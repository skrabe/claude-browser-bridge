---
name: control-chrome
description: "Control the user's Chrome browser for tasks that depend on existing Chrome state: tabs, logged-in sessions, or extensions. Prefer purpose-built connectors, APIs, or CLIs when available."
---

# Chrome

Use Chrome when the task requires the user's existing Chrome profile state or the user explicitly requests Chrome. Do not switch to Chrome solely because a preferred connector, API, or CLI has missing or expired authentication. Ask the user to fix authentication or explicitly approve Chrome as a fallback.

Chrome is the routing touchpoint for the Codex Chrome Extension:

- Use Chrome directly for Chrome setup, detection, repair, or profile checks.
- For bare or general Chrome requests, do not ask a clarification question just because the request is ambiguous. Proceed with browser automation in this skill.

If this plugin is listed as available in the session, treat that as mandatory reading before Chrome work. Open and follow this skill before saying that Chrome is unavailable and before falling back to standalone Playwright or Computer Use.

## Setup Documentation

Use `await agent.documentation.get("<name>")` when one of these setup topics applies:

- `bootstrap-troubleshooting`: read when browser setup succeeds but discovery or selection fails
- `chrome-troubleshooting`: read when Chrome extension setup, installation, or communication fails

## Bootstrap

These setup details are internal. User-facing progress updates should be less technical in nature. Never mention `Node REPL`, `node_repl`, `REPL`, JavaScript sessions, module exports, reading documentation, or loading instructions unless a user is asking for that exact information. If setup or recovery is needed, describe it naturally as connecting to Chrome or retrying the Chrome connection.

The `browser-client` module is the core entry point for browser use, and is available under `scripts/browser-client.mjs` in this plugin's root directory. ALWAYS import it using an absolute path. IMPORTANT: If this path cannot be found, stop and report that this plugin is missing `scripts/browser-client.mjs`. NEVER use the built in `browser-client` library.

Run browser setup code through the Node REPL `js` tool. In this environment the callable tool id typically appears as `mcp__node_repl__js`. If it is not already available, use tool discovery for `node_repl js` without setting a result limit. You need the `js` execution tool: `js_reset` only clears state, and `js_add_node_module_dir` only changes package resolution. Do not call either helper while trying to expose `js`. If `js` is still not available, search again for `node_repl js` with `limit: 10`.

Initialize the runtime once per fresh Node session, select Chrome, and immediately read its complete documentation:

```js
if (globalThis.agent?.browsers == null) {
  const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");
  await setupBrowserRuntime({ globals: globalThis });
}
globalThis.browser = await agent.browsers.get("extension");
nodeRepl.write(await browser.documentation());
```

If setup succeeds but browser discovery or selection fails, read `await agent.documentation.get("bootstrap-troubleshooting")` before resetting the JavaScript session or trying another browser-control mechanism. If the failure is specific to Chrome extension setup, installation, or communication, read `await agent.documentation.get("chrome-troubleshooting")` before retrying or taking another recovery action.

Use the browser bound to `browser` for tasks in this skill. When authentication blocks requested navigation, do not replace it with web search, a search engine, another site, or another source merely to bypass sign-in. If the browser documentation does not provide a supported authentication flow, ask the user to sign in in Chrome and tell you when it is ready.

The ability to interact directly with Chrome is exposed through the `browser-client` runtime via the `agent.browsers.*` API. Before trying to interact with it, you MUST emit and read the complete documentation returned by `await browser.documentation()` in one go. For the initial documentation read, run the exact direct call `nodeRepl.write(await browser.documentation());` shown above. Do not assign the documentation to a variable, inspect its length, slice it, truncate it, summarize it, or emit only an excerpt. Do not proactively split the documentation into pages or chunks. Only if the tool output itself explicitly reports that it was truncated may you emit and read smaller chunks until you have read the documentation in its entirety.

Only the Node REPL `js` tool (`mcp__node_repl__js`) can be used to control Chrome. Do not use external MCP browser-control tools, separate browser automation servers, or other browser skills for this surface. References to Playwright mean the in-skill `tab.playwright` API after browser-client setup.
