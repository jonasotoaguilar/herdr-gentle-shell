# Issues viewer (`/herdr-gentle:issues`)

Full-screen three-page overlay over the current checkout's repository
GitHub issues: the left pane lists the issues, the right pane shows the
selected issue in full (labels, state, author, dates, reactions, separated
comments) with its own scroll. The viewer is read-only about the checkout's
worktree association: it never marks, toggles or saves which issue belongs
to a worktree — that association lives in the worktree detail (S10b).
`Esc` closes.

## What it shows

The list shows the repository's issues fetched through `gh` (`author:@me`
for My issues, `assignee:@me` for Assigned, and `involves:@me -author:@me`
for Involved). The frame reads top to bottom: the concise header, then the
dedicated search/filter row (`› Search (T)`, showing the live query while
typing and the kept query after leaving), then the bucket tabs with their
counts, then a notice row (errors and copy notices only, blank when there is
nothing to say), and finally the list with its page footer (`page n/m`).
The three tabs are disjoint by design: an issue
the viewer both authored and commented on belongs to My issues only, never
to Involved; Assigned keeps its own meaning and may overlap either.
Typing filters live: author `@user`, `#number`, title words.

Only open issues are listed (S10a): the state toggle is gone, no other state
is ever requested, and a page that arrives carrying a closed row counts only
its open rows — a closed issue never inflates a tab count or the page footer.
Each row shows the issue number and title. While a page is being fetched
the view says `loading issues…` instead of claiming an empty list.
Closing the focused issue removes it from the list at once, because the list
only ever shows open issues.

The right pane shows the selected issue: number and title, state, labels,
author, created and updated time, `👍` reactions, comment count, the body,
then each comment separated by its author and time. The body and the
comments render as plain wrapped text, never as styled markdown. Moving
the selection resets the scroll to the top of that issue.

Rows carry no association mark and the notice row carries no
assignment hint: the viewer never claims which issue belongs to the
checkout's worktree (S10b). Reading, search, labels, comments, closing and
opening in the browser all work as before; the checkout↔issue association
lives in the worktree detail.

The frame header stays short and carries only the surface (`◈ Issues`): the
active bucket is named and marked by its own tab, and the header repeats
neither it nor the branch/worktree — the session already sits in that
checkout. There is no `esc` text in the top-right corner: the footer legend
names the key and the right border runs unbroken to the terminal's last cell.
Each hint is named once: `T` belongs to the search row, the issue total to
the tab, and while the search box holds the keyboard the footer names that
interaction's keys (`type to filter · bksp edit · enter/esc keep`) instead of
repeating them beside the query or naming the list keys.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | move the selection in the list |
| `tab` / `→`, `shift+tab` / `←` | next / previous page (My issues, Assigned, Involved — the `stats-view` convention) |
| `ctrl+j`/`ctrl+k`, `pgDn`/`pgUp` | scroll the issue pane |
| `home`/`end` | first / last issue in the current page |
| `[` / `]` | previous / next list page, with the page footer showing `page n/m` |
| `T` (also `/`) | open the search row directly below the header; typing filters live (author `@user`, `#number`, title words); `Enter`/`Esc` leave the row keeping the filter, which stays visible in it |
| `L` | open the label editor (S3) |
| `n` | create a new label inside the label editor |
| `c` | open the comment input (S7) |
| `x` / `X` | close the focused issue (S4/S10a), after the host's own confirm; it leaves the open list at once |
| `o` | open the issue in the browser (S5) |
| `r` | reload the current page from `gh` |
| `esc`/`ctrl+c`/`q` | close |

There is no `?` key-help overlay: the footer shortcut legend is the only
key reference, and every shortcut it names stays on screen. It is also the
legend of the interaction in progress — the search keys while the search box
is open, the list keys otherwise — on ONE row.

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

The view needs the `gh` CLI plus an authenticated user. The command itself
is always registered, so it always appears in the command list; the check
gates the INVOCATION, not the registration. Both are verified once at
session start, and again when the command runs: without `gh`, or without a
login, one notification per session names what is missing and the command
that fixes it (`install it (https://cli.github.com) and run `gh auth
login`` for a missing binary, otherwise `gh`'s own `gh auth login` wording)
and the view does not open. The note says the command cannot open until
then — never that it is unregistered, because it always is. Nothing in this
view runs `gh` through a shell, echoes a token, or writes user config.

## What writes (three actions, each behind its explicit key)

Listing, search, paging, filtering, scrolling, opening and reloading
never write anything. Only these three actions write, each after an explicit key, each
reported honestly — a failed action leaves the local state unchanged and
shows the error; nothing claims success:

| Key | Write | What it does |
| --- | --- | --- |
| `ctrl+s` (label editor) | label edit | creates each new name first through `gh label create`, then applies the whole add/remove delta through `gh issue edit --add-label/--remove-label` |
| `ctrl+s` (comment input) | comment | posts the draft through `gh issue comment` |
| `Enter` (confirm) | state change | closes the focused issue (`x` or `X`) through `gh issue close` after the host's own confirm |

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
- **Read-only association (S10b):** the view never marks, toggles or saves
  which issue belongs to the checkout's worktree. A malformed or unreadable
  worktree registry therefore changes nothing here: the command opens and
  stays fully usable.
- **`gh` unavailable:** the command stays registered and stays in the
  command list, but it refuses to open, names the install plus login fix,
  and the view's own `gh unavailable` state says the same thing.
- **No TUI overlay:** when the TUI helpers cannot be loaded, the command
  falls back to one muted line naming the issue count across the pages.

## Limits

The list total is a bounded count: when the fetch bound is reached the tab
renders it as `N+` (a lower bound, not the exact total); the page footer
names only the page position. Scope is the current checkout only — the
session's cwd resolved to its Git root. The issue body and the comments
show as plain wrapped text (no markdown styling).
