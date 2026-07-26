// 機能B: 会話読み取りの検証(実データ)。
import { listConversations, readConversation } from "./src/conversations";
const t0 = Date.now();
const list = listConversations();
console.log(`一覧: ${list.length}件 / ${Date.now() - t0}ms`);
for (const m of list.slice(0, 8)) {
  console.log(`  [${m.source}] ${m.title}`);
}
const bySource: Record<string, number> = {};
for (const m of list) bySource[m.source] = (bySource[m.source] ?? 0) + 1;
console.log("内訳:", bySource);
for (const src of ["antigravity-ide", "antigravity-cli", "claude-code"]) {
  const m = list.find((x) => x.source === src);
  if (!m) { console.log(`\n--- ${src}: 該当なし ---`); continue; }
  const t1 = Date.now();
  const text = readConversation(m);
  console.log(`\n--- ${src} 本文 (${Buffer.byteLength(text)}B / ${Date.now() - t1}ms) ---`);
  console.log(text.replace(/\r/g, "").split("\n").slice(0, 8).map((l) => "  " + l.slice(0, 100)).join("\n"));
}
