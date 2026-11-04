// ★ P-282 测试变体 v2：正式补丁 + 测试钩子 + 文件跟踪日志。
//   跟踪写入 work/dsh-test-trace.log（绕开 stdout 捕获的不确定性）。
const TRACE_PATH = __WORK.replace(/\\/g, "/") + "/dsh-test-trace.log";
//   钩子仅测试用，正式安装的 app.asar.patched 不含。
import fs from 'node:fs';
import path from 'node:path';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../config/resolve.mjs';
import crypto from 'node:crypto';

const ASAR = __ASAR;
const OUT = __TESTVARIANT;
const MARKER = '/* P-282 renderer-recovery v4 */';
const TEST_MARK = '/* P-282 TEST HOOKS */';

// 源 asar 解析：安装的 asar 若已含旧版补丁，自动改用最新备份作为干净源
const extractMainOf = (p) => {
  const b = fs.readFileSync(p);
  const hs = b.readUInt32LE(4), jl = b.readUInt32LE(12);
  const ss = b.slice(16, 16 + jl).toString('utf8');
  const h = JSON.parse(ss.slice(0, ss.lastIndexOf('}') + 1));
  const e = h.files.lib.files['main.js'];
  const off = 8 + hs + Number(e.offset);
  return b.slice(off, off + e.size).toString('utf8');
};
let SOURCE = process.env.DSH_SOURCE_ASAR || ASAR;
if (extractMainOf(SOURCE).includes('P-282 renderer-recovery')) {
  const dir = path.dirname(ASAR);
  const baks = fs.readdirSync(dir).filter((x) => x.startsWith('app.asar.bak-')).sort();
  if (!baks.length) { console.log('❌ 安装 asar 已含补丁且无备份可作干净源'); process.exit(1); }
  SOURCE = dir + '/' + baks[baks.length - 1];
  console.log('ℹ️ 安装 asar 已含旧版补丁 ⟹ 干净源用备份:', baks[baks.length - 1]);
}
const buf = fs.readFileSync(SOURCE);
const jsonLen = buf.readUInt32LE(12);
const jsonStart = 16;
const jsonRaw = buf.slice(jsonStart, jsonStart + jsonLen).toString('utf8');
const end = jsonRaw.lastIndexOf('}') + 1;
const header = JSON.parse(jsonRaw.slice(0, end));
const dataBase = 8 + buf.readUInt32LE(4);
const mainEntry = header.files.lib.files['main.js'];

let src = buf.slice(dataBase + Number(mainEntry.offset),
                    dataBase + Number(mainEntry.offset) + mainEntry.size).toString('utf8');
if (src.includes(MARKER)) { console.log('❌ 源 asar 已含正式补丁？不预期'); process.exit(1); }

// ---- 跟踪函数（appendFileSync 是 main.js 第 8 行已有的导入，直接用）----
const TRACE_FN = `function p282Trace(msg) {
	try {
		appendFileSync(${JSON.stringify(TRACE_PATH)}, new Date().toISOString() + " [test] " + msg + "\\n");
	} catch (_) {}
	if (process.env.DSH_TEST_DEBUG) console.log("[test] " + msg);
}`;
src = src.replace(`import { createRequire } from "node:module";`,
  `import { createRequire } from "node:module";\n${TRACE_FN}\np282Trace("main.js 顶层已加载（补丁测试变体）");`);

