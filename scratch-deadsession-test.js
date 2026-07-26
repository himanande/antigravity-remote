"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scratch-deadsession-test.ts
var fs2 = __toESM(require("fs"));

// src/sessionManager.ts
var path2 = __toESM(require("path"));

// src/pty.ts
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
function ensureSpawnHelperExecutable() {
  if (process.platform !== "darwin") return;
  const helper = path.join(
    __dirname,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper"
  );
  try {
    if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 73)) {
      fs.chmodSync(helper, 493);
    }
  } catch {
  }
}
var ptyLib;
try {
  ensureSpawnHelperExecutable();
  ptyLib = require("node-pty");
} catch (e) {
  throw new Error(
    `node-pty \u306E\u8AAD\u307F\u8FBC\u307F\u306B\u5931\u6557\u3057\u307E\u3057\u305F(${process.platform}-${process.arch})\u3002\u3053\u306E\u74B0\u5883\u5411\u3051\u306E\u30D0\u30A4\u30CA\u30EA\u304C\u540C\u68B1\u3055\u308C\u3066\u3044\u306A\u3044\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002\u539F\u56E0: ` + e.message
  );
}
var BUILTIN_PRESETS = {
  claude: { file: "claude", args: [] },
  codex: { file: "codex", args: [] },
  gemini: { file: "gemini", args: [] },
  bash: { file: "bash", args: ["-l"] }
};
var PRESETS = { ...BUILTIN_PRESETS };
var PtySession = class _PtySession {
  proc;
  scrollback = [];
  scrollbackBytes = 0;
  static SCROLLBACK_MAX = 500;
  // チャンク数の上限
  static SCROLLBACK_BYTES_MAX = 256 * 1024;
  // 合計バイト上限(snapshot 1通の大きさを縛る)
  alive = true;
  dataListeners = /* @__PURE__ */ new Set();
  exitListeners = /* @__PURE__ */ new Set();
  constructor(opts) {
    const preset = PRESETS[opts.preset];
    if (!preset) {
      throw new Error(`\u672A\u77E5\u306E\u30D7\u30EA\u30BB\u30C3\u30C8: ${opts.preset}(\u8A31\u53EF: ${Object.keys(PRESETS).join(", ")})`);
    }
    this.proc = ptyLib.spawn(preset.file, preset.args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: process.env
    });
    this.proc.onData((chunk) => {
      this.pushScrollback(chunk);
      for (const l of this.dataListeners) l(chunk);
    });
    this.proc.onExit(({ exitCode }) => {
      this.alive = false;
      for (const l of this.exitListeners) l(exitCode);
    });
  }
  pushScrollback(chunk) {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.length;
    while (this.scrollback.length > _PtySession.SCROLLBACK_MAX || this.scrollbackBytes > _PtySession.SCROLLBACK_BYTES_MAX && this.scrollback.length > 1) {
      const dropped = this.scrollback.shift();
      this.scrollbackBytes -= dropped ? dropped.length : 0;
    }
  }
  // ⚠️ 終了済みの PTY を触ると node-pty が例外を投げ、**ホストプロセスごと落ちる**
  // (`ioctl(2) failed, EBADF`)。スマホで終了済みセッションを開くと resize が飛ぶため、
  // 誰でも簡単に踏める経路だった(F22)。以下は必ず生存確認 + try/catch で守る。
  // 終了の検知(onExit)と操作の間には競合があるので、フラグだけでは不十分。
  /** リモートからの入力を PTY に書き込む(キー入力・許可プロンプト応答 FR-2.3)。 */
  write(data) {
    if (!this.alive) return;
    try {
      this.proc.write(data);
    } catch {
      this.alive = false;
    }
  }
  resize(cols, rows) {
    if (!this.alive || cols <= 0 || rows <= 0) return;
    try {
      this.proc.resize(cols, rows);
    } catch {
      this.alive = false;
    }
  }
  /** 再接続時に直近出力を再送する(FR-2.4)。 */
  getScrollback() {
    return this.scrollback.join("");
  }
  onData(l) {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }
  onExit(l) {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }
  dispose() {
    this.alive = false;
    try {
      this.proc.kill();
    } catch {
    }
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
};
function defaultCwd() {
  return process.env.HOME ?? os.homedir();
}

