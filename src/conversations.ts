// エージェント会話の閲覧(要件v0.3 機能B / findings F2・F27)。
//
// Antigravity IDE・Antigravity CLI(agy)・Claude Code の3系統は保存先も形式も別だが、
// どれも**読み出しは可能**。ここでは「読むだけ」に徹する(送信は機能Cで別物)。
//
// ⚠️ SQLite は **`node:sqlite`(Node標準)** で読む。Electron 39.2.3 / Node 22.21.1 で
// 利用可能なことを実測済み。better-sqlite3 等のネイティブモジュールを足すと、せっかく
// 解消した ABI/配布の問題(F16)が再発するため使わない。古いランタイムでは
// require が失敗するので、その場合は Antigravity 分だけ静かに諦める(Claude Code は JSONL なので影響なし)。

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type ConversationSource = "antigravity-ide" | "antigravity-cli" | "claude-code";

export interface ConversationMeta {
  id: string; // 例 "ide:42c2c836-..." / "cc:-home-ike3-work/32a4f9b7-..."
  source: ConversationSource;
  title: string;
  updatedAt: number; // epoch ms
  path: string;
}

/** 1会話あたりの転送量の上限。scrollback(256KB)とリレーの上限(512KB)に収める。 */
const MAX_TRANSCRIPT_BYTES = 120 * 1024;
/** 一覧に出す最大件数(新しい順)。 */
const MAX_CONVERSATIONS = 24;
/** 題名を作るために読むメッセージ数。 */
const TITLE_SCAN = 40;

const SOURCE_LABEL: Record<ConversationSource, string> = {
  "antigravity-ide": "Antigravity",
  "antigravity-cli": "agy",
  "claude-code": "Claude Code",
};

function home(): string {
  return process.env.HOME ?? os.homedir();
}

function safeStat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ───────────────────────── Antigravity(SQLite + protobuf) ─────────────────────────

// @types/node@20 には node:sqlite の型が無い。依存を上げずに済ませるため、
// 使う分だけをここで宣言する(実行時に存在しなければ null に倒す)。
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteMod {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDatabase;
}
let sqliteMod: SqliteMod | null | undefined;
function sqlite(): SqliteMod | null {
  if (sqliteMod !== undefined) return sqliteMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteMod = require("node:sqlite") as SqliteMod;
  } catch {
    sqliteMod = null; // 古いランタイム。Antigravity の会話は読めないが致命ではない
  }
  return sqliteMod;
}

/**
 * protobuf ペイロードから本文を取り出す。
 *
 * ⚠️ **日本語(UTF-8マルチバイト)を必ず対象に含める**こと。ASCII だけの判定にすると
 * 日本語の会話が「読めない」と誤判定される(F27で実際に踏んだ)。
 * 制御文字で区切り、十分な長さの可読断片のうち最長のものを本文とみなす。
 */
function extractText(buf: Buffer): string {
  const s = buf.toString("utf8");
  let best = "";
  let cur = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const printable = c === 0x0a || c === 0x09 || (c >= 0x20 && c !== 0x7f && c !== 0xfffd);
    if (printable) {
      cur += ch;
    } else {
      if (cur.length > best.length) best = cur;
      cur = "";
    }
  }
  if (cur.length > best.length) best = cur;
  return best.trim();
}

/**
 * 会話として読む価値がある本文か。
 *
 * step_payload には**ツール呼び出しのJSONや内部ID**が混ざる。素通しすると
 * `{"AbsolutePath":...}` の羅列になって読み物にならないので、ここで落とす。
 */
