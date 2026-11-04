// ★ P-282 结构完整性测试：补丁版 asar 相对原版，必须只有三处差异：
//   ① 头部 JSON 里 main.js 的 offset/size/integrity 条目
//   ② 头部 JSON 末尾的空格补齐
//   ③ 文件尾追加的 main.js
// 其余字节必须完全一致 —— 这是「没有附带伤害」的字节级证明。
import fs from 'node:fs';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';
import crypto from 'node:crypto';
import path from 'node:path';

// 原版基准解析：若安装的 asar 已含补丁（旧版），自动改用最新备份作为原版
const INSTALL_DIR = path.dirname(__ASAR);
const mainOf = (p) => {
  const b = fs.readFileSync(p);
  const hs = b.readUInt32LE(4), jl = b.readUInt32LE(12);
  const s = b.slice(16, 16 + jl).toString('utf8');
  const h = JSON.parse(s.slice(0, s.lastIndexOf('}') + 1));
  const e = h.files.lib.files['main.js'];
  const off = 8 + hs + Number(e.offset);
  return b.slice(off, off + e.size).toString('utf8');
};
let origPath = INSTALL_DIR + '/app.asar';
if (mainOf(origPath).includes('P-282 renderer-recovery')) {
  const baks = fs.readdirSync(INSTALL_DIR).filter((f) => f.startsWith('app.asar.bak-')).sort();
  if (!baks.length) { console.error('❌ 安装 asar 已是补丁版且无备份可作原版基准'); process.exit(1); }
  origPath = INSTALL_DIR + '/' + baks[baks.length - 1];
  console.log('ℹ️ 安装 asar 已是补丁版 ⟹ 原版基准用备份:', baks[baks.length - 1]);
}
const orig = fs.readFileSync(origPath);
const patch = fs.readFileSync(__PATCHED);

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
};

// ---- ① 头部控制区 [0..16) ----
check('S1 控制区 [0..16) 逐字节一致', orig.slice(0, 16).equals(patch.slice(0, 16)));

// ---- ② 头部 JSON 解析后逐条目对比 ----
function parse(b) {
  const jsonLen = b.readUInt32LE(8);
  const s = b.slice(16, 16 + jsonLen).toString('utf8');
  const end = s.lastIndexOf('}') + 1;
  return { header: JSON.parse(s.slice(0, end)), end, s };
}
const o = parse(orig), p = parse(patch);
check('S2 头部 JSON 长度不变（补齐不越界）', o.end === p.end, `${o.end} vs ${p.end}`);
check('S2b 控制字段 [8] 不变（pickle 尺寸）', orig.readUInt32LE(8) === patch.readUInt32LE(8));

// 递归对比两个 header 的每个叶子
const diffs = [];
function compare(a, b, path) {
  if (a.files) {
    const ka = Object.keys(a.files), kb = Object.keys(b.files);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      diffs.push(path + ' 键集/顺序不同');
      return;
    }
    for (const k of ka) compare(a.files[k], b.files[k], path + '/' + k);
  } else {
    const aOff = Number(a.offset), bOff = Number(b.offset);
    const sizeSame = a.size === b.size, offSame = a.offset === b.offset;
    const integSame = JSON.stringify(a.integrity) === JSON.stringify(b.integrity);
    if (!(sizeSame && offSame && integSame)) {
      // main.js 是唯一预期差异
      if (path === '/lib/main.js') {
        diffs.push(`main.js（预期）: size ${a.size}->${b.size}, offset ${a.offset}->${b.offset}`);
      } else {
        diffs.push(`${path}: 意外差异 size ${a.size}->${b.size} off ${a.offset}->${b.offset} integ=${integSame}`);
      }
    }
  }
}
compare(o.header, p.header, '');
check('S3 头部条目差异只有 main.js（键序不变）',
      diffs.length === 1 && diffs[0].startsWith('main.js'), diffs.join(' ; ').slice(0, 200));

// ---- ③ 数据区 [dataOffset .. 原EOF) 逐字节一致 ----
const oData = 16 + o.end;
check('S4 原数据区 [dataOffset..原EOF) 逐字节一致',
      orig.slice(oData).equals(patch.slice(oData, oData + (orig.length - oData))),
      `范围 ${oData}..${orig.length}（${((orig.length - oData) / 1048576).toFixed(1)} MB）`);

// ---- ④ 追加的 main.js 与补丁源一致（哈希）----
const pMainEntry = p.header.files.lib.files['main.js'];
const appended = patch.slice(8 + patch.readUInt32LE(4) + Number(pMainEntry.offset),
                             8 + patch.readUInt32LE(4) + Number(pMainEntry.offset) + pMainEntry.size);
const appendedHash = crypto.createHash('sha256').update(appended).digest('hex');
check('S5 追加块与头部声明的 integrity.hash 一致', appendedHash === pMainEntry.integrity.hash);
// 块哈希也核一遍（每 4MB）
const blockHashes = [];
for (let off = 0; off < appended.length; off += 4194304) {
  blockHashes.push(crypto.createHash('sha256').update(appended.slice(off, off + 4194304)).digest('hex'));
}
check('S5b 追加块 integrity.blocks 一致',
      JSON.stringify(blockHashes) === JSON.stringify(pMainEntry.integrity.blocks));

// ---- ⑥ 文件总长 = 原长 + 追加块长 ----
check('S6 文件总长恰为 原长+追加块', patch.length === orig.length + appended.length,
      `${patch.length} vs ${orig.length}+${appended.length}`);

// ---- ⑦ 追加块是合法的 main.js（含 marker、含原版全部行数）----
const appendedStr = appended.toString('utf8');
check('S7a 追加块含补丁 marker', appendedStr.includes('/* P-282 renderer-recovery'));
// 原版 main.js 用正确基准抽取（参照 disk.js: base = 8 + headerSize）
const origMain = orig.slice(8 + orig.readUInt32LE(4) + Number(o.header.files.lib.files['main.js'].offset),
                            8 + orig.readUInt32LE(4) + Number(o.header.files.lib.files['main.js'].offset)
                            + o.header.files.lib.files['main.js'].size).toString('utf8');
check('S7b 追加块以原版 main.js 开头（除替换段）',
      appendedStr.startsWith(origMain.slice(0, 200)));
check('S7b2 原版 main.js 尾段也在补丁版中（替换段之后）',
      appendedStr.endsWith(origMain.slice(-60)));
// 行数只增不减
const origMainLines = origMain.split('\n').length;
check('S7c 行数只增不减', appendedStr.split('\n') >= origMainLines || appendedStr.split('\n').length > origMainLines,
      `${origMainLines} -> ${appendedStr.split('\n').length}`);

console.log();
console.log(fails ? `❌ ${fails} 项失败` : '✅ 结构完整性测试全部通过');
process.exit(fails ? 1 : 0);
