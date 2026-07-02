# Claude Browser Bridge

Drive your **real, logged-in browser tabs** from Claude Code — Codex-style hands
(claim existing tabs, raw CDP, multi-tab), owned end-to-end, no third-party code.

## Architecture (no listening TCP port)

```
Claude Code ──MCP stdio──▶ host/bridge.mjs (MCP mode)
                                │  0600 unix socket  /tmp/claude-browser-bridge-$USER.sock
                                ▼
                           host/bridge.mjs (--native-host, launched by the browser)
                                │  Chrome native messaging (stdio, 4-byte LE + JSON)
                                ▼
                           extension/ (MV3, in Brave)  ── chrome.debugger CDP 1.3 + chrome.tabs
                                ▼
                           your real, logged-in tabs
```

Trust model = same tier as Claude-in-Chrome: the native-messaging manifest pins the
extension id (`allowed_origins`), and the MCP leg is a `0600` unix-domain socket. Nothing
listens on a network port.

## Setup

1. **Load the extension**: `brave://extensions` → enable Developer mode → *Load unpacked*
   → pick `extension/`. Copy the assigned **Extension ID**.
2. **Register the native host**: `./install.sh <EXTENSION_ID>`
3. **Register the MCP server** (the command install.sh prints):
   `claude mcp add claude-browser -- <node> <path>/host/bridge.mjs`
4. **Restart the browser** so it picks up the native host.

## Tools exposed to Claude Code

`tabs_list` · `tab_claim` · `tab_create` · `navigate` · `screenshot` · `read_text`
· `click` · `type_text` · `cdp` (raw escape hatch) · `tab_release`

## Doctrine

Pair with the browser-navigation skill in `skill/` (ported from Codex's operating
instructions) so Claude navigates cleanly: claim don't spawn, cheapest state check,
snapshot reuse, unique-locator-before-act, tidy tab lifecycle.

## Status

v0 — first cut. Verify by driving a real tab end-to-end before relying on it.
