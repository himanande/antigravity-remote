import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { IPty } from "node-pty";

// node-pty はネイティブモジュールだが Node-API(N-API)実装のため **ABI安定**で、
// Electron/Node のバージョンが変わっても同じバイナリが動く(findings F16)。
// 必要なのは plat-arch ごとのバイナリ同梱だけで、配布物は dist/node_modules/node-pty
// (scripts/prepare-native.js が生成)に自己完結している。
//
// macOS の spawn-helper は実行ビットが必須。.vsix(zip)展開でパーミッションが
// 落ちる環境があるため、読み込み前に付け直す。
function ensureSpawnHelperExecutable(): void {
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
    if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) {
      fs.chmodSync(helper, 0o755);
    }
  } catch {
    // 付け直せなくても読み込み自体は試す
  }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
let ptyLib: typeof import("node-pty");
try {
  ensureSpawnHelperExecutable();
  ptyLib = require("node-pty");
} catch (e) {
  throw new Error(
    `node-pty の読み込みに失敗しました(${process.platform}-${process.arch})。` +
      "この環境向けのバイナリが同梱されていない可能性があります。原因: " +
      (e as Error).message
  );
}

const PRESETS: Record<string, { file: string; args: string[] }> = {
  claude: { file: "claude", args: [] },
  bash: { file: "bash", args: ["-l"] },
};

export interface PtyOptions {
  preset: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

/**
 * 1本のホスト型PTYセッション。プリセットで起動コマンドを制限する(任意コマンド不可)。
 * scrollback を保持し、再接続時に再送できるようにする(FR-2.4)。
 */
export class PtySession {
  private proc: IPty;
  private scrollback: string[] = [];
  private scrollbackBytes = 0;
  private static readonly SCROLLBACK_MAX = 500; // チャンク数の上限
  private static readonly SCROLLBACK_BYTES_MAX = 256 * 1024; // 合計バイト上限(snapshot 1通の大きさを縛る)
  private dataListeners = new Set<(chunk: string) => void>();
  private exitListeners = new Set<(code: number) => void>();

  constructor(opts: PtyOptions) {
    const preset = PRESETS[opts.preset];
    if (!preset) {
      throw new Error(`未知のプリセット: ${opts.preset}(許可: ${Object.keys(PRESETS).join(", ")})`);
    }
    this.proc = ptyLib.spawn(preset.file, preset.args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: process.env as { [key: string]: string },
    });
    this.proc.onData((chunk) => {
      this.pushScrollback(chunk);
      for (const l of this.dataListeners) l(chunk);
    });
    this.proc.onExit(({ exitCode }) => {
      for (const l of this.exitListeners) l(exitCode);
    });
  }

  private pushScrollback(chunk: string) {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.length;
    // チャンク数だけでなく**バイト数**でも切る。1チャンクは PTY から最大数十KB来るため、
    // 数だけの制限では snapshot 1通が数MBになり、リレーのメッセージ上限に当たる(TASK-22)。
    while (
      this.scrollback.length > PtySession.SCROLLBACK_MAX ||
      (this.scrollbackBytes > PtySession.SCROLLBACK_BYTES_MAX && this.scrollback.length > 1)
    ) {
      const dropped = this.scrollback.shift();
      this.scrollbackBytes -= dropped ? dropped.length : 0;
    }
  }

  /** リモートからの入力を PTY に書き込む(キー入力・許可プロンプト応答 FR-2.3)。 */
  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.proc.resize(cols, rows);
  }

  /** 再接続時に直近出力を再送する(FR-2.4)。 */
  getScrollback(): string {
    return this.scrollback.join("");
  }

  onData(l: (chunk: string) => void): () => void {
    this.dataListeners.add(l);
    return () => this.dataListeners.delete(l);
  }

  onExit(l: (code: number) => void): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  dispose(): void {
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

export function defaultCwd(): string {
  return process.env.HOME ?? os.homedir();
}
