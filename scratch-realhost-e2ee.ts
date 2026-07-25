// E2EE 検証用の常駐ホスト: ペアリングを生成し RelayClient(E2EE)で接続、
// 生成したペアリングURL(hpk/ps入り)を pairing-url.txt に書き出す。Playwright がこれを開く。
import * as fs from "fs";
import { SessionManager } from "./src/sessionManager";
import { RelayClient } from "./src/relayClient";
import { createPairing, buildPairingUrl } from "./src/pairing";

(async () => {
  const relay = process.env.RELAY_URL || "ws://localhost:8787";
  const clientBase = process.env.CLIENT_BASE || "http://localhost:8787";
  const room = "e2ee-room";
  const pairing = await createPairing(room);
  const url = buildPairingUrl(pairing, clientBase, relay);
  fs.writeFileSync(__dirname + "/pairing-url.txt", url + "\n");

  const mgr = new SessionManager();
  const rc = new RelayClient(relay, mgr, (m) => console.log("[host]", m), room, pairing);
  rc.start();
  mgr.create({ preset: "bash", cwd: process.env.HOME });
  console.log("[host] E2EE host up");
  setInterval(() => {}, 1 << 30);
})();
