# Better Claude in Chrome

**Let Claude Code drive your real, logged-in browser.** It sees and *claims* the tabs you already
have open — your cookies, your sessions, your logins — and reads, fills, clicks, and navigates them
over the Chrome DevTools Protocol. Owned end to end: no third-party service, no network port, a
compact codebase you can read in one sitting.

> A fuller, self-hosted take on "Claude in Chrome" — it works *with* your existing signed-in
> browser instead of spinning up a fresh sandbox.

---

## Why it's different

- **Programmable, not one-op-at-a-time.** The `run` tool executes a JavaScript automation script in
  one call, driving a Playwright-shaped `page` with semantic, **auto-waiting** locators
  (`getByRole`/`getByText`/`getByLabel`/…) — locate, fill, click, wait, loop, and read a whole flow
  in a single round trip instead of a tool call per action. This is what makes it feel fast.
- **Your real session, not a sandbox.** `tabs_list` shows every tab across every window; `tab_claim`
  takes control of one *in place*. No re-login, no fresh profile.
- **Sees inside cross-origin iframes.** Stripe card fields, "Sign in with Google" frames, embedded
  editors — `read_page` merges out-of-process frames and clicks land inside them (coordinate-translated).
- **Signs you in without ever seeing the secret.** `credential_request` pops a secure window *you*
  type into; the bridge fills the page and returns only a status. The value never reaches the model.
- **Cheap by design.** Every action returns a status header (`{url, title, new console errors}`) so
  the agent usually skips a follow-up read. Screenshots auto-downscale to the model's vision limits.
- **Private.** No TCP port anywhere — a `0600` unix socket + Chrome native messaging, with the
  extension id pinned in the manifest. A small, auditable codebase.

---

## Quickstart

