// Claude Browser Bridge — extension service worker (v0.3.0).
// A generic CDP proxy + tab manager. The native host sends {id, method, params};
// we execute via chrome.debugger / chrome.tabs and reply {id, result|error}.
// chrome.debugger events are buffered per-tab (console/network) and streamed as onCDPEvent.

const HOST = 'com.claude.browserbridge';
const VERSION = '0.12.0';
let port = null;

// Downloads are browser-wide (not tab-scoped): buffer them so the agent can wait for one and get
// its absolute path to Read in Claude Code.
const downloads = new Map(); // id -> { id, url, filename, state, ts }
try {
  chrome.downloads.onCreated.addListener((d) => downloads.set(d.id, { id: d.id, url: d.url, filename: d.filename || '', state: d.state || 'in_progress', ts: Date.now() }));
  chrome.downloads.onChanged.addListener((delta) => {
    const e = downloads.get(delta.id) || { id: delta.id, url: '', filename: '', ts: Date.now() };
    if (delta.filename) e.filename = delta.filename.current;
    if (delta.state) { e.state = delta.state.current; e.ts = Date.now(); }
    downloads.set(delta.id, e);
  });
} catch {}

// Secure credential entry: pending requests keyed by a token handed to the popup window. The
// user's secret values live only inside the popup → this worker → the page fill; they are never
// logged, returned to the host/MCP, or exposed to the model.
const pendingCredentials = new Map(); // token -> { spec, tabId, origin, fields, submit, finish }

// per controlled tab: refs: Map<ref, {backendNodeId, sessionId}>, seq, console, network,
// frames: Map<sessionId, {parentSession, ownerBackendNodeId, url}> for cross-origin (OOPIF) frames.
const state = new Map();
function st(tabId) {
  let s = state.get(tabId);
  if (!s) { s = { refs: new Map(), seq: 0, console: [], network: new Map(), domains: new Set(), frames: new Map(), ax: null }; state.set(tabId, s); }
  return s;
}
// Which tabs the agent opened.
//
// This cannot live only in `state`: an MV3 service worker is evicted routinely, and when it comes
// back that map is empty — so tab_close would refuse to close a tab the agent itself had opened,
// orphaning it in the user's window with no way to clean up.
//
// storage.session was the obvious home, but it is also cleared by an extension *reload*, which
// orphans every agent tab open at that moment. storage.local survives a reload — the catch being
// that Chrome reuses tab ids across browser restarts, so a stale record could name one of the
// user's tabs. Two independent fences make that safe, and a stale id would have to beat both:
//
//   1. A watermark that only a browser start moves. onStartup fires on browser start but NOT on an
//      extension reload, which is exactly the distinction we need; records older than it are ignored
//      (and pruned outright).
//   2. A TTL, so even if onStartup never fires on some build, a record cannot stay dangerous
//      indefinitely. Expiry only ever makes tab_close refuse — it fails in the safe direction.
const AGENT_TABS_KEY = 'cbb.agentTabs';
const RUN_MARK_KEY = 'cbb.browserRunStartedAt';
const AGENT_TAB_TTL_MS = 24 * 60 * 60 * 1000;

let runMark = null;
async function browserRunMark() {
  if (runMark != null) return runMark;
  try {
    const v = (await chrome.storage.local.get(RUN_MARK_KEY))[RUN_MARK_KEY];
    if (typeof v === 'number') return (runMark = v);
    runMark = Date.now(); // first run ever — start the fence here
    await chrome.storage.local.set({ [RUN_MARK_KEY]: runMark });
    return runMark;
  } catch { return (runMark = Date.now()); }
}
// A new browser run: every id from the previous one is now meaningless and possibly reassigned.
async function startBrowserRun() {
  runMark = Date.now();
  try { await chrome.storage.local.set({ [RUN_MARK_KEY]: runMark, [AGENT_TABS_KEY]: [] }); } catch {}
}
async function readAgentTabs() {
  try {
    const mark = await browserRunMark();
    const floor = Math.max(mark, Date.now() - AGENT_TAB_TTL_MS);
    const cur = (await chrome.storage.local.get(AGENT_TABS_KEY))[AGENT_TABS_KEY] || [];
    return cur.filter((r) => r && typeof r.id === 'number' && (r.at || 0) >= floor);
  } catch { return []; }
}
async function markAgentTab(tabId) {
  st(tabId).createdByAgent = true;
  try {
    const cur = await readAgentTabs();
    if (!cur.some((r) => r.id === tabId)) {
      await chrome.storage.local.set({ [AGENT_TABS_KEY]: [...cur, { id: tabId, at: Date.now() }] });
    }
  } catch {}
}
async function isAgentTab(tabId) {
  if (state.get(tabId)?.createdByAgent) return true;
  return (await readAgentTabs()).some((r) => r.id === tabId);
}
async function forgetAgentTab(tabId) {
  // Both halves, or "forgetting" a tab leaves the in-memory flag asserting ownership that storage
  // no longer backs. Today every caller also drops the tab's state, which hides that; a future one
  // might not.
  const s = state.get(tabId); if (s) s.createdByAgent = false;
  try {
    const cur = await readAgentTabs();
    if (cur.some((r) => r.id === tabId)) await chrome.storage.local.set({ [AGENT_TABS_KEY]: cur.filter((r) => r.id !== tabId) });
  } catch {}
}
// Don't let the set grow stale as the user closes tabs themselves.
try { chrome.tabs.onRemoved.addListener((tabId) => { forgetAgentTab(tabId); state.delete(tabId); }); } catch {}

// Route a CDP command to a tab (number) or a specific frame session ({tabId, sessionId}). Chrome 125+
// flat sessions: sendCommand takes {tabId, sessionId} to address an out-of-process child frame.
const dbgOf = (tabId, sessionId) => (sessionId ? { tabId, sessionId } : tabId);
// Pages the agent must never drive/see — browser UI and extension pages (incl. our credential popup).
const PRIVILEGED_URL = /^(chrome|chrome-extension|devtools|edge|brave|about|view-source):/i;

