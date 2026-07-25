// 拡張機能を1ファイルにバンドルする。vscode と node-pty(ネイティブ)は外部化する。
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // vscode は実行時に注入される。node-pty はネイティブ .node を含むため
  // バンドルせず node_modules から解決させる(electron-rebuild でABI一致必須)。
  external: ["vscode", "node-pty"],
  logLevel: "info",
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching...");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] build done");
  }
})();
