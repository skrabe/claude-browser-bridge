---
name: browser-navigation
description: >
  How to drive a real browser cleanly and cheaply via the claude-browser MCP tools
  (tabs_list, tab_claim, tab_create, navigate, screenshot, read_text, click, type_text,
  cdp, tab_release). Use whenever controlling the user's browser. Ported from OpenAI
  Codex's browser operating instructions.
---

# Browser navigation

You are driving the user's **real, logged-in** browser. Behave like a careful operator,
not a scraper. The whole point is their existing session state — never route around it.

## Claim, don't spawn
- Start with `tabs_list`. If the page you need is already open, `tab_claim` it **in place**.
  Do **not** open a new tab for something already on screen.
- Only `tab_create` when nothing suitable is open.
- Never guess a `tabId` — only use ids returned by `tabs_list`.
- When done, `tab_release` tabs you claimed from the user (hands them back, leaves them open).
  Never close the user's own tabs.

## Cheapest state check after every action
- After a click / type / navigate, collect the **single cheapest** observation that answers
  the next question. `read_text` for content/ground-truth; `screenshot` for visual layout.
  **Do not request both by default.**
- Reuse what you already saw. Do **not** re-`read_text` or re-`screenshot` the whole page to
  re-confirm a fact you already have.
- Stop as soon as one **authoritative signal** confirms the outcome — a selected option, a
  success toast/modal, a basket line item, a URL parameter. Don't keep re-verifying via other
  surfaces once you have it.

## Navigation
- If a tab is already on the target URL, **do not** `navigate` to it again — that reloads and
  can destroy in-progress user input. Only re-navigate when you deliberately need a reload.
- For a read-only lookup, one focused direct navigation to the obvious result/search URL is fine.
- **Never** brute-force URL variants or candidate-URL arrays. If the one focused attempt fails,
  switch to the page's own search/nav UI or give the best answer with stated uncertainty.

## Acting on elements (via `cdp` / `click`)
- Find and **verify a target before acting on it.** Prefer a scoped
  `cdp` → `Runtime.evaluate` that queries a stable selector and returns whether it resolves to
  exactly one element (and its box), rather than clicking blind coordinates.
- Selector stability order: `data-testid` → other stable `data-*` → stable `href` → role +
  accessible name → scoped text → scoped CSS. Treat generic labels (`Menu`, `Close`, `Search`,
  `Add to cart`, size letters `S/M/L`) and repeated `href`s on grids/carousels as **ambiguous** —
  scope to the right container first.
- If a target resolves to 0 elements: it's wrong/stale/not-ready — re-observe and rebuild, don't
  click anyway and don't busy-wait on it. If it resolves to >1: it's ambiguous — scope tighter,
  never just take the first.
- After two failed attempts on the same target, stop escalating — switch to the most stable
  attribute from a fresh observation, or a coordinate `click` from a `screenshot`.
- Don't use fixed sleeps as a waiting strategy; after an action, do a concrete state check.

## Reading pages — don't over-read
- One broad observation to orient, then **narrow**. Don't discover content by iterating over
  many cards/links/rows and reading each one — that's slow and expensive.
- Don't dump full body text or embedded app-state JSON as an exploratory search tool. Use broad
  extraction only after you've already identified the exact element/container you need.

## Focus & visibility
- Work in the background by default. Only `activateTab` (bring a tab to the front) when the user
  wants to watch or the task is to put a page in front of them.

## Interruption
- If the user or browser takes control mid-action, summarize it naturally
  ("Browser control was taken back in the browser") — don't dump raw runtime errors or tab ids.

## Escape hatch
- `cdp` sends any raw Chrome DevTools Protocol command to a controlled tab (`Page.*`, `DOM.*`,
  `Input.*`, `Runtime.*`, `Network.*`, `Accessibility.*`). Use it for anything the higher-level
  tools don't cover — but prefer the higher-level tools when they fit.
