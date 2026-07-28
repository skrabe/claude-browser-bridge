#!/usr/bin/env node
// Coordinate-accuracy harness for the browser bridge.
//
// Drives test/coordinate-harness.html through the REAL MCP server (spawned as a child, same as
// Claude Code speaks to it) and measures, per targeting strategy, how often a click lands on the
// element it was aimed at and by how far it misses when it doesn't.
//
// The point is to separate two things that used to be conflated:
//   * screenshot pixels are not CSS pixels (a plumbing bug — this measures it and its fix)
//   * a model misreading a picture (not our bug; the harness reads exact centres instead of
//     guessing, so any miss it reports is ours)
//
// Requires the browser running with the extension loaded (the MCP server talks to the native host).
//   node test/run-coordinates.mjs [--keep]

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes('--keep');

// Serve the page over http rather than file:// — a file:// page needs "Allow access to file URLs"
// turned on per-extension, and its opaque origin blocks the same-origin iframe the harness uses.
const html = fs.readFileSync(path.join(HERE, 'coordinate-harness.html'));
const site = http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${site.address().port}/`;

// ---- minimal MCP client over the server's stdio ----
const server = spawn('node', [path.join(HERE, '..', 'host', 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let idc = 0, buf = '';
server.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
  }
});
function rpc(method, params) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout: ${method}`)); }, 200000);
    waiting.set(id, (m) => { clearTimeout(to); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
// Returns { data, image } — data is the parsed JSON text block, image the base64 png if present.
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.content || []).find((c) => c.type === 'text');
  const image = (r.content || []).find((c) => c.type === 'image');
  let data = null;
  if (text) { try { data = JSON.parse(text.text); } catch { data = text.text; } }
  if (r.isError) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return { data, image: image ? image.data : null };
}
const evalIn = async (tabId, expression) => (await call('cdp', {
  tabId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true },
})).data?.result?.value;

