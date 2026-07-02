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

**Accessibility tree (what `read_page` is built on)**
```
cdp Accessibility.enable {}
cdp Accessibility.getFullAXTree {}          // or getPartialAXTree for a subtree
```

**Precise input** (usually use `click`/`type_text`/`press_key` instead)
```
cdp Input.dispatchMouseEvent { type:"mousePressed"|"mouseReleased", x, y, button:"left", clickCount:1 }
cdp Input.insertText { text }
cdp Input.dispatchKeyEvent { type:"keyDown"|"keyUp", key, code, windowsVirtualKeyCode }
```

**Navigation & lifecycle**
```
cdp Page.enable {}
cdp Page.navigate { url }
cdp Page.getFrameTree {}
```
For a screenshot use the **`screenshot` tool**, not raw `cdp Page.captureScreenshot` — the tool
returns a viewable image, whereas raw `cdp` results come back as text, so `captureScreenshot` would
hand you a multi-megabyte base64 string you can't see and shouldn't spend tokens on.

**Network & console** (prefer `read_network` / `read_console`; raw domains if you need more)
```
cdp Network.enable {}      // then events stream; query captured requests
cdp Runtime.enable {}      // console API + exceptions
```

**DOM node ops**
```
cdp DOM.getDocument { depth:-1 }            // full DOM (large — scope instead when possible)
cdp DOM.querySelector { nodeId, selector }
```

## Notes
- Events (`Network.*`, `Runtime.consoleAPICalled`, `Page.*`) stream back through the bridge; the
  `read_console`/`read_network` tools buffer and expose them — use those unless you need a domain
  they don't cover.
- CDP is per-tab and scoped to the tab's current origin/session. Enable a domain before using it.
