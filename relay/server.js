// フェーズ0の最小WebSocketリレー(LAN内・単一ペア・平文)。
// host と client を1本ずつ受け、相手のメッセージをそのまま中継するだけ。
// リレーは中身を解釈しない(将来E2EEでも同じ=ゼロナレッジ設計 ADR-002)。
//
// 使い方: node relay/server.js  (PORT環境変数で変更可、既定8787)
// 静的に client/ も配信するので、スマホから http://<PCのLAN IP>:8787/ を開けばUIが出る。

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const relayLogic = require("./logic");

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const CLIENT_DIR = path.join(__dirname, "..", "client");

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || "/").split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(CLIENT_DIR, path.normalize(rel));
  if (!filePath.startsWith(CLIENT_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    const ext = path.extname(filePath);
    const type =
      ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript"
      : ext === ".webmanifest" ? "application/manifest+json"
      : "text/plain";
    res.writeHead(200, { "content-type": type }).end(buf);
  });
});

const wss = new WebSocketServer({ server });
relayLogic.attach(wss, log);

function log(m) {
  console.log(`[relay ${new Date().toISOString()}] ${m}`);
}

server.listen(PORT, () => {
  log(`listening on http://0.0.0.0:${PORT}  (client UI + ws)`);
});
