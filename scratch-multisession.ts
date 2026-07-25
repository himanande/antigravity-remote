// TASK-11 検証: 実モジュール(SessionManager + RelayClient + リレーlogic)を通して
// 2本の pty を同時ホストし、(1)一覧に2件出る (2)subscribe したセッションのみ出力が届く
// (3)片方の入出力がもう片方に混線しない、を確認する。
// esbuild で束ねて実行(scratch-run.js 参照)。
import * as fs from "fs";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
// @ts-ignore JS モジュール
import relayLogic from "./relay/logic";
import { SessionManager } from "./src/sessionManager";
import { RelayClient } from "./src/relayClient";

const RESULT = __dirname + "/e2e-result.txt";
const log = (s: string) => fs.appendFileSync(RESULT, s + "\n");
fs.writeFileSync(RESULT, "");

const PORT = 8803;
const server = http.createServer();
const wss = new WebSocketServer({ server });
(relayLogic as any).attach(wss);

let done = false;
function finish(ok: boolean, msg: string) {
  if (done) return;
  done = true;
  log((ok ? "PASS: " : "FAIL: ") + msg);
  try { wss.close(); server.close(); } catch {}
  process.exit(ok ? 0 : 1);
}

server.listen(PORT, () => {
  log("[stage] relay listening " + PORT);
  const URL = `ws://localhost:${PORT}`;

  // ホスト側: SessionManager に bash 2本
  const manager = new SessionManager();
  const relay = new RelayClient(URL, manager, (m) => log("[host] " + m));
  relay.start();
  const s1 = manager.create({ preset: "bash", cwd: process.env.HOME });
  const s2 = manager.create({ preset: "bash", cwd: process.env.HOME });
  log(`[stage] created ${s1.id}, ${s2.id}`);

  // クライアント役
  setTimeout(() => {
    const client = new WebSocket(URL);
    const send = (payload: any) => client.readyState === 1 && client.send(JSON.stringify({ t: "msg", payload }));
    const bufs: Record<string, string> = {};
    const A = "AAA_" + Date.now();
    const B = "BBB_" + Date.now();
    let phase = 0;

    client.on("open", () => {
      client.send(JSON.stringify({ t: "hello", role: "client" }));
      send({ t: "client.hello", protocol: 1 });
      send({ t: "session.list.request" });
    });
    client.on("message", (raw) => {
      const env = JSON.parse(raw.toString());
      if (env.t !== "msg") return;
      const m = env.payload;

      if (m.t === "session.list") {
        if (m.sessions.length !== 2) return finish(false, `一覧が2件でない: ${m.sessions.length}`);
        log("[stage] session.list に2件確認");
        // s1 を subscribe → 入力 A
        phase = 1;
        send({ t: "session.subscribe", sessionId: s1.id });
        setTimeout(() => send({ t: "input", sessionId: s1.id, data: `echo ${A}\n` }), 200);
        // s2 はまだ subscribe しない(スコープ検証: s2 の出力が来ないこと)
        setTimeout(checkPhase1, 1200);
      } else if (m.t === "output" || m.t === "snapshot") {
        bufs[m.sessionId] = (bufs[m.sessionId] || "") + m.data;
      }
    });

    function checkPhase1() {
      const b1 = bufs[s1.id] || "";
      const b2 = bufs[s2.id] || "";
      if (!b1.includes(A)) return finish(false, "s1 に入力A の結果が出ない");
      if (b2.length > 0) return finish(false, "未subscribeの s2 の出力が届いた(スコープ違反)");
      log("[stage] phase1 OK: s1にA出力あり / s2出力なし");
      // s2 を subscribe → 入力 B
      phase = 2;
      send({ t: "session.subscribe", sessionId: s2.id });
      setTimeout(() => send({ t: "input", sessionId: s2.id, data: `echo ${B}\n` }), 200);
      setTimeout(checkPhase2, 1200);
    }

    function checkPhase2() {
      const b1 = bufs[s1.id] || "";
      const b2 = bufs[s2.id] || "";
      if (!b2.includes(B)) return finish(false, "s2 に入力B の結果が出ない");
      if (b2.includes(A)) return finish(false, "s2 に s1 の入力A が混線");
      if (b1.includes(B)) return finish(false, "s1 に s2 の入力B が混線");
      finish(true, "2セッション多重化: 一覧2件・subscribeスコープ・混線なし を確認");
    }
  }, 400);
});

setTimeout(() => finish(false, "タイムアウト"), 8000);
