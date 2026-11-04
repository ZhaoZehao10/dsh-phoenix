// ★ 基准偏移实证：用官方 @electron/asar 抽原版 main.js/package.json，
//   与我方解析器（不同 base 假设）的抽取结果逐字节比对，钉死真正的 base。
import { extractFile } from '@electron/asar';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';

const ORIG = __ASAR;
const buf = fs.readFileSync(ORIG);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const refMain = extractFile(ORIG, 'lib/main.js');
const refPkg = extractFile(ORIG, 'package.json');
console.log('参照实现: main.js', refMain.length, '字节 sha', sha(refMain).slice(0, 16));
console.log('参照实现: package.json', refPkg.length, '字节');

// 我方解析
const jsonLen = buf.readUInt32LE(8);
const s = buf.slice(16, 16 + jsonLen).toString('utf8');
const end = s.lastIndexOf('}') + 1;              // 我方旧基准
const h = JSON.parse(s.slice(0, end));
const relMain = Number(h.files.lib.files['main.js'].offset);
const relPkg = Number(h.files['package.json'].offset);
const sizeMain = h.files.lib.files['main.js'].size;
console.log('header 字段: @0=', buf.readUInt32LE(0), '@4=', buf.readUInt32LE(4),
            '@8=', buf.readUInt32LE(8), '@12=', buf.readUInt32LE(12));
console.log('相对偏移: main.js =', relMain, ' package.json =', relPkg, ' size =', sizeMain);

console.log();
// ★ 扫描窗口从 asar 自身推导（不再硬编码版本相关值）：
//   理论 base = 8 + readUInt32LE(4)；窗口 = 理论值 ±16，验证唯一命中
const theory = 8 + buf.readUInt32LE(4);
// 旧错误基准（本项目实测踩过的坑）：16 + jsonLen串 + lastIndexOf('}')+1
const naive = 16 + jsonLen + end;
console.log(`理论 base = 8 + readUInt32LE(4) = ${theory}；旧错误假设 = ${naive}`);
let hits = [];
for (let base = theory - 16; base <= theory + 16; base++) {
  const m = buf.slice(base + relMain, base + relMain + sizeMain);
  const p = buf.slice(base + relPkg, base + relPkg + h.files['package.json'].size);
  const okMain = sha(m) === sha(refMain);
  const okPkg = sha(p) === sha(refPkg);
  if (okMain || okPkg) {
    hits.push(base);
    console.log(`  base=${base}: main.js ${okMain ? '✅' : '❌'}  package.json ${okPkg ? '✅' : '❌'}`);
  }
}
console.log('（未打 ✅ 的 base = 错误基准）');
// 断言：唯一命中的 base == 理论值；旧错误假设不得命中
if (hits.length !== 1 || hits[0] !== theory) {
  console.error(`❌ 基准验证失败：命中 ${JSON.stringify(hits)}，期望唯一命中 ${theory}`);
  process.exit(1);
}
if (hits.includes(naive) && naive !== theory) {
  console.error(`❌ 旧错误基准 ${naive} 竟然命中 —— 数据区错位风险！`);
  process.exit(1);
}
console.log(`✅ 基准实证：唯一命中 base=${theory}（= 8 + headerSize），旧错误基准未命中`);
