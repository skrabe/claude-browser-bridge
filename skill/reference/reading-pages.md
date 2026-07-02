# Reading pages — pick the right lens, don't over-read

## Which reader
- **`read_page`** — accessibility tree: roles, accessible names, and a **ref** per interactable
  element. Best default for *understanding structure and building targets*. Compact vs raw DOM.
- **`read_text`** — visible `innerText`. Best for *reading prose/content* once you're on the
  right page. Not a search tool for a whole site.
- **`dom_query`** — a CSS selector's matches (count + refs/boxes/attrs). Best for *checking a
  specific thing* (does X exist? how many? what's its href?).
- **`screenshot`** — pixels. Best when *visual layout matters* (charts, canvas, "does it look
  right"), or as a fallback when the DOM is opaque.
- **`find_text`** — does a word/price/error appear *anywhere* on the page (incl. off-screen, not
  yet scrolled into view)? One cheap check — beats a scroll+`read_text` loop.
- **`cdp`** — raw escape hatch (see `cdp.md`) for anything structured the above don't expose.

## Don't over-read (this is where tokens die)
- One broad observation to orient, then **narrow**. Don't discover content by iterating over many
  cards/links/rows and reading each — that's slow and huge on big pages.
- Don't dump full body text, or embedded app-state JSON (`__NEXT_DATA__` etc.), as an exploratory
  search. Use broad extraction **only after** you've identified the exact element/container.
- When you need many links/results at once, prefer **one** `read_page`/`dom_query` and parse its
  output, or use the site's own search — not per-element reads in a loop.

## Extracting structured data
- Scope first (find the container/table), then extract from *that*.
- Need a link/URL? Read the element's actual `href` via `dom_query` — never reconstruct or guess
  a URL from truncated or visible anchor text.
- For a bounded, already-identified set, a single `cdp` → `Runtime.evaluate` that queries and
  projects exactly the fields you need (return by value, limit rows) beats many small reads.
