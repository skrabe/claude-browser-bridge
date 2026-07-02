# Acting — click, type, select, scroll, drag

Act **by element ref** (from `read_page`/`dom_query`) whenever possible — it's precise and
survives layout shifts. Fall back to coordinates only from a `screenshot` when no ref exists.

## Tools
- **`click`** — click an element by `ref`, or by `{x, y}` viewport coordinates. Default to ref.
- **`fill`** — replace an input's value (clears first). Prefer over `type_text` for form fields.
- **`type_text`** — type into the currently focused element without clearing (focus it first,
  usually via a `click`). Use for contenteditable / search-as-you-type.
- **`press_key`** — a keyboard key/chord (`Enter`, `Escape`, `Tab`, `Meta+A`) on the focused
  element. Use `Enter` to submit rather than hunting for a submit button when the form supports
  it.
- **`select_option`** — choose an option in a `<select>` by value/label.
- **`scroll`** — scroll the page or a container by a delta, or to bring a ref into view.
- **`hover`** — move the pointer over a ref to reveal hover-only controls (a card's CTA, a
  hover menu), then act on what appears.
- **`drag`** — drag from one point/ref to another (sliders, reordering, canvas).

## Rules
- **Verify the target is unique before acting** (see `finding-elements.md`). One element only.
- **Don't assume every click navigates.** Opening a menu/filter changes UI state, not the page —
  wait for the expected element to appear, not for a page load.
- **After acting, observe only if the next decision needs it** (see `interaction-loop.md`).
  A fill/type often needs no re-read; a submit needs a state check.
- **Don't add explicit timeouts** to routine click/fill/select unless the target is known slow.
- If you already know the destination URL and no click side-effect matters, prefer `navigate`
  over a brittle click.
- After a checkbox/radio `click` reports hidden/no-change, click its scoped visible `label[for]`
  or enclosing control once, then verify checked state — don't hammer the hidden input.

## Choice controls
- Target radio/checkbox/`select` options by their **exact rendered label** — never a paraphrase
  ("I am not a protected veteran" is not "No"). Map yes/no-shaped data straight onto the matching
  exact-text option; never invert it.
- A real `<select>` is one step. A **custom** listbox/combobox (styled `div`/`button`,
  `role=listbox`/`combobox`) is two: `click` to open (its options often aren't in the DOM, or
  render into a portal, until opened), re-observe, then `click` the option. A placeholder
  ("Select…", "—") or a loading row means *not ready yet* — wait/re-observe, don't select it.
- After filling a search/autocomplete field, check for a suggestions dropdown before moving on —
  many sites want an explicit pick (`click` the option, or `press_key Escape`) rather than the raw
  typed text. This is the one fill that *does* need a follow-up check.
- Split OTP/verification-code input: focus the first box and `type_text` the **whole** code once
  before falling back to one `fill` per box — most auto-advance focus per keystroke.

## Scrolling
- If a page-level `scroll` does nothing, the content is likely in its own scrollable sub-panel
  (modal body, side filter, embedded list/chat log) — target `scroll` at a **ref inside that
  container** instead of the page.
