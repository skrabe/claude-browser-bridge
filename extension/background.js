// Claude Browser Bridge — extension service worker (v0.3.0).
// A generic CDP proxy + tab manager. The native host sends {id, method, params};
// we execute via chrome.debugger / chrome.tabs and reply {id, result|error}.
// chrome.debugger events are buffered per-tab (console/network) and streamed as onCDPEvent.

const HOST = 'com.claude.browserbridge';
const VERSION = '0.3.3';
let port = null;

// per controlled tab: { refs: Map<ref, backendNodeId>, seq, console: [], network: Map<reqId,obj>, domains: Set }
const state = new Map();
function st(tabId) {
  let s = state.get(tabId);
  if (!s) { s = { refs: new Map(), seq: 0, console: [], network: new Map(), domains: new Set() }; state.set(tabId, s); }
  return s;
}

function connect() {
  if (port) return; // one native-messaging connection only — never spawn a second host
  try { port = chrome.runtime.connectNative(HOST); }
  catch { port = null; setTimeout(connect, 2000); return; }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    for (const tabId of [...state.keys()]) detach(tabId).catch(() => {});
    setTimeout(connect, 1000);
  });
}
connect();

// Self-heal: MV3 service workers go dormant, so a failed/dropped native-messaging port can get
// stuck. Reconnect on startup/install and via a periodic alarm that wakes the worker.
try { chrome.runtime.onStartup.addListener(() => connect()); } catch {}
try { chrome.runtime.onInstalled.addListener(() => connect()); } catch {}
try {
  chrome.alarms.create('cbb-reconnect', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'cbb-reconnect' && !port) connect(); });
} catch {}

function reply(id, result, error) {
  if (!port || id === undefined) return;
  port.postMessage(error ? { id, error: String(error && error.message || error) } : { id, result });
}
async function onMessage(m) {
  if (m && m.keepalive !== undefined) return; // host heartbeat — just keeps this worker alive
  const { id, method, params } = m || {};
  try { reply(id, await handle(method, params || {})); }
  catch (e) { reply(id, undefined, e); }
}

// ---- low-level CDP ----
function cmd(tabId, method, params = {}) {
  return new Promise((res, rej) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
      else res(result);
    });
  });
}
function attach(tabId) {
  const s = st(tabId);
  if (s.attached) return Promise.resolve();
  if (s.attaching) return s.attaching; // dedupe concurrent attaches (parallel tool calls on a cold tab)
  s.attaching = new Promise((res, rej) => {
    chrome.debugger.attach({ tabId }, '1.3', async () => {
      s.attaching = null;
      if (chrome.runtime.lastError) {
        // a racing attach already won — treat as attached, not an error
        if (s.attached || /already attached/i.test(chrome.runtime.lastError.message)) { s.attached = true; return res(); }
        return rej(new Error(chrome.runtime.lastError.message));
      }
      s.attached = true;
      try {
        for (const d of ['Page', 'DOM', 'Runtime', 'Accessibility', 'Network', 'Log']) {
          await cmd(tabId, d + '.enable').catch(() => {});
        }
      } catch {}
      res();
    });
  });
  return s.attaching;
}
function detach(tabId) {
  return new Promise((res) => {
    if (!state.get(tabId)?.attached) { state.delete(tabId); return res(); }
    chrome.debugger.detach({ tabId }, () => { state.delete(tabId); res(); });
  });
}
async function need(tabId) { if (!state.get(tabId)?.attached) await attach(tabId); }

