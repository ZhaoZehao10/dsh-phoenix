// ★ 渲染器恢复处理器语义测试（对 TS 源码补丁段）。
//
// 用法（仓库根目录，先应用 01-desktop-renderer-recovery.patch）：
//   node tests/handler-semantics.mjs [apps/desktop/src/main.ts]
//
// 原理：从打了补丁的 main.ts 里**原样抽取**补丁段（常量 + logRendererRecovery +
// render-process-gone 处理器），写入临时 .ts 文件用 Node 24 的原生类型剥离直接
// 运行 —— 桩对象驱动，验证的是「补丁实际写入源码的字节」，不是重抄的逻辑。
//
// 覆盖：三类可恢复原因恢复 / 三类不可恢复直接 fatal / clean-exit 不动 /
// quitting 与窗口销毁防护 / 审计日志写入。预算重置与有界防循环见
// tests/bounded-budget.spec 说明（需要可控时钟，此处覆盖基础语义）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const mainTsPath = process.argv[2] ?? path.join(PKG_ROOT, 'apps/desktop/src/main.ts');
const src = fs.readFileSync(mainTsPath, 'utf8');

// ---- 抽取补丁段 ----
if (!src.includes('RECOVERABLE_RENDERER_EXITS')) {
  console.error('❌ 目标文件不含渲染器恢复补丁段（先应用 patches/01-*.patch）');
  process.exit(1);
}
const constAnchor = src.indexOf('const RECOVERABLE_RENDERER_EXITS');
const docStart = src.lastIndexOf('/**', constAnchor);
const regStart = src.indexOf("window.webContents.on('render-process-gone'", constAnchor);
if (docStart < 0 || regStart < 0) { console.error('❌ 补丁段锚点缺失'); process.exit(1); }
// 深度扫描找处理器注册的收尾 ")"（TS 源码无分号结尾 —— 只认深度回零的 ")"）
// ⚠️ 扫描器必须跳过注释：doc 注释里的撇号（如 other's）会被当成字符串引号，
//    导致深度失配（实测：块尾被推到 60K 之外）
let depth = 0, inStr = null, esc = false, blockEnd = -1, inLineComment = false, inBlockComment = false;
for (let i = regStart - 1; i < src.length; i++) {
  const c = src[i], next = src[i + 1];
  if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
  if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
  if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
  if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
  if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') depth--;
  else if (c === ')' && depth === 0) {
    // 语句收尾判定：")" 后必须是 ";" 或换行 —— 排除参数表的 ")"（后面跟 " => "）
    let j = i + 1;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++;
    if (src[j] === ';' || src[j] === '\n' || src[j] === '\r') { blockEnd = i + 1; break; }
  }
}
if (blockEnd < 0) { console.error('❌ 找不到补丁段结尾'); process.exit(1); }
// 两段抽取：补丁在模块级插入常量/日志块（到 let focusPrimaryWindow 之前），
// 处理器注册又在 main() 深处 —— 单段 doc→handler 会把整个 main() 体卷进来。
const moduleBlock = src.slice(docStart, src.indexOf('let focusPrimaryWindow', docStart));
const handlerBlock = src.slice(regStart, blockEnd);
const segment = moduleBlock + '\n' + handlerBlock;
console.log('补丁段:', segment.length, '字符（模块级块', moduleBlock.length, '+ 处理器', handlerBlock.length, '）');


