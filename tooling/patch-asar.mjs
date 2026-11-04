// ★ P-282：给 app.asar 里的 lib/main.js 打「渲染器死亡恢复」补丁。
//
// 背景（详见本轮分析）：
//   · RC3 的 render-process-gone 处理器把任何非 clean-exit 的渲染器死亡
//     一律升级为 fatal 弹窗 ⟹ 整个应用瘫死（P-278 崩溃的实际恶化器）。
//   · 上游补丁 01（renderer recovery）对本 RC3 的 main.ts 仍干净适用，
//     但完整构建需数小时且从未有人跑通。
//   · 实测三项绿灯使轻量路径成立：
//       ① fuse EnableEmbeddedAsarIntegrityValidation = disabled
//       ② fuse OnlyLoadAppFromAsar = disabled
//       ③ app.asar 的 ACL 允许当前用户写（交接方的「不可写」是运行期文件锁）
//
// 做法：不改 1.8 万个文件的布局 ——
//   ① 就地改写头部 JSON 里 main.js 的 offset/size/integrity（保持 JSON 总长不变，
//      用空格补齐 ⟹ 其余全部文件的有效偏移一个都不动）
//   ② 把打过补丁的 main.js 追加到 asar 文件末尾
//
// 幂等：main.js 内含 marker，重复运行直接退出。
// 产物：app.asar.patched（不覆盖原文件；切换由 install-patched.ps1 执行）。
import fs from 'node:fs';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, EXE as __EXE, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, INSTALL_DIR as __INSTALL, assertRuntime as __assertRuntime, describe as __describe } from '../config/resolve.mjs';
import crypto from 'node:crypto';
import path from 'node:path';

const ASAR = __ASAR;
const OUT = __PATCHED;
const MARKER = '/* P-282 renderer-recovery v6 */';

// 源 asar 解析：若安装的 asar 已含旧版补丁（用户已安装过），自动改用最新备份作为干净源。
// 这是「补丁升级」场景：安装中的 asar 是补丁版，备份才是原版。
const extractMainOf = (p) => {
  const b = fs.readFileSync(p);
  const hs = b.readUInt32LE(4);
  const jl = b.readUInt32LE(12);
  const s = b.slice(16, 16 + jl).toString('utf8');
  const h = JSON.parse(s.slice(0, s.lastIndexOf('}') + 1));
  const e = h.files.lib.files['main.js'];
  const off = 8 + hs + Number(e.offset);
  return b.slice(off, off + e.size).toString('utf8');
};
let SOURCE = process.env.DSH_SOURCE_ASAR || ASAR;
let srcProbe = extractMainOf(SOURCE);
if (srcProbe.includes('P-282 renderer-recovery')) {
  const dir = path.dirname(ASAR);
  const baks = fs.readdirSync(dir).filter((f) => f.startsWith('app.asar.bak-')).sort();
  if (!baks.length) {
    console.log('❌ 安装的 asar 已含旧版补丁，且找不到备份作为干净源。');
    console.log('   先运行 scripts/revert-asar.ps1 还原，或用 DSH_SOURCE_ASAR=<原版 asar> 指定。');
    process.exit(1);
  }
  SOURCE = path.join(dir, baks[baks.length - 1]);
  console.log('ℹ️ 安装的 asar 已含旧版补丁 ⟹ 自动改用最新备份作为干净源:', baks[baks.length - 1]);
  srcProbe = extractMainOf(SOURCE);
}
const buf = fs.readFileSync(SOURCE);
console.log('原 asar:', (buf.length / 1048576).toFixed(1), 'MB');
// ---- ⓪ fuse 安全校验（必须在动 asar 之前）----
// 若构建启用了 EnableEmbeddedAsarIntegrityValidation，补丁后的 asar 会被
// Electron 直接拒绝加载（应用起不来）。这里实测 exe 的 fuse wire，拒绝硬闯。
{
  const exePath = path.resolve(ASAR, '../../DeepSeek Harness.exe');
  if (!fs.existsSync(exePath)) {
    console.log('⚠️ 找不到主程序 exe，跳过 fuse 校验:', exePath);
  } else {
    const exeBuf = fs.readFileSync(exePath);
    const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
    const at = exeBuf.indexOf(SENTINEL);
    if (at < 0) {
      console.log('⚠️ 未找到 fuse sentinel（旧版 Electron）—— 无法校验，继续');
    } else {
      const count = exeBuf[at + SENTINEL.length + 1];
      const fuseVal = (i) => exeBuf[at + SENTINEL.length + 2 + i];
      const stateOf = (v) => v === 0x31 ? 'enabled' : v === 0x30 ? 'disabled' : `inert(0x${v.toString(16)})`;
      const integrity = fuseVal(4);
      const onlyAsar = fuseVal(5);
      console.log(`fuse: EnableEmbeddedAsarIntegrityValidation=${stateOf(integrity)} OnlyLoadAppFromAsar=${stateOf(onlyAsar)} (count=${count})`);
      if (integrity !== 0x30) {
        console.log('❌ 该构建启用了 asar 完整性校验 —— 补丁 asar 会被拒绝加载，拒绝制作。');
        console.log('   对策：先禁用该 fuse（@electron/fuses flip）或改用源码构建。');
        process.exit(1);
      }
      if (onlyAsar === 0x31) console.log('ℹ️ OnlyLoadAppFromAsar=enabled（不影响打补丁，仅限制从 asar 加载）');
    }
  }
}

