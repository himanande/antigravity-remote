// F22: 終了済みセッションへの操作でホストが落ちないことを確認する。
// 修正前は resize が node-pty の ioctl(2) EBADF を投げ、**ホストプロセスごと死んだ**。
// スマホで終了済みセッションを開くだけで resize が飛ぶため、誰でも踏める経路だった。
import * as fs from "fs";
import { SessionManager } from "./src/sessionManager";

const RESULT = __dirname + "/deadsession-result.txt";
const log = (s: string) => (fs.appendFileSync(RESULT, s + "\n"), console.log(s));
fs.writeFileSync(RESULT, "");

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

(async () => {
  const mgr = new SessionManager();

  // 1) 存在しないコマンドのプリセットでも、ホストは生き残る
  let meta;
  try {
    meta = mgr.create({ preset: "gemini", cwd: process.env.HOME! }); // 未インストール想定
    check("未インストールのプリセットでも create が例外を投げない", true);
  } catch (e) {
    check("未インストールのプリセットでも create が例外を投げない", false, (e as Error).message);
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 1200)); // 終了するまで待つ

  // 2) 終了済みに resize → 落ちない
  try {
    mgr.resize(meta.id, 120, 40);
    check("終了済みセッションへの resize でホストが落ちない", true);
  } catch (e) {
    check("終了済みセッションへの resize でホストが落ちない", false, (e as Error).message);
  }

  // 3) 終了済みに write → 落ちない
  try {
    mgr.write(meta.id, "echo hello\r");
    check("終了済みセッションへの write でホストが落ちない", true);
  } catch (e) {
    check("終了済みセッションへの write でホストが落ちない", false, (e as Error).message);
  }

  // 4) 生きているセッションは従来どおり動く(退行がないこと)
  const alive = mgr.create({ preset: "bash", cwd: process.env.HOME! });
  let out = "";
  mgr.onData((id, chunk) => { if (id === alive.id) out += chunk; });
  mgr.resize(alive.id, 100, 30);
  mgr.write(alive.id, "echo STILL_WORKS\r");
  await new Promise((r) => setTimeout(r, 1500));
  check("生存セッションは resize/write が従来どおり効く", out.includes("STILL_WORKS"), out.slice(-60).replace(/\n/g, "⏎"));

  // 5) close 済みに操作 → 落ちない
  mgr.close(alive.id);
  await new Promise((r) => setTimeout(r, 400));
  try {
    mgr.resize(alive.id, 90, 25);
    mgr.write(alive.id, "x");
    check("close 済みセッションへの操作でも落ちない", true);
  } catch (e) {
    check("close 済みセッションへの操作でも落ちない", false, (e as Error).message);
  }

  log(fails === 0 ? "\nALL PASS" : `\n${fails} 件 FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})();