// ---- 生成每用例独立模块（桩 + 补丁段 + 该用例的触发序列）----
// ⚠️ 每用例独立模块：恢复预算是补丁段内的模块级状态，单模块连跑全部用例会
//    互相污染（真实时钟下第 3 次崩溃就 fatal —— 实测踩过）。
const STUBS = `
const st: any = { reloads: 0, fatal: [] as string[], warnings: [] as string[], logWrites: [] as any[] }
const wc: any = { h: {} as Record<string, (e?: unknown, d?: any) => void>, on(ev: string, fn: (e?: unknown, d?: any) => void) { this.h[ev] = fn } }
const window: any = { isDestroyed: () => false, reload: () => { st.reloads++ }, webContents: wc }
const reportFatal = (e: any): void => { st.fatal.push(String(e && e.message)) }
console.warn = (m: any) => { st.warnings.push(String(m)) }
const appendFileSync = (p: any, content: any) => { st.logWrites.push({ path: String(p), content: String(content) }) }
const join = (...parts: string[]) => parts.join('/')
const app = { getPath: () => 'LOGSDIR' }
let quitting = false
let navigation: any = undefined
const fire = (details: any): void => { wc.h['render-process-gone']({}, details) }
const assert = (ok: any, msg: any) => { if (!ok) { console.log("ASSERT-FAIL: " + msg); process.exit(3) } }
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))
`;
const CASES = [
  { name: 'C1 oom -> 重载 1 次且无 fatal', body: `
    fire({ reason: 'oom' }); await sleep(400)
    assert(st.reloads === 1 && st.fatal.length === 0, 'reloads=' + st.reloads + ' fatal=' + st.fatal.length)
    assert(st.warnings.some((w: string) => w.includes('recovery 1/2')), 'warning missing')` },
  { name: 'C2 crashed -> 重载', body: `
    fire({ reason: 'crashed' }); await sleep(400)
    assert(st.reloads === 1 && st.fatal.length === 0, 'reloads=' + st.reloads)` },
  { name: 'C2b killed -> 重载', body: `
    fire({ reason: 'killed' }); await sleep(400)
    assert(st.reloads === 1 && st.fatal.length === 0, 'reloads=' + st.reloads)` },
  { name: 'C7 窗口已销毁 -> 不动', body: `
    window.isDestroyed = () => true
    fire({ reason: 'oom' }); await sleep(300)
    assert(st.reloads === 0 && st.fatal.length === 0, 'reloads=' + st.reloads)` },
  { name: 'C6 退出中 -> 不动', body: `
    quitting = true
    fire({ reason: 'oom' }); await sleep(300)
    assert(st.reloads === 0 && st.fatal.length === 0, 'reloads=' + st.reloads)` },
  { name: 'C3 clean-exit -> 不动', body: `
    fire({ reason: 'clean-exit' }); await sleep(300)
    assert(st.reloads === 0 && st.fatal.length === 0, 'reloads=' + st.reloads)` },
  { name: 'C4 不可恢复原因 -> 直接 fatal 不重载', body: `
    const reasons = ['integrity-failure', 'launch-failed', 'abnormal-exit']
    for (let i = 0; i < reasons.length; i++) {
      fire({ reason: reasons[i] }); await sleep(300)
      assert(st.fatal.length === i + 1 && st.reloads === 0, 'fatal=' + st.fatal.length + ' reloads=' + st.reloads)
    }` },
  { name: 'C9 每次恢复写审计日志', body: `
    // 60s 预算内最多 2 次恢复 ⟹ 只发 2 次（第 3 次 fatal 不写日志，属预期）
    for (const reason of ['oom', 'crashed']) { fire({ reason }); await sleep(300) }
    assert(st.logWrites.length === 2 && st.logWrites.every((w: any) => String(w.path).endsWith('renderer-recovery.log')),
           JSON.stringify(st.logWrites.slice(0, 2)))` },
];

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p282-handler-'));
fs.writeFileSync(path.join(runDir, 'stubs.ts'), STUBS, 'utf8');
fs.writeFileSync(path.join(runDir, 'segment.ts'), segment, 'utf8');
fs.writeFileSync(path.join(runDir, 'cases.json'), JSON.stringify(CASES.map(c => ({ name: c.name, body: c.body.replace(/^ {4}/gm, '') }))), 'utf8');
const runnerTs = `
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const stubs = fs.readFileSync(path.join(here, 'stubs.ts'), 'utf8')
const segment = fs.readFileSync(path.join(here, 'segment.ts'), 'utf8')
const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'))
let fails = 0
for (let n = 0; n < cases.length; n++) {
  const modTs = stubs + '\\n' + segment + '\\n' + cases[n].body + '\\n'
  const f = path.join(here, 'case-' + n + '.ts')
  fs.writeFileSync(f, modTs, 'utf8')
  let out = ''
  try {
    out = execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 60000, cwd: here })
  } catch (e: any) { out = String(e.stdout || '') + String(e.stderr || '') }
  const ok = !/ASSERT-FAIL/.test(out) && !/Error/.test(out)
  console.log((ok ? '  PASS  ' : '  FAIL  ') + cases[n].name + (ok ? '' : '  <- ' + out.split('\\n').filter((l: string) => /ASSERT-FAIL|Error/.test(l)).slice(0, 2).join(' | ')))
  if (!ok) fails++
  try { fs.rmSync(f, { force: true }) } catch {}
}
console.log(fails ? 'FAIL: ' + fails + ' cases' : 'PASS: all handler-semantics cases')
process.exit(fails ? 1 : 0)
`;
fs.writeFileSync(path.join(runDir, 'runner.ts'), runnerTs, 'utf8');

let fails = 1;
try {
  const out = execFileSync(NODE, [path.join(runDir, 'runner.ts')], { encoding: 'utf8', timeout: 300000, cwd: runDir });
  console.log(out);
  fails = /FAIL:/.test(out) ? 1 : 0;
} catch (e) {
  console.log('runner 执行失败:');
  console.log(String(e.stdout || '').slice(0, 800));
  console.log(String(e.stderr || '').slice(0, 800));
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}
process.exit(fails > 0 ? 1 : 0);