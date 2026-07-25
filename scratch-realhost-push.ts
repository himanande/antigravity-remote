// push 対応の常駐ホスト(平文・UI検証用)。notify ボタン表示と SW 登録の確認に使う。
import { SessionManager } from "./src/sessionManager";
import { RelayClient } from "./src/relayClient";
import { PushSender, generateVapidKeys } from "./src/push";

const url = process.env.RELAY_URL || "ws://localhost:8787";
const mgr = new SessionManager();
const push = new PushSender(generateVapidKeys(), "mailto:test@local", (m) => console.log("[host]", m));
const rc = new RelayClient(url, mgr, (m) => console.log("[host]", m), "default-room", undefined, push);
rc.start();
mgr.create({ preset: "bash", cwd: process.env.HOME });
console.log("[host] push-enabled host up");
setInterval(() => {}, 1 << 30);
