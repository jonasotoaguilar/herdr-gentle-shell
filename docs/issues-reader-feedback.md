# Issues reader — footer-only keys, no Copy, fresh comment, metadata (S4, S6, S7, S9, S10)

User feedback on the Issues overlay (`lib/issues-view.js`) after the paging work.
The list and preview frames are unchanged: this round only removes the Copy
feature, moves every shortcut hint into the footer, clears the search with
Delete, refreshes the preview after a posted comment, and shows the metadata an
issue actually has.

## Shortcut hints live in the footer only (S4)

- The search row carries the widget and the live query alone: `› Search`, or
  `› <query>█` while typing. No `(T)` and no `(T to edit)` appears above the
  footer.
- `T search` is a footer token like every other shortcut; the footer stays one
  terminal row and compacts to short tokens before it drops anything.
- While the search input is active the footer names that interaction:
  `type to filter · bksp edit · del clear · enter/esc keep`. The reading legend
  returns when the box closes.

## Search clearing (S4)

- `Delete` clears the **whole** query in one key.
- `Backspace` still deletes a single character.
- `del clear` is advertised only while the input is active, so the reading
  legend never claims a key it does not answer.

## Copy is gone (S7)

- The `y`/`Y` binding, its clipboard seam and the `y/Y copy` footer hint are
  removed. Both keys are inert in reading mode: no clipboard write, no notice,
  no repaint.
- The comment discard ask and the close confirmation keep their own `y` inside
  their own modes; that key is not Copy.

## A posted comment is visible at once (S6)

- A successful comment posts through `actions.postComment`, then invalidates
  the selected detail and reads it again through
  `loadIssue(number, { refresh: true })` — the same path labels and assignees
  already use. Page rows carry no comments, so a cache would hide the result.
- The result is reported truthfully: the notice row says `comment posted`, and
  the refreshed comment appears in the preview.
- A failed refresh paints its own `unreadable: <reason>` in the preview and
  keeps the cached content out of sight. Posting is never rolled back by a
  refresh error and no frame claims updated data it does not have.

## Preview metadata (S9)

- All assigned people render on one `assignees:` row (existing S8 behaviour).
- `projects: <title, …>` renders only when the issue has projects; URLs stay
  internal to the data, the compact preview shows the title.
- `linked PRs: <n>` renders only for a nonzero count.
- Empty relations are omitted. There is no `no projects`, no `0 PR`, and no
  `none` placeholder, and a zero is never read as "unsupported".
- `issue.metadataError` becomes the single status line `metadata unavailable`.
  Scope names and other long reasons stay out of the compact preview.

## `r` refreshes page and preview (S10)

- In server mode `r` re-reads the current page from its recorded start cursor
  and keeps the focused row. The detail is read again with
  `{ refresh: true }` even when the page answer repeats the same issue objects,
  so a new comment or edit is visible without moving the selection.
- The cursor generation guard still drops stale answers, the resize reset still
  rebuilds page starts, and the permission gates on the label/assignee editors
  are untouched.
- Static `pages`/`loadPages` mode remains supported with the same reload path.
