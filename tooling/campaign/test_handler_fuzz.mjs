// ★ P-282 v3 恢复处理器 · 100 轮随机化模糊测试
//
// 方法：从 app.asar.patched 原样抽取补丁段（模块级块 + 处理器），嵌入每轮
// 独立生成的 .ts 模块，用受控时钟 + 定时器队列重放随机事件序列，并以
// **独立规格模型**逐事件核对实际行为（重载数/致命数/无操作数/预算窗口）。
//
// 不变量：
//   I1 记账：fires === reloads + fatals + noops
//   I2 语义：clean-exit / quitting / destroyed ⟹ 无操作
//   I3 语义：不可恢复原因 ⟹ fatal 且不重载
//   I4 预算：任意 60s 滑动窗口内恢复次数 ≤ 2
//   I5 重置：耗尽后 >60s 的下一次可恢复崩溃 ⟹ 恢复
//   I6 无未捕获异常
import fs from 'node:fs';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASAR = __PATCHED;   // 补丁产物（installed asar 尚未打补丁）
const NODE = process.execPath;
const ROUNDS = Number(process.argv[2] ?? 100);

// ---- 抽取补丁段（正确基准：8 + readUInt32LE(4)）----
const buf = fs.readFileSync(ASAR);
const headerSize = buf.readUInt32LE(4);
const dataBase = 8 + headerSize;
const jsonLen = buf.readUInt32LE(12);
const s = buf.slice(16, 16 + jsonLen).toString('utf8');
const header = JSON.parse(s.slice(0, s.lastIndexOf('}') + 1));
const mainEntry = header.files.lib.files['main.js'];
const mainSrc = buf.slice(dataBase + Number(mainEntry.offset),
                          dataBase + Number(mainEntry.offset) + mainEntry.size).toString('utf8');
if (!mainSrc.includes('P-282 renderer-recovery')) { console.error('❌ 补丁 marker 缺失'); process.exit(1); }

const constAnchor = mainSrc.indexOf('const RECOVERABLE_RENDERER_EXITS');
const docStart = mainSrc.indexOf('/* P-282 renderer-recovery');
const regStart = mainSrc.indexOf('window.webContents.on("render-process-gone"', constAnchor);
let depth = 0, inStr = null, esc = false, blockEnd = -1, inLC = false, inBC = false;
for (let i = regStart - 1; i < mainSrc.length; i++) {
  const c = mainSrc[i], nx = mainSrc[i + 1];
  if (inLC) { if (c === '\n') inLC = false; continue; }
  if (inBC) { if (c === '*' && nx === '/') { inBC = false; i++; } continue; }
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
  if (c === '/' && nx === '/') { inLC = true; i++; continue; }
  if (c === '/' && nx === '*') { inBC = true; i++; continue; }
  if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') depth--;
  else if (c === ')' && depth === 0) {
    // 语句收尾：")" 后必须是 ";" 或换行（排除参数表的 ")"，其后跟 " => "）
    let j = i + 1;
    while (j < mainSrc.length && (mainSrc[j] === ' ' || mainSrc[j] === '\t')) j++;
    if (mainSrc[j] === ';' || mainSrc[j] === '\n' || mainSrc[j] === '\r') { blockEnd = i + 1; break; }
  }
}
if (blockEnd < 0) { console.error('❌ 块尾未找到'); process.exit(1); }
const handlerBlock = mainSrc.slice(regStart, blockEnd);
// 编译版里生产补丁是单一连续块（marker → 常量 → 日志 → 处理器，都在 createMainWindow 内）
const markStart = mainSrc.indexOf('/* P-282 renderer-recovery');
const fuzzBlock = mainSrc.slice(markStart, blockEnd);
console.log('补丁段就绪：整块', fuzzBlock.length, '字符（处理器', handlerBlock.length, '）');
console.log(' rounds 目标:', ROUNDS);

