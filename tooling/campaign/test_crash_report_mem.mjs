// ★ v5 测试：崩溃报告的内存快照函数（从补丁产物原样抽取并驱动）。
//   验证：主进程内存行、系统内存行、渲染器行；以及 API 缺失/抛错时的健壮性。
import fs from 'node:fs';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';

const PATCHED = __PATCHED;
const buf = fs.readFileSync(PATCHED);
const hs = buf.readUInt32LE(4), jl = buf.readUInt32LE(12);
const s = buf.slice(16, 16 + jl).toString('utf8');
const h = JSON.parse(s.slice(0, s.lastIndexOf('}') + 1));
const e = h.files.lib.files['main.js'];
const main = buf.slice(8 + hs + Number(e.offset), 8 + hs + Number(e.offset) + e.size).toString('utf8');

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
};

// ---- 抽取函数（花括号配对）----
const start = main.indexOf('function p282MemorySnapshot()');
if (start < 0) { console.error('❌ 产物中无 p282MemorySnapshot'); process.exit(1); }
let depth = 0, end = -1;
for (let i = main.indexOf('{', start); i < main.length; i++) {
  const c = main[i];
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error('❌ 函数结尾未找到'); process.exit(1); }
const code = main.slice(start, end);

const makeProcess = (opts = {}) => ({
  memoryUsage: () => ({ rss: 500 * 1024 * 1024, heapUsed: 200 * 1024 * 1024, external: 10 * 1024 * 1024 }),
  getSystemMemoryInfo: opts.noSys ? undefined : () => ({ total: 32 * 1024 * 1024, free: 8 * 1024 * 1024 }),
});
const makeApp = (opts = {}) => ({
  getAppMetrics: opts.throwing
    ? () => { throw new Error('boom'); }
    : () => ([
        { type: 'Tab', pid: 111, memory: { privateBytes: 2 * 1024 * 1024, workingSetSize: 3 * 1024 * 1024 } },
        { type: 'GPU', pid: 222, memory: { privateBytes: 9 * 1024 * 1024, workingSetSize: 9 * 1024 * 1024 } },
      ]),
});

// ---- ① 正常路径 ----
{
  const fn = new Function('app', 'process', code + '\nreturn p282MemorySnapshot();');
  const out = fn(makeApp(), makeProcess());
  check('C1 主进程内存行', out.includes('main: rss=500MB heapUsed=200MB external=10MB'), out.split('\n')[0]);
  check('C2 系统内存行', out.includes('system: total=32768MB free=8192MB'), out.split('\n')[1] || '');
  check('C3 渲染器行（只列 Tab，不列 GPU）', out.includes('renderers: 111:private=2048MB ws=3072MB') && !out.includes('222:'), out.split('\n')[2] || '');
}
// ---- ② 系统信息 API 缺失 ----
{
  const fn = new Function('app', 'process', code + '\nreturn p282MemorySnapshot();');
  const out = fn(makeApp(), makeProcess({ noSys: true }));
  check('C4 缺 getSystemMemoryInfo ⟹ 无 system 行但仍有 main', out.includes('main: rss=') && !out.includes('system:'), out.split('\n').join(' / '));
}
// ---- ③ getAppMetrics 抛错 ----
{
  const fn = new Function('app', 'process', code + '\nreturn p282MemorySnapshot();');
  const out = fn(makeApp({ throwing: true }), makeProcess());
  check('C5 getAppMetrics 抛错 ⟹ 不冒泡、仍返回 main 行', out.includes('main: rss=') && !out.includes('renderers:'), out.split('\n').join(' / '));
}

console.log();
console.log(fails ? `❌ ${fails} 项失败` : '✅ 崩溃报告内存快照测试全部通过');
process.exit(fails ? 1 : 0);
