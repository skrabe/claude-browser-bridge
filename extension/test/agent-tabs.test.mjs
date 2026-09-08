// Agent-tab ownership across worker eviction, extension reload, and browser restart.
//
// Getting this wrong is not a cosmetic bug in either direction: too strict and tab_close orphans
// the agent's own tabs in the user's window, too loose and it closes a tab of theirs that happens
// to have inherited a recycled id. So the real background.js is loaded here under a stubbed
// `chrome` and driven through each lifecycle event.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'background.js');
const code = fs.readFileSync(SRC, 'utf8');

const listeners = () => ({ addListener() {}, removeListener() {} });

// One storage.local that persists across "reloads", like the real thing.
function makeChrome(local) {
  const area = (store) => ({
    async get(k) { return k in store ? { [k]: store[k] } : {}; },
    async set(o) { Object.assign(store, o); },
  });
  const startup = [];
  return {
    _startup: startup,
    storage: { local: area(local), session: area({}) },
    runtime: {
      connectNative() { throw new Error('no host in test'); },
      onStartup: { addListener: (f) => startup.push(f) },
      onInstalled: listeners(), onMessage: listeners(), lastError: null,
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    downloads: { onCreated: listeners(), onChanged: listeners() },
    tabs: { onRemoved: listeners(), async get() { return {}; }, async query() { return []; } },
    tabGroups: { async query() { return []; } },
    windows: { async getAll() { return []; } },
    bookmarks: {},
    alarms: { create() {}, onAlarm: listeners() },
    debugger: { onEvent: listeners(), onDetach: listeners() },
    scripting: {},
  };
}

// Boot background.js in a fresh context — a fresh service worker — over the given storage.local.
function boot(local) {
  const chrome = makeChrome(local);
  const ctx = vm.createContext({ chrome, setTimeout() {}, clearTimeout() {}, setInterval() {}, console, Date, JSON, Math, Promise, Map, Set, Object, Array, String, Number, Boolean, RegExp, Error, NodeFilter: {} });
  vm.runInContext(code, ctx, { filename: 'background.js' });
  return { ctx, chrome };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); cond ? pass++ : fail++; };

const AGENT_TAB = 4242;
const USER_TAB = 4242; // deliberately the SAME id: what a browser restart can hand back

// 1. Within one run: the agent marks a tab and owns it.
const store = {};
{
  const { ctx } = boot(store);
  await ctx.markAgentTab(AGENT_TAB);
  ok('owns a tab it just opened', await ctx.isAgentTab(AGENT_TAB));
  ok('does not own an unrelated tab', !(await ctx.isAgentTab(9999)));
}

// 2. Service worker evicted and restarted (new context, storage intact) — ownership survives.
{
  const { ctx } = boot(store);
  ok('ownership survives a service-worker restart', await ctx.isAgentTab(AGENT_TAB));
}

// 3. Extension reloaded. This is the regression: storage.session would have been wiped here, and
//    the agent's own tab became unclosable. onStartup does NOT fire for a reload.
{
  const { ctx } = boot(store);
  ok('ownership survives an extension reload', await ctx.isAgentTab(AGENT_TAB));
}

// 4. Browser restart: onStartup fires, and the id may now belong to one of the user's tabs.
{
  const { ctx, chrome } = boot(store);
  for (const f of chrome._startup) await f();
  ok('a recycled id is NOT claimed after a browser restart', !(await ctx.isAgentTab(USER_TAB)));
  ok('the stale record is pruned from storage', (store['cbb.agentTabs'] || []).length === 0);
}

// 5. The TTL is the backstop for a build where onStartup never arrives.
{
  const aged = { 'cbb.browserRunStartedAt': 1, 'cbb.agentTabs': [{ id: USER_TAB, at: Date.now() - 48 * 60 * 60 * 1000 }] };
  const { ctx } = boot(aged);
  ok('an expired record is not claimed even without onStartup', !(await ctx.isAgentTab(USER_TAB)));
}

// 6. A fresh record under an old watermark is still claimable (the reload case, aged watermark).
{
  const live = { 'cbb.browserRunStartedAt': 1, 'cbb.agentTabs': [{ id: AGENT_TAB, at: Date.now() }] };
  const { ctx } = boot(live);
  ok('a current record is claimed under an old watermark', await ctx.isAgentTab(AGENT_TAB));
}

// 7. Releasing a tab gives up ownership.
{
  const s2 = {};
  const { ctx } = boot(s2);
  await ctx.markAgentTab(77);
  await ctx.forgetAgentTab(77);
  ok('forgetting a tab drops ownership', !(await ctx.isAgentTab(77)));
}

// 8. Legacy records (a bare id array from the storage.session era) must not crash or be trusted.
{
  const legacy = { 'cbb.agentTabs': [USER_TAB] };
  const { ctx } = boot(legacy);
  ok('a legacy bare-id record is ignored', !(await ctx.isAgentTab(USER_TAB)));
}

// A duplicate top-level `function` name does not throw — the last declaration silently wins and
// every earlier caller starts getting the wrong implementation. That is invisible until something
// far away breaks, so check it here where it is cheap.
{
  const names = [...code.matchAll(/^(?:async\s+)?function\s+([$\w]+)\s*\(/gm)].map((m) => m[1]);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  ok('no duplicate top-level function names' + (dupes.length ? ` (found: ${dupes.join(', ')})` : ''), dupes.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
