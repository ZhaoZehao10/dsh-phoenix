// ★ P-282 处理器单元测试 v2：从补丁后的 asar 原样抽取补丁段，
//   用 new Function 注入桩对象驱动，验证恢复语义。
//   抽取的是「实际打进 asar 的字节」，不是重抄的逻辑。
import fs from 'node:fs';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';

// ---- 从补丁后的 asar 抽 main.js ----
const buf = fs.readFileSync(__PATCHED);
const jsonLen = buf.readUInt32LE(12);
const s = buf.slice(16, 16 + jsonLen).toString('utf8');
const end = s.lastIndexOf('}') + 1;
const h = JSON.parse(s.slice(0, end));
const off = 8 + buf.readUInt32LE(4) + Number(h.files.lib.files['main.js'].offset);
const main = buf.slice(off, off + h.files.lib.files['main.js'].size).toString('utf8');

// ---- 抽取补丁段：MARKER 起至处理器注册结束 ----
const startMark = main.indexOf('/* P-282 renderer-recovery');
if (startMark < 0) { console.log('❌ 找不到 marker'); process.exit(1); }
const regStart = main.indexOf('window.webContents.on("render-process-gone"', startMark);
if (regStart < 0) { console.log('❌ 找不到处理器注册'); process.exit(1); }
// 配对扫描：从 regStart 找到该语句的收尾 ");"（深度回到 0 且遇到 ");"）
let depth = 0, inStr = null, esc = false, blockEnd = -1;
for (let i = regStart - 1; i < main.length; i++) {
  const c = main[i];
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
  if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') depth--;
  else if (c === ')' && depth === 0 && main[i + 1] === ';') { blockEnd = i + 2; break; }
}
if (blockEnd < 0) { console.log('❌ 找不到块结尾'); process.exit(1); }
const segment = main.slice(startMark, blockEnd).replace(/\t/g, '  ');
console.log('补丁段:', segment.length, '字节（MARKER 起至注册收尾）');

// ---- 桩（v2 补丁段额外引用 appendFileSync/join/app —— 桩化；时钟可控）----
const realDateNow = Date.now;
let fakeClock = null;
function setClock(t) { fakeClock = t; Date.now = () => fakeClock; }
function restoreClock() { fakeClock = null; Date.now = realDateNow; }

function makeHarness(opts = {}) {
  const st = { reloads: 0, fatal: [], warnings: [], logWrites: [] };
  const wc = { h: {}, on(ev, fn) { this.h[ev] = fn; } };
  const win = {
    isDestroyed: () => false,
    reload: () => { st.reloads++; },
    webContents: wc,
  };
  const reportFatal = (e) => { st.fatal.push(String(e && e.message)); };
  // console.warn 的捕获要持续到 fire 之后 —— 用 done() 显式恢复
  const origWarn = console.warn;
  console.warn = (m) => { st.warnings.push(String(m)); };
  const quit = { value: false };
  const appendFileSync = opts.throwingLog
    ? () => { throw new Error('disk full (simulated)'); }
    : (p, content) => { st.logWrites.push({ path: p, content: String(content) }); };
  const join = (...parts) => parts.join('/');
  const app = { getPath: () => 'LOGSDIR', getAppMetrics: () => opts.appMetrics || [] };
  // segment 引用：window / reportFatal / quitting / navigation / appendFileSync / join / app
  const run = new Function('window', 'reportFatal', 'quitting', 'navigation',
                           'appendFileSync', 'join', 'app', segment + `
    return { fire: (details) => window.webContents.h["render-process-gone"]({}, details) };`)
    (win, reportFatal, quit.value, undefined, appendFileSync, join, app);
  return { st, run, done: () => { console.warn = origWarn; } };
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
};

