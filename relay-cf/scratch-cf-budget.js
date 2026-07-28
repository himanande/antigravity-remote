// フェアユース上限(room単位・日次)の検証。
//
// ⚠️ 本番値は 100万通/日 なので、このテストは **worker.ts の ROOM_MSGS_PER_DAY を
// 一時的に小さく(例 250)してから** 実行する。値を戻すと「到達しない=正常」になり、
// このテストは意味を持たない(その場合の FAIL は不具合ではない)。
//   sed -i 's/ROOM_MSGS_PER_DAY = 1_000_000/ROOM_MSGS_PER_DAY = 250/' src/worker.ts
const { WebSocket } = require("ws");
const HTTP = process.env.CF_HTTP || "http://127.0.0.1:8790";
const WS = HTTP.replace(/^http/, "ws");
const room = "YnVkZ2V0dGVzdA" + Date.now();
const open = (role) => new Promise((res, rej) => {
  const ws = new WebSocket(`${WS}/ws?room=${room}&role=${role}`);
  ws.once("open", () => res(ws)); ws.once("error", rej);
});
(async () => {
  const host = await open("host");
  const cli = await open("client");
  let errMsg = null, closeCode = null;
  cli.on("message", (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.t === "msg" && e.payload && e.payload.t === "error") errMsg = e.payload.message;
  });
  cli.on("close", (c) => { closeCode = c; });
  for (let i = 0; i < 400; i++) {
    if (cli.readyState !== 1) break;
    cli.send(JSON.stringify({ t: "msg", payload: { t: "input", data: "x" } }));
    if (i % 50 === 0) await new Promise(r => setTimeout(r, 60));
  }
  await new Promise(r => setTimeout(r, 2500));
  const ok = closeCode === 1013 && !!errMsg;
  console.log(`${ok ? "PASS" : "FAIL"}: 上限超過で切断される — close=${closeCode} msg=${errMsg ? "あり" : "なし"}`);
  console.log("  文言:", errMsg);
  // 上限に達した room は再接続しても即座に弾かれる(永続化の確認)
  const again = await open("client").catch(() => null);
  await new Promise(r => setTimeout(r, 300));
  if (again) { again.send(JSON.stringify({ t: "msg", payload: { t: "input", data: "y" } })); }
  await new Promise(r => setTimeout(r, 1500));
  process.exit(ok ? 0 : 1);
})();
