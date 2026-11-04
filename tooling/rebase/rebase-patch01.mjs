// ★ P-282：生成 rebase 到最新 master 的补丁 01（含 v3 完善项），全程原子化。
//   ① 读 pristine main.ts  ② 三处精确替换  ③ git diff 出补丁
//   ④ round-trip：reset 后 apply --check + apply + 语义抽查  ⑤ 还原工作树
import { execSync } from 'node:child_process';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';
import { BUNDLE_ROOT as __BUNDLE } from '../../config/resolve.mjs';

import fs from 'node:fs';
import crypto from 'node:crypto';

const REPO = process.env.DSH_REPO_DIR || path.join(__WORK, 'dsh-patch-test');
const FILE = 'apps/desktop/src/main.ts';
const OUT = process.env.DSH_PATCH_OUT || path.join(__BUNDLE, 'patches', '01-desktop-renderer-recovery.patch');
const run = (cmd, opts) => execSync(cmd, { cwd: REPO, encoding: 'utf8', ...opts });

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// ---- ① pristine 基线（确保工作树 = HEAD）----
run('git checkout -- ' + JSON.stringify(FILE));
const rawPristine = fs.readFileSync(REPO + '/' + FILE, 'utf8');
// git autocrlf 可能把工作树写成 CRLF —— 处理时统一归一化为 LF，写回时恢复原风格
const hadCrlf = rawPristine.includes('\r\n');
const pristine = hadCrlf ? rawPristine.replace(/\r\n/g, '\n') : rawPristine;
console.log('① pristine:', pristine.length, '字符, 行尾', hadCrlf ? 'CRLF（已归一化处理）' : 'LF');
const must = (cond, msg) => { if (!cond) { console.error('❌ ' + msg); process.exit(1); } };
must(pristine.includes("import { access, readFile, writeFile } from 'node:fs/promises'"), 'fs/promises 导入锚点');
must(pristine.includes("import { DesktopBackgroundNotice } from './background-notice.ts'"), 'background-notice 锚点');
must(pristine.includes(`window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(\`Desktop renderer exited: \${details.reason}\`), 'renderer')
      }
    })`), '处理器锚点（master 现行多行风格）');
console.log('① pristine 锚点全部命中');

// ---- ② 三处替换 ----
let out = pristine;

// ②-a 导入：appendFileSync（恢复审计日志用）
out = out.replace(
  "import { access, readFile, writeFile } from 'node:fs/promises'\nimport { join } from 'node:path'",
  "import { access, readFile, writeFile } from 'node:fs/promises'\nimport { appendFileSync } from 'node:fs'\nimport { join } from 'node:path'");
must(out.includes("import { appendFileSync } from 'node:fs'"), '②-a 导入插入');

// ②-b 模块级常量 + 审计日志函数（anchor：background-notice 导入后）
out = out.replace(
  "import { DesktopBackgroundNotice } from './background-notice.ts'\n\nlet focusPrimaryWindow",
  `import { DesktopBackgroundNotice } from './background-notice.ts'

/**
 * Renderer exits a page reload can repair. The window is a pure view over the
 * durable session log, so a dead renderer is recoverable state rather than a
 * corrupt one; \`oom\` is the case observed in the field (the renderer heap
 * exhausts on a very large session and Chromium kills the process).
 */
const RECOVERABLE_RENDERER_EXITS: ReadonlySet<string> = new Set(['oom', 'crashed', 'killed'])
/** Reloads one renderer-OOM recovery may spend before escalating to the fatal dialog. */
const MAX_RENDERER_RECOVERIES = 2
/** Delay before reloading, so a still-dying process is not asked to navigate synchronously. */
const RENDERER_RECOVERY_DELAY_MS = 250
/**
 * Isolated crashes (hours apart) must not consume each other's reload budget; only
 * a tight crash loop exhausts it, so a session that deterministically exhausts the
 * heap on load still surfaces a diagnostic instead of looping forever.
 */
const RECOVERY_BUDGET_RESET_MS = 60_000
let rendererRecoveries = 0
let lastRecoveryAt = 0
/** Persist one recovery to the app logs dir; logging must never block the recovery. */
const logRendererRecovery = (message: string): void => {
  console.warn(\`dsh desktop: \${message}\`)
  try {
    appendFileSync(join(app.getPath('logs'), 'renderer-recovery.log'), \`\${new Date().toISOString()} \${message}\\n\`)
  } catch {
    // recovery must not depend on logging
  }
}

let focusPrimaryWindow`);
must(out.includes('const RECOVERY_BUDGET_RESET_MS = 60_000'), '②-b 常量插入');