// src/sessionManager.ts
var DEFAULT_PROMPT_PATTERNS = [
  /\bDo you want to proceed\?/i,
  /❯\s*1\.\s*Yes/i,
  /\[y\/n\]/i,
  /\(y\/N\)/i,
  /Press\s+Enter\s+to\s+continue/i
];
var SessionManager = class {
  entries = /* @__PURE__ */ new Map();
  seq = 0;
  promptPatterns;
  dataListeners = /* @__PURE__ */ new Set();
  exitListeners = /* @__PURE__ */ new Set();
  metaListeners = /* @__PURE__ */ new Set();
  constructor(opts = {}) {
    this.promptPatterns = opts.promptPatterns ?? DEFAULT_PROMPT_PATTERNS;
  }
  /** 新規 pty セッションを作成し、メタを返す。任意コマンド不可(preset は PtySession 側で検証)。 */
  create(opts) {
    const cwd = opts.cwd ?? defaultCwd();
    const id = `s${++this.seq}`;
    const pty = new PtySession({ preset: opts.preset, cwd, cols: opts.cols, rows: opts.rows });
    const meta = {
      id,
      kind: "pty",
      title: `${opts.preset}: ${path2.basename(cwd) || cwd}`,
      status: "running",
      createdAt: Date.now(),
      preset: opts.preset
    };
    const disposers = [
      pty.onData((chunk) => {
        if (this.promptPatterns.some((re) => re.test(chunk))) this.setStatus(id, "waiting-input");
        for (const l of this.dataListeners) l(id, chunk);
      }),
      pty.onExit((code) => {
        this.setStatus(id, "exited");
        for (const l of this.exitListeners) l(id, code);
      })
    ];
    this.entries.set(id, { meta, pty, disposers });
    this.emitMeta({ kind: "added", meta });
    return meta;
  }
  /** セッションを終了して一覧から除去する。 */
  close(sessionId) {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    for (const d of e.disposers) d();
    e.pty.dispose();
    this.entries.delete(sessionId);
    this.emitMeta({ kind: "removed", sessionId });
    return true;
  }
  write(sessionId, data) {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    if (e.meta.status === "waiting-input") this.setStatus(sessionId, "running");
    e.pty.write(data);
    return true;
  }
  resize(sessionId, cols, rows) {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    e.pty.resize(cols, rows);
    return true;
  }
  /** subscribe/再接続時に返す直近出力(scrollback)。存在しなければ undefined。 */
  snapshot(sessionId) {
    return this.entries.get(sessionId)?.pty.getScrollback();
  }
  has(sessionId) {
    return this.entries.has(sessionId);
  }
  /** 現在の全セッションメタ(一覧同期用)。 */
  list() {
    return [...this.entries.values()].map((e) => ({ ...e.meta }));
  }
  setStatus(sessionId, status) {
    const e = this.entries.get(sessionId);
    if (!e || e.meta.status === status) return;
    e.meta = { ...e.meta, status };
    this.emitMeta({ kind: "updated", meta: e.meta });
  }
  emitMeta(change) {
    for (const l of this.metaListeners) l(change);
  }
  onData(l) {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }
  onExit(l) {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }
  onMeta(l) {
    this.metaListeners.add(l);
    return () => this.metaListeners.delete(l);
  }
  dispose() {
    for (const id of [...this.entries.keys()]) this.close(id);
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.metaListeners.clear();
  }
};

// scratch-deadsession-test.ts
var RESULT = __dirname + "/deadsession-result.txt";
var log = (s) => (fs2.appendFileSync(RESULT, s + "\n"), console.log(s));
fs2.writeFileSync(RESULT, "");
var fails = 0;
var check = (name, ok, detail = "") => {
  log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " \u2014 " + detail : ""}`);
  if (!ok) fails++;
};
(async () => {
  const mgr = new SessionManager();
  let meta;
  try {
    meta = mgr.create({ preset: "gemini", cwd: process.env.HOME });
    check("\u672A\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u306E\u30D7\u30EA\u30BB\u30C3\u30C8\u3067\u3082 create \u304C\u4F8B\u5916\u3092\u6295\u3052\u306A\u3044", true);
  } catch (e) {
    check("\u672A\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u306E\u30D7\u30EA\u30BB\u30C3\u30C8\u3067\u3082 create \u304C\u4F8B\u5916\u3092\u6295\u3052\u306A\u3044", false, e.message);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1200));
  try {
    mgr.resize(meta.id, 120, 40);
    check("\u7D42\u4E86\u6E08\u307F\u30BB\u30C3\u30B7\u30E7\u30F3\u3078\u306E resize \u3067\u30DB\u30B9\u30C8\u304C\u843D\u3061\u306A\u3044", true);
  } catch (e) {
    check("\u7D42\u4E86\u6E08\u307F\u30BB\u30C3\u30B7\u30E7\u30F3\u3078\u306E resize \u3067\u30DB\u30B9\u30C8\u304C\u843D\u3061\u306A\u3044", false, e.message);
  }
  try {
    mgr.write(meta.id, "echo hello\r");
    check("\u7D42\u4E86\u6E08\u307F\u30BB\u30C3\u30B7\u30E7\u30F3\u3078\u306E write \u3067\u30DB\u30B9\u30C8\u304C\u843D\u3061\u306A\u3044", true);
  } catch (e) {
    check("\u7D42\u4E86\u6E08\u307F\u30BB\u30C3\u30B7\u30E7\u30F3\u3078\u306E write \u3067\u30DB\u30B9\u30C8\u304C\u843D\u3061\u306A\u3044", false, e.message);
  }
  const alive = mgr.create({ preset: "bash", cwd: process.env.HOME });
  let out = "";
  mgr.onData((id, chunk) => {
    if (id === alive.id) out += chunk;
  });
  mgr.resize(alive.id, 100, 30);
  mgr.write(alive.id, "echo STILL_WORKS\r");
  await new Promise((r) => setTimeout(r, 1500));
  check("\u751F\u5B58\u30BB\u30C3\u30B7\u30E7\u30F3\u306F resize/write \u304C\u5F93\u6765\u3069\u304A\u308A\u52B9\u304F", out.includes("STILL_WORKS"), out.slice(-60).replace(/\n/g, "\u23CE"));
  mgr.close(alive.id);
  await new Promise((r) => setTimeout(r, 400));
  try {
    mgr.resize(alive.id, 90, 25);
    mgr.write(alive.id, "x");
    check("close \u6E08\u307F\u30BB\u30C3\u30B7\u30E7\u30F3\u3078\u306E\u64CD\u4F5C\u3067\u3082\u843D\u3061\u306A\u3044", true);
  } catch (e) {
    check("close \u6E08\u307F\u30BB\u30C3\u30B7\u30E7\u30F3\u3078\u306E\u64CD\u4F5C\u3067\u3082\u843D\u3061\u306A\u3044", false, e.message);
  }
  log(fails === 0 ? "\nALL PASS" : `
${fails} \u4EF6 FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})();
