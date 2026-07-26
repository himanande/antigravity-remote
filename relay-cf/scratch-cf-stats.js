// TASK-27 / ADR-009: 軽量テレメトリの検証。
// 前提: `STATS_KEY=testkey npx wrangler dev --port 8790 --local` 起動中。
const fs = require("fs");
const { WebSocket } = require("ws");

const HTTP = process.env.CF_HTTP || "http://127.0.0.1:8790";
const WS = HTTP.replace(/^http/, "ws");
const KEY = process.env.STATS_KEY || "testkey";
const RESULT = __dirname + "/stats-result.txt";
const log = (s) => (fs.appendFileSync(RESULT, s + "\n"), console.log(s));
fs.writeFileSync(RESULT, "");

let fails = 0;
const check = (name, cond, detail) => {
  log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails++;
};

const today = new Date().toISOString().slice(0, 10);
const readStats = async () => {
  const r = await fetch(`${HTTP}/stats?key=${encodeURIComponent(KEY)}&days=1`);
  if (r.status !== 200) throw new Error("stats status=" + r.status);
  return (await r.json())[today];
};

const open = (room, role) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(`${WS}/ws?room=${room}&role=${role}`);
    ws.once("open", () => res(ws));
    ws.once("unexpected-response", (_q, r) => rej(new Error(role + " status=" + r.statusCode)));
    ws.once("error", rej);
  });
const closed = (ws) => new Promise((r) => ws.once("close", (c) => r(c)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 秘密なし/誤りでは存在を伏せる
  check("key なしは 404", (await fetch(`${HTTP}/stats`)).status === 404);
  check("key 誤りは 404", (await fetch(`${HTTP}/stats?key=wrong`)).status === 404);
  check("key 正しいと 200", (await fetch(`${HTTP}/stats?key=${KEY}&days=1`)).status === 200);

  const before = await readStats();
  log("  初期値: " + JSON.stringify(before));

  // 2. メッセージ数・バイト数・方向が数えられる
  const room = "c3RhdHN0ZXN0" + Date.now();
  const host = await open(room, "host");
  const cli = await open(room, "client");
  const N = 120; // STATS_FLUSH_EVERY(100)を超える数
  for (let i = 0; i < N; i++) cli.send(JSON.stringify({ t: "msg", payload: { t: "input", data: "x" } }));
  await sleep(1500);
  const mid = await readStats();
  check(
    `client→host のメッセージが数えられる(${N}件送信)`,
    mid.msgClientToHost >= 100 && mid.msgClientToHost <= N,
    `計測=${mid.msgClientToHost - before.msgClientToHost}`
  );
  check("バイト数が増える", mid.bytes > before.bytes, `+${mid.bytes - before.bytes}`);

  // 3. 切断で sessions と connSeconds が確定する
  await sleep(2200);
  cli.close();
  await closed(cli);
  host.close();
  await closed(host);
  await sleep(1500);
  const after = await readStats();
  check("sessions が2本ぶん増える", after.sessions - before.sessions === 2, `+${after.sessions - before.sessions}`);
  check("connSeconds が計上される", after.connSeconds > before.connSeconds, `+${after.connSeconds - before.connSeconds}秒`);
  check(
    "切断時に端数のメッセージも回収される",
    after.msgClientToHost - before.msgClientToHost === N,
    `計測=${after.msgClientToHost - before.msgClientToHost} / 送信=${N}`
  );

  // 4. 拒否カウンタ: 満室
  const room2 = "cm9vbWZ1bGx0" + Date.now();
  const socks = [];
  for (let i = 0; i < 6; i++) socks.push(await open(room2, "client"));
  let full = 0;
  try { await open(room2, "client"); } catch { full = 1; }
  await sleep(1200);
  const s4 = await readStats();
  check("満室(roomFull)が数えられる", s4.roomFull - after.roomFull === 1, `+${s4.roomFull - after.roomFull} (拒否検知=${full})`);
  for (const s of socks) s.close();

  // 5. サイズ超過
  const room3 = "dG9vbGFyZ2V0" + Date.now();
  const big = await open(room3, "client");
  big.send(JSON.stringify({ t: "msg", payload: "x".repeat(600 * 1024) }));
  await closed(big);
  await sleep(1200);
  const s5 = await readStats();
  check("サイズ超過(tooLarge)が数えられる", s5.tooLarge - s4.tooLarge === 1, `+${s5.tooLarge - s4.tooLarge}`);

  // 6. 記録してはいけないものが混ざっていないこと
  const keys = Object.keys(s5).sort();
  const expected = ["bytes","connSeconds","msgClientToHost","msgHostToClient","rateLimited","roomFull","sessions","tooLarge"];
  check("集計項目が想定どおり(IP/room等が混ざっていない)", JSON.stringify(keys) === JSON.stringify(expected), keys.join(","));

  log("\n最終: " + JSON.stringify(s5));
  log(fails === 0 ? "\nALL PASS" : `\n${fails} 件 FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { log("EXCEPTION: " + e.message); process.exit(1); });
