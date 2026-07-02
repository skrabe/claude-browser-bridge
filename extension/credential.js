// Secure credential popup. Runs in the extension's own window — the model (attached to the target
// tab only) can't see it. The user's secrets go to the background worker via runtime messaging and
// are filled straight into the page; they never cross to the host/MCP side.
const token = new URLSearchParams(location.search).get('token');
const $ = (id) => document.getElementById(id);
let settled = false;

chrome.runtime.sendMessage({ type: 'cbb-cred-getspec', token }, (spec) => {
  if (!spec || spec.error) { $('err').textContent = spec?.error || 'This request expired.'; $('fill').disabled = true; return; }
  $('origin').textContent = spec.origin || '';
  $('reason').textContent = spec.reason || 'Sign in to continue.';
  const form = $('form');
  for (const f of spec.fields || []) {
    const label = document.createElement('label');
    label.textContent = f.label || f.id;
    const input = document.createElement('input');
    input.type = f.type === 'password' ? 'password' : f.type === 'email' ? 'email' : 'text';
    input.autocomplete = 'off';
    input.dataset.id = f.id;
    form.appendChild(label);
    form.appendChild(input);
  }
  const first = form.querySelector('input');
  if (first) first.focus();
});

function submit() {
  if (settled) return;
  const values = {};
  for (const input of document.querySelectorAll('#form input')) values[input.dataset.id] = input.value;
  $('fill').disabled = true; $('fill').textContent = 'Filling…';
  settled = true;
  // The worker fills the page and closes this window; if the selector was wrong the agent re-issues
  // a fresh request. Either way we're done once we've handed over the values.
  chrome.runtime.sendMessage({ type: 'cbb-cred-submit', token, values }, () => window.close());
}
function cancel() { if (settled) return; settled = true; chrome.runtime.sendMessage({ type: 'cbb-cred-cancel', token }, () => window.close()); window.close(); }

$('fill').addEventListener('click', submit);
$('cancel').addEventListener('click', cancel);
// If the user just closes the window, treat it as declined.
window.addEventListener('unload', () => { if (!settled) chrome.runtime.sendMessage({ type: 'cbb-cred-cancel', token }); });
