// Integration test: full host stack (runScript -> Page -> Locator -> mock CDP -> jsdom).
import { JSDOM } from 'jsdom';
import { runScript, _ENGINE } from '../browserapi.mjs';

const html = `<!doctype html><html><body>
  <h2>Welcome back</h2>
  <form>
    <label for="email">Email</label><input id="email" name="email" type="email">
    <input id="file" type="file">
    <button type="submit" data-testid="submit">Save changes</button>
    <button type="button" aria-hidden="true">Save changes</button>
    <select id="sel"><option value="1">One</option><option value="2">Two</option></select>
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
const keys = [];
const records = {};
async function callHost(method, params) {
  if (method === 'executeCdp') {
    const m = params.cdpMethod, p = params.cdpParams || {};
    if (m === 'Runtime.evaluate') { if (p.returnByValue === false) { await win.__evalExpr(p.expression); return { result: { objectId: 'obj-el-1' } }; } const v = await win.__evalExpr(p.expression); return { result: { value: v } }; }
    if (m === 'Input.dispatchMouseEvent') { mouse.push({ type: p.type, x: p.x, y: p.y, button: p.button, clickCount: p.clickCount, buttons: p.buttons }); return {}; }
    if (m === 'Input.insertText') { records.insert = { text: p.text, sessionId: params.sessionId ?? null }; return {}; }
    if (m === 'Input.dispatchKeyEvent') { if (p.type === 'keyDown') keys.push({ key: p.key, text: p.text, modifiers: p.modifiers }); return {}; }
    if (m === 'Page.navigate') return String(p.url || '').includes('blocked.invalid') ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : {};
    if (m === 'DOM.setFileInputFiles') { records.setFiles = { objectId: p.objectId, files: p.files }; return {}; }
    if (m === 'Page.printToPDF') return { data: Buffer.from('%PDF-1.4 hello').toString('base64') };
    if (m === 'Emulation.setDeviceMetricsOverride') { records.viewport = p; return {}; }
    if (m === 'Emulation.clearDeviceMetricsOverride') { records.viewportReset = true; return {}; }
    if (m === 'Page.captureScreenshot') return { data: 'BASE64PNG' };
    if (m === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 600 } };
    if (m === 'Page.reload') return {};
    return {};
  }
  if (method === 'listFrames') return { frames: [] };
  if (method === 'frameOffsetOf') return { ox: 0, oy: 0 };
  if (method === 'getUserTabs') return { tabs: [] };
  if (method === 'readConsole') return { messages: ['log: hi', 'error: boom'] };
  if (method === 'waitDownload') return { ok: true, path: '/tmp/dl.txt', url: 'https://x/dl.txt', bytes: 12 };
  if (method === 'getDialog') return { dialog: { type: 'confirm', message: 'Sure?', defaultPrompt: '' } };
  if (method === 'handleDialog') { records.dialogHandled = params; return { ok: true }; }
  if (method === 'getHistory') return { entries: [{ url: 'https://a', title: 'A', lastVisit: 1, visitCount: 2 }] };
  if (method === 'createTab') return { id: 2 };
  if (method === 'closeAgentTab') { records.closed = params.tabId; return { ok: true }; }
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

// ── v0.9.0 additive capabilities ──
await check('setInputFiles returns paths', `return await page.setInputFiles('#file', ['/a.txt','/b.txt']);`, ['/a.txt','/b.txt']);
{ const ok = records.setFiles && records.setFiles.objectId==='obj-el-1' && JSON.stringify(records.setFiles.files)===JSON.stringify(['/a.txt','/b.txt']); console.log((ok?'  ok  ':'  FAIL')+' setInputFiles → DOM.setFileInputFiles by objectId'); ok?pass++:fail++; }
await check('mouse.click at coords', `await page.mouse.click(123,45); return 'ok';`, 'ok');
{ const ok = mouse.some(m=>m.type==='mousePressed'&&m.x===123&&m.y===45); console.log((ok?'  ok  ':'  FAIL')+' mouse.click dispatched at (123,45)'); ok?pass++:fail++; }
await check('drag press/release endpoints', `await page.drag({x:5,y:6},{x:90,y:80}); return 'ok';`, 'ok');
{ const ok = mouse.some(m=>m.type==='mousePressed'&&m.x===5&&m.y===6) && mouse.some(m=>m.type==='mouseReleased'&&m.x===90&&m.y===80) && mouse.some(m=>m.type==='mouseMoved'&&m.buttons===1); console.log((ok?'  ok  ':'  FAIL')+' drag: press@from, held moves, release@to'); ok?pass++:fail++; }
await check('consoleLogs', `return await page.consoleLogs();`, ['log: hi','error: boom']);
await check('waitForDownload', `return await page.waitForDownload();`, {path:'/tmp/dl.txt',url:'https://x/dl.txt',bytes:12});
await check('getJsDialog type', `const d = await page.getJsDialog(); await d.accept(); return d.type;`, 'confirm');
{ const ok = records.dialogHandled && records.dialogHandled.accept===true; console.log((ok?'  ok  ':'  FAIL')+' dialog.accept() → handleDialog(accept:true)'); ok?pass++:fail++; }
await check('browser.history', `return await browser.history({query:'a'});`, [{url:'https://a',title:'A',lastVisit:1,visitCount:2}]);
await check('setViewport records metrics', `await page.setViewport({width:390,height:844,mobile:true}); return 'ok';`, 'ok');
{ const ok = records.viewport && records.viewport.width===390 && records.viewport.mobile===true; console.log((ok?'  ok  ':'  FAIL')+' setViewport → Emulation.setDeviceMetricsOverride'); ok?pass++:fail++; }
await check('pdf writes file (bytes>0)', `const r = await page.pdf(); return r.bytes>0;`, true);
await check('readUrls batch shape', `const r = await browser.readUrls(['https://example.test/page']); return r.length===1 && r[0].url==='https://example.test/page';`, true);
{ const ok = records.closed===2; console.log((ok?'  ok  ':'  FAIL')+' readUrls closes the background tab'); ok?pass++:fail++; }
await check('elementFromPoint plumbing (jsdom→null)', `return await page.elementFromPoint({x:5,y:5});`, null);

// ── code-review fixes ──
await check('#2 regex locator matches (reWrap)', `return await page.getByRole('button',{name:/save changes/i}).getAttribute('data-testid');`, 'submit');
await check('#14 aria-hidden dup not counted', `return await page.getByRole('button',{name:'Save changes'}).count();`, 1);
await check('#3 global positional .last()', `return (await page.getByRole('listitem').last().textContent()).trim();`, 'gamma');
await check('#3 global positional .first()', `return (await page.getByRole('listitem').first().textContent()).trim();`, 'alpha');
await check('#3 global positional .nth(1)', `return (await page.getByRole('listitem').nth(1).textContent()).trim();`, 'beta');
await check('#3 .last() no crash on single match', `return (await page.getByRole('heading').last().textContent()).trim();`, 'Welcome back');
await check('#9 selectOption numeric value', `return await page.locator('#sel').selectOption({value:2});`, ['2']);
await check('#6 type runs', `await page.getByLabel('Email').type('hi'); return 'ok';`, 'ok');
{ const ok = records.insert && records.insert.text === 'hi' && records.insert.sessionId === null; console.log((ok?'  ok  ':'  FAIL')+' #6 Input.insertText dispatched at top-level (no sessionId)'); ok?pass++:fail++; }
await check('#12 press Shift+a returns', `await page.getByLabel('Email').press('Shift+a'); return 'ok';`, 'ok');
{ const kd = keys[keys.length-1]; const ok = kd && kd.text === 'A' && kd.key === 'A'; console.log((ok?'  ok  ':'  FAIL')+' #12 press Shift+a → uppercase A (text/key)'); ok?pass++:fail++; }
await check('#4 goto throws on nav failure', `try{ await page.goto('https://blocked.invalid'); return 'no-throw'; }catch(e){ return /goto failed/.test(e.message)?'threw':e.message; }`, 'threw');
await check('#5 expectNavigation throws on timeout', `try{ await page.expectNavigation(()=>{}, {url:/nope/, timeoutMs:250}); return 'no-throw'; }catch(e){ return /no matching navigation/.test(e.message)?'threw':e.message; }`, 'threw');
await check('#10 dom_cua.double_click guards missing node', `try{ await page.dom_cua.double_click({node_id:'99999'}); return 'no-throw'; }catch(e){ return /double_click/.test(e.message)?'threw':e.message; }`, 'threw');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
