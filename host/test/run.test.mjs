// Integration test: full host stack (runScript -> Page -> Locator -> mock CDP -> jsdom).
import { JSDOM } from 'jsdom';
import { runScript, _ENGINE } from '../browserapi.mjs';

const html = `<!doctype html><html><body>
  <h2>Welcome back</h2>
  <form>
    <label for="email">Email</label><input id="email" name="email" type="email">
    <button type="submit" data-testid="submit">Save changes</button>
  </form>
  <ul><li>alpha</li><li>beta</li><li>gamma</li></ul>
</body></html>`;
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/page' });
const win = dom.window;
const rect = { x:10,y:10,left:10,top:10,right:110,bottom:30,width:100,height:20,toJSON(){return this;} };
win.Element.prototype.getBoundingClientRect = function(){ return rect; };
win.Element.prototype.getClientRects = function(){ return [rect]; };
const inj = win.document.createElement('script'); inj.textContent = _ENGINE + '\nwindow.__evalExpr = async (code) => await eval(code);'; win.document.body.appendChild(inj);

const mouse = [];
async function callHost(method, params) {
  if (method === 'executeCdp') {
    const m = params.cdpMethod, p = params.cdpParams || {};
    if (m === 'Runtime.evaluate') { const v = await win.__evalExpr(p.expression); return { result: { value: v } }; }
    if (m === 'Input.dispatchMouseEvent') { mouse.push({ type: p.type, x: p.x, y: p.y, button: p.button, clickCount: p.clickCount }); return {}; }
    if (m === 'Input.insertText' || m === 'Input.dispatchKeyEvent') return {};
    if (m === 'Page.captureScreenshot') return { data: 'BASE64PNG' };
    if (m === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 600 } };
    if (m === 'Page.navigate' || m === 'Page.reload') return {};
    return {};
  }
  if (method === 'listFrames') return { frames: [] };
  if (method === 'frameOffsetOf') return { ox: 0, oy: 0 };
  if (method === 'getUserTabs') return { tabs: [] };
  return { ok: true };
}

let pass=0, fail=0;
const check=async (name, script, want)=>{ let got; try { got = (await runScript({ callHost, tabId: 1, script, timeoutMs: 8000 })).result; } catch (e) { got = 'THREW: '+e.message; } const ok = JSON.stringify(got)===JSON.stringify(want); console.log((ok?'  ok  ':'  FAIL')+' '+name+(ok?'':`  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)); ok?pass++:fail++; };

await check('click button + read heading', `await page.getByRole('button',{name:'Save changes'}).click(); return await page.getByRole('heading').innerText();`, 'Welcome back');
console.log('     (click dispatched at', mouse.find(m=>m.type==='mousePressed'), ')');
await check('fill + inputValue', `await page.getByLabel('Email').fill('x@y.com'); return await page.getByLabel('Email').inputValue();`, 'x@y.com');
await check('count listitems', `return await page.getByRole('listitem').count();`, 3);
await check('loop nth textContent', `const n=await page.getByRole('listitem').count(); const out=[]; for(let i=0;i<n;i++) out.push((await page.getByRole('listitem').nth(i).textContent()).trim()); return out;`, ['alpha','beta','gamma']);
await check('page.url()', `return await page.url();`, 'https://example.test/page');
await check('page.evaluate', `return await page.evaluate(() => document.querySelectorAll('li').length);`, 3);
await check('domSnapshot has button', `const s = await page.domSnapshot(); return /button "Save changes"/.test(s);`, true);
await check('auto-wait for late element', `await page.evaluate(() => { setTimeout(() => { const b=document.createElement('button'); b.setAttribute('type','button'); b.textContent='Later'; document.body.appendChild(b); }, 200); }); await page.getByRole('button',{name:'Later'}).click(); return 'clicked';`, 'clicked');
await check('strict mode violation on 3 matches', `try { await page.getByRole('listitem').click(); return 'no-throw'; } catch(e){ return /strict/.test(e.message)?'strict-caught':e.message; }`, 'strict-caught');

const clicked = mouse.some(m=>m.type==='mousePressed' && m.x===60 && m.y===20);
console.log((clicked?'  ok  ':'  FAIL')+' real click landed at element center (60,20)'); clicked?pass++:fail++;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
