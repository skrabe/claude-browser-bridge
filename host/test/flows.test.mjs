// The pure half of the flow engine: URL normalization, variable templating, and fingerprints.
// The replay loop itself is exercised live against the browser (it needs real pages).
import { normalizeUrl, templatize, substitute, fingerprintOf, compileUserRecording } from '../flows.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)); ok ? pass++ : fail++; };

eq('strips utm/gclid/fbclid and the hash, keeps real params',
  normalizeUrl('https://shop.example/cart?item=42&utm_source=x&gclid=abc&fbclid=1#top'), 'https://shop.example/cart?item=42');
eq('leaves a plain url alone', normalizeUrl('https://a.b/c?d=1'), 'https://a.b/c?d=1');
eq('non-url passes through', normalizeUrl('not a url'), 'not a url');

eq('templatize replaces the value with %name%, deep, in every occurrence',
  templatize({ value: 'ada@x.com', note: 'mail ada@x.com twice ada@x.com', nested: ['ada@x.com', 7] }, { email: 'ada@x.com' }),
  { value: '%email%', note: 'mail %email% twice %email%', nested: ['%email%', 7] });
eq('templatize ignores one-char values (would match everything)', templatize({ v: 'a-b-a' }, { x: 'a' }), { v: 'a-b-a' });

{
  const missing = new Set();
  eq('substitute fills placeholders', substitute({ value: '%email%', url: 'https://x/%id%' }, { email: 'bo@x.com', id: '9' }, missing), { value: 'bo@x.com', url: 'https://x/9' });
  eq('…and reports none missing', [...missing], []);
}
{
  const missing = new Set();
  substitute({ value: '%email%', other: '%zip%' }, { email: 'bo@x.com' }, missing);
  eq('substitute reports what was not supplied', [...missing], ['zip']);
}

const page = (els) => ({ elements: els });
const A = page([{ role: 'button', name: 'Save' }, { role: 'textbox', name: 'Email' }]);
eq('fingerprint is order-independent', fingerprintOf(page([{ role: 'textbox', name: 'Email' }, { role: 'button', name: 'Save' }])).hash, fingerprintOf(A).hash);
eq('fingerprint changes when a control changes', fingerprintOf(page([{ role: 'button', name: 'Submit' }, { role: 'textbox', name: 'Email' }])).hash !== fingerprintOf(A).hash, true);
eq('fingerprint ignores values and refs (only role+name)', fingerprintOf(page([{ ref: 'e9', role: 'button', name: 'Save', value: 'x' }, { ref: 'e1', role: 'textbox', name: 'Email', value: 'typed' }])).hash, fingerprintOf(A).hash);
eq('fingerprint carries the control count', fingerprintOf(A).n, 2);

{
  const c = compileUserRecording({ startUrl: 'https://app.test/login', events: [
    { type: 'document', url: 'https://app.test/login' },
    { type: 'fill', target: { selector: '#email' }, label: 'Email', value: 'ada@x.com' },
    { type: 'fill-secret', target: { selector: '#pw' }, label: 'Password', field: 'password' },
    { type: 'click', target: { role: 'button', name: 'Sign in' }, label: 'Sign in', role: 'button' },
    { type: 'submit' },
    { type: 'document', url: 'https://app.test/home' },
    { type: 'select', target: { fragile: true, hint: 'select "Plan"' }, label: 'Plan', value: 'pro' },
  ] });
  eq('script: goto first', c.script.split('\n')[0], 'await page.goto("https://app.test/login");');
  eq('script: fill by selector', c.script.includes('page.locator("#email").fill("ada@x.com")'), true);
  eq('script: password becomes a secret placeholder, value absent', c.script.includes('fill({ secret: "password" })') && !/hunter|pw=/.test(c.script), true);
  eq('script: click by role+name', c.script.includes('page.getByRole("button", { name: "Sign in" }).click()'), true);
  eq('script: navigation after an action becomes a load wait', c.script.includes('waitForLoadState(); // navigated to https://app.test/home'), true);
  eq('script: fragile target is marked', c.script.includes('FRAGILE'), true);
  eq('secrets reported', c.secrets, ['password']);
  eq('fragile steps reported', c.fragile, [5]);
  eq('flow steps carry intent from the label', c.steps[3].target.intent, 'Sign in');
  eq('flow step for the secret stores the name only', c.steps[2].args, { secret: 'password' });
}
{
  let threw = null; try { compileUserRecording({ events: [{ type: 'document', url: 'https://x/' }] }); } catch (e) { threw = e.message; }
  eq('a recording with no actions is rejected', /nothing actionable/.test(threw || ''), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
