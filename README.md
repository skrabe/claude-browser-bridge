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

Installing globally also **disables the built-in Claude in Chrome** so you have one browser surface;
`--scope project` scopes that to a single project. Uninstall restores it — but only if *we* turned
it off. Reload the extension after any code change (a browser restart is **not** needed).

**Requirements:** macOS · Node 18+ · a Chromium browser (Brave / Chrome / Edge) on **v125+** (for
cross-origin-iframe support). Brave reads native-messaging manifests from Chrome's directory, so the
installer registers with every detected Chromium browser automatically.

---

## Tools

36 MCP tools. **`run` is the fast path** — script a whole flow in one call; the atomic tools below
are for one-off actions. `cdp` is the escape hatch for anything they don't cover.

| Group | Tools |
|---|---|
| **Programmable** | `run` *(JS script: Playwright-shaped `page`/locators — getByRole/Text/Label, click/fill/press/check/selectOption/setInputFiles/dragTo, evaluate, waitForURL, domSnapshot, pdf, screenshot; `browser` — openTabs/claimTab/newTab/readUrls/history; auto-waiting, pierces frames + shadow DOM)* |
| **Tabs** | `tabs_list` · `tab_claim` · `tab_create` *(group by topic)* · `tab_activate` · `tab_release` · `tab_close` |
| **Navigate** | `navigate` *(waits for load)* · `reload` · `go_back` · `go_forward` · `wait_for` |
| **Read / observe** | `read_page` *(a11y tree + refs, incl. cross-origin frames)* · `read_text` · `find_text` · `dom_query` · `find` · `screenshot` *(element / full-page)* · `read_console` · `read_network` · `network_body` |
| **Act** | `click` *(right/double)* · `fill` · `type_text` · `press_key` · `select_option` · `scroll` · `hover` · `drag` · `act_batch` · `upload_file` |
| **Auth & dialogs** | `credential_request` *(secure popup)* · `dialog_handle` |
| **Downloads** | `download_wait` · `downloads_list` |
| **Escape hatch** | `cdp` *(any raw CDP command)* |

Ships with the **`browser` skill** (`skill/`) — an always-loaded navigation map that leads with
`run`, plus on-demand reference docs (`reference/*.md`): the **scripting playbook** (`run`
page/locator API + patterns), the interaction loop, targeting, acting, safety, CDP recipes, and
troubleshooting. Invoke it as `/browser`.

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
