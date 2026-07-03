# Raw CDP (`cdp` tool)

`cdp` sends any Chrome DevTools Protocol command to a controlled tab: `{tabId, method, params}`.
It's the escape hatch for anything the high-level tools don't cover. Prefer the high-level tools
when they fit — reach here for structured reads, precise input, or domains not otherwise exposed.

The tab must be controlled (`tab_claim`/`tab_create`) first — the debugger is already attached.

## Common recipes

**Read/evaluate (read-only) DOM & state**
```
cdp Runtime.evaluate { expression: "(() => { /* query + project */ })()", returnByValue: true }
```
Keep it bounded — query the container, return only the fields you need, cap rows. Don't dump the
whole page.

**Exotic input** — `click` covers left/right/middle (`button:`) and double (`double:true`); reach
here only for chorded mouse gestures or pointer types `click` doesn't expose.

**Navigation & lifecycle**
```
cdp Page.enable {}
cdp Page.navigate { url }
cdp Page.getFrameTree {}
```
Prefer the **`navigate` tool** over raw `Page.navigate` — it skips the reload when the tab is
already on that URL (raw CDP doesn't, so it can wipe in-progress input). Reach for `cdp
Page.navigate` only for something `navigate` can't do, e.g. targeting a specific subframe.

**JS dialogs and file uploads have dedicated tools now** — use `dialog_handle` (accept/dismiss an
open alert/confirm/prompt; an open dialog shows up as `openDialog` in the action status header) and
`upload_file` (set files on an `<input type=file>` by ref, absolute paths, no native picker). Reach
for raw `cdp` only for something those don't cover.
For a screenshot use the **`screenshot` tool**, not raw `cdp Page.captureScreenshot` — the tool
returns a viewable image, whereas raw `cdp` results come back as text, so `captureScreenshot` would
hand you a multi-megabyte base64 string you can't see and shouldn't spend tokens on.

**DOM node ops**
```
cdp DOM.getDocument { depth:-1 }            // full DOM (large — scope instead when possible)
cdp DOM.querySelector { nodeId, selector }
```

## Notes
- The bridge does **not** stream CDP events to you. Console/network events are buffered per-tab and
  exposed only via `read_console`/`read_network`; event-driven recipes won't work — poll state.
- `Page`/`DOM`/`Runtime`/`Accessibility`/`Network`/`Log` are pre-enabled on claim; enable any other
  domain before use. CDP is per-tab, scoped to the tab's session.
- Before overriding device metrics / viewport via raw CDP, check whether the `screenshot` tool's
  own options (or `page.setViewport()` in `run`) already cover the need — an override re-renders the
  tab's viewport for emulation; it does **not** resize the user's real browser window.
