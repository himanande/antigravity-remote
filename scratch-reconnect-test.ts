// TASK-15 検証: クライアント切断→再接続で (1)セッション一覧が再同期 (2)購読中セッションの
// scrollback が snapshot で復元(切断中の出力も含む) (3)セッションは実行継続。
import * as fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
// @ts-ignore JS
import relayLogic from "./relay/logic";
import { SessionManager } from "./src/sessionManager";
import { RelayClient } from "./src/relayClient";

const RESULT = __dirname + "/reconnect-result.txt";
const log = (s: string) => fs.appendFileSync(RESULT, s + "\n");
fs.writeFileSync(RESULT, "");
let done = false;
const finish = (ok: boolean, msg: string) => { if (done) return; done = true; log((ok ? "PASS: " : "FAIL: ") + msg); process.exit(ok ? 0 : 1); };

const PORT = 8814;
const wss = new WebSocketServer({ port: PORT }, () => {
  (relayLogic as any).attach(wss);
  const URL = `ws://localhost:${PORT}`;
  const manager = new SessionManager();
  const relay = new RelayClient(URL, manager, () => {}, "room");
  relay.start();
  const s1 = manager.create({ preset: "bash", cwd: process.env.HOME });

  const M1 = "BEFORE_" + Date.now();
  const M2 = "DURING_" + Date.now();

  // 1回目の接続: subscribe → M1 を出力させる
  const c1 = new WebSocket(URL);
  const send1 = (m: any) => c1.readyState === 1 && c1.send(JSON.stringify({ t: "msg", payload: m }));
  let got1 = "";
  c1.on("open", () => {
    c1.send(JSON.stringify({ t: "hello", role: "client" }));
    send1({ t: "client.hello", protocol: 1 });
    send1({ t: "session.list.request" });
  });
  c1.on("message", (raw) => {
    const env = JSON.parse(raw.toString());
    if (env.t !== "msg") return;
    const m = env.payload;
    if (m.t === "session.list") { send1({ t: "session.subscribe", sessionId: s1.id }); setTimeout(() => send1({ t: "input", sessionId: s1.id, data: `echo ${M1}\n` }), 200); }
    else if (m.t === "output" || m.t === "snapshot") { got1 += m.data; if (got1.includes(M1)) step2(); }
  });

  let stepped = false;
  function step2() {
    if (stepped) return; stepped = true;
    log("[t] 1回目: M1 出力を確認 → 切断");
    c1.close();
    // 切断中に M2 を出力(セッションは動き続ける)
    setTimeout(() => manager.write(s1.id, `echo ${M2}\n`), 300);
    // 再接続
    setTimeout(reconnect, 800);
  }

  function reconnect() {
    log("[t] 再接続");
    const c2 = new WebSocket(URL);
    const send2 = (m: any) => c2.readyState === 1 && c2.send(JSON.stringify({ t: "msg", payload: m }));
    let listSeen = false, snap = "";
    c2.on("open", () => {
      c2.send(JSON.stringify({ t: "hello", role: "client" }));
      send2({ t: "client.hello", protocol: 1 });
      send2({ t: "session.list.request" });
    });
    c2.on("message", (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.t !== "msg") return;
      const m = env.payload;
      if (m.t === "session.list") {
        if (!m.sessions.find((s: any) => s.id === s1.id)) return finish(false, "再接続後の一覧に元セッションが無い");
        if (!listSeen) { listSeen = true; log("[t] 再接続: 一覧に元セッション有り"); send2({ t: "session.subscribe", sessionId: s1.id }); }
      } else if (m.t === "snapshot" || m.t === "output") {
        snap += m.data;
        if (snap.includes(M1) && snap.includes(M2)) {
          finish(true, "再接続で 一覧再同期 + scrollback復元(切断前M1・切断中M2 の両方)を確認");
        }
      }
    });
  }
});

setTimeout(() => finish(false, "タイムアウト"), 10000);
