// 读取 Electron fuse 配置（fuse wire sentinel 后的字节）。
// sentinel: dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX
// fuse 索引（@electron/fuses 版本 1）：
//   0 RunAsNode  1 EnableCookieEncryption  2 EnableNodeOptionsEnvironmentVariable
//   3 EnableNodeCliInspectArguments  4 EnableEmbeddedAsarIntegrityValidation
//   5 OnlyLoadAppFromAsar  6 LoadBrowserProcessSpecificV8Snapshot  7 GrantFileProtocolExtraPrivileges
// 值: 0x30 ('0')=disable  0x31 ('1')=enable  0x32 ('2')=removed/inert
const fs = require('fs');
const EXE = process.env.DSH_EXE || __EXE;
const buf = fs.readFileSync(EXE);
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const at = buf.indexOf(SENTINEL);
if (at < 0) { console.log('未找到 fuse sentinel（旧版 Electron？）'); process.exit(0); }
console.log('fuse sentinel @', at);
// 布局: sentinel | version(1B) | count(1B) | fuses(count B)
const version = buf[at + SENTINEL.length];
const count = buf[at + SENTINEL.length + 1];
console.log('wire version:', version, ' fuse 数量:', count);
const NAMES = ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges'];
for (let i = 0; i < count && i < NAMES.length; i++) {
  const v = buf[at + SENTINEL.length + 2 + i];
  const state = v === 0x31 ? 'ENABLED' : v === 0x30 ? 'disabled' : 'inert(0x' + v.toString(16) + ')';
  console.log(`  fuse[${i}] ${(NAMES[i] || 'fuse' + i).padEnd(42)} ${state}`);
}
