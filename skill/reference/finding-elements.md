# Finding elements — target before you act

> Atomic-tool dialect. In a `run` script: a `ref` → a **locator**, `dom_query` count →
> `page.locator(css).count()`, `read_page` → `page.domSnapshot()`. The targeting *principles*
> (uniqueness, the durability ladder) apply to both — a locator is just a re-findable ref.

Never act on an element you haven't located and confirmed. Acting blind (guessed coordinates,
guessed selectors) is the top cause of wrong clicks.

## How to locate
- **`read_page`** — the accessibility tree with a stable **ref** per interactable element (role +
  accessible name). Primary way to target: read it, pick by role/name, act by `ref`. Robust across
  layout changes (capped at ~500 elements — on a huge page, narrow with `dom_query`/`find_text`
  before concluding a target is absent).
- **`dom_query`** — run a CSS selector, get back the matches (count + a ref & attrs each). Use when
  you know a stable selector and want to confirm uniqueness.
- **`find`** — keyword match over the a11y tree (role + accessible name); returns ≤10 ranked
  candidate refs. Query with the element's *label words* ("subscribe newsletter"), never visual
  descriptions ("the blue button in the header" — color/position match nothing). Cheap but
  context-free: confirm the winner is the right element before acting.

## Uniqueness — the hard rule
Before any click/fill/select, confirm the target resolves to **exactly one** element:
- From `read_page`, use a ref that names a single element.
- From `dom_query`, check the match **count**.
  - **count 0** → wrong/stale/hidden/not-ready. Do NOT act, do NOT busy-wait on it. Re-observe
    and rebuild the target.
  - **count >1** → ambiguous. Scope to the right container or a stronger attribute. **Never**
    just take the first match.

## Selector durability ladder
Refs from the current snapshot are how you act. When you need a re-findable `dom_query` selector
(retries, re-observation), prefer the most durable contract, in order:
1. `data-testid`  2. other stable `data-*`  3. stable `href` (exact/strong match)
4. ARIA role + accessible name (string, not regex)  5. scoped visible text  6. scoped CSS

## Ambiguity to expect
Generic labels (`Menu`, `Close`, `Search`, `Add to cart`, size letters `S/M/L`, `Sort by`) and
repeated `href`s on grids/carousels/modals are **ambiguous by default** — first identify the
stable card/container, then scope inside it before acting.

Resolve "the first / last X" from **rendered order** — what `read_page` or a `screenshot` shows —
not DOM source order; CSS (flex/grid `order`, positioning) can make the visually-first element not
be the first in the source.

## Recovery
- Same target failed twice → stop escalating on role/text. Switch to the most stable attribute
  from a fresh `read_page`, or fall back to a `screenshot` + coordinate `click`.
- Never retry the exact same failing selector without re-observing first.
- A single opaque `canvas`/generic node where you expect many rows/cells (a spreadsheet, a canvas
  editor, a map) means the content is **painted, not in the DOM** — go straight to `screenshot` +
  coordinate `click`/`drag`, don't keep retrying ref/CSS selectors.
