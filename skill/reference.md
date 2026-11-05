# Browser bridge reference

Read on demand. The core rules (safety, CAPTCHAs, the working loop, verification) are in
`SKILL.md`; this file holds the detail. Sections:

1. `run` scripts: shape, locators, actions, reads, navigation, tabs, more capabilities
2. Acting on what you can see (marks, coordinates, `probe_point`, click receipts)
3. Atomic tools: see and target, act, wait, peek, emulate and trace, browser management, page API
   and assets
4. Observing and stopping
5. Targeting in depth
6. Flows: record, replay, user recording
7. Patterns
8. Script doctrine
9. Navigation and tabs
10. Non-obvious behaviour
11. Troubleshooting
12. Raw CDP

---

## 1. `run` scripts

`run {tabId, script, timeoutMs?}` executes one JavaScript automation script in a single call:
locate, act, read, loop and branch without a round trip per step.

### Shape

- The script runs in the host (Node), not in the page. There is no `document`, `window` or
  `fetch` at the top level; reach the DOM only through locators or `page.evaluate`.
  (`return document.title` fails; use `return await page.title()`.)
- The body is an async function. In scope, no imports needed:
  - `page`: the Playwright-shaped driver. `tab` is an alias.
  - `browser`: tabs (`openTabs`, `claimTab`, `newTab`, `readUrls`, `history`).
  - `log(...)` / `console.log`: progress lines, returned alongside the result.
  - `sleep(ms)`: a delay. Rarely needed; locators auto-wait.
- `return` a distilled value (a value, a small array or object), never the whole page. Returning
  a screenshot object surfaces the image.
- The result is `{result, logs, status}` on success and `{error, logs, status}` on failure
  (`timedOut:true` when the time cap hit). `status` is `{url, title, openDialog?, challenge?}` as
  of the end of the script.
- Default script timeout is 60s (raise with `timeoutMs`). Each locator auto-waits up to 15s.

### Refs inside a script

`await page.ref("e12")` turns a ref from `read_page`, `dom_query` or `find` into a locator. It is
valid while that element lives in the document. If you're writing the selector into a script you
will keep, or handing it to the user, use `generate_locator {ref}` for a durable locator instead.

### Locators: target by meaning

`page.getBy…` and `page.locator` return a lazy locator. It resolves fresh when you act or read, so
it survives DOM churn. Locators pierce same-origin iframes and shadow DOM, and reach cross-origin
(out-of-process) frames.

| Locator | Matches |
|---|---|
| `page.getByRole('button', {name:'Save'})` | ARIA role + accessible name (implicit roles included) |
| `page.getByText('Sign in')` | visible text; matches the deepest element, not ancestors |
| `page.getByLabel('Email')` | form control by its `<label>` / `aria-label` |
| `page.getByPlaceholder('Search…')` | input by placeholder |
| `page.getByTestId('row-42')` | `data-testid` / `data-test-id` / `data-test` |
| `page.locator('css > selector')` | raw CSS (also pierces shadow DOM and same-origin frames) |

Name and text matching is substring and case-insensitive by default. Use `{exact:true}` for exact,
or a RegExp: `getByRole('button', {name:/save|update/i})`.

Refine instead of guessing indices: `.filter({hasText:'In stock'})`, `.filter({hasNotText:'Sold'})`,
`.nth(i)`, `.first()`, `.last()`, or chain to scope:
`page.getByRole('row').filter({hasText:'ACME'}).getByRole('button',{name:'Edit'})`.

Strict mode: an action or single-value read on a locator that matches more than one element
throws. Refine it; don't retry it as is. `.count()`, `.all()` and `.allTextContents()` are the
plural reads. They cap at 500 matches per frame; for a bigger set, count in `evaluate`.

### Auto-waiting

`.click()`, `.fill()`, `.type()`, `.press()`, `.check()`, `.selectOption()` and `.hover()` wait for
the element to exist, be visible and be actionable (up to ~15s). You rarely need a `sleep` or a
pre-check. Explicit waits: `await loc.waitFor({state:'visible'|'hidden'|'attached'|'detached'})`.
Don't pass `timeoutMs` to routine actions; keep it for known-slow navigation.

### Actions

`click(o)` · `dblclick()` · `hover()` · `fill(value)` · `type(value)` · `press('Enter'|'Meta+A')` ·
`selectOption(v)` · `check()` · `uncheck()` · `setChecked(bool)` · `focus()` ·
`setInputFiles(paths)` · `dragTo(target)` · `scrollIntoViewIfNeeded()`.
`pressSequentially(v)` is Playwright's current name for `type(v)`; both work, and neither clears
the field first.

- Clicks are real trusted mouse events at the element's center, scrolled into view first.
  `click({button:'right'})`, `click({modifiers:['Meta']})`, `click({clickCount:2})`.
- `fill` clicks into the field, clears it and types the value as real keystrokes. Date, color and
  range inputs are set directly. `type` appends keystrokes without clearing: use it to add to
  existing text or to drive a per-key widget; use `fill` for everything else.
- `check`/`uncheck` are idempotent. `selectOption('US')`, `{label:'United States'}`,
  `{value:'us'}` or `{index:2}` (numbers coerce). For a custom (non-`<select>`) dropdown, click to
  open, wait for the option to render, then click it.
