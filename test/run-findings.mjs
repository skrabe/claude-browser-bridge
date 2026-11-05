#!/usr/bin/env node
// Live regression suite for the agent-facing failures an external test pass found: results that
// said ok when nothing happened, dialogs that froze clicks, iframe-blind checks, text matching
// that hit <script>. Drives test/findings-harness.html through a real MCP server and browser.
//
//   node test/run-findings.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'findings-harness.html'));
const site = http.createServer((req, res) => {
  if (req.url.startsWith('/page2')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Page 2</title><h1>Page 2</h1>'); }
  if (req.url.startsWith('/slow2')) { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Slow 2</title>slow'); }, 5000); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${site.address().port}`;
const PAGE = ORIGIN + '/';

const server = spawn('node', [path.join(HERE, '..', 'host', 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let idc = 0, buf = '';
server.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
const rpc = (method, params) => new Promise((res, rej) => { const id = ++idc; const to = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + method)); }, 120000); waiting.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
async function call(name, args) {
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).find((c) => c.type === 'text');
  let data = null; if (t) { try { data = JSON.parse(t.text); } catch { data = t.text; } }
  return { data, isError: !!r.isError, ms: Date.now() - t0, text: t ? t.text : '' };
}
const green = (s) => `\x1b[32m${s}\x1b[0m`, red = (s) => `\x1b[31m${s}\x1b[0m`, bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;
let failures = 0; const results = [];
const check = (label, ok, detail) => { console.log(`  ${ok ? green('✓') : red('✗')} ${label}${detail ? dim('  ' + String(detail).slice(0, 160)) : ''}`); if (!ok) failures++; results.push({ label, ok }); };
const section = (s) => console.log(bold('\n' + s));
const run = (tabId, script, timeoutMs) => call('run', { tabId, script, ...(timeoutMs ? { timeoutMs } : {}) });
const ev = async (tabId, fn) => (await run(tabId, `return await page.evaluate(${fn})`)).data?.result;
const fresh = async (tabId) => { await call('navigate', { tabId, url: ORIGIN + '/page2' }); await call('navigate', { tabId, url: PAGE }); };
const ref = async (tabId, name) => (await call('find', { tabId, query: name })).data?.candidates?.find((c) => c.name === name)?.ref;

let tabId;
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'findings', version: '1' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  tabId = (await call('tab_create', { url: PAGE, active: false })).data.id;
  await call('wait_for', { tabId, state: 'load' });

  section('1. JS dialogs');
  {
    const r = await call('click', { tabId, ref: await ref(tabId, 'Alert') });
    check('a click that opens an alert returns at once', !r.isError && r.ms < 5000, `${r.ms}ms`);
    check('and reports the open dialog', r.data?.openedDialog?.type === 'alert' && r.data.openedDialog.message === 'hi from alert', JSON.stringify(r.data?.openedDialog));
    const blocked = await call('read_text', { tabId });
    check('anything else fails fast naming the dialog', blocked.isError && /alert/.test(blocked.text) && blocked.ms < 5000, `${blocked.ms}ms ${blocked.text.slice(0, 90)}`);
    const h = await call('dialog_handle', { tabId, accept: true });
    check('dialog_handle clears it', !h.isError && !h.data?.status?.openDialog);
    const c = await run(tabId, `await page.getByRole('button', {name:'Confirm'}).click(); const d = await page.getJsDialog(); const t = d && d.type; await d.dismiss(); return { t, res: await page.locator('#cres').textContent() };`);
    check('in a script, getJsDialog() is reachable after the click', c.data?.result?.t === 'confirm' && c.data.result.res === 'false', JSON.stringify(c.data?.result || c.data));
    const pr = await run(tabId, `await page.getByRole('button', {name:'Prompt'}).click(); await (await page.getJsDialog()).accept('Ada'); return await page.locator('#pres').textContent();`);
    check('a prompt can be answered with text', pr.data?.result === 'Ada', JSON.stringify(pr.data?.result ?? pr.data));
    await call('click', { tabId, ref: await ref(tabId, 'Key alert') });
    const k = await call('press_key', { tabId, key: 'Enter' });
    check('a key that opens a dialog reports it too', !k.isError && k.data?.openedDialog?.type === 'alert', k.text.slice(0, 120));
    await call('dialog_handle', { tabId, accept: true });
  }

  section('2/15. Navigation that did not happen');
  {
    const n = await call('navigate', { tabId, url: 'data:text/html,<title>D</title>hi' });
    check('navigate to a top-frame data: URL errors', n.isError && /data:/.test(n.text), n.text.slice(0, 120));
    const g = await run(tabId, `try { await page.goto('data:text/html,hi'); return 'ok'; } catch (e) { return e.message; }`);
    check('page.goto to it throws too', /refused|data:/.test(String(g.data?.result)), g.data?.result);
    const ok = await call('navigate', { tabId, url: ORIGIN + '/page2' });
    check('a real navigation still succeeds', !ok.isError && ok.data?.status?.title === 'Page 2', ok.data?.status?.title);
    const hash = await call('navigate', { tabId, url: ORIGIN + '/page2#frag' });
    check('a same-document hash navigation is not mistaken for a refusal', !hash.isError, hash.text.slice(0, 100));
    await call('navigate', { tabId, url: PAGE });
  }

  section('3. Frame text in find_text / validate / read_text');
  {
    const f = (await call('find_text', { tabId, query: 'Only in frame' })).data;
    check('find_text sees text inside an iframe', f?.count === 1 && f.inFrames === 1, JSON.stringify(f));
    const v = (await call('validate', { tabId, text: 'Only in frame' })).data;
    check('validate sees it', v?.ok === true);
    const t = (await call('read_text', { tabId })).data?.text || '';
    check('read_text includes it', t.includes('Only in frame'));
    const hw = (await call('find_text', { tabId, query: 'Hello World!' })).data;
    check('find_text does not count <script>/<style> text', hw?.count === 1, `count=${hw?.count}`);
  }

  section('4/5. Text matching');
  {
    const r = await run(tabId, `const l = page.getByText('Hello World!'); return { n: await l.count(), t: await l.innerText() };`);
    check('getByText skips the <script> that contains the string', r.data?.result?.n === 1 && r.data.result.t === 'Hello World!', JSON.stringify(r.data?.result ?? r.data));
    const e = await run(tabId, `return await page.getByText('Editor text').count();`);
    check('a hidden editor <textarea> does not collide with the editor text', e.data?.result === 1, `count=${e.data?.result}`);
    const strict = await run(tabId, `try { await page.getByRole('button', {name:'order'}).click({timeoutMs:2000}); return 'clicked'; } catch (x) { return x.message; }`);
    check('strict-mode error names the locator and its matches', /getByRole\("button", "order"\) matches 2/.test(strict.data?.result) && /Save order/.test(strict.data?.result), strict.data?.result);
    const t0 = Date.now();
    const miss = await run(tabId, `try { await page.getByRole('button', {name:'Nope'}).click({timeoutMs:1500}); } catch (x) { return x.message; }`);
    check('a missing element names the locator, honours timeoutMs', /getByRole\("button", "Nope"\) matched no element in 2s/.test(miss.data?.result) && Date.now() - t0 < 6000, miss.data?.result);
  }

  section('7. fill on a rich-text iframe');
  {
    const edRef = (await call('find', { tabId, query: 'Rich Text Area' })).data?.candidates?.[0]?.ref;
    const f = await call('fill', { tabId, ref: edRef, value: 'Typed into the editor' });
    const body = await ev(tabId, `() => document.getElementById('ed').contentDocument.body.innerText.trim()`);
    check('filling the iframe ref fills its editable body', !f.isError && body === 'Typed into the editor', `${f.text.slice(0, 80)} | body=${JSON.stringify(body)}`);
    const nf = await call('fill', { tabId, ref: await ref(tabId, 'Save order'), value: 'x' });
    check('filling a non-field is refused, not ok', nf.isError && /not a field/.test(nf.text), nf.text.slice(0, 100));
    const inner = (await call('find', { tabId, query: 'Inner' })).data?.candidates?.[0]?.ref;
    const fi = await call('fill', { tabId, ref: inner, value: 'inside' });
    const iv = await ev(tabId, `() => document.getElementById('plain').contentDocument.getElementById('in2').value`);
    check('a plain input inside an iframe still fills', !fi.isError && iv === 'inside', iv);
  }

  section('8. domSnapshot');
  {
    const s = await run(tabId, `return await page.domSnapshot({ selector: '#save' });`);
    check('a selector on a leaf element includes the element', /button "Save order"/.test(s.data?.result || ''), JSON.stringify(s.data?.result).slice(0, 80));
  }

  section('9. Disabled controls');
  {
    const d = await call('click', { tabId, selector: '#off' });
    check('a ref click on a disabled button fails at once', d.isError && /disabled/.test(d.text) && d.ms < 4000, `${d.ms}ms ${d.text.slice(0, 80)}`);
    const a = await call('click', { tabId, selector: '#ariaoff' });
    const why = await ev(tabId, `() => document.getElementById('why').textContent`);
    check('an aria-disabled button still takes the click (it may explain itself)', !a.isError && why === 'explained', `${a.text.slice(0, 120)} why=${why}`);
    check('…and the receipt warns it is aria-disabled', /aria-disabled/.test(a.text), a.text.slice(0, 160));
    const t0 = Date.now();
    const sd = await run(tabId, `try { await page.locator('#off').click({timeoutMs:1500}); } catch (x) { return x.message; }`);
    check('a script click says the element stayed disabled', /stayed disabled/.test(sd.data?.result) && Date.now() - t0 < 6000, sd.data?.result);
  }

  section('10. Status after a navigating click');
  {
    const c = await call('click', { tabId, ref: await ref(tabId, 'Go to page 2') });
    check('a link click reports the new page in status', c.data?.navigated === true && c.data?.status?.title === 'Page 2', JSON.stringify(c.data?.status));
    await call('navigate', { tabId, url: PAGE });
    const j = await call('click', { tabId, ref: await ref(tabId, 'JS nav') });
    check('a JS location.href click reports the new page too', j.data?.status?.url?.endsWith('/page2'), j.data?.status?.url);
    await call('navigate', { tabId, url: PAGE });
    const quiet = await call('click', { tabId, ref: await ref(tabId, 'Save order') });
    check('a click that does not navigate is not slowed by the navigation watch', !quiet.isError && quiet.ms < 1500 && !quiet.data?.navigated, `${quiet.ms}ms`);
  }

  section('11/14. covered:true');
  {
    const p = (await call('read_page', { tabId, full: true })).data;
    const el = (n) => p.elements.find((e) => e.name === n);
    check('a button under the bar is covered', el('Buried')?.covered === true);
    check('a button painted above the bar is not', !el('Above bar')?.covered);
    check("an iframe's input is not covered by the top page's bar", !el('Inner')?.covered, JSON.stringify(el('Inner')));
    const again = (await call('read_page', { tabId })).data;
    check('the overlay hint is not repeated on an unchanged read', again?.covered >= 1 && !again.hint, JSON.stringify({ covered: again?.covered, hint: !!again?.hint }));
  }

  section('12. Click receipt');
  {
    const c = await call('click', { tabId, ref: await ref(tabId, 'Settings') });
    check('landedOn names the button, not the SVG path', c.data?.landedOn?.tag === 'button', JSON.stringify(c.data?.landedOn));
  }

  section('13. Intent');
  {
    const n = await call('click', { tabId, intent: 'the Delete account button' });
    check('an absent element says no match', n.isError && /nothing on the page matches/.test(n.text) && /Delete order/.test(n.text), n.text.slice(0, 140));
    const s = await call('click', { tabId, intent: 'Save order' });
    check('a real match is clicked', !s.isError && s.data?.resolvedBy === 'intent');
  }

  section('19. Console');
  {
    // The page's own console.error and thrown errors are captured once read_console has switched
    // capture on (it is detectable, so it is opt-in); network/browser errors are always captured.
    await call('read_console', { tabId, limit: 1 });
    const c = await call('click', { tabId, ref: await ref(tabId, 'Throw') });
    check('status quotes the first new error', c.data?.status?.newConsoleErrors >= 1 && /boom|lab-error/.test(JSON.stringify(c.data?.status?.firstErrors)), JSON.stringify(c.data?.status?.firstErrors));
    await call('read_console', { tabId, stop: true });
  }

  section('21. Tabs the agent opened by clicking');
  {
    const before = new Set(((await call('tabs_list', {})).data?.tabs || []).map((t) => t.id));
    await call('click', { tabId, ref: await ref(tabId, 'New tab') });
    await new Promise((r) => setTimeout(r, 800));
    const opened = ((await call('tabs_list', {})).data?.tabs || []).find((t) => !before.has(t.id) && String(t.url).includes('/page2'));
    const closed = opened ? await call('tab_close', { tabId: opened.id }) : null;
    check('tab_close closes the tab its click opened', closed && !closed.isError, closed?.text?.slice(0, 100) || 'no new tab seen');
  }

  section('6. world:"page"');
  {
    const w = await run(tabId, `return await page.evaluate(() => window.pageGlobal, null, { world: 'page' });`);
    check('page.evaluate world:page reads a page global', w.data?.result === 42, JSON.stringify(w.data));
    await call('read_console', { tabId, limit: 1 });
    await call('navigate', { tabId, url: ORIGIN + '/page2' }); await call('navigate', { tabId, url: PAGE });
    const w2 = await run(tabId, `return await page.evaluate(() => window.pageGlobal, null, { world: 'page' });`);
    check('…also with console capture on, after a navigation', w2.data?.result === 42, JSON.stringify(w2.data));
    const wm = await call('webmcp_tools', { tabId });
    check('webmcp_tools runs on a plain page', !wm.isError, wm.text.slice(0, 100));
    await call('read_console', { tabId, stop: true });
  }
} catch (e) {
  console.error(red('harness error: ' + (e.stack || e)));
  failures++;
} finally {
  if (tabId) await call('tab_close', { tabId }).catch(() => {});
  server.kill(); site.close();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
  process.exit(failures ? 1 : 0);
}
