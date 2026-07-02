#!/usr/bin/env node
// Claude Browser Bridge installer.
//   install  --scope global|project [--project <path>] [--browsers brave,chrome,edge]
//   uninstall
//   status
//   verify
//
// Pure config + files. Writes: native-messaging manifest(s), MCP server entry, the skill,
// and disables Claude-in-Chrome — all scoped. Records prior state for an exact uninstall.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // repo root
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const STATE = path.join(HOME, '.claude-browser-bridge', 'install-state.json');
const SOCK = `/tmp/claude-browser-bridge-${os.userInfo().username}.sock`;
const NH_NAME = 'com.claude.browserbridge';
const MCP_NAME = 'claude-browser';
const CIC = 'claude-in-chrome';

const BROWSERS = {
  brave: 'Library/Application Support/BraveSoftware/Brave-Browser',
  chrome: 'Library/Application Support/Google/Chrome',
  edge: 'Library/Application Support/Microsoft Edge',
  chromium: 'Library/Application Support/Chromium',
};

// ---- helpers ----
const readJSON = (p, d = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
function writeJSONAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');
  const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n'); fs.renameSync(tmp, p);
}
function extensionId() {
  const m = readJSON(path.join(ROOT, 'extension', 'manifest.json'));
  const der = Buffer.from(m.key, 'base64');
  const h = crypto.createHash('sha256').update(der).digest();
  let id = ''; for (let i = 0; i < 16; i++) id += String.fromCharCode(97 + (h[i] >> 4)) + String.fromCharCode(97 + (h[i] & 0xf));
  return id;
}
function detectedBrowsers() { return Object.entries(BROWSERS).filter(([, rel]) => fs.existsSync(path.join(HOME, rel))).map(([k]) => k); }
const log = (...a) => console.error('[bridge]', ...a);

function parseArgs(argv) {
  const o = { browsers: null, scope: null, project: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope') o.scope = argv[++i];
    else if (argv[i] === '--project') o.project = path.resolve(argv[++i]);
    else if (argv[i] === '--browsers') o.browsers = argv[++i].split(',').map(s => s.trim());
  }
  return o;
}

// ---- install ----
function install(opts) {
  const scope = opts.scope || 'global';
  const extId = extensionId();
  const node = process.execPath;
  // Always register with EVERY detected Chromium browser. Some (notably Brave) read
  // native-messaging manifests from Chrome's directory, not their own — so writing only to
  // the "selected" browser silently breaks discovery. The manifest is inert where unused.
  const browsers = detectedBrowsers();
  if (browsers.length === 0) throw new Error('no Chromium-family browser found');

  // 1) native-host wrapper (absolute node + bridge path)
  const wrap = path.join(ROOT, 'host', 'native-host');
  fs.writeFileSync(wrap, `#!/bin/sh\nexec "${node}" "${path.join(ROOT, 'host', 'bridge.mjs')}" --native-host\n`);
  fs.chmodSync(wrap, 0o755);

  // 2) native-messaging manifest per browser
  const manifest = { name: NH_NAME, description: 'Claude Browser Bridge native host', path: wrap, type: 'stdio', allowed_origins: [`chrome-extension://${extId}/`] };
  const wroteBrowsers = [];
  for (const b of browsers) {
    const dir = path.join(HOME, BROWSERS[b], 'NativeMessagingHosts');
    if (!fs.existsSync(path.dirname(dir))) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, NH_NAME + '.json'), JSON.stringify(manifest, null, 2) + '\n');
    wroteBrowsers.push(b);
  }

  // 3) MCP registration
  const mcpEntry = { type: 'stdio', command: node, args: [path.join(ROOT, 'host', 'bridge.mjs')], env: {} };
  let mcpTarget;
  if (scope === 'global') {
    const cj = readJSON(CLAUDE_JSON); cj.mcpServers = cj.mcpServers || {}; cj.mcpServers[MCP_NAME] = mcpEntry;
    writeJSONAtomic(CLAUDE_JSON, cj); mcpTarget = '~/.claude.json (user)';
  } else {
    const f = path.join(opts.project, '.mcp.json'); const j = readJSON(f); j.mcpServers = j.mcpServers || {}; j.mcpServers[MCP_NAME] = mcpEntry;
    writeJSONAtomic(f, j); mcpTarget = f;
  }

  // 4) skill
  const skillDest = scope === 'global'
    ? path.join(HOME, '.claude', 'skills', 'browser')
    : path.join(opts.project, '.claude', 'skills', 'browser');
  copyDir(path.join(ROOT, 'skill'), skillDest);

  // 5) disable Claude-in-Chrome (scoped) + record prior state
  const cj = readJSON(CLAUDE_JSON);
  const disable = {};
  if (scope === 'global') {
    disable.globalPrev = cj.claudeInChromeDefaultEnabled; // remember (could be true/undefined)
    cj.claudeInChromeDefaultEnabled = false;
  } else {
    cj.projects = cj.projects || {}; cj.projects[opts.project] = cj.projects[opts.project] || {};
    const list = cj.projects[opts.project].disabledMcpServers = cj.projects[opts.project].disabledMcpServers || [];
    disable.projectAlreadyDisabled = list.includes(CIC);
    disable.projectPath = opts.project;
    if (!list.includes(CIC)) list.push(CIC);
  }
  writeJSONAtomic(CLAUDE_JSON, cj);

  // 6) state for uninstall
  const state = { version: readJSON(path.join(ROOT, 'extension', 'manifest.json')).version, scope, project: opts.project, extId, bridgePath: ROOT, browsers: wroteBrowsers, skillDest, mcpTarget, disable };
  writeJSONAtomic(STATE, state);

  log('installed:');
  log('  extension id :', extId);
  log('  native host  :', wroteBrowsers.join(', '));
  log('  mcp          :', mcpTarget);
  log('  skill        :', skillDest);
  log('  claude-in-chrome disabled for', scope === 'global' ? 'ALL projects (global)' : opts.project);
  log('\nNext: load unpacked ->', path.join(ROOT, 'extension'), '; enable it; then: node setup.mjs verify');
  return state;
}