- Secrets: `.fill({secret:'NAME'})` fills a value registered with `secret_set` without putting the
  literal in your script. It is redacted from every result. Use it for passwords and OTPs.
- Formatted fields can rewrite what you typed (a mask or `maxlength`). The atomic `fill` reads the
  value back and returns `mismatch` when the field didn't keep it; act on that. Inside `run`,
  check `.inputValue()` yourself.
- Date and time inputs take one format whatever they display. Chrome renders them by locale but
  only accepts the wire format, so `03/15/2026` sets nothing. `read_page` states the expected
  `format` on those elements; use it.
- Choice controls: match the exact rendered label, never a paraphrase. "I am not a protected
  veteran" is not "No". Map yes/no-shaped data onto the matching exact-text option, and never
  invert it. If a checkbox or radio reports hidden or won't change, click its scoped visible
  `label` or enclosing control once and verify the checked state; don't hammer the hidden input.
- OTP / split code: focus the first box and `type` the whole code once (most boxes auto-advance per
  keystroke) before falling back to one `fill` per box.
- Submit with `press('Enter')` on the focused field when the form supports it, rather than hunting
  for a submit button.
- Not every click navigates. Opening a menu, filter or accordion changes UI state, not the page:
  wait for the expected element, not for a page load.
- Scrolling: if a page-level scroll does nothing, the content is in its own scrollable panel
  (modal body, side list, chat log). Scroll a locator or ref inside that container.

### Reads

Single-value (strict, auto-wait): `textContent()` · `innerText()` · `inputValue()` ·
`getAttribute(name)` · `boundingBox()`. Boolean or plural (no throw): `count()` · `all()` ·
`allTextContents()` · `isVisible()` · `isEnabled()` · `isChecked()`.

Locator-scoped JS: `loc.evaluate((el, arg) => …, arg)` on the single matched element, and
`loc.evaluateAll((el, arg, i) => …, arg)` across every match in one pass. For scraping a list you
already have a locator for, `page.getByRole('row').evaluateAll(el => el.innerText)` beats looping
`.nth(i)`, which pays a round trip per row.

`page.domSnapshot({selector, max, exclude, boxes})` is the whole-page overview inside a script: a
compact list of visible interactables (`[n] role "name" =value`), scopable to a container and
piercing frames and shadow DOM. No element cap, but character-budgeted (default 20k, raise with
`max`; each cross-origin frame gets 4k). `exclude:['nav','.ads']` prunes noise; `boxes:true`
appends `[box=x,y,w,h]`. Open dialogs and dropdowns come first so truncation can't drop them. Its
`[n]` numbers are not `read_page` refs. It is good for a one-shot survey of a big page; outside a
script, in an act-then-look loop, `read_page`'s delta is cheaper because `domSnapshot` always
returns everything.

`page.evaluate(fn, arg)` runs JS in the page. The function is serialized (`.toString`), so it has
no closures: pass data through the single JSON-serializable `arg`. It runs in the main frame and in
an isolated world (see section 10); pass `{ world: 'page' }` as the third argument to reach page
globals.

`evaluate` is the bulk-read primitive. To read a property off many elements, project the whole
array in one `evaluate`. Each locator read is a separate round trip, so a per-row loop is the most
expensive thing you can do. When the ask is "all" or "every", compare your count against
`document.querySelectorAll(...).length` in the same `evaluate`. Read hrefs off `.href`; never
retype a long URL you only saw in snapshot text. Click by locator or read the href in the script.

### Navigation and page state

`goto(url,{waitUntil})` · `url()` · `title()` · `reload()` · `goBack()` · `goForward()` ·
`waitForLoadState({state})` · `waitForURL(pattern)` · `expectNavigation(action,{url})` ·
`waitForTimeout(ms)` · `screenshot({fullPage})` · `bringToFront()` · `close()`.

- `goto` waits for `load` and throws on a failed navigation. `waitForURL('/checkout')` matches a
  substring; a RegExp like `/\/orders\/\d+/` also works.
- Wrap a click that navigates: `await page.expectNavigation(() => btn.click(), {url:/success/})`.
  It detects a URL change, so for a same-URL SPA re-render wait on a content signal instead.

### Tabs

`browser.openTabs()` returns the user's real tabs `[{id,title,url,tabGroup,windowId,lastOpened}]`.
`browser.claimTab(idOrTab)` and `browser.newTab(url)` each return a fresh `page` bound to that tab,
so you can hold several handles and work multiple tabs in one script. Claim an existing tab before
opening a new one.

### More capabilities

- Upload: `await page.getByLabel('Resume').setInputFiles('/abs/file.pdf')`. No OS picker.
- Download: trigger it, then `const {path} = await page.waitForDownload()` and `Read` that path.
- Dialogs: a native `alert`/`confirm`/`prompt` freezes the tab until handled. A click or key that
  opens one returns at once (the atomic `click` reports `openedDialog`); anything else that touches
  the page fails fast naming the dialog until it is answered. After an action that may open one,
  `const d = await page.getJsDialog()` returns `null` or `{type, message, accept, dismiss}`. Decide by the task goal (accept a "proceed?"; weigh a
  "discard changes?"). `beforeunload` is auto-accepted so it can't wedge navigation.
