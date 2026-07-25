// TASK-22 / F18: 接続レート制限(RateGate DO)の検証。
// 実WebSocketアップグレードで試す。curl(Upgradeなし)は 426 で手前に返るため制限に到達しない。
// 前提: `wrangler dev --port 8790 --local` 起動中。
const fs = require("fs");
const { WebSocket } = require("ws");

const BASE = process.env.CF_URL || "ws://127.0.0.1:8790";
const RESULT = __dirname + "/ratelimit-result.txt";
const log = (s) => (fs.appendFileSync(RESULT, s + "\n"), console.log(s));
fs.writeFileSync(RESULT, "");

// GATE_PER_MIN=20 / GATE_BURST=40 / GATE_BLOCK_MS=60000
const BURST = 40;

let fails = 0;
const check = (name, cond, detail) => {
  log(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
  if (!cond) fails++;
};

// room を毎回変え、RelayRoom 側の同時接続上限(host2)と切り分ける
const attempt = (i) =>
  new Promise((res) => {
    const ws = new WebSocket(`${BASE}/ws?room=Z2F0ZXRlc3Q${i}x${Date.now()}&role=host`);
    const done = (r) => {
      try { ws.close(); } catch {}
      res(r);
    };
    ws.once("open", () => done("open"));
    ws.once("unexpected-response", (_q, r) => done(String(r.statusCode)));
    ws.once("error", () => done("err"));
    setTimeout(() => done("timeout"), 10000);
  });

const run = async (n) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await attempt(i));
  return out;
};

(async () => {
  // 1. バースト分(40)は通り、それを超えると 429 になる
  const r1 = await run(BURST + 15);
  const opened = r1.filter((r) => r === "open").length;
  const blocked = r1.filter((r) => r === "429").length;
  const firstBlock = r1.indexOf("429") + 1;
  check(
    `バースト${BURST}本前後まで通る`,
    opened >= BURST - 5 && opened <= BURST + 5,
    `通った=${opened} 初めて429=${firstBlock}回目`
  );
  check("上限超過は 429 で拒否される", blocked > 0, `429=${blocked}件`);

  // 2. 一度ブロックされたら継続して拒否される(バケツが即回復しない)
  const r2 = await run(5);
  check("ブロック中は継続して拒否", r2.every((r) => r === "429"), `内訳=${r2.join(",")}`);

  // 3. DO の退避(eviction)を狙って間隔を空けても、blockedUntil が永続化されているので回避できない
  log("  …15秒待って DO の退避を誘発してから再試行");
  await new Promise((r) => setTimeout(r, 15000));
  const r3 = await run(3);
  check(
    "間隔を空けてもブロックが維持される(永続化の確認)",
    r3.every((r) => r === "429"),
    `内訳=${r3.join(",")}`
  );

  log(fails === 0 ? "\nALL PASS" : `\n${fails} 件 FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})();
