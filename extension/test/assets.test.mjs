// bundle_assets fetches URLs the page chose, with the extension's <all_urls> reach. These checks
// pin what each fetch is allowed to carry: the user's cookies only for the page's own origin, no
// cookies anywhere else, no private-network targets from a public page, no redirects, and no
// inventory that outlives its document. The real background.js runs under a stubbed `chrome` and a
// stubbed `fetch`, so nothing here touches the network.

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'background.js');
const code = fs.readFileSync(SRC, 'utf8');
const listeners = () => ({ addListener() {}, removeListener() {} });
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function boot() {
  const page = { frame: { id: 'F', loaderId: 'L1', securityOrigin: 'https://shop.example', url: 'https://shop.example/' }, assets: [], pageUrl: 'https://shop.example/', navigateDuringInventory: false };
  const fetched = [];
  const responses = new Map();
  let onEvent = null;
  const area = () => ({ async get() { return {}; }, async set() {} });
  const chrome = {
    storage: { local: area(), session: area() },
    runtime: {
      connectNative() { throw new Error('no host in test'); },
      onStartup: listeners(), onInstalled: listeners(), onMessage: listeners(), lastError: null,
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    downloads: { onCreated: listeners(), onChanged: listeners() },
    tabs: { onRemoved: listeners(), async get() { return {}; }, async query() { return []; } },
    tabGroups: { async query() { return []; } },
    windows: { async getAll() { return []; } },
    bookmarks: {},
    alarms: { create() {}, onAlarm: listeners() },
    debugger: {
      onEvent: { addListener: (f) => { onEvent = f; } }, onDetach: listeners(),
      attach(_t, _v, cb) { cb(); },
      sendCommand(_t, method, _params, cb) {
        if (method === 'Page.getFrameTree') return cb({ frameTree: { frame: { ...page.frame } } });
        if (method === 'Runtime.evaluate') {
          const value = { pageUrl: page.pageUrl, assets: page.assets.map((a) => ({ ...a })), inlineSvgs: [], summary: {} };
          if (page.navigateDuringInventory) page.frame = { ...page.frame, loaderId: page.frame.loaderId + '-next' };
          return cb({ result: { value } });
        }
        cb({});
      },
    },
    scripting: {},
  };
  const fetch = async (url, init = {}) => {
    fetched.push({ url, credentials: init.credentials, redirect: init.redirect });
    const r = responses.get(url) || { status: 200 };
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, type: r.type || 'basic',
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
      async arrayBuffer() { return PNG.buffer.slice(0); },
    };
  };
  const ctx = vm.createContext({ chrome, fetch, URL, btoa, atob, setTimeout() {}, clearTimeout() {}, setInterval() {}, console, Date, JSON, Math, Promise, Map, Set, Object, Array, String, Number, Boolean, RegExp, Error, Uint8Array, NodeFilter: {} });
  vm.runInContext(code, ctx, { filename: 'background.js' });
  return { ctx, page, fetched, responses, navigate: (tabId) => onEvent({ tabId }, 'Page.frameNavigated', { frame: { id: 'F' } }) };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); cond ? pass++ : fail++; };
const rejects = async (p, re) => { try { await p; return false; } catch (e) { return re.test(e.message); } };
const TAB = 7;
const asset = (url, name) => ({ url, kind: 'image', name: name || url });