- Console: `await page.consoleLogs({limit})`, for debugging a local app.
- Screenshot: `await page.screenshot({fullPage, marks, boxes, ref})` uses the same capture path as
  the atomic tool, so it returns the same `{scale, origin, space, …}` mapping and can draw marks.
- Save the page: `await page.pdf({path})` or `page.export({format:'text'})` returns
  `{path, bytes}`.
- Responsive: `await page.setViewport({width:390, height:844, mobile:true})`, then
  `page.resetViewport()`. Only for device or breakpoint testing.
- Batch read: `await browser.readUrls([url1, url2])` loads each URL in a background tab (bounded
  parallel), extracts `{title, snapshot, text}`, and closes it. For multi-source research.
  `await browser.history({query})` lists recent history, only when the task needs it.
- Visual helpers: see section 2.
- Only available as atomic tools (no `page.` equivalent): `clipboard_read`/`clipboard_write`,
  `page_assets`/`bundle_assets`, `webmcp_tools`/`webmcp_call`, `probe_point`, `credential_request`.
  Call them before or after a `run`, not inside it.

---

## 2. Acting on what you can see

Sometimes the page is the picture: a canvas app, a painted UI, a chart, an element with no stable
role or name. Acting visually is fine. The one rule is don't guess a raw pixel: a pixel you read
off a screenshot is not a CSS pixel, and clicking it as one lands somewhere else.

`screenshot {marks:true}` then `click {ref}` is the way to act visually. Marks draw a labelled
badge on every interactable element, and the badge text is the ref `click` takes. It resolves
through the element, so it cannot land on the wrong thing. It is not a fallback; use it freely.
Marks omit geometry by default; add `boxes:true` only when you need coordinates.

When you need a real coordinate (a point on a canvas, a chart position, a spot with no element of
its own), every screenshot returns its mapping alongside the image:

```json
{"space":"viewport","scale":0.62,"origin":{"x":0,"y":0},
 "imageSize":{"width":1568,"height":940},"viewport":{"width":2528,"height":1516},
 "scroll":{"x":0,"y":0}}
```

Pass the pixel back in the space you read it in and the bridge converts it:

- `click{x, y, space:"image"}`: a pixel measured on the last screenshot. Almost always what you
  want.
- `click{x, y, space:"page"}`: document coordinates (what a `fullPage:true` shot is in).
- `click{x, y}`: CSS viewport pixels, the default. Only correct if you computed them yourself.

The same `space` option applies to `hover`, `scroll`, `drag` and `probe_point`. Sending an image
pixel without `space:"image"` is the classic miss: at `scale` 0.62 every coordinate lands about
1.6× short. A point outside the viewport is rejected rather than clamped, so a wrong space usually
shows up on the first try.

`probe_point {x, y, space}` tells you what is actually at a point: the element (tag, role, label,
selector, box) plus a ref you can click. That turns a coordinate guess into a semantic target.
`annotate:true` also returns a picture with a crosshair on the point, so you can see a misplaced
guess.

Every `click` returns a receipt. `landedOn` names the element that took the click (the button or
link, not the icon inside it; `via` names the innermost element when it differs); `intercepted`
appears when an overlay covered the element your ref pointed at:

> `click at (412,388) was over <div> "Accept cookies", not the ref's <button> "Add to cart" —
> something is covering the target. Clear it and retry.`

That is the signal to dismiss the modal or banner, not to retry the same click.

Inside `run`: `page.dom_cua.get_visible_dom()` (numbered nodes with boxes), then
`click({node_id})` · `double_click({node_id})` · `type({text})` · `keypress({keys})` ·
`scroll({node_id,x,y})`; plus `page.elementFromPoint({x,y})`, `page.mouse.click(x,y)` /
`page.mouse.wheel(x,y,dx,dy)` and `page.drag(from,to)`. `run`'s mouse helpers take CSS viewport
pixels: get them from a locator's `.boundingBox()` or `domSnapshot({boxes:true})`, never from a
screenshot.

Whatever the route, verify with page state, not with the click's own success: a selected option,
a checked box, a toast, a cart line, a URL parameter.

---

## 3. Atomic tools

For a single action or a quick look. Each action (`click`, `fill`, `type_text`, `press_key`,
`select_option`, `scroll`, `hover`, `drag`, `upload_file`, `navigate`, `reload`, `go_back`,
`go_forward`, `dialog_handle`) returns a status:
`{url, title, newConsoleErrors?, newConsoleWarnings?, openDialog?, challenge?}`. A `challenge`
entry includes `blocking` and a `next` hint.

### See and target

- `tabs_list` · `tab_claim` · `tab_create` (`group:"<topic>"` puts it in a tab group) ·
  `tab_activate` · `tab_release` · `tab_close`.
