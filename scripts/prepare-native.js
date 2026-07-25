// node-pty のネイティブバイナリを dist/node_modules/node-pty へ集約する(TASK-21)。
//
// node-pty 1.1.0 は node-addon-api = Node-API(N-API)実装のため、バイナリは
// **Electron/Node のバージョンに依存しない**(ABI安定)。よって必要なのは
// 「Electronの世代ごとのビルド」ではなく「plat-arch ごとのバイナリ同梱」だけ。
//
// dist/node_modules に置くのは、dist/extension.js からの require("node-pty") を
// Node の解決規則でそこに当てるため(拡張は自己完結し、利用者側ビルド不要)。
//
// 使い方: node scripts/prepare-native.js [--verify]

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "node_modules", "node-pty");
const OUT = path.join(ROOT, "dist", "node_modules", "node-pty");

// 同梱対象。node-pty 公式prebuildsに無い linux-* は自前ビルドを vendor-prebuilds/ に置く。
const TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-arm64",
  "win32-x64",
  "linux-x64",
  "linux-arm64",
];

// 自前ビルドの置き場(CIで各OSからコミット or artifact 展開)
const VENDOR = path.join(ROOT, "vendor-prebuilds");

const isExcluded = (f) =>
  f.endsWith(".pdb") || // Windows デバッグシンボル(53MB)は不要
  f.endsWith(".map") ||
  f.endsWith(".test.js");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (!isExcluded(ent.name)) {
      fs.copyFileSync(s, d);
      // spawn-helper(macOS)や *.exe は実行ビットが必須
      fs.chmodSync(d, ent.name.endsWith(".exe") || ent.name === "spawn-helper" ? 0o755 : 0o644);
    }
  }
}

function du(dir) {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    n += ent.isDirectory() ? du(p) : fs.statSync(p).size;
  }
  return n;
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";

function main() {
  const verifyOnly = process.argv.includes("--verify");
  if (!verifyOnly) {
    fs.rmSync(OUT, { recursive: true, force: true });
    copyDir(path.join(SRC, "lib"), path.join(OUT, "lib"));

    // package.json は最小化(install/postinstall スクリプトを持ち込まない)
    const orig = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8"));
    fs.writeFileSync(
      path.join(OUT, "package.json"),
      JSON.stringify(
        { name: orig.name, version: orig.version, main: orig.main, license: orig.license },
        null,
        2
      ) + "\n"
    );
  }

  const found = [];
  const missing = [];
  for (const t of TARGETS) {
    const dst = path.join(OUT, "prebuilds", t);
    if (!verifyOnly) {
      const upstream = path.join(SRC, "prebuilds", t);
      const vendor = path.join(VENDOR, t);
      // 自前ビルドを優先(upstream に無い linux 等)
      if (fs.existsSync(vendor)) copyDir(vendor, dst);
      else if (fs.existsSync(upstream)) copyDir(upstream, dst);
    }
    if (fs.existsSync(path.join(dst, "pty.node"))) found.push(t);
    else missing.push(t);
  }

  console.log("同梱済み:", found.join(", ") || "(なし)");
  if (missing.length) console.log("未同梱  :", missing.join(", "), "← その環境では拡張が動きません");
  console.log("サイズ  :", fs.existsSync(OUT) ? mb(du(OUT)) : "-");

  if (missing.length && process.env.STRICT_NATIVE === "1") {
    console.error("STRICT_NATIVE=1: 全ターゲットが揃っていないため失敗させます");
    process.exit(1);
  }
}

main();
