#!/usr/bin/env node
// Claude Browser Bridge — dual-mode host.
//
//   --native-host : launched BY the browser (native messaging). Talks NM stdio with the
//                   extension AND listens on a 0600 unix socket for the MCP side.
//   (default)     : launched BY Claude Code (MCP stdio server). Connects to that unix socket
//                   and exposes browser tools. No TCP port anywhere.
//
// Wire between the two of our own processes = the same 4-byte LE length prefix + JSON.
// Chrome native messaging framing = 4-byte native-endian length + JSON (LE on arm64/x64 macs).

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';

// Fixed /tmp path (symlink to /private/tmp) so the browser-spawned native host and the
// Claude-spawned MCP server always rendezvous — os.tmpdir() is $TMPDIR-dependent and can
// differ between the two processes.
const SOCK = `/tmp/claude-browser-bridge-${os.userInfo().username}.sock`;

// ---- framing (4-byte LE length + UTF-8 JSON) ----
function encode(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length, 0);
  return Buffer.concat([h, b]);
}
function framer(onMsg) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try { onMsg(JSON.parse(body.toString('utf8'))); } catch {}
    }
  };
}

if (process.argv.includes('--native-host')) runNativeHost();
else runMcpServer();

// ============================================================================
// NATIVE HOST MODE  (browser <-> us <-> MCP clients)
// ============================================================================
function runNativeHost() {
  const pending = new Map();     // hostId -> { client, origId }
  const eventClients = new Set();
  let counter = 0;

  const toExt = (obj) => process.stdout.write(encode(obj));

  // messages FROM the extension
  process.stdin.on('data', framer((msg) => {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { client, origId } = pending.get(msg.id);
      pending.delete(msg.id);
      write(client, { id: origId, result: msg.result, error: msg.error });
    } else if (msg.method === 'onCDPEvent') {
      for (const c of eventClients) write(c, msg);
    }
  }));
  process.stdin.on('end', () => process.exit(0));

  // unix socket server for the MCP side
  try { fs.unlinkSync(SOCK); } catch {}
  const server = net.createServer((client) => {
    eventClients.add(client);
    client.on('data', framer((cmd) => {
      const hostId = `h${counter++}`;
      pending.set(hostId, { client, origId: cmd.id });
      toExt({ id: hostId, method: cmd.method, params: cmd.params });
    }));
    client.on('close', () => eventClients.delete(client));
    client.on('error', () => {});
  });
  const oldUmask = process.umask(0o177); // -> socket mode 0600
  server.listen(SOCK, () => process.umask(oldUmask));
}
function write(sock, obj) { try { sock.write(encode(obj)); } catch {} }

// ============================================================================
// MCP SERVER MODE  (Claude Code <-> us <-> native host)
// ============================================================================
function runMcpServer() {
  let sock = null;
  const socketReqs = new Map();
  let idc = 0;

  function connectSocket() {
    return new Promise((res, rej) => {
      if (sock && !sock.destroyed) return res(sock);
      const s = net.createConnection(SOCK);
      s.on('data', framer((msg) => {
        const r = socketReqs.get(msg.id);
        if (r) { socketReqs.delete(msg.id); r(msg); }
      }));
      s.on('connect', () => { sock = s; res(s); });
      s.on('error', (e) => { if (!sock) rej(e); });
      s.on('close', () => { sock = null; });
    });
  }
  async function callHost(method, params) {
    let s;
    try { s = await connectSocket(); }
    catch { throw new Error('browser bridge host not running — open your browser with the extension loaded'); }
    const id = `m${idc++}`;
    return new Promise((resolve, reject) => {
      socketReqs.set(id, (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)));
      s.write(encode({ id, method, params }));
    });
  }

  // ---- tool surface (Codex functionality) ----
  const TOOLS = [
    { name: 'tabs_list', description: "List the user's real open tabs across all windows (id, title, url, tabGroup). Prefer claiming an existing tab over opening a new one.", inputSchema: { type: 'object', properties: {} } },
    { name: 'tab_claim', description: 'Take control of an EXISTING tab in place by id (from tabs_list). Attaches the debugger; does not open a new tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
    { name: 'tab_create', description: 'Open a new tab and take control of it.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' } } } },
    { name: 'navigate', description: 'Navigate a controlled tab to a URL (skips reload if already there).', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, url: { type: 'string' } }, required: ['tabId', 'url'] } },
    { name: 'screenshot', description: 'Capture a PNG screenshot of a controlled tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
    { name: 'read_text', description: 'Return the visible text content of a controlled tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
    { name: 'click', description: 'Click at viewport coordinates (x, y) in a controlled tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['tabId', 'x', 'y'] } },
    { name: 'type_text', description: 'Type text into the currently focused element of a controlled tab.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, text: { type: 'string' } }, required: ['tabId', 'text'] } },
    { name: 'cdp', description: 'Escape hatch: send a raw Chrome DevTools Protocol command to a controlled tab. method e.g. "Runtime.evaluate", params per CDP.', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, method: { type: 'string' }, params: { type: 'object' } }, required: ['tabId', 'method'] } },
    { name: 'tab_release', description: 'Detach from a tab and hand it back to the user (does not close it).', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  ];

  async function cdp(tabId, method, params) {
    return callHost('executeCdp', { tabId, cdpMethod: method, cdpParams: params || {} });
  }

  async function dispatch(name, a) {
    switch (name) {
      case 'tabs_list': return await callHost('getUserTabs', {});
      case 'tab_claim': return await callHost('claimTab', { tabId: a.tabId });
      case 'tab_create': return await callHost('createTab', { url: a.url, active: a.active });
      case 'tab_release': return await callHost('release', { tabId: a.tabId });
      case 'navigate': { await cdp(a.tabId, 'Page.enable', {}); return await cdp(a.tabId, 'Page.navigate', { url: a.url }); }
      case 'read_text': {
        const r = await cdp(a.tabId, 'Runtime.evaluate', { expression: 'document.body?.innerText ?? ""', returnByValue: true });
        return r?.result?.value ?? '';
      }
      case 'click': {
        await cdp(a.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        await cdp(a.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', clickCount: 1 });
        return { ok: true };
      }
      case 'type_text': { await cdp(a.tabId, 'Input.insertText', { text: a.text }); return { ok: true }; }
      case 'screenshot': {
        const r = await cdp(a.tabId, 'Page.captureScreenshot', { format: 'png' });
        return { __image: r?.data, mimeType: 'image/png' };
      }
      case 'cdp': return await cdp(a.tabId, a.method, a.params);
      default: throw new Error('unknown tool: ' + name);
    }
  }

  // ---- minimal MCP stdio (newline-delimited JSON-RPC 2.0) ----
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let inbuf = '';
  process.stdin.on('data', (d) => {
    inbuf += d;
    let i;
    while ((i = inbuf.indexOf('\n')) >= 0) {
      const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 1);
      if (line.trim()) handle(JSON.parse(line));
    }
  });

  async function handle(msg) {
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'claude-browser-bridge', version: '0.1.0' } } });
    } else if (msg.method === 'notifications/initialized') {
      /* no-op */
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      try {
        const r = await dispatch(msg.params.name, msg.params.arguments || {});
        let content;
        if (r && r.__image) content = [{ type: 'image', data: r.__image, mimeType: r.mimeType }];
        else content = [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }];
        send({ jsonrpc: '2.0', id: msg.id, result: { content } });
      } catch (e) {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Error: ' + ((e && e.message) || e) }], isError: true } });
      }
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
  }
}
