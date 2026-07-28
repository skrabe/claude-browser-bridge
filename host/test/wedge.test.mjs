#!/usr/bin/env node
// A timeout must not wedge the bridge permanently.
//
// Regression for a real incident: the MCP server kept its socket after a request timed out. If the
// far end had stopped answering (extension service worker reloaded or evicted), the socket still
// looked healthy, so every later call wrote into the void and timed out too — the bridge appeared
// dead until the process restarted. A timeout must drop the connection so the next call reconnects.

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Its own socket path, so the live bridge is never touched.
const SOCK = path.join(os.tmpdir(), `cbb-wedge-test-${process.pid}.sock`);

let pass = 0, fail = 0;
const ok = (label, cond, detail) => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`); };

function encode(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0);
  return Buffer.concat([h, b]);
}
function framer(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len); buf = buf.subarray(4 + len);
      try { onMsg(JSON.parse(body.toString('utf8'))); } catch {}
    }
  };
}

// A stand-in host. Silence is PER CONNECTION and permanent, which is what actually happens: when the
// extension's service worker goes away, the connection the client already holds never answers again,
// while a fresh connection reaches a live host. Modelling silence as a global flag that later
// switches back on would let the buggy code pass by simply reusing the dead socket.
let connections = 0;
const live = new Set();
const stalled = new Set(); // methods the (living) far end will not answer — models a busy page
const killExistingConnections = () => live.clear();
function startFakeHost() {
  const server = net.createServer((client) => {
    connections++;
    live.add(client);
    client.on('error', () => {});
    client.on('close', () => live.delete(client));
    client.on('data', framer((cmd) => {
      if (!live.has(client)) return;                       // connection is dead: never answers again
      if (stalled.has(cmd.method)) return;                  // alive, but this operation is stuck
      client.write(encode({ id: cmd.id, result: { pong: true } }));
    }));
  });
  return new Promise((res) => { try { fs.unlinkSync(SOCK); } catch {} server.listen(SOCK, () => res(server)); });
}

async function main() {
  const server = await startFakeHost();
  const mcp = spawn('node', [path.join(HERE, '..', 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, CBB_SOCK: SOCK, CBB_TIMEOUT_MS: '1500' } });
  const waiting = new Map(); let idc = 0, buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++idc;
    const to = setTimeout(() => rej(new Error('test harness timeout')), 90000);
    waiting.set(id, (m) => { clearTimeout(to); res(m); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const t = (r.result?.content || []).find((c) => c.type === 'text');
    return { text: t ? t.text : '', isError: !!r.result?.isError };
  };

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wedge', version: '1' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 1. Healthy call establishes the connection.
  const first = await call('tabs_list', {});
  ok('a healthy call succeeds', !first.isError && first.text.includes('pong'), first.text.slice(0, 60));
  const afterFirst = connections;

  // 2. The far end this client is attached to goes silent for good — this call must time out.
  killExistingConnections();
  const t0 = Date.now();
  const wedged = await call('tabs_list', {});
  const elapsed = Date.now() - t0;
  ok('a silent far end times out', wedged.isError && /timed out/.test(wedged.text), `${elapsed}ms`);
  ok('the timeout says the connection was dropped and to retry',
    /dropped/.test(wedged.text) && /retry/.test(wedged.text), wedged.text.slice(0, 80));

  // 3. THE REGRESSION: the next call must reconnect and work, not time out again. It can only
  // succeed by opening a NEW connection — the old one is silent forever, as in the real failure.
  const t1 = Date.now();
  const recovered = await call('tabs_list', {});
  const recoveredMs = Date.now() - t1;
  ok('the next call recovers instead of wedging', !recovered.isError && recovered.text.includes('pong'),
    `${recoveredMs}ms`);
  ok('it recovered by opening a NEW connection', connections > afterFirst, `${connections} total connections`);
  ok('recovery is immediate, not another full timeout', recoveredMs < 500, `${recoveredMs}ms`);

  // 4. Alive but BUSY: the operation must fail on its own budget WITHOUT tearing down a healthy
  //    connection. Getting this wrong is what broke a real session — a slow page load was treated as
  //    a dead worker, so the drop punished callers whose extension was fine.
  stalled.add('readPage');
  const beforeBusy = connections;
  const busy = await call('read_page', { tabId: 1 });
  ok('a busy page fails its own call', busy.isError && /exceeded/.test(busy.text), busy.text.slice(0, 70));
  ok('the busy message does NOT blame the service worker',
    !/service worker/.test(busy.text) && /connection is fine/.test(busy.text), busy.text.slice(0, 90));
  const afterBusy = await call('tabs_list', {});
  ok('the connection survives a busy-page timeout', !afterBusy.isError && afterBusy.text.includes('pong'));
  ok('no reconnect was needed', connections === beforeBusy, `${connections} total connections`);

  mcp.kill(); server.close();
  try { fs.unlinkSync(SOCK); } catch {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('wedge test error:', e.message);
  try { fs.unlinkSync(SOCK); } catch {}
  process.exit(1);
});