// ---- 正式补丁（与 patch-asar.mjs 一致）----
const OLD_HANDLER = `\t\twindow.webContents.on("render-process-gone", (_event, details) => {
\t\t\tnavigation = void 0;
\t\t\tif (!quitting && !window.isDestroyed() && details.reason !== "clean-exit") reportFatal(/* @__PURE__ */ new Error(\`Desktop renderer exited: \${details.reason}\`), "renderer");
\t\t});`;
const NEW_HANDLER = `${MARKER}
\t\t// 上游补丁 01（renderer recovery）+ 本地完善：渲染器死亡 ≠ 应用死亡。
\t\t// 会话日志在磁盘上、Host 仍健康，重载页面即恢复视图。
\t\t// 有界（2 次）防止「一加载必崩」的会话变成无限重载循环；
\t\t// 耗尽后仍走原 reportFatal ⟹ 诊断与弹窗路径一个不少。
\t\t//
\t\t// 本地完善 ①（预算重置）：距上次恢复超过 60s 的孤立崩溃不累计——
\t\t//   隔小时级的两次偶发崩溃各自独立恢复；只有 60s 内的连环崩才耗尽预算。
\t\t// 本地完善 ②（可审计）：恢复事件写入 logs/renderer-recovery.log——
\t\t//   打包的 GUI 应用里 console.warn 无人看见，没有日志就无法确认恢复发生过。
\t\tconst RECOVERABLE_RENDERER_EXITS = new Set(["oom", "crashed", "killed"]);
\t\tconst MAX_RENDERER_RECOVERIES = 2;
\t\tconst RENDERER_RECOVERY_DELAY_MS = 250;
\t\tconst RECOVERY_BUDGET_RESET_MS = 60000;
\t\tlet rendererRecoveries = 0;
\t\tlet lastRecoveryAt = 0;
\t\tconst logRendererRecovery = (message) => {
\t\t\tconsole.warn(\`dsh desktop: \${message}\`);
\t\t\ttry {
\t\t\t\tappendFileSync(join(app.getPath("logs"), "renderer-recovery.log"), \`\${new Date().toISOString()} \${message}\\n\`);
\t\t\t} catch (_error) {}
\t\t};
\t\twindow.webContents.on("render-process-gone", (_event, details) => {
\t\t\tnavigation = void 0;
\t\t\tif (quitting || window.isDestroyed() || details.reason === "clean-exit") return;
\t\t\tif (Date.now() - lastRecoveryAt > RECOVERY_BUDGET_RESET_MS) rendererRecoveries = 0;
\t\t\tconst recoverable = RECOVERABLE_RENDERER_EXITS.has(details.reason) && rendererRecoveries < MAX_RENDERER_RECOVERIES;
\t\t\tif (!recoverable) {
\t\t\t\treportFatal(new Error(\`Desktop renderer exited: \${details.reason}\`), "renderer");
\t\t\t\treturn;
\t\t\t}
\t\t\trendererRecoveries += 1;
\t\t\tlastRecoveryAt = Date.now();
\t\t\tlogRendererRecovery(\`renderer exited (\${details.reason}); reloading page (recovery \${rendererRecoveries}/\${MAX_RENDERER_RECOVERIES})\`);
\t\t\tsetTimeout(() => {
\t\t\t\tif (quitting || window.isDestroyed()) return;
\t\t\t\ttry {
\t\t\t\t\twindow.reload();
\t\t\t\t} catch (error) {
\t\t\t\t\treportFatal(error, "renderer");
\t\t\t\t}
\t\t\t}, RENDERER_RECOVERY_DELAY_MS);
\t\t});`;
const BOOTCHECK = `
\t\t// ★ P-282 v3 BOOTCHECK：安装脚本的启动自检钩子（未设环境变量时完全惰性）
\t\tif (process.env.DSH_PATCH_BOOTCHECK) {
\t\t\tapp.whenReady().then(() => {
\t\t\t\ttry {
\t\t\t\t\tappendFileSync(process.env.DSH_PATCH_BOOTCHECK, \`boot-ok \${app.getVersion()} marker=P-282-v4\\n\`);
\t\t\t\t} catch (_error) {}
\t\t\t\tapp.exit(77);
\t\t\t});
\t\t}`;

if (!src.includes(OLD_HANDLER)) { console.log('❌ 未找到处理器原文'); process.exit(1); }
src = src.replace(OLD_HANDLER, NEW_HANDLER + BOOTCHECK);

// ---- 测试钩子：单实例锁绕过 + userData 重定向 ----
const OLD_LOCK = `function claimDesktopSingleInstance(application, focusOwner) {
	if (!application.requestSingleInstanceLock()) {`;
