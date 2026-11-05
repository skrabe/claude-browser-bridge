#!/usr/bin/env node
// Challenge handoff: a page that answers like a Cloudflare interstitial (title "Just a moment...",
// cf-mitigated: challenge) must show up as status.challenge, and challenge_wait must detach, wait
// while it stays up, and report cleared once the page moves on — without the bridge touching it.
//
//   node test/run-challenge.mjs        (needs the browser running with the extension loaded)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The interstitial clears itself after a delay, the way an invisible Turnstile check does, so the
// test can watch challenge_wait notice it without a human.
const CLEAR_AFTER_MS = 4000;
let firstHit = 0;
const site = http.createServer((req, res) => {
  if (req.url.startsWith('/widget')) {
    // An ordinary page that embeds a challenge widget (as a sign-up form with Turnstile does).
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>Sign up</title><h1>Sign up</h1><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/0/test" width="300" height="65"></iframe>');
  }
  if (req.url.startsWith('/protected')) {
    if (!firstHit) firstHit = Date.now();
    if (Date.now() - firstHit < CLEAR_AFTER_MS) {
      res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      return res.end(`<!doctype html><title>Just a moment...</title><p>Checking your browser.</p><script>setTimeout(()=>location.reload(),1000)</script>`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>Protected page</title><h1>Welcome through</h1>');
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>start</title><a href="/protected">go</a>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${site.address().port}`;

const server = spawn('node', [path.join(HERE, '..', 'host', 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map(); let idc = 0, buf = '';
server.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; let m; try { m = JSON.parse(l); } catch { continue; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });
const rpc = (method, params) => new Promise((res, rej) => { const id = ++idc; const to = setTimeout(() => { waiting.delete(id); rej(new Error('timeout ' + method)); }, 120000); waiting.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
async function call(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = (r.content || []).find((c) => c.type === 'text');
  let data = null; if (t) { try { data = JSON.parse(t.text); } catch { data = t.text; } }
  if (r.isError) throw new Error(`${name}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
let failed = 0, passed = 0;
const check = (name, ok, detail) => { ok ? passed++ : failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`); };

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'challenge', version: '0' } });
const tab = await call('tab_create', { url: BASE + '/', group: 'stealth-test' });
const tabId = tab.tabId ?? tab.id;
try {
  const nav = await call('navigate', { tabId, url: BASE + '/protected' });
  const ch = nav.status && nav.status.challenge;
  check('navigate reports the challenge in its status header', !!ch, ch ? `${ch.vendor}: ${ch.signals.join('; ')}` : JSON.stringify(nav.status));
  check('it names Cloudflare and marks it blocking', ch && ch.vendor === 'cloudflare' && ch.blocking === true);
  const pre = await call('challenge_wait', { tabId, check: true });
  check('challenge_wait check:true sees it without waiting', !!pre.challenge);
  const t0 = Date.now();
  const res = await call('challenge_wait', { tabId, timeoutMs: 30000, notify: false });
  check('challenge_wait returns cleared once the page moves on', res.cleared === true, JSON.stringify(res));
  check('it waited for the check rather than returning at once', Date.now() - t0 >= 1000, `${Date.now() - t0} ms`);
  const after = await call('read_text', { tabId });
  check('work resumes on the real page afterwards', /Welcome through/.test(after.text || ''), (after.text || '').slice(0, 60));
  const w = await call('navigate', { tabId, url: BASE + '/widget' });
  const wc = w.status && w.status.challenge;
  check('an embedded widget alone is not reported as blocking', !wc || wc.blocking === false, JSON.stringify(wc));
  const wres = await call('challenge_wait', { tabId, timeoutMs: 8000, notify: false });
  check('challenge_wait does not wait on a widget-only page', wres.cleared === true && wres.waitedMs < 2000, JSON.stringify(wres).slice(0, 160));
  const quiet = await call('navigate', { tabId, url: BASE + '/' });
  check('an ordinary page carries no challenge', !(quiet.status && quiet.status.challenge));
} finally {
  await call('tab_close', { tabId }).catch(() => {});
  server.kill(); site.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
