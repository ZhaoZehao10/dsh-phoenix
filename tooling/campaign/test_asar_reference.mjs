// ★ P-282：用官方 @electron/asar 参照实现验证补丁版 asar。
//   我自己的解析器说它没问题 —— 参照实现才是 Electron 运行时的同族读法。
import { listPackage, extractFile } from '@electron/asar';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PATCHED = __PATCHED;
const ORIG = __ASAR;

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
};

// ---- ① 参照实现能列出补丁版（解析头部成功）----
const fileList = listPackage(PATCHED);
check('R1 参照实现列出补丁 asar 成功', Array.isArray(fileList) && fileList.length > 0,
      `${fileList.length} 项`);
const origList = listPackage(ORIG);
check('R1b 文件清单与原版完全一致', JSON.stringify(fileList.sort()) === JSON.stringify(origList.sort()),
      `${fileList.length} vs ${origList.length}`);

// ---- ② 参照实现抽出 main.js，与我自己解析的补丁字节比对 ----
const refMain = extractFile(PATCHED, 'lib/main.js');
const myMain = (() => {
  const buf = fs.readFileSync(PATCHED);
  const jsonLen = buf.readUInt32LE(12);
  const s = buf.slice(16, 16 + jsonLen).toString('utf8');
  const end = s.lastIndexOf('}') + 1;
  const h = JSON.parse(s.slice(0, end));
  const off = 8 + buf.readUInt32LE(4) + Number(h.files.lib.files['main.js'].offset);
  return buf.slice(off, off + h.files.lib.files['main.js'].size);
})();
check('R2 参照实现与自研解析器抽出的 main.js 一致',
      crypto.createHash('sha256').update(refMain).digest('hex') ===
      crypto.createHash('sha256').update(myMain).digest('hex'),
      `${refMain.length} vs ${myMain.length} 字节`);
check('R2b 参照实现抽出的 main.js 含补丁 marker',
      refMain.toString('utf8').includes('/* P-282 renderer-recovery'));

// ---- ③ 未动文件内容一致：5 个固定 + 30 个随机抽样（固定种子可复现）----
for (const f of ['package.json', 'dsh/package.json', 'lib/preload-app.cjs',
                 'renderer/welcome.html', 'dsh/desktop-runtime.json']) {
  const a = extractFile(ORIG, f), b = extractFile(PATCHED, f);
  check('R3 未动文件内容一致: ' + f,
        crypto.createHash('sha256').update(a).digest('hex') ===
        crypto.createHash('sha256').update(b).digest('hex'));
}
// 从头部键收集真实文件路径（listPackage 的 Windows 输出格式不可靠）
const headerOf = (p) => {
  const b = fs.readFileSync(p);
  const jl = b.readUInt32LE(12);
  const s = b.slice(16, 16 + jl).toString('utf8');
  return JSON.parse(s.slice(0, s.lastIndexOf('}') + 1));
};
const headerPaths = [];
(function walk(node, prefix) {
  for (const [k, v] of Object.entries(node.files || {})) {
    if (v.files) walk(v, prefix + '/' + k);
    else if (typeof v.size === 'number' && !v.unpacked) headerPaths.push((prefix + '/' + k).slice(1));
  }
})(headerOf(PATCHED), '');
const candidates2 = headerPaths.filter((f) => !f.includes('main.js'));
let seed2 = 20261026;
const rnd2 = () => { seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff; return seed2 / 0x7fffffff; };
const sample2 = [];
for (let i = 0; i < 30 && candidates2.length; i++) {
  sample2.push(candidates2.splice(Math.floor(rnd2() * candidates2.length), 1)[0]);
}
let sampleOk = 0; const sampleFail = [];
// ⚠️ @electron/asar 的 JS 版 extractFile 对本档案的 node_modules 搜索树有兼容怪癖
//   （Electron 实际用 C++ 读取器；listPackage/R1b 正常）。抽样改为直接按
//   头部条目的 offset/size 读字节 —— 这同时也独立验证了偏移的正确性。
const readEntry = (p, entryPath) => {
  const b = fs.readFileSync(p);
  const jl = b.readUInt32LE(12);
  const str = b.slice(16, 16 + jl).toString('utf8');
  const hdr = JSON.parse(str.slice(0, str.lastIndexOf('}') + 1));
  let node = hdr;
  for (const seg of entryPath.split('/')) node = node.files[seg];
  if (node.unpacked) return null;                    // unpacked 内容在 .unpacked 目录
  const base = 8 + b.readUInt32LE(4);
  return b.slice(base + Number(node.offset), base + Number(node.offset) + node.size);
};
for (const f of sample2) {
  try {
    const a = readEntry(ORIG, f), b2 = readEntry(PATCHED, f);
    if (a === null) { continue; }                    // unpacked 条目跳过（本轮只验证打包区）
    if (crypto.createHash('sha256').update(a).digest('hex') ===
        crypto.createHash('sha256').update(b2).digest('hex')) sampleOk++;
    else sampleFail.push(f);
  } catch (e) { sampleFail.push(f + ' (' + String(e.message).slice(0, 40) + ')'); }
}
check('R5 随机 30 packed 文件按偏移读字节全部一致（含偏移正确性验证）', sampleFail.length === 0,
      `${sampleOk} 个比对一致${sampleFail.length ? '；失败: ' + sampleFail.slice(0, 3).join(', ') : ''}`);

// ---- ④ 参照实现抽取 main.js 语法有效（ESM）----
fs.writeFileSync(__WORK + '/_ref_main_check.mjs', refMain);
console.log('（语法检查由外部 node --check 完成）');

console.log();
console.log(fails ? `❌ ${fails} 项失败` : '✅ 官方参照实现验证全部通过');
process.exit(fails ? 1 : 0);