// ---- ① 解析头部（基准偏移按官方 disk.js 公式）----
//   参照 @electron/asar/lib/disk.js readFileSync：
//     fileOffset = 8 + headerSize + info.offset
//   其中 headerSize = buf.readUInt32LE(4)（第一个 pickle 的 readUInt32）。
//   ⚠️ P-282b 教训：不能用 `16 + lastIndexOf('}')+1` 当数据基准 ——
//      RC2 的 pickle 布局碰巧让该式命中，RC3 差 1 字节 ⟹ main.js 整体
//      前移 1 字节、越界 1 字节，Electron 拒绝加载（语法检查与行号核对
//      全部被骗过 —— 官方参照实现 @electron/asar 抓到了）。
const headerSize = buf.readUInt32LE(4);
const dataBase = 8 + headerSize;
console.log('headerSize =', headerSize, '⟹ 数据基准 =', dataBase);

const jsonLen = buf.readUInt32LE(12);        // 头部 pickle 里的字符串长度
const jsonStart = 16;                        // 字符串体（{ 之前有 4 字节长度字段）
const jsonRaw = buf.slice(jsonStart, jsonStart + jsonLen).toString('utf8');
const end = jsonRaw.lastIndexOf('}') + 1;
const jsonStr = jsonRaw.slice(0, end);
const header = JSON.parse(jsonStr);
// 健全性断言：数据基准必须在 JSON 结束之后的 pickle 对齐区（≤3 字节填充）内
if (dataBase < jsonStart + end || dataBase > jsonStart + jsonLen + 3) {
  console.log('❌ 数据基准', dataBase, '不在 JSON 结束 [', jsonStart + end, '] 的对齐区 [..', jsonStart + jsonLen + 3, '] 内 —— 布局假设破坏'); process.exit(1);
}
console.log('JSON 结束于', jsonStart + end, '，pickle 对齐到', dataBase, '（空隙', dataBase - jsonStart - end, '字节）');
const mainEntry = header.files.lib.files['main.js'];

// ---- ② 取出现有 main.js 并应用补丁 ----
const src = buf.slice(dataBase + Number(mainEntry.offset),
                      dataBase + Number(mainEntry.offset) + mainEntry.size).toString('utf8');