// ---- C1：可恢复原因（oom）⟹ 重载，不 fatal ----
{
  const { st, run, done } = makeHarness();
  run.fire({ reason: 'oom' });
  await sleep(400);
  done();
  check('C1 oom ⟹ 重载 1 次且无 fatal', st.reloads === 1 && st.fatal.length === 0,
        `reloads=${st.reloads} fatal=${st.fatal.length}`);
  check('C1b 打了恢复日志', st.warnings.some(w => w.includes('reloading page (recovery 1/2)')),
        st.warnings.join(' | ').slice(0, 90));
}
// ---- C2：crashed / killed 也可恢复 ----
for (const reason of ['crashed', 'killed']) {
  const { st, run, done } = makeHarness();
  run.fire({ reason });
  await sleep(400);
  check(`C2 ${reason} ⟹ 重载`, st.reloads === 1 && st.fatal.length === 0,
        `reloads=${st.reloads}`);
}
// ---- C3：clean-exit ⟹ 不重载不 fatal ----
{
  const { st, run, done } = makeHarness();
  run.fire({ reason: 'clean-exit' });
  await sleep(400);
  check('C3 clean-exit ⟹ 什么都不做', st.reloads === 0 && st.fatal.length === 0);
}
// ---- C4：不可恢复原因（如 integrity-failure / launch-failed）⟹ 直接 fatal ----
for (const reason of ['integrity-failure', 'launch-failed', 'abnormal-exit']) {
  const { st, run, done } = makeHarness();
  run.fire({ reason });
  await sleep(400);
  check(`C4 ${reason} ⟹ 直接 fatal 不重载`, st.fatal.length === 1 && st.reloads === 0,
        `fatal=${st.fatal.length} reloads=${st.reloads}`);
}
// ---- C5：有界 —— 60s 内第 3 次 oom ⟹ fatal（2 次恢复后升级）----
// ★ v2 有预算重置：必须用受控时钟把三次崩溃压进 60s 内，否则第三次会被重置放行
{
  const { st, run, done } = makeHarness();
  setClock(1000000);
  run.fire({ reason: 'oom' }); await sleep(400); setClock(1000000 + 1000);
  run.fire({ reason: 'oom' }); await sleep(400); setClock(1000000 + 2000);
  run.fire({ reason: 'oom' }); await sleep(400);
  done(); restoreClock();
  check('C5 60s内连续 3 次 oom ⟹ 重载 2 次 + fatal 1 次（有界）',
        st.reloads === 2 && st.fatal.length === 1,
        `reloads=${st.reloads} fatal=${st.fatal.length}`);
  check('C5b fatal 消息保留了原始 reason', st.fatal[0] === 'Desktop renderer exited: oom',
        st.fatal[0]);
}
// ---- C6：quitting=true ⟹ 不做任何事 ----
{
  const st = { reloads: 0, fatal: [], logWrites: [] };
  const wc = { h: {}, on(ev, fn) { this.h[ev] = fn; } };
  const win = { isDestroyed: () => false, reload: () => { st.reloads++; }, webContents: wc };
  const fatal = (e) => { st.fatal.push(String(e.message)); };
  const afs = (p, c) => { st.logWrites.push({ path: p, content: String(c) }); };
  const run = new Function('window', 'reportFatal', 'quitting', 'navigation',
                           'appendFileSync', 'join', 'app', segment + `
    return { fire: (d) => window.webContents.h["render-process-gone"]({}, d) };`)
    (win, fatal, true, undefined, afs, (...p) => p.join('/'), { getPath: () => 'L' });
  run.fire({ reason: 'oom' });
  await sleep(400);
  check('C6 退出中 ⟹ 不重载不 fatal', st.reloads === 0 && st.fatal.length === 0);
}
// ---- C7：window 已销毁 ⟹ 不做任何事 ----
{
  const st = { reloads: 0, fatal: [], logWrites: [] };
  const wc = { h: {}, on(ev, fn) { this.h[ev] = fn; } };
  const win = { isDestroyed: () => true, reload: () => { st.reloads++; }, webContents: wc };
  const fatal = (e) => { st.fatal.push(String(e.message)); };
  const afs = (p, c) => { st.logWrites.push({ path: p, content: String(c) }); };
  const run = new Function('window', 'reportFatal', 'quitting', 'navigation',
                           'appendFileSync', 'join', 'app', segment + `
    return { fire: (d) => window.webContents.h["render-process-gone"]({}, d) };`)
    (win, fatal, false, undefined, afs, (...p) => p.join('/'), { getPath: () => 'L' });
  run.fire({ reason: 'oom' });
  await sleep(400);
  check('C7 窗口已销毁 ⟹ 不重载不 fatal', st.reloads === 0 && st.fatal.length === 0);
}
// ---- C8：预算重置 —— 相隔 >60s 的孤立崩溃各自恢复，不耗尽预算 ----
{
  const { st, run, done } = makeHarness();
  setClock(2000000);
  run.fire({ reason: 'oom' }); await sleep(400);          // 恢复 1/2（t=0）
  setClock(2000000 + 61000);
  run.fire({ reason: 'oom' }); await sleep(400);          // 重置 ⟹ 又是 1/2（t=61s）
  setClock(2000000 + 122000);
  run.fire({ reason: 'oom' }); await sleep(400);          // 再重置 ⟹ 1/2（t=122s）
  setClock(2000000 + 183000);
  run.fire({ reason: 'oom' }); await sleep(400);          // 1/2（t=183s）
  done(); restoreClock();
  check('C8 4 次相隔 61s 的孤立崩溃全部恢复（预算按时间重置）',
        st.reloads === 4 && st.fatal.length === 0,
        `reloads=${st.reloads} fatal=${st.fatal.length}`);
  check('C8b 每次都记为 recovery 1/2（重置生效）',
        st.logWrites.filter(w => w.content.includes('recovery 1/2')).length === 4,
        st.logWrites.map(w => (w.content.match(/recovery \d\/\d/) || ['?'])[0]).join(','));
}
// ---- C8c：边界时间 —— 恰好 60s 不重置（>60s 才重置），59.9s 重置与否按实现 ----
{
  const { st, run, done } = makeHarness();
  setClock(3000000);
  run.fire({ reason: 'oom' }); await sleep(400);          // 1/2
  setClock(3000000 + 30000);
  run.fire({ reason: 'oom' }); await sleep(400);          // 30s < 60s ⟹ 2/2（不重置）
  setClock(3000000 + 59999);
  run.fire({ reason: 'oom' }); await sleep(400);          // 仍 <60s ⟹ 预算耗尽 ⟹ fatal
  done(); restoreClock();
  check('C8c 30s/30s 间隔的连环崩 ⟹ 2 次恢复 + 1 次 fatal（不误重置）',
        st.reloads === 2 && st.fatal.length === 1,
        `reloads=${st.reloads} fatal=${st.fatal.length}`);
}
// ---- C9：恢复事件写入文件日志（可审计）----
{
  const { st, run, done } = makeHarness();
  setClock(4000000);
  run.fire({ reason: 'killed' });
  await sleep(400);
  done(); restoreClock();
  const w = st.logWrites[0];
  check('C9a 恢复写入了 renderer-recovery.log',
        st.logWrites.length === 1 && w.path === 'LOGSDIR/renderer-recovery.log',
        JSON.stringify(w || {}).slice(0, 120));
  check('C9b 日志含时间戳与原因', w && w.content.includes('killed')
        && w.content.includes('reloading page (recovery 1/2)')
        && /\d{4}-\d{2}-\d{2}T/.test(w.content),
        (w ? w.content : '').trim());
}
// ---- C10：日志写入失败 ⟹ 恢复必须照常（P-88 原则：清理失败不改变主流程）----
{
  const { st, run, done } = makeHarness({ throwingLog: true });
  setClock(5000000);
  run.fire({ reason: 'crashed' });
  await sleep(400);
  done(); restoreClock();
  check('C10a 日志写失败 ⟹ 重载照常', st.reloads === 1 && st.fatal.length === 0,
        `reloads=${st.reloads} fatal=${st.fatal.length}`);
  check('C10b fire 正常返回（异常被块内 catch 吞掉，无未捕获冒泡）',
        st.warnings.some(w => w.includes('reloading page (recovery 1/2)')));
}