// ---- uninstall ----
function uninstall() {
  const state = readJSON(STATE, null);
  if (!state) { log('no install state found; nothing to uninstall'); return; }
  // native host manifests
  for (const b of state.browsers || []) {
    const f = path.join(HOME, BROWSERS[b], 'NativeMessagingHosts', NH_NAME + '.json');
    try { fs.unlinkSync(f); } catch {}
  }
  // MCP entry
  if (state.scope === 'global') {
    const cj = readJSON(CLAUDE_JSON); if (cj.mcpServers) delete cj.mcpServers[MCP_NAME]; writeJSONAtomic(CLAUDE_JSON, cj);
  } else {
    const f = path.join(state.project, '.mcp.json'); const j = readJSON(f); if (j.mcpServers) delete j.mcpServers[MCP_NAME]; writeJSONAtomic(f, j);
  }
  // skill
  try { fs.rmSync(state.skillDest, { recursive: true, force: true }); } catch {}
  // re-enable Claude-in-Chrome ONLY if we disabled it
  const cj = readJSON(CLAUDE_JSON);
  const d = state.disable || {};
  if (state.scope === 'global') {
    // restore prior value; if it was undefined (default) or true, we re-enable; if user had it false, leave false
    if (d.globalPrev === undefined) delete cj.claudeInChromeDefaultEnabled;
    else cj.claudeInChromeDefaultEnabled = d.globalPrev;
  } else if (!d.projectAlreadyDisabled && cj.projects?.[d.projectPath]?.disabledMcpServers) {
    cj.projects[d.projectPath].disabledMcpServers = cj.projects[d.projectPath].disabledMcpServers.filter(x => x !== CIC);
  }
  writeJSONAtomic(CLAUDE_JSON, cj);
  try { fs.unlinkSync(STATE); } catch {}
  log('uninstalled. Remove the unpacked extension manually from your browser (we cannot).');
  log('claude-in-chrome:', state.scope === 'global'
    ? (d.globalPrev === false ? 'left disabled (you had it off)' : 're-enabled')
    : (d.projectAlreadyDisabled ? 'left disabled (you had it off)' : 're-enabled for the project'));
}

// ---- verify / status ----
function verify(timeoutMs = 12000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = () => {
      if (!fs.existsSync(SOCK)) {
        if (Date.now() - started > timeoutMs) return resolve({ ok: false, reason: 'no socket — extension not loaded/enabled or browser not open' });
        return setTimeout(attempt, 500);
      }
      const s = net.createConnection(SOCK);
      let buf = Buffer.alloc(0);
      s.on('connect', () => { const b = Buffer.from(JSON.stringify({ id: 'v', method: 'getInfo', params: {} })); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); s.write(Buffer.concat([h, b])); });
      s.on('data', (d) => { buf = Buffer.concat([buf, d]); if (buf.length >= 4) { const l = buf.readUInt32LE(0); if (buf.length >= 4 + l) { const msg = JSON.parse(buf.subarray(4, 4 + l)); s.end(); resolve({ ok: !!msg.result, info: msg.result }); } } });
      s.on('error', () => { if (Date.now() - started > timeoutMs) resolve({ ok: false, reason: 'socket error' }); else setTimeout(attempt, 500); });
    };
    attempt();
  });
}
function status() {
  const state = readJSON(STATE, null);
  log('install state:', state ? `${state.scope} @ v${state.version}` : 'not installed');
  log('extension id :', extensionId());
  log('socket       :', fs.existsSync(SOCK) ? 'present' : 'absent');
  log('browsers found:', detectedBrowsers().join(', ') || 'none');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// ---- main ----
const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
try {
  if (cmd === 'install') install(opts);
  else if (cmd === 'uninstall') uninstall();
  else if (cmd === 'status') status();
  else if (cmd === 'verify') verify().then(r => { log('verify:', JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
  else { console.error('usage: setup.mjs install|uninstall|status|verify [--scope global|project] [--project <path>] [--browsers a,b]'); process.exit(2); }
} catch (e) { log('ERROR:', e.message); process.exit(1); }
