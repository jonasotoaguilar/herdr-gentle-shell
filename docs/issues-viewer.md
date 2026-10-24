# Issues viewer (`/herdr-gentle:issues`)

Full-screen four-tab overlay over the current checkout's repository
GitHub issues: the left pane lists the issues, the right pane shows the
selected issue in full (labels, state, author, dates, reactions, separated
comments) with its own scroll. The viewer is read-only about the checkout's
worktree association: it never marks, toggles or saves which issue belongs
to a worktree — that association lives in the worktree detail (S10b).
`Esc` closes.

## What it shows

The list shows the repository's issues fetched through `gh` (`author:@me`
for My issues, `assignee:@me` for Assigned, and `involves:@me -author:@me`
for Involved). The fourth tab, All, lists every open issue in the repository,
not just those involving you; it does not deduplicate against the other tabs. The frame reads top to bottom: the concise header, then the
dedicated search/filter row (`› Search (T)`, showing the live query while
typing and the kept query after leaving), then the bucket tabs with their
counts, then a notice row (errors and copy notices only, blank when there is
nothing to say), and finally the list. `page n/m` is fixed beside Search,
even for empty or single-page results, and never consumes a list row.
An issue authored by you is excluded from Involved; Assigned may overlap
My issues or Involved, and All may overlap every scoped tab. The list and
preview use the shared 40/60 split and titles wrap in full.

Typing sends a debounced GitHub search over the complete active bucket,
not just the loaded page: title words and qualifiers such as `label:bug`
work before every page is fetched. A settled query resets its page cursor;
a stale response cannot overwrite a newer query. Already loaded tabs reuse
their rows and position immediately. `r` explicitly refreshes the current
page, while successful writes invalidate affected cached pages.

Only open issues are listed (S10a): the state toggle is gone, no other state
is ever requested, and a page that arrives carrying a closed row counts only
its open rows — a closed issue never inflates a tab count or page marker.
Each row shows the issue number and title. While a page is being fetched
the view says `loading issues…` instead of claiming an empty list.
Closing the focused issue removes it from the list at once, because the list
only ever shows open issues.

The right pane shows the selected issue: number and title, state, labels,
author, created and updated time, `👍` reactions, comment count, the body,
then each comment separated by its author and time. The body and the
comments render as complete plain wrapped text, never as styled markdown or
silently capped snippets. This is the same formatter as worktree detail,
including assignees, projects and linked-PR count. Moving
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
| `tab`, `shift+tab` | next / previous bucket (My issues, Assigned, Involved, All) |
| `ctrl+shift+j/k` when negotiated; `Shift+J/K` fallback; `PgDn`/`PgUp` always | page the issue preview |
| `ctrl+d`/`ctrl+u` | half-page the preview |
| `home`/`end` | first / last issue in the current page |
| `←` / `→`, `[` / `]` | previous / next list page; `page n/m` stays beside Search |
| `T` (also `/`) | open the search row directly below the header; typing searches the complete active bucket through GitHub; `Enter`/`Esc` leave the row keeping the filter, which stays visible in it |
| `L` | open the label editor (S3) |
| `n` | create a new label inside the label editor |
| `a` | open the assignee editor when its permission is confirmed |
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
applies, `esc` leaves without applying (an editor cancel writes nothing).
The assignee editor is the same toggle shape over the assignable users plus
any current assignee: `space` toggles and `ctrl+s` applies the add/remove
delta; `esc` leaves without applying. The labels are fetched on the
editor's first use, never while the list is opening: the editor shows
`loading labels…` until they arrive, and a failed fetch is named and
retried the next time it opens. The comment input takes multiple
lines: `Enter` inserts a newline, `ctrl+s` posts, and `esc` on a NON-EMPTY
draft asks once before discarding (`y` discards, `n`/`esc` keep editing); an
empty draft leaves at once. The issue pane scrolls independently of the list.
The insertion point has a
visible caret. Submitting any write paints its saving state before invoking
the action, then locks keys until completion; failure keeps the draft and
releases the keyboard. Preview keys are plugin bindings, not Pi defaults:
the legend uses confirmed extended-protocol capability, never the OS.
Bare LF/CR and legacy Ctrl+J/K are not preview-scroll aliases.

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

## What writes (four actions, each behind its explicit key)

Listing, search, paging, filtering, scrolling, opening and reloading
never write anything. Only these four actions write, each after an explicit key, each
reported honestly — a failed action leaves the local state unchanged and
shows the error; nothing claims success:

| Key | Write | What it does |
| --- | --- | --- |
| `ctrl+s` (label editor) | label edit | creates each new name first through `gh label create`, then applies the whole add/remove delta through `gh issue edit --add-label/--remove-label` |
| `ctrl+s` (assignee editor, when permitted) | assignee edit | sends only the add/remove delta of GitHub logins through `gh issue edit --add-assignee/--remove-assignee`, after the repository permission is re-checked |
| `ctrl+s` (comment input) | comment | posts the draft through `gh issue comment` |
| `Enter` (confirm) | state change | closes the focused issue (`x` or `X`) through `gh issue close` after the host's own confirm |

`o` opens `gh issue view <n> --web` through the fixed-argv runner and
changes nothing. Leaving an editor without saving is local only: `esc` on
the label or assignee editor drops the draft and writes nothing, while `esc`
on a nonempty comment draft asks before discarding.

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

GitHub search cannot enumerate more than 1000 matches. The server path names
that limit and asks you to narrow the filter instead of silently treating a
partial result as complete. A bounded eager source may show `N+` as a lower
bound; the page marker names only the page position. Scope is the current checkout only — the
session's cwd resolved to its Git root. The issue body and the comments
show as plain wrapped text (no markdown styling).