// ---- C11：恢复日志带内存上下文（renderers/mainRSS —— 诊断价值）----
{
  const { st, run, done } = makeHarness({ appMetrics: [{ type: 'Tab', memory: { privateBytes: 2 * 1024 * 1024 } }] });
  setClock(6000000);
  run.fire({ reason: 'oom' });
  await sleep(400);
  done(); restoreClock();
  const w = st.logWrites[0];
  check('C11 日志含 renderers/mainRSS 内存上下文',
        w && /renderers=/.test(w.content) && /mainRSS=\d+MB/.test(w.content) && w.content.includes('renderers=2048MB'),
        (w ? w.content : '').slice(0, 160));
}
// ---- C12：有界升级也留审计（fatal 前写一条）----
{
  const { st, run, done } = makeHarness();
  setClock(7000000);
  run.fire({ reason: 'oom' }); await sleep(300); setClock(7000000 + 1000);
  run.fire({ reason: 'oom' }); await sleep(300); setClock(7000000 + 2000);
  run.fire({ reason: 'oom' }); await sleep(400);
  done(); restoreClock();
  check('C12 升级到 fatal 时也写审计行',
        st.logWrites.length === 3 && st.logWrites[2].content.includes('escalating to fatal'),
        JSON.stringify(st.logWrites.map(w => w.content.slice(24, 90))));
}

console.log();
console.log(fails ? `❌ ${fails} 项失败` : '✅ 处理器语义测试全部通过');
process.exit(fails ? 1 : 0);
