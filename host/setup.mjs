#!/usr/bin/env node
// Claude Browser Bridge installer.
//   install  --scope global|project [--project <path>]   (registers with every detected Chromium browser)
//   uninstall
//   desktop    finish the Claude Desktop step once the app is closed (exit 3 while it still runs)
//   status
//   verify
//
// Pure config + files. Writes: native-messaging manifest(s), MCP server entry, the skill,
// and disables Claude-in-Chrome (the CLI's, scoped; the desktop app's on a global install).
// Records prior state for an exact uninstall.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // repo root
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const STATE = path.join(HOME, '.claude-browser-bridge', 'install-state.json');
const SOCK = `/tmp/claude-browser-bridge-${os.userInfo().username}.sock`;
const NH_NAME = 'com.claude.browserbridge';
// Claude Desktop launches Code sessions with its own names in deniedMcpServers and folds `-` into
// `_`, so `claude-browser` collided with its reserved `claude_browser` and was silently dropped a few
// seconds into every desktop session. Keep this name clear of anything Claude-branded.
const MCP_NAME = 'browser-bridge';
const LEGACY_MCP_NAMES = ['claude-browser'];
const CIC = 'claude-in-chrome';
// Claude Desktop (macOS) injects its own Claude in Chrome server into every session, gated by
// this preference. The app loads the file once at launch and later writes its whole in-memory copy
// back on any preference change, so an edit made while it runs is silently reverted: only edit it
// while the app is closed. DESKTOP_STATE records the value we replaced, for the restore.
const DESKTOP_CONFIG = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const DESKTOP_PREF = 'chromeExtensionEnabled';
const DESKTOP_STATE = path.join(HOME, '.claude-browser-bridge', 'desktop-state.json');
const DESKTOP_PENDING_EXIT = 3;

// Pre-0.10.2 install-state files stored these keys in `browsers` instead of home-relative
// paths; kept ONLY so uninstall can resolve them. Detection is fully structural (below).
const LEGACY_STATE_DIRS = {
  brave: 'Library/Application Support/BraveSoftware/Brave-Browser',
  chrome: 'Library/Application Support/Google/Chrome',
  edge: 'Library/Application Support/Microsoft Edge',
  chromium: 'Library/Application Support/Chromium',
};

