// Recorded flows: compile a sequence of successful actions into something that replays without the
// model in the loop.
//
// The shape follows what Stagehand documents for its action cache, translated to a coding-agent
// tool. A flow is recorded, not declared: while recording, every state-changing tool call is
// captured together with a fingerprint of the page taken just before it — the only moment that
// fingerprint can be taken. Reads are not recorded, so on replay the observe steps simply vanish.
//
// Invalidation is the hard part. A fingerprint is the set of interactive roles and names on the
// page (optionally scoped to a container), so prose and counters do not churn it. On replay a
// mismatched fingerprint does not by itself stop the flow — sites drift — but a target that no
// longer resolves to exactly one element does, with the failing step and evidence returned so the
// model can heal that one step rather than start over.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const FLOW_DIR = process.env.CBB_FLOW_DIR || path.join(os.homedir(), '.claude-browser-bridge', 'flows');

// Tools whose calls are worth replaying. Reads are deliberately absent.
const RECORDABLE = new Set(['click', 'fill', 'type_text', 'press_key', 'select_option', 'select_text', 'scroll', 'hover',
  'drag', 'upload_file', 'navigate', 'reload', 'go_back', 'go_forward', 'wait_for', 'dialog_handle', 'validate']);
const TARGETED = new Set(['click', 'fill', 'select_option', 'select_text', 'scroll', 'hover', 'upload_file', 'validate']);

// Query parameters that identify a visit, not a page. Stagehand filters these too, and notes it
// does not catch everything — neither will this.
const TRACKER_PARAM = /^(utm_\w+|gclid|fbclid|msclkid|dclid|ref|ref_src|mc_[ce]id|_ga|_gl|yclid|igshid|si|s|t)$/i;
export function normalizeUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (TRACKER_PARAM.test(k)) url.searchParams.delete(k);
    url.hash = '';
    return url.toString();
  } catch { return String(u || ''); }
}

const safeName = (n) => String(n || '').trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80);
const flowPath = (name) => path.join(FLOW_DIR, safeName(name) + '.json');

export async function listFlows() {
  await fsp.mkdir(FLOW_DIR, { recursive: true });
  const out = [];
  for (const f of await fsp.readdir(FLOW_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(await fsp.readFile(path.join(FLOW_DIR, f), 'utf8'));
      out.push({ name: j.name, description: j.description, origin: j.origin, steps: (j.steps || []).length, variables: j.variables || [], recordedAt: j.recordedAt, runs: j.runs || 0, lastStatus: j.lastStatus });
    } catch {}
  }
  return out;
}
export async function loadFlow(name) {
  try { return JSON.parse(await fsp.readFile(flowPath(name), 'utf8')); }
  catch { throw new Error(`no flow named "${name}" — flows({action:"list"}) shows what exists`); }
}
export async function saveFlow(flow) {
  await fsp.mkdir(FLOW_DIR, { recursive: true });
  await fsp.writeFile(flowPath(flow.name), JSON.stringify(flow, null, 2));
  return flowPath(flow.name);
}
export async function deleteFlow(name) {
  try { await fsp.unlink(flowPath(name)); return true; } catch { return false; }
}

// Structure only: interactive roles + names, sorted, hashed. Names of controls are what a site
// keeps stable; body text and counters are what it does not.
export function fingerprintOf(pageResult) {
  const els = (pageResult && pageResult.elements) || [];
  const sig = els.map((e) => `${e.role}|${e.name || ''}`).sort().join('\n');
  return { hash: crypto.createHash('sha1').update(sig).digest('hex').slice(0, 16), n: els.length };
}

