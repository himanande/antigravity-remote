// フェーズ0 実機確認用の「ホスト役」単体スクリプト(Antigravity拡張の代役)。
// 起動中のリレー(既定 ws://localhost:8787)に host として接続し、node-pty で
// プリセットのシェル/CLI を起動して入出力を中継する。これで拡張のF5ロード無しに
// 実機スマホ ⇄ リレー ⇄ PTY の往復(TASK-04)を体験できる。
//
// 使い方: node scratch-host.js [preset]   preset = bash | claude (既定 bash)
const { WebSocket } = require("ws");
const pty = require("node-pty");

const PRESETS = { bash: { file: "bash", args: ["-i"] }, claude: { file: "claude", args: [] } };
const presetName = process.argv[2] || "bash";
const preset = PRESETS[presetName] || PRESETS.bash;
const URL = process.env.RELAY_URL || "ws://localhost:8787";

const scrollback = [];
const term = pty.spawn(preset.file, preset.args, {
  name: "xterm-256color", cols: 80, rows: 24, cwd: process.env.HOME,
  env: process.env,
});

function connect() {
  const ws = new WebSocket(URL);
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const toClient = (m) => send({ t: "msg", payload: m });

  // v0.3 プロトコル(sessionId 多重化)の単一セッション橋渡し。
  const SID = "main";
  const meta = () => ({ id: SID, kind: "pty", title: presetName, status: "running", createdAt: Date.now(), preset: presetName });

  ws.on("open", () => { console.log(`[host] connected to ${URL}, preset=${presetName}`); send({ t: "hello", role: "host" }); });
  ws.on("message", (raw) => {
    let env; try { env = JSON.parse(raw.toString()); } catch { return; }
    if (env.t === "peer-joined" && env.role === "client") {
      console.log("[host] client joined → hello/list/snapshot送信");
      toClient({ t: "host.hello", protocol: 1, features: { pty: true, agentMirror: false, agentControl: false } });
      toClient({ t: "session.list", sessions: [meta()] });
      toClient({ t: "snapshot", sessionId: SID, data: scrollback.join("") });
    }
    if (env.t !== "msg") return;
    const m = env.payload;
    if (m.t === "client.hello" || m.t === "session.list.request") toClient({ t: "session.list", sessions: [meta()] });
    else if (m.t === "session.subscribe" && m.sessionId === SID) toClient({ t: "snapshot", sessionId: SID, data: scrollback.join("") });
    else if (m.t === "input" && m.sessionId === SID) term.write(m.data);
    else if (m.t === "resize" && m.sessionId === SID) term.resize(m.cols, m.rows);
  });
  ws.on("close", () => { console.log("[host] relay切断 → 2秒後に再接続"); setTimeout(connect, 2000); });
  ws.on("error", (e) => console.log("[host] ws error:", e.message));

  term.onData((d) => {
    scrollback.push(d);
    if (scrollback.length > 500) scrollback.splice(0, scrollback.length - 500);
    toClient({ t: "output", sessionId: SID, data: d });
  });
  term.onExit(({ exitCode }) => { toClient({ t: "exit", sessionId: SID, code: exitCode }); process.exit(0); });
}
connect();