- `read_page`: the accessibility tree with a ref per interactable (role + name), including
  same-site iframe content and cross-origin frames (elements tagged `frame:true`). Capped at about
  500 elements; on a huge page, narrow first.
  - Refs stay valid for as long as their element lives in the document. After the first read of a
    page, it returns only the delta (`added`/`changed`/`removed`, with `unchanged` as a count);
    unchanged elements keep their refs. In an act-then-look loop the delta costs roughly the size
    of what changed. A navigation resets the baseline, so the first read on a new page is full.
  - `full:true` re-sends the whole tree; use it when you've lost the thread, not routinely.
    `screenshot:true` returns the structure and a marked picture of the same state in one call.
  - `full:true` + `toFile:true` writes the tree to disk and returns a path and a 12-element
    preview; refs in the file are live. `screenshot` and `network_body` take `toFile` too.
  - `mode:"interact"` returns controls and headings only.
  - `ignore:["nav","[role=banner]",".ads"]` drops those subtrees from the tree and from the delta
    baseline, so a live badge in the nav stops churning every read. It sticks per tab until
    `ignore:[]`.
  - `covered:true` marks elements painted over by an overlay (modal, dropdown, cookie banner).
    They can't be clicked until it's dismissed, and the result carries a count. This is the most
    common reason a click silently does nothing.
  - Role `clickable` is the bridge's own: a role-less element (`<div onclick>`, a card with
    `cursor:pointer`) that the page makes clickable. It has a ref and clicks like anything else,
    named from its `aria-label`, `title` or text.
  - `unchanged:true` means your last action changed nothing. Don't repeat the action and don't
    fall back to coordinates; find the reason (overlay, disabled control, still-loading page
    — use `wait_for` — or the wrong element) and act on it.
  - A top-level `challenge` appears when an anti-bot check is present.
- `read_text`: visible innerText, for reading prose once you're on the right page.
- `find_text`: does a word or phrase appear anywhere, including off-screen? Returns a count and
  context snippets. Cheaper than a scroll-and-read loop. `regex:true` for a pattern.
- `find`: keyword search over roles and names; up to 10 ranked candidate refs. Query with the
  element's label words ("subscribe newsletter"), not visual descriptions ("the blue button"
  matches nothing). Confirm the winner before acting.
- `dom_query`: a CSS selector returns the match count and a ref and attributes per match. Top
  document only (a selector can't cross an origin boundary; use `read_page` or `find` inside a
  cross-origin frame). Use it to confirm existence or uniqueness.
- `screenshot`: visual layout. `marks:true` badges every interactable with its ref; `ref:` shoots
  just that element; `fullPage:true` the whole page. Always reports its image-to-CSS mapping (see
  section 2).
- `probe_point`: what element is at `{x,y,space}`. See section 2.
- `generate_locator {ref}`: a durable locator for a ref (see section 5).
- Pick the one lens that answers the next question: `read_page` for structure and refs,
  `read_text` for prose, `find_text` for "does X appear", `screenshot` for layout.

### Act

Target by `ref`, by a unique CSS `selector` (saves a `dom_query` round trip; matching more than
one element is an error, not permission to take the first), by `intent`, or by coordinates where
the tool takes them.

`click` (`button:"right"|"middle"`, `double:true`) · `fill` · `type_text` · `press_key` ·
`select_option` · `scroll` · `hover` · `drag` · `upload_file` · `select_text`.

- `fill`, `select_option`, `select_text` and `upload_file` accept `selector` or `intent` instead
  of `ref`.
- `fill` replaces a value in an input, textarea or contenteditable rich-text editor, including
  inside same-site iframes. It reads the value back and reports `mismatch` when a mask or
  `maxlength` rewrote it. `fill` and `type_text` take `{secret:"NAME"}`.
- `type_text` types into the focused element (focus it first). `press_key` presses a key or chord
  (`Enter`, `Tab`, `Escape`, `Arrow*`, `Meta+A`); a single printable key also types its character.
- `select_option` picks a `<select>` option by value. For custom dropdowns, see section 5.
- `upload_file` sets absolute file paths on an `<input type=file>`, with no native picker.
- `intent` is the robust way to target: `{selector:"#save", intent:"save the order"}`. The
  selector narrows and the intent confirms. If the selector now points at something whose label
  doesn't agree (a reshuffled id landing on "Delete order"), the call is refused. If the selector
  matches nothing, the intent finds the control by label, but only when one candidate clearly
  leads (`resolvedBy:"intent"` in the result). `intent` alone works too. An ambiguous intent
  errors with the candidates rather than guessing.
- `select_text` puts the caret or a selection at an exact spot inside existing text (input,
  textarea or contenteditable): `{ref, text:"Berlin", selectionType:"select"}`, then `type_text`
  to replace just that word, or `selectionType:"before"|"after"` to place the caret and type
  around it. This edits part of a value; `fill` replaces all of it. When the text repeats, pin the
  occurrence with `prefix`/`suffix`; an ambiguous match errors.
- The acting rules in section 1 (exact labels, checkbox labels, not every click navigates) apply
  here too.

### Wait and other tools

- `wait_for`: block until a condition holds instead of polling `read_page`:
  `{state:"load"|"networkidle"}`, or `selector` / `text` / `textGone` / `urlIncludes`. Caps at 25s.
- `validate`: proves an outcome in one deterministic call. Page level: `urlIncludes`,
  `urlMatches` (regex), `titleIncludes`, `text` (string or array), `textAbsent`. Element level (by
  `ref`, `selector` or `intent`): `visible`, `enabled`, `checked`, `value`, `textContains`. All
  checks run and return evidence; `ok:true` only if all pass. A failure tells you what the page
  shows, which is usually the next step.