// ---- ref resolution ----
async function boxCenter(tabId, backendNodeId) {
  await cmd(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
  const { model } = await cmd(tabId, 'DOM.getBoxModel', { backendNodeId });
  const q = model.content; // [x1,y1,x2,y2,x3,y3,x4,y4]
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}
async function objectFor(tabId, backendNodeId) {
  const { object } = await cmd(tabId, 'DOM.resolveNode', { backendNodeId });
  return object.objectId;
}
function refBackend(tabId, ref) {
  const b = st(tabId).refs.get(ref);
  if (b == null) throw new Error(`unknown ref "${ref}" — take a fresh read_page/dom_query`);
  return b;
}

// ---- key map for press_key ----
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox',
  'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'listbox', 'textarea', 'colorwell', 'date', 'datetime']);

// ---- method dispatch ----
async function handle(method, p) {
  switch (method) {
    case 'getInfo': return { name: 'ClaudeBrowserBridge', version: VERSION, cdp: '1.3' };

    case 'getUserTabs': {
      const list = await chrome.tabs.query({});
      const out = [];
      for (const t of list) {
        if (t.id == null) continue;
        let group = null;
        if (t.groupId != null && t.groupId !== -1) {
          try { group = (await chrome.tabGroups.get(t.groupId)).title || null; } catch {}
        }
        out.push({ id: t.id, title: t.title, url: t.url, windowId: t.windowId, active: t.active, lastAccessed: t.lastAccessed, tabGroup: group });
      }
      out.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return { tabs: out };
    }

    case 'claimTab': {
      const tab = await chrome.tabs.get(p.tabId);
      if (tab.url && tab.url.startsWith('chrome://')) throw new Error('cannot claim a chrome:// tab');
      await attach(p.tabId);
      return { id: p.tabId, title: tab.title, url: tab.url, claimed: true };
    }
    case 'createTab': {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.active });
      await attach(tab.id);
      return { id: tab.id, url: tab.url };
    }
    case 'activateTab': { const t = await chrome.tabs.get(p.tabId); await chrome.windows.update(t.windowId, { focused: true }); await chrome.tabs.update(p.tabId, { active: true }); return { ok: true }; }
    case 'reload': { await need(p.tabId); await cmd(p.tabId, 'Page.reload', {}); return { ok: true }; }
    case 'release': { await detach(p.tabId); return { ok: true }; }
    case 'closeTab': { await detach(p.tabId).catch(() => {}); await chrome.tabs.remove(p.tabId); return { ok: true }; }

    case 'navigate': {
      await need(p.tabId);
      const cur = (await chrome.tabs.get(p.tabId)).url;
      if (cur === p.url) return { ok: true, skipped: 'already on url' };
      await cmd(p.tabId, 'Page.navigate', { url: p.url });
      return { ok: true };
    }

    case 'readPage': {
      await need(p.tabId);
      const s = st(p.tabId); s.refs.clear(); // fresh snapshot; seq stays monotonic so stale ids error, never re-alias
      const { nodes } = await cmd(p.tabId, 'Accessibility.getFullAXTree', {});
      const lines = [];
      for (const n of nodes) {
        if (n.ignored) continue;
        const role = n.role?.value; if (!role || role === 'none' || role === 'generic') continue;
        const name = (n.name?.value || '').trim();
        const interactive = INTERACTIVE.has(role);
        if (!interactive && !name) continue;
        let ref = null;
        if (n.backendDOMNodeId != null && (interactive || name)) {
          ref = 'e' + (++s.seq); s.refs.set(ref, n.backendDOMNodeId);
        }
        const val = n.value?.value;
        lines.push({ ref, role, name: name.slice(0, 160), ...(val != null ? { value: String(val).slice(0, 80) } : {}) });
        if (lines.length >= 500) break;
      }
      return { url: (await chrome.tabs.get(p.tabId)).url, count: lines.length, elements: lines };
    }

    case 'readText': {
      await need(p.tabId);
      const r = await cmd(p.tabId, 'Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true });
      return { text: r.result?.value ?? '' };
    }

    case 'domQuery': {
      await need(p.tabId);
      const s = st(p.tabId);
      const limit = Math.min(p.limit || 30, 100);
      const { root } = await cmd(p.tabId, 'DOM.getDocument', { depth: 0 });
      const { nodeIds } = await cmd(p.tabId, 'DOM.querySelectorAll', { nodeId: root.nodeId, selector: p.selector });
      const matches = [];
      for (const nodeId of nodeIds.slice(0, limit)) {
        let desc; try { desc = (await cmd(p.tabId, 'DOM.describeNode', { nodeId })).node; } catch { continue; }
        const backendNodeId = desc.backendNodeId;
        const ref = 'q' + (++s.seq); s.refs.set(ref, backendNodeId);
        const attrs = {}; const a = desc.attributes || [];
        for (let i = 0; i < a.length; i += 2) attrs[a[i]] = a[i + 1];
        matches.push({ ref, tag: (desc.nodeName || '').toLowerCase(), href: attrs.href, id: attrs.id, class: attrs.class });
      }
      return { count: nodeIds.length, returned: matches.length, matches };
    }

    case 'find': {
      // heuristic over the a11y tree: rank interactive nodes by fuzzy match on name/role
      await need(p.tabId);
      const s = st(p.tabId); // append 'f' refs with a monotonic seq — never clobber read_page's 'e' refs
      const { nodes } = await cmd(p.tabId, 'Accessibility.getFullAXTree', {});
      const q = String(p.query || '').toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const n of nodes) {
        if (n.ignored || n.backendDOMNodeId == null) continue;
        const role = n.role?.value || ''; const name = (n.name?.value || '').trim();
        if (!INTERACTIVE.has(role) && !name) continue;
        const hay = (role + ' ' + name).toLowerCase();
        let score = 0; for (const t of terms) if (hay.includes(t)) score += t.length;
        if (name && q.includes(name.toLowerCase())) score += 5;
        if (score <= 0) continue;
        const ref = 'f' + (++s.seq); s.refs.set(ref, n.backendDOMNodeId);
        scored.push({ ref, role, name: name.slice(0, 160), score });
      }
      scored.sort((a, b) => b.score - a.score);
      return { candidates: scored.slice(0, 10).map(({ score, ...c }) => c) };
    }

    case 'click': {
      await need(p.tabId);
      let x = p.x, y = p.y;
      if (p.ref != null) { const c = await boxCenter(p.tabId, refBackend(p.tabId, p.ref)); x = c.x; y = c.y; }
      if (x == null || y == null) throw new Error('click needs a ref or {x,y}');
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return { ok: true };
    }

    case 'fill': {
      await need(p.tabId);
      const objectId = await objectFor(p.tabId, refBackend(p.tabId, p.ref));
      await cmd(p.tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function(v){this.focus&&this.focus();const p=Object.getOwnPropertyDescriptor(this.__proto__,"value");if(p&&p.set)p.set.call(this,v);else this.value=v;this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));}',
        arguments: [{ value: String(p.value ?? '') }],
      });
      return { ok: true };
    }
    case 'typeText': { await need(p.tabId); await cmd(p.tabId, 'Input.insertText', { text: String(p.text ?? '') }); return { ok: true }; }
    case 'pressKey': {
      await need(p.tabId);
      // support modifier chords like "Meta+A", "Ctrl+Shift+K"
      const parts = String(p.key).split('+');
      const base = parts.pop();
      let modifiers = 0;
      for (const m of parts) { const ml = m.toLowerCase(); if (ml === 'alt') modifiers |= 1; else if (ml === 'ctrl' || ml === 'control') modifiers |= 2; else if (ml === 'meta' || ml === 'cmd' || ml === 'command') modifiers |= 4; else if (ml === 'shift') modifiers |= 8; }
      const k = KEYS[base] || (base.length === 1
        ? { key: base, code: 'Key' + base.toUpperCase(), windowsVirtualKeyCode: base.toUpperCase().charCodeAt(0) }
        : { key: base, code: base, windowsVirtualKeyCode: 0 });
      await cmd(p.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...k });
      await cmd(p.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
      return { ok: true };
    }
    case 'scroll': {
      await need(p.tabId);
      if (p.ref != null) { const b = refBackend(p.tabId, p.ref); await cmd(p.tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: b }); return { ok: true }; }
      const x = p.x ?? 100, y = p.y ?? 100;
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: p.dx || 0, deltaY: p.dy || 300 });
      return { ok: true };
    }
    case 'selectOption': {
      await need(p.tabId);
      const objectId = await objectFor(p.tabId, refBackend(p.tabId, p.ref));
      const r = await cmd(p.tabId, 'Runtime.callFunctionOn', {
        objectId,
        // match by option value OR visible label/text (doctrine advertises both)
        functionDeclaration: 'function(v){const o=[...(this.options||[])];const m=o.find(x=>x.value===v)||o.find(x=>(x.label||x.text||x.textContent||"").trim()===v);this.value=m?m.value:v;this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));return !!m;}',
        arguments: [{ value: String(p.value ?? '') }],
        returnByValue: true,
      });
      return { ok: true, matched: !!r?.result?.value };
    }
    case 'drag': {
      await need(p.tabId);
      const from = p.fromRef != null ? await boxCenter(p.tabId, refBackend(p.tabId, p.fromRef)) : { x: p.fromX, y: p.fromY };
      const to = p.toRef != null ? await boxCenter(p.tabId, refBackend(p.tabId, p.toRef)) : { x: p.toX, y: p.toY };
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left' });
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      return { ok: true };
    }

    case 'screenshot': { await need(p.tabId); const r = await cmd(p.tabId, 'Page.captureScreenshot', { format: 'png' }); return { __image: r.data, mimeType: 'image/png' }; }

    case 'readConsole': { const s = st(p.tabId); const out = s.console.slice(-(p.limit || 50)); if (p.clear) s.console = []; return { messages: out }; }
    case 'readNetwork': { const s = st(p.tabId); const out = [...s.network.values()].slice(-(p.limit || 50)); if (p.clear) s.network.clear(); return { requests: out }; }

    case 'executeCdp': { await need(p.tabId); return await cmd(p.tabId, p.cdpMethod, p.cdpParams || {}); }

    default: throw new Error('unknown method: ' + method);
  }
}

