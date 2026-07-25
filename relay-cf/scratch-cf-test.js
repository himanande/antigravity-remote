// CF リレー(wrangler dev, RelayRoom DO)の疎通テスト。
// host/client を role クエリで接続し、peer-joined 通知・msg 中継・多重化往復を確認する。
// 前提: `wrangler dev --port 8790 --local` 起動中。
const fs = require("fs");
const { WebSocket } = require("ws");

const BASE = process.env.CF_URL || "ws://127.0.0.1:8790";
const ROOM = "test-" + Date.now();
const RESULT = __dirname + "/cf-result.txt";
const log = (s) => { fs.appendFileSync(RESULT, s + "\n"); };
fs.writeFileSync(RESULT, "");

let done = false;
const finish = (ok, msg) => {
  if (done) return; done = true;
  log((ok ? "PASS: " : "FAIL: ") + msg);
  process.exit(ok ? 0 : 1);
};

const SID = "main";
const meta = { id: SID, kind: "pty", title: "bash", status: "running", createdAt: Date.now(), preset: "bash" };

// host 役
const host = new WebSocket(`${BASE}/ws?room=${ROOM}&role=host`);
const hsend = (o) => host.readyState === 1 && host.send(JSON.stringify(o));
const hToClient = (m) => hsend({ t: "msg", payload: m });
host.on("open", () => log("[host] open"));
host.on("error", (e) => finish(false, "host err " + e.message));
host.on("message", (raw) => {
  const env = JSON.parse(raw.toString());
  if (env.t === "peer-joined" && env.role === "client") {
    log("[host] peer-joined(client) 受信 → list/snapshot");
    hToClient({ t: "session.list", sessions: [meta] });
    hToClient({ t: "snapshot", sessionId: SID, data: "(sb)\n" });
  }
  if (env.t !== "msg") return;
  const m = env.payload;
  if (m.t === "session.list.request") hToClient({ t: "session.list", sessions: [meta] });
  else if (m.t === "session.subscribe") hToClient({ t: "snapshot", sessionId: SID, data: "(sb)\n" });
  else if (m.t === "input") {
    // 疑似シェル: 入力をそのまま結果としてエコー(PTYなしでも中継検証できる)
    hToClient({ t: "output", sessionId: SID, data: "RESULT:" + m.data });
  }
});

// client 役(host 接続後に接続)
setTimeout(() => {
  const client = new WebSocket(`${BASE}/ws?room=${ROOM}&role=client`);
  const csend = (m) => client.readyState === 1 && client.send(JSON.stringify({ t: "msg", payload: m }));
  let buf = "";
  const MARKER = "CF_OK_" + Date.now();
  let subscribed = false;
  client.on("open", () => {
    log("[client] open");
    csend({ t: "client.hello", protocol: 1 });
    csend({ t: "session.list.request" });
  });
  client.on("error", (e) => finish(false, "client err " + e.message));
  client.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.t !== "msg") return;
    const m = env.payload;
    if (m.t === "session.list" && !subscribed) {
      subscribed = true;
      log("[client] session.list 受信(" + m.sessions.length + "件)→ subscribe/input");
      csend({ t: "session.subscribe", sessionId: m.sessions[0].id });
      setTimeout(() => csend({ t: "input", sessionId: SID, data: MARKER }), 150);
    } else if (m.t === "output" || m.t === "snapshot") {
      buf += m.data;
      if (buf.includes("RESULT:" + MARKER)) {
        finish(true, "CF DO 経由で peer-joined→list→subscribe→input→output 往復を確認");
      }
    }
  });
}, 600);

setTimeout(() => finish(false, "タイムアウト(CF往復未確認)"), 8000);