- Also: `dialog_handle`, `download_wait` / `downloads_list`, `credential_request`,
  `secret_set` / `secret_list` / `secret_clear`, `read_console` / `read_network` / `network_body`,
  `clipboard_read` / `clipboard_write`, `navigate` / `reload` / `go_back` / `go_forward`,
  `challenge_wait`, `cdp` / `cdp_events`.
- `credential_request {tabId, reason, fields:[{id,label,type,selector}], submit?}`: the user types
  into a secure popup; the bridge fills the fields by selector and returns only a status
  (`submitted`, `declined`, `origin_changed`, `locator_invalid`, `expired`, `submission_failed`).
  Pass selectors and metadata, never values.

### Without taking the tab over

`peek_tab` reads a user tab's title, URL and visible text without claiming it. No debugger attach,
so no "being debugged" banner and nothing taken away from the user. Use it for "what does that
other tab say" or "check the price in my other tab"; claim only when you need to act. It can't read
browser-internal pages, and a page still loading may come back thin; claim it if you need
certainty.

### Test under conditions, find out why it's slow

- `emulate`: `cpuThrottlingRate:4`, `networkConditions:"Slow 3G"` (`Offline`, `Slow 3G`,
  `Fast 3G`, `Slow 4G`, `Fast 4G`, `none`), `colorScheme:"dark"`,
  `viewport:"390x844x3,mobile,touch"`, `userAgent`, `geolocation:"lat,lng"`, `extraHttpHeaders`.
  Each key applies independently. Nothing is undone for you; `reset:true` when done.
- `perf_trace {action:"start", reload:true}` (returns after the load settles), interact if you want
  INP, then `{action:"stop"}`. Returns Core Web Vitals (LCP, CLS, INP, FCP, TTFB) each rated
  good/needs-improvement/poor, long tasks, render-blocking and slowest resources, and named
  insights (`LCPBreakdown`, `DocumentLatency`, `CLSCulprits`, …) saying what to look at, plus the
  raw trace as a `.json.gz` for DevTools or Perfetto. For "on a slow phone", `emulate` first, then
  trace.

### Organize the browser itself

`browser_manage`: windows, tab groups, pinning and bookmarks. `namespace` + `method` + `args`
mirror the Chrome extension APIs: `tabs.query({url:'https://docs.*/*'})`,
`tabs.update(id,{pinned:true})`, `tabs.group({tabIds})`, `tabGroups.update(id,{title,color})`,
`windows.update(id,{focused:true,width,height})`, `bookmarks.search({query})`,
`bookmarks.create({title,url,parentId})`, `bookmarks.move(id,{parentId})`. Query first and act on
the ids you get back. Keep tabs in their current window unless the user asked to move them.
`namespace:"audit"` lists what you changed this session with the state before each change; use it
to tell the user what happened or to undo it. Confirm before deleting a bookmark or closing tabs
the user owns.

### The page's own API and assets

- `webmcp_tools`: does this page publish its own tools (WebMCP `document.modelContext`, plus
  declarative `[toolname]` forms)? When one covers what you need, `webmcp_call` it instead of
  driving the UI: it's the app's own semantic operation, so it can't misclick. Still rare; worth
  one check on an unfamiliar app before a long flow, not on every page.
- `page_assets`: inventory the files the page rendered (images including `srcset` and CSS
  backgrounds, video, stylesheets, scripts, loaded fonts, inline SVG markup). Load the UI state you
  care about first; it reports what's currently observable.
- `bundle_assets`: downloads assets from the last inventory and returns local paths to Read.
  Filter with `kinds` or `assetIds`. Don't navigate to an asset URL just to fetch it. Only the
  page's own origin is fetched with the user's session; other origins go without cookies,
  private-network addresses are skipped on public pages, and redirects aren't followed. If the
  page navigated since `page_assets`, call it again. Where the files land: see section 10.

---

## 4. Observing and stopping

- One broad observation to orient, then narrow. Don't take two lenses by default (for example
  `read_page` and `screenshot`). On a fresh page, dismiss a blocking modal or cookie banner as part
  of orienting. If you're not getting narrower, don't scale extraction across more elements;
  change strategy (a different lens, the site's own search, a direct URL).
- When driving atomically, look after each action. The `read_page` delta is cheap. Firing three or
  four actions blind and then reconstructing which one didn't land is the failure mode to avoid.
- Verification order: the status header first; `validate` to prove a specific outcome (value,
  text, visibility) and before reporting a submit done; a fresh `read_page` when you need to see
  what changed.
- Acting is not finishing. Before you report done, observed state has to show it: the row is
  gone, the toast says saved, the URL carries the id.
- One authoritative signal (URL param, success toast, checked state, basket line) is the answer
  unless another directly contradicts it. Don't re-verify it.
- Search-engine fallback is one focused query. Run it, open the strongest result; don't loop
  rewriting the query.
- Stuck detection: same URL after 3+ actions with no new content means you're stuck; change
  approach. A rejection or validation message means change the value or target, never retry it
  identically.
- Done, continue or blocked: for a compound goal ("do A and B and email me"), verify each part and
  never report done while one is unmet. If you can't proceed (a challenge you cannot complete, a
  missing credential, a hard access-deny), say why and hand back rather than looping.
- Ground every value you report: a price, name, date or count must have appeared in a read this
  session, not from memory. If you couldn't verify, say so.