if (src.includes(MARKER)) { console.log('已打过补丁（含 marker），退出'); process.exit(0); }

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
\t\t\t\tconst logRendererRecovery = (message) => {
\t\t\tlet extra = "";
\t\t\ttry {
\t\t\t\tconst tabs = app.getAppMetrics().filter((m) => m.type === "Tab");
\t\t\t\tconst rss = Math.round(process.memoryUsage().rss / 1048576);
\t\t\t\textra = \` | renderers=\${tabs.map((t) => Math.round((t.memory.privateBytes || 0) / 1024) + "MB").join("+") || "n/a"} last=\${typeof p282LastRendererMemory !== "undefined" && p282LastRendererMemory ? p282LastRendererMemory : "n/a"} mainRSS=\${rss}MB\`;
\t\t\t} catch (_error) {}
\t\t\tconsole.warn(\`dsh desktop: \${message}\${extra}\`);
\t\t\ttry {
\t\t\t\tappendFileSync(join(app.getPath("logs"), "renderer-recovery.log"), \`\${new Date().toISOString()} \${message}\${extra}\\n\`);
\t\t\t} catch (_error) {}
\t\t};
\t\twindow.webContents.on("render-process-gone", (_event, details) => {
\t\t\tnavigation = void 0;
\t\t\tif (quitting || window.isDestroyed() || details.reason === "clean-exit") return;
\t\t\tif (Date.now() - lastRecoveryAt > RECOVERY_BUDGET_RESET_MS) rendererRecoveries = 0;
\t\t\tconst recoverable = RECOVERABLE_RENDERER_EXITS.has(details.reason) && rendererRecoveries < MAX_RENDERER_RECOVERIES;
\t\t\tif (!recoverable) {
\t\t\t\tlogRendererRecovery(\`renderer exited (\${details.reason}); escalating to fatal (recovery budget exhausted or unrecoverable)\`);
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

if (!src.includes(OLD_HANDLER)) { console.log('❌ 未找到预期的 render-process-gone 处理器原文 —— 上游已改？中止'); process.exit(1); }
const occurrences = src.split(OLD_HANDLER).length - 1;
if (occurrences !== 1) { console.log('❌ 处理器原文出现', occurrences, '次（预期 1 次），中止'); process.exit(1); }

// ---- 本地完善 ③（v3）：BOOTCHECK —— 让安装脚本能「真启动一次」验证补丁 asar 可加载。
//   仅当 DSH_PATCH_BOOTCHECK=<标记文件路径> 时激活（正常运行完全无感）：
//   whenReady 后写标记文件并立即 exit(77)。放在处理器段之后 ⟹ 不进入语义测试的抽取段。
const BOOTCHECK = `
\t\t// ★ P-282 v3 BOOTCHECK：安装脚本的启动自检钩子（未设环境变量时完全惰性）
\t\tif (process.env.DSH_PATCH_BOOTCHECK) {
\t\t\tapp.whenReady().then(() => {
\t\t\t\ttry {
\t\t\t\t\tappendFileSync(process.env.DSH_PATCH_BOOTCHECK, \`boot-ok \${app.getVersion()} marker=P-282-v6\\n\`);
\t\t\t\t} catch (_error) {}
\t\t\t\tapp.exit(77);
\t\t\t});
\t\t}`;

const FRAG = (n) => fs.readFileSync(new URL('./patch-fragments/' + n, import.meta.url), 'utf8');
const CRASH_HELPER = FRAG('crash-helper.txt');
const OLD_CRASH_TAIL = FRAG('crash-tail-old.txt');
const NEW_CRASH_TAIL = FRAG('crash-tail-new.txt');
const WATCHDOG = FRAG('watchdog.txt');
const INCLUDE_BOOTCHECK = process.env.DSH_NO_BOOTCHECK !== '1';
const RENDER_ANCHOR = 'function renderCrashReport(input) {';
const LOGS_ANCHOR = 'app.setAppLogsPath();';

let patched = src.replace(OLD_HANDLER, NEW_HANDLER + (INCLUDE_BOOTCHECK ? BOOTCHECK : ''));
if (!patched.includes(OLD_CRASH_TAIL)) { console.log('❌ 崩溃报告尾部锚点未命中 —— 上游已改？中止'); process.exit(1); }
patched = patched.replace(OLD_CRASH_TAIL, NEW_CRASH_TAIL);
if (!patched.includes(RENDER_ANCHOR)) { console.log('❌ renderCrashReport 锚点未命中'); process.exit(1); }
patched = patched.replace(RENDER_ANCHOR, CRASH_HELPER + RENDER_ANCHOR);
if (!patched.includes(LOGS_ANCHOR)) { console.log('❌ setAppLogsPath 锚点未命中'); process.exit(1); }
patched = patched.replace(LOGS_ANCHOR, LOGS_ANCHOR + '\n' + WATCHDOG);
console.log('main.js:', src.length, '->', patched.length, '字节（+' + (patched.length - src.length) + '）');

// ---- ③ 重算 integrity（SHA256 + 4MB 块）----
function integrityOf(b) {
  const hash = crypto.createHash('sha256').update(b).digest('hex');
  const blocks = [];
  for (let off = 0; off < b.length; off += 4194304) {
    blocks.push(crypto.createHash('sha256').update(b.slice(off, off + 4194304)).digest('hex'));
  }
  return { algorithm: 'SHA256', hash, blockSize: 4194304, blocks };
}
mainEntry.integrity = integrityOf(Buffer.from(patched, 'utf8'));

// ---- ④ 就地改写头部 JSON（总长不变）----
mainEntry.offset = String(buf.length - dataBase);   // 追加到 EOF
mainEntry.size = Buffer.byteLength(patched, 'utf8');
let newJson = JSON.stringify(header);
if (newJson.length > jsonStr.length) {
  console.log('❌ 新头部 JSON 反而更长（', newJson.length, '>', jsonStr.length, '）—— 需要另行处理'); process.exit(1);
}
newJson = newJson + ' '.repeat(jsonStr.length - newJson.length);
if (JSON.parse(newJson).files.lib.files['main.js'].offset !== mainEntry.offset) {
  console.log('❌ 补齐后解析不一致'); process.exit(1);
}

// ---- ⑤ 组装新 asar：头部区（含对齐填充，原样）+ 原数据区 + 追加的 main.js ----
// ⚠️ [jsonStart+jsonLen .. dataBase) 是 pickle 对齐填充字节 —— 必须原样保留，
//    否则整个数据区前移，所有文件偏移失配（又一个 1 字节陷阱）。
const out = Buffer.concat([
  buf.slice(0, jsonStart),                        // [0..16) 控制区
  Buffer.from(newJson, 'utf8'),                   // JSON 字符串（等长改写）
  buf.slice(jsonStart + jsonLen, dataBase),       // pickle 对齐填充（原样）
  buf.slice(dataBase),                            // 数据区（原封不动）
  Buffer.from(patched, 'utf8'),                   // 追加的补丁版 main.js
]);
fs.writeFileSync(OUT, out);
console.log('写出', OUT, (out.length / 1048576).toFixed(1), 'MB（追加', Buffer.byteLength(patched, 'utf8'), '字节 @ 相对偏移', mainEntry.offset, '）');

// ---- ⑥ 自校验：读回 + 官方参照实现抽取比对 ----
const back = fs.readFileSync(OUT);
const backHeaderSize = back.readUInt32LE(4);
const backBase = 8 + backHeaderSize;
const backJsonLen = back.readUInt32LE(12);
const backJsonRaw = back.slice(jsonStart, jsonStart + backJsonLen).toString('utf8');
const backEnd = backJsonRaw.lastIndexOf('}') + 1;
const backHeader = JSON.parse(backJsonRaw.slice(0, backEnd));
const backEntry = backHeader.files.lib.files['main.js'];
const backMain = back.slice(backBase + Number(backEntry.offset),
                            backBase + Number(backEntry.offset) + backEntry.size);
const wantHash = crypto.createHash('sha256').update(Buffer.from(patched, 'utf8')).digest('hex');
const gotHash = crypto.createHash('sha256').update(backMain).digest('hex');
console.log('回读 main.js:', backMain.length, '字节, 哈希', gotHash === wantHash ? '一致 ✅' : '❌ 不一致');
console.log('回读基准一致性:', backBase === dataBase ? '✅' : '❌', `(${backBase} vs ${dataBase})`);
// 边界检查：模拟官方 disk.js 的判定（本次事故的抓捕器）
const fileEnd = backBase + Number(backEntry.offset) + backEntry.size;
console.log('边界检查: 块尾', fileEnd, '≤ 文件长', back.length,
            fileEnd <= back.length ? '✅ 不越界' : '❌ 越界（上一个版本的 bug）');
// 其余文件抽查三个
for (const probe of ['package.json', 'dsh/package.json', 'lib/preload-app.cjs']) {
  const seg = probe.split('/');
  let node = backHeader, o = header;          // 从根开始（不是 .files）
  for (const segName of seg) { node = node.files[segName]; o = o.files[segName]; }
  const same = node.offset === o.offset && node.size === o.size;
  console.log('  未动文件', probe, same ? 'offset/size 不变 ✅' : '❌ 变了');
}
