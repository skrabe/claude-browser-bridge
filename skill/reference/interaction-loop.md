# Interaction loop — observe cheaply, act, verify

The expensive mistake in browser work is over-observing: dumping the page after every action.
Discipline here is the difference between fast/clean and slow/spammy.

## Cheapest state check
After an action, first read its **status header** ({url, title, new console errors/warnings}) —
often that alone answers the next question. Only then take the *single* cheapest read that answers
it (one lens — see `reading-pages.md`; never `read_page` + `screenshot` by default).

## Reuse, don't refetch
- Keep the latest `read_page`/`dom_query` result and reuse it for building targets and retry
  decisions until it proves stale.
- Refetch only after: a navigation, a DOM-changing action, a failed target (0 or >1 matches),
  or a timeout.
- Don't reprint/re-extract the same observation to re-confirm a fact you already have.

## Authoritative-signal stopping
When the page exposes one canonical signal for the fact you need — a URL query param, a success
toast/modal, a checked/selected state, a basket line item, a selected sort — **treat that as the
answer** unless another signal directly contradicts it. Do not keep re-verifying the same fact
through header badges, alternate surfaces, or repeated full-page reads.

## Orientation, then narrowing
- One broad observation to orient (usually one `read_page`, or one `screenshot` if the visual
  structure is clearer than the DOM).
- Then **narrow** to the relevant section or a few strong candidates.
- If you're not getting narrower, don't scale extraction across more elements — **change
  strategy** (different tool, the site's own search, a direct URL).
- If you fall back to a general web search from inside a page, run **one focused query** and open
  the strongest result — don't loop rewriting the query.
- On a freshly loaded/navigated page, check for a blocking modal / cookie banner / overlay as part
  of orienting and dismiss it via its own close/accept control *before* going for the real target
  — don't click the target first and diagnose the failure afterward.
- When a screen needs several actions (a multi-field form) and filling one won't invalidate
  another's ref, resolve **all** the targets from one `read_page`, then fire the actions — don't
  re-observe between each field unless one changes the DOM.

## Stuck detection
Distinct from a single failed action — this is the loop that quietly wastes turns:
- Same URL after 3+ actions with no new element/content = **stuck**, even if each action reported
  success. Change approach, don't push the same sequence further.
- The same action failing repeatedly → change approach, not repeat it. An explicit
  rejection/validation message → change the value or target next attempt, never retry it identical.
- A click that resolves to a unique element but produces no visible change → its status header's
  new-console-error count is the first clue; then suspect a covering overlay/modal/banner (a
  `screenshot` usually shows it); clear that before re-clicking.
- When you do give up on a path, say why in plain terms rather than looping silently.

## Waiting
There is no wait tool. After a slow action, verify with a concrete check — the action's status
header (url/title), a `dom_query` for the expected element, or one re-`read_page` — and space out
re-checks on known-slow transitions instead of hammering.
