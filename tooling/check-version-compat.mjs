// ★ 版本适配检查（新版本 DSH 发布后先跑这个）：
//   ① 新 asar 的 main.js 里，补丁锚点（原处理器原文）是否仍唯一命中
//   ② 版本号 / dataBase / main.js 尺寸 摘要
//   退出码 0 = 锚点命中，可直接重跑 patch-asar.mjs + campaign；
//   非 0  = 上游改了这段代码，按 docs/INSTALL.md「DSH 官方更新之后」处理。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = process.env.DSH_INSTALL_DIR
  || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
const asarPath = path.join(cfg, 'resources', 'app.asar');
const exePath = path.join(cfg, 'DeepSeek Harness.exe');

const ver = fs.existsSync(exePath)
  ? '（用 PowerShell 查 FileVersion 更准）' : '';
console.log('安装目录:', cfg);

const buf = fs.readFileSync(asarPath);
const hs = buf.readUInt32LE(4);
const jl = buf.readUInt32LE(12);
const s = buf.slice(16, 16 + jl).toString('utf8');
const header = JSON.parse(s.slice(0, s.lastIndexOf('}') + 1));
const e = header.files.lib.files['main.js'];
const main = buf.slice(8 + hs + Number(e.offset), 8 + hs + Number(e.offset) + e.size).toString('utf8');
console.log(`asar: ${buf.length} 字节 | dataBase: ${8 + hs} | main.js: ${e.size} 字节`);

const OLD_HANDLER = `\t\twindow.webContents.on("render-process-gone", (_event, details) => {
\t\t\tnavigation = void 0;
\t\t\tif (!quitting && !window.isDestroyed() && details.reason !== "clean-exit") reportFatal(/* @__PURE__ */ new Error(\`Desktop renderer exited: \${details.reason}\`), "renderer");
\t\t});`;
const cnt = main.split(OLD_HANDLER).length - 1;
console.log('补丁锚点唯一命中数:', cnt);
if (cnt === 1) {
  console.log('✅ 锚点命中 —— 直接重跑 tooling/patch-asar.mjs + campaign 全套即可适配新版本');
  console.log('   （全绿后把新版本号加入 scripts/install-patched.ps1 的允许列表）');
  process.exit(0);
} else if (cnt === 0) {
  console.log('❌ 锚点未命中 —— 上游改了处理器代码。两种可能：');
  console.log('   a) 官方已自行实现恢复逻辑（在新 main.js 里搜 render-process-gone 逐个看）⟹ 不要再打补丁');
  console.log('   b) 代码重构了 ⟹ 从新 main.js 抄出新处理器原文，更新 patch-asar.mjs 的 OLD_HANDLER 后重跑');
  process.exit(1);
} else {
  console.log('❌ 锚点出现多次 —— 处理器被复制/拆分，需人工分析');
  process.exit(1);
}
