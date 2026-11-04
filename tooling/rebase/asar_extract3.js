// 从 app.asar 提取文件（RC3 复用 —— 格式与 RC2 相同已验证）
// 用法: node asar_extract3.js <asar内路径> [更多路径...]
// 提取到 work/asar-src/ 下（可用 DSH_EXTRACT_OUT 覆盖）
const fs = require('fs');
const path = require('path');
const ASAR = process.env.DSH_ASAR || __ASAR;
const OUT = process.env.DSH_EXTRACT_OUT || path.join(__WORK, 'asar-src');
fs.mkdirSync(OUT, { recursive: true });
const fd = fs.openSync(ASAR, 'r');
const hdr = Buffer.alloc(16);
fs.readSync(fd, hdr, 0, 16, 0);
const jsonLen = hdr.readUInt32LE(12);
const buf = Buffer.alloc(jsonLen);
fs.readSync(fd, buf, 0, jsonLen, 16);
const s = buf.toString('utf8');
const end = s.lastIndexOf('}') + 1;
const header = JSON.parse(s.slice(0, end));
const dataBase = 8 + buf.readUInt32LE(4);
console.log('jsonLen', jsonLen, 'dataOffset', dataOffset);

const files = [];
(function walk(node, p) {
  if (!node) return;
  if (node.files) for (const [k, v] of Object.entries(node.files)) walk(v, p ? p + '/' + k : k);
  else if (typeof node.size === 'number') files.push([p, node.size, node.offset, !!node.unpacked]);
})(header, '');
fs.writeFileSync(path.join(OUT, '_index.tsv'),
  files.map(f => `${f[1]}\t${f[2]}\t${f[3] ? 'U' : '-'}\t${f[0]}`).join('\n'));
console.log('files', files.length);
console.log('root:', Object.keys(header.files).join(','));
const targets = process.argv.slice(2);
let found = 0;
for (const t of targets) {
  const recs = files.filter(f => f[0] === t || f[0].startsWith(t + '/'));
  if (!recs.length) { console.log('NOMATCH', t); continue; }
  for (const rec of recs) {
    const b = Buffer.alloc(rec[1]);
    fs.readSync(fd, b, 0, rec[1], dataOffset + Number(rec[2]));
    const dest = path.join(OUT, rec[0]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, b);
    console.log('OK', rec[1], rec[0]);
    found++;
  }
}
console.log('extracted', found, 'paths');
fs.closeSync(fd);
