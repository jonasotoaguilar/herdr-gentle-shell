# Issues viewer — widened list and fresh pages (S3, S5, D1, D3)

The Issues overlay (`lib/issues-view.js`) lists issue **titles only** in a pane
that takes about **half** the inner width, wrapped over as many rows as each
title needs, and reads its rows through a **server-page seam** instead of a
session-accumulated list. Capacity follows the real viewport, so nothing is
capped at 20 (or any other fixed count).

## Left pane and rows

- Width: `lib/view-layout.js` `paneWidths(innerWidth(w)).left` — the same rule
  the issues and ODD readers use. The old 34/36-column cap is gone.
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
loadIssuePage({ bucketId, cursor, limit, query }) =>
  { ok: true, issues, total, hasNextPage }   // every issue carries its `cursor`
  // or { ok: false, error: 'gh issue list failed: …' }
```

`query` is the reader's typed search (empty when the search row is blank); the
host decides what it means, if anything. `total` is the source's own count and
`hasNextPage` is the source's own answer, so the view never derives either from
a page length.

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
   - **Rows answer exactly one query.** A read that fails for a query the held
     rows do not answer (a typed search) drops those rows **and** the bucket's
     count, so the tab falls back to the unknown marker `–` and the frame shows
     the failure instead of the previous query's list. Nothing from another
     query is ever read as this query's result.
   - **A failed continuation or refresh keeps its own rows.** An append page and
     an `r` re-read ask for the *same* query the rows on screen already answer,
     so their failure is reported on the note row (`502: bad gateway`, …) while
     the rows, the focused row, the preview and the count stay exactly as they
     were. A failed append is never shown as the end of the list, and a bucket
     with no rows at all keeps asking nothing.
   - **A clear is per bucket.** A failure on one tab never touches another tab's
     rows; that tab reports (or recovers from) its own read.
   - **A pending search claims no result.** While a typed search is inside its
     debounce window and the bucket has no rows yet, the reading pane says
     `loading issues…` rather than claiming an empty match.

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
  `assigned`, `involved` and `all`, so the tabs exist before any row does;
- `loadIssuePage({ bucketId, cursor, limit, query })` — an adapter over the real
  client, scoped to this checkout's `cwd`, that picks the source by bucket and
  by whether the reader typed a query:

  ```text
  mine      author:@me sort:updated-desc                  search API
  assigned  assignee:@me sort:updated-desc                search API
  involved  involves:@me -author:@me sort:updated-desc    search API
  all       (no reader query)                             repository issue connection
  all       sort:updated-desc <typed query>               search API
  ```

  `mine`, `assigned` and `involved` are searches, and so is **any** typed query
  in the search row — including one typed on the All tab — because the search
  API is the only source that takes search text.

  **All with an empty query** is the exception (T2/S2): it reads the
  repository's own issue connection through
  `gh.getIssueConnectionPage({ after, first }, { cwd })` instead of the search
  API. The bucket's builtin ordering (`sort:updated-desc`) is *not* forwarded;
  the connection query carries `orderBy: {field: UPDATED_AT, direction: DESC}`
  and `states: [OPEN]` itself, and it accepts no search text at all. The
  connection returns the same page shape (`{ ok, issues, total, hasNextPage }`
  with a `cursor` per row), so the reader is unchanged: it still continues after
  the last row it showed, keeps its own page starts per bucket and paints only
  the newest answer.

  For a search bucket the cursor and limit pass through unchanged, `first` is
  the view's row budget (clamped to `1..1000`), and every request runs with this
  checkout's `cwd`. An unknown bucket id is an explicit
  `{ ok: false, error: 'unknown issues bucket "…"' }` and never reaches a
  subprocess.

`r` re-reads the current page and its preview through the same seam: on the All
tab that is a new connection read, never a cached list. The cached
`loadPages({ state })` loader is **not** passed beside it: the seam takes
precedence, so no accumulated bucket list can answer a fresh read. That loader
still serves the headless notice, and `actions.reload` remains for the
static/`loadPages` fallback. The authoritative open snapshot the worktree
assignment guards read is still primed at session start; only the viewer's own
bucket priming is gone.

## Why the two sources differ (limits)

GitHub refuses to page a **search** result set past **1000 matches**: the
search connection reports the larger `issueCount` and stops, so a further page
would either repeat or lie. The client therefore fails an over-cap search with
`GitHub issue search exceeds 1000 matches; narrow the filter` and the view
renders that failure — it never presents a capped result as the whole dataset.
That is what a typed query can reach, on any bucket.

The repository's `issues` connection has no such ceiling: it is cursor-paged to
its end and reports an exact `totalCount`, which is why the unfiltered All tab
uses it. A repository with more open issues than one page can therefore be
browsed completely, and a count taken from a partial walk is shown as a lower
bound (`N+`) exactly like any other truncated page.

Two further cautions belong to the client, not the view: `totalCount` is the
server's count **at request time**, so a cursor walk is not a snapshot and
concurrent updates can shift what it sees; and a failed continuation page is a
failure, never a short page a caller could read as the end of the list. On the
reader's side that failed continuation keeps the rows it already showed (rule 6
above): it is reported on the note row, and only a read that was asked for a
**different** query can drop rows — never a continuation of the query on screen.
A typed query is the case that reaches the 1000-match refusal, on any bucket
including All, and the reader answers it by painting the failure with no rows
and an unknown `–` count instead of the rows its previous read returned.

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
