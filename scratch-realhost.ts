// 実 SessionManager + RelayClient を使う常駐ホスト(拡張のヘッドレス相当)。
// リレーに接続し、初期 bash セッションを1本作って生かし続ける。UI検証用。
import { SessionManager } from "./src/sessionManager";
import { RelayClient } from "./src/relayClient";

const url = process.env.RELAY_URL || "ws://localhost:8787";
const mgr = new SessionManager();
const relay = new RelayClient(url, mgr, (m) => console.log("[host]", m));
relay.start();
mgr.create({ preset: "bash", cwd: process.env.HOME });
console.log("[host] started, initial bash session created");
setInterval(() => {}, 1 << 30); // keep alive