// 1. A public page: what each declared URL is allowed to carry.
{
  const t = boot();
  t.page.pageUrl = 'https://victim.example/'; // the page's own claim; the frame tree says shop.example
  t.page.assets = [
    asset('https://shop.example/logo.png'),
    asset('https://cdn.example/hero.png'),
    asset('https://victim.example/admin/secret.json', 'harmless little icon'),
    asset('http://127.0.0.1:8080/'), asset('http://localhost:3000/'), asset('http://192.168.1.1/'),
    asset('http://10.0.0.5/'), asset('http://172.20.0.1/'), asset('http://169.254.169.254/latest/'),
    asset('http://100.101.102.103/'), asset('http://intranet/'), asset('https://nas.local/'),
    asset('http://2130706433/'), asset('http://[::1]/'), asset('http://[fd00::1]/'),
    asset('file:///etc/passwd'), asset('https://shop.example/bounce'),
    asset('data:image/png;base64,iVBORw0KGgo='),
  ];
  t.responses.set('https://shop.example/bounce', { status: 0, type: 'opaqueredirect' });
  await t.ctx.dispatch('pageAssets', { tabId: TAB });
  const r = await t.ctx.dispatch('fetchAssets', { tabId: TAB });
  const by = (u) => t.fetched.find((f) => f.url === u);
  const reason = (u) => (r.failures.find((f) => f.url === u.slice(0, 120)) || {}).reason || '';

  ok("the page's own origin is fetched with the user's cookies", by('https://shop.example/logo.png')?.credentials === 'include');
  ok('a same-origin fetch does not follow redirects', by('https://shop.example/logo.png')?.redirect === 'manual');
  ok('a cross-origin asset is fetched without cookies', by('https://cdn.example/hero.png')?.credentials === 'omit');
  ok("an authenticated endpoint on another origin gets no cookies, whatever pageUrl claims", by('https://victim.example/admin/secret.json')?.credentials === 'omit');
  ok('a cross-origin fetch does not follow redirects', by('https://cdn.example/hero.png')?.redirect === 'manual');
  const privates = ['http://127.0.0.1:8080/', 'http://localhost:3000/', 'http://192.168.1.1/', 'http://10.0.0.5/', 'http://172.20.0.1/',
    'http://169.254.169.254/latest/', 'http://100.101.102.103/', 'http://intranet/', 'https://nas.local/', 'http://127.0.0.1/', 'http://[::1]/', 'http://[fd00::1]/'];
  ok('no private-network address is fetched from a public page', privates.every((u) => !by(u)));
  ok('a decimal-encoded loopback address is caught after URL normalisation', !t.fetched.some((f) => f.url.includes('2130706433') || f.url.startsWith('http://127.0.0.1/')));
  ok('skipped private addresses are reported as failures', /private-network/.test(reason('http://192.168.1.1/')));
  ok('file: URLs are never fetched', !by('file:///etc/passwd') && /not fetched/.test(reason('file:///etc/passwd')));
  ok('a redirecting URL is reported, not saved', /redirect/.test(reason('https://shop.example/bounce')) && !r.assets.some((a) => a.url === 'https://shop.example/bounce'));
  ok('inline data: URIs still bundle, without cookies', by('data:image/png;base64,iVBORw0KGgo=')?.credentials === 'omit');
  ok('every fetch that carries cookies is to the page origin', t.fetched.filter((f) => f.credentials === 'include').every((f) => new URL(f.url).origin === 'https://shop.example'));
}

// 2. A navigation retires the inventory, so a new document can't use the old one's URLs.
{
  const t = boot();
  t.page.assets = [asset('https://shop.example/logo.png')];
  await t.ctx.dispatch('pageAssets', { tabId: TAB });
  t.navigate(TAB);
  ok('after a main-frame navigation, bundle_assets refuses', await rejects(t.ctx.dispatch('fetchAssets', { tabId: TAB }), /page_assets/));
  ok('and fetches nothing', t.fetched.length === 0);
}

// 3. Same, when the navigation event was missed: the document id is checked again at fetch time.
{
  const t = boot();
  t.page.assets = [asset('https://shop.example/logo.png')];
  await t.ctx.dispatch('pageAssets', { tabId: TAB });
  t.page.frame = { ...t.page.frame, loaderId: 'L2', securityOrigin: 'https://other.example' };
  ok('a changed document id is caught without the event', await rejects(t.ctx.dispatch('fetchAssets', { tabId: TAB }), /navigated/));
  ok('and fetches nothing', t.fetched.length === 0);
}

// 4. A navigation that lands while the inventory is being taken.
{
  const t = boot();
  t.page.assets = [asset('https://shop.example/logo.png')];
  t.page.navigateDuringInventory = true;
  ok('page_assets refuses an inventory that straddles two documents', await rejects(t.ctx.dispatch('pageAssets', { tabId: TAB }), /navigated/));
}

// 5. A page that is itself on a private address (a dev server) can still bundle local assets.
{
  const t = boot();
  t.page.frame = { id: 'F', loaderId: 'L1', securityOrigin: 'http://localhost:5173', url: 'http://localhost:5173/' };
  t.page.assets = [asset('http://localhost:5173/a.png'), asset('http://127.0.0.1:9000/b.png')];
  await t.ctx.dispatch('pageAssets', { tabId: TAB });
  await t.ctx.dispatch('fetchAssets', { tabId: TAB });
  ok("a dev server's own assets keep cookies", t.fetched.find((f) => f.url === 'http://localhost:5173/a.png')?.credentials === 'include');
  ok('another local origin is fetched, without cookies', t.fetched.find((f) => f.url === 'http://127.0.0.1:9000/b.png')?.credentials === 'omit');
}

// 6. An opaque-origin document (about:blank, sandboxed) never gets cookies attached.
{
  const t = boot();
  t.page.frame = { id: 'F', loaderId: 'L1', securityOrigin: 'null', url: 'about:blank' };
  t.page.assets = [asset('https://victim.example/secret.json')];
  await t.ctx.dispatch('pageAssets', { tabId: TAB });
  await t.ctx.dispatch('fetchAssets', { tabId: TAB });
  ok('an opaque-origin page sends no cookies', t.fetched.every((f) => f.credentials === 'omit'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
