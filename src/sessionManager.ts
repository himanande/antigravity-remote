import * as path from "path";
import { PtySession, defaultCwd } from "./pty";
import type { SessionMeta, SessionStatus } from "./protocol";

// ホスト側で複数セッションを sessionId で多重化する中核(ADR-005)。
// 現状は kind=pty のみ。kind=agent(会話ミラー)はフェーズ2で本 Manager に統合する。

interface Entry {
  meta: SessionMeta;
  pty: PtySession;
  disposers: Array<() => void>;
}

export type MetaChange =
  | { kind: "added"; meta: SessionMeta }
  | { kind: "updated"; meta: SessionMeta }
  | { kind: "removed"; sessionId: string };

export interface CreateOptions {
  preset: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface SessionManagerOptions {
  // 出力がこのパターンに一致したら status を waiting-input にする(入力待ち検出)。
  // 既定は Claude Code / 一般的な確認プロンプト向け。
  promptPatterns?: RegExp[];
}

const DEFAULT_PROMPT_PATTERNS: RegExp[] = [
  /\bDo you want to proceed\?/i,
  /❯\s*1\.\s*Yes/i,
  /\[y\/n\]/i,
  /\(y\/N\)/i,
  /Press\s+Enter\s+to\s+continue/i,
];

/**
 * 複数の PtySession を保持し、sessionId で入出力・メタを多重化する。
 * 出力/終了/メタ変更はリスナ(RelayClient が購読)へ sessionId 付きで通知する。
 */
export class SessionManager {
  private entries = new Map<string, Entry>();
  private seq = 0;
  private readonly promptPatterns: RegExp[];

  private dataListeners = new Set<(sessionId: string, chunk: string) => void>();
  private exitListeners = new Set<(sessionId: string, code: number) => void>();
  private metaListeners = new Set<(change: MetaChange) => void>();

  constructor(opts: SessionManagerOptions = {}) {
    this.promptPatterns = opts.promptPatterns ?? DEFAULT_PROMPT_PATTERNS;
  }

  /** 新規 pty セッションを作成し、メタを返す。任意コマンド不可(preset は PtySession 側で検証)。 */
  create(opts: CreateOptions): SessionMeta {
    const cwd = opts.cwd ?? defaultCwd();
    const id = `s${++this.seq}`;
    const pty = new PtySession({ preset: opts.preset, cwd, cols: opts.cols, rows: opts.rows });
    const meta: SessionMeta = {
      id,
      kind: "pty",
      title: `${opts.preset}: ${path.basename(cwd) || cwd}`,
      status: "running",
      createdAt: Date.now(),
      preset: opts.preset,
    };
    const disposers = [
      pty.onData((chunk) => {
        // 入力待ちプロンプトを検出したら status を上げる(通知トリガ FR-5.1)
        if (this.promptPatterns.some((re) => re.test(chunk))) this.setStatus(id, "waiting-input");
        for (const l of this.dataListeners) l(id, chunk);
      }),
      pty.onExit((code) => {
        this.setStatus(id, "exited");
        for (const l of this.exitListeners) l(id, code);
      }),
    ];
    this.entries.set(id, { meta, pty, disposers });
    this.emitMeta({ kind: "added", meta });
    return meta;
  }

  /** セッションを終了して一覧から除去する。 */
  close(sessionId: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    for (const d of e.disposers) d();
    e.pty.dispose();
    this.entries.delete(sessionId);
    this.emitMeta({ kind: "removed", sessionId });
    return true;
  }

  write(sessionId: string, data: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    // 入力が来たら実行中に戻す(入力待ち解除)
    if (e.meta.status === "waiting-input") this.setStatus(sessionId, "running");
    e.pty.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    e.pty.resize(cols, rows);
    return true;
  }

  /** subscribe/再接続時に返す直近出力(scrollback)。存在しなければ undefined。 */
  snapshot(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.pty.getScrollback();
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** 現在の全セッションメタ(一覧同期用)。 */
  list(): SessionMeta[] {
    return [...this.entries.values()].map((e) => ({ ...e.meta }));
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const e = this.entries.get(sessionId);
    if (!e || e.meta.status === status) return;
    e.meta = { ...e.meta, status };
    this.emitMeta({ kind: "updated", meta: e.meta });
  }

  private emitMeta(change: MetaChange): void {
    for (const l of this.metaListeners) l(change);
  }

  onData(l: (sessionId: string, chunk: string) => void): () => void {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }

  onExit(l: (sessionId: string, code: number) => void): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  onMeta(l: (change: MetaChange) => void): () => void {
    this.metaListeners.add(l);
    return () => this.metaListeners.delete(l);
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.metaListeners.clear();
  }
}
