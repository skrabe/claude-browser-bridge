# Reading pages — pick the right lens, don't over-read

> Atomic-tool dialect. In a `run` script: `read_page`→`page.domSnapshot()`, `read_text`→
> `page.evaluate(() => document.body.innerText)`, `dom_query`→`page.locator(css)`, and structured
> extraction → one `page.evaluate` that projects the data. The lens-choice *principles* below apply.

## Which reader
- **`read_page`** — accessibility tree: roles, accessible names, and a **ref** per interactable
  element. Best default for *understanding structure and building targets*. Compact vs raw DOM.
- **`read_text`** — visible `innerText`. Best for *reading prose/content* once you're on the
  right page. Not a search tool for a whole site.
- **`dom_query`** — a CSS selector's matches (count + a ref & attrs each). Best for *checking a
  specific thing* (does X exist? how many? what's its href?).
- **`screenshot`** — pixels. Best when *visual layout matters* (charts, canvas, "does it look
  right"), or as a fallback when the DOM is opaque.
- **`find_text`** — does a word/price/error appear *anywhere* on the page (incl. off-screen, not
  yet scrolled into view)? One cheap check — beats a scroll+`read_text` loop.
- **`read_console` / `read_network`** — buffered console messages / requests (url, method, status,
  requestId) since claim. First stop when debugging a live site; `clear:true` resets between repro
  attempts. Follow a request's `requestId` into **`network_body`** to read the API/JSON it returned.
- **`screenshot`** also takes `ref` (just that element) or `fullPage:true` (whole scrollable page).
- **`cdp`** — raw escape hatch (see `cdp.md`) for anything structured the above don't expose.

## Don't over-read (this is where tokens die)
- Don't dump full body text or embedded app-state JSON (`__NEXT_DATA__` etc.) as an exploratory
  search; broad extraction comes **after** you've identified the exact container.
- Many links/results at once = **one** `read_page`/`dom_query` parsed once — never per-element
  reads in a loop.

## Extracting structured data
- Scope first (find the container/table), then extract from *that*.
- Need a link/URL? Read the element's actual `href` via `dom_query` — never reconstruct or guess
  a URL from truncated or visible anchor text.
- For a bounded, already-identified set, a single **`run` with `page.evaluate`** that queries and
  projects exactly the fields you need (limit rows) beats many small reads. (Raw `cdp`
  `Runtime.evaluate` does the same but with more ceremony — prefer `run`.)
