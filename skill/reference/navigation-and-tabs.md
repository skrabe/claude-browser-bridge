# Navigation & tabs

## Navigating
- **`navigate`** goes to a URL in a controlled tab; it **skips the load if already on that URL**
  (a reload can destroy in-progress input). Use **`reload`** when you truly need a refresh (e.g.,
  after a local dev rebuild).
- For a read-only lookup, one focused direct nav to the obvious result or a parameterized search
  URL (e.g. `?q=…`) is fine and often better than clicking through filters.
- **`go_back`** / **`go_forward`** move through the tab's history without retyping URLs.

## Claiming vs creating
- **Claim, don't spawn.** `tabs_list` → if the page you need is already open, `tab_claim` it
  **in place** (keeps its logged-in session, doesn't move it). Only `tab_create` when nothing
  suitable exists.
- Never guess a tabId — only use ids from the current `tabs_list`.
- `tab_activate` brings a tab to the front (only when the user should watch — otherwise work in
  the background).
- **Several sources at once?** `tab_create` one background tab per URL instead of walking the
  user's current tab through each URL in turn — faster, and it leaves whatever they had open alone.
- **Group the tabs you open by topic.** Pass `tab_create` a `group:"<topic>"` (a short task name)
  so the tabs you spawn land in one labeled tab group instead of scattering across the user's
  window — it reuses an existing group of that name, or starts one. Keeps their workspace tidy and
  makes cleanup obvious.

## Lifecycle — leave the workspace tidy
- **Close by default.** Once you've gotten what you need from a tab, it's done — research, search,
  and intermediate tabs don't earn a spot just because they helped you answer. Keep one open only
  for a stated reason (below).
- Tabs **you created** are yours to clean up; **`tab_close`** them when done (it only closes tabs
  the agent opened, never the user's) — unless the tab *is* a deliverable the user asked to keep
  open (a created doc, a checkout, a dashboard).
- Tabs **you claimed** from the user: `tab_release` hands control back and **leaves them open**.
  Never close a user's own tab.
- If work must continue on a page in a later turn (awaiting login/approval/payment), leave it and
  say so — don't tear it down.

## Multi-window
- `tabs_list` spans all windows (each tab carries its `windowId` and, if any, `tabGroup`). Use
  the window/group to disambiguate which of several similar tabs is the right one.

## State across navigation
- After a transition you didn't cause (a redirect after submit, an unexpected reload), re-verify
  fields you filled earlier are still populated before continuing — don't assume they held.
- Before deliberately leaving a page, capture anything a later step needs (a confirmation number,
  the current sort/filter, an extracted value) — going back may not reproduce the same state.
