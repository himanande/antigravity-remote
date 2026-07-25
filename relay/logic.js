// リレーの中継ロジック(host/client 各1本を結線して msg をそのまま転送)。
// server.js(本番配信付き)と scratch-e2e.js(テスト)で同一コードを使う。
// リレーは payload の中身を解釈しない = 将来E2EEでもゼロナレッジ(ADR-002)。

/** @param {import('ws').WebSocketServer} wss */
function attach(wss, logFn) {
  const log = logFn || (() => {});
  const peers = { host: null, client: null };

  wss.on("connection", (ws) => {
    let role = null;
    ws.on("message", (raw) => {
      let env;
      try { env = JSON.parse(raw.toString()); } catch { return; }

      if (env.t === "hello" && (env.role === "host" || env.role === "client")) {
        role = env.role;
        peers[role] = ws;
        log(`${role} 接続`);
        const other = role === "host" ? peers.client : peers.host;
        if (other && other.readyState === 1) other.send(JSON.stringify({ t: "peer-joined", role }));
        return;
      }
      if (env.t === "msg") {
        const other = role === "host" ? peers.client : peers.host;
        if (other && other.readyState === 1) other.send(raw.toString());
      }
    });
    ws.on("close", () => {
      if (role && peers[role] === ws) {
        peers[role] = null;
        log(`${role} 切断`);
        const other = role === "host" ? peers.client : peers.host;
        if (other && other.readyState === 1) other.send(JSON.stringify({ t: "peer-left", role }));
      }
    });
  });
}

module.exports = { attach };
