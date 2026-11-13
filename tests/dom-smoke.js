/*
 * 轻量 DOM 桩冒烟测试：在无浏览器环境加载真实 app.js，
 * 验证初始化、四个页签的渲染函数及主要交互不会抛异常。
 * 仅实现 app.js 实际用到的 DOM API 子集。
 */
const fs = require('node:fs');
const path = require('node:path');

class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.attributes = {};
    this.classList = {
      _set: new Set(),
      add: (...c) => c.forEach(x => this.classList._set.add(x)),
      remove: (...c) => c.forEach(x => this.classList._set.delete(x)),
      toggle: (c, force) => (force ? this.classList._set.add(c) : this.classList._set.delete(c)),
      contains: (c) => this.classList._set.has(c)
    };
    this.style = {};
    this.dataset = {};
    this._listeners = {};
    this._html = '';
    this._text = '';
    this.options = [];
    this.value = '';
    this.hidden = false;
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    // 从 HTML 字符串里提取 class / id / data-* 标记，生成可 querySelector 的桩子节点
    const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
    let m;
    while ((m = tagRe.exec(this._html))) {
      const child = new El(m[1]);
      const attrs = m[2];
      const idM = attrs.match(/id="([^"]+)"/);
      if (idM) { child.id = idM[1]; registry.set(idM[1], child); }
      const clsM = attrs.match(/class="([^"]+)"/);
      if (clsM) clsM[1].split(/\s+/).filter(Boolean).forEach(c => child.classList.add(c));
      const dataM = attrs.match(/data-([\w-]+)="([^"]*)"/);
      if (dataM) child.dataset[camel(dataM[1])] = dataM[2];
      this.children.push(child);
    }
  }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); this._html = ''; }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.children.push(c)); }
  remove() { this.removed = true; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev) { (this._listeners[t] || []).forEach(fn => fn(ev || {})); }
  click() { this.dispatch('click', { stopPropagation() {}, target: this }); }
  querySelector(sel) { return this._query(sel, false); }
  querySelectorAll(sel) { return this._query(sel, true); }
  _query(sel, all) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return all ? out : (out[0] || null);
  }
}
function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function matches(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('[')) {
    const k = sel.slice(1, sel.indexOf('='));
    const v = sel.slice(sel.indexOf('"') + 1, sel.lastIndexOf('"'));
    return el.dataset[k] === v || el.attributes[k] === v;
  }
  return el.tagName === sel.toUpperCase();
}

const registry = new Map();
function makeEl(tag) {
  const el = new El(tag);
  return new Proxy(el, {
    set(t, k, v) { t[k] = v; return true; },
    get(t, k) {
      if (k in t) return t[k];
      return undefined;
    }
  });
}

const ids = new Set([...fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8')
  .matchAll(/id="([^"]+)"/g)].map(m => m[1]));
// 弹窗内动态 id
['rv-period', 'rv-date'].forEach(id => ids.add(id));

const documentStub = {
  createElement: (tag) => makeEl(tag),
  createTextNode: (t) => makeEl('#text'),
  querySelector(sel) {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      if (!registry.has(id)) {
        const el = makeEl('div');
        el.id = id;
        registry.set(id, el);
      }
      return registry.get(id);
    }
    return makeEl(sel.replace(/[^a-z]/gi, ''));
  },
  querySelectorAll(sel) {
    if (sel === 'nav.tabs button') return ['entries', 'close', 'tb', 'correct'].map(tab => {
      const b = makeEl('button'); b.dataset = { tab }; return b;
    });
    if (sel === '.modal-mask') return [...registry.values()].filter(e => e._isMask);
    return [];
  },
  addEventListener() {}
};

const store = new Map();
global.document = documentStub;
// app.js 通过 window.LedgerCore / window.SeedData 访问 UMD 全局；让 window 即 global
global.window = global;
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};
global.confirm = () => true;
global.alert = () => {};
global.Blob = class { constructor(parts) { this.parts = parts; } };
global.URL = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} };

// 先加载 core / seed（UMD 在 Node 下走 module.exports，显式挂到全局模拟浏览器）
global.LedgerCore = require('../js/core.js');
global.SeedData = require('../js/seed.js');
// app.js 是 IIFE，直接 require 即执行
require('../js/app.js');

const assert = require('node:assert/strict');

// 初始化后应已写入 localStorage
assert.ok(store.has('local-close-desk:v1'), '初始化应持久化状态');
const saved = JSON.parse(store.get('local-close-desk:v1'));
assert.ok(saved.vouchers.length >= 13, '种子凭证应已入账');
assert.equal(saved.periods['2026-08'].status, 'closed');

// 触发各页签按钮的 click 监听（模拟 nav 切换）
const navBtns = documentStub.querySelectorAll('nav.tabs button');
for (const b of navBtns) b.dispatch('click', { target: b });

// 手动派发渲染相关控件事件，确保监听内代码可运行
function fire(id, type, ev) {
  const el = documentStub.querySelector('#' + id);
  el.dispatch(type, ev || { target: el });
}
['f-period', 'f-account', 'f-voucher', 'f-kind'].forEach(id => fire(id, 'change'));
fire('f-keyword', 'input');
fire('btn-clear-filter', 'click');
fire('btn-new-voucher', 'click');
fire('btn-add-line', 'click');
fire('btn-save-voucher', 'click');           // 桩里默认值，可能校验失败，走 toast 分支
fire('btn-import-vouchers', 'click');
fire('btn-load-bad-samples', 'click');
fire('btn-do-import', 'click');
fire('btn-export', 'click');
fire('tb-period', 'change');
fire('btn-tb-refresh', 'click');
fire('btn-simulate', 'click');
fire('btn-close', 'click');
fire('btn-cancel-sim', 'click');
fire('btn-reopen', 'click');
fire('btn-reset', 'click');

console.log('✅ DOM 桩冒烟测试通过：app.js 初始化 + 四页签渲染 + 主要交互均无异常');
console.log('   持久化凭证数:', JSON.parse(store.get('local-close-desk:v1')).vouchers.length);
