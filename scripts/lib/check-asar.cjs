// ★ asar 检查工具（供 install-patched.ps1 调用 —— 不用 node -e 传内联 JS，
//   PS 5.1 会剥掉 -e 参数里的双引号导致语法坏，实测踩过）。
// 用法：
//   node check-asar.cjs extract <asar> <outMain.js>   抽出 main.js 写到 out；缺 marker 则 exit 1
//   node check-asar.cjs marker  <asar>                输出 yes/no（是否已打补丁）
//   node check-asar.cjs version <asar>                输出补丁版本（如 v4）；未打补丁输出 none
const fs = require("fs");
const [, , mode, asarPath, outPath] = process.argv;
if (!asarPath) { console.error("usage: check-asar.cjs extract|marker|version <asar> [outMain]"); process.exit(2); }
let buf;
try { buf = fs.readFileSync(asarPath); }
catch (e) { console.error("读 asar 失败: " + e.message); process.exit(2); }
const headerSize = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const s = buf.slice(16, 16 + jsonLen).toString("utf8");
const h = JSON.parse(s.slice(0, s.lastIndexOf("}") + 1));
const e = h.files.lib.files["main.js"];
const off = 8 + headerSize + Number(e.offset);           // ★ 官方公式（8 + headerSize）
const main = buf.slice(off, off + e.size);
const text = main.toString("utf8");
const versionMatch = text.match(/P-282 renderer-recovery (v\d+)/);
if (mode === "marker") {
  process.stdout.write(text.includes("P-282 renderer-recovery") ? "yes" : "no");
  process.exit(0);
}
if (mode === "version") {
  process.stdout.write(versionMatch ? versionMatch[1] : "none");
  process.exit(0);
}
if (mode === "extract") {
  fs.writeFileSync(outPath, main);
  if (!versionMatch) {
    console.error("marker missing");
    process.exit(1);
  }
  console.log("main.js " + e.size + " bytes, marker " + versionMatch[1] + " ok");
  process.exit(0);
}
console.error("未知 mode: " + mode);
process.exit(2);