// ---- helpers ----
const readJSON = (p, d = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
function writeJSONAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // pristine backup, ONCE — a single install writes ~/.claude.json twice; don't let the 2nd clobber it
  if (fs.existsSync(p) && !fs.existsSync(p + '.bak')) fs.copyFileSync(p, p + '.bak');
  writeFileAtomic(p, JSON.stringify(obj, null, 2) + '\n');
}
// Write through a symlink (dotfile-managed settings stay linked) and keep the file's mode: these
// files can hold secrets and are often 0600, which a plain tmp+rename would widen to 0644.
function writeFileAtomic(p, text) {
  let target = p, mode;
  try { target = fs.realpathSync(p); mode = fs.statSync(target).mode & 0o777; } catch {}
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, text);
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, target);
}
function hasDesktopApp() {
  return process.platform === 'darwin' && fs.existsSync(path.dirname(DESKTOP_CONFIG));
}
// ps, not pgrep: pgrep does not list the app's main process on macOS.
function desktopRunning() {
  if (process.env.CBB_DESKTOP_RUNNING) return process.env.CBB_DESKTOP_RUNNING === '1'; // tests
  try {
    return execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').some(l => l.endsWith('Claude.app/Contents/MacOS/Claude'));
  } catch { return false; }
}
function readDesktopConfig() {
  if (!fs.existsSync(DESKTOP_CONFIG)) return {};
  try { return JSON.parse(fs.readFileSync(DESKTOP_CONFIG, 'utf8')); }
  catch (e) { throw new Error(`cannot parse ${DESKTOP_CONFIG} (${e.message}); fix or remove it, then retry`); }
}
// value === undefined removes the key (the app's default, on).
function setDesktopPref(value) {
  const cfg = readDesktopConfig();
  const prefs = cfg.preferences = cfg.preferences || {};
  if (prefs[DESKTOP_PREF] === value) return;
  if (value === undefined) delete prefs[DESKTOP_PREF]; else prefs[DESKTOP_PREF] = value;
  writeFileAtomic(DESKTOP_CONFIG, JSON.stringify(cfg, null, 2) + '\n');
}
// Bring the desktop app's Claude in Chrome in line with the install: off while a global install
// exists, otherwise back to what it was before we turned it off. Idempotent; safe to rerun.
//   'none'    nothing to do (no desktop app, or nothing of ours to undo)
//   'ok'      already as wanted
//   'applied' changed it now
//   'pending' the app is running, so the change has to wait until it is closed
function syncDesktop() {
  if (!hasDesktopApp()) return { status: 'none' };
  const inst = readJSON(STATE, null);
  const want = inst && inst.scope === 'global' ? 'off' : 'restore';
  const rec = readJSON(DESKTOP_STATE, null);
  if (want === 'restore' && !rec) return { status: 'none', want };
  const current = readDesktopConfig().preferences?.[DESKTOP_PREF];
  const target = want === 'off' ? false : (rec.hadValue ? rec.prev : undefined);
  if (current === target) {
    // Already off before we got here: remember that, so the restore leaves it off.
    if (want === 'off' && !rec) writeDesktopState({ hadValue: true, prev: false });
    if (want === 'restore') fs.rmSync(DESKTOP_STATE, { force: true });
    return { status: 'ok', want };
  }
  if (desktopRunning()) return { status: 'pending', want };
  if (want === 'off') {
    if (!rec) writeDesktopState({ hadValue: current !== undefined, prev: current });
    setDesktopPref(false);
  } else {
    setDesktopPref(target);
    fs.rmSync(DESKTOP_STATE, { force: true });
  }
  return { status: 'applied', want };
}
function writeDesktopState(obj) {
  fs.mkdirSync(path.dirname(DESKTOP_STATE), { recursive: true });
  writeFileAtomic(DESKTOP_STATE, JSON.stringify(obj, null, 2) + '\n');
}
function logDesktop(r) {
  if (r.status === 'none') return;
  const what = r.want === 'off' ? 'Claude in Chrome off' : 'Claude in Chrome restored';
  if (r.status === 'pending') {
    log(`claude desktop: running, so it would overwrite its settings. Quit it (Cmd+Q), then run: node ${path.join(ROOT, 'host', 'setup.mjs')} desktop`);
  } else log('claude desktop:', what);
}
// An entry is ours when it runs some clone's host/bridge.mjs; never touch a same-named server
// that belongs to something else.
const ownsEntry = (e) => Array.isArray(e?.args) && e.args.some(a => typeof a === 'string' && a.endsWith(path.join('host', 'bridge.mjs')));
function removeMcpEntries(file, names) {
  const j = readJSON(file, null);
  const owned = names.filter(n => j?.mcpServers && ownsEntry(j.mcpServers[n]));
  if (!owned.length) return false;
  for (const n of owned) delete j.mcpServers[n];
  writeJSONAtomic(file, j);
  return true;
}
// Permission rules and hook matchers name tools as mcp__<server>__<tool>; carry them over to the
// new server name with a text replace so the rest of the file keeps its formatting. Planned before
// any install write so a malformed file fails the install up front.
function planToolRefs(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  let out = text;
  for (const old of LEGACY_MCP_NAMES) out = out.split(`mcp__${old}__`).join(`mcp__${MCP_NAME}__`).split(`"mcp__${old}"`).join(`"mcp__${MCP_NAME}"`);
  const hasLegacyApproval = LEGACY_MCP_NAMES.some(n => text.includes(`"${n}"`));
  if (out === text && !hasLegacyApproval) return null;
  let obj;
  try { obj = JSON.parse(out); } catch (e) { throw new Error(`cannot parse ${file} (${e.message}); fix it, then reinstall`); }
  if (renameApprovals(obj)) out = JSON.stringify(obj, null, 2) + '\n';
  return out === text ? null : { file, out };
}
// Project .mcp.json servers are approved by bare name; carry an approval over to the new name.
function renameApprovals(obj) {
  let changed = false;
  for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
    const list = obj?.[key];
    if (!Array.isArray(list) || !list.some(n => LEGACY_MCP_NAMES.includes(n))) continue;
    obj[key] = [...new Set(list.map(n => LEGACY_MCP_NAMES.includes(n) ? MCP_NAME : n))];
    changed = true;
  }
  return changed;
}
function settingsFiles(scope, project) {
  const dir = scope === 'global' ? path.join(HOME, '.claude') : path.join(project, '.claude');
  return [path.join(dir, 'settings.json'), path.join(dir, 'settings.local.json')];
}
function extensionId() {
  const m = readJSON(path.join(ROOT, 'extension', 'manifest.json'));
  const der = Buffer.from(m.key, 'base64');
  const h = crypto.createHash('sha256').update(der).digest();
  let id = ''; for (let i = 0; i < 16; i++) id += String.fromCharCode(97 + (h[i] >> 4)) + String.fromCharCode(97 + (h[i] & 0xf));
  return id;
}
// Detect every Chromium-family browser on this machine by structure, not by name — a
// hardcoded list silently breaks on each new fork (Arc, Aside, Helium, …), and each fork
// reads native-messaging manifests ONLY from its own user-data dir. A qualifying dir
// (≤2 levels under the platform config root) has all three Chromium runtime artifacts:
//   Local State           — the browser has actually run here
//   Default / "Profile N"  — a real user profile (Electron apps fail this or the next)
//   NativeMessagingHosts  — the native-messaging surface, created by Chromium on first run
// Firefox fails the first (and uses a different manifest schema anyway); phantom dirs that
// other installers created just to drop a manifest into fail all three.
function isUserDataDir(d) {
  try {
    if (!fs.statSync(path.join(d, 'Local State')).isFile()) return false;
    if (!fs.statSync(path.join(d, 'NativeMessagingHosts')).isDirectory()) return false;
    if (fs.existsSync(path.join(d, 'Default'))) return true;
    return fs.readdirSync(d).some(n => /^Profile \d+$/.test(n));
  } catch { return false; }
}
function detectedBrowsers() {
  const root = process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support')
    : path.join(HOME, '.config');
  const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(d, e.name)); } catch { return []; } };
  const found = [];
  for (const d1 of subdirs(root))
    for (const c of [d1, ...subdirs(d1)])
      if (isUserDataDir(c)) found.push(path.relative(HOME, c));
  return found.sort();
}
const log = (...a) => console.error('[bridge]', ...a);

