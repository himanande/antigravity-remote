// TASK-22: リレーの上限(room検証 / 同時接続数 / メッセージサイズ / 流量)の検証。
// 前提: `wrangler dev --port 8790 --local` 起動中。
const fs = require("fs");
const { WebSocket } = require("ws");

const HTTP = process.env.CF_HTTP || "http://127.0.0.1:8790";
const WS = HTTP.replace(/^http/, "ws");
const RESULT = __dirname + "/limits-result.txt";
const log = (s) => fs.appendFileSync(RESULT, s + "\n");
fs.writeFileSync(RESULT, "");

const room = (n) => `Zm9vYmFy${n}${Date.now()}`.slice(0, 40); // 合法な形の room
const open = (r, role) =>
  new Promise((res) => {
    const ws = new WebSocket(`${WS}/ws?room=${r}&role=${role}`);
    ws.once("open", () => res({ ws, ok: true }));
    ws.once("unexpected-response", (_q, r2) => res({ ok: false, status: r2.statusCode }));
    ws.once("error", () => res({ ok: false, status: 0 }));
  });
const closed = (ws) =>
  new Promise((res) => ws.once("close", (code, reason) => res({ code, reason: String(reason) })));

let fails = 0;
const check = (name, cond, detail) => {
  log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails++;
};

(async () => {
  // 1. room の形式検証
  for (const bad of ["", "ab", "a".repeat(200), "bad room!", "../../etc"]) {
    const res = await fetch(`${HTTP}/ws?room=${encodeURIComponent(bad)}&role=host`);
    check(`不正な room を拒否 (${JSON.stringify(bad.slice(0, 12))})`, res.status === 400, `status=${res.status}`);
  }
  const okRoom = await fetch(`${HTTP}/ws?room=${room("v")}&role=host`);
  check("正しい room は 400 にならない", okRoom.status !== 400, `status=${okRoom.status}`);

  // 2. room あたりの同時接続上限(client は 6 まで)
  const r2 = room("f");
  const socks = [];
  for (let i = 0; i < 6; i++) {
    const c = await open(r2, "client");
    if (c.ok) socks.push(c.ws);
  }
  check("client 6本まで接続できる", socks.length === 6, `接続できた本数=${socks.length}`);
  const seventh = await open(r2, "client");
  check("7本目は拒否される", !seventh.ok && seventh.status === 429, `status=${seventh.status}`);
  const h1 = await open(r2, "host");
  const h2 = await open(r2, "host");
  const h3 = await open(r2, "host");
  check("host は 2本まで(再接続の重なり用)", h1.ok && h2.ok && !h3.ok, `3本目 status=${h3.status}`);
  for (const s of socks) s.close();
  if (h1.ok) h1.ws.close();
  if (h2.ok) h2.ws.close();

  // 3. メッセージサイズ上限 → close 1009
  const r3 = room("s");
  const big = await open(r3, "client");
  const bigClosed = closed(big.ws);
  big.ws.send(JSON.stringify({ t: "msg", payload: "x".repeat(600 * 1024) }));
  const bc = await Promise.race([bigClosed, new Promise((r) => setTimeout(() => r({ code: 0 }), 5000))]);
  check("512KB 超のメッセージで切断(1009)", bc.code === 1009, `code=${bc.code} reason=${bc.reason}`);

  // 4. 流量上限 → close 1008(バースト1200 + 1秒あたり300回復 を超える量を一気に送る)
  const r4 = room("r");
  const flood = await open(r4, "client");
  const floodClosed = closed(flood.ws);
  for (let i = 0; i < 3000; i++) flood.ws.send(JSON.stringify({ t: "msg", payload: i }));
  const fc = await Promise.race([floodClosed, new Promise((r) => setTimeout(() => r({ code: 0 }), 5000))]);
  check("流量超過で切断(1008)", fc.code === 1008, `code=${fc.code} reason=${fc.reason}`);

  // 5. 通常の中継が壊れていないこと
  const r5 = room("n");
  const host = await open(r5, "host");
  const cli = await open(r5, "client");
  const got = new Promise((res) => {
    host.ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString());
      if (e.t === "msg" && e.payload && e.payload.t === "input") res(e.payload.data);
    });
  });
  cli.ws.send(JSON.stringify({ t: "msg", payload: { t: "input", data: "hello" } }));
  const data = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 5000))]);
  check("通常の中継は従来どおり動く", data === "hello", `受信=${data}`);
  host.ws.close();
  cli.ws.close();

  log(fails === 0 ? "\nALL PASS" : `\n${fails} 件 FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})();
