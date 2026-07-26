// E2EE 検証用の常駐ホスト: ペアリングを生成し RelayClient(E2EE)で接続、
// 生成したペアリングURL(hpk/ps入り)を pairing-url.txt に書き出す。Playwright がこれを開く。
import * as fs from "fs";
import { SessionManager } from "./src/sessionManager";
import { RelayClient } from "./src/relayClient";
import { createPairing, buildPairingUrl } from "./src/pairing";

(async () => {
  const relay = process.env.RELAY_URL || "ws://localhost:8787";
  const clientBase = process.env.CLIENT_BASE || "http://localhost:8787";
  // ⚠️ room は毎回乱数にする。固定名だと、過去に漏れたペアリング秘密が
  // 将来のセッションでも有効になりうる(F20: pairing-url.txt が公開物に混入した)。
  const room = "e2ee" + Math.random().toString(36).slice(2, 10) + Date.now();
  const pairing = await createPairing(room);
  const url = buildPairingUrl(pairing, clientBase, relay);
  fs.writeFileSync(__dirname + "/pairing-url.txt", url + "\n");

  const mgr = new SessionManager();
  const rc = new RelayClient(relay, mgr, (m) => console.log("[host]", m), room, pairing, undefined,
    { pty: true, agentMirror: true, agentControl: false, push: false });
  rc.start();
  mgr.create({ preset: "bash", cwd: process.env.HOME });
  console.log("[host] E2EE host up");
  setInterval(() => {}, 1 << 30);
})();
