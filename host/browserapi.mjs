// Programmable browser API for the `run` tool — a Playwright-shaped page/locator engine that the
// model scripts in a single call (compose many ops, one MCP round trip), mirroring Codex's REPL.
//
// Design: everything runs in the HOST (Node can eval the model's script; the MV3 SW can't). The
// page/locator methods drive the tab through the extension's raw-CDP passthrough (`executeCdp`).
// An injected in-page ENGINE resolves semantic locators (role/text/label/placeholder/testid/css),
// pierces same-origin iframes AND shadow roots, computes top-viewport coordinates, and performs
// in-page mutations. The host does real trusted Input dispatch + auto-waiting, and routes to
// cross-origin (OOPIF) frame sessions for full-page coverage.

// ============================ in-page engine (string, injected via Runtime.evaluate) ============================
// Exposes window.__cbb(op, arg). Stateless per call (re-resolves each time, like Playwright), so it
// survives DOM churn and navigations; re-installs itself if the page replaced window.
const ENGINE = `
if (!window.__cbb) {
  const M = (s, matcher, exact) => {
    s = (s == null ? '' : String(s)).replace(/\\s+/g, ' ').trim();
    if (matcher && matcher.__re) { try { return new RegExp(matcher.source, matcher.flags).test(s); } catch { return false; } }
    const t = String(matcher == null ? '' : matcher).replace(/\\s+/g, ' ').trim();
    return exact ? s === t : s.toLowerCase().includes(t.toLowerCase());
  };
  const IMPLICIT = {
    a: (e) => e.hasAttribute('href') ? 'link' : null, button: () => 'button', nav: () => 'navigation',
    h1: () => 'heading', h2: () => 'heading', h3: () => 'heading', h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
    img: (e) => (e.getAttribute('alt') === '' ? 'presentation' : 'img'), ul: () => 'list', ol: () => 'list', li: () => 'listitem',
    table: () => 'table', tr: () => 'row', td: () => 'cell', th: () => 'columnheader', thead: () => null, form: () => 'form',
    select: () => 'combobox', option: () => 'option', textarea: () => 'textbox', article: () => 'article', main: () => 'main',
    dialog: () => 'dialog', summary: () => 'button', progress: () => 'progressbar', output: () => 'status',
    input: (e) => { const t = (e.getAttribute('type') || 'text').toLowerCase();
      return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button', image: 'button',
        search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox', password: 'textbox' })[t] || (t === 'hidden' ? null : 'textbox'); },
  };
  const roleOf = (e) => { const r = e.getAttribute && e.getAttribute('role'); if (r) return r.trim().split(/\\s+/)[0]; const f = IMPLICIT[e.tagName ? e.tagName.toLowerCase() : '']; return f ? f(e) : null; };
  const labelForm = (e) => { // <label> associated with a control
    let n = ''; if (e.labels) for (const l of e.labels) n += ' ' + (l.textContent || '');
    return n.trim();
  };
  const accName = (e) => {
    const al = e.getAttribute && e.getAttribute('aria-label'); if (al) return al.trim();
    const lb = e.getAttribute && e.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\\s+/).map((id) => { const x = e.ownerDocument.getElementById(id); return x ? x.textContent : ''; }).join(' ').trim(); if (t) return t; }
    const tag = e.tagName ? e.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') { const l = labelForm(e); if (l) return l; const ph = e.getAttribute('placeholder'); if (ph) return ph.trim(); const ti = e.getAttribute('title'); if (ti) return ti.trim(); }
    if (tag === 'img') { const a = e.getAttribute('alt'); if (a) return a.trim(); }
    const txt = (e.textContent || '').replace(/\\s+/g, ' ').trim(); if (txt) return txt;
    const ti = e.getAttribute && e.getAttribute('title'); return ti ? ti.trim() : '';
  };
  const isVisible = (e) => {
    if (!e || !e.getClientRects) return false;
    if (e.getClientRects().length === 0) return false;
    const s = (e.ownerDocument.defaultView || window).getComputedStyle(e);
    if (!s || s.visibility === 'hidden' || s.visibility === 'collapse' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  };
  const isEnabled = (e) => !(e.disabled || e.getAttribute && (e.getAttribute('aria-disabled') === 'true'));
  const isChecked = (e) => { if (typeof e.checked === 'boolean') return e.checked; const a = e.getAttribute && e.getAttribute('aria-checked'); return a === 'true'; };
  const isEditable = (e) => (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable) && isEnabled(e) && !e.readOnly;
  // top-viewport box: getBoundingClientRect is frame-local; add each same-origin ancestor iframe's origin
  const topBox = (e) => {
    let r = e.getBoundingClientRect(); let x = r.left, y = r.top; const w = r.width, h = r.height;
    let win = e.ownerDocument.defaultView;
    while (win && win.frameElement && win !== win.parent) { const fr = win.frameElement.getBoundingClientRect(); const cs = (win.parent).getComputedStyle(win.frameElement); const bl = parseFloat(cs.borderLeftWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0, pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0; x += fr.left + bl + pl; y += fr.top + bt + pt; win = win.parent; }
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  };
  // enumerate elements under a root, piercing same-origin iframes + shadow roots
  const deep = (root, out) => {
    if (!root) return out; let list;
    try { list = root.querySelectorAll('*'); } catch { return out; }
    for (const el of list) { out.push(el);
      if (el.shadowRoot) deep(el.shadowRoot, out);
      if (el.tagName === 'IFRAME') { let d = null; try { d = el.contentDocument; } catch {} if (d) deep(d, out); }
    }
    return out;
  };
  const universe = (scope) => { const out = []; if (scope.nodeType === 9 || scope.shadowRoot === undefined && scope.querySelectorAll) { /*document or element*/ } deep(scope.documentElement ? scope : scope, out); return out; };
  const queryStep = (scopes, step) => {
    let out = [];
    for (const scope of scopes) {
      const all = universe(scope);
      if (step.by === 'css') { try { const found = []; const collect = (r) => { for (const e of r.querySelectorAll(step.selector)) found.push(e); for (const e of r.querySelectorAll('*')) { if (e.shadowRoot) collect(e.shadowRoot); if (e.tagName === 'IFRAME') { let d = null; try { d = e.contentDocument; } catch {} if (d) collect(d); } } }; collect(scope.documentElement ? scope : scope); out.push(...found); } catch {} continue; }
      for (const e of all) {
        if (step.by === 'role') { if (roleOf(e) !== step.role) continue; if (step.name != null && !M(accName(e), step.name, step.exact)) continue; out.push(e); }
        else if (step.by === 'text') { if (M(e.textContent, step.text, step.exact)) out.push(e); }
        else if (step.by === 'label') { const l = labelForm(e); const ar = e.getAttribute && e.getAttribute('aria-label'); if ((l && M(l, step.text, step.exact)) || (ar && M(ar, step.text, step.exact))) out.push(e); }
        else if (step.by === 'placeholder') { const ph = e.getAttribute && e.getAttribute('placeholder'); if (ph && M(ph, step.text, step.exact)) out.push(e); }
        else if (step.by === 'testid') { const t = e.getAttribute && (e.getAttribute('data-testid') || e.getAttribute('data-test-id') || e.getAttribute('data-test')); if (t === step.testId) out.push(e); }
      }
    }
    let res = [...new Set(out)];
    // text matching is ancestor-inclusive (textContent bubbles up); keep only the deepest matches,
    // like Playwright's getByText — drop any element that contains another match.
    if (step.by === 'text') res = res.filter((e) => !res.some((o) => o !== e && e.contains && e.contains(o)));
    return res;
  };
  const resolve = (steps) => {
    let scopes = [document];
    for (const step of steps) {
      if (step.op === 'nth') { scopes = scopes[step.n < 0 ? scopes.length + step.n : step.n] ? [scopes[step.n < 0 ? scopes.length + step.n : step.n]] : []; }
      else if (step.op === 'first') scopes = scopes.slice(0, 1);
      else if (step.op === 'last') scopes = scopes.slice(-1);
      else if (step.op === 'filter') { scopes = scopes.filter((s) => { if (step.hasText != null && !M(s.textContent, step.hasText, false)) return false; if (step.hasNotText != null && M(s.textContent, step.hasNotText, false)) return false; return true; }); }
      else scopes = queryStep(scopes, step);
    }
    return scopes;
  };
  const meta = (e) => ({ box: topBox(e), vis: isVisible(e), en: isEnabled(e), checked: isChecked(e), role: roleOf(e), name: accName(e).slice(0, 200), tag: (e.tagName || '').toLowerCase(), val: 'value' in e ? String(e.value).slice(0, 200) : undefined });
  const nativeSet = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, v); else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };

  window.__cbb = (op, a) => {
    a = a || {};
    if (op === 'q') { const els = resolve(a.steps); return { count: els.length, matches: els.slice(0, a.cap || 200).map((e, i) => ({ i, ...meta(e) })) }; }
    const els = a.steps ? resolve(a.steps) : [];
    const el = els[a.i || 0];
    if (op === 'text') { if (!el) return null; return a.kind === 'inner' ? (el.innerText != null ? el.innerText : el.textContent) : a.kind === 'value' ? ('value' in el ? String(el.value) : null) : a.kind === 'attr' ? el.getAttribute(a.name) : (el.textContent == null ? null : el.textContent); }
    if (op === 'bool') { if (!el) return false; return a.q === 'visible' ? isVisible(el) : a.q === 'enabled' ? isEnabled(el) : a.q === 'checked' ? isChecked(el) : a.q === 'editable' ? isEditable(el) : false; }
    if (op === 'fill') { if (!el) return { ok: false, err: 'not found' }; el.focus && el.focus(); if (el.isContentEditable) { el.textContent = a.value; el.dispatchEvent(new Event('input', { bubbles: true })); } else nativeSet(el, a.value); return { ok: true }; }
    if (op === 'select') { if (!el || el.tagName !== 'SELECT') return { ok: false, err: 'not a <select>' }; const want = a.values; let sel = []; for (const o of el.options) { const hit = want.some((w) => (w.value != null && o.value === w.value) || (w.label != null && (o.label || o.text) === w.label) || (w.index != null && o.index === w.index) || (typeof w === 'string' && (o.value === w || o.label === w || o.text === w))); o.selected = hit; if (hit) sel.push(o.value); } el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: sel.length > 0, selected: sel }; }
    if (op === 'focus') { if (!el) return { ok: false }; el.focus && el.focus(); return { ok: true }; }
    if (op === 'scroll') { if (!el) return { ok: false }; if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' }); return { ok: true, box: topBox(el) }; }
    if (op === 'checkstate') { if (!el) return null; return { box: topBox(el), checked: isChecked(el), vis: isVisible(el), en: isEnabled(el) }; }
    if (op === 'snapshot') {
      const root = a.selector ? document.querySelector(a.selector) : document; if (!root) return '(selector matched nothing)';
      const INT = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'tab', 'option', 'listbox', 'heading']);
      const lines = []; const seen = new Set(); let ref = 0;
      for (const e of universe(root.documentElement ? root : root)) { if (!isVisible(e)) continue; const r = roleOf(e); const nm = accName(e).replace(/\\s+/g, ' ').trim(); if (!r || (!INT.has(r) && !nm)) continue; if (r === 'generic' || r === 'none' || r === 'presentation') continue; const key = r + '\\u0000' + nm; const line = '[' + (++ref) + '] ' + r + (nm ? ' "' + nm.slice(0, 160) + '"' : '') + ('value' in e && e.value ? ' =' + String(e.value).slice(0, 80) : ''); lines.push(line); if (lines.join('\\n').length > (a.max || 20000)) { lines.push('… (truncated)'); break; } }
      return lines.join('\\n');
    }
    if (op === 'vdom') {
      const INT = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'tab', 'option']);
      const out = []; let id = 0;
      for (const e of universe(document)) { const r = roleOf(e); if (!r || !INT.has(r)) continue; if (!isVisible(e)) continue; out.push({ node_id: String(++id), role: r, name: accName(e).slice(0, 160), tag: (e.tagName || '').toLowerCase(), box: topBox(e), val: 'value' in e ? String(e.value).slice(0, 80) : undefined }); if (out.length >= (a.cap || 300)) break; }
      return out;
    }
    if (op === 'vact') { // dom_cua act by node_id: re-derive vdom ordering, act on the node
      const INT = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'tab', 'option']);
      let id = 0, target = null; for (const e of universe(document)) { const r = roleOf(e); if (!r || !INT.has(r) || !isVisible(e)) continue; if (String(++id) === String(a.node_id)) { target = e; break; } }
      if (!target) return { ok: false, err: 'node_id not found' };
      if (a.action === 'box') return { ok: true, box: topBox(target) };
      if (a.action === 'type') { target.focus && target.focus(); if (target.isContentEditable) { target.textContent += a.text; } else if ('value' in target) nativeSet(target, (target.value || '') + a.text); target.dispatchEvent(new Event('input', { bubbles: true })); return { ok: true }; }
      return { ok: false };
    }
    return { err: 'unknown op ' + op };
  };
}
`;

