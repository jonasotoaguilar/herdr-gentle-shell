# Issues viewer (`/herdr-gentle:issues`)

Full-screen three-page overlay over the current checkout's repository
GitHub issues: the left pane lists the issues, the right pane shows the
selected issue in full (labels, state, author, dates, reactions, separated
comments) with its own scroll. Each list row also marks whether that issue
is assigned to the checkout the session runs in; `space` toggles the
assignment locally and `ctrl+s` saves it through the worktree registry.
`Esc` closes.

## What it shows

The list shows the repository's issues fetched through `gh` (`author:@me`
for My issues, `assignee:@me` for Assigned, and `involves:@me -author:@me`
for Involved). The frame reads top to bottom: the concise header, then the
dedicated search/filter row (`› Search (T)`, showing the live query while
typing and the kept query after leaving), then the bucket tabs with their
counts, then the filter/notice row (`f:open` or `f:closed`, followed by any
error or notice), and finally the list with its totals line
(`page n/m · N issues`). The three tabs are disjoint by design: an issue
the viewer both authored and commented on belongs to My issues only, never
to Involved; Assigned keeps its own meaning and may overlap either.
Typing filters live: author `@user`, `#number`, title words.

Only open issues show by default, and every tab count names the rows the
current filter actually lists — closed issues never inflate an open list.
`f` alternates between the two states, open-only and closed-only; there is
no combined "all" view (the footer legend and the hint above the list both
name it: the row reads `f:open` / `f:closed`).
Each row shows the issue number and title. While a page is being fetched
the view says `loading issues…` instead of claiming an empty list.

The right pane shows the selected issue: number and title, state, labels,
author, created and updated time, `👍` reactions, comment count, the body,
then each comment separated by its author and time. The body and the
comments render as plain wrapped text, never as styled markdown. Moving
the selection resets the scroll to the top of that issue.

Every list row carries its assignment mark:

| Mark | Meaning |
| --- | --- |
| `✓` | assigned to this checkout and stored |
| `·` | not assigned |
| `✎` | changed but unsaved — differs from the stored assignment |

These marks, the `space assign · ctrl+s save` legend on the filter/notice
row and the `· unsaved` header claim belong to the worktree-tools
association. When that association is off (fresh mode, or a malformed
association), the marks and the legend are absent, `space` and `ctrl+s` do
nothing at all — no save is attempted — and stored associations are simply
not shown. Reading, search, the open/closed toggle, labels, comments,
close/reopen and opening in the browser are unchanged in that mode.

The frame header stays short and carries only what the panes do not already
show: the surface and the active bucket (`◈ Issues · My issues`), plus
`· unsaved` while any toggle is pending. It never repeats the
branch/worktree — the session already sits in that checkout. There is no
`esc` text in the top-right corner: the footer legend names the key and the
right border runs unbroken to the terminal's last cell.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | move the selection in the list |
| `tab` / `→`, `shift+tab` / `←` | next / previous page (My issues, Assigned, Involved — the `stats-view` convention) |
| `ctrl+j`/`ctrl+k`, `pgDn`/`pgUp` | scroll the issue pane |
| `home`/`end` | first / last issue in the current page |
| `[` / `]` | previous / next list page, with the totals line showing `page n/m · N issues` |
| `T` (also `/`) | open the search row directly below the header; typing filters live (author `@user`, `#number`, title words); `Enter`/`Esc` leave the row keeping the filter, which stays visible in it |
| `f` | toggle between the two states, open-only <-> closed-only (S4/S18); the tab counts follow it |
| `space` | toggle "assigned to this checkout" (S5), applied only on save; only while the worktree-tools association is available |
| `ctrl+s` | save the pending assignment through the worktree registry `issues[]`, exactly the odd viewer's path and guards; only while the association is available |
| `L` | open the label editor (S3) |
| `n` | create a new label inside the label editor |
| `c` | open the comment input (S7) |
| `x` / `X` | close / reopen the issue (S4), after the host's own confirm |
| `o` | open the issue in the browser (S5) |
| `r` | reload the current page from `gh` |
| `esc`/`ctrl+c`/`q` | close (discarding unsaved toggles, like the odd viewer) |

