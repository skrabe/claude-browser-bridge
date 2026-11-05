// Every action handler, run once against a stubbed debugger. Not a behaviour test: it proves each
// handler's code path is wired (no name used before it is defined, no block left inside the wrong
// function). Both such slips passed every other unit test and only showed up in a live browser.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const code = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'background.js'), 'utf8');
const L = () => ({ addListener() {}, removeListener() {} });
const node = { backendNodeId: 5, nodeName: 'INPUT', attributes: [] };
const describe = { tag: 'input', role: null, label: 'Email', disabled: false, ariaDisabled: false, box: { x: 10, y: 10, width: 100, height: 20 } };
function reply(method, params) {
  switch (method) {
    case 'DOM.resolveNode': return { object: { objectId: 'o1' } };
    case 'DOM.describeNode': return { node };
    case 'DOM.getBoxModel': return { model: { content: [10, 10, 110, 10, 110, 30, 10, 30], border: [10, 10, 110, 10, 110, 30, 10, 30] } };
    case 'DOM.getDocument': return { root: { nodeId: 1, backendNodeId: 1 } };
    case 'DOM.querySelectorAll': return { nodeIds: [] };
    case 'Page.getFrameTree': return { frameTree: { frame: { id: 'F' }, childFrames: [] } };
    case 'Page.createIsolatedWorld': return { executionContextId: 9 };
    case 'Page.getLayoutMetrics': return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, scale: 1 } };
    case 'Accessibility.getFullAXTree': return { nodes: [{ nodeId: '1', role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 5 }] };
    case 'DOMSnapshot.captureSnapshot': return { documents: [], strings: [] };
    case 'Page.navigate': return { frameId: 'F', loaderId: 'L1' };
    case 'Runtime.callFunctionOn': {
      const f = String(params.functionDeclaration || '');
      if (/selectorMatches|clickable/.test(f) || /getBoundingClientRect\(\)/.test(f) && /tag:/.test(f)) return { result: { value: describe } };
      if (/text:\(this\.tagName/.test(f)) return { result: { value: { tag: 'input', type: 'text', editable: false, text: true, secret: false, focused: true, value: '' } } };
      if (/activeElement/.test(f)) return { result: { value: true } };
      return { result: { value: { got: 'x', ok: true, covered: false } } };
    }
    case 'Runtime.evaluate': return { result: { value: String(params.expression || '').includes('innerText') ? ['page text'] : null } };
    default: return {};
  }
}
const chrome = {
  storage: { local: { async get() { return {}; }, async set() {} }, session: { async get() { return {}; }, async set() {} } },
  runtime: { connectNative() { throw new Error('no host'); }, getManifest: () => ({ version: 'test' }), onStartup: L(), onInstalled: L(), onMessage: L(), lastError: null, getURL: (p) => p },
  downloads: { onCreated: L(), onChanged: L() },
  tabs: { onRemoved: L(), onCreated: L(), async get(id) { return { id, url: 'https://x.test/', title: 'X', status: 'complete' }; }, async query() { return []; } },
  tabGroups: { async query() { return []; } }, windows: { async getAll() { return []; } }, bookmarks: {},
  alarms: { create() {}, onAlarm: L() },
  debugger: { onEvent: L(), onDetach: L(), attach(t, v, cb) { cb(); }, sendCommand(d, m, p, cb) { setTimeout(() => cb(reply(m, p)), 0); } },
  scripting: {},
};
const ctx = vm.createContext({ chrome, setTimeout, clearTimeout, setInterval() {}, clearInterval() {}, console, Date, JSON, Math, Promise, Map, Set, Object, Array, String, Number, Boolean, RegExp, Error, NodeFilter: {}, navigator: { userAgent: 'Mac' } });
vm.runInContext(code, ctx);

let pass = 0, fail = 0;
const ok = (name, cond, why) => { console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  ' + why)); cond ? pass++ : fail++; };
const tab = 42;
await ctx.handle('readPage', { tabId: tab }).catch(() => {});
const ref = [...ctx.st(tab).refs.keys()][0] || 'e1';
if (!ctx.st(tab).refs.has(ref)) ctx.st(tab).refs.set(ref, { backendNodeId: 5 });
const calls = [
  ['click', { tabId: tab, ref }], ['fill', { tabId: tab, ref, value: 'x' }], ['hover', { tabId: tab, ref }],
  ['pressKey', { tabId: tab, key: 'Enter' }], ['typeText', { tabId: tab, text: 'hi' }], ['scroll', { tabId: tab, ref }],
  ['navigate', { tabId: tab, url: 'https://y.test/', waitUntil: 'none' }], ['find', { tabId: tab, query: 'email' }],
  ['findText', { tabId: tab, query: 'page' }], ['readText', { tabId: tab }], ['validate', { tabId: tab, text: 'page' }],
  ['readPage', { tabId: tab }], ['readConsole', { tabId: tab }], ['pageStatus', { tabId: tab }],
];
// A wiring slip surfaces as a ReferenceError or TypeError on an undefined name; anything else is a
// stub that could not answer a real browser question, which is fine here.
const WIRING = /is not defined|Cannot access .* before initialization|is not a function|Cannot read properties of undefined \(reading '(?:has|get|set|tag|ariaDisabled)'\)/;
for (const [m, p] of calls) {
  let err = null;
  try { await ctx.handle(m, p); } catch (e) { err = e; }
  ok(`${m} is wired`, !(err && WIRING.test(String(err.message))), err && err.message);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
