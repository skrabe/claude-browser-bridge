# Claude Browser Bridge

Let Claude Code drive your **real, logged-in browser** — see and claim your existing tabs,
full CDP, multi-tab — owned end to end, no third-party code, no network port.

## Architecture

```
Claude Code ──MCP stdio──▶ host/bridge.mjs (MCP mode)
                                │  0600 unix socket  /tmp/claude-browser-bridge-$USER.sock
                                ▼
                           host/bridge.mjs (--native-host, launched by the browser)
                                │  Chrome native messaging (stdio, 4-byte LE + JSON)
                                ▼
                           extension/ (MV3)  ── chrome.debugger CDP 1.3 + chrome.tabs
                                ▼
                           your real, logged-in tabs
```

Trust = the native-messaging manifest pins the extension id (`allowed_origins`) + a `0600`
unix socket. Nothing listens on a network port. The extension id is deterministic (pinned key).

## Tools (MCP)

`tabs_list · tab_claim · tab_create · tab_activate · tab_release · navigate · reload ·
read_page · read_text · dom_query · find · screenshot · read_console · read_network ·
click · fill · type_text · press_key · scroll · select_option · drag · cdp`

Pair with the `browser` skill (in `skill/`) — a navigation map + on-demand reference docs.
Invoke it as `/browser`.

## Install / uninstall

```
node host/setup.mjs install  --scope global            # ~/.claude.json + ~/.claude/skills/browser
node host/setup.mjs install  --scope project --project <path>
node host/setup.mjs verify                             # polls the socket + getInfo
node host/setup.mjs status
node host/setup.mjs uninstall                           # reverses everything; re-enables Claude-in-Chrome only if we disabled it
```

Then load the extension once: `brave://extensions` → Developer mode → **Load unpacked** →
`extension/`, and enable it. Restart the browser is **not** needed (the manifest is read on
demand); reload the extension after any code change.

Install (global) also **disables Claude in Chrome** (`claudeInChromeDefaultEnabled: false`) so
you have one browser surface; `--scope project` disables it only for that project
(`disabledMcpServers`). Uninstall restores it — but only if *we* were the one who disabled it.

## Status

Works end to end. First-batch build; verify by driving a real tab before relying on it.