**Easiest — install it from [tweakcc-fixed](https://github.com/skrabe/tweakcc-fixed).** Run
`npx -y tweakcc-fixed`, pick **Better Claude in Chrome**, and it fetches this repo, wires up the MCP
server and the `/browser` skill, walks you through loading the extension once, and verifies the
connection. Reinstall / repair / uninstall live in the same menu. No clone, no manual steps.

Or install directly from a checkout of this repo:

```bash
# 1. install the host + skill (global scope shown; --scope project also supported)
node host/setup.mjs install --scope global

# 2. load the extension once
#    brave://extensions  →  Developer mode  →  Load unpacked  →  extension/   (then enable it)

# 3. confirm the socket is live
node host/setup.mjs verify
```

Then just ask Claude to do something in your browser, or run **`/browser`** for the full playbook.

```bash
node host/setup.mjs status       # what's installed
node host/setup.mjs uninstall    # reverses everything (re-enables Claude-in-Chrome only if we disabled it)
```

Installing globally also **disables the built-in Claude in Chrome** so you have one browser surface:
in the Claude Code CLI, and in the Claude Desktop app when it is installed (restart the app after
installing; it reads its settings only at launch). `--scope project` scopes the CLI side to a single
project and leaves the desktop app alone, since its setting is app-wide. Uninstall restores both —
but only what *we* turned off.

The MCP server is registered as `browser-bridge`, so its tools are `mcp__browser-bridge__*`.
Installs before 0.13 used `claude-browser`, a name Claude Desktop reserves for its own browser
server (it drops a same-named server from every desktop session). Reinstalling renames it and
carries `mcp__claude-browser__*` permission rules over to the new name. Reload the extension after any code change (a browser restart is **not** needed).

**Requirements:** macOS · Node 18+ · any Chromium-family browser on **v125+** (for
cross-origin-iframe support). The installer detects browsers structurally — every Chromium
user-data dir that has actually run (Chrome, Brave, Edge, Chromium, Arc, Aside, Helium, and
any future fork) gets the native-messaging manifest; each fork reads manifests only from its
own dir, so all of them are registered automatically.

---

## Tools

58 MCP tools. **`run` is the fast path** — script a whole flow in one call; the atomic tools below
are for one-off actions; **flows** replay a sequence you (or the user) did once, with no model in
the loop. `cdp` is the escape hatch for anything they don't cover.

| Group | Tools |
|---|---|
| **Programmable** | `run` *(JS script: Playwright-shaped `page`/locators — getByRole/Text/Label, click/fill/press/check/selectOption/setInputFiles/dragTo, evaluate, waitForURL, domSnapshot, pdf, screenshot; `browser` — openTabs/claimTab/newTab/readUrls/history; auto-waiting, pierces frames + shadow DOM)* |
| **Tabs** | `tabs_list` · `tab_claim` · `tab_create` *(group by topic)* · `tab_activate` · `tab_release` · `tab_close` |
| **Navigate** | `navigate` *(waits for load)* · `reload` · `go_back` · `go_forward` · `wait_for` |
| **Read / observe** | `read_page` *(a11y tree + refs that survive across reads; returns only the DELTA after the first read; flags elements buried under an overlay; `mode:"interact"`, sticky `ignore:[css]`, `toFile`)* · `validate` *(prove an action landed: url / text / element visible-checked-value, with evidence)* · `generate_locator` *(ref → durable locator, with match counts)* · `peek_tab` *(read a user tab without claiming it)* · `read_text` · `find_text` · `dom_query` · `find` · `screenshot` *(element / full-page / `marks:true` set-of-mark badges, always reports its image↔CSS mapping)* · `probe_point` *(what's at {x,y} + a clickable ref; `annotate:true` draws a crosshair)* · `read_console` · `read_network` · `network_body` |
| **Act** | `click` *(by ref, CSS `selector`, or `intent` — selector narrows, intent confirms the label and finds the control again if the selector died; right/double; returns a receipt naming what it hit; `space:"image"`/`"page"` coords)* · `fill` *(reads the value back and reports a mask/maxlength rewrite; rejects a wrongly-formatted date)* · `type_text` · `press_key` · `select_option` · `select_text` *(caret/selection at an exact spot in existing text)* · `scroll` · `hover` · `drag` · `act_batch` · `upload_file` |
| **Flows** | `flow_record` *(start/stop: every state-changing call captured with a page fingerprint, refs made durable, `%variables%`)* · `flow_run` *(replay in one call; `HIT` / `HIT-DRIFTED` / `STALE` with the failing step to heal)* · `flows` · `user_record` *(watch the USER do it once → run script + flow; passwords never captured)* |
| **Browser & perf** | `browser_manage` *(windows, tab groups, pinning, bookmarks + an undo audit trail)* · `emulate` *(CPU/network throttling, dark mode, UA, geolocation, headers, device viewport)* · `perf_trace` *(Core Web Vitals rated + named insights + trace .json.gz)* · `cdp_events` *(cursor-paged CDP event buffer)* |
| **Auth & dialogs** | `credential_request` *(secure popup)* · `dialog_handle` |
| **Secrets** | `secret_set` / `secret_list` / `secret_clear` *(fill by name; the literal is auto-redacted from every tool result so a page echo / network body / console line can't leak it)* |
| **Downloads** | `download_wait` · `downloads_list` |
| **Page API & assets** | `webmcp_tools` / `webmcp_call` *(call the page's own published tools instead of driving its UI)* · `page_assets` / `bundle_assets` *(inventory + download what the page rendered)* |
| **Clipboard** | `clipboard_read` · `clipboard_write` |
| **Escape hatch** | `cdp` *(any raw CDP command)* |

Ships with the **`browser` skill** — a single self-contained `skill/SKILL.md` that leads with `run`
(the scripting playbook: page/locator API + patterns) and covers targeting, the interaction loop,
navigation/tabs, safety, troubleshooting, and the CDP escape hatch. Invoke it as `/browser`.

---

## Architecture

```
Claude Code ──MCP (stdio)──▶ host/bridge.mjs  (MCP mode)
                                   │  0600 unix socket · /tmp/claude-browser-bridge-$USER.sock
                                   ▼
                              host/bridge.mjs  (--native-host, launched by the browser)
                                   │  Chrome native messaging · 4-byte LE length + JSON
                                   ▼
                              extension/  (MV3 service worker)
                                   │  chrome.debugger (CDP 1.3) · chrome.tabs · chrome.tabGroups
                                   ▼
                              your real, logged-in tabs  ─ incl. out-of-process iframes
```

One file, two modes: the browser launches `bridge.mjs --native-host` (bridging native messaging to
the socket); Claude Code launches `bridge.mjs` in MCP mode (exposing the tools over the socket). The
extension is a thin, generic CDP proxy — all behavior lives in the host and the skill.

## Security & trust model

- **No network port.** The only IPC is a `0600` unix socket (owner-only) and Chrome native messaging.
- **Pinned extension id.** The native-messaging manifest's `allowed_origins` pins the extension's
  deterministic id (fixed public key), so only *this* extension can talk to the host.
- **Secrets stay out of the model.** `credential_request` collects values in the extension's own
  popup window and fills them via CDP — never logged, never returned, never in the model's context.
  The agent can't `tab_claim` the popup (extension/browser pages are refused and hidden from `tabs_list`).
- **Tab safety.** `tab_close` only closes tabs the agent opened; your own tabs are protected in code.

---

Provenance: a clean-room implementation inspired by the shape of mature browser-agent tooling. All
its own code.
