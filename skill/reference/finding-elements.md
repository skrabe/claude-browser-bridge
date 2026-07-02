# Finding elements — target before you act

Never act on an element you haven't located and confirmed. Acting blind (guessed coordinates,
guessed selectors) is the top cause of wrong clicks.

## How to locate
- **`read_page`** — returns the accessibility tree with a stable **ref** per interactable
  element (role + accessible name + ref). This is the primary way to target: read it, pick the
  element by role/name, act on it by `ref`. Robust across layout changes.
- **`dom_query`** — run a CSS selector, get back the matches (count + a ref/box each). Use when
  you know a stable selector and want to confirm uniqueness.
- **`find`** — natural-language element match ("the blue Subscribe button in the header") when
  role/name/selector aren't obvious. Slower (it reasons over the page); prefer `read_page`/
  `dom_query` when you can name the element.

## Uniqueness — the hard rule
Before any click/fill/select, confirm the target resolves to **exactly one** element:
- From `read_page`, use a ref that names a single element.
- From `dom_query`, check the match **count**.
  - **count 0** → wrong/stale/hidden/not-ready. Do NOT act, do NOT busy-wait on it. Re-observe
    and rebuild the target.
  - **count >1** → ambiguous. Scope to the right container or a stronger attribute. **Never**
    just take the first match.

## Selector stability ladder
Prefer the most durable contract, in order:
1. `data-testid`
2. other stable `data-*`
3. stable `href` (exact/strong match, not broad substring)
4. ARIA role + accessible name (string, not regex)
5. scoped visible text
6. scoped CSS
7. an element `ref` from `read_page` (when no stable selector exists)

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