function parseArgs(argv) {
  const o = { scope: null, project: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--scope') o.scope = argv[++i];
    else if (argv[i] === '--project') o.project = path.resolve(argv[++i]);
  }
  return o;
}

// ---- install ----
function install(opts) {
  const scope = opts.scope || 'global';
  const extId = extensionId();
  const node = process.execPath;
  // Register with EVERY detected Chromium browser — the manifest is inert where unused,
  // and per-browser selection just creates "works in Chrome, dead in the fork" bugs.
  const browsers = detectedBrowsers();
  if (browsers.length === 0) throw new Error('no Chromium-family browser found');
  const prev = readJSON(STATE, null);
  // Fail before any write if the desktop config we may edit later is unreadable.
  if (hasDesktopApp() && (scope === 'global' || prev?.scope === 'global')) readDesktopConfig();
  const mcpFile = scope === 'global' ? CLAUDE_JSON : path.join(opts.project, '.mcp.json');
  const existing = readJSON(mcpFile).mcpServers?.[MCP_NAME];
  if (existing && !ownsEntry(existing)) throw new Error(`${mcpFile} already has an MCP server named "${MCP_NAME}" that is not this bridge; rename or remove it, then reinstall`);
  // Tool references can sit in user settings (they apply everywhere) and in either scope's project
  // settings: migrate all of them.
  const settings = new Set([...settingsFiles('global'), ...settingsFiles(scope, opts.project)]);
  if (prev && (prev.scope === 'global' || prev.project)) for (const f of settingsFiles(prev.scope, prev.project)) settings.add(f);
  const refPlans = [...settings].map(planToolRefs).filter(Boolean);

  // 1) native-host wrapper (absolute node + bridge path)
  const wrap = path.join(ROOT, 'host', 'native-host');
  fs.writeFileSync(wrap, `#!/bin/sh\nexec "${node}" "${path.join(ROOT, 'host', 'bridge.mjs')}" --native-host\n`);
  fs.chmodSync(wrap, 0o755);

  // 2) native-messaging manifest per browser (detection guarantees NativeMessagingHosts exists)
  const manifest = { name: NH_NAME, description: 'Claude Browser Bridge native host', path: wrap, type: 'stdio', allowed_origins: [`chrome-extension://${extId}/`] };
  const wroteBrowsers = [];
  for (const b of browsers) {
    fs.writeFileSync(path.join(HOME, b, 'NativeMessagingHosts', NH_NAME + '.json'), JSON.stringify(manifest, null, 2) + '\n');
    wroteBrowsers.push(b);
  }

  // 3) MCP registration, replacing any entry under a legacy name in the same file
  const mcpEntry = { type: 'stdio', command: node, args: [path.join(ROOT, 'host', 'bridge.mjs')], env: {} };
  const mcpTarget = scope === 'global' ? '~/.claude.json (user)' : mcpFile;
  const j = readJSON(mcpFile); j.mcpServers = j.mcpServers || {};
  const replaced = LEGACY_MCP_NAMES.filter(n => ownsEntry(j.mcpServers[n]));
  for (const n of replaced) delete j.mcpServers[n];
  j.mcpServers[MCP_NAME] = mcpEntry;
  writeJSONAtomic(mcpFile, j);
  if (replaced.length) log('replaced legacy MCP entry:', replaced.join(', '), '->', MCP_NAME);
  // A scope change leaves the previous scope's entry behind; remove it so there is one bridge.
  if (prev) {
    const prevFile = prev.scope === 'global' ? CLAUDE_JSON : prev.project && path.join(prev.project, '.mcp.json');
    if (prevFile && prevFile !== mcpFile && removeMcpEntries(prevFile, [MCP_NAME, ...LEGACY_MCP_NAMES])) log('removed the previous', prev.scope, 'MCP entry');
  }
  for (const { file, out } of refPlans) { writeFileAtomic(file, out); log('renamed tool references in', file); }

  // 4) skill
  const skillDest = scope === 'global'
    ? path.join(HOME, '.claude', 'skills', 'browser')
    : path.join(opts.project, '.claude', 'skills', 'browser');
  copyDir(path.join(ROOT, 'skill'), skillDest);
  if (prev?.skillDest && prev.skillDest !== skillDest && path.basename(prev.skillDest) === 'browser') {
    fs.rmSync(prev.skillDest, { recursive: true, force: true });
    log('removed the previous skill copy:', prev.skillDest);
  }

  // 5) disable Claude-in-Chrome (scoped) + record prior state.
  // Reinstall/scope-change safety: read any prior state FIRST. On a same-scope reinstall, keep the
  // original prior value (don't re-capture the `false` we already wrote). On a scope change, reverse
  // the previous scope's disable so it isn't orphaned (uninstall would otherwise never undo it).
  const prevD = (prev && prev.disable) || {};
  const cj = readJSON(CLAUDE_JSON);
  // Moving a project install to another project is a scope change for the old project too.
  const movedProject = prev && prev.scope === 'project' && scope === 'project' && prev.project !== opts.project;
  if (prev && (prev.scope !== scope || movedProject)) {
    if (prev.scope === 'global') {
      if (prevD.globalPrev === undefined) delete cj.claudeInChromeDefaultEnabled;
      else cj.claudeInChromeDefaultEnabled = prevD.globalPrev;
    } else if (prevD.projectPath && !prevD.projectAlreadyDisabled && cj.projects?.[prevD.projectPath]?.disabledMcpServers) {
      cj.projects[prevD.projectPath].disabledMcpServers = cj.projects[prevD.projectPath].disabledMcpServers.filter(x => x !== CIC);
    }
  }
  const sameScope = prev && prev.scope === scope;
  const disable = {};
  if (scope === 'global') {
    // preserve the ORIGINAL prior on same-scope reinstall; else capture the current (pre-disable) value
    disable.globalPrev = (sameScope && 'globalPrev' in prevD) ? prevD.globalPrev : cj.claudeInChromeDefaultEnabled;
    cj.claudeInChromeDefaultEnabled = false;
  } else {
    cj.projects = cj.projects || {}; cj.projects[opts.project] = cj.projects[opts.project] || {};
    const list = cj.projects[opts.project].disabledMcpServers = cj.projects[opts.project].disabledMcpServers || [];
    disable.projectAlreadyDisabled = (sameScope && prev.project === opts.project && 'projectAlreadyDisabled' in prevD) ? prevD.projectAlreadyDisabled : list.includes(CIC);
    disable.projectPath = opts.project;
    if (!list.includes(CIC)) list.push(CIC);
  }
  for (const p of new Set([opts.project, prev?.project].filter(Boolean))) renameApprovals(cj.projects?.[p]);
  writeJSONAtomic(CLAUDE_JSON, cj);

  // 6) state for uninstall
  const state = { version: readJSON(path.join(ROOT, 'extension', 'manifest.json')).version, mcpName: MCP_NAME, scope, project: opts.project, extId, bridgePath: ROOT, browsers: wroteBrowsers, skillDest, mcpTarget, disable };
  writeJSONAtomic(STATE, state);

  // 7) the desktop app's Claude in Chrome. App-wide, so only a global install turns it off; a
  // project install (or a switch to one) puts back what we changed.
  const desktop = syncDesktop();

  log('installed:');
  log('  extension id :', extId);
  log('  native host  :', wroteBrowsers.join(', '));
  log('  mcp          :', mcpTarget);
  log('  skill        :', skillDest);
  log('  claude-in-chrome disabled for', scope === 'global' ? 'ALL projects (global)' : opts.project);
  logDesktop(desktop);
  log('\nNext: load unpacked ->', path.join(ROOT, 'extension'), '; enable it; then: node setup.mjs verify');
  return { state, desktop };
}

