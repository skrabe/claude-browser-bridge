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