// ---- browser organization (browser_manage) ----
// A named allowlist rather than an open passthrough, so a typo'd method name fails with the list of
// real ones instead of an opaque "not a function" from deep inside the extension API.
const MANAGE_ALLOWED = {
  tabs: new Set(['query', 'get', 'update', 'move', 'group', 'ungroup', 'remove', 'discard', 'reload']),
  windows: new Set(['get', 'getAll', 'getCurrent', 'getLastFocused', 'create', 'update', 'remove']),
  tabGroups: new Set(['query', 'get', 'update', 'move']),
  bookmarks: new Set(['search', 'get', 'getTree', 'getSubTree', 'getChildren', 'getRecent', 'create', 'move', 'update', 'remove', 'removeTree']),
};
const MANAGE_MUTATING = new Set([
  'tabs.update', 'tabs.move', 'tabs.group', 'tabs.ungroup', 'tabs.remove', 'tabs.discard',
  'windows.create', 'windows.update', 'windows.remove',
  'tabGroups.update', 'tabGroups.move',
  'bookmarks.create', 'bookmarks.move', 'bookmarks.update', 'bookmarks.remove', 'bookmarks.removeTree',
]);
const auditTrail = [];
// What the browser looked like immediately before a mutation — enough to describe the change in
// words and to reverse it, without dragging the whole bookmark tree into memory every time.
async function layoutSnapshot(ns) {
  try {
    if (ns === 'bookmarks') return { bookmarks: await chrome.bookmarks.getRecent(25).catch(() => []) };
    const tabs = (await chrome.tabs.query({})).map((t) => ({ id: t.id, index: t.index, windowId: t.windowId, groupId: t.groupId, pinned: t.pinned, url: t.url }));
    const groups = await chrome.tabGroups.query({}).catch(() => []);
    const windows = (await chrome.windows.getAll({})).map((w) => ({ id: w.id, focused: w.focused, state: w.state, left: w.left, top: w.top, width: w.width, height: w.height }));
    return { tabs, groups, windows };
  } catch { return null; }
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
// onStartup means a new browser run, so it also retires the previous run's agent-tab records —
// their ids may already have been handed to tabs the user opened. An extension reload deliberately
// does NOT come through here, which is what lets those records survive one.
try { chrome.runtime.onStartup.addListener(() => { startBrowserRun(); connect(); }); } catch {}
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
// target: a tabId (number) → {tabId}, or a debuggee object {tabId, sessionId} for a child frame.
function cmd(target, method, params = {}) {
  const dbg = typeof target === 'number' ? { tabId: target } : target;
  return new Promise((res, rej) => {
    chrome.debugger.sendCommand(dbg, method, params, (result) => {
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
        // Reach into cross-origin (out-of-process) iframes. Chrome 125+ flat sessions; older Chrome
        // just no-ops here and we stay main-frame-only.
        await cmd(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }).catch(() => {});
        // Let a backgrounded tab behave as focused + stay lifecycle-active, so SPAs that gate
        // rendering on focus/visibility (e.g. the Cloudflare dashboard) load without us stealing the
        // user's foreground. Work on the tab in the background instead of activating it.
        await cmd(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
        await cmd(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
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

// ---- page geometry + attributes, in one CDP call ----
//
// The accessibility tree knows what an element IS but not where it sits or what is painted over it,
// so on its own it will happily offer you a button that a cookie modal is covering. DOMSnapshot
// answers all of that at once — bounds, paint order, attributes and the styles we need to tell a
// real occluder from a transparent one — for the price of a single round trip.
const OCCLUSION_STYLES = ['background-color', 'opacity', 'cursor'];
async function domSnapshotIndex(tabId, sessionId) {
  let snap;
  try {
    snap = await cmd(dbgOf(tabId, sessionId), 'DOMSnapshot.captureSnapshot', {
      computedStyles: OCCLUSION_STYLES, includePaintOrder: true, includeDOMRects: false,
    });
  } catch { return null; }
  const S = snap.strings || [];
  const str = (i) => (i == null || i < 0 ? undefined : S[i]);
  const out = new Map();  // backendNodeId -> { tag, attrs, rect, paint }
  const painted = [];     // { rect, paint, opaque } for the occlusion pass
  for (const doc of snap.documents || []) {
    const nodes = doc.nodes || {}, layout = doc.layout || {};
    const bids = nodes.backendNodeId || [];
    const byNodeIndex = new Map();
    for (let i = 0; i < (layout.nodeIndex || []).length; i++) {
      const ni = layout.nodeIndex[i];
      const b = (layout.bounds || [])[i];
      const paint = (layout.paintOrders || [])[i];
      if (!b || paint == null) continue;
      const rect = { x1: b[0], y1: b[1], x2: b[0] + b[2], y2: b[1] + b[3] };
      byNodeIndex.set(ni, { rect, paint });
      if (b[2] <= 0 || b[3] <= 0) continue;
      // Only something you cannot see through actually hides what is behind it. A transparent
      // layout wrapper spanning the page is the common case, and treating it as an occluder marks
      // the whole page unclickable — which is exactly the false positive this guards against.
      const st = (layout.styles || [])[i] || [];
      const bg = str(st[0]) ?? '', op = str(st[1]) ?? '1';
      const opaque = !/^rgba\(.*,\s*0\)$/.test(bg) && bg !== 'transparent' && bg !== '' && parseFloat(op || '1') >= 0.8;
      byNodeIndex.get(ni).cursor = str(st[2]);
      painted.push({ rect, paint, opaque });
    }
    for (let ni = 0; ni < bids.length; ni++) {
      const bid = bids[ni];
      if (bid == null) continue;
      const attrs = {};
      const a = (nodes.attributes || [])[ni] || [];
      for (let k = 0; k + 1 < a.length; k += 2) {
        const name = str(a[k]); if (name) attrs[name] = str(a[k + 1]) ?? '';
      }
      const geo = byNodeIndex.get(ni);
      out.set(bid, { tag: (str((nodes.nodeName || [])[ni]) || '').toLowerCase(), attrs, rect: geo?.rect, paint: geo?.paint, cursor: geo?.cursor });
    }
  }
  return { nodes: out, painted };
}

// A disjoint union of rectangles, so an element buried under SEVERAL stacked panels is caught, not
// just one covering it outright. Capped, because each insert can fragment existing rects into four
// and a page of translucent layers would otherwise grow this without bound; past the cap it simply
// reports nothing as covered, which errs toward silence rather than a wrong warning.
const MAX_UNION_RECTS = 5000;
const rIntersects = (a, b) => !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);
const rContains = (a, b) => a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2;
// a minus b, as up to four rectangles.
function rSplit(a, b) {
  const parts = [];
  if (a.y1 < b.y1) parts.push({ x1: a.x1, y1: a.y1, x2: a.x2, y2: b.y1 });
  if (b.y2 < a.y2) parts.push({ x1: a.x1, y1: b.y2, x2: a.x2, y2: a.y2 });
  const lo = Math.max(a.y1, b.y1), hi = Math.min(a.y2, b.y2);
  if (a.x1 < b.x1) parts.push({ x1: a.x1, y1: lo, x2: b.x1, y2: hi });
  if (b.x2 < a.x2) parts.push({ x1: b.x2, y1: lo, x2: a.x2, y2: hi });
  return parts;
}
class RectUnion {
  constructor() { this.rects = []; }
  covers(r) {
    if (!this.rects.length) return false;
    let stack = [r];
    for (const s of this.rects) {
      const next = [];
      for (const piece of stack) {
        if (rContains(s, piece)) continue;
        if (rIntersects(piece, s)) next.push(...rSplit(piece, s));
        else next.push(piece);
      }
      if (!next.length) return true; // every part of r was eaten
      stack = next;
    }
    return false;
  }
  add(r) {
    if (this.rects.length >= MAX_UNION_RECTS || this.covers(r)) return;
    let pending = [r];
    for (const s of this.rects) {
      const next = [];
      for (const piece of pending) {
        if (rIntersects(piece, s)) next.push(...rSplit(piece, s));
        else next.push(piece);
      }
      pending = next;
      if (!pending.length) return;
    }
    this.rects.push(...pending);
  }
}

// Which nodes are buried? Walk paint order from the top down: everything at one level is tested
// against what is already above it before any of that level is added, so siblings never occlude
// each other.
function occludedNodes(geo) {
  const covered = new Set();
  if (!geo) return covered;
  const levels = new Map();
  for (const p of geo.painted) {
    if (!levels.has(p.paint)) levels.set(p.paint, []);
    levels.get(p.paint).push(p);
  }
  const union = new RectUnion();
  const byBid = new Map();
  for (const [bid, g] of geo.nodes) if (g.rect && g.paint != null) byBid.set(bid, g);
  for (const paint of [...levels.keys()].sort((a, b) => b - a)) {
    const group = levels.get(paint);
    for (const [bid, g] of byBid) if (g.paint === paint && union.covers(g.rect)) covered.add(bid);
    for (const p of group) if (p.opaque) union.add(p.rect);
  }
  return covered;
}

// Chrome renders a date/time input by locale but only accepts a value in one wire format, so a model
// typing "03/15/2026" into a date field it can see as "MM/DD/YYYY" silently sets nothing. Naming the
// format it must actually type is the whole fix.
const DATE_FORMATS = { date: 'YYYY-MM-DD', month: 'YYYY-MM', week: 'YYYY-Www', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM' };

// ---- ref resolution ----
function refNode(tabId, ref) {
  const n = st(tabId).refs.get(ref);
  if (n == null) throw new Error(`unknown ref "${ref}" — take a fresh read_page/dom_query`);
  return n; // { backendNodeId, sessionId }
}
async function objectFor(dbg, backendNodeId) {
  const { object } = await cmd(dbg, 'DOM.resolveNode', { backendNodeId });
  return object.objectId;
}
// Accumulated top-left offset of a frame chain, in top-level viewport CSS px. In a real
// (non-headless) browser DOM.getBoxModel returns FRAME-LOCAL coords, so an OOPIF element's viewport
// position = its local box + each ancestor <iframe> owner's content-box origin, walked to the top.
async function frameOffset(tabId, sessionId) {
  let ox = 0, oy = 0, sid = sessionId; const s = st(tabId); const guard = new Set();
  while (sid && !guard.has(sid)) {
    guard.add(sid);
    const fr = s.frames.get(sid);
    if (!fr || fr.ownerBackendNodeId == null || !fr.parentSession) break;
    try { const { model } = await cmd(fr.parentSession, 'DOM.getBoxModel', { backendNodeId: fr.ownerBackendNodeId }); ox += model.content[0]; oy += model.content[1]; }
    catch { break; }
    sid = fr.parentSession.sessionId; // undefined at the main frame → stop
  }
  return { ox, oy };
}
// Axis-aligned box of a node in top-level viewport CSS px (translated through any OOPIF chain).
// Does NOT scroll — callers that need the element on screen scroll it themselves first, so this
// stays safe to fan out over every element on the page.
async function nodeBox(tabId, backendNodeId, sessionId, which = 'content') {
  const dbg = dbgOf(tabId, sessionId);
  let model;
  try { ({ model } = await cmd(dbg, 'DOM.getBoxModel', { backendNodeId })); } catch { return null; }
  const q = model[which] || model.content;
  if (!q) return null;
  const { ox, oy } = sessionId ? await frameOffset(tabId, sessionId) : { ox: 0, oy: 0 };
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs) + ox, y = Math.min(...ys) + oy;
  return { x, y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
// Box + scroll offset read in ONE evaluation, so the pair is always internally consistent even
// while a smooth scroll is still settling. Returns viewport-space and document-space rects.
// Cross-origin frames fall back to the CDP path, which is the only thing that can reach them.
const MEASURE_FN = `function(){
  const r=this.getBoundingClientRect();
  const sx=window.scrollX||0, sy=window.scrollY||0;
  return { viewport:{x:r.left,y:r.top}, page:{x:r.left+sx,y:r.top+sy},
           width:r.width, height:r.height, scroll:{x:Math.round(sx),y:Math.round(sy)} };
}`;
async function measureNode(tabId, backendNodeId, sessionId) {
  if (!sessionId) {
    try {
      const objectId = await objectFor(tabId, backendNodeId);
      const r = await cmd(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration: MEASURE_FN, returnByValue: true });
      const v = r.result?.value;
      if (v && v.width > 0 && v.height > 0) return v;
      if (v) return v; // zero-sized is a real answer; the caller decides what to do with it
    } catch { /* fall through to the CDP path */ }
  }
  const box = await nodeBox(tabId, backendNodeId, sessionId, 'border');
  if (!box) return null;
  const { scroll } = await pageGeometry(tabId);
  return { viewport: { x: box.x, y: box.y }, page: { x: box.x + scroll.x, y: box.y + scroll.y }, width: box.width, height: box.height, scroll };
}
// Center of a ref in top-level viewport coords (translates through any OOPIF chain).
async function absCenter(tabId, backendNodeId, sessionId) {
  await cmd(dbgOf(tabId, sessionId), 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
  const b = await nodeBox(tabId, backendNodeId, sessionId, 'content');
  if (!b) throw new Error('element has no layout box (display:none or detached) — take a fresh read_page');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
async function refPoint(tabId, ref) { const { backendNodeId, sessionId } = refNode(tabId, ref); return absCenter(tabId, backendNodeId, sessionId); }

// ---- hit testing ----
// What the browser would actually deliver a click at this point to. Pierces open shadow roots and
// same-origin iframes so the answer names the real target, not the outer host/frame element.
const HIT_TEST_FN = `function(x,y){
  const desc=(e)=>{ if(!e) return null;
    const a=(n)=>e.getAttribute&&e.getAttribute(n)||null;
    const label=(a('aria-label')||e.title||(e.tagName==='INPUT'?(a('placeholder')||a('name')||''):'')||(e.innerText||e.textContent||'').trim()).replace(/\\s+/g,' ').slice(0,120);
    // Build the most specific selector the element actually supports, preferring stable hooks.
    // A bare tag+class is often ambiguous, so try distinguishing attributes before falling back,
    // and report how many elements the result matches so ambiguity is visible rather than assumed.
    const tag=e.tagName?e.tagName.toLowerCase():'';
    const q=(s)=>{try{return document.querySelectorAll(s).length}catch{return null}};
    const cand=[];
    if(e.id&&!/^[0-9]/.test(e.id)&&/^[\\w-]+$/.test(e.id)) cand.push('#'+CSS.escape(e.id));
    for(const at of ['data-testid','data-test-id','data-test','data-qa','name']){ const v=a(at); if(v) cand.push(tag+'['+at+'="'+CSS.escape(v)+'"]'); }
    // any other data-* attribute with a short, distinctive value
    if(e.attributes) for(const at of e.attributes){ if(/^data-/.test(at.name)&&at.value&&at.value.length<=40&&!/^data-(testid|test-id|test|qa)$/.test(at.name)) cand.push(tag+'['+at.name+'="'+CSS.escape(at.value)+'"]'); }
    const ar=a('aria-label'); if(ar&&ar.length<=60) cand.push(tag+'[aria-label="'+CSS.escape(ar)+'"]');
    if(e.classList&&e.classList.length){const c=[...e.classList].filter(c=>/^[\\w-]+$/.test(c)).slice(0,3);if(c.length)cand.push(tag+'.'+c.map(x=>CSS.escape(x)).join('.'));}
    cand.push(tag);
    let sel=cand[cand.length-1], n=q(sel);
    for(const c of cand){ const k=q(c); if(k===1){ sel=c; n=1; break; } if(k!=null&&(n==null||k<n)){ sel=c; n=k; } }
    const r=e.getBoundingClientRect?e.getBoundingClientRect():null;
    return { tag, role:a('role')||null, label:label||null, selector:sel, selectorMatches:n,
             href:a('href'), disabled:!!(e.disabled),
             box:r?{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}:null };
  };
  let doc=document, el=doc.elementFromPoint(x,y), fx=x, fy=y, frames=0;
  if(!el) return { hit:null, outside:true };
  // descend through same-origin iframes and open shadow roots to the innermost real target
  for(let i=0;i<12;i++){
    if(el.shadowRoot){ const inner=el.shadowRoot.elementFromPoint(fx,fy); if(inner&&inner!==el){ el=inner; continue; } }
    if((el.tagName==='IFRAME'||el.tagName==='FRAME')&&el.contentDocument){
      const r=el.getBoundingClientRect(); const inner=el.contentDocument.elementFromPoint(fx-r.left,fy-r.top);
      if(inner){ fx-=r.left; fy-=r.top; el=inner; frames++; continue; }
    }
    break;
  }
  // the nearest clickable ancestor is usually what the user "meant" (text node inside a button)
  let act=el; for(let i=0;i<8&&act;i++){ const t=act.tagName; if(t==='A'||t==='BUTTON'||t==='INPUT'||t==='SELECT'||t==='TEXTAREA'||t==='LABEL'||act.getAttribute('role')||act.onclick||act.tabIndex>=0) break; act=act.parentElement; }
  const out={ hit:desc(el) };
  if(act&&act!==el) out.clickable=desc(act);
  if(frames) out.crossedFrames=frames;
  return out;
}`;
async function hitTest(tabId, x, y) {
  try {
    const r = await cmd(tabId, 'Runtime.evaluate', {
      expression: `(${HIT_TEST_FN})(${Number(x)},${Number(y)})`, returnByValue: true,
    });
    return r.result?.value ?? null;
  } catch { return null; } // hit-testing is advisory — never fail an action because it didn't work
}
// Same shape as a hitTest entry, for the element a ref points at — so the two are comparable.
const DESCRIBE_FN = `function(){
  const e=this,a=(n)=>e.getAttribute&&e.getAttribute(n)||null;
  const label=(a('aria-label')||e.title||(e.tagName==='INPUT'?(a('placeholder')||a('name')||''):'')||(e.innerText||e.textContent||'').trim()).replace(/\\s+/g,' ').slice(0,120);
  const r=e.getBoundingClientRect?e.getBoundingClientRect():null;
  return { tag:e.tagName?e.tagName.toLowerCase():'', role:a('role')||null, label:label||null,
           box:r?{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}:null };
}`;
async function describeNode(tabId, backendNodeId, sessionId) {
  try {
    const dbg = dbgOf(tabId, sessionId);
    const objectId = await objectFor(dbg, backendNodeId);
    const r = await cmd(dbg, 'Runtime.callFunctionOn', { objectId, functionDeclaration: DESCRIBE_FN, returnByValue: true });
    return r.result?.value ?? null;
  } catch { return null; }
}
// Would a click at this point actually reach the ref's element?
//
// Judged by DOM relationship, not geometry: an overlay that covers the target CONTAINS its area, so
// an overlap test calls that a hit and misses the very case worth reporting. Whereas the element
// really under the cursor is either the target, inside it (its own label/icon), or the wrapper
// around it — anything else is something sitting on top.
const COVERED_FN = `function(x,y){
  const hit=document.elementFromPoint(x,y);
  if(!hit) return {covered:true,by:null};
  if(hit===this||this.contains(hit)||hit.contains(this)) return {covered:false};
  const a=(n)=>hit.getAttribute&&hit.getAttribute(n)||null;
  const label=(a('aria-label')||hit.title||(hit.innerText||hit.textContent||'').trim()).replace(/\\s+/g,' ').slice(0,80);
  return {covered:true,by:{tag:hit.tagName?hit.tagName.toLowerCase():'',label:label||null}};
}`;
async function checkCovered(tabId, backendNodeId, sessionId, x, y) {
  if (sessionId) return null; // cross-origin frame: the point would need frame-local coords — skip
  try {
    const objectId = await objectFor(tabId, backendNodeId);
    const r = await cmd(tabId, 'Runtime.callFunctionOn', {
      objectId, functionDeclaration: COVERED_FN,
      arguments: [{ value: Number(x) }, { value: Number(y) }], returnByValue: true,
    });
    return r.result?.value ?? null;
  } catch { return null; }
}

// Fill user-entered secrets into the page by selector (top document). Values arrive only here from
// the popup; never logged or returned. Returns a status code (browserAuth-style).
const SETTER_FN = 'function(v){this.focus&&this.focus();const p=Object.getOwnPropertyDescriptor(this.__proto__,"value");if(p&&p.set)p.set.call(this,v);else this.value=v;this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));}';
async function fillCredentials(pend, values) {
  const { tabId, origin, fields, submit } = pend;
  let curOrigin = ''; try { curOrigin = new URL((await chrome.tabs.get(tabId)).url).origin; } catch {}
  if (origin && curOrigin && origin !== curOrigin) return 'origin_changed';
  const { root } = await cmd(tabId, 'DOM.getDocument', { depth: 0 });
  for (const f of fields) {
    if (values[f.id] == null) continue;
    let nodeId;
    try { nodeId = (await cmd(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: f.selector })).nodeId; } catch { return 'locator_invalid'; }
    if (!nodeId) return 'locator_invalid';
    const { object } = await cmd(tabId, 'DOM.resolveNode', { nodeId });
    await cmd(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: SETTER_FN, arguments: [{ value: String(values[f.id]) }] });
  }
  if (submit && submit.selector) {
    let snid;
    try { snid = (await cmd(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: submit.selector })).nodeId; } catch { return 'submission_failed'; }
    if (!snid) return 'submission_failed';
    const { object } = await cmd(tabId, 'DOM.resolveNode', { nodeId: snid });
    const fn = submit.action === 'enter'
      ? 'function(){this.focus();const f=this.form;if(f){f.requestSubmit?f.requestSubmit():f.submit();}else{this.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:13,bubbles:true}));}}'
      : 'function(){this.click();}';
    await cmd(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn });
  }
  return 'submitted';
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
  'tab', 'option', 'listbox', 'textarea', 'colorwell', 'date', 'datetime',
  'clickable']); // our own role for a role-less element that the page makes clickable (see readPage)

// Icon-font glyphs surface as Private-Use-Area codepoints — meaningless to the model. Collapse to [icon].
function cleanName(s) {
  return String(s || '').replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+/gu, '[icon]');
}

// ---- screenshot geometry ----
// Claude's vision limits (~1568px longest edge / ~1.15MP): we downscale to stay under them.
const VISION_MAX_EDGE = 1568, VISION_MAX_PIXELS = 1.15e6;

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(buf) { // chunked — a per-byte string concat is quadratic on megapixel PNGs
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return btoa(s);
}
const decodePng = (b64) => createImageBitmap(new Blob([b64ToBytes(b64)], { type: 'image/png' }));
async function canvasToB64(canvas) {
  return bytesToB64(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
}

// Page geometry in CSS px: viewport size, scroll offset, full document size.
async function pageGeometry(tabId) {
  const m = await cmd(tabId, 'Page.getLayoutMetrics').catch(() => ({}));
  const lv = m.cssLayoutViewport || m.layoutViewport || {};
  const vv = m.cssVisualViewport || m.visualViewport || {};
  const cs = m.cssContentSize || m.contentSize || {};
  return {
    viewport: { width: Math.round(vv.clientWidth ?? lv.clientWidth ?? 0), height: Math.round(vv.clientHeight ?? lv.clientHeight ?? 0) },
    scroll: { x: Math.round(vv.pageX ?? lv.pageX ?? 0), y: Math.round(vv.pageY ?? lv.pageY ?? 0) },
    content: { width: Math.round(cs.width ?? 0), height: Math.round(cs.height ?? 0) },
  };
}

// Capture a screenshot AND the exact mapping from its pixels back to CSS pixels.
//
// The scale factor is MEASURED from the decoded bitmap (imageWidth / sourceCssWidth) rather than
// assumed, so device pixel ratio, browser zoom, and CDP's clip semantics can't silently skew it —
// which is the whole reason coordinates read off a screenshot used to miss. `origin` is where the
// image's top-left sits in the space named by `space`, so:
//     cssViewportX = origin.x + imageX / scale   (space "viewport")
//     pageX        = origin.x + imageX / scale   (space "page" — subtract scroll for a click)
async function captureShot(tabId, p = {}) {
  const geo = await pageGeometry(tabId);
  const opts = { format: 'png' };
  let space = 'viewport', origin = { x: 0, y: 0 }, srcW = geo.viewport.width, srcH = geo.viewport.height;

  if (p.ref != null) { // just this element
    const { backendNodeId, sessionId } = refNode(tabId, p.ref);
    const dbg = dbgOf(tabId, sessionId);
    await cmd(dbg, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
    // captureScreenshot's clip is in DOCUMENT space while getBoxModel reports VIEWPORT space, so the
    // scroll offset has to be added or a scrolled page captures the wrong region entirely.
    //
    // Box and scroll must be read together: scrollIntoViewIfNeeded above settles asynchronously, so
    // two separate reads can straddle it and produce a mismatched pair. One evaluation gets both
    // from the same frame.
    const m = await measureNode(tabId, backendNodeId, sessionId);
    if (!m) throw new Error(`ref "${p.ref}" has no layout box (display:none or detached)`);
    geo.scroll = m.scroll;
    opts.clip = { x: m.page.x, y: m.page.y, width: m.width, height: m.height, scale: 1 };
    // origin stays viewport-relative — that is the space the returned coordinates are declared in
    origin = { x: m.viewport.x, y: m.viewport.y }; srcW = m.width; srcH = m.height;
  } else if (p.fullPage) { // whole scrollable page, not just the viewport
    opts.captureBeyondViewport = true;
    if (geo.content.width) opts.clip = { x: 0, y: 0, width: geo.content.width, height: geo.content.height, scale: 1 };
    space = 'page'; srcW = geo.content.width || geo.viewport.width; srcH = geo.content.height || geo.viewport.height;
  }

  const raw = (await cmd(tabId, 'Page.captureScreenshot', opts)).data;
  let bmp = null, data = raw, imgW = srcW, imgH = srcH, marks = null;
  try {
    bmp = await decodePng(raw);
    imgW = bmp.width; imgH = bmp.height;
    if (p.marks) marks = await collectMarks(tabId, { space, origin, srcW, srcH, scroll: geo.scroll });
    // One canvas pass does both the downscale and the mark overlay, so badges stay crisp and the
    // annotation is drawn in FINAL image coordinates (what the model will actually read off).
    const fit = Math.min(1, VISION_MAX_EDGE / Math.max(imgW, imgH), Math.sqrt(VISION_MAX_PIXELS / (imgW * imgH)));
    const needsDraw = fit < 1 || (marks && marks.length) || p.point;
    if (needsDraw) {
      const outW = Math.max(1, Math.round(imgW * fit)), outH = Math.max(1, Math.round(imgH * fit));
      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0, outW, outH);
      const toImg = (outW / srcW); // CSS px in the captured rect -> final image px
      if (marks && marks.length) drawMarks(ctx, marks, origin, toImg, outW, outH);
      if (p.point) drawProbePoint(ctx, (p.point.x - origin.x) * toImg, (p.point.y - origin.y) * toImg);
      data = await canvasToB64(canvas);
      imgW = outW; imgH = outH;
    }
  } catch { data = raw; /* fall back to the raw capture on any decode/resize failure */ }
  finally { bmp && bmp.close && bmp.close(); }

  const scale = srcW ? imgW / srcW : 1;
  const shot = {
    space, origin, scale: Number(scale.toFixed(6)),
    imageSize: { width: imgW, height: imgH },
    capturedCssSize: { width: srcW, height: srcH },
    viewport: geo.viewport, scroll: geo.scroll, ts: Date.now(),
  };
  st(tabId).lastShot = shot; // lets a later {space:"image"} coordinate be translated exactly
  return { image: data, shot, marks };
}

// ---- coordinate spaces ----
// "viewport" (default) = CSS px from the viewport's top-left — what CDP Input actually consumes.
// "page"              = CSS px from the document's top-left (a full-page screenshot's space).
// "image"             = pixels in the last screenshot returned for this tab.
async function toViewport(tabId, x, y, space) {
  const sp = space || 'viewport';
  if (sp === 'viewport') return { x, y };
  if (sp === 'page') { // document coords — the LIVE scroll offset, not whatever a stale shot recorded
    const { scroll } = await pageGeometry(tabId);
    return { x: x - scroll.x, y: y - scroll.y };
  }
  if (sp === 'image') {
    const shot = state.get(tabId)?.lastShot;
    if (!shot) throw new Error('space:"image" refers to the last screenshot of this tab — take one first');
    const cx = shot.origin.x + x / shot.scale, cy = shot.origin.y + y / shot.scale;
    if (shot.space !== 'page') return { x: cx, y: cy };
    // The shot was document-space; convert through the live scroll so a scroll since the capture
    // shifts the point instead of silently aiming at the wrong row.
    const { scroll } = await pageGeometry(tabId);
    return { x: cx - scroll.x, y: cy - scroll.y };
  }
  throw new Error(`unknown coordinate space "${sp}" — use "viewport", "page" or "image"`);
}
// Resolve a tool's target point to viewport CSS px, whatever space it was expressed in.
async function pointOf(tabId, p) {
  if (p.x == null || p.y == null) return null;
  return toViewport(tabId, p.x, p.y, p.space);
}

// ---- set-of-mark annotation ----
// Label every interactable element in the shot with the SAME ref that `click{ref}` takes. This
// turns "read a pixel off the picture and hope" into "name the badge you can see" — the model gets
// to work visually while the actual click still resolves through the element, so it cannot miss.
const MARK_COLORS = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2'];

async function collectMarks(tabId, { space, origin, srcW, srcH, scroll }) {
  const s = st(tabId);
  const cands = [];
  for (const sessionId of [undefined, ...s.frames.keys()]) {
    let nodes;
    try { nodes = (await cmd(dbgOf(tabId, sessionId), 'Accessibility.getFullAXTree', {})).nodes; } catch { continue; }
    for (const n of nodes) {
      if (n.ignored || n.backendDOMNodeId == null) continue;
      const role = n.role?.value; if (!role || !INTERACTIVE.has(role)) continue;
      if (n.properties?.some((pr) => pr.name === 'hidden' && pr.value?.value === true)) continue;
      cands.push({ role, name: cleanName((n.name?.value || '').trim()).slice(0, 120), backendNodeId: n.backendDOMNodeId, sessionId });
      if (cands.length >= 300) break;
    }
  }
  // Boxes in parallel — each is an in-process CDP call, so a page full of controls stays fast.
  const boxes = await Promise.all(cands.map((c) => nodeBox(tabId, c.backendNodeId, c.sessionId, 'border').catch(() => null)));
  const out = [];
  for (let i = 0; i < cands.length; i++) {
    const b = boxes[i]; if (!b || b.width <= 0 || b.height <= 0) continue;
    // Boxes come back viewport-relative; a full-page capture is document-space, so add the scroll.
    const bx = space === 'page' ? b.x + scroll.x : b.x;
    const by = space === 'page' ? b.y + scroll.y : b.y;
    if (bx + b.width < origin.x || by + b.height < origin.y) continue; // fully above/left of the capture
    if (bx > origin.x + srcW || by > origin.y + srcH) continue;        // fully below/right of it
    const c = cands[i];
    const ref = 'm' + (++s.seq);
    s.refs.set(ref, { backendNodeId: c.backendNodeId, sessionId: c.sessionId });
    out.push({ ref, role: c.role, name: c.name, x: Math.round(bx), y: Math.round(by), width: Math.round(b.width), height: Math.round(b.height) });
  }
  return out;
}

// Draw the badges onto the final (already-downscaled) canvas, in image pixels.
//
// A badge that sits ON the element hides the very text that identifies it, which makes the
// screenshot worse than an unmarked one. So each badge is placed OUTSIDE its element's box —
// preferring the left margin, then above, then below — and only lands on top of the element as a
// last resort when nothing else is free.
function drawMarks(ctx, marks, origin, toImg, outW, outH) {
  const F = 10, PAD = 2;
  ctx.font = `bold ${F}px -apple-system, "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const placed = [];
  const free = (x, y, w, h) => x >= 0 && y >= 0 && x + w <= outW && y + h <= outH
    && !placed.some((q) => x < q.x + q.w && x + w > q.x && y < q.y + q.h && y + h > q.y);

  const boxes = marks.map((m) => ({
    x: (m.x - origin.x) * toImg, y: (m.y - origin.y) * toImg,
    w: m.width * toImg, h: m.height * toImg,
  }));
  // Place the small elements first: they have the fewest viable spots, and a big element's badge
  // can always fall back to its own wide margin.
  const order = marks.map((_, i) => i).sort((a, b) => (boxes[a].w * boxes[a].h) - (boxes[b].w * boxes[b].h));

  for (const i of order) {
    const m = marks[i], b = boxes[i];
    const bw = ctx.measureText(m.ref).width + PAD * 2, bh = F + PAD * 2;
    const cand = [
      [b.x - bw - 1, b.y + (b.h - bh) / 2],   // left margin — best for wide inline text
      [b.x, b.y - bh - 1],                    // above, left-aligned
      [b.x, b.y + b.h + 1],                   // below, left-aligned
      [b.x + b.w + 1, b.y + (b.h - bh) / 2],  // right margin
      [b.x - bw - 1, b.y - bh - 1],           // diagonally outside the corner
      [b.x, b.y],                             // give up and overlay it
    ];
    let spot = cand.find(([x, y]) => free(x, y, bw, bh)) || cand[cand.length - 1];
    const bx = Math.min(Math.max(0, spot[0]), outW - bw), by = Math.min(Math.max(0, spot[1]), outH - bh);
    placed.push({ x: bx, y: by, w: bw, h: bh, i });
  }

  // Outlines under every badge, so a badge sitting in the margin still reads as belonging to its box.
  for (const p of placed) {
    const b = boxes[p.i], color = MARK_COLORS[p.i % MARK_COLORS.length];
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(1, b.w - 1), Math.max(1, b.h - 1));
    // a hairline from badge to box when the badge had to sit away from it
    const bcx = p.x + p.w / 2, bcy = p.y + p.h / 2;
    if (bcx < b.x - 2 || bcx > b.x + b.w + 2 || bcy < b.y - 2 || bcy > b.y + b.h + 2) {
      ctx.globalAlpha = 0.45; ctx.beginPath();
      ctx.moveTo(bcx, bcy); ctx.lineTo(Math.max(b.x, Math.min(bcx, b.x + b.w)), Math.max(b.y, Math.min(bcy, b.y + b.h)));
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  for (const p of placed) {
    const color = MARK_COLORS[p.i % MARK_COLORS.length];
    ctx.fillStyle = color; ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = '#fff'; ctx.fillText(marks[p.i].ref, p.x + PAD, p.y + PAD);
  }
}

// Crosshair + ring marking exactly where a probed/clicked point landed.
function drawProbePoint(ctx, x, y) {
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  for (const r of [11, 9]) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = '#e11d48'; }
  ctx.beginPath();
  ctx.moveTo(x - 18, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 18, y);
  ctx.moveTo(x, y - 18); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 18);
  ctx.stroke();
  ctx.fillStyle = '#e11d48'; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
}

// chrome.tabs.get() reports an EMPTY url for a tab whose navigation hasn't committed yet — which is
// exactly the moment after a fresh attach or a just-started load, so the status header could come
// back with url:null and read as "we lost the page" when nothing was wrong. Fall back to the
// pending url, then to what the page itself says.
async function tabUrl(tabId, tab) {
  const t = tab || await chrome.tabs.get(tabId).catch(() => null);
  if (t?.url) return t.url;
  if (t?.pendingUrl) return t.pendingUrl;
  try {
    const r = await cmd(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    return r.result?.value || null;
  } catch { return null; }
}

// Actions that change page/UI state — attach a cheap status header (post-action url/title + new
// console error/warning counts) so the model can often skip a follow-up read_page. Best-effort:
// a failure here never affects the action's own result.
const ACTION_METHODS = new Set(['click', 'fill', 'typeText', 'pressKey', 'selectOption', 'scroll', 'drag', 'navigate', 'reload', 'hover', 'goBack', 'goForward', 'setFiles', 'handleDialog']);
// Let any ref-taking tool accept a CSS `selector` instead, resolved here so all of them gain it at
// once. Saves the dom_query round trip when you already know the selector — and it is strict on
// purpose: matching several elements is an ambiguous instruction, not a licence to take the first.
const REF_TOOLS = new Set(['click', 'fill', 'typeText', 'pressKey', 'selectOption', 'scroll', 'hover', 'drag', 'setFiles', 'selectText', 'generateLocator', 'screenshot', 'validate']);
async function resolveSelector(method, p) {
  if (!p || !p.selector || p.ref || !REF_TOOLS.has(method) || p.tabId == null) return p;
  await need(p.tabId);
  const s = st(p.tabId);
  const { root } = await cmd(p.tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeIds } = await cmd(p.tabId, 'DOM.querySelectorAll', { nodeId: root.nodeId, selector: p.selector });
  if (!nodeIds.length) throw new Error(`selector ${JSON.stringify(p.selector)} matched no element — check it with dom_query, or target by ref from read_page (a selector cannot cross into a cross-origin frame)`);
  if (nodeIds.length > 1) throw new Error(`selector ${JSON.stringify(p.selector)} matched ${nodeIds.length} elements — narrow it, or pick one with dom_query and act by ref`);
  const { node } = await cmd(p.tabId, 'DOM.describeNode', { nodeId: nodeIds[0] });
  const ref = 's' + (++s.seq);
  s.refs.set(ref, { backendNodeId: node.backendNodeId, sessionId: undefined });
  return { ...p, ref };
}

async function handle(method, p) {
  p = await resolveSelector(method, p);
  const tabId = p && p.tabId;
  const track = ACTION_METHODS.has(method) && tabId != null;
  const before = track ? (state.get(tabId)?.console.length ?? 0) : 0;
  const result = await dispatch(method, p);
  if (track && result && typeof result === 'object' && !result.__image) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const fresh = state.get(tabId)?.console.slice(before) || [];
      const errs = fresh.filter((m) => m.level === 'error').length;
      const warns = fresh.filter((m) => m.level === 'warning' || m.level === 'warn').length;
      const dialog = state.get(tabId)?.dialog;
      result.status = { url: await tabUrl(tabId, tab), title: tab.title || null, ...(errs ? { newConsoleErrors: errs } : {}), ...(warns ? { newConsoleWarnings: warns } : {}), ...(dialog ? { openDialog: dialog } : {}) };
    } catch { /* status is best-effort — never fail the action over it */ }
  }
  return result;
}

// ---- method dispatch ----
async function dispatch(method, p) {
  switch (method) {
    case 'getInfo': return { name: 'ClaudeBrowserBridge', version: VERSION, cdp: '1.3' };

    case 'getUserTabs': {
      const list = await chrome.tabs.query({});
      const out = [];
      for (const t of list) {
        if (t.id == null) continue;
        if (t.url && PRIVILEGED_URL.test(t.url)) continue; // hide browser/extension pages (incl. the credential popup)
        let group = null;
        if (t.groupId != null && t.groupId !== -1) {
          try { group = (await chrome.tabGroups.get(t.groupId)).title || null; } catch {}
        }
        out.push({ id: t.id, title: t.title, url: t.url, windowId: t.windowId, active: t.active, lastAccessed: t.lastAccessed, tabGroup: group });
      }
      out.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return { tabs: out };
    }

    // Browser organization (windows, groups, bookmarks) — the "tidy my tabs" surface, which is
    // separate from driving a page and needs no debugger at all.
    case 'manage': {
      const ns = String(p.namespace || ''), method = String(p.method || '');
      const api = { tabs: chrome.tabs, windows: chrome.windows, tabGroups: chrome.tabGroups, bookmarks: chrome.bookmarks }[ns];
      if (ns === 'audit') return { changes: auditTrail.slice().reverse() };
      if (!api) throw new Error(`unknown namespace "${ns}" — use tabs, windows, tabGroups, bookmarks, or audit`);
      if (!MANAGE_ALLOWED[ns].has(method)) throw new Error(`"${ns}.${method}" is not available — allowed: ${[...MANAGE_ALLOWED[ns]].join(', ')}`);
      if (typeof api[method] !== 'function') throw new Error(`this browser does not implement ${ns}.${method}`);
      const args = Array.isArray(p.args) ? p.args : [];
      // Snapshot before a mutation so the model can tell the user what changed and put it back.
      // Reads are the common case and must stay cheap, so only mutations pay for this.
      const mutating = MANAGE_MUTATING.has(ns + '.' + method);
      const before = mutating ? await layoutSnapshot(ns) : null;
      const result = await api[method](...args);
      if (mutating) {
        auditTrail.push({ at: new Date().toISOString(), namespace: ns, method, args, before });
        if (auditTrail.length > 100) auditTrail.shift();
      }
      return { ok: true, result: result === undefined ? null : result };
    }

    // Read one of the user's tabs WITHOUT claiming it: no debugger attach, so no "being debugged"
    // banner and nothing taken away from them. This is the right tool for "what does that other tab
    // say" — claiming a tab to read one number is disproportionate and visible to the user.
    // Cursor-paged so an observe-act-observe loop reads exactly the events its action caused:
    // read once to learn the cursor, act, then read from that cursor.
    case 'cdpEvents': {
      await need(p.tabId);
      const s = st(p.tabId);
      const all = s.events || [];
      const after = p.afterSequence != null ? Number(p.afterSequence) : null;
      const methods = Array.isArray(p.methods) && p.methods.length ? new Set(p.methods) : null;
      const limit = Math.min(Math.max(Number(p.limit) || 100, 1), 1000);
      let hits = all.filter((e) => (after == null || e.sequence > after) && (!methods || methods.has(e.method)));
      const hasMore = hits.length > limit;
      hits = hits.slice(0, limit);
      return {
        cursor: all.length ? all[all.length - 1].sequence : (s.evSeq || 0),
        events: hits, hasMore, truncated: !!s.evTruncated,
        ...(p.clear ? (s.events = [], s.evTruncated = false, { cleared: true }) : {}),
      };
    }

    // A ref is a pointer into THIS session's tree — it dies with the page. A locator is a rule for
    // finding the element again tomorrow, in a `run` script or a saved flow. This converts one to
    // the other, walking the durability ladder and reporting how many elements each candidate
    // actually matches, so a suggestion that is already ambiguous is visibly ambiguous.
    case 'generateLocator': {
      await need(p.tabId);
      const s = st(p.tabId);
      const { backendNodeId, sessionId } = refNode(p.tabId, p.ref);
      const dbg = dbgOf(p.tabId, sessionId);
      const objectId = await objectFor(dbg, backendNodeId);
      const r = await cmd(dbg, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function(){
          const el = this.nodeType === 3 ? this.parentElement : this;
          if (!el || !el.tagName) return null;
          const doc = el.ownerDocument;
          const count = (sel) => { try { return doc.querySelectorAll(sel).length; } catch { return -1; } };
          const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\\\]/g, '\\\\$&'));
          const at = (n) => (el.getAttribute ? el.getAttribute(n) : null);
          const tag = el.tagName.toLowerCase();
          const cands = [];
          const add = (kind, selector) => { if (selector) cands.push({ kind, selector, count: count(selector) }); };
          const testid = at('data-testid') || at('data-test-id') || at('data-test');
          if (testid) add('testid', '[data-testid="' + testid + '"]');
          // An id that looks generated (long hex, framework churn) is not durable, so don't lead with it.
          if (el.id && !/^[0-9]|:r[0-9a-z]+:|^[0-9a-f]{8,}$/i.test(el.id)) add('id', '#' + esc(el.id));
          for (const a of ['data-cy', 'data-qa', 'data-id', 'name']) { const v = at(a); if (v) add('attr', tag + '[' + a + '="' + v + '"]'); }
          const href = at('href');
          if (href && !/^https?:\\/\\/|^#$/.test(href)) add('href', 'a[href="' + href + '"]');
          const type = at('type'); if (type && /^(input|button)$/.test(tag)) add('type', tag + '[type="' + type + '"]');
          add('tag', tag);
          return {
            tag, text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
            ariaLabel: at('aria-label'), candidates: cands,
          };
        }`,
      });
      const info = r.result?.value;
      if (!info) throw new Error('that ref no longer resolves to an element — take a fresh read_page');

      // Role + accessible name is usually the most readable durable locator, and its uniqueness is
      // free: the tree from the last read_page already says how many elements share the pair.
      const ax = s.ax;
      let semantic = null;
      if (ax) {
        const me = [...ax.values()].find((e) => e.ref === p.ref);
        if (me && me.name) {
          const same = [...ax.values()].filter((e) => e.role === me.role && e.name === me.name).length;
          semantic = { kind: 'role', locator: `page.getByRole(${JSON.stringify(String(me.role).toLowerCase())}, { name: ${JSON.stringify(me.name)} })`, count: same };
        }
      }
      const unique = info.candidates.filter((c) => c.count === 1);
      const best = (semantic && semantic.count === 1)
        ? semantic.locator
        : unique.length ? `page.locator(${JSON.stringify(unique[0].selector)})` : null;
      return {
        best,
        ...(best ? {} : { warning: 'nothing here resolves to exactly one element — scope it to a container first (page.getByRole("row", {hasText:…}).getByRole(…))' }),
        ...(semantic ? { semantic } : {}),
        candidates: info.candidates,
        element: { tag: info.tag, text: info.text, ariaLabel: info.ariaLabel },
      };
    }

    case 'peekTab': {
      const t = await chrome.tabs.get(p.tabId);
      if (t.url && PRIVILEGED_URL.test(t.url)) throw new Error('cannot read a browser-internal page (' + t.url + ')');
      const limit = Math.min(Math.max(Number(p.limit) || 20000, 500), 200000);
      let res;
      try {
        [res] = await chrome.scripting.executeScript({
          target: { tabId: p.tabId },
          args: [limit],
          func: (max) => {
            const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
            return { title: document.title, url: location.href, text: text.slice(0, max), truncated: text.length > max, length: text.length };
          },
        });
      } catch (e) {
        // Chrome reports an injection into a discarded (auto-slept) tab as a *permission* error,
        // which sends you hunting through the manifest for a problem that isn't there. The tab
        // simply has no live document until something wakes it.
        const fresh = await chrome.tabs.get(p.tabId).catch(() => null);
        if (fresh?.discarded || fresh?.status === 'unloaded') {
          throw new Error('that tab is discarded (Chrome unloaded it to save memory), so it has no page to read yet — reload it first, or tab_claim it');
        }
        throw new Error('could not read that tab without claiming it (' + e.message + ') — the page may still be loading, or be a restricted origin; tab_claim gives full access');
      }
      return { peek: true, ...(res?.result || {}), tabGroup: t.groupId != null && t.groupId !== -1 ? (await chrome.tabGroups.get(t.groupId).catch(() => null))?.title || null : null };
    }

    case 'claimTab': {
      const tab = await chrome.tabs.get(p.tabId);
      // Refuse privileged/extension pages — notably our own credential popup, so the secret the user
      // types there can never be read back by claiming it.
      if (tab.url && PRIVILEGED_URL.test(tab.url)) throw new Error('cannot claim a browser/extension page');
      await attach(p.tabId);
      return { id: p.tabId, title: tab.title, url: tab.url, claimed: true };
    }
    case 'createTab': {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: !!p.active });
      await attach(tab.id);
      await markAgentTab(tab.id); // tab_close may only close tabs the agent opened
      let grouped = null;
      if (p.group) { // put the tab in a topic group — reuse an existing group of that name, else create one
        try {
          const existing = await chrome.tabGroups.query({ title: String(p.group), windowId: tab.windowId });
          if (existing && existing.length) { await chrome.tabs.group({ tabIds: [tab.id], groupId: existing[0].id }); grouped = String(p.group); }
          else { const gid = await chrome.tabs.group({ tabIds: [tab.id] }); await chrome.tabGroups.update(gid, { title: String(p.group) }); grouped = String(p.group); }
        } catch {}
      }
      return { id: tab.id, url: await tabUrl(tab.id, tab), ...(grouped ? { group: grouped } : {}) };
    }
    case 'activateTab': { const t = await chrome.tabs.get(p.tabId); await chrome.windows.update(t.windowId, { focused: true }); await chrome.tabs.update(p.tabId, { active: true }); return { ok: true }; }
    case 'reload': { await need(p.tabId); await cmd(p.tabId, 'Page.reload', {}); return { ok: true }; }
    case 'release': { await detach(p.tabId); return { ok: true }; }

    case 'navigate': {
      await need(p.tabId);
      const cur = (await chrome.tabs.get(p.tabId)).url;
      if (cur === p.url) return { ok: true, skipped: 'already on url' };
      await cmd(p.tabId, 'Page.navigate', { url: p.url });
      if (p.waitUntil !== 'none') { // settle so the next read isn't racing the load
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const r = await cmd(p.tabId, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => ({}));
          if (r.result?.value === 'complete') break;
          await new Promise((res) => setTimeout(res, 120));
        }
      }
      return { ok: true };
    }

    case 'readPage': {
      await need(p.tabId);
      const s = st(p.tabId);
      // Identity is the DOM node (backendDOMNodeId within its frame session), not the position in
      // the tree. That is what makes both halves of this work: a ref stays valid for as long as its
      // element lives — so the model can act on an element it saw two reads ago — and "what changed
      // since the last read" becomes a set operation instead of a guess.
      const cur = new Map();
      let anon = 0;
      const generics = [];   // role-less main-frame nodes with a DOM node, to be promoted by geometry
      let mainById = null;   // AX nodes of the main frame by id, for ancestor walks
      outer: for (const sessionId of [undefined, ...s.frames.keys()]) { // main frame + each cross-origin iframe
        let nodes;
        try { nodes = (await cmd(dbgOf(p.tabId, sessionId), 'Accessibility.getFullAXTree', {})).nodes; } catch { continue; }
        const byId = new Map(nodes.map((n) => [n.nodeId, n]));
        if (!sessionId) mainById = byId;
        for (const n of nodes) {
          if (n.ignored) continue;
          const role = n.role?.value; if (!role) continue;
          // A <div onclick> has the AX role "generic" and no accessible name, so the tree alone
          // would drop it and the element could never be targeted. Park it; the geometry pass
          // decides whether the page actually treats it as clickable.
          if (role === 'none' || role === 'generic') {
            if (n.backendDOMNodeId != null && !sessionId) generics.push(n);
            continue;
          }
          // Chrome's per-line layout boxes. They have no DOM node, so they can never be targeted,
          // and they restate the StaticText directly above them — on a text-heavy page that is a
          // third of the tree spent saying everything twice.
          if (role === 'InlineTextBox') continue;
          const name = (n.name?.value || '').trim();
          const interactive = INTERACTIVE.has(role);
          if (!interactive && !name) continue;
          // A control's label is also published as a StaticText child, so a button arrives as two
          // entries that mean the same thing — and the model has to pick, with only one of them
          // clickable. Keep the control.
          if (role === 'StaticText' && name) {
            let up = byId.get(n.parentId), hops = 0, dup = false;
            while (up && hops++ < 4) {
              if (INTERACTIVE.has(up.role?.value) && (up.name?.value || '').trim() === name) { dup = true; break; }
              up = byId.get(up.parentId);
            }
            if (dup) continue;
          }
          const bid = n.backendDOMNodeId;
          // A node with no DOM backing can never be targeted, so it gets no ref and an identity that
          // is only good for this read — it shows up as page structure, never as a click target.
          const key = bid != null ? (sessionId || '-') + ':' + bid : 'anon:' + (++anon);
          if (cur.has(key)) continue;
          const val = n.value?.value;
          cur.set(key, {
            role, name: cleanName(name).slice(0, 160),
            ...(val != null ? { value: String(val).slice(0, 80) } : {}),
            ...(sessionId ? { frame: true } : {}),
            __bid: bid, __sid: sessionId,
          });
          if (cur.size >= 500) break outer;
        }
      }

      // Enrich the main frame with geometry + attributes. Best-effort: if the snapshot fails we
      // still return a perfectly usable tree, just without the covered/format annotations.
      const geo = await domSnapshotIndex(p.tabId);
      let coveredCount = 0;
      if (geo) {
        const buried = occludedNodes(geo);
        for (const e of cur.values()) {
          if (e.__bid == null) continue;
          const g = geo.nodes.get(e.__bid);
          if (!g) continue;
          const type = (g.attrs.type || '').toLowerCase();
          // A password's value must never reach the transcript, whatever the AX tree offers.
          if (type === 'password') delete e.value;
          if (DATE_FORMATS[type] && !e.value) e.format = DATE_FORMATS[type];
          // Only worth saying about something you would actually try to click. A landmark or a
          // container being overlapped is normal page layout, not a problem to report.
          if (INTERACTIVE.has(e.role) && buried.has(e.__bid)) { e.covered = true; coveredCount++; }
        }
        // Promote role-less elements the page makes clickable: cursor:pointer, or an onclick /
        // tabindex attribute. cursor inherits, so a span inside a link qualifies too — the ancestor
        // walk keeps those out, and an element inside something already promoted is skipped so a
        // clickable card does not bring every child along with it. Capped: on a page where
        // everything is a pointer target this would otherwise undo the pruning win entirely.
        let promoted = 0;
        const promotedIds = new Set();
        const labelOf = (n) => {
          const out = []; const q = [...(n.childIds || [])]; let seen = 0;
          while (q.length && seen++ < 16 && out.join(' ').length < 80) {
            const c = mainById.get(q.shift()); if (!c) continue;
            const r = c.role?.value;
            if (r === 'StaticText') { const t = (c.name?.value || '').trim(); if (t) out.push(t); }
            else if (r !== 'InlineTextBox') q.push(...(c.childIds || []));
          }
          return cleanName(out.join(' ')).slice(0, 80);
        };
        for (const n of generics) {
          if (promoted >= 80) break;
          const g = geo.nodes.get(n.backendDOMNodeId); if (!g) continue;
          const clickable = g.cursor === 'pointer' || 'onclick' in g.attrs || ('tabindex' in g.attrs && g.attrs.tabindex !== '-1');
          if (!clickable) continue;
          let up = mainById.get(n.parentId), hops = 0, inside = false;
          while (up && hops++ < 8) {
            if (INTERACTIVE.has(up.role?.value) || promotedIds.has(up.nodeId)) { inside = true; break; }
            up = mainById.get(up.parentId);
          }
          if (inside) continue;
          const label = (g.attrs['aria-label'] || g.attrs.title || '').trim() || labelOf(n);
          if (!label) continue; // nothing to name it by, and a nameless target is not usable
          const key = '-:' + n.backendDOMNodeId;
          if (cur.has(key)) continue;
          promotedIds.add(n.nodeId);
          promoted++;
          const e = { role: 'clickable', name: label, __bid: n.backendDOMNodeId, __sid: undefined };
          if (buried.has(e.__bid)) { e.covered = true; coveredCount++; }
          cur.set(key, e);
        }
      }

      const prev = s.ax; // Map(key -> {ref, role, name, value, frame}) from the previous read
      // Retire refs whose element is gone, so a stale ref errors instead of silently re-aliasing
      // onto whatever node inherited its id.
      if (prev) for (const [k, e] of prev) if (!cur.has(k) && e.ref) s.refs.delete(e.ref);

      const next = new Map();
      const added = [], changed = [];
      let unchanged = 0;
      for (const [k, e] of cur) {
        const was = prev && prev.get(k);
        let ref = was && was.ref;
        if (e.__bid != null) {
          if (!ref) ref = 'e' + (++s.seq);
          s.refs.set(ref, { backendNodeId: e.__bid, sessionId: e.__sid });
        } else ref = null;
        const shown = { ref, role: e.role, name: e.name, ...(e.value != null ? { value: e.value } : {}), ...(e.format ? { format: e.format } : {}), ...(e.covered ? { covered: true } : {}), ...(e.frame ? { frame: true } : {}) };
        next.set(k, shown);
        if (!was) added.push(shown);
        else if (was.name !== e.name || was.value !== e.value || was.role !== e.role) {
          changed.push({ ...shown, was: { ...(was.name !== e.name ? { name: was.name } : {}), ...(was.value !== e.value ? { value: was.value } : {}), ...(was.role !== e.role ? { role: was.role } : {}) } });
        } else unchanged++;
      }
      const removed = [];
      if (prev) for (const [k, e] of prev) if (!cur.has(k)) removed.push({ role: e.role, name: e.name });
      s.ax = next;

      const url = (await chrome.tabs.get(p.tabId)).url;
      const frames = s.frames.size ? { frames: s.frames.size } : {};
      // An overlay is the single most common reason a click does nothing, and the a11y tree gives no
      // hint of it. Say it once, as a count, rather than flipping a flag on every buried element.
      const overlay = coveredCount ? { covered: coveredCount, hint: coveredCount + ' element(s) are painted over by an overlay (modal, dropdown, cookie banner) and cannot be clicked until it is dismissed. They are marked covered:true.' } : {};
      // A page with almost nothing on it is usually mid-load, not genuinely empty — worth saying,
      // because the alternative is the model concluding the content does not exist.
      const thin = next.size < 10 ? { note2: 'Very few elements — the page is probably still loading or rendering. wait_for a known element before concluding anything is missing.' } : {};
      // Full tree on the first read of a tab, or on demand. Otherwise only the delta — in an
      // act-then-look loop almost every element is unchanged, and re-sending the whole tree each
      // time is the single biggest source of wasted tokens in a browser session.
      if (!prev || p.full) {
        return { url, count: next.size, elements: [...next.values()], ...overlay, ...thin, ...frames };
      }
      if (!added.length && !changed.length && !removed.length) {
        return { url, diff: true, unchanged: true, total: next.size, ...overlay, ...thin, note: 'No accessibility change since the last read_page. Refs from the previous read are still valid. Do not repeat this call without acting first — if you expected a change, the action did not land: look for an overlay/disabled control (screenshot:true), or the page may still be loading (wait_for).', ...frames };
      }
      return {
        url, diff: true, total: next.size, unchanged, ...overlay, ...thin,
        ...(added.length ? { added } : {}), ...(changed.length ? { changed } : {}), ...(removed.length ? { removed } : {}),
        note: 'Delta since the last read_page; unchanged elements are omitted and their refs remain valid. Pass full:true for the whole tree.',
        ...frames,
      };
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
        const ref = 'q' + (++s.seq); s.refs.set(ref, { backendNodeId, sessionId: undefined });
        const attrs = {}; const a = desc.attributes || [];
        for (let i = 0; i < a.length; i += 2) attrs[a[i]] = a[i + 1];
        matches.push({ ref, tag: (desc.nodeName || '').toLowerCase(), href: attrs.href, id: attrs.id, class: attrs.class });
      }
      return { count: nodeIds.length, returned: matches.length, matches };
    }

    case 'find': {
      // heuristic over the a11y tree (main + cross-origin frames): rank interactive nodes by fuzzy match
      await need(p.tabId);
      const s = st(p.tabId); // append 'f' refs with a monotonic seq — never clobber read_page's 'e' refs
      const q = String(p.query || '').toLowerCase();
      const terms = q.split(/\s+/).filter(Boolean);
      const scored = [];
      for (const sessionId of [undefined, ...s.frames.keys()]) {
        let nodes;
        try { nodes = (await cmd(dbgOf(p.tabId, sessionId), 'Accessibility.getFullAXTree', {})).nodes; } catch { continue; }
        for (const n of nodes) {
          if (n.ignored || n.backendDOMNodeId == null) continue;
          const role = n.role?.value || ''; const name = (n.name?.value || '').trim();
          if (!INTERACTIVE.has(role) && !name) continue;
          const hay = (role + ' ' + name).toLowerCase();
          let score = 0; for (const t of terms) if (hay.includes(t)) score += t.length;
          if (name && q.includes(name.toLowerCase())) score += 5;
          if (score <= 0) continue;
          const ref = 'f' + (++s.seq); s.refs.set(ref, { backendNodeId: n.backendDOMNodeId, sessionId });
          scored.push({ ref, role, name: cleanName(name).slice(0, 160), score, ...(sessionId ? { frame: true } : {}) });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return { candidates: scored.slice(0, 10).map(({ score, ...c }) => c) };
    }

    case 'click': {
      await need(p.tabId);
      let x, y, node = null, intended = null;
      if (p.ref != null) {
        node = refNode(p.tabId, p.ref);
        const c = await absCenter(p.tabId, node.backendNodeId, node.sessionId);
        x = c.x; y = c.y;
        intended = await describeNode(p.tabId, node.backendNodeId, node.sessionId);
      } else {
        const pt = await pointOf(p.tabId, p);
        if (!pt) throw new Error('click needs a ref or {x,y}');
        x = pt.x; y = pt.y;
      }
      const geo = await pageGeometry(p.tabId);
      if (x < 0 || y < 0 || x > geo.viewport.width || y > geo.viewport.height) {
        throw new Error(`point (${Math.round(x)},${Math.round(y)}) is outside the ${geo.viewport.width}x${geo.viewport.height} viewport`
          + ' — scroll it into view, or pass space:"image"/"page" if the coordinate came from a screenshot');
      }
      // What is really under the cursor BEFORE we press. This is the receipt: a click swallowed by
      // an overlay/cookie banner says so instead of reporting a bare ok.
      const [before, covered] = await Promise.all([
        hitTest(p.tabId, x, y),
        node ? checkCovered(p.tabId, node.backendNodeId, node.sessionId, x, y) : Promise.resolve(null),
      ]);
      const button = p.button === 'right' ? 'right' : p.button === 'middle' ? 'middle' : 'left';
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); // settle :hover before pressing
      for (const clickCount of (p.double ? [1, 2] : [1])) {
        await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
        await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
      }
      const out = { ok: true, point: { x: Math.round(x), y: Math.round(y) }, landedOn: before?.hit || null };
      if (before?.clickable) out.nearestClickable = before.clickable;
      if (covered?.covered) {
        const by = covered.by;
        out.intercepted = `click at (${Math.round(x)},${Math.round(y)}) was over `
          + (by ? `<${by.tag}>${by.label ? ` "${by.label}"` : ''}` : 'nothing hit-testable')
          + `, not the ref's <${intended?.tag || '?'}>${intended?.label ? ` "${intended.label}"` : ''}`
          + ' — something is covering the target (modal, cookie banner, sticky header). Clear it and retry.';
      }
      return out;
    }

    case 'probePoint': {
      // Point-to-element: hand back what is really at a coordinate, with a ref you can click and a
      // selector you can reuse — so a coordinate guess converts into a reliable semantic target
      // instead of a blind retry.
      await need(p.tabId);
      const pt = await pointOf(p.tabId, p);
      if (!pt) throw new Error('probe_point needs {x,y}');
      const geo = await pageGeometry(p.tabId);
      const outside = pt.x < 0 || pt.y < 0 || pt.x > geo.viewport.width || pt.y > geo.viewport.height;
      const info = outside ? null : await hitTest(p.tabId, pt.x, pt.y);
      const out = {
        requested: { x: p.x, y: p.y, space: p.space || 'viewport' },
        viewportPoint: { x: Math.round(pt.x), y: Math.round(pt.y) },
        viewport: geo.viewport, scroll: geo.scroll,
        ...(outside ? { outsideViewport: true } : {}),
        ...(info || {}),
      };
      // Register a ref for the element actually there, so the next call can target it properly.
      if (info?.hit) {
        try {
          const { backendNodeId } = await cmd(p.tabId, 'DOM.getNodeForLocation', { x: Math.round(pt.x), y: Math.round(pt.y), includeUserAgentShadowDOM: false });
          if (backendNodeId != null) { const s = st(p.tabId); const ref = 'p' + (++s.seq); s.refs.set(ref, { backendNodeId, sessionId: undefined }); out.ref = ref; }
        } catch {}
      }
      if (p.annotate) { // picture of exactly where that point is, so a miss is visible not inferred
        const shot = await captureShot(p.tabId, { point: pt, marks: !!p.marks });
        return { __image: shot.image, mimeType: 'image/png', __meta: { ...out, screenshot: shot.shot, ...(shot.marks ? { marks: shot.marks } : {}) } };
      }
      return out;
    }

    case 'fill': {
      await need(p.tabId);
      const { backendNodeId, sessionId } = refNode(p.tabId, p.ref);
      const dbg = dbgOf(p.tabId, sessionId);
      const objectId = await objectFor(dbg, backendNodeId);
      // Read the value back in the same call. A phone/date/currency/card field with an input mask
      // silently rewrites what you set, and a maxlength quietly truncates it — so "fill succeeded"
      // is not the same as "the field holds what you asked for". Reporting the difference here is
      // what turns a wrong value discovered three steps later into one you see immediately.
      const r = await cmd(dbg, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function(v){
          this.focus && this.focus();
          const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value");
          if (d && d.set) d.set.call(this, v); else this.value = v;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return { got: this.value, secret: this.type === "password", type: (this.type || "").toLowerCase() };
        }`,
        arguments: [{ value: String(p.value ?? '') }],
      });
      const want = String(p.value ?? '');
      const { got, secret, type } = r.result?.value || {};
      // A date/time input silently rejects anything not in its wire format, leaving the field empty
      // while the page still displays a locale mask like mm/dd/yyyy. Without this the model sets a
      // perfectly reasonable-looking value, sees no error, and moves on with an empty field.
      if (DATE_FORMATS[type] && got === '' && want !== '') {
        throw new Error(`this is an <input type="${type}"> — it only accepts ${DATE_FORMATS[type]}, and rejected ${JSON.stringify(want)}, leaving the field empty. The mm/dd/yyyy you see is just how Chrome displays it. Re-fill using ${DATE_FORMATS[type]}.`);
      }
      if (got === want || got === undefined) return { ok: true };
      // Never echo a password back, even to report a mismatch.
      if (secret) return { ok: true, mismatch: 'the field did not keep the value exactly (length ' + String(got).length + ' vs ' + want.length + ')' };
      return { ok: true, mismatch: 'the field now holds ' + JSON.stringify(String(got).slice(0, 120)) + ', not what you set — an input mask or maxlength rewrote it. Reconcile before continuing.', value: got };
    }
    // Put the caret somewhere specific inside existing text, instead of the only two positions a
    // click gives you (wherever you happened to hit) or fill gives you (everything replaced).
    // This is what makes "change just this word" a single action rather than clear-and-retype.
    case 'selectText': {
      await need(p.tabId);
      const { backendNodeId, sessionId } = refNode(p.tabId, p.ref);
      const dbg = dbgOf(p.tabId, sessionId);
      const objectId = await objectFor(dbg, backendNodeId);
      const r = await cmd(dbg, 'Runtime.callFunctionOn', {
        objectId, returnByValue: true,
        functionDeclaration: `function(text, prefix, suffix, how){
          // A StaticText ref from read_page resolves to a TEXT NODE, not an element. A TreeWalker
          // rooted at a text node yields nothing, so climb to the containing element first.
          const host = this.nodeType === 3 ? this.parentElement : this;
          if (!host) return { ok: false, reason: 'this ref no longer has a containing element' };
          host.focus && host.focus();
          const editable = host.value !== undefined && (host.tagName === 'INPUT' || host.tagName === 'TEXTAREA');
          const hay = editable ? String(host.value) : (host.innerText || host.textContent || '');
          // prefix/suffix disambiguate which occurrence is meant when the text repeats.
          const needle = (prefix || '') + text + (suffix || '');
          const at = hay.indexOf(needle);
          if (at < 0) return { ok: false, reason: 'text not found in this element', length: hay.length, sample: hay.slice(0, 200) };
          if (hay.indexOf(needle, at + 1) >= 0) return { ok: false, reason: 'ambiguous — that text appears more than once; add prefix/suffix to pin the occurrence' };
          const s = at + (prefix || '').length, e = s + text.length;
          const from = how === 'after' ? e : s;
          const to = how === 'before' ? s : how === 'after' ? e : e;
          if (editable) { host.setSelectionRange(from, to); return { ok: true, start: from, end: to }; }
          // contenteditable / static text: walk text nodes to convert the string offset into a Range.
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
          let seen = 0, a = null, b = null, n;
          while ((n = walker.nextNode())) {
            const len = n.nodeValue.length;
            if (!a && seen + len >= from) a = [n, from - seen];
            if (!b && seen + len >= to) { b = [n, to - seen]; break; }
            seen += len;
          }
          if (!a || !b) return { ok: false, reason: 'could not map the offset onto the rendered text nodes' };
          const range = document.createRange();
          range.setStart(a[0], a[1]); range.setEnd(b[0], b[1]);
          const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          return { ok: true, start: from, end: to };
        }`,
        arguments: [{ value: String(p.text ?? '') }, { value: String(p.prefix ?? '') }, { value: String(p.suffix ?? '') }, { value: String(p.selectionType || 'select') }],
      });
      const out = r.result?.value || {};
      if (!out.ok) throw new Error('select_text: ' + (out.reason || 'failed') + (out.sample ? ' — element text starts: ' + JSON.stringify(out.sample) : ''));
      return out;
    }
    case 'typeText': { // real per-char keystrokes (keyDown+keyUp) so search-as-you-type / key-filtered / per-key OTP widgets fire
      await need(p.tabId);
      for (const ch of String(p.text ?? '')) {
        const up = ch.toUpperCase(); const code = /^[a-z]$/i.test(ch) ? 'Key' + up : /^[0-9]$/.test(ch) ? 'Digit' + ch : '';
        const kc = /^[a-z0-9]$/i.test(ch) ? up.charCodeAt(0) : 0;
        await cmd(p.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code, windowsVirtualKeyCode: kc });
        await cmd(p.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: kc });
      }
      return { ok: true };
    }
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
      // A printable key with no Alt/Ctrl/Meta must carry `text`, or CDP fires the event without
      // inserting the character (a chord like Ctrl+A intentionally omits text — it's a shortcut).
      const printable = base.length === 1 && !(modifiers & (1 | 2 | 4));
      const textField = printable ? { text: base } : {};
      await cmd(p.tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...k, ...textField });
      await cmd(p.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
      return { ok: true };
    }
    case 'scroll': {
      await need(p.tabId);
      if (p.ref != null) { const { backendNodeId, sessionId } = refNode(p.tabId, p.ref); await cmd(dbgOf(p.tabId, sessionId), 'DOM.scrollIntoViewIfNeeded', { backendNodeId }); return { ok: true }; }
      const pt = (await pointOf(p.tabId, p)) || { x: 100, y: 100 };
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: p.dx || 0, deltaY: p.dy || 300 });
      return { ok: true };
    }
    case 'selectOption': {
      await need(p.tabId);
      const { backendNodeId, sessionId } = refNode(p.tabId, p.ref);
      const dbg = dbgOf(p.tabId, sessionId);
      const objectId = await objectFor(dbg, backendNodeId);
      const r = await cmd(dbg, 'Runtime.callFunctionOn', {
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
      const from = p.fromRef != null ? await refPoint(p.tabId, p.fromRef) : await toViewport(p.tabId, p.fromX, p.fromY, p.space);
      const to = p.toRef != null ? await refPoint(p.tabId, p.toRef) : await toViewport(p.tabId, p.toX, p.toY, p.space);
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left' });
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      return { ok: true };
    }

    case 'screenshot': {
      await need(p.tabId);
      const shot = await captureShot(p.tabId, p);
      // Geometry per mark is only useful for coordinate work; the badge is clicked by ref. Dropping
      // it by default roughly halves the payload on a link-dense page — pass boxes:true to get it.
      const marks = shot.marks && (p.boxes
        ? shot.marks
        : shot.marks.map((m) => ({ ref: m.ref, role: m.role, ...(m.name ? { name: m.name } : {}) })));
      return {
        __image: shot.image, mimeType: 'image/png',
        __meta: { screenshot: shot.shot, ...(marks ? { markCount: marks.length, marks } : {}) },
      };
    }

    case 'findText': {
      await need(p.tabId);
      const q = String(p.query ?? '');
      if (!q) throw new Error('find_text needs a non-empty query');
      const max = Math.min(p.limit || 20, 50);
      const r = await cmd(p.tabId, 'Runtime.evaluate', {
        expression: `(()=>{const q=${JSON.stringify(q)},rx=${p.regex ? 'true' : 'false'},max=${max};
          const t=document.body?document.body.innerText:'';const out=[];let count=0;
          const push=(i,len)=>{if(out.length<max){const s=Math.max(0,i-40);out.push(t.slice(s,i+len+40).replace(/\\s+/g,' ').trim());}};
          if(rx){const re=new RegExp(q,'gi');let m;while((m=re.exec(t))&&count<10000){count++;push(m.index,m[0].length);if(m.index===re.lastIndex)re.lastIndex++;}}
          else{const hay=t.toLowerCase(),n=q.toLowerCase();let i=0;while((i=hay.indexOf(n,i))>=0&&count<10000){count++;push(i,n.length);i+=n.length;}}
          return{count,contexts:out};})()`,
        returnByValue: true,
      });
      const v = r.result?.value || { count: 0, contexts: [] };
      return { query: q, count: v.count, matches: v.contexts };
    }

    // "Did it land?" as one cheap, deterministic call. Every check runs and reports its evidence, so
    // a failed assertion says what the page actually shows rather than just "no". No model is
    // consulted here on purpose: the outer model reads the evidence, and a nested classifier would
    // add cost and a second opinion without adding facts.
    case 'validate': {
      await need(p.tabId);
      const checks = [];
      const t = await chrome.tabs.get(p.tabId);
      const url = t.url || '';
      if (p.urlIncludes != null) checks.push({ check: 'urlIncludes', want: p.urlIncludes, ok: url.includes(String(p.urlIncludes)), got: url });
      if (p.urlMatches != null) { let ok = false; try { ok = new RegExp(String(p.urlMatches)).test(url); } catch { checks.push({ check: 'urlMatches', want: p.urlMatches, ok: false, got: 'invalid regex' }); }
        if (!checks.some((c) => c.check === 'urlMatches')) checks.push({ check: 'urlMatches', want: p.urlMatches, ok, got: url }); }
      if (p.titleIncludes != null) checks.push({ check: 'titleIncludes', want: p.titleIncludes, ok: String(t.title || '').includes(String(p.titleIncludes)), got: t.title });
      const textCount = async (q) => {
        const r = await cmd(p.tabId, 'Runtime.evaluate', { returnByValue: true, expression: `(()=>{const t=(document.body?document.body.innerText:'').toLowerCase();const n=${JSON.stringify(String(q).toLowerCase())};let i=0,c=0;while((i=t.indexOf(n,i))>=0&&c<1000){c++;i+=n.length;}return c;})()` });
        return r.result?.value ?? 0;
      };
      for (const q of [].concat(p.text ?? [])) { const c = await textCount(q); checks.push({ check: 'text', want: q, ok: c > 0, got: c + ' occurrence(s)' }); }
      for (const q of [].concat(p.textAbsent ?? [])) { const c = await textCount(q); checks.push({ check: 'textAbsent', want: q, ok: c === 0, got: c + ' occurrence(s)' }); }
      if (p.ref) {
        const { backendNodeId, sessionId } = refNode(p.tabId, p.ref);
        const dbg = dbgOf(p.tabId, sessionId);
        const objectId = await objectFor(dbg, backendNodeId);
        const r = await cmd(dbg, 'Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: `function(){
          const el = this.nodeType === 3 ? this.parentElement : this; if (!el) return null;
          const cs = getComputedStyle(el), b = el.getBoundingClientRect();
          const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && b.width > 0 && b.height > 0;
          const checked = typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true';
          const enabled = !(el.disabled || el.getAttribute('aria-disabled') === 'true');
          return { visible, checked, enabled, value: 'value' in el ? String(el.value) : null, text: (el.innerText || el.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 300), secret: el.type === 'password' };
        }` });
        const e = r.result?.value;
        if (!e) checks.push({ check: 'element', ok: false, got: 'ref no longer resolves to an element' });
        else {
          if (p.visible != null) checks.push({ check: 'visible', want: p.visible, ok: e.visible === !!p.visible, got: e.visible });
          if (p.enabled != null) checks.push({ check: 'enabled', want: p.enabled, ok: e.enabled === !!p.enabled, got: e.enabled });
          if (p.checked != null) checks.push({ check: 'checked', want: p.checked, ok: e.checked === !!p.checked, got: e.checked });
          if (p.value != null) checks.push({ check: 'value', want: e.secret ? '(secret)' : p.value, ok: e.value === String(p.value), got: e.secret ? '(secret, length ' + String(e.value ?? '').length + ')' : e.value });
          if (p.textContains != null) checks.push({ check: 'textContains', want: p.textContains, ok: e.text.toLowerCase().includes(String(p.textContains).toLowerCase()), got: e.text.slice(0, 120) });
        }
      }
      if (!checks.length) throw new Error('validate: nothing to check — pass urlIncludes/urlMatches/titleIncludes/text/textAbsent, or a ref/selector with visible/enabled/checked/value/textContains');
      const failed = checks.filter((c) => !c.ok);
      return { ok: failed.length === 0, passed: checks.length - failed.length, ...(failed.length ? { failed } : {}), checks };
    }

    case 'hover': {
      await need(p.tabId);
      const c = p.ref != null ? await refPoint(p.tabId, p.ref) : await pointOf(p.tabId, p);
      if (!c) throw new Error('hover needs a ref or {x,y}');
      await cmd(p.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
      return { ok: true };
    }

    case 'readConsole': { const s = st(p.tabId); const out = s.console.slice(-(p.limit || 50)); if (p.clear) s.console = []; return { messages: out }; }
    case 'readNetwork': { const s = st(p.tabId); const out = [...s.network.values()].slice(-(p.limit || 50)); if (p.clear) s.network.clear(); return { requests: out }; }

    case 'getNetworkBody': {
      await need(p.tabId);
      const r = await cmd(p.tabId, 'Network.getResponseBody', { requestId: p.requestId });
      let body = r.body || '';
      const full = body.length;
      const cap = p.limit || 20000;
      if (body.length > cap) body = body.slice(0, cap);
      return { body, base64Encoded: !!r.base64Encoded, truncated: full > cap, length: full };
    }

    case 'handleDialog': {
      await need(p.tabId);
      await cmd(p.tabId, 'Page.handleJavaScriptDialog', { accept: p.accept !== false, ...(p.promptText != null ? { promptText: String(p.promptText) } : {}) });
      st(p.tabId).dialog = null;
      return { ok: true };
    }
    case 'getDialog': { return { dialog: state.get(p.tabId)?.dialog || null }; }

    case 'setFiles': {
      await need(p.tabId);
      const { backendNodeId, sessionId } = refNode(p.tabId, p.ref);
      const files = Array.isArray(p.paths) ? p.paths : [p.paths];
      await cmd(dbgOf(p.tabId, sessionId), 'DOM.setFileInputFiles', { files, backendNodeId });
      return { ok: true, files };
    }

    case 'closeAgentTab': {
      if (!(await isAgentTab(p.tabId))) throw new Error('refusing to close a tab the agent did not open — use tab_release to hand it back');
      await detach(p.tabId).catch(() => {});
      await chrome.tabs.remove(p.tabId);
      await forgetAgentTab(p.tabId);
      return { ok: true, closed: p.tabId };
    }

    case 'goBack': { await need(p.tabId); await cmd(p.tabId, 'Runtime.evaluate', { expression: 'history.back()' }); return { ok: true }; }
    case 'goForward': { await need(p.tabId); await cmd(p.tabId, 'Runtime.evaluate', { expression: 'history.forward()' }); return { ok: true }; }

    case 'waitFor': {
      await need(p.tabId);
      const deadline = Date.now() + Math.min(p.timeoutMs || 10000, 25000); // under the 30s host timeout
      const s = st(p.tabId);
      const ev = (expr) => cmd(p.tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result?.value).catch(() => undefined);
      while (Date.now() < deadline) {
        if (p.selector) { if (await ev(`!!document.querySelector(${JSON.stringify(p.selector)})`)) return { ok: true, matched: 'selector' }; }
        else if (p.textGone != null) { if (await ev(`!(document.body?.innerText||'').includes(${JSON.stringify(p.textGone)})`)) return { ok: true, matched: 'textGone' }; }
        else if (p.text != null) { if (await ev(`(document.body?.innerText||'').includes(${JSON.stringify(p.text)})`)) return { ok: true, matched: 'text' }; }
        else if (p.urlIncludes != null) { const t = await chrome.tabs.get(p.tabId); if ((t.url || '').includes(p.urlIncludes)) return { ok: true, matched: 'url', url: t.url }; }
        else if (p.state === 'networkidle') { if (s.lastRequestTs && Date.now() - s.lastRequestTs > 500) return { ok: true, matched: 'networkidle' }; }
        else { if ((await ev('document.readyState')) === 'complete') return { ok: true, matched: 'load' }; }
        await new Promise((res) => setTimeout(res, 120));
      }
      return { ok: false, timedOut: true };
    }

    case 'listDownloads': { return { downloads: [...downloads.values()].sort((a, b) => b.ts - a.ts).slice(0, p.limit || 10) }; }
    case 'waitDownload': {
      // Wait for a download to COMPLETE (one triggered by the action you just took). Returns its
      // absolute path so Claude Code can Read it. Ignores downloads already complete before now.
      const deadline = Date.now() + Math.min(p.timeoutMs || 30000, 120000);
      const seen = new Set([...downloads.values()].filter((d) => d.state === 'complete').map((d) => d.id));
      while (Date.now() < deadline) {
        const done = [...downloads.values()].filter((d) => d.state === 'complete' && !seen.has(d.id)).sort((a, b) => b.ts - a.ts)[0];
        if (done) {
          let path = done.filename, bytes;
          try { const res = await chrome.downloads.search({ id: done.id }); if (res?.[0]) { path = res[0].filename; bytes = res[0].fileSize; } } catch {}
          return { ok: true, path, url: done.url, ...(bytes != null ? { bytes } : {}) };
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      return { ok: false, timedOut: true };
    }

    case 'requestCredential': {
      await need(p.tabId);
      let origin = ''; try { origin = new URL((await chrome.tabs.get(p.tabId)).url).origin; } catch {}
      const token = (crypto.randomUUID && crypto.randomUUID()) || 't' + Date.now() + Math.random();
      // spec sent to the popup carries labels/types only — never values (there are none yet)
      const spec = { origin, reason: p.reason || '', fields: (p.fields || []).map((f) => ({ id: f.id, label: f.label, type: f.type })) };
      return await new Promise((resolve) => {
        let winId = null;
        const finish = (status) => { if (!pendingCredentials.has(token)) return; pendingCredentials.delete(token); clearTimeout(timer); if (winId != null) chrome.windows.remove(winId).catch(() => {}); resolve({ status }); };
        const timer = setTimeout(() => finish('expired'), Math.min(p.timeoutMs || 180000, 300000));
        pendingCredentials.set(token, { spec, tabId: p.tabId, origin, fields: p.fields || [], submit: p.submit, finish });
        chrome.windows.create({ type: 'popup', url: chrome.runtime.getURL('credential.html') + '?token=' + token, width: 460, height: 440, focused: true }, (w) => { winId = w?.id ?? null; });
      });
    }

    case 'executeCdp': { await need(p.tabId); return await cmd(dbgOf(p.tabId, p.sessionId), p.cdpMethod, p.cdpParams || {}); }
    // Frame plumbing for the host-side programmable `page` API (run tool): enumerate cross-origin
    // frame sessions and get a frame's accumulated top-viewport offset for coordinate translation.
    case 'listFrames': { await need(p.tabId); return { frames: [...st(p.tabId).frames.entries()].map(([sessionId, fr]) => ({ sessionId, url: fr.url || null })) }; }
    case 'frameOffsetOf': { await need(p.tabId); return await frameOffset(p.tabId, p.sessionId); }
    case 'getHistory': {
      const items = await chrome.history.search({ text: p.text || '', maxResults: Math.min(p.maxResults || 50, 500), ...(p.startTime ? { startTime: p.startTime } : {}), ...(p.endTime ? { endTime: p.endTime } : {}) });
      return { entries: (items || []).map((h) => ({ url: h.url, title: h.title, lastVisit: h.lastVisitTime, visitCount: h.visitCount })) };
    }

    case 'clipboardRead':
    case 'clipboardWrite': {
      await need(p.tabId);
      // The async clipboard API is the wrong tool here. `navigator.clipboard.readText()` requires
      // the clipboard-read permission, and when that permission is in the "prompt" state on a tab
      // the user isn't looking at, the prompt never appears and the promise NEVER SETTLES — the call
      // just hangs until something else times out. (Browser.grantPermissions can't rescue it either:
      // it's a browser-level command that isn't routable on a page-target debugger session.)
      //
      // A real editing command dispatched through CDP is a trusted user action, so it needs no
      // permission at all and always completes. It operates on the focused editable, hence the
      // throwaway textarea.
      const writing = method === 'clipboardWrite';
      const text = String(p.text ?? '');
      const mac = /Mac/i.test(navigator.userAgent);
      const evalIn = (expression) => cmd(p.tabId, 'Runtime.evaluate', { expression, returnByValue: true });

      const ready = await evalIn(`(()=>{
        if(!document.body) return false;
        let ta=document.getElementById('__cbb_clip');
        if(!ta){ ta=document.createElement('textarea'); ta.id='__cbb_clip'; ta.setAttribute('aria-hidden','true');
          ta.style.cssText='position:fixed;left:-9999px;top:0;width:10px;height:10px;opacity:0';
          document.body.appendChild(ta); }
        window.__cbbPrev=document.activeElement;
        ta.value=${JSON.stringify(writing ? text : '')};
        ta.focus(); ta.select();
        return document.activeElement===ta;
      })()`);
      if (!ready.result?.value) throw new Error('could not focus a scratch field for the clipboard (page has no body yet?)');

      const restore = () => evalIn(`(()=>{const ta=document.getElementById('__cbb_clip'); if(ta)ta.remove();
        try{ window.__cbbPrev&&window.__cbbPrev.focus&&window.__cbbPrev.focus(); }catch{}
        delete window.__cbbPrev; return true;})()`).catch(() => {});
      try {
        await cmd(p.tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key: writing ? 'c' : 'v', code: writing ? 'KeyC' : 'KeyV',
          windowsVirtualKeyCode: writing ? 67 : 86, nativeVirtualKeyCode: writing ? 67 : 86,
          modifiers: mac ? 4 : 2, commands: [writing ? 'copy' : 'paste'],
        });
        await cmd(p.tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: writing ? 'c' : 'v', code: writing ? 'KeyC' : 'KeyV', windowsVirtualKeyCode: writing ? 67 : 86, modifiers: mac ? 4 : 2 });
        if (writing) { await restore(); return { ok: true, length: text.length }; }
        const got = await evalIn(`(document.getElementById('__cbb_clip')||{}).value ?? ''`);
        await restore();
        return { text: got.result?.value ?? '' };
      } catch (e) { await restore(); throw e; }
    }

    case 'pageAssets': {
      await need(p.tabId);
      const r = await cmd(p.tabId, 'Runtime.evaluate', {
        expression: `(()=>{
          const abs=(u)=>{try{return new URL(u,location.href).href}catch{return null}};
          const seen=new Map(), svgs=[];
          const add=(url,kind,name)=>{const u=abs(url); if(!u||u.startsWith('data:')&&u.length>512) return;
            if(!seen.has(u)) seen.set(u,{url:u,kind,name:name||u.split('/').pop().split('?')[0]||kind});};
          for(const e of document.querySelectorAll('img')){ add(e.currentSrc||e.src,'image',e.alt||null);
            if(e.srcset) for(const part of e.srcset.split(',')) add(part.trim().split(/\\s+/)[0],'image',e.alt||null); }
          for(const e of document.querySelectorAll('video,audio,source')) add(e.currentSrc||e.src,'video',null);
          for(const e of document.querySelectorAll('link[rel~="stylesheet"]')) add(e.href,'stylesheet',null);
          for(const e of document.querySelectorAll('link[rel~="icon"],link[rel~="apple-touch-icon"]')) add(e.href,'image',null);
          for(const e of document.querySelectorAll('script[src]')) add(e.src,'script',null);
          // CSS background images and @font-face files actually in use
          for(const e of document.querySelectorAll('*')){
            const bg=getComputedStyle(e).backgroundImage;
            if(bg&&bg!=='none') for(const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) add(m[1],'image',null);
          }
          try{ for(const f of document.fonts){ if(f.status==='loaded'&&f.family) seen.set('font:'+f.family+f.weight+f.style,{url:null,kind:'font',name:f.family+' '+f.style+' '+f.weight}); } }catch{}
          document.querySelectorAll('svg').forEach((s,i)=>{ if(svgs.length<40){const m=s.outerHTML; if(m.length<20000) svgs.push({name:(s.getAttribute('aria-label')||s.id||'svg-'+i),markup:m});} });
          const assets=[...seen.values()].slice(0,400);
          const byKind={}; for(const a of assets) byKind[a.kind]=(byKind[a.kind]||0)+1;
          return {pageUrl:location.href,assets,inlineSvgs:svgs,summary:{byKind,total:assets.length,inlineSvgCount:svgs.length}};
        })()`,
        returnByValue: true,
      });
      const v = r.result?.value || { assets: [], inlineSvgs: [] };
      const s = st(p.tabId);
      v.assets.forEach((a, i) => { a.id = 'a' + i; });
      s.assets = new Map(v.assets.filter((a) => a.url).map((a) => [a.id, a]));
      if (p.kinds && p.kinds.length) v.assets = v.assets.filter((a) => p.kinds.includes(a.kind));
      return v;
    }
    case 'fetchAssets': {
      // Fetch asset BYTES and hand them back for the host to write.
      //
      // This deliberately does not use chrome.downloads. That API drives the browser's user-facing
      // download machinery, which means the user's own "ask where to save each file" setting opens a
      // native save panel per asset — and nobody is there to answer it during an automated bundle.
      // Fetching here and writing in the host has no UI, no permission gate, and doesn't litter the
      // user's Downloads folder. credentials:'include' so assets behind the user's session still
      // resolve, which is the whole point of driving their real browser.
      const s = st(p.tabId);
      if (!s.assets || !s.assets.size) throw new Error('no asset inventory for this tab — call page_assets first');
      let picked = [...s.assets.values()];
      if (p.assetIds && p.assetIds.length) picked = picked.filter((a) => p.assetIds.includes(a.id));
      else if (p.kinds && p.kinds.length) picked = picked.filter((a) => p.kinds.includes(a.kind));
      picked = picked.filter((a) => a.url).slice(0, Math.min(p.limit || 60, 200));

      const PER_ASSET_CAP = 12 * 1024 * 1024, TOTAL_CAP = 64 * 1024 * 1024;
      const out = [], failures = [];
      let total = 0;
      for (const a of picked) {
        try {
          const res = await fetch(a.url, { credentials: 'include' });
          if (!res.ok) { failures.push({ id: a.id, url: a.url.slice(0, 120), reason: `HTTP ${res.status}` }); continue; }
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length > PER_ASSET_CAP) { failures.push({ id: a.id, url: a.url.slice(0, 120), reason: `${(buf.length / 1e6).toFixed(1)} MB exceeds the 12 MB per-asset cap` }); continue; }
          if (total + buf.length > TOTAL_CAP) { failures.push({ id: a.id, url: a.url.slice(0, 120), reason: 'total bundle size cap (64 MB) reached' }); continue; }
          total += buf.length;
          out.push({ id: a.id, url: a.url.slice(0, 300), kind: a.kind, name: a.name || 'asset',
            contentType: res.headers.get('content-type') || null, bytes: buf.length, b64: bytesToB64(buf) });
        } catch (e) { failures.push({ id: a.id, url: a.url.slice(0, 120), reason: String(e && e.message || e) }); }
      }
      return { requested: picked.length, assets: out, failures, totalBytes: total };
    }

    case 'webmcpTools': {
      // WebMCP (W3C proposal): a page publishes its own semantic tools. When one covers the task,
      // calling it beats driving the UI entirely.
      //
      // Agent-side surface is document.modelContext.getTools() / .executeTool(tool, params). The
      // spec moved from navigator to document, and the MCP-B polyfill still ships the older
      // listTools/callTool pair, so probe both rather than betting on either.
      await need(p.tabId);
      const r = await cmd(p.tabId, 'Runtime.evaluate', {
        expression: `(async()=>{
          const ctx = (typeof document!=='undefined'&&document.modelContext)
                   || (typeof navigator!=='undefined'&&navigator.modelContext) || null;
          const surface = (typeof document!=='undefined'&&document.modelContext) ? 'document.modelContext'
                        : (typeof navigator!=='undefined'&&navigator.modelContext) ? 'navigator.modelContext' : null;
          let tools=[], error=null;
          if(ctx){
            try{
              // also reach tools registered inside cross-origin iframes on this page
              const origins=[...new Set([...document.querySelectorAll('iframe[src]')]
                .map(f=>{try{return new URL(f.src).origin}catch{return null}}).filter(Boolean))];
              let t;
              if(ctx.getTools) t = await (origins.length ? ctx.getTools({fromOrigins:origins}).catch(()=>ctx.getTools()) : ctx.getTools());
              else if(ctx.listTools) t = await ctx.listTools();
              else t = ctx.tools;
              if(Array.isArray(t)) tools=t;
              else if(t&&Array.isArray(t.tools)) tools=t.tools;
            }catch(e){ error=String(e&&e.message||e); }
          }
          const declarative=[...document.querySelectorAll('[toolname]')].map(e=>({
            name:e.getAttribute('toolname'), description:e.getAttribute('tooldescription')||null,
            autoSubmit:e.hasAttribute('toolautosubmit'), declarative:true,
            fields:[...e.querySelectorAll('input,select,textarea')].map(i=>({
              name:i.name||i.id||null, type:i.type||i.tagName.toLowerCase(), required:!!i.required,
              description:i.getAttribute('toolparamdescription')||null,
            })).filter(f=>f.name),
          })).filter(t=>t.name);
          return { supported: !!ctx || declarative.length>0, surface, ...(error?{error}:{}),
                   tools: tools.map(t=>({name:t.name,description:t.description||null,
                                         inputSchema:t.inputSchema||t.input_schema||null})),
                   declarative };
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      return r.result?.value || { supported: false, tools: [], declarative: [] };
    }
    case 'webmcpCall': {
      await need(p.tabId);
      // executeTool takes the registered tool OBJECT, not its name — so discovery and invocation
      // have to happen inside one evaluation; the object cannot survive the CDP boundary.
      const r = await cmd(p.tabId, 'Runtime.evaluate', {
        expression: `(async()=>{
          const ctx=(document.modelContext)||(navigator.modelContext)||null;
          if(!ctx) throw new Error('this page does not expose WebMCP tools');
          const name=${JSON.stringify(String(p.name || ''))}, args=${JSON.stringify(p.arguments || {})};
          if(ctx.getTools&&ctx.executeTool){
            const origins=[...new Set([...document.querySelectorAll('iframe[src]')]
              .map(f=>{try{return new URL(f.src).origin}catch{return null}}).filter(Boolean))];
            const tools=await (origins.length ? ctx.getTools({fromOrigins:origins}).catch(()=>ctx.getTools()) : ctx.getTools());
            const tool=(tools||[]).find(t=>t.name===name);
            if(!tool) throw new Error('no WebMCP tool named "'+name+'" on this page (have: '+(tools||[]).map(t=>t.name).join(', ')+')');
            // the typings say params is a string; the reference agent passes the object — try both
            try { return await ctx.executeTool(tool,args); }
            catch(e){ return await ctx.executeTool(tool,JSON.stringify(args)); }
          }
          if(ctx.callTool) return await ctx.callTool({name,arguments:args}); // MCP-B polyfill
          throw new Error('this page exposes modelContext but neither executeTool nor callTool');
        })()`,
        awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'WebMCP call failed');
      return { result: r.result?.value ?? null };
    }

    default: throw new Error('unknown method: ' + method);
  }
}

// ---- event buffering ----
chrome.debugger.onEvent.addListener((source, cdpMethod, cdpParams) => {
  const tabId = source.tabId; if (tabId == null) return;
  const s = state.get(tabId); if (!s) return;
  // Generic event ring, on top of the console/network digests below. read_console and read_network
  // cover the usual questions; this is for the rest of the protocol — a lifecycle event, a CSS or
  // Animation domain you enabled yourself via `cdp` — which otherwise fires and is gone.
  if (!s.events) { s.events = []; s.evSeq = 0; }
  s.events.push({ sequence: ++s.evSeq, method: cdpMethod, params: cdpParams, ...(source.sessionId ? { sessionId: source.sessionId } : {}) });
  if (s.events.length > 1000) { s.events.shift(); s.evTruncated = true; }
  if (cdpMethod === 'Runtime.consoleAPICalled') {
    s.console.push({ level: cdpParams.type, text: (cdpParams.args || []).map(a => a.value ?? a.description ?? '').join(' '), ts: cdpParams.timestamp });
    if (s.console.length > 500) s.console.shift();
  } else if (cdpMethod === 'Runtime.exceptionThrown') {
    s.console.push({ level: 'error', text: cdpParams.exceptionDetails?.exception?.description || cdpParams.exceptionDetails?.text || 'exception' });
    if (s.console.length > 500) s.console.shift();
  } else if (cdpMethod === 'Network.requestWillBeSent') {
    s.network.set(cdpParams.requestId, { requestId: cdpParams.requestId, url: cdpParams.request?.url, method: cdpParams.request?.method });
    s.lastRequestTs = Date.now(); // for networkidle in waitFor
  } else if (cdpMethod === 'Network.responseReceived') {
    const e = s.network.get(cdpParams.requestId); if (e) { e.status = cdpParams.response?.status; e.type = cdpParams.type; }
  } else if (cdpMethod === 'Page.javascriptDialogOpening') {
    // A dialog freezes the page's CDP — record it so the agent sees it in the status header and can
    // clear it (dialog_handle). beforeunload we auto-accept so it can't wedge navigation.
    s.dialog = { type: cdpParams.type, message: cdpParams.message, defaultPrompt: cdpParams.defaultPrompt };
    if (cdpParams.type === 'beforeunload') { cmd(tabId, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); s.dialog = null; }
  } else if (cdpMethod === 'Page.javascriptDialogClosed') {
    s.dialog = null;
  } else if (cdpMethod === 'Page.loadEventFired') {
    s.lastLoadTs = Date.now();
  } else if (cdpMethod === 'Page.frameNavigated' && !cdpParams.frame?.parentId) {
    // New main-frame document: every backendDOMNodeId from the old one is dead, so a delta against
    // it would be pure noise. Drop the baseline and let the next read_page return a full tree.
    s.ax = null;
  } else if (cdpMethod === 'Target.attachedToTarget') {
    // A cross-origin child frame attached. Enable its domains, resolve its owner <iframe> in the
    // parent (needed for coordinate translation), and recurse auto-attach for nested frames.
    const child = { tabId, sessionId: cdpParams.sessionId };
    (async () => {
      for (const d of ['DOM', 'Runtime', 'Accessibility', 'Page']) await cmd(child, d + '.enable').catch(() => {});
      let ownerBackendNodeId = null;
      try {
        const frameId = (await cmd(child, 'Page.getFrameTree'))?.frameTree?.frame?.id;
        if (frameId) ownerBackendNodeId = (await cmd(source, 'DOM.getFrameOwner', { frameId }))?.backendNodeId ?? null;
      } catch {}
      s.frames.set(cdpParams.sessionId, { parentSession: source, ownerBackendNodeId, url: cdpParams.targetInfo?.url });
      await cmd(child, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }).catch(() => {});
    })();
  } else if (cdpMethod === 'Target.detachedFromTarget') {
    s.frames.delete(cdpParams.sessionId);
  }
});
chrome.debugger.onDetach.addListener((source) => { if (source.tabId != null) state.delete(source.tabId); });

// Popup ↔ worker channel for secure credential entry. Secret values arrive here and go straight to
// the page fill (fillCredentials); they are never logged or forwarded to the host/MCP side.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return; // only our own popup/pages — never another extension or (absent externally_connectable) a web page
  if (!msg || !msg.token) return;
  const pend = pendingCredentials.get(msg.token);
  if (msg.type === 'cbb-cred-getspec') { sendResponse(pend ? pend.spec : { error: 'This request expired.' }); return; }
  if (!pend) { sendResponse({ status: 'expired' }); return; }
  if (msg.type === 'cbb-cred-cancel') { pend.finish('declined'); sendResponse({ status: 'declined' }); return; }
  if (msg.type === 'cbb-cred-submit') {
    (async () => {
      let status; try { status = await fillCredentials(pend, msg.values || {}); } catch { status = 'submission_failed'; }
      pend.finish(status);
      sendResponse({ status });
    })();
    return true; // async response
  }
});
