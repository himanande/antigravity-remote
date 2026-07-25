// フェーズ0 縦切り疎通テスト(単一プロセス版)。
// 子プロセスを spawn せず、リレー(WSS)・host役(bash PTY中継)・client役 を1プロセス内で結線し、
// client入力 → PTY → 出力 → client の一巡を確認する。TASK-03/04 のデータ経路検証。
const fs = require("fs");
const { WebSocketServer, WebSocket } = require("ws");
const pty = require("node-pty");

const RESULT = __dirname + "/e2e-result.txt";
const log = (s) => fs.appendFileSync(RESULT, s + "\n");
fs.writeFileSync(RESULT, "");

const PORT = 8802;
const relayLogic = require("./relay/logic"); // 中継ロジックを共有(server.js と同一)
const wss = new WebSocketServer({ port: PORT }, () => {
  log("[stage] relay listening " + PORT);
  runPeers();
});
relayLogic.attach(wss);

let done = false;
function finish(ok, msg) {
  if (done) return;
  done = true;
  log((ok ? "PASS: " : "FAIL: ") + msg);
  try { wss.close(); } catch {}
  process.exit(ok ? 0 : 1);
}

function runPeers() {
  const URL = `ws://localhost:${PORT}`;
  // host役
  const term = pty.spawn("bash", ["--norc", "-i"], { cols: 80, rows: 24, cwd: process.env.HOME });
  const SID = "main";
  const meta = { id: SID, kind: "pty", title: "bash", status: "running", createdAt: Date.now(), preset: "bash" };
  const host = new WebSocket(URL);
  const hsend = (o) => { if (host.readyState === 1) host.send(JSON.stringify(o)); };
  const hToClient = (m) => hsend({ t: "msg", payload: m });
  host.on("open", () => { log("[stage] host open"); host.send(JSON.stringify({ t: "hello", role: "host" })); });
  host.on("error", (e) => log("host err " + e.message));
  host.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.t === "peer-joined" && env.role === "client") {
      hToClient({ t: "session.list", sessions: [meta] });
      hToClient({ t: "snapshot", sessionId: SID, data: "(sb)" });
    }
    if (env.t !== "msg") return;
    const m = env.payload;
    if (m.t === "session.list.request") hToClient({ t: "session.list", sessions: [meta] });
    else if (m.t === "session.subscribe") hToClient({ t: "snapshot", sessionId: SID, data: "(sb)" });
    else if (m.t === "input") term.write(m.data);
    else if (m.t === "resize") term.resize(m.cols, m.rows);
  });
  term.onData((d) => hToClient({ t: "output", sessionId: SID, data: d }));

  // client役
  setTimeout(() => {
    const client = new WebSocket(URL);
    let buf = "";
    const MARKER = "E2E_OK_" + Date.now();
    let subscribed = false;
    client.on("open", () => {
      log("[stage] client open");
      client.send(JSON.stringify({ t: "hello", role: "client" }));
      client.send(JSON.stringify({ t: "msg", payload: { t: "client.hello", protocol: 1 } }));
      client.send(JSON.stringify({ t: "msg", payload: { t: "session.list.request" } }));
    });
    client.on("error", (e) => log("client err " + e.message));
    client.on("message", (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.t !== "msg") return;
      const m = env.payload;
      if (m.t === "session.list" && !subscribed) {
        // 一覧を受けて最初のセッションを subscribe → 入力送信(多重化経路を検証)
        subscribed = true;
        const sid = m.sessions[0].id;
        log("[stage] client subscribe " + sid);
        client.send(JSON.stringify({ t: "msg", payload: { t: "session.subscribe", sessionId: sid } }));
        setTimeout(() => client.send(JSON.stringify({ t: "msg", payload: { t: "input", sessionId: sid, data: `echo ${MARKER}\n` } })), 300);
      } else if (m.t === "output" || m.t === "snapshot") {
        buf += m.data;
        if (buf.split(MARKER).length > 2) finish(true, "list→subscribe→input→output の多重化往復を確認");
      }
    });
  }, 400);
}

setTimeout(() => finish(false, "タイムアウト(往復未確認)"), 6000);