// ---- event buffering ----
chrome.debugger.onEvent.addListener((source, cdpMethod, cdpParams) => {
  const tabId = source.tabId; if (tabId == null) return;
  const s = state.get(tabId); if (!s) return;
  if (cdpMethod === 'Runtime.consoleAPICalled') {
    s.console.push({ level: cdpParams.type, text: (cdpParams.args || []).map(a => a.value ?? a.description ?? '').join(' '), ts: cdpParams.timestamp });
    if (s.console.length > 500) s.console.shift();
  } else if (cdpMethod === 'Runtime.exceptionThrown') {
    s.console.push({ level: 'error', text: cdpParams.exceptionDetails?.exception?.description || cdpParams.exceptionDetails?.text || 'exception' });
    if (s.console.length > 500) s.console.shift();
  } else if (cdpMethod === 'Network.requestWillBeSent') {
    s.network.set(cdpParams.requestId, { url: cdpParams.request?.url, method: cdpParams.request?.method });
  } else if (cdpMethod === 'Network.responseReceived') {
    const e = s.network.get(cdpParams.requestId); if (e) { e.status = cdpParams.response?.status; e.type = cdpParams.type; }
  }
});
chrome.debugger.onDetach.addListener((source) => { if (source.tabId != null) state.delete(source.tabId); });
