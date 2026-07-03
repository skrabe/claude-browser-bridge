import { JSDOM } from 'jsdom';
import { _ENGINE } from '../browserapi.mjs';

const html = `<!doctype html><html><body>
  <h2>Welcome back</h2>
  <nav aria-label="Main"><a href="/x">Home</a><a href="/y">Docs</a></nav>
  <form>
    <label for="email">Email</label><input id="email" name="email" type="email">
    <label>Password <input id="pw" type="password"></label>
    <input type="search" placeholder="Search records">
    <input type="checkbox" id="tos" aria-label="Accept terms">
    <select id="plan"><option value="m">Monthly</option><option value="y">Yearly</option></select>
    <button type="submit" data-testid="submit">Save changes</button>
    <button type="button">Cancel</button>
    <div role="button" aria-label="Custom action">x</div>
  </form>
  <ul><li>alpha</li><li>beta</li><li>gamma</li></ul>
</body></html>`;

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const win = dom.window;
const rect = { x:10, y:10, left:10, top:10, right:110, bottom:30, width:100, height:20, toJSON(){return this;} };
win.Element.prototype.getBoundingClientRect = function(){ return rect; };
win.Element.prototype.getClientRects = function(){ return [rect]; };
const s = win.document.createElement('script'); s.textContent = _ENGINE; win.document.body.appendChild(s);
const cbb = win.__cbb;
if (typeof cbb !== 'function') { console.error('ENGINE did not install window.__cbb'); process.exit(2); }

let pass=0, fail=0;
const eq=(name,got,want)=>{ const ok=JSON.stringify(got)===JSON.stringify(want); console.log((ok?'  ok  ':'  FAIL')+' '+name+(ok?'':`  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)); ok?pass++:fail++; };
const q=(steps)=>cbb('q',{steps}).count;

eq('getByRole button "Save changes"', q([{by:'role',role:'button',name:'Save changes'}]), 1);
eq('getByRole button name substring "save"', q([{by:'role',role:'button',name:'save',exact:false}]), 1);
eq('getByRole textbox (email+password only; search is searchbox)', q([{by:'role',role:'textbox'}]), 2);
eq('getByRole link count', q([{by:'role',role:'link'}]), 2);
eq('getByRole heading', q([{by:'role',role:'heading'}]), 1);
eq('getByRole checkbox', q([{by:'role',role:'checkbox'}]), 1);
eq('getByRole combobox (select)', q([{by:'role',role:'combobox'}]), 1);
eq('getByRole button total (2 native + 1 div[role])', q([{by:'role',role:'button'}]), 3);
eq('getByLabel Email', q([{by:'label',text:'Email'}]), 1);
eq('getByLabel Password (wrapping label)', q([{by:'label',text:'Password',exact:false}]), 1);
eq('getByPlaceholder Search', q([{by:'placeholder',text:'Search',exact:false}]), 1);
eq('getByTestId submit', q([{by:'testid',testId:'submit'}]), 1);
eq('getByText Welcome (deepest only)', q([{by:'text',text:'Welcome',exact:false}]), 1);
eq('aria-label role=button "Custom action"', q([{by:'role',role:'button',name:'Custom action'}]), 1);
eq('css input[name=email]', q([{by:'css',selector:'input[name=email]'}]), 1);
eq('getByRole listitem', q([{by:'role',role:'listitem'}]), 3);
eq('listitem nth(1)', cbb('q',{steps:[{by:'role',role:'listitem'},{op:'nth',n:1}]}).count, 1);
eq('listitem first', cbb('q',{steps:[{by:'role',role:'listitem'},{op:'first'}]}).count, 1);
eq('listitem filter hasText beta', cbb('q',{steps:[{by:'role',role:'listitem'},{op:'filter',hasText:'beta'}]}).count, 1);
let fired=[]; win.document.getElementById('email').addEventListener('input',()=>fired.push('input')); win.document.getElementById('email').addEventListener('change',()=>fired.push('change'));
const fr=cbb('fill',{steps:[{by:'css',selector:'#email'}],i:0,value:'a@b.com'});
eq('fill ok', fr.ok, true);
eq('fill value set', win.document.getElementById('email').value, 'a@b.com');
eq('fill fired input+change', fired, ['input','change']);
const sr=cbb('select',{steps:[{by:'css',selector:'#plan'}],i:0,values:[{label:'Yearly'}]});
eq('selectOption ok', sr.ok, true);
eq('selectOption value', win.document.getElementById('plan').value, 'y');
eq('innerText of heading', cbb('text',{steps:[{by:'role',role:'heading'}],i:0,kind:'inner'}), 'Welcome back');
eq('getAttribute type', cbb('text',{steps:[{by:'css',selector:'#email'}],i:0,kind:'attr',name:'type'}), 'email');
eq('isVisible', cbb('bool',{steps:[{by:'role',role:'button',name:'Cancel'}],i:0,q:'visible'}), true);
const snap=cbb('snapshot',{max:20000});
eq('snapshot has button "Save changes"', /button "Save changes"/.test(snap), true);
eq('snapshot has heading Welcome', /heading "Welcome back"/.test(snap), true);
const vd=cbb('vdom',{});
eq('vdom returns interactables (>=6)', vd.length>=6, true);
eq('vdom entries have node_id+role+box', !!(vd[0].node_id && vd[0].role && vd[0].box), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