// ---- reporting ----
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'coord-harness', version: '1' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const { data: tab } = await call('tab_create', { url: PAGE, active: true });
  const tabId = tab.id;
  console.log(dim(`tab ${tabId} → ${PAGE}\n`));
  await call('wait_for', { tabId, state: 'load' });
  await new Promise((r) => setTimeout(r, 400)); // let the harness lay out

  const targets = await evalIn(tabId, 'window.__harness.targets()');
  if (!Array.isArray(targets) || !targets.length) throw new Error('harness did not expose targets — did the page load?');
  console.log(`${targets.length} targets laid out\n`);

  // Baseline shot: establishes the image↔CSS mapping we are testing.
  const shot = await call('screenshot', { tabId });
  const geo = shot.data.screenshot;
  console.log(bold('screenshot geometry'));
  console.log(`  viewport   ${geo.viewport.width}x${geo.viewport.height} css px`);
  console.log(`  image      ${geo.imageSize.width}x${geo.imageSize.height} px`);
  console.log(`  scale      ${geo.scale}   ${geo.scale === 1 ? '' : dim(`(a pixel read off the image is ${(1 / geo.scale).toFixed(3)}x a CSS pixel)`)}`);
  console.log(`  space      ${geo.space}\n`);

  // The pixel a perfect-vision model would report for each target, in image space.
  const toImage = (t) => ({ x: Math.round((t.x - geo.origin.x) * geo.scale), y: Math.round((t.y - geo.origin.y) * geo.scale) });

  // Marks give every interactable element a badge carrying its ref; match badges to targets by centre.
  const marked = await call('screenshot', { tabId, marks: true, boxes: true });
  const marks = marked.data.marks || [];
  const markFor = (t) => marks.find((m) => Math.abs(m.x + m.width / 2 - t.x) <= 3 && Math.abs(m.y + m.height / 2 - t.y) <= 3);

  const onscreen = targets.filter((t) => t.y >= 0 && t.y <= geo.viewport.height && t.x >= 0 && t.x <= geo.viewport.width);
  // The "V" row sits under a deliberate overlay: those clicks SHOULD be blocked, so they belong to
  // the interception check below, not to targeting accuracy.
  const reachable = onscreen.filter((t) => !t.tid.startsWith('V'));

  const STRATEGIES = [
    { name: 'ref (semantic)', note: 'dom_query → click{ref}',
      run: async (t) => {
        const q = await call('dom_query', { tabId, selector: `[data-tid="${t.tid}"]`, limit: 1 });
        const ref = q.data.matches?.[0]?.ref;
        if (!ref) return { skipped: 'no dom_query match (nested document)' };
        return (await call('click', { tabId, ref })).data;
      } },
    { name: 'screenshot pixel, no space', note: 'the old path: image px sent as if CSS px',
      run: async (t) => { const p = toImage(t); return (await call('click', { tabId, x: p.x, y: p.y })).data; } },
    { name: 'screenshot pixel, space:"image"', note: 'same pixel, declared space',
      run: async (t) => { const p = toImage(t); return (await call('click', { tabId, x: p.x, y: p.y, space: 'image' })).data; } },
    { name: 'set-of-mark badge', note: 'read the badge off the picture → click{ref}',
      run: async (t) => {
        const m = markFor(t);
        if (!m) return { skipped: 'no badge' };
        return (await call('click', { tabId, ref: m.ref })).data;
      } },
  ];

  const results = [];
  for (const s of STRATEGIES) {
    await evalIn(tabId, 'window.__harness.reset()');
    let hit = 0, missed = 0, skipped = 0, intercepted = 0;
    const offsets = [];
    for (const t of reachable) {
      await evalIn(tabId, `window.__harness.expect(${JSON.stringify(t.tid)})`);
      let r;
      try { r = await s.run(t); } catch (e) { r = { error: e.message }; }
      if (r?.skipped) { skipped++; continue; }
      if (r?.intercepted) intercepted++;
      const log = await evalIn(tabId, 'window.__harness.log()');
      const last = log[log.length - 1];
      if (last && last.hit) hit++;
      else {
        missed++;
        if (last) offsets.push(Math.hypot(last.x - t.x, last.y - t.y));
      }
    }
    const total = hit + missed;
    const mean = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 0;
    results.push({ ...s, hit, missed, skipped, total, mean, max: offsets.length ? Math.max(...offsets) : 0, intercepted });
  }

  console.log(bold('accuracy by targeting strategy') + dim(`  (${reachable.length} reachable on-screen targets)`));
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    const pct = r.total ? (r.hit / r.total) * 100 : 0;
    const tag = pct === 100 ? green('100%') : pct >= 50 ? `${pct.toFixed(0)}%` : red(`${pct.toFixed(0)}%`);
    let line = `  ${r.name.padEnd(width)}  ${String(r.hit).padStart(3)}/${String(r.total).padEnd(3)} ${tag}`;
    if (r.missed) line += red(`  mean miss ${r.mean.toFixed(0)}px, max ${r.max.toFixed(0)}px`);
    if (r.skipped) line += dim(`  (${r.skipped} skipped)`);
    console.log(line);
    console.log(dim(`  ${' '.repeat(width)}  ${r.note}`));
  }

  // Interception: the occluded row must be REPORTED, not silently swallowed.
  console.log('\n' + bold('interception reporting') + dim('  (targets under a transparent overlay)'));
  await evalIn(tabId, 'window.__harness.reset()');
  const veiled = onscreen.filter((t) => t.tid.startsWith('V'));
  let reported = 0;
  for (const t of veiled) {
    const q = await call('dom_query', { tabId, selector: `[data-tid="${t.tid}"]`, limit: 1 });
    const ref = q.data.matches?.[0]?.ref;
    if (!ref) continue;
    const r = (await call('click', { tabId, ref })).data;
    if (r.intercepted) reported++;
  }
  console.log(`  ${reported}/${veiled.length} occluded clicks reported an interception `
    + (reported === veiled.length ? green('✓') : red('✗ — a covered click still looked like a success')));

  // probe_point must name what is really at a coordinate.
  console.log('\n' + bold('probe_point resolution'));
  let named = 0;
  const sample = onscreen.filter((t) => t.tid.startsWith('G')).slice(0, 8);
  let refClicks = 0;
  for (const t of sample) {
    const p = toImage(t);
    const r = (await call('probe_point', { tabId, x: p.x, y: p.y, space: 'image' })).data;
    const el = r.hit || r.clickable;
    // The probe identified the right element if the box it reports is the target's own box.
    const b = el && el.box;
    if (b && Math.abs(b.x + b.width / 2 - t.x) <= 2 && Math.abs(b.y + b.height / 2 - t.y) <= 2) named++;
    // and the ref it hands back must actually click that target
    if (r.ref) {
      await evalIn(tabId, `window.__harness.expect(${JSON.stringify(t.tid)})`);
      await call('click', { tabId, ref: r.ref });
      const log = await evalIn(tabId, 'window.__harness.log()');
      if (log[log.length - 1]?.hit) refClicks++;
    }
  }
  console.log(`  ${named}/${sample.length} probes identified the exact element under an image-space pixel `
    + (named === sample.length ? green('✓') : red('✗')));
  console.log(`  ${refClicks}/${sample.length} of the refs they returned then clicked that target `
    + (refClicks === sample.length ? green('✓') : red('✗')));

  // Element-clip screenshots: CDP's clip rect and DOM.getBoxModel do not obviously share an origin,
  // so rather than assume, capture the same element unscrolled and scrolled. If the clip is being
  // built in the wrong space the second capture frames a different region and the bytes diverge.
  console.log('\n' + bold('element screenshot under scroll'));
  const anchor = onscreen.find((t) => t.tid === 'G1');
  let clipVerdict = 'skipped';
  if (anchor) {
    const q = await call('dom_query', { tabId, selector: '[data-tid="G1"]', limit: 1 });
    const ref = q.data.matches?.[0]?.ref;
    if (ref) {
      const a = await call('screenshot', { tabId, ref });
      await evalIn(tabId, 'window.scrollTo(0, 300)');
      await new Promise((r) => setTimeout(r, 200));
      const b = await call('screenshot', { tabId, ref });
      await evalIn(tabId, 'window.scrollTo(0, 0)');
      await new Promise((r) => setTimeout(r, 200));
      const same = a.image === b.image;
      clipVerdict = same ? 'ok' : 'drifts';
      console.log(`  same element, scrollY 0 vs 300 → ${same ? green('identical capture ✓') : red('different capture ✗ — clip origin is in the wrong space')}`);
      console.log(dim(`  ${a.data.screenshot.imageSize.width}x${a.data.screenshot.imageSize.height} px, origin ${JSON.stringify(a.data.screenshot.origin)}, scale ${a.data.screenshot.scale}`));
    }
  }

  const failed = (clipVerdict === 'drifts' ? { name: 'element screenshot under scroll', hit: 0, total: 1 } : null)
    || (named !== sample.length ? { name: 'probe_point element identification', hit: named, total: sample.length } : null)
    || (refClicks !== sample.length ? { name: 'probe_point ref click-through', hit: refClicks, total: sample.length } : null)
    || (reported !== veiled.length ? { name: 'interception reporting', hit: reported, total: veiled.length } : null)
    || results.find((r) => r.name.includes('space:"image"') && r.hit !== r.total)
    || results.find((r) => r.name.startsWith('ref') && r.hit !== r.total)
    || results.find((r) => r.name.includes('set-of-mark') && r.hit !== r.total);
  if (!KEEP) await call('tab_close', { tabId });
  else console.log(dim('\n--keep: tab left open with the error overlay drawn'));

  server.kill(); site.close();
  if (failed) { console.log(red(`\nFAIL: "${failed.name}" should land every click, got ${failed.hit}/${failed.total}`)); process.exit(1); }
  console.log(green('\nPASS'));
  process.exit(0);
}

main().catch((e) => { console.error(red("harness error: " + e.message)); server.kill(); site.close(); process.exit(1); });