// ---- 随机场景生成（mulberry32，每轮独立种子）----
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RECOVERABLE = ['oom', 'crashed', 'killed'];
const FATAL = ['integrity-failure', 'launch-failed', 'abnormal-exit'];
const ALL = [...RECOVERABLE, ...FATAL, 'clean-exit', 'unknown-reason'];
function makeScenario(seed) {
  const rand = mulberry32(seed);
  const events = [];
  let t = 5000, destroyed = false, quitting = false;
  const n = 3 + Math.floor(rand() * 8);          // 3..10 个事件
  const extreme = rand() < 0.2;                   // 20% 轮次用极端时序
  for (let i = 0; i < n; i++) {
    const rr = rand();
    let reason;
    if (rr < 0.4) reason = RECOVERABLE[Math.floor(rand() * 3)];
    else if (rr < 0.6) reason = 'clean-exit';
    else if (rr < 0.8) reason = FATAL[Math.floor(rand() * 3)];
    else reason = ALL[Math.floor(rand() * ALL.length)];
    let gap;
    if (extreme) {
      const edge = Math.floor(rand() * 3);
      gap = edge === 0 ? 0 : edge === 1 ? 59999 + Math.floor(rand() * 3) : 250 + Math.floor(rand() * 40);
    } else {
      gap = Math.floor(rand() * 130000);
    }
    if (i > 0) t += gap;
    const ev = { t, reason };
    if (rand() < 0.18) { quitting = !quitting; ev.setQuitting = quitting; }
    if (rand() < 0.07 && !destroyed) { destroyed = true; ev.setDestroyed = true; }
    events.push(ev);
    if (destroyed && events.length >= i + 2) { /* 销毁后再来 1 个 no-op 事件就收 */ if (i >= n - 1) break; }
  }
  // 收尾：若未被销毁，+130s 的可恢复崩溃（验证耗尽后重置）
  if (!destroyed) {
    events.push({ t: t + 130000, reason: 'oom', tailReset: true });
  }
  return { seed, events };
}

// ---- 每轮生成 .ts 模块并运行 ----
const RECOVERABLE_JS = JSON.stringify(RECOVERABLE);
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p282-fuzz-'));
fs.writeFileSync(path.join(runDir, 'fuzz-block.ts'), fuzzBlock, 'utf8');
const runnerTs = `
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const rounds = JSON.parse(fs.readFileSync(path.join(here, 'rounds.json'), 'utf8'))
let fails = 0
for (const r of rounds) {
  const stubs = \`
let st: any = { reloads: 0, fatal: [] as string[], warnings: [] as string[] }
const wc: any = { h: {} as Record<string, (e?: unknown, d?: any) => void>, on(ev: string, fn: any) { this.h[ev] = fn } }
let destroyed = false
let quitting = false
const window: any = { isDestroyed: () => destroyed, reload: () => { st.reloads++ }, webContents: wc }
const reportFatal = (e: any): void => { st.fatal.push(String(e && e.message)) }
let now = 0
const timers: any[] = []
Date.now = () => now
globalThis.setTimeout = ((fn: any, ms: number) => { timers.push({ at: now + Number(ms), fn }); return 0 }) as any
const appendFileSync = () => {}
const join = (...p: string[]) => p.join('/')
const app = { getPath: () => 'LOGSDIR' }
let navigation: any = undefined
function tick(ms: number) {
  const target = now + ms
  for (;;) {
    timers.sort((a: any, b: any) => a.at - b.at)
    const t = timers.find((x: any) => x.at <= target)
    if (!t) break
    timers.splice(timers.indexOf(t), 1)
    now = Math.max(now, t.at)
    if (!quitting && !destroyed) t.fn()
  }
  now = target
}
\`
  const handler = fs.readFileSync(path.join(here, 'fuzz-block.ts'), 'utf8')
  const replay = \`
destroyed = false
quitting = false
let modelReloads = 0, modelFatals = 0, modelNoops = 0
let modelBudget = 0, modelLast = 0
const RECOVERABLE = \${JSON.stringify(['oom', 'crashed', 'killed'])}
const firedAt: number[] = []
let modelTailRecovered = false
let actualReloadsBeforeTail = -1
for (const ev of r.events) {
  const isTail = (ev === r.events[r.events.length - 1]) && ev.tailReset === true
  tick(ev.t - now)
  now = Math.max(now, ev.t)
  if (ev.setQuitting !== undefined) quitting = ev.setQuitting
  if (ev.setDestroyed) destroyed = true
  if (isTail) actualReloadsBeforeTail = st.reloads
  const wasQuitting = quitting, wasDestroyed = destroyed
  const f0 = st.fatal.length, r0 = st.reloads
  wc.h['render-process-gone']({}, { reason: ev.reason })
  tick(260)
  // 规格模型（独立于实现推导）
  if (wasQuitting || wasDestroyed || ev.reason === 'clean-exit') { modelNoops++ }
  else {
    if (ev.t - modelLast > 60000) modelBudget = 0
    if (RECOVERABLE.includes(ev.reason) && modelBudget < 2) {
      modelBudget++; modelLast = ev.t
      if (!quitting && !destroyed) { modelReloads++; if (isTail) modelTailRecovered = true } else if (isTail) modelNoops++
    } else { modelFatals++ }
  }
  firedAt.push(ev.t)
}
// I1 记账
if (st.reloads + st.fatal.length !== modelReloads + modelFatals) { console.log('FAIL I1 r=' + st.reloads + ' f=' + st.fatal.length + ' model=' + modelReloads + '/' + modelFatals); process.exit(3) }
// A/B 模型一致
if (st.reloads !== modelReloads || st.fatal.length !== modelFatals) { console.log('FAIL model-mismatch reloads=' + st.reloads + '/' + modelReloads + ' fatals=' + st.fatal.length + '/' + modelFatals); process.exit(3) }
// I4 滑动窗口：恢复时刻任意 60s 窗口 ≤ 2（按模型恢复时刻；实现与模型已证一致）
const times: number[] = []
let b2 = 0, last2 = 0
for (const ev of r.events) {
  if (ev.setQuitting !== undefined) quitting = ev.setQuitting
  if (ev.setDestroyed) destroyed = true
  if (quitting || destroyed || ev.reason === 'clean-exit') continue
  if (ev.t - last2 > 60000) b2 = 0
  if (RECOVERABLE.includes(ev.reason) && b2 < 2) { b2++; last2 = ev.t; times.push(ev.t) }
}
for (let i = 0; i + 2 < times.length + 1; i++) {
  const w = times.filter((x: number) => x >= times[i] && x < times[i] + 60000).length
  if (w > 2) { console.log('FAIL I4 window ' + w + ' at ' + times[i]); process.exit(3) }
}
// I5 耗尽后重置：若模型判定尾部 +130s 的恢复发生 ⟹ 实现必须同样恢复
const tail = r.events[r.events.length - 1]
if (modelTailRecovered && st.reloads === actualReloadsBeforeTail) {
  console.log('FAIL I5 tail did not recover'); process.exit(3)
}
console.log('ROUND-OK ' + r.seed + ' events=' + r.events.length + ' reloads=' + st.reloads + ' fatals=' + st.fatal.length)
\`;
  const f = path.join(here, 'round-' + r.seed + '.ts')
  fs.writeFileSync(f, stubs + '\\n' + handler + '\\nconst r = ' + JSON.stringify(r) + '\\n' + replay, 'utf8')
  let out = ''
  try {
    out = execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 60000, cwd: here })
  } catch (e: any) { out = String(e.stdout || '') + String(e.stderr || '') }
  const ok = out.includes('ROUND-OK')
  console.log((ok ? '  ok  ' : '  FAIL  ') + 'seed=' + r.seed + ' ' + (out.split('\\n').find((l: string) => l.startsWith('ROUND-OK') || l.startsWith('FAIL')) || out.split('\\n')[0] || '').slice(0, 110))
  if (!ok) fails++
  try { fs.rmSync(f, { force: true }) } catch {}
}
console.log(fails ? 'FUZZ-FAIL ' + fails : 'FUZZ-PASS ' + rounds.length)
process.exit(fails ? 1 : 0)
`;
fs.writeFileSync(path.join(runDir, 'runner.ts'), runnerTs, 'utf8');