// Replace every occurrence of a variable's value in the recorded args with %name%, deep.
export function templatize(value, variables) {
  if (typeof value === 'string') {
    let v = value;
    for (const [name, val] of Object.entries(variables || {})) {
      if (val && typeof val === 'string' && val.length >= 2 && v.includes(val)) v = v.split(val).join(`%${name}%`);
    }
    return v;
  }
  if (Array.isArray(value)) return value.map((x) => templatize(x, variables));
  if (value && typeof value === 'object') { const o = {}; for (const [k, x] of Object.entries(value)) o[k] = templatize(x, variables); return o; }
  return value;
}
export function substitute(value, variables, missing) {
  if (typeof value === 'string') {
    return value.replace(/%([\w-]+)%/g, (m, name) => {
      if (variables && name in variables) return String(variables[name]);
      missing.add(name); return m;
    });
  }
  if (Array.isArray(value)) return value.map((x) => substitute(x, variables, missing));
  if (value && typeof value === 'object') { const o = {}; for (const [k, x] of Object.entries(value)) o[k] = substitute(x, variables, missing); return o; }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Recorder. One active recording per MCP process; the dispatcher calls observe() around tool calls.
export function makeRecorder({ MAP }) {
  let rec = null; // { name, description, tabId, steps: [], startedAt }

  // Scoping comes for free: read_page applies the tab's sticky `ignore` list, so setting
  // ignore:["nav", ".ads"] once scopes both the live tree and every fingerprint taken from it —
  // Stagehand's "scope by selector so changes outside the container don't bust the key".
  const fingerprint = async (tabId) => {
    try {
      const page = await MAP.read_page({ tabId, full: true, mode: 'interact' });
      return { ...fingerprintOf(page), url: normalizeUrl(page.url) };
    } catch { return null; }
  };

  // Turn a ref the model used into something that survives the session.
  const durableTarget = async (tabId, args) => {
    if (args.selector && !args.ref) return { selector: args.selector };
    if (!args.ref) return null;
    try {
      const g = await MAP.generate_locator({ tabId, ref: args.ref });
      if (g.best && /^page\.locator\(/.test(g.best)) return { selector: JSON.parse(g.best.slice('page.locator('.length, -1)) };
      if (g.semantic && g.semantic.count === 1) {
        const m = g.semantic.locator.match(/getByRole\("([^"]+)", \{ name: (".*") \}\)/);
        if (m) return { role: m[1], name: JSON.parse(m[2]) };
      }
      const el = g.element || {};
      return { fragile: true, hint: `${el.tag || 'element'} "${(el.text || el.ariaLabel || '').slice(0, 60)}"`, ...(g.semantic ? { role: g.semantic.locator.match(/getByRole\("([^"]+)"/)?.[1], name: g.semantic.locator.match(/name: (".*") \}/)?.[1] && JSON.parse(g.semantic.locator.match(/name: (".*") \}/)[1]) } : {}) };
    } catch { return { fragile: true }; }
  };

  return {
    active: () => !!rec,
    start({ name, description, tabId }) {
      if (!name) throw new Error('flow_record start needs a name');
      if (rec) throw new Error(`already recording "${rec.name}" — stop or cancel it first`);
      rec = { name: safeName(name), description: description || '', tabId: tabId ?? null, steps: [], startedAt: new Date().toISOString() };
      return { recording: rec.name, note: 'Every state-changing tool call is now captured with a page fingerprint. Work normally; reads are not recorded. Stop with flow_record {action:"stop", variables:{name:"value"}} to turn literal values into %name% placeholders.' };
    },
    cancel() { const n = rec?.name; rec = null; return { cancelled: n || null }; },
    async stop({ variables, description }) {
      if (!rec) throw new Error('not recording');
      const done = rec; rec = null;
      const varNames = Object.keys(variables || {});
      const steps = done.steps.map((s) => ({ ...s, args: templatize(s.args, variables) }));
      const flow = {
        name: done.name, description: description || done.description, origin: steps.find((s) => s.before?.url)?.before?.url ? new URL(steps.find((s) => s.before?.url).before.url).origin : null,
        variables: varNames, steps, recordedAt: done.startedAt, runs: 0,
      };
      if (!steps.length) throw new Error('nothing was recorded — no state-changing tool ran while recording');
      const file = await saveFlow(flow);
      const fragile = steps.map((s, i) => (s.target?.fragile ? i : -1)).filter((i) => i >= 0);
      return { saved: flow.name, file, steps: steps.length, variables: varNames, ...(fragile.length ? { fragileSteps: fragile, warning: 'these steps had no unique durable locator; replay resolves them by role+name and may need healing' } : {}) };
    },
    // Called by the dispatcher before/after a tool call. `before` runs pre-call so the fingerprint
    // describes the page the action was taken on; `after` records only on success.
    async before(tool, args) {
      if (!rec || !RECORDABLE.has(tool)) return null;
      const tabId = args.tabId ?? rec.tabId;
      const target = TARGETED.has(tool) ? await durableTarget(tabId, args) : null;
      return { tabId, target, fp: await fingerprint(tabId) };
    },
    after(tool, args, pre, result) {
      if (!rec || !pre) return;
      // validate does not throw on a failed assertion — it reports it. Recording that would replay
      // a check that is known to fail, so a red validate is dropped just like a thrown action.
      if (tool === 'validate' && result && result.ok === false) return;
      const { tabId, target, fp } = pre;
      const { ref, selector, ...rest } = args; // the session ref is replaced by the durable target
      rec.steps.push({ tool, args: { ...rest, tabId: undefined }, ...(target ? { target } : {}), before: fp, ...(result && result.status && result.status.url ? { afterUrl: normalizeUrl(result.status.url) } : {}) });
    },
    steps: () => rec ? rec.steps.length : 0,
    name: () => rec?.name || null,
  };
}

// ---------------------------------------------------------------------------------------------
// Replay.
export async function runFlow({ MAP, name, tabId, variables, stopOnDrift }) {
  const flow = await loadFlow(name);
  if (tabId == null) throw new Error('flow_run needs the tabId to replay in');
  const missing = new Set();
  const report = { flow: flow.name, cacheStatus: 'HIT', steps: [], drift: 0 };
  const startedAt = Date.now();

  const resolveTarget = async (target) => {
    if (!target) return {};
    if (target.selector) return { selector: target.selector };
    if (target.role && target.name) {
      const page = await MAP.read_page({ tabId, full: true, mode: 'interact' });
      const hits = (page.elements || []).filter((e) => String(e.role).toLowerCase() === String(target.role).toLowerCase() && e.name === target.name);
      if (hits.length === 1) return { ref: hits[0].ref };
      throw new Error(`target ${target.role} "${target.name}" matched ${hits.length} elements`);
    }
    throw new Error('step has no usable target' + (target.hint ? ` (recorded as ${target.hint})` : ''));
  };

  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    const entry = { i, tool: step.tool };
    try {
      // Fingerprint the page as it is now against the page the step was recorded on.
      if (step.before && step.before.hash) {
        const page = await MAP.read_page({ tabId, full: true, mode: 'interact' });
        const now = fingerprintOf(page);
        const urlNow = normalizeUrl(page.url);
        if (now.hash !== step.before.hash) {
          entry.drift = { recorded: step.before.n + ' controls', now: now.n + ' controls', urlThen: step.before.url, urlNow };
          report.drift++;
          if (stopOnDrift) throw new Error('page fingerprint differs from the recording and stopOnDrift is set');
        }
        if (step.before.url && new URL(step.before.url).origin !== new URL(urlNow).origin) throw new Error(`different site: recorded on ${new URL(step.before.url).origin}, now on ${new URL(urlNow).origin}`);
      }
      const args = substitute(step.args || {}, variables, missing);
      if (missing.size) throw new Error(`missing variable(s): ${[...missing].join(', ')} — pass them in variables:{}`);
      const target = await resolveTarget(step.target);
      const fn = MAP[step.tool];
      if (!fn) throw new Error(`tool ${step.tool} is not available`);
      const result = await fn({ ...args, ...target, tabId });
      if (step.tool === 'validate' && result && result.ok === false) throw new Error('validate failed: ' + JSON.stringify(result.failed));
      if (result && result.mismatch) entry.note = result.mismatch;
      entry.ok = true;
      report.steps.push(entry);
    } catch (e) {
      entry.ok = false; entry.error = e.message;
      report.steps.push(entry);
      report.cacheStatus = entry.drift ? 'STALE' : 'FAILED';
      report.failedStep = i;
      report.heal = `Step ${i} (${step.tool}) failed. Take a read_page, do that one step by hand, then re-record from here or edit the flow file: ${flowPath(flow.name)}`;
      break;
    }
  }
  if (report.cacheStatus === 'HIT' && report.drift) report.cacheStatus = 'HIT-DRIFTED';
  report.ms = Date.now() - startedAt;
  report.completed = report.steps.filter((s) => s.ok).length + '/' + flow.steps.length;
  flow.runs = (flow.runs || 0) + 1; flow.lastStatus = report.cacheStatus; flow.lastRunAt = new Date().toISOString();
  await saveFlow(flow).catch(() => {});
  return report;
}
