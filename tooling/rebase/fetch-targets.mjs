// 拉取补丁目标文件（master HEAD），建最小 git 仓库，验证补丁是否仍适用。
// 背景：git 网络被断（connection reset），但 Node TLS 正常；tarball 太慢。
// 本脚本只拉 3 个文件 —— 足以做 git apply --check（补丁只碰这 3 个文件）。
import fs from 'node:fs';
// __BUNDLE_PATHS__ 统一路径（见 config/resolve.mjs）
import { ASAR as __ASAR, PATCHED_ASAR as __PATCHED, TESTVARIANT_ASAR as __TESTVARIANT, WORK_DIR as __WORK, NODE_EXE as __NODE, assertRuntime as __assertRuntime, describe as __describe } from '../../config/resolve.mjs';

import path from 'node:path';
import { execSync } from 'node:child_process';

const BASE = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/';
const FILES = [
  'apps/desktop/src/main.ts',
  'packages/api/session-controller/src/client/contract/events.ts',
  'packages/api/session-controller/src/client/sessions/session.ts',
];
const ROOT = process.env.DSH_REPO_DIR || path.join(__WORK, 'dsh-patch-test');

// raw.githubusercontent 常被 reset；api.github.com 实测最稳。两路 + 重试。
async function fetchFile(f) {
  const attempts = [
    async () => {
      const r = await fetch('https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/' + f,
        { headers: { 'User-Agent': 'dsh-patch-check' } });
      if (!r.ok) throw new Error('raw HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
    async () => {
      const r = await fetch('https://api.github.com/repos/deepseek-ai/deepseek-harness/contents/' + f + '?ref=master',
        { headers: { 'User-Agent': 'dsh-patch-check' } });
      if (!r.ok) throw new Error('api HTTP ' + r.status);
      const j = await r.json();
      return Buffer.from(j.content, 'base64');
    },
  ];
  let lastErr;
  for (let round = 0; round < 3; round++) {
    for (const [i, attempt] of attempts.entries()) {
      try {
        return await attempt();
      } catch (e) {
        lastErr = e;
        console.log('  retry', round + '-' + i, e.message);
      }
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  throw lastErr;
}

fs.rmSync(ROOT, { recursive: true, force: true });
for (const f of FILES) {
  const dest = path.join(ROOT, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const t = Date.now();
  const body = await fetchFile(f);
  fs.writeFileSync(dest, body);
  console.log('OK', (body.length / 1024).toFixed(1) + 'KB', ((Date.now() - t) / 1000).toFixed(1) + 's', f);
}
execSync('git init -q && git add -A && git -c user.email=v@local -c user.name=v commit -q -m baseline', { cwd: ROOT, stdio: 'inherit' });
console.log('baseline committed');
console.log('HEAD version refs:', (() => {
  try {
    const mt = fs.readFileSync(path.join(ROOT, 'apps/desktop/src/main.ts'), 'utf8');
    const m = mt.match(/desktopClientVersion[\s\S]{0,120}?return "([^"]+)"/);
    return m ? m[1] : '(未找到 desktopClientVersion)';
  } catch (e) { return '?'; }
})());
