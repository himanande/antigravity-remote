// TASK-16 検証: 入力待ち検出 → push 送信の一連を確認する。
// 偽の push エンドポイント(HTTP)を立て、bash セッションが確認プロンプトを出力したら
// RelayClient が web-push で暗号化 POST してくることを捕捉する。
import * as fs from "fs";
import * as https from "https";
import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
// @ts-ignore JS
import relayLogic from "./relay/logic";
import { SessionManager } from "./src/sessionManager";
import { RelayClient } from "./src/relayClient";
import { PushSender, generateVapidKeys } from "./src/push";

const RESULT = __dirname + "/push-result.txt";
const log = (s: string) => fs.appendFileSync(RESULT, s + "\n");
fs.writeFileSync(RESULT, "");
let done = false;
const finish = (ok: boolean, msg: string) => { if (done) return; done = true; log((ok ? "PASS: " : "FAIL: ") + msg); process.exit(ok ? 0 : 1); };

// 偽 push エンドポイント(web-push は https 必須)。自己署名証明書を使う。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const CERT_DIR = process.env.CERT_DIR || ".";
const PUSH_PORT = 8811;
const pushSrv = https.createServer(
  { key: fs.readFileSync(CERT_DIR + "/key.pem"), cert: fs.readFileSync(CERT_DIR + "/cert.pem") },
  (req, res) => {
  let body = Buffer.alloc(0);
  req.on("data", (d) => { body = Buffer.concat([body, d]); });
  req.on("end", () => {
    const auth = req.headers["authorization"] || "";
    const ttl = req.headers["ttl"];
    log(`[push-endpoint] POST 受信: hasVapid=${/vapid/i.test(String(auth))} ttl=${ttl} bodyLen=${body.length}`);
    res.writeHead(201).end();
    if (/vapid/i.test(String(auth)) && body.length > 0) {
      finish(true, "入力待ち検出→web-push暗号化POSTを push エンドポイントで捕捉(VAPID認証付き)");
    } else {
      finish(false, "POSTは来たが VAPID/本文が不正");
    }
  });
  }
);

// 有効な subscription(P-256 鍵)を生成
function makeSubscription(endpoint: string) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { endpoint, expirationTime: null, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(crypto.randomBytes(16)) } };
}

const RELAY_PORT = 8812;
const wss = new WebSocketServer({ port: RELAY_PORT }, () => {
  (relayLogic as any).attach(wss);
  pushSrv.listen(PUSH_PORT, () => {
    const URL = `ws://localhost:${RELAY_PORT}`;
    const manager = new SessionManager(); // 既定 promptPatterns
    const push = new PushSender(generateVapidKeys(), "mailto:test@local", (m) => log("[host] " + m));
    const relay = new RelayClient(URL, manager, (m) => log("[host] " + m), "room", undefined, push);
    relay.start();
    const s1 = manager.create({ preset: "bash", cwd: process.env.HOME });

    // クライアント: push 購読だけ登録し、セッションは subscribe しない(非表示中に通知が来る想定)
    const client = new WebSocket(URL);
    client.on("open", () => {
      client.send(JSON.stringify({ t: "hello", role: "client" }));
      client.send(JSON.stringify({ t: "msg", payload: { t: "client.hello", protocol: 1 } }));
      const sub = makeSubscription(`https://localhost:${PUSH_PORT}/push/abc`);
      client.send(JSON.stringify({ t: "msg", payload: { t: "push.subscribe", subscription: sub } }));
      // 購読登録後に、プロンプトを出力させて入力待ちを誘発
      setTimeout(() => {
        manager.write(s1.id, "echo 'Do you want to proceed?'\n");
      }, 500);
    });
  });
});

setTimeout(() => finish(false, "タイムアウト(push未捕捉)"), 8000);