// ②-c 处理器替换
out = out.replace(
  `window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(\`Desktop renderer exited: \${details.reason}\`), 'renderer')
      }
    })`,
  `window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      if (quitting || window.isDestroyed() || details.reason === 'clean-exit') return
      // Isolated crashes (hours apart) must not consume each other's budget; only a
      // tight crash loop exhausts it, so a session that deterministically exhausts
      // the heap on load still surfaces a diagnostic instead of looping forever.
      if (Date.now() - lastRecoveryAt > RECOVERY_BUDGET_RESET_MS) rendererRecoveries = 0
      const recoverable = RECOVERABLE_RENDERER_EXITS.has(details.reason) && rendererRecoveries < MAX_RENDERER_RECOVERIES
      if (!recoverable) {
        reportFatal(new Error(\`Desktop renderer exited: \${details.reason}\`), 'renderer')
        return
      }
      rendererRecoveries += 1
      lastRecoveryAt = Date.now()
      logRendererRecovery(\`renderer exited (\${details.reason}); reloading page (recovery \${rendererRecoveries}/\${MAX_RENDERER_RECOVERIES})\`)
      setTimeout(() => {
        if (quitting || window.isDestroyed()) return
        try {
          window.reload()
        } catch (error) {
          reportFatal(error, 'renderer')
        }
      }, RENDERER_RECOVERY_DELAY_MS)
    })`);
must(out.includes("logRendererRecovery(`renderer exited"), '②-c 处理器替换');
must(out !== pristine, '② 至少一处变更');
console.log('② 三处替换完成');

// ---- ③ 写工作树 + git diff ----
const outWrite = hadCrlf ? out.replace(/\n/g, '\r\n') : out;
fs.writeFileSync(REPO + '/' + FILE, outWrite, 'utf8');
const patch = run('git diff -- ' + JSON.stringify(FILE));
must(patch.includes('diff --git'), '③ git diff 非空');
must(patch.includes('appendFileSync'), '③ diff 含新导入');
must(!patch.includes('<<<<<<<'), '③ 无冲突标记');
fs.writeFileSync(OUT, patch, 'utf8');
console.log('③ 补丁写出:', patch.split('\n').length, '行,', patch.length, '字符');

// ---- ④ round-trip 验证：reset → apply --check → apply → 内容抽查 ----
run('git checkout -- ' + JSON.stringify(FILE));
const pristineAgainRaw = fs.readFileSync(REPO + '/' + FILE, 'utf8');
const pristineAgain = hadCrlf ? pristineAgainRaw.replace(/\r\n/g, '\n') : pristineAgainRaw;
must(pristineAgain === pristine, '④ reset 后回到 pristine');
run('git apply --check ' + JSON.stringify(OUT));
console.log('④a git apply --check 通过');
run('git apply ' + JSON.stringify(OUT));
const patchedNowRaw = fs.readFileSync(REPO + '/' + FILE, 'utf8');
const patchedNow = hadCrlf ? patchedNowRaw.replace(/\r\n/g, '\n') : patchedNowRaw;
must(patchedNow === out, '④b apply 结果与预期内容逐字节一致');
console.log('④b apply 后内容与构造逐字节一致');
// 官方参照抽取语义等价性：把 apply 后文件里的补丁段抠出来跑语义测试由独立套件完成
// 这里做结构抽查：常量、导入、处理器、审计函数都在
for (const probe of ["import { appendFileSync } from 'node:fs'", 'RECOVERY_BUDGET_RESET_MS = 60_000',
                     'logRendererRecovery', "new Set(['oom', 'crashed', 'killed'])",
                     "window.reload()"]) {
  must(patchedNow.includes(probe), '④c 结构抽查: ' + probe);
}
console.log('④c 结构抽查 5/5');
run('git checkout -- ' + JSON.stringify(FILE));
console.log('⑤ 工作树已还原 pristine');

// ---- ⑥ patch 元数据 ----
const added = patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
const removed = patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;
console.log(`⑥ diffstat: +${added} -${removed}`);
console.log('✅ rebase 后的补丁 01 生成并验证完毕:', OUT);
