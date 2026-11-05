// Intent and find matching: which elements a phrase like "the Delete account button" can mean.
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

const page = [['button', 'Save order'], ['button', 'Delete order'], ['button', 'Cancel'], ['button', 'Add'], ['link', 'Home'], ['textbox', 'Email'], ['StaticText', 'The order was saved']];
ctx.cmd = async () => ({ nodes: page.map(([role, name], i) => ({ role: { value: role }, name: { value: name }, backendDOMNodeId: i + 1 })) });
const names = async (q) => (await ctx.intentCandidates(1, q)).map((c) => c.name);

let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)); ok ? pass++ : fail++; };

eq('an absent element matches nothing, not every button or a near miss', await names('the Delete account button'), []);
eq('the near miss is reported, not taken', (await ctx.intentCandidates(1, 'the Delete account button')).near.map((c) => c.name), ['Delete order']);
eq('find still ranks partial matches', (await ctx.findCandidates(1, 'delete account')).map((c) => c.name), ['Delete order']);
eq('a phrase with no word on the page matches nothing', await names('the Logout button'), []);
eq('"save the order" leads with Save order', (await names('save the order'))[0], 'Save order');
eq('a role word prefers that role', (await names('email field'))[0], 'Email');
eq('a query of only role words lists that role', (await names('the link')), ['Home']);
eq('stopwords alone do not match every name', (await ctx.findCandidates(1, 'the')).map((c) => c.name), ['The order was saved']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