// ---- uninstall ----
function uninstall() {
  const state = readJSON(STATE, null);
  if (!state) { log('no install state found; nothing to uninstall'); return; }
  // native host manifests — state stores home-relative dirs; pre-0.10.2 states stored keys
  for (const b of state.browsers || []) {
    const f = path.join(HOME, LEGACY_STATE_DIRS[b] || b, 'NativeMessagingHosts', NH_NAME + '.json');
    try { fs.unlinkSync(f); } catch {}
  }
  // MCP entry, under whichever name this or an older install used
  const mcpFile = state.scope === 'global' ? CLAUDE_JSON : path.join(state.project, '.mcp.json');
  removeMcpEntries(mcpFile, state.mcpName ? [state.mcpName] : LEGACY_MCP_NAMES);
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
  // drop the stale pristine backup so the next install re-captures a fresh one
  try { fs.unlinkSync(CLAUDE_JSON + '.bak'); } catch {}
  log('uninstalled. Remove the unpacked extension manually from your browser (we cannot).');
  log('claude-in-chrome:', state.scope === 'global'
    ? (d.globalPrev === false ? 'left disabled (you had it off)' : 're-enabled')
    : (d.projectAlreadyDisabled ? 'left disabled (you had it off)' : 're-enabled for the project'));
  const desktop = syncDesktop();
  logDesktop(desktop);
  return { desktop };
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
  if (state) log('mcp name     :', state.mcpName || `${LEGACY_MCP_NAMES[0]} (legacy; reinstall to rename to ${MCP_NAME})`);
  if (hasDesktopApp()) log('desktop chrome:', readJSON(DESKTOP_CONFIG).preferences?.[DESKTOP_PREF] === false ? 'off' : 'on');
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
  // install/uninstall/desktop exit DESKTOP_PENDING_EXIT when only the desktop step is left, waiting
  // for the app to be closed; `desktop` finishes it.
  const pending = (r) => { if (r?.desktop?.status === 'pending') process.exitCode = DESKTOP_PENDING_EXIT; };
  if (cmd === 'install') pending(install(opts));
  else if (cmd === 'uninstall') pending(uninstall());
  else if (cmd === 'desktop') { const desktop = syncDesktop(); logDesktop(desktop); if (desktop.status === 'none') log('claude desktop: nothing to do'); pending({ desktop }); }
  else if (cmd === 'status') status();
  else if (cmd === 'verify') verify().then(r => { log('verify:', JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
  else { console.error('usage: setup.mjs install|uninstall|desktop|status|verify [--scope global|project] [--project <path>]'); process.exit(2); }
} catch (e) { log('ERROR:', e.message); process.exit(1); }
