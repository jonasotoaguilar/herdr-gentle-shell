# Issues viewer — widened list and fresh pages (S3, S5, D1, D3)

The Issues overlay (`lib/issues-view.js`) lists issue **titles only** in a pane
that takes about **half** the inner width, wrapped over as many rows as each
title needs, and reads its rows through a **server-page seam** instead of a
session-accumulated list. Capacity follows the real viewport, so nothing is
capped at 20 (or any other fixed count).

## Left pane and rows

- Width: `lib/view-layout.js` `paneWidths(innerWidth(w)).left` — the same rule
  the worktree detail and ODD readers use. The old 34/36-column cap is gone.
- Each row is the title alone. The issue **number stays in the preview** on the
  right; it is not part of the left list.
- A title too long for the pane wraps (`view-layout.wrapLabel`) onto the next
  row instead of being truncated. Words wider than the pane are hard-broken, so
  no title is ever cut to fit a row budget.
- The focused row is marked with `▸ ` on its first row only.

## Page capacity

Capacity is derived on every render from the wrapped row heights against the
body budget:

```text
bodyRows   = rowsAvailable() - 6     // frame, search row, tabs, note, footer, rule
itemBudget = bodyRows - 1            // the list's own "page N" marker row
```

An item is never split across pages; an item taller than the budget still gets
its own page. No fixed item count is stored in view state.

## The `loadIssuePage` seam

Optional. When it is present the view asks the host for one page at a time:

```js
loadIssuePage({ bucketId, cursor, limit }) =>
  { ok: true, issues, total, hasNextPage }   // every issue carries its `cursor`
  // or { ok: false, error: 'gh issue list failed: …' }
```

- `bucketId` — the tab's bucket (`mine` / `assigned` / `involved` by default,
  or the ids of the `pages` metadata the caller passes).
- `cursor` — `null` for the first page, otherwise the `cursor` of an issue.
- `limit` — an **upper bound in body rows** (the item budget above), never a
  fixed issue count.

Rules the view enforces:

1. **Fresh reads.** Mount, every arrow move, `r` refresh and every bucket
   switch issue a new request. Nothing is served from an accumulated session
   list, so an edited issue or a new comment cannot hide behind a cache.
2. **Last SHOWN row.** The next page starts after the `cursor` of the last row
   the pane actually painted. Rows that were fetched but did not fit the
   budget are re-read from their own cursor, never skipped silently.
3. **Per-bucket page starts.** Each bucket records the start cursor of every
   page it has visited, so `left` is a real request for that page rather than a
   cached list, and each tab keeps its own position.
4. **Resize resets boundaries.** A width or height change drops every recorded
   start cursor and returns the active bucket to its first page.
5. **Stale answers never paint.** Every request carries a monotonic generation
   and only the newest answer for a bucket may be applied, so a slow earlier
   answer cannot overwrite the page the reader moved to.
6. **Truthful states.** While a page is in flight the note row says `loading…`
   (or `loading issues…` on a first paint); a failure renders
   `failed to load issues: <reason>` and paints no fake rows.

## Keys (D3)

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | select the next / previous bucket |
| `←` / `→`, `[` / `]` | previous / next page of the ACTIVE list |
| `↑` / `↓`, `j` / `k` | move the selection inside the visible page |
| `home` / `end` | first / last row of the visible page |
| `r` | re-read the current page (and the preview) |

## Fallback contracts

`loadIssuePage` is preferred. When it is absent the previous contracts keep
working unchanged: eager `options.pages` / `options.issues` fixtures and the
`loadPages({state})` loader. Those paths use the same widened, wrapped left
list and the same derived capacity, and page through the rows they already
hold.

## How the command wires the seam (extension)

`/herdr-gentle:issues` mounts the overlay **before** any GitHub read: it does
not prime a bucket, merge the session snapshot or fetch a page first, so the
first frame is a truthful `loading…` rather than a wait. The command passes:

- `pages` — metadata only (`{ id, label, issues: null }`) for `mine`,
  `assigned` and `involved`, so the tabs exist before any row does;
- `loadIssuePage({ bucketId, cursor, limit })` — an adapter over the real
  client call `gh.getIssuePage({ query, after, first }, { cwd: checkoutRoot })`.
  The bucket id selects the **exact** source query and nothing else:

  ```text
  mine      author:@me sort:updated-desc
  assigned  assignee:@me sort:updated-desc
  involved  involves:@me -author:@me sort:updated-desc
  ```

  The cursor is passed through unchanged, `first` is the view's row budget
  (clamped to the client's `1..1000`), and every request runs with this
  checkout's `cwd`. An unknown bucket id is an explicit
  `{ ok: false, error: 'unknown issues bucket "…"' }` and never reaches a
  subprocess.

`r` re-reads the current page and its preview through the same seam. The
cached `loadPages({ state })` loader is **not** passed beside it: the seam
takes precedence, so no accumulated bucket list can answer a fresh read.
That loader still serves the headless notice, and `actions.reload` remains for
the static/`loadPages` fallback. The authoritative open snapshot the worktree
assignment guards read is still primed at session start; only the viewer's own
bucket priming is gone.

## Assignment evidence versus the reader's page

The assignment margin is a **separate** read, never a second source for the
list. After the overlay has mounted — the factory has already produced the
first `loading…` frame — the command starts one
`refreshIssuesCache(repoRoot)` over the shared open-issue cache, which lists at
most the newest 20 issues in any state (`gh issue list --state all --limit 20`).
Two rules keep the two reads apart:

- the margin's rows are **never** handed to the viewer; the list on screen is
always the fresh `getIssuePage` result for the requested bucket and cursor;
- `executeIssues` settles the refresh in a `finally` before returning, so even
  an overlay closed immediately leaves the latest closure evidence for the next
  assignment check, and a rejected read is reported by the surfaces that need
  it instead of purging a stored assignment.

The headless (no `ctx.ui.custom`) path is unchanged: it refreshes and merges the
cached pages it still has to report a total, because it has no fresh page seam.
