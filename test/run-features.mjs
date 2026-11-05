#!/usr/bin/env node
// Exercises the capabilities ported from Codex's Chrome plugin: WebMCP tool discovery/invocation,
// page-asset inventory + bundling, and clipboard read/write. Also times the set-of-mark overlay,
// since it fans out a box measurement per interactable element.
//
//   node test/run-features.mjs

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'feature-harness.html'));
// A tiny 2x2 PNG and a stylesheet, so bundling has real network assets to fetch (not just the
// inline data: URIs the page also carries).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYEJRIAAIhoDATaMhH8AAAAASUVORK5CYII=', 'base64');
const site = http.createServer((req, res) => {
  if (req.url.startsWith('/logo.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  if (req.url.startsWith('/extra.css')) { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('#png{outline:1px solid #ccc}'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${site.address().port}/`;

const server = spawn('node', [path.join(HERE, '..', 'host', 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let idc = 0, buf = '';
server.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
const rpc = (method, params) => new Promise((res, rej) => { const id = ++idc; const to = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + method)); }, 200000); waiting.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).find((c) => c.type === 'text');
  const im = (r.content || []).find((c) => c.type === 'image');
  let data = null; if (t) { try { data = JSON.parse(t.text); } catch { data = t.text; } }
  return { data, image: im ? im.data : null, isError: !!r.isError };
}
const ev = async (tabId, e) => (await call('cdp', { tabId, method: 'Runtime.evaluate', world: 'page', params: { expression: e, returnByValue: true, awaitPromise: true } })).data?.result?.value;

const green = (s) => `\x1b[32m${s}\x1b[0m`, red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`, dim = (s) => `\x1b[2m${s}\x1b[0m`;
let failures = 0;
const check = (label, ok, detail) => { console.log(`  ${ok ? green('✓') : red('✗')} ${label}${detail ? dim('  ' + detail) : ''}`); if (!ok) failures++; };

async function main() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'feat', version: '1' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tabId = (await call('tab_create', { url: PAGE, active: false })).data.id;
  await call('wait_for', { tabId, state: 'load' });
  await new Promise((r) => setTimeout(r, 400));

  console.log(bold('\nWebMCP') + dim('  (page uses a spec-shaped test double: registerTool/getTools/executeTool)'));
  const t = (await call('webmcp_tools', { tabId })).data;
  check('discovers the page as WebMCP-capable', t.supported === true, `surface=${t.surface}`);
  check('lists both imperative tools', (t.tools || []).length === 2, (t.tools || []).map((x) => x.name).join(', '));
  check('carries each tool\'s inputSchema', !!(t.tools || []).find((x) => x.name === 'add-todo')?.inputSchema);
  check('finds the declarative [toolname] form', (t.declarative || []).length === 1, (t.declarative || [])[0]?.name);
  const decl = (t.declarative || [])[0];
  check('reads toolparamdescription off its inputs',
    !!decl?.fields?.find((f) => f.name === 'make' && f.description?.includes('BMW')),
    decl?.fields?.map((f) => f.name).join(', '));

  const called = (await call('webmcp_call', { tabId, name: 'add-todo', arguments: { text: 'ship the bridge' } }));
  check('executeTool runs the page tool', !called.isError && JSON.stringify(called.data).includes('successfully'),
    JSON.stringify(called.data).slice(0, 70));
  const todoText = await ev(tabId, 'document.querySelector("#todos li")?.textContent');
  check('the tool actually mutated the page', todoText === 'ship the bridge', `li = ${JSON.stringify(todoText)}`);
  const counted = (await call('webmcp_call', { tabId, name: 'count-todos', arguments: {} })).data;
  check('a second tool returns structured data', counted?.result?.count === 1, JSON.stringify(counted?.result));
  const missing = await call('webmcp_call', { tabId, name: 'nope', arguments: {} });
  check('an unknown tool name errors clearly', missing.isError && String(missing.data).includes('nope'),
    String(missing.data).slice(0, 80));

  console.log(bold('\nPage assets'));
  const a = (await call('page_assets', { tabId })).data;
  const kinds = a.summary?.byKind || {};
  check('inventories rendered assets', (a.assets || []).length > 0, JSON.stringify(kinds));
  check('catches the <img>', (a.assets || []).some((x) => x.kind === 'image'));
  check('catches the CSS background-image', (a.assets || []).filter((x) => x.kind === 'image').length >= 2,
    `${(a.assets || []).filter((x) => x.kind === 'image').length} images`);
  check('captures inline SVG markup', (a.inlineSvgs || []).some((s) => s.markup.includes('polygon')),
    (a.inlineSvgs || []).map((s) => s.name).join(', '));
  check('every asset has a stable id', (a.assets || []).every((x) => typeof x.id === 'string'));

  check('catches the network <img> and stylesheet',
    (a.assets || []).some((x) => x.url?.includes('/logo.png')) && (a.assets || []).some((x) => x.kind === 'stylesheet'),
    JSON.stringify(a.summary?.byKind));
  const t0 = Date.now();
  const b = (await call('bundle_assets', { tabId, kinds: ['image'], directory: 'cbb-feature-test' })).data;
  const bundleMs = Date.now() - t0;
  check('bundles them to disk', (b?.downloaded || 0) > 0, `${b?.downloaded}/${b?.requested} in ${bundleMs}ms → ${b?.directory || '—'}`);
  // No browser download UI is involved, so this must be I/O-fast. Anything near a second means
  // something is waiting on a human again.
  check('completes without any user interaction', bundleMs < 1500, `${bundleMs}ms`);
  check('writes to scratch space, not the user\'s Downloads folder',
    !!b?.directory && !b.directory.includes('Downloads') && b.directory.startsWith(os.tmpdir()), b?.directory);
  // An absolute directory must NOT escape scratch space — it is a name, not a path.
  const esc = (await call('bundle_assets', { tabId, kinds: ['image'], directory: '/Users/' + (process.env.USER || 'x') + '/Desktop/escape' })).data;
  // Correct containment test: the result must sit exactly one level under the scratch root, so a
  // path separator or .. in the name cannot traverse out of it. (The flattened name may still
  // CONTAIN words from the input — that is fine; what matters is where the directory actually is.)
  const scratchRoot = path.join(os.tmpdir(), 'claude-browser-bridge-assets');
  check('an absolute directory cannot escape scratch space',
    !!esc?.directory && path.dirname(path.resolve(esc.directory)) === scratchRoot, esc?.directory);
  const trav = (await call('bundle_assets', { tabId, kinds: ['image'], directory: '../../../../etc/evil' })).data;
  check('a traversal directory cannot escape either',
    !!trav?.directory && path.dirname(path.resolve(trav.directory)) === scratchRoot, trav?.directory);
  check('bundles inline data: assets too, not silently skipping them',
    (b?.files || []).some((f) => /\.(png|svg)$/.test(f.path)) && (b?.downloaded || 0) >= 3,
    `${b?.downloaded} files; failures: ${JSON.stringify(b?.failures || [])}`.slice(0, 140));
  const onDisk = (b?.files || []).filter((f) => { try { return fs.statSync(f.path).size > 0; } catch { return false; } });
  check('the files are readable locally', onDisk.length === (b?.files || []).length && onDisk.length > 0,
    onDisk.map((f) => path.basename(f.path)).join(', '));

  console.log(bold('\nClipboard'));
  const marker = 'cbb-clip-' + Date.now();
  const w = await call('clipboard_write', { tabId, text: marker });
  check('writes text', !w.isError && w.data?.ok === true, w.isError ? String(w.data).slice(0, 90) : '');
  const r = await call('clipboard_read', { tabId });
  check('reads it back', !r.isError && r.data?.text === marker, r.isError ? String(r.data).slice(0, 90) : `"${r.data?.text}"`);
  // Decisive check: put a value on the REAL system clipboard from outside the browser entirely.
  // If the read returns it, we are reading the OS clipboard and not echoing our own scratch field.
  const external = 'cbb-external-' + Date.now();
  let osOk = false;
  try { execSync('pbcopy', { input: external }); osOk = true; } catch { /* non-macOS */ }
  if (osOk) {
    const r2 = await call('clipboard_read', { tabId });
    check('reads a value set outside the browser (real OS clipboard)', r2.data?.text === external,
      r2.isError ? String(r2.data).slice(0, 90) : `"${r2.data?.text}"`);
  } else {
    console.log(dim('  – skipped OS-clipboard check (pbcopy unavailable)'));
  }

  console.log(bold('\nEditing') + dim('  (same-site iframe, contenteditable, background-tab speed)'));
  {
    const edit = `<!doctype html><body><textarea id=ta>t</textarea>`
      + `<div contenteditable id=ce aria-label=editor><p>old</p></div>`
      + `<iframe id=f srcdoc='<input aria-label=inner value=framevalue><div contenteditable role=textbox aria-label=frameeditor><p>old</p></div>`
      + `<script>let k=0;document.addEventListener("keydown",()=>{k++;document.body.dataset.keys=k},true)</script>'></iframe></body>`;
    const es = http.createServer((_, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(edit); });
    await new Promise((r) => es.listen(0, '127.0.0.1', r));
    const et = (await call('tab_create', { url: `http://127.0.0.1:${es.address().port}/`, active: false })).data.id;
    await call('wait_for', { tabId: et, state: 'load' });
    await new Promise((r) => setTimeout(r, 300));

    const els = (await call('read_page', { tabId: et, full: true })).data?.elements || [];
    const inner = els.find((e) => e.role === 'textbox' && e.value === 'framevalue');
    check('read_page lists a field inside a same-site iframe', !!inner, inner ? inner.ref : 'missing');
    if (inner) {
      const f = await call('fill', { tabId: et, ref: inner.ref, value: 'typed' });
      const got = await ev(et, 'f.contentDocument.querySelector("input").value');
      const keys = Number(await ev(et, 'f.contentDocument.body.dataset.keys || 0'));
      check('fill types into the iframe field', !f.isError && got === 'typed' && !f.data?.viaSetter && keys >= 5,
        f.isError ? String(f.data).slice(0, 90) : `value = ${JSON.stringify(got)}, ${keys} keydowns${f.data?.viaSetter ? ', viaSetter' : ''}`);
      const c = (await call('click', { tabId: et, ref: inner.ref })).data;
      check('a click inside the iframe is not reported as covered', c && !c.intercepted, JSON.stringify(c?.intercepted || null).slice(0, 80));
    }
    const fe = els.find((e) => e.name === 'frameeditor');
    check('read_page lists an editor inside the iframe', !!fe);
    if (fe) {
      const r = await call('fill', { tabId: et, ref: fe.ref, value: 'framed\ntext' });
      const t = await ev(et, 'f.contentDocument.querySelector("[contenteditable]").innerText');
      check('fill changes an editor inside the iframe', !r.isError && /framed/.test(t) && /text/.test(t), JSON.stringify(t));
    }

    const ce = await call('fill', { tabId: et, selector: '#ce', value: 'first\nsecond' });
    const ceText = await ev(et, 'ce.innerText');
    check('fill changes a contenteditable editor', !ce.isError && /first/.test(ceText) && /second/.test(ceText), JSON.stringify(ceText));
    const v = (await call('validate', { tabId: et, selector: '#ce', value: 'first\nsecond' })).data;
    check('validate reads an editor\'s text, not an invented .value', v?.ok === true && !(await ev(et, '"value" in ce')), JSON.stringify(v?.checks?.[0]));

    const t0 = Date.now();
    await call('fill', { tabId: et, selector: '#ta', value: 'hello world' });
    const ms = Date.now() - t0;
    check('fill in a background tab stays fast', ms < 5000, `${ms}ms for 11 chars`);

    await call('tab_close', { tabId: et });
    es.close();
  }

  console.log(bold('\nSet-of-mark cost') + dim('  (a box measurement per interactable element)'));
  for (const url of [PAGE, 'https://en.wikipedia.org/wiki/Set_cover_problem']) {
    const t2 = (await call('tab_create', { url, active: false })).data.id;
    await call('wait_for', { tabId: t2, state: 'load' });
    await new Promise((r2) => setTimeout(r2, 1200));
    const plain0 = Date.now(); await call('screenshot', { tabId: t2 }); const plain = Date.now() - plain0;
    const mk0 = Date.now(); const m = await call('screenshot', { tabId: t2, marks: true }); const mk = Date.now() - mk0;
    const n = m.data?.markCount ?? 0;
    if (!n) { failures++; console.log(red(`  ✗ ${url} produced no marks — the page did not load`)); }
    console.log(`  ${new URL(url).hostname.padEnd(22)} ${String(n).padStart(3)} marks   plain ${String(plain).padStart(4)}ms   marks ${String(mk).padStart(5)}ms   ${dim(`+${mk - plain}ms`)}`);
    await call('tab_close', { tabId: t2 });
  }

  await call('tab_close', { tabId });
  server.kill(); site.close();
  console.log(failures ? red(`\n${failures} check(s) failed`) : green('\nall feature checks passed'));
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(red('harness error: ' + e.message)); server.kill(); site.close(); process.exit(1); });