- Batch independent work: parallel reads across tabs, `Promise.all` across distinct pages,
  multi-field fills from one observation. Serialize only what's causally dependent.
- Speak plainly: describe what you're doing in the user's terms; don't surface tabIds, CDP names,
  "MCP" or debugger details unless asked.

---

## 5. Targeting in depth

- Confirm the target resolves to exactly one element before clicking or filling. Count 0: wrong,
  not ready, or gone (re-observe, don't busy-wait). Count above 1: scope to the right container.
- Durability ladder for a re-findable selector: `data-testid`, then other stable `data-*`, stable
  `href`, role + accessible name, scoped text, scoped CSS. `generate_locator {ref}` walks it for
  you and reports how many elements each candidate matches; `best` is the one that matches exactly
  one, and if none does it says so and you should scope to a container. Use it when you're writing
  a selector into a reusable script or handing one to the user: a ref dies with its element or
  document, a locator doesn't.
- Generic labels (`Menu`, `Close`, `Search`, size letters `S/M/L`) and repeated `href`s on grids or
  carousels are ambiguous by default. Identify the stable card or container first, then scope in.
- Resolve "the first/last X" from rendered order, not DOM source order.
- Custom widgets need a protocol. A real `<select>` is one step; a styled listbox or combobox is
  click to open, wait for the options to render, click the option. After a search or autocomplete
  fill, wait for suggestions and pick one. If the exact string yields no match, generalize or
  specialize it once; don't retype it identically.
- Virtualized or infinite lists render only visible rows. Scroll, collect and dedupe by a stable
  key until the set stops growing.
- Same target failed twice: stop escalating on role or text. Switch to the most stable attribute
  from a fresh read, or to `screenshot {marks:true}` and click the badge.
- A single opaque `canvas` where you expect many rows means the content is painted, not in the
  DOM. Go visual, and use `probe_point` to name what's under a point before acting on it.

---

## 6. Flows

A flow is a sequence of your own successful actions, compiled so it replays without you in the
loop. (Stagehand reports about 2× faster and 30% cheaper on repeat work for the same idea.)

### Record

`flow_record {action:"start", name}`, do the task with the atomic tools, then
`flow_record {action:"stop", variables:{email:"ada@x.com"}}`. `action:"cancel"` discards.

- Every state-changing call (`click`, `fill`, `type_text`, `select_option`, `select_text`,
  `press_key`, `scroll`, `hover`, `navigate`, `wait_for`, `validate`, …) is captured with a
  fingerprint of the page it acted on.
- Reads are not recorded; on replay the observe steps vanish, which is the point.
- A ref you used is converted to a durable locator on the spot. An element with no unique locator
  is recorded as fragile, and you're told which step.
- A failed action, or a red `validate`, is not recorded.
- `variables` turns literal values into `%email%`. The key is the variable name, so one flow
  serves every value. Use `secret:"NAME"` for passwords: the name is stored, never the value.
- `run` scripts are not recorded. Use atomic tools while recording.
- End the recording with a `validate` so the flow proves its own outcome on every replay.

### Replay

`flow_run {name, tabId, variables:{email:"bo@y.org"}}` runs every step in one call and returns
`cacheStatus`:

- `HIT`: the page matched the recording; all steps ran.
- `HIT-DRIFTED`: the page's controls changed since recording, but every target still resolved
  uniquely, so it proceeded. Consider re-recording when convenient.
- `STALE` / `FAILED`: a step's target no longer resolves, or a `validate` went red. You get the
  failing step index, what the page shows, and the flow file path. Heal that one step: take a
  `read_page`, do the step by hand, re-record from there. Don't start the task over.
- `stopOnDrift:true` refuses any drift, for flows where a changed page means stop and look.

Scope the fingerprint. Fingerprints hash interactive roles and names, so prose and counters don't
churn them, but a nav with a live badge will. Set `read_page {ignore:["nav",".ads"]}` once on the
tab before recording; it sticks, and both the live tree and every fingerprint honour it.

### Let the user show you once

`user_record {tabId, action:"start"}` watches the user's real clicks, typing (coalesced to the
final value per field), selects and Enter, across navigations. `stop` returns a ready `run` script
and, with `saveAs:"name"`, a saved flow (`variables` works as above). Tell the user when you start
and stop. Password values are never captured; they become `fill({secret:"NAME"})` placeholders you
register with `secret_set` before replaying. User-recorded steps carry no fingerprints, so replay
relies on each target resolving uniquely and its intent agreeing; run it once to confirm.

### Manage

`flows {action:"list"|"show"|"delete"}`. Flows are plain JSON under
`~/.claude-browser-bridge/flows` (`CBB_FLOW_DIR` relocates them): portable, and committable next
to a project so CI can replay a login or a fixture setup.

---

## 7. Patterns

Extract a list in one `evaluate`, not per row:

```js
return await page.evaluate(() => {
  const rows = [...document.querySelectorAll('tr')].filter(r => r.textContent.includes('INV-'));
  return rows.map(r => ({
    id: r.querySelector('td')?.innerText.trim(),
    amount: r.querySelector('[data-testid=amount]')?.innerText.trim(),
  }));
});
```

Login, submit, confirm:

```js
await page.getByLabel('Email').fill(user);
await page.getByLabel('Password').fill({ secret: 'pw' });
await page.expectNavigation(() => page.getByRole('button', { name: /sign in/i }).click(), { url: /app/ });
return { landedOn: await page.url() };
```

