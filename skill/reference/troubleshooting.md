# Troubleshooting

## "browser bridge host not running"
The native host is spawned by the browser when the extension connects. If a tool returns this:
- The browser isn't open, or the extension isn't loaded/enabled, or its service worker is asleep.
- Ask the user to open the browser and confirm the extension is enabled. If it was just enabled,
  a `tabs_list` retry usually wakes it. Don't loop retries silently — surface the cause.

## Debugger detached / "Debugger unattached"
- `chrome.debugger` can be detached by the browser (DevTools opened on that tab, tab crashed, or
  the user clicked "Cancel" on the debugging banner).
- Re-`tab_claim` the tab to re-attach, then retry. If it keeps detaching, the user likely has
  DevTools open on that tab — ask them to close it.

## The debugging banner
- Claimed tabs show a "…is debugging this browser" banner. That's expected and harmless; leave it
  up while working. `tab_release` removes it for that tab.

## Timeouts / target not found
- Usually the element is missing, hidden, offscreen, not yet rendered, or the selector is too
  broad. Don't retry the same target — re-`read_page`, confirm it exists, then refine (see
  `finding-elements.md`).

## Navigation seems stuck
- Confirm the actual URL via `cdp Runtime.evaluate { expression:"location.href", returnByValue:true }`
  before assuming failure — a client-side route change may have already happened without a full
  load.

## Screenshot is blank/stale on a background tab
- CDP screenshots a background tab can be stale. `tab_activate` it briefly, or rely on `read_page`
  for ground truth instead.

## Connection dropped mid-session
- MV3 service workers idle out and the native host exits; the extension auto-reconnects on the
  next event. If tools error transiently, a single retry after re-orienting is fine.

## Ambiguous outcome after an action
- A blank page, a stuck spinner, a closed popup, or a timeout right after a state-changing action
  (especially after asking the user to sign in) means **unknown** — not proof it succeeded, not
  proof it failed. Re-observe (`read_page` or `screenshot`) before deciding either way; don't
  assume success and move on, and don't assume failure and retry a destructive action.
- If a `read_page` right after a nav/action returns very few elements, or elements with no
  accessible names, treat that as **still loading**, not empty/wrong — re-read once after a beat
  before concluding there's no content or switching strategy.

## Target lives in a cross-origin iframe
- `read_page`/`dom_query` see the top document only — a target inside a cross-origin (out-of-
  process) iframe won't appear, and that's a real structural limit, not a bad selector. Fall back
  to a `screenshot` + coordinate `click`, or scope a `cdp` call to that frame's own context.
