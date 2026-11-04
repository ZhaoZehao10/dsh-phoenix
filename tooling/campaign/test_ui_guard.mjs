// ★ v8 测试：UI 守护（主滚动容器 + 草稿快照/恢复 + 堆水位预警）。
import fs from 'node:fs';
const SRC = fs.readFileSync('D:/DSH_Workspace/patch-fragments/ui-guard.js', 'utf8');
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
};

function makeEl(tag, props = {}) {
  const el = {
    nodeType: 1, tagName: tag.toUpperCase(), children: [], parentElement: null, previousElementSibling: null,
    scrollTop: props.scrollTop || 0, scrollHeight: props.scrollHeight || 0, clientHeight: props.clientHeight || 0,
    value: props.value, isContentEditable: !!props.isContentEditable, innerText: props.innerText || '',
    _listeners: {},
    dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((f) => f(ev)); return true; },
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
  };
  return el;
}
function link(parent, child) {
  parent.children.push(child);
  child.parentElement = parent;
  child.previousElementSibling = parent.children.length > 1 ? parent.children[parent.children.length - 2] : null;
  return child;
}
function makeEnv(opts = {}) {
  const html = makeEl('html');
  const body = link(html, makeEl('body'));
  const composer = link(body, makeEl('div'));
  const textarea = link(composer, makeEl('textarea', { value: opts.value || 'draft text' }));
  const scrollBox = link(body, makeEl('div', { scrollTop: opts.scrollTop || 240, scrollHeight: 4000, clientHeight: 400 }));
  const all = [html, body, composer, textarea, scrollBox];
  const store = new Map(Object.entries(opts.store || {}));
  const timers = [];
  const warns = [];
  const clock = { now: opts.now || 1700000000000 };
  const doc = {
    children: [html],
    querySelectorAll(sel) { if (sel.indexOf('textarea') >= 0) return [textarea]; if (sel === '*') return all; return []; },
  };
  const sandbox = {
    window: { scrollX: 0, scrollY: 0, scrollTo() {}, localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } },
    document: doc,
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    performance: { memory: opts.memory },
    getComputedStyle: (el) => ({ overflowY: el === scrollBox ? 'auto' : 'visible' }),
    console: { warn: (m) => warns.push(String(m)), log: () => {}, error: () => {} },
    setInterval: (fn, ms) => { timers.push({ fn, ms, kind: 'interval' }); return timers.length; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, kind: 'timeout' }); return timers.length; },
    Event: class { constructor(type) { this.type = type; } },
    HTMLTextAreaElement: class {}, HTMLInputElement: class {},
    Date: { now: () => clock.now },
    JSON, Math, String, Object, Array, parseInt, parseFloat, isNaN,
  };
  Object.defineProperty(sandbox.HTMLTextAreaElement.prototype, 'value', { set(v) { textarea.value = v; }, get() { return textarea.value; }, configurable: true });
  Object.defineProperty(sandbox.HTMLInputElement.prototype, 'value', { set(v) { textarea.value = v; }, get() { return textarea.value; }, configurable: true });
  const run = new Function(...Object.keys(sandbox), SRC + '\n');
  const drain = (max = 400) => {
    let n = 0;
    while (timers.length && n < max) {
      const t = timers.shift();
      clock.now += t.ms;
      try { t.fn(); } catch (e) {}
      n++;
    }
  };
  return { run, sandbox, timers, store, warns, textarea, scrollBox, clock, drain };
}
const KEY = '__P282_UI_SNAPSHOT__';
const NOW = 1700000000000;

// ① 安装 + 自动快照
{
  const env = makeEnv({ value: 'draft text', scrollTop: 240 });
  env.run(...Object.values(env.sandbox));
  check('U1 安装标记', env.sandbox.window.__P282_UI_GUARD__ === true);
  check('U1b 激活日志', env.warns.some((w) => w.indexOf('[P-282-UI]') === 0), env.warns[0] || '');
  const autosave = env.timers.find((t) => t.ms === 2000);
  check('U2 注册 2s 自动快照', !!autosave);
  if (autosave) autosave.fn();
  const snap = JSON.parse(env.store.get(KEY) || 'null');
  check('U3 快照含草稿', snap && snap.fields[0] && snap.fields[0].v === 'draft text', snap ? JSON.stringify(snap.fields[0] || {}) : 'none');
  check('U4 快照含主滚动容器', snap && snap.main && snap.main.y === 240 && snap.main.h === 4000, snap ? JSON.stringify(snap.main) : 'none');
}
// ② 新快照 ⟹ 恢复（草稿 + 滚动）
{
  const env = makeEnv({ value: '', scrollTop: 0 });
  env.store.set(KEY, JSON.stringify({
    t: NOW - 1000,
    main: { y: 900, h: 4000, ch: 400 },
    fields: [{ p: '0:html/0:body/0:div/0:textarea', v: 'saved draft', ce: false }],
  }));
  env.run(...Object.values(env.sandbox));
  env.drain(80);
  check('U5 新快照恢复草稿', env.textarea.value === 'saved draft', env.textarea.value);
  check('U6 新快照恢复滚动（按比例）', env.scrollBox.scrollTop === 900, String(env.scrollBox.scrollTop));
  check('U7 恢复过程有日志', env.warns.some((w) => w.indexOf('[P-282-UI] scroll restore') === 0), env.warns.find((w) => w.indexOf('scroll restore') >= 0) || '');
}
// ③ 过期快照 ⟹ 不恢复
{
  const env = makeEnv({ value: 'current', scrollTop: 50 });
  env.store.set(KEY, JSON.stringify({ t: NOW - 60000, main: { y: 900, h: 4000, ch: 400 }, fields: [{ p: '0:html/0:body/0:div/0:textarea', v: 'stale', ce: false }] }));
  env.run(...Object.values(env.sandbox));
  env.drain(20);
  check('U8 过期快照不恢复', env.textarea.value === 'current' && env.scrollBox.scrollTop === 50, `${env.textarea.value}/${env.scrollBox.scrollTop}`);
}
// ④ 堆水位
{
  const env = makeEnv({ memory: { usedJSHeapSize: 850, jsHeapSizeLimit: 1000 } });
  env.run(...Object.values(env.sandbox));
  const memTimer = env.timers.find((t) => t.ms === 30000);
  check('U9 注册 30s 堆检查', !!memTimer);
  if (memTimer) memTimer.fn();
  check('U10 85% 触发 [P-282-MEM]', env.warns.some((w) => w.indexOf('[P-282-MEM]') === 0), env.warns.find((w) => w.indexOf('[P-282-MEM]') >= 0) || '');
}
{
  const env = makeEnv({ memory: { usedJSHeapSize: 500, jsHeapSizeLimit: 1000 } });
  env.run(...Object.values(env.sandbox));
  const memTimer = env.timers.find((t) => t.ms === 30000);
  if (memTimer) memTimer.fn();
  check('U11 50% 不告警', env.warns.filter((w) => w.indexOf('[P-282-MEM]') === 0).length === 0, JSON.stringify(env.warns));
}
console.log();
console.log(fails ? `❌ ${fails} 项失败` : '✅ UI 守护测试全部通过');
process.exit(fails ? 1 : 0);