const NEW_LOCK = `${TEST_MARK}
	function claimDesktopSingleInstance(application, focusOwner) {
	p282Trace("claimDesktopSingleInstance: NO_SINGLE=" + process.env.DSH_TEST_NO_SINGLE);
	if (process.env.DSH_TEST_NO_SINGLE === "1") {
		if (process.env.DSH_TEST_USER_DATA) {
			application.setPath("userData", process.env.DSH_TEST_USER_DATA);
			p282Trace("userData 重定向到 " + process.env.DSH_TEST_USER_DATA);
		}
		return true;
	}
	if (!application.requestSingleInstanceLock()) {`;
if (!src.includes(OLD_LOCK)) { console.log('❌ 未找到单实例锁原文'); process.exit(1); }
src = src.replace(OLD_LOCK, NEW_LOCK);

// ---- main() 入口 + window-all-closed 跟踪 ----
const OLD_MAIN = `async function main() {`;
if (!src.includes(OLD_MAIN)) { console.log('❌ 未找到 main()'); process.exit(1); }
src = src.replace(OLD_MAIN, `async function main() {
	p282Trace("main() 已进入");`);
const OLD_WAC = `app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});`;
if (!src.includes(OLD_WAC)) { console.log('❌ 未找到 window-all-closed'); process.exit(1); }
src = src.replace(OLD_WAC, `app.on("window-all-closed", () => {
		p282Trace("window-all-closed 触发 ⟹ 即将退出");
		if (process.platform !== "darwin") app.quit();
	});`);

// ---- 测试钩子：不劫持 dsh:// 协议 ----
const OLD_PROTO = `if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP === "1") app.setAsDefaultProtocolClient("dsh");`;
if (!src.includes(OLD_PROTO)) { console.log('❌ 未找到协议注册'); process.exit(1); }
src = src.replace(OLD_PROTO, `p282Trace("跳过 dsh:// 协议注册（测试变体）"); ${TEST_MARK} proto`);

// ---- 组装（追加式布局，与 patch-asar.mjs 相同）----
function integrityOf(b) {
  const hash = crypto.createHash('sha256').update(b).digest('hex');
  const blocks = [];
  for (let off = 0; off < b.length; off += 4194304) {
    blocks.push(crypto.createHash('sha256').update(b.slice(off, off + 4194304)).digest('hex'));
  }
  return { algorithm: 'SHA256', hash, blockSize: 4194304, blocks };
}
mainEntry.integrity = integrityOf(Buffer.from(src, 'utf8'));
mainEntry.offset = String(buf.length - dataBase);
mainEntry.size = Buffer.byteLength(src, 'utf8');
const origJsonLen = jsonRaw.slice(0, end).length;
let newJson = JSON.stringify(header);
if (newJson.length > origJsonLen) { console.log('❌ 头部 JSON 变长', newJson.length, '>', origJsonLen); process.exit(1); }
newJson = newJson + ' '.repeat(origJsonLen - newJson.length);
const out = Buffer.concat([
  buf.slice(0, jsonStart),                        // [0..16) 控制区
  Buffer.from(newJson, 'utf8'),                   // JSON 字符串（等长改写）
  buf.slice(jsonStart + jsonLen, dataBase),       // ★ pickle 对齐填充（原样保留 —— 丢了会整体错位）
  buf.slice(dataBase),                            // 数据区（原封不动）
  Buffer.from(src, 'utf8'),                       // 追加的测试变体 main.js
]);
fs.writeFileSync(OUT, out);
console.log('写出测试变体', OUT, (out.length / 1048576).toFixed(1), 'MB');
console.log('钩子:', src.includes(TEST_MARK) ? '✅' : '❌', '| 正式补丁:', src.includes(MARKER) ? '✅' : '❌',
            '| 跟踪函数:', src.includes('p282Trace') ? '✅' : '❌', '| BOOTCHECK:', src.includes('DSH_PATCH_BOOTCHECK') ? '✅' : '❌');