function looksLikeProse(text: string): boolean {
  const s = text.trim();
  if (s.length < 8) return false;
  if (s.startsWith("{") || s.startsWith("[")) return false; // ツールの構造化データ
  if (/^[0-9a-f-]{8,}$/i.test(s)) return false; // UUID など
  if (/file:\/\/|^[a-z]+:\/\//i.test(s)) return false; // URL/ファイル参照の断片
  if (/^[^\s]+\.(jsonl|db|json|log|md|ts|js|py)$/i.test(s)) return false; // ファイル名だけ
  // 記号・英数だけの断片(内部ID、パス片)を落とす。文字が一定割合あることを求める。
  const letters = (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (letters / s.length < 0.5) return false;
  // UUID が大半を占めるものも落とす
  const uuid = (s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).join("");
  return uuid.length < s.length * 0.5;
}

/** step_type → 正規化した役割。5/8/9(ツール)は読み物として不要なので落とす。 */
function roleOf(stepType: number): "user" | "model" | "summary" | null {
  if (stepType === 14) return "user";
  if (stepType === 15) return "model";
  if (stepType === 23) return "summary";
  return null;
}

interface StepRow {
  step_type: number;
  step_payload: Buffer | null;
}

function readAntigravitySteps(dbPath: string, limit?: number): { role: string; text: string }[] {
  const mod = sqlite();
  if (!mod) return [];
  let db: SqliteDatabase | undefined;
  try {
    // 読み取り専用で開く。IDE が書き込み中でも壊さない。
    db = new mod.DatabaseSync(dbPath, { readOnly: true });
    const sql = limit
      ? "SELECT step_type, step_payload FROM steps ORDER BY idx ASC LIMIT ?"
      : "SELECT step_type, step_payload FROM steps ORDER BY idx ASC";
    const rows = (limit ? db.prepare(sql).all(limit) : db.prepare(sql).all()) as unknown as StepRow[];
    const out: { role: string; text: string }[] = [];
    for (const r of rows) {
      const role = roleOf(Number(r.step_type));
      if (!role || !r.step_payload) continue;
      const text = extractText(Buffer.from(r.step_payload));
      if (looksLikeProse(text)) out.push({ role, text });
    }
    return out;
  } catch {
    return []; // ロック中・形式変更・権限なし等はすべて「読めない」に倒す
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

// ───────────────────────── Claude Code(JSONL) ─────────────────────────

/** 題名用に先頭だけ読むための上限。会話ログは 10MB を超えることがあり、全読みは重い。 */
const HEAD_BYTES = 64 * 1024;

function readTextHead(file: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.subarray(0, n).toString("utf8");
    // 最後の行は途中で切れている可能性が高いので捨てる
    return s.slice(0, s.lastIndexOf("\n") + 1);
  } catch {
    return "";
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      /* noop */
    }
  }
}

function readClaudeCode(file: string, maxMessages?: number): { role: string; text: string }[] {
  let raw: string;
  try {
    // 題名を作るときは先頭だけ。全文が要るときだけ読み切る。
    raw = maxMessages ? readTextHead(file, HEAD_BYTES) : fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: { role: string; text: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let d: { type?: string; message?: { content?: unknown } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "user" && d.type !== "assistant") continue;
    const c = d.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c
        .map((x) => (x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text) : ""))
        .filter(Boolean)
        .join("\n");
    }
    text = text.trim();
    // Claude Code のログには CLI が挿入する制御ブロックやコマンド出力が混ざる。
    // 会話として読みたいものだけ残す。
    if (text.startsWith("<local-command-caveat>") || text.startsWith("<command-name>")) continue;
    if (text.startsWith("<command-message>") || text.startsWith("<local-command-stdout>")) continue;
    if (!looksLikeProse(text)) continue;
    out.push({ role: d.type === "user" ? "user" : "model", text });
    if (maxMessages && out.length >= maxMessages) break;
  }
  return out;
}

// ───────────────────────── 一覧と本文 ─────────────────────────

function titleFrom(msgs: { role: string; text: string }[], fallback: string): string {
  const first = msgs.find((m) => m.role === "user" && looksLikeProse(m.text)) ?? msgs[0];
  if (!first) return fallback;
  const line = first.text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? line.slice(0, 48) + "…" : line || fallback;
}

let cache: { at: number; items: ConversationMeta[] } | undefined;
const CACHE_MS = 10_000;

/** 3系統をまとめて新しい順に返す。重い処理を避けるため、題名は先頭だけ読んで作る。 */
export function listConversations(): ConversationMeta[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const items = scanConversations();
  cache = { at: Date.now(), items };
  return items;
}

function scanConversations(): ConversationMeta[] {
  const h = home();
  const found: ConversationMeta[] = [];

  const agDirs: [ConversationSource, string][] = [
    ["antigravity-ide", path.join(h, ".gemini", "antigravity-ide", "conversations")],
    ["antigravity-cli", path.join(h, ".gemini", "antigravity-cli", "conversations")],
  ];
  for (const [source, dir] of agDirs) {
    for (const f of listFiles(dir, ".db")) {
      const st = safeStat(f);
      if (!st) continue;
      found.push({
        id: `${source === "antigravity-ide" ? "ide" : "agy"}:${path.basename(f, ".db")}`,
        source,
        title: "",
        updatedAt: st.mtimeMs,
        path: f,
      });
    }
  }

  const projects = path.join(h, ".claude", "projects");
  try {
    for (const proj of fs.readdirSync(projects)) {
      for (const f of listFiles(path.join(projects, proj), ".jsonl")) {
        const st = safeStat(f);
        if (!st || st.size === 0) continue;
        found.push({
          id: `cc:${proj}/${path.basename(f, ".jsonl")}`,
          source: "claude-code",
          title: "",
          updatedAt: st.mtimeMs,
          path: f,
        });
      }
    }
  } catch {
    /* Claude Code 未使用 */
  }

  found.sort((a, b) => b.updatedAt - a.updatedAt);
  const top = found.slice(0, MAX_CONVERSATIONS);
  for (const m of top) {
    const msgs =
      m.source === "claude-code"
        ? readClaudeCode(m.path, TITLE_SCAN)
        : readAntigravitySteps(m.path, TITLE_SCAN);
    m.title = `${SOURCE_LABEL[m.source]}: ${titleFrom(msgs, path.basename(m.path))}`;
  }
  return top;
}

/** 会話1件を読める形の文字列にする。末尾(新しい方)を優先して上限内に収める。 */
export function readConversation(meta: ConversationMeta): string {
  const msgs =
    meta.source === "claude-code" ? readClaudeCode(meta.path) : readAntigravitySteps(meta.path);
  if (msgs.length === 0) {
    return `(${SOURCE_LABEL[meta.source]} の会話を読み取れませんでした)\r\n`;
  }
  const label: Record<string, string> = { user: "▶ あなた", model: "◀ エージェント", summary: "≡ 要約" };
  const blocks = msgs.map((m) => `${label[m.role] ?? m.role}\r\n${m.text.replace(/\n/g, "\r\n")}\r\n`);

  // 上限を超えるときは**古い方から捨てる**(直近のやりとりが読みたいはずなので)
  let total = 0;
  const kept: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    total += Buffer.byteLength(blocks[i]);
    if (total > MAX_TRANSCRIPT_BYTES) {
      kept.unshift(`(これ以前の ${i + 1} 件は長いため省略しました)\r\n\r\n`);
      break;
    }
    kept.unshift(blocks[i]);
  }
  return kept.join("\r\n");
}
