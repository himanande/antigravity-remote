import * as vscode from "vscode";
import type { SessionManager } from "./sessionManager";

/**
 * TASK-20 双方向同期: ホストの各セッション(node-pty)を、PC側の VS Code ターミナルタブにも
 * ミラーする。**同じ node-pty** を PC とスマホの両方が見るので、入力も出力も双方向で同期する:
 *  - PC のターミナルで打つ → manager.write → pty → 出力が PC(onData)にもスマホ(RelayClient)にも流れる
 *  - スマホで打つ → pty → 出力が PC のターミナル(onData→onDidWrite)にも出る
 *
 * VS Code の Pseudoterminal API を使う(拡張が入出力を仲介する疑似端末)。SessionManager 側は
 * vscode 非依存のまま。ミラーは manager のイベントに乗るだけで、全セッション(PC発/スマホ発)に張る。
 */
interface MirrorEntry {
  term: vscode.Terminal;
  write: vscode.EventEmitter<string>;
  opened: boolean; // open() 前は破棄されるため、live出力は open 後のみ流す(open時に scrollback を再生)
}

export class TerminalMirror {
  private terminals = new Map<string, MirrorEntry>();
  private closing = new Set<string>(); // remove 起因の close() を manager.close と二重にしないためのガード
  private disposers: Array<() => void> = [];

  constructor(
    private readonly manager: SessionManager,
    private readonly log: (m: string) => void
  ) {
    this.disposers.push(
      manager.onMeta((c) => {
        if (c.kind === "added") this.add(c.meta.id, c.meta.title);
        else if (c.kind === "removed") this.remove(c.sessionId);
      }),
      // open 前の live 出力は流さない(open() の scrollback 再生に含まれる=取りこぼし/重複なし)
      manager.onData((id, chunk) => {
        const e = this.terminals.get(id);
        if (e && e.opened) e.write.fire(chunk);
      }),
      manager.onExit((id, code) => {
        const e = this.terminals.get(id);
        if (e && e.opened) e.write.fire(`\r\n[プロセス終了 code=${code}]\r\n`);
      })
    );
    // ミラー生成時点で既にあるセッションにも張る(通常は空だが順序に依存しないように)
    for (const m of manager.list()) this.add(m.id, m.title);
  }

  private add(id: string, title: string): void {
    if (this.terminals.has(id)) return;
    const write = new vscode.EventEmitter<string>();
    const entry: MirrorEntry = { term: undefined as unknown as vscode.Terminal, write, opened: false };
    const pty: vscode.Pseudoterminal = {
      onDidWrite: write.event,
      open: (dims) => {
        // scrollback は pty.onData で同期更新済み。open 時点までの全出力をここで一括再生し、
        // 以後の live 出力を流し始める(この関数は同期実行なので間に出力が割り込まない)。
        const snap = this.manager.snapshot(id);
        if (snap) write.fire(snap);
        entry.opened = true;
        if (dims) this.manager.resize(id, dims.columns, dims.rows);
      },
      // PC ターミナルタブが閉じられた(ユーザー操作/プログラム双方でここに来る)
      close: () => {
        if (this.closing.has(id)) return; // remove() 由来 → 既に片付け中
        this.manager.close(id); // 同じ pty なのでスマホ側セッションも終了する
      },
      handleInput: (data) => this.manager.write(id, data),
      setDimensions: (dims) => this.manager.resize(id, dims.columns, dims.rows),
    };
    entry.term = vscode.window.createTerminal({ name: `⇄ ${title}`, pty });
    this.terminals.set(id, entry);
    entry.term.show(false); // フォーカスは奪わない
    this.log(`PCミラー端末を作成: ${title}(${id})`);
  }

  private remove(id: string): void {
    const t = this.terminals.get(id);
    if (!t) return;
    this.terminals.delete(id);
    this.closing.add(id); // これから走る close() コールバックを無視させる
    t.term.dispose();
    t.write.dispose();
    setTimeout(() => this.closing.delete(id), 0);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    for (const id of [...this.terminals.keys()]) this.remove(id);
  }
}