const asExpr = (op, arg) => `(()=>{${ENGINE}\nreturn window.__cbb(${JSON.stringify(op)}, ${JSON.stringify(arg)});})()`;

export const _ENGINE = ENGINE; // exported for the jsdom unit test (host/test/engine.test.mjs)

// ============================ host driver ============================
const KEY = { Enter: { key: 'Enter', code: 'Enter', kc: 13 }, Tab: { key: 'Tab', code: 'Tab', kc: 9 }, Escape: { key: 'Escape', code: 'Escape', kc: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', kc: 8 }, Delete: { key: 'Delete', code: 'Delete', kc: 46 }, ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', kc: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', kc: 40 }, ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', kc: 39 }, Home: { key: 'Home', code: 'Home', kc: 36 }, End: { key: 'End', code: 'End', kc: 35 }, PageUp: { key: 'PageUp', code: 'PageUp', kc: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', kc: 34 }, Space: { key: ' ', code: 'Space', kc: 32 } };
const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8, ControlOrMeta: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a driver bound to one tab. `callHost(method, params)` reaches the extension.
export function makeBrowser(callHost, tabId) {
  const cdp = (method, params = {}, sessionId) => callHost('executeCdp', { tabId, cdpMethod: method, cdpParams: params, ...(sessionId ? { sessionId } : {}) });
  const evalIn = async (op, arg, sessionId) => { const r = await cdp('Runtime.evaluate', { expression: asExpr(op, arg), returnByValue: true, awaitPromise: true }, sessionId); if (r && r.exceptionDetails) throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r && r.result ? r.result.value : undefined; };

  let framesCache = null, framesCacheAt = 0;
  const frameSessions = async () => { const now = Date.now(); if (framesCache && now - framesCacheAt < 1500) return framesCache; let fr = { frames: [] }; try { fr = await callHost('listFrames', { tabId }); } catch {} framesCache = fr.frames || []; framesCacheAt = now; return framesCache; };
  const frameOffset = async (sessionId) => { try { return await callHost('frameOffsetOf', { tabId, sessionId }); } catch { return { ox: 0, oy: 0 }; } };

  // Resolve a locator's step-chain across the main session + every cross-origin frame session.
  // Returns a global, ordered list: [{sessionId|null, i (local index), box (top-viewport, OOPIF-translated), ...meta}]
  async function resolveGlobal(steps) {
    const out = [];
    const main = await evalIn('q', { steps, cap: 500 });
    for (const m of main.matches || []) out.push({ sessionId: null, ...m });
    const frames = await frameSessions();
    for (const f of frames) {
      let res; try { res = await evalIn('q', { steps, cap: 500 }, f.sessionId); } catch { continue; }
      if (!res || !res.matches || !res.matches.length) continue;
      const off = await frameOffset(f.sessionId);
      for (const m of res.matches) out.push({ sessionId: f.sessionId, ...m, box: { ...m.box, x: m.box.x + off.ox, y: m.box.y + off.oy, cx: m.box.cx + off.ox, cy: m.box.cy + off.oy } });
    }
    return out;
  }

  const mouse = async (type, x, y, opts = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: opts.button || 'left', clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 });

  class Locator {
    constructor(steps) { this.steps = steps; }
    _child(step) { return new Locator([...this.steps, step]); }
    getByRole(role, o = {}) { return this._child({ by: 'role', role, name: o.name, exact: o.exact }); }
    getByText(text, o = {}) { return this._child({ by: 'text', text, exact: o.exact }); }
    getByLabel(text, o = {}) { return this._child({ by: 'label', text, exact: o.exact }); }
    getByPlaceholder(text, o = {}) { return this._child({ by: 'placeholder', text, exact: o.exact }); }
    getByTestId(testId) { return this._child({ by: 'testid', testId }); }
    locator(selector) { return this._child({ by: 'css', selector }); }
    filter(o = {}) { return this._child({ op: 'filter', hasText: o.hasText, hasNotText: o.hasNotText }); }
    nth(n) { return this._child({ op: 'nth', n }); }
    first() { return this._child({ op: 'first' }); }
    last() { return this._child({ op: 'last' }); }
    // terminal reads
    async count() { return (await resolveGlobal(this.steps)).length; }
    async all() { const g = await resolveGlobal(this.steps); return g.map((_, i) => this.nth(i)); }
    async _one(actionable, timeoutMs = 15000) {
      const deadline = Date.now() + Math.min(timeoutMs, 60000);
      let last = null;
      while (Date.now() < deadline) {
        const g = await resolveGlobal(this.steps);
        if (g.length === 1 || (g.length > 1 && this._picked != null)) { const t = g.length === 1 ? g[0] : g[this._picked]; if (!actionable || (t.vis && t.en)) return t; last = t; }
        else if (g.length > 1) throw new Error(`strict mode: ${g.length} elements match — add .first()/.nth()/.filter()`);
        await sleep(120);
      }
      if (last) throw new Error('element not actionable in time (visible/enabled)');
      throw new Error('locator matched no element in time');
    }
    async waitFor(o = {}) { const state = o.state || 'visible'; const deadline = Date.now() + Math.min(o.timeoutMs || 15000, 60000); while (Date.now() < deadline) { const g = await resolveGlobal(this.steps); const t = g[0]; const ok = state === 'attached' ? !!t : state === 'detached' ? !t : state === 'visible' ? (t && t.vis) : state === 'hidden' ? (!t || !t.vis) : !!t; if (ok) return; await sleep(120); } throw new Error('waitFor(' + state + ') timed out'); }
    async textContent(o = {}) { const t = await this._one(false, o.timeoutMs); return evalIn('text', { steps: this.steps, i: t.i, kind: 'text' }, t.sessionId); }
    async innerText(o = {}) { const t = await this._one(false, o.timeoutMs); return evalIn('text', { steps: this.steps, i: t.i, kind: 'inner' }, t.sessionId); }
    async inputValue(o = {}) { const t = await this._one(false, o.timeoutMs); return evalIn('text', { steps: this.steps, i: t.i, kind: 'value' }, t.sessionId); }
    async getAttribute(name, o = {}) { const t = await this._one(false, o.timeoutMs); return evalIn('text', { steps: this.steps, i: t.i, kind: 'attr', name }, t.sessionId); }
    async allTextContents() { const g = await resolveGlobal(this.steps); return Promise.all(g.map((t) => evalIn('text', { steps: this.steps, i: t.i, kind: 'text' }, t.sessionId))); }
    async isVisible() { const g = await resolveGlobal(this.steps); return !!(g[0] && g[0].vis); }
    async isEnabled() { const g = await resolveGlobal(this.steps); return !!(g[0] && g[0].en); }
    async isChecked() { const g = await resolveGlobal(this.steps); return !!(g[0] && g[0].checked); }
    async boundingBox(o = {}) { const t = await this._one(false, o.timeoutMs); return { x: t.box.x, y: t.box.y, width: t.box.w, height: t.box.h }; }
    async scrollIntoViewIfNeeded(o = {}) { const t = await this._one(false, o.timeoutMs); await evalIn('scroll', { steps: this.steps, i: t.i }, t.sessionId); }
    // terminal actions (real events / in-page mutation with auto-wait)
    async click(o = {}) { const t = await this._one(true, o.timeoutMs); await evalIn('scroll', { steps: this.steps, i: t.i }, t.sessionId); const b = (await this._one(true, 2000)).box; const mods = (o.modifiers || []).reduce((m, k) => m | (MOD[k] || 0), 0); const button = o.button || 'left'; const clicks = o.clickCount || (o._double ? 2 : 1); await mouse('mouseMoved', b.cx, b.cy); for (let c = 1; c <= clicks; c++) { await mouse('mousePressed', b.cx, b.cy, { button, clickCount: c, modifiers: mods }); await mouse('mouseReleased', b.cx, b.cy, { button, clickCount: c, modifiers: mods }); } }
    async dblclick(o = {}) { return this.click({ ...o, _double: true }); }
    async hover(o = {}) { const t = await this._one(true, o.timeoutMs); await evalIn('scroll', { steps: this.steps, i: t.i }, t.sessionId); const b = (await this._one(true, 2000)).box; await mouse('mouseMoved', b.cx, b.cy); }
    async fill(value, o = {}) { const t = await this._one(true, o.timeoutMs); const r = await evalIn('fill', { steps: this.steps, i: t.i, value: String(value) }, t.sessionId); if (!r || !r.ok) throw new Error('fill failed: ' + (r && r.err)); }
    async type(value, o = {}) { const t = await this._one(true, o.timeoutMs); await evalIn('focus', { steps: this.steps, i: t.i }, t.sessionId); await cdp('Input.insertText', { text: String(value) }, t.sessionId); }
    async press(keyChord, o = {}) { const t = await this._one(true, o.timeoutMs); await evalIn('focus', { steps: this.steps, i: t.i }, t.sessionId); await pressChord(cdp, keyChord, t.sessionId); }
    async selectOption(values, o = {}) { const t = await this._one(true, o.timeoutMs); const arr = (Array.isArray(values) ? values : [values]).map((v) => (typeof v === 'string' ? v : v)); const r = await evalIn('select', { steps: this.steps, i: t.i, values: arr }, t.sessionId); if (!r || !r.ok) throw new Error('selectOption failed: ' + (r && r.err)); return r.selected; }
    async check(o = {}) { const t = await this._one(true, o.timeoutMs); const s = await evalIn('checkstate', { steps: this.steps, i: t.i }, t.sessionId); if (s && s.checked) return; await this.click(o); }
    async uncheck(o = {}) { const t = await this._one(true, o.timeoutMs); const s = await evalIn('checkstate', { steps: this.steps, i: t.i }, t.sessionId); if (s && !s.checked) return; await this.click(o); }
    async setChecked(v, o = {}) { return v ? this.check(o) : this.uncheck(o); }
    async focus(o = {}) { const t = await this._one(false, o.timeoutMs); await evalIn('focus', { steps: this.steps, i: t.i }, t.sessionId); }
  }
  // pick() lets nth() resolve a specific global index for actions
  Object.defineProperty(Locator.prototype, '_picked', { get() { for (let k = this.steps.length - 1; k >= 0; k--) { if (this.steps[k].op === 'nth') return this.steps[k].n; if (this.steps[k].op === 'first') return 0; if (this.steps[k].op === 'last') return -1; } return null; }, configurable: true });

  async function pressChord(cdpFn, chord, sessionId) { const parts = String(chord).split('+'); const base = parts.pop(); let mods = 0; for (const m of parts) mods |= (MOD[m] || MOD[m.charAt(0).toUpperCase() + m.slice(1)] || 0); const k = KEY[base] || (base.length === 1 ? { key: base, code: 'Key' + base.toUpperCase(), kc: base.toUpperCase().charCodeAt(0) } : { key: base, code: base, kc: 0 }); const printable = base.length === 1 && !(mods & (1 | 2 | 4)); await cdpFn('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.kc, ...(printable ? { text: base } : {}) }, sessionId); await cdpFn('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, key: k.key, code: k.code, windowsVirtualKeyCode: k.kc }, sessionId); }

  const rootLoc = (step) => new Locator([step]);
  const dom_cua = {
    async get_visible_dom() { return evalIn('vdom', { cap: 400 }); },
    async click({ node_id }) { const r = await evalIn('vact', { node_id, action: 'box' }); if (!r || !r.ok) throw new Error('dom_cua.click: ' + (r && r.err)); await mouse('mouseMoved', r.box.cx, r.box.cy); await mouse('mousePressed', r.box.cx, r.box.cy); await mouse('mouseReleased', r.box.cx, r.box.cy); },
    async double_click({ node_id }) { const r = await evalIn('vact', { node_id, action: 'box' }); await mouse('mouseMoved', r.box.cx, r.box.cy); for (let c = 1; c <= 2; c++) { await mouse('mousePressed', r.box.cx, r.box.cy, { clickCount: c }); await mouse('mouseReleased', r.box.cx, r.box.cy, { clickCount: c }); } },
    async type({ text }) { await cdp('Input.insertText', { text: String(text) }); },
    async keypress({ keys }) { for (const k of (Array.isArray(keys) ? keys : [keys])) await pressChord(cdp, k); },
    async scroll({ node_id, x = 0, y = 300 }) { let cx = 200, cy = 300; if (node_id) { const r = await evalIn('vact', { node_id, action: 'box' }); if (r && r.ok) { cx = r.box.cx; cy = r.box.cy; } } await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: x, deltaY: y }); },
  };

  const page = {
    getByRole: (role, o) => rootLoc({ by: 'role', role, name: (o || {}).name, exact: (o || {}).exact }),
    getByText: (text, o) => rootLoc({ by: 'text', text, exact: (o || {}).exact }),
    getByLabel: (text, o) => rootLoc({ by: 'label', text, exact: (o || {}).exact }),
    getByPlaceholder: (text, o) => rootLoc({ by: 'placeholder', text, exact: (o || {}).exact }),
    getByTestId: (testId) => rootLoc({ by: 'testid', testId }),
    locator: (selector) => rootLoc({ by: 'css', selector }),
    frameLocator: (frameSelector) => rootLoc({ by: 'css', selector: frameSelector + ' ' }), // same-origin frames are pierced automatically; scope by the iframe's ancestor
    async evaluate(fn, arg) { const expr = typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(arg ?? null)})` : String(fn); const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r && r.exceptionDetails) throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r && r.result ? r.result.value : undefined; },
    async goto(url, o = {}) { const cur = await this.url(); await cdp('Page.navigate', { url }); if ((o.waitUntil || 'load') !== 'commit') await this.waitForLoadState({ state: o.waitUntil || 'load', timeoutMs: o.timeoutMs }); return null; },
    async url() { try { const r = await cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true }); return r.result.value; } catch { return null; } },
    async title() { const r = await cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true }); return r.result.value; },
    async reload(o = {}) { await cdp('Page.reload', {}); await this.waitForLoadState({ state: o.waitUntil || 'load', timeoutMs: o.timeoutMs }); },
    async goBack() { await this.evaluate(() => history.back()); await sleep(300); },
    async goForward() { await this.evaluate(() => history.forward()); await sleep(300); },
    async bringToFront() { await callHost('activateTab', { tabId }); },
    async waitForTimeout(ms) { await sleep(Math.min(ms, 30000)); },
    async waitForLoadState(o = {}) { const state = o.state || 'load'; const deadline = Date.now() + Math.min(o.timeoutMs || 15000, 60000); while (Date.now() < deadline) { const r = await cdp('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => ({})); const rs = r && r.result && r.result.value; if (state === 'domcontentloaded' && (rs === 'interactive' || rs === 'complete')) return; if ((state === 'load' || state === 'networkidle') && rs === 'complete') { if (state === 'load') return; await sleep(500); return; } await sleep(120); } },
    async waitForURL(pattern, o = {}) { const deadline = Date.now() + Math.min((o && o.timeoutMs) || 15000, 60000); const re = pattern instanceof RegExp ? pattern : null; while (Date.now() < deadline) { const u = await this.url(); if (u && (re ? re.test(u) : u.includes(pattern))) return; await sleep(150); } throw new Error('waitForURL timed out: ' + pattern); },
    async expectNavigation(action, o = {}) { const before = await this.url(); const r = await action(); const deadline = Date.now() + Math.min(o.timeoutMs || 15000, 60000); while (Date.now() < deadline) { const u = await this.url(); if (u !== before && (!o.url || (o.url instanceof RegExp ? o.url.test(u) : u.includes(o.url)))) { await this.waitForLoadState({ state: o.waitUntil || 'load', timeoutMs: 5000 }); return r; } await sleep(150); } return r; },
    async domSnapshot(o = {}) { return evalIn('snapshot', { selector: o && o.selector, max: (o && o.max) || 20000 }); },
    async snapshot(o) { return this.domSnapshot(o); },
    async screenshot(o = {}) { const params = { format: 'png' }; if (o.fullPage) { params.captureBeyondViewport = true; const m = await cdp('Page.getLayoutMetrics').catch(() => ({})); const cs = m.cssContentSize || m.contentSize; if (cs) params.clip = { x: 0, y: 0, width: cs.width, height: cs.height, scale: 1 }; } if (o.clip) params.clip = { ...o.clip, scale: 1 }; const r = await cdp('Page.captureScreenshot', params); return { __image: r.data, mimeType: 'image/png' }; },
    async getJsDialog() { return null; },
    dom_cua,
    cua: dom_cua,
    capabilities: { async list() { return ['viewport', 'screenshot', 'domSnapshot']; }, async get() { return null; } },
    async close() { await callHost('closeAgentTab', { tabId }).catch(() => callHost('release', { tabId })); },
  };

  const browser = {
    async openTabs() { const r = await callHost('getUserTabs', {}); return (r.tabs || []).map((t) => ({ id: String(t.id), title: t.title, url: t.url, tabGroup: t.tabGroup, lastOpened: t.lastAccessed })); },
    async claimTab(t) { const id = typeof t === 'string' ? Number(t) : Number(t.id); await callHost('claimTab', { tabId: id }); return makeBrowser(callHost, id).page; },
    async newTab(url) { const r = await callHost('createTab', { url: url || 'about:blank' }); return makeBrowser(callHost, r.id).page; },
    async nameSession() { /* no-op: our tabs aren't session-scoped */ },
    documentation: async () => 'See the /browser skill.',
  };
  page.browser = browser;
  return { page, browser, cdp, evalIn };
}

// Run a model-authored script with page/browser/tab/console injected. Returns { result, logs }.
export async function runScript({ callHost, tabId, script, timeoutMs = 60000 }) {
  const { page, browser } = makeBrowser(callHost, tabId);
  const logs = [];
  const log = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  const console = { log, info: log, warn: log, error: log };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('page', 'tab', 'browser', 'console', 'log', 'sleep', `"use strict";\n${script}`);
  let result, error;
  const run = (async () => { try { result = await fn(page, page, browser, console, log, sleep); } catch (e) { error = e; } })();
  let timer; const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('run: script exceeded ' + timeoutMs + 'ms')), timeoutMs); });
  try { await Promise.race([run, guard]); } finally { clearTimeout(timer); }
  if (error) throw new Error(error && error.message ? error.message : String(error));
  return { result: result === undefined ? null : result, logs };
}
