# Interaction loop — observe cheaply, act, verify

The expensive mistake in browser work is over-observing: dumping the page after every action.
Discipline here is the difference between fast/clean and slow/spammy.

## Cheapest state check
After a click / type / navigate, collect the **single cheapest** observation that answers the
*next* question — not a full re-scan:
- Need element ground truth (to build a target)? → `read_page` (structured a11y tree + refs).
- Need to confirm a value or read prose? → `read_text`, or a scoped `dom_query`.
- Need visual layout / a rendered widget / a chart? → `screenshot`.
- **Do not take both `read_page` and `screenshot` by default.** Pick one.

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

## Waiting
- Don't use fixed sleeps as a default wait. After an action, do a concrete state check
  (re-`read_page`, `dom_query` for the expected element, or check the URL via `cdp`).
- Reserve explicit waits/timeouts for known-slow transitions (navigation, async render).
