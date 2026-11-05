// The occlusion pass behind read_page's covered:true, on the shapes a real page produced:
// a same-site iframe's nodes (their own paint order and coordinates) next to a top-page overlay,
// and a zero-area link wrapping an absolutely positioned image.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const code = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'background.js'), 'utf8');
const L = () => ({ addListener() {}, removeListener() {} });
const chrome = {
  storage: { local: { async get() { return {}; }, async set() {} }, session: { async get() { return {}; }, async set() {} } },
  runtime: { connectNative() { throw new Error('no host'); }, onStartup: L(), onInstalled: L(), onMessage: L(), lastError: null, getURL: (p) => p },
  downloads: { onCreated: L(), onChanged: L() }, tabs: { onRemoved: L(), onCreated: L(), async get() { return {}; }, async query() { return []; } },
  tabGroups: { async query() { return []; } }, windows: { async getAll() { return []; } }, bookmarks: {},
  alarms: { create() {}, onAlarm: L() }, debugger: { onEvent: L(), onDetach: L() }, scripting: {},
};
const ctx = vm.createContext({ chrome, setTimeout() {}, clearTimeout() {}, setInterval() {}, console, Date, JSON, Math, Promise, Map, Set, Object, Array, String, Number, Boolean, RegExp, Error, NodeFilter: {} });
vm.runInContext(code, ctx);

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); cond ? pass++ : fail++; };
const R = (x, y, w, h) => ({ x1: x, y1: y, x2: x + w, y2: y + h });

// Top document: a translucent-but-opaque-enough fixed bar over the top 50px (paint 10), a button
// painted ABOVE it (paint 11, so not covered), a button below the bar's paint level inside it
// (paint 5, covered), an iframe lower down (paint 3), and a zero-area link (paint 4).
// Child document (doc 1): an input at y=8 in its own coordinates, paint 2.
const nodes = new Map([
  [1, { rect: R(0, 0, 800, 50), paint: 10, doc: 0 }],
  [2, { rect: R(10, 10, 80, 20), paint: 11, doc: 0 }],
  [3, { rect: R(200, 10, 80, 20), paint: 5, doc: 0 }],
  [4, { rect: R(0, 100, 300, 150), paint: 3, doc: 0 }],
  [5, { rect: R(700, 20, 0, 0), paint: 4, doc: 0 }],
  [6, { rect: R(8, 8, 150, 20), paint: 2, doc: 1, frameOwner: 4 }],
]);
// Every laid-out top-document node with area is in `painted`, as domSnapshotIndex builds it.
// The child document's paint levels are included too, as the snapshot reports them: the pass must
// still not compare that document's nodes against the top page's rects.
const painted = [...nodes.values()].filter((g) => g.rect.x2 > g.rect.x1).map((g) => ({ rect: g.rect, paint: g.paint, opaque: g.paint >= 10 }));
let buried = ctx.occludedNodes({ nodes, painted });
ok('a control under the overlay is covered', buried.has(3));
ok('a control painted above the overlay is not', !buried.has(2));
ok("an iframe's input is not judged against the top page's overlay", !buried.has(6));
ok('a zero-area link is never covered', !buried.has(5));

// Now an opaque modal over the iframe: everything inside the frame inherits that.
buried = ctx.occludedNodes({ nodes, painted: [...painted, { rect: R(0, 90, 400, 200), paint: 20, opaque: true }].sort((a, b) => a.paint - b.paint) });
ok('a frame covered by a modal covers what is inside it', buried.has(4) && buried.has(6));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
