// The pure half of the flow engine: URL normalization, variable templating, and fingerprints.
// The replay loop itself is exercised live against the browser (it needs real pages).
import { normalizeUrl, templatize, substitute, fingerprintOf } from '../flows.mjs';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