There is no `?` key-help overlay: the footer shortcut legend is the only
key reference, and every shortcut it names stays on screen.

Reserved keys this view must not steal: `ctrl+c`, `ctrl+u`, `ctrl+d`, `alt+*` shortcuts registered elsewhere.

The label editor lists every repository label with a toggle plus a final
`create new…` row: `space` toggles, `n` jumps to create-new, `ctrl+s`
applies, `esc` leaves without applying. The labels are fetched on the
editor's first use, never while the list is opening: the editor shows
`loading labels…` until they arrive, and a failed fetch is named and
retried the next time it opens. The comment input takes multiple
lines: `Enter` inserts a newline, `ctrl+s` posts, `esc` discards. The
issue pane scrolls independently of the list.

## The `gh` requirement and the startup gate

The view needs the `gh` CLI plus an authenticated user. Both are checked
once at session start: only then is `/herdr-gentle:issues` registered.
Without `gh`, or without a login, the command stays unregistered and one
notification per session names what is missing and the command that fixes
it (`install it (https://cli.github.com) and run `gh auth login`` for a
missing binary, otherwise `gh`'s own `gh auth login` wording). Nothing in
this view runs `gh` through a shell, echoes a token, or writes user
config.

## What writes (four actions, each behind its explicit key)

Listing, search, paging, filtering, scrolling, opening and reloading
never write anything. Only these four actions write, each after an explicit key, each
reported honestly — a failed action leaves the local state unchanged and
shows the error; nothing claims success:

| Key | Write | What it does |
| --- | --- | --- |
| `ctrl+s` (list) | assignment save | persists the whole pending set as this checkout's `issues[]` through the worktree registry, replacing the stored set exactly like the odd viewer's save |
| `ctrl+s` (label editor) | label edit | creates each new name first through `gh label create`, then applies the whole add/remove delta through `gh issue edit --add-label/--remove-label` |
| `ctrl+s` (comment input) | comment | posts the draft through `gh issue comment` |
| `Enter` (confirm) | state change | closes (`x`) or reopens (`X`) the issue through `gh issue close`/`gh issue reopen` after the host's own confirm |

`o` opens `gh issue view <n> --web` through the fixed-argv runner and
changes nothing; `esc` always discards.

## States

- **Not in a Git checkout:** the command notifies and opens nothing.
- **Empty page:** the view answers with the empty state (`no issues`),
  never fake rows.
- **Unreadable issue:** the issue's own error line renders in the right
  pane; the list stays usable.
- **Failed load:** a page that `gh` could not list renders an empty page
  plus the error (`failed to load issues: …`); a partial failure keeps the
  pages that did arrive and names the failure above the list.
- **Loading:** the overlay opens at once and paints `loading issues…`
  while the pages are in flight. A slow answer can never overwrite a
  newer one: the viewer keeps only the answer to its latest request, and a
  closed view paints nothing.
- **Worktree tools off:** the command still opens and stays readable, but the
  assignment interaction is gone as described above (no marks, no legend, no
  `· unsaved`, no save callback).
- **Unreadable assignment:** the stored `issues[]` loads fail-soft — the
  view opens with nothing marked and stays usable; the failure is reported
  only if a save is attempted, and a refusing registry is left untouched.
- **`gh` unavailable:** the gated command is never registered, and the
  view's own `gh unavailable` state names the install plus login fix.
- **No TUI overlay:** when the TUI helpers cannot be loaded, the command
  falls back to one muted line naming the issue count across the pages.

## Limits

The list total is a bounded count: when the fetch bound is reached the
totals line renders it as `N+` and the tab marks it the same way (a lower
bound, not the exact total). Scope
is the current checkout only — the session's cwd resolved to its Git root,
and the assignment marks belong to the checkout the session runs in. The
issue body and the comments show as plain wrapped text (no markdown
styling).