Act on a ref you got from `read_page`:

```js
const row = await page.ref('e41');
await row.getByRole('button', { name: 'Edit' }).click();
return await page.getByRole('dialog').innerText();
```

Fan out across tabs. Independent reads on different pages run concurrently. Never `Promise.all`
actions on the same page; they race the shared focus and pointer.

```js
const [a, b] = [await browser.claimTab(t1), await browser.newTab(u2)];
const [x, y] = await Promise.all([
  a.evaluate(() => [...document.querySelectorAll('.order')].map(o => o.textContent)),
  b.evaluate(() => [...document.querySelectorAll('.user')].map(u => u.textContent)),
]);
```

A click that opens a new tab (`target=_blank`, OAuth). Your `page` still points at the old tab:

```js
const before = new Set((await browser.openTabs()).map(t => t.id));
await page.getByRole('link', { name: 'Open report' }).click();
await sleep(400);
const p2 = await browser.claimTab((await browser.openTabs()).find(t => !before.has(t.id)));
```

Verifying your own local app (`localhost`, `127.0.0.1`, `::1`, a dev URL): without hot reload, the
tab shows the code from before your edit. `reload()` first, then observe, or you'll verify a stale
build. With hot reload on, still wait for a content signal rather than assuming the re-render
happened.

---

## 8. Script doctrine

- One script per flow, split at a confirmation boundary. Around a consequential action (buy,
  send, delete, a submit that transmits data), end the script before that click, return the staged
  state for the user to confirm, and commit in a second `run`.
- Semantic first: role, text or label locators over CSS, CSS over marks, marks over raw
  coordinates. Raw pixels carry the risk.
- A mid-script action can navigate and leave later locators pointing at a gone page. If a step
  might navigate, wrap it in `expectNavigation` or `waitForURL`. On failure `run` returns
  `{error, logs}`, so the `log()` trail survives.
- Self-heal. A locator that fails mid-script is often transient (animation, re-render). Wrap risky
  steps in try/catch, take a fresh `domSnapshot`, and re-derive the locator once before giving up.
- `domSnapshot` numbering is per snapshot. Take a fresh one after a navigation, and after a
  timed-out click, a strict-mode failure or a bad selector, before building the next locator.
- When a script dies mid-flow, don't re-run a longer one. Step the failing part with atomic tools
  until you can see what the page is doing.

---

## 9. Navigation and tabs

- `navigate` goes to a URL, waits for load by default (`waitUntil:"none"` skips), and skips the
  load if already there, because a reload can destroy in-progress input. Use `reload` only when
  you need fresh state (for example after a dev rebuild). `go_back`/`go_forward` move through
  history. Don't brute-force candidate URLs: one focused direct navigation, else the page's own
  search.
- Claim, don't spawn. If the page is already open, `tab_claim` it in place (keeps its session).
  Only `tab_create` when nothing suitable exists; never guess a tabId. For several sources at once,
  open one background tab per URL (`group:"<topic>"` keeps them tidy) rather than walking one tab
  through each.
