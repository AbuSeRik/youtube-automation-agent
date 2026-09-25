// Dashboard language switch (EN original / RU via DeepL).
// Works on the rendered DOM so app.js stays untouched: known strings come from the
// static dictionary /i18n/<lang>.json, unknown ones are translated server-side once
// (POST /api/i18n/translate) and cached into the same dictionary.
(function () {
  const LANGS = ['ru', 'en'];
  const STORAGE_KEY = 'yaa_lang';
  const ATTRS = ['placeholder', 'title', 'aria-label'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'NOSCRIPT']);
  const MAX_TEXT = 5000;

  let lang = 'ru';
  try { lang = LANGS.includes(localStorage.getItem(STORAGE_KEY)) ? localStorage.getItem(STORAGE_KEY) : 'ru'; } catch (_e) { /* storage blocked */ }
  document.documentElement.lang = lang;

  function renderToggle() {
    if (document.getElementById('i18n-toggle')) return;
    const wrap = document.createElement('div');
    wrap.id = 'i18n-toggle';
    wrap.setAttribute('data-no-i18n', '');
    wrap.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9999;display:flex;border-radius:999px;overflow:hidden;' +
      'border:1px solid rgba(255,255,255,.25);background:rgba(20,20,24,.85);font:600 12px Inter,system-ui,sans-serif;backdrop-filter:blur(6px)';
    for (const code of LANGS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = code.toUpperCase();
      button.style.cssText = 'border:0;padding:6px 12px;cursor:pointer;color:#fff;background:' + (code === lang ? '#ff4d5e' : 'transparent');
      button.addEventListener('click', () => {
        if (code === lang) return;
        try { localStorage.setItem(STORAGE_KEY, code); } catch (_e) { /* storage blocked */ }
        location.reload();
      });
      wrap.appendChild(button);
    }
    document.body.appendChild(wrap);
  }

  if (lang === 'en') {
    document.addEventListener('DOMContentLoaded', renderToggle);
    return;
  }

  let dict = {};
  const applied = new WeakMap(); // text node -> value we wrote (to ignore our own mutations)
  const pending = new Set();
  let flushTimer = null;
  let queue = new Set();
  let scheduled = false;

  function translatable(text) {
    const t = text.trim();
    if (t.length < 2 || t.length > MAX_TEXT || !/[A-Za-z]{2}/.test(t)) return false;
    if (/:\/\/|^[\w.-]+@[\w.-]+$/.test(t)) return false;           // URLs, emails
    if (/^[a-z0-9_.:/-]+$/.test(t)) return false;                    // ids, slugs, file names, model ids
    return true;
  }

  function skipped(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (SKIP_TAGS.has(node.tagName) || node.isContentEditable || node.hasAttribute('data-no-i18n')) return true;
    }
    return false;
  }

  function translateTextNode(node) {
    const value = node.nodeValue;
    if (applied.get(node) === value || !translatable(value) || skipped(node.parentElement)) return;
    const core = value.trim();
    const hit = dict[core];
    if (hit === undefined) { want(core); return; }
    const next = value.replace(core, hit);
    applied.set(node, next);
    node.nodeValue = next;
  }

  function translateAttrs(el) {
    if (skipped(el)) return;
    for (const attr of ATTRS) {
      const value = el.getAttribute(attr);
      if (!value || !translatable(value)) continue;
      const core = value.trim();
      if (el.getAttribute('data-i18n-' + attr) === core) continue; // already ours
      const hit = dict[core];
      if (hit === undefined) { want(core); continue; }
      el.setAttribute('data-i18n-' + attr, hit);
      el.setAttribute(attr, hit);
    }
  }

  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) return translateTextNode(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    translateAttrs(root);
    const tree = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = tree.nextNode(); node; node = tree.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
      else translateAttrs(node);
    }
  }

  function want(text) {
    pending.add(text);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 400);
  }

  async function flush() {
    const texts = [...pending];
    pending.clear();
    let key = '';
    try { key = localStorage.getItem('yaa_api_key') || ''; } catch (_e) { /* storage blocked */ }
    // Chunk to the server limits (100 texts / 30k chars per request).
    const chunks = [];
    let chunk = [], size = 0;
    for (const text of texts) {
      if (chunk.length === 100 || size + text.length > 30000) { chunks.push(chunk); chunk = []; size = 0; }
      chunk.push(text); size += text.length;
    }
    if (chunk.length) chunks.push(chunk);
    let gotAny = false;
    for (const part of chunks) {
      try {
        const response = await fetch('/api/i18n/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
          body: JSON.stringify({ lang, texts: part })
        });
        if (!response.ok) continue;
        const data = await response.json();
        Object.assign(dict, data.translations || {});
        gotAny = true;
      } catch (_e) { /* offline: keep English */ }
    }
    if (gotAny) walk(document.body);
  }

  function schedule(node) {
    queue.add(node);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const nodes = queue;
      queue = new Set();
      scheduled = false;
      nodes.forEach(n => { if (n.isConnected) walk(n); });
    });
  }

  async function start() {
    try {
      const response = await fetch('/i18n/' + lang + '.json', { cache: 'no-cache' });
      if (response.ok) dict = await response.json();
    } catch (_e) { /* no dictionary yet */ }
    renderToggle();
    if (dict[document.title]) document.title = dict[document.title];
    walk(document.body);
    new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'childList') m.addedNodes.forEach(schedule);
        else if (m.type === 'characterData') schedule(m.target);
        else if (m.type === 'attributes') schedule(m.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
