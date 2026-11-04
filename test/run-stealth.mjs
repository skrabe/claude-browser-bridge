#!/usr/bin/env node
// Measures what a page can learn about the bridge driving it: the Runtime-domain console
// serialization leak, bridge globals left in the page's own JS world, whether fill/type produce
// trusted keystrokes, and whether a click arrives with pointer movement before it.
//
//   node test/run-stealth.mjs
//
// Needs the browser running with the extension loaded (it drives a real tab, opened in its own
// tab group and closed at the end).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'stealth-harness.html'));
const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${site.address().port}/`;

const server = spawn('node', [path.join(HERE, '..', 'host', 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let idc = 0, buf = '';
server.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
const rpc = (method, params) => new Promise((res, rej) => { const id = ++idc; const to = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + method)); }, 60000); waiting.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).find((c) => c.type === 'text');
  let data = null; if (t) { try { data = JSON.parse(t.text); } catch { data = t.text; } }
  if (r.isError) throw new Error(`${name}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stealth', version: '0' } });
const tab = await call('tab_create', { url: PAGE, group: 'stealth-test' });
const tabId = tab.tabId ?? tab.id;
let failed = 0; const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`); };
try {
  await call('wait_for', { tabId, selector: '#go' });
  // Exercise every page-touching tool once, then let the bait loop run.
  await call('read_page', { tabId });
  await call('read_text', { tabId });
  await call('find_text', { tabId, query: 'Stealth' });
  await call('dom_query', { tabId, selector: '#name' });
  const name = (await call('find', { tabId, query: 'Name' }));
  const nameRef = (await call('dom_query', { tabId, selector: '#name' })).matches[0].ref;
  const pwRef = (await call('dom_query', { tabId, selector: '#pw' })).matches[0].ref;
  const goRef = (await call('dom_query', { tabId, selector: '#go' })).matches[0].ref;
  await call('fill', { tabId, ref: nameRef, value: 'Ada' });
  await call('fill', { tabId, ref: pwRef, value: 'hunter2' });
  await call('click', { tabId, ref: goRef });
  await call('validate', { tabId, text: 'Stealth' });
  await call('run', { tabId, script: `await page.getByRole('button', { name: 'Go' }).click(); return await page.title();` });
  await call('screenshot', { tabId, marks: true });
  await sleep(800);
  void name;
  // Read the page's own findings. This read is itself a Runtime call, so take it last.
  const probe = (await call('run', { tabId, script: `return await page.evaluate(() => JSON.parse(document.getElementById('out').textContent || '{}'));` }));
  const P = probe && 'result' in probe ? probe.result : probe;
  // A page-world global read through the bridge's own evaluate must come back undefined: our
  // evaluations do not run in the page's world.
  const seen = (await call('run', { tabId, script: `return await page.evaluate(() => typeof window.__probe);` })).result;
  check('bridge evaluations run outside the page world', seen === 'undefined', 'typeof window.__probe from evaluate = ' + seen);
  const opted = (await call('run', { tabId, script: `return await page.evaluate(() => typeof window.__probe, null, { world: 'page' });` })).result;
  check("page.evaluate {world:'page'} reaches page globals when asked", opted === 'object', 'typeof window.__probe = ' + opted);
  check('no Runtime-domain console leak', P.runtimeLeak === false, P.runtimeLeak ? 'page saw its console args serialized' : '');
  const ms = [...P.consoleMs].sort((a, b) => a - b); const p90 = ms[Math.floor(ms.length * 0.9)] ?? 0;
  check('console calls are not serialized (timing side channel)', p90 < 0.5, `p90 console.debug(big) = ${p90.toFixed(2)} ms over ${ms.length} samples`);
  check('no bridge globals in the page world', P.ownGlobals.length === 0, P.ownGlobals.join(', '));
  const nameInputs = P.inputs.filter((e) => e.id === 'name');
  check('fill types trusted input events', nameInputs.length > 0 && nameInputs.every((e) => e.trusted), JSON.stringify(nameInputs.slice(0, 3)));
  check('fill sends keystrokes', P.keys.filter((k) => k.id === 'name').length >= 3, `${P.keys.filter((k) => k.id === 'name').length} keydowns`);
  const gaps = P.keys.filter((k) => k.id === 'name').map((k, i, a) => i ? k.t - a[i - 1].t : null).filter((x) => x != null);
  check('keystrokes have human-scale gaps', gaps.length > 0 && Math.min(...gaps) >= 15, gaps.map((g) => Math.round(g)).join(','));
  check('password fill is trusted', P.inputs.filter((e) => e.id === 'pw').every((e) => e.trusted) && P.inputs.some((e) => e.id === 'pw'));
  check('clicks are trusted', P.clicks.length >= 2 && P.clicks.every((c) => c.trusted), JSON.stringify(P.clicks));
  check('pointer moves along a path before the click', P.clicks.length > 0 && P.clicks[0].moves >= 5, `${P.clicks[0]?.moves ?? 0} mousemoves before first click`);
} finally {
  await call('tab_close', { tabId }).catch(() => {});
  server.kill(); site.close();
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