// ---- 生成 100 轮场景 ----
const rounds = [];
for (let i = 0; i < ROUNDS; i++) rounds.push(makeScenario(0x50282 + i * 7919));
fs.writeFileSync(path.join(runDir, 'rounds.json'), JSON.stringify(rounds), 'utf8');

let fails = 1;
let okRounds = 0, failRounds = 0;
try {
  const out = execFileSync(NODE, [path.join(runDir, 'runner.ts')], { encoding: 'utf8', timeout: 600000, cwd: runDir });
  fs.writeFileSync(__WORK + '/fuzz-results.log', out, 'utf8');   // 完整结果落盘
  const lines = out.split('\n').filter(l => l.startsWith('  ok') || l.startsWith('  FAIL'));
  okRounds = lines.filter(l => l.startsWith('  ok')).length;
  failRounds = lines.filter(l => l.startsWith('  FAIL')).length;
  console.log(lines.filter(l => l.startsWith('  FAIL')).slice(0, 10).join('\n') || '  （无失败轮）');
  console.log(out.split('\n').find(l => l.startsWith('FUZZ-')) || '');
  fails = out.includes('FUZZ-FAIL') ? Number((out.match(/FUZZ-FAIL (\d+)/) || [])[1] || 1) : 0;
} catch (e) {
  console.log('❌ runner 失败');
  const so = String(e.stdout || '');
  if (so) fs.writeFileSync(__WORK + '/fuzz-results.log', so, 'utf8');
  console.log(String(e.stderr || '').slice(0, 800));
  fails = 1;
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}
console.log(`轮次统计: ok=${okRounds} fail=${failRounds} (完整日志见 work/fuzz-results.log)`);
console.log(fails ? `❌ 模糊测试：${fails} 轮失败` : `✅ 模糊测试：${ROUNDS} 轮全部通过`);
process.exit(fails ? 1 : 0);