- Background by default. `tab_activate` only when the user wants to watch.
- Leave the workspace tidy. `tab_close` the tabs you created (it refuses the user's own);
  `tab_release` hands a claimed tab back and leaves it open. Keep a tab only for a stated reason (a
  deliverable, or work continuing next turn).
- After a transition you didn't cause (redirect, unexpected reload), check that earlier-filled
  fields held before continuing. Capture anything a later step needs before leaving a page.

---

## 10. Non-obvious behaviour

This bridge drives a real running browser, not a headless one you own.

- A screenshot pixel is not a CSS pixel. Images are downscaled to fit vision limits, so `scale` is
  usually below 1. Pass a measured pixel back with `space:"image"` (section 2). This is the most
  common way to act on the wrong thing.
- Refs live as long as their element. A ref from `read_page`, `find`, `dom_query` or marks stays
  valid across reads and actions while its element is in the document. A navigation (new
  document) or the element's removal kills it, and a dead ref errors clearly rather than clicking
  the wrong thing.
- Don't read the clipboard from page JS. `navigator.clipboard.readText()` needs the
  `clipboard-read` permission; on a tab the user isn't looking at, the permission prompt can never
  be shown and the promise never settles, so your `run` script hangs until it times out. Use the
  `clipboard_read` tool, which pastes via a trusted browser command and needs no permission.
- Your scripts run in a private world. `page.evaluate`, `run` and `cdp` `Runtime.evaluate`
  execute in the bridge's isolated JS world: the same DOM and `document`, but not the page's own
  globals, so a variable the page set on `window` (an app object, a framework store) reads as
  `undefined`. Data embedded in markup is still there: read
  `document.getElementById('__NEXT_DATA__').textContent`, not `window.__NEXT_DATA__`. That split
  keeps the page from seeing the bridge. To reach a page global, pass `{ world: 'page' }` as the
  third argument to `page.evaluate(fn, arg, { world: 'page' })`, or `world:"page"` to `cdp`. The
  page can observe those calls, so use them only when you need page JS state.
- Page console capture is opt-in. Network and browser errors are always recorded. The page's own
  `console.*` calls are captured from the first `read_console` on a tab onward (listening is
  detectable by anti-bot scripts); `read_console {stop:true}` turns it off again.
- Input is human-shaped. Clicks travel a curved pointer path with a short dwell; `fill` clicks
  into the field, clears it with real keys and types with a rhythm. A long value types fast; date,
  color and range inputs are set directly. Expect a click or fill to take a few hundred ms.
- Background tabs work. The bridge emulates focus and keeps the tab lifecycle active, so SPAs that
  gate rendering on visibility still load. `tab_activate` is for when the user should watch, not
  to make a page work.
- The "…is debugging this browser" banner is expected on any claimed tab. It's how Chrome shows
  the attach; `tab_release` removes it. Don't apologise for it or work around it.
- Downloads land in the user's real Downloads folder, not a sandbox. `download_wait` returns an
  absolute path you can `Read` (`timeoutMs` caps at 120s).
- `bundle_assets` writes to scratch space under the OS temp dir (swept after 12h, gone on reboot),
  never the user's Downloads folder and never a path you pick (`directory` is just a folder name).
  These are working copies; if the user wants one kept, copy it somewhere permanent and say where.
- A download the page starts uses the browser's own UI, which an extension can't suppress. If the
  user has "ask where to save each file" on, a native save dialog opens and the download sits at
  `in_progress` with an empty filename until they click Save. A `download_wait` timeout isn't
  necessarily a failure; say a dialog may be waiting rather than retrying.
- `dom_query` and a CSS `selector` on atomic tools are top-document only. Use `read_page` or
  `find` (refs) to target inside a cross-origin frame.

---

## 11. Troubleshooting

- "host not running" or timeouts: the browser must be open with the extension loaded and enabled,
  and its native host reachable. If a call times out, the extension's service worker may have
  slept; a retry usually reconnects it. A timeout that says the extension stayed responsive means
  the page is busy: narrow the step or wait for a specific condition instead of a full load.
- A `run` script failed: it returns `{error, logs}`; read `logs` to see how far it got.
  `timedOut:true` means the time cap hit and further browser calls were aborted mid-flow. Page
  state is unknown, so re-orient before continuing, and never blind-rerun a script whose committed
  half (a submit) may already have executed. A strict-mode throw is your locator, not the page:
  refine it.
- Navigation seems stuck: a client-side route may have changed without a full load. Check
  `page.url()` in a `run`, or `wait_for {urlIncludes}`.
- A click did nothing: check its receipt first. `intercepted` names the overlay that swallowed it;
  `landedOn` names what it reached. Clear the blocker, then retry. Don't retry the same failing
  selector without re-observing.
- A coordinate click landed in the wrong place: you almost certainly sent an image pixel without
  `space:"image"`. Check `scale` in the screenshot metadata; at 0.62 a click lands about 1.6× short.
  `probe_point {…, annotate:true}` shows exactly where the point is.
- Debugger detached: if DevTools was opened on the tab, the tab crashed or the banner was
  cancelled, `tab_claim` the tab again to re-attach. If it keeps detaching, the user likely has
  DevTools open; ask them to close it.
- Ambiguous outcome (blank page, stuck spinner, closed popup, timeout right after a state-changing
  action, especially after a sign-in) is unknown, not success or failure. Re-observe before
  deciding, and don't blind-retry a destructive action. A read with very few elements or no
  accessible names right after a navigation is still loading; read again after a beat before
  concluding it's empty.
- Screenshot blank or stale on a background tab: `tab_activate` it briefly, or rely on
  `read_page` / `domSnapshot` for ground truth.
- Iframes: `read_page`, `find`, `run` locators and `domSnapshot` reach into same-site and
  cross-origin frames (cross-origin elements are tagged `frame:true`; clicks are translated through
  the frame chain), so payment widgets (Stripe), auth frames and embedded editors are reachable.
  `dom_query` stays top-document only. A just-loaded frame may lag one read; `wait_for` or read
  again.

---

## 12. Raw CDP

`cdp {tabId, method, params, world?}` sends any Chrome DevTools Protocol command to a controlled
tab, for anything the high-level tools and `run` don't cover. Prefer `run`/`page.evaluate` for
reads, the dedicated tools for dialogs, uploads and screenshots (raw `Page.captureScreenshot`
returns an unusable base64 string), and the `navigate` tool over raw `Page.navigate` (which reloads
even when already on the URL, wiping in-progress input).

Use it for DOM node operations (`DOM.getDocument {depth:-1}`, `DOM.querySelector`), chorded mouse
gestures or pointer types `click` doesn't expose, or a domain not otherwise surfaced.
`Page`, `DOM`, `Accessibility`, `Network` and `Log` are enabled on claim. `Runtime` is deliberately
not (it is the most detectable domain): `Runtime.evaluate` still works and runs in the bridge's
isolated world; pass `world:"page"` to reach page globals. Enable any other domain first.

Events are buffered, not streamed. `read_console` and `read_network` are the digests for the two
you usually want; `cdp_events` reads the rest (lifecycle, CSS, Animation, a domain you enabled
yourself). To attribute events to an action, read once for the `cursor`, act, then read again with
`afterSequence:<cursor>`; that returns exactly what your action caused. Filter with
`methods:[…]`, keep paging while `hasMore`, and treat `truncated:true` as older events aged out.
