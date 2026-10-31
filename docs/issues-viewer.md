# Issues viewer (`/herdr-gentle:issues`)

Full-screen four-tab overlay over the current checkout's repository
GitHub issues: the left pane lists the issues, the right pane shows the
selected issue in full (labels, state, author, dates, reactions, separated
comments) with its own scroll. Worktrees carry no issue association any more
(S1), so the viewer has nothing to mark, toggle or save: no surface assigns an
issue to a worktree.
`Esc` closes.

## What it shows

The list shows the repository's issues fetched through `gh` (`author:@me`
for My issues, `assignee:@me` for Assigned, and `involves:@me -author:@me`
for Involved). The fourth tab, All, lists every open issue in the repository,
not just those involving you; it does not deduplicate against the other tabs.
The scoped tabs and any typed search read GitHub's search API, while the
unfiltered All tab reads the repository's own issue connection, which is the
only source GitHub will page past 1000 matches — so a large repository can be
browsed to its end (see [Limits](#limits)). The frame reads top to bottom: the concise header, then the
dedicated search/filter row (`› Search (T)`, showing the live query while
typing and the kept query after leaving), then the bucket tabs with their
counts, then a notice row (errors and copy notices only, blank when there is
nothing to say), and finally the list. The search row carries the widget alone:
the `page n/m` indicator left with the pager (S3).
An issue authored by you is excluded from Involved; Assigned may overlap
My issues or Involved, and All may overlap every scoped tab. The issues and
ODD readers use the smaller 30% list / 70% reading allocation, and titles wrap
in full.

The list is ONE continuous window, never a pager: `]`/`[` scroll it a
screenful and the focused issue always stays inside the painted window, so
scrolling past its edge slides the list instead of jumping to a page. `tab`,
`shift+tab` and `←`/`→` all switch buckets — the arrows are the tab key, they do
not scroll the list (S10) — and a bucket keeps its own window and focused row, so
returning to it restores the reader's place. Scrolling
to the bottom of the rows loaded so far reads the NEXT cursor page and appends
it below them, so a large bucket keeps going while opening still costs exactly
one page per bucket.

Typing sends a debounced GitHub search over the complete active bucket,
not just the loaded rows: title words and qualifiers such as `label:bug`
work before every page is fetched, and an appended page repeats the same query.
A typed query is a search on every tab, All included; clearing it returns the
All tab to its unfiltered connection read. A settled query reads from the head of its own result set; a stale response
cannot overwrite a newer query. Opening the viewer reads all four tabs once, so
switching between them never fetches again and no tab can show a false `0` for
issues the repository does have; a tab whose read is still in flight shows `–`
instead. Already loaded tabs reuse their rows and position immediately. `r`
explicitly refreshes the active list from the head, while successful writes
invalidate the affected lists.

Only open issues are listed (S10a): the state toggle is gone, no other state
is ever requested, and a page that arrives carrying a closed row counts only
its open rows — a closed issue never inflates a tab count.
Each row shows the issue number and title. While a page is being fetched
the view says `loading issues…` instead of claiming an empty list.
Closing the focused issue removes it from the list at once, because the list
only ever shows open issues.

The right pane shows the selected issue: number and title, state, labels,
author, created and updated time, `👍` reactions, comment count, the body,
then each comment separated by its author and time. The body and the
comments render as complete plain wrapped text, never as styled markdown or
silently capped snippets. This is the shared issue formatter
(`lib/issue-preview.js`), including assignees, projects and linked-PR count.
Moving the selection resets the scroll to the top of that issue.

Rows carry no association mark and the notice row carries no
assignment hint: no surface claims which issue belongs to a checkout any more
(S1), so there is nothing here to show. Reading, search, labels, comments,
closing and opening in the browser all work as before.

The frame header stays short and carries only the surface (`◈ Issues`): the
active bucket is named and marked by its own tab, and the header repeats
neither it nor the branch/worktree — the session already sits in that
checkout. There is no `esc` text in the top-right corner: the footer legend
names the key and the right border runs unbroken to the terminal's last cell.
Each hint is named once: `T` belongs to the search row, the issue total to
the tab, and while the search box holds the keyboard the footer names that
interaction's keys (`type to filter · bksp edit · enter/esc keep`) instead of
repeating them beside the query or naming the list keys.

## Palette

Every token paints through the injected theme with a role that says what it is
(S11), so the header, the search row, the tabs and the footer read as ONE
palette and no view hardcodes a colour:

| Token | Role |
| --- | --- |
| frame title (`◈ Issues`), active tab label, right-pane issue title | `accent` + bold |
| shortcut KEY in the footer (`↑↓`, `tab/←→`, `esc`, …) | `accent` + bold |
| a key's description (`move`, `bucket`, `close`, …) | `muted` |
| tab counts and status words (`(12)`, `loading…`) | `muted` |
| static labels — the `›` prompt and the idle `Search` | `dim` |
| the live search value and its caret | `accent` |
| frame rules and pane divider | `border` |

A key is therefore distinguishable from the words beside it by BOTH colour and
weight, and focus never depends on colour at all: the focused row keeps its `▸`
mark and the active tab its `▸` too, so a monochrome terminal shows the same
information. A missing, partial or throwing theme degrades to plain text rather
than breaking a frame.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | move the selection in the list; the window follows it |
| `tab`, `shift+tab`, `←` / `→` | next / previous bucket (My issues, Assigned, Involved, All) |
| `ctrl+shift+j/k` when negotiated; `Shift+J/K` fallback; `PgDn`/`PgUp` always | page the issue preview (the footer names this target once, as `ctrl+shift+j/k doc` or `shift+j/k doc`) |
| `ctrl+d`/`ctrl+u` | half-page the preview |
| `home`/`end` | first / last loaded issue (the last one asks for the next page) |
| `]` / `[` | scroll the list one screenful (no pages: the window just moves, and reaching its end reads the next page); the footer token reads `]/[ list` |
| `T` (also `/`) | open the search row directly below the header; typing searches the complete active bucket through GitHub; `Enter`/`Esc` leave the row keeping the filter, which stays visible in it |
| `L` | open the label editor (S3) |
| `n` | create a new label inside the label editor |
| `a` | open the assignee editor when its permission is confirmed |
| `c` | open the comment input (S7) |
| `x` / `X` | close the focused issue (S4/S10a), after the host's own confirm; it leaves the open list at once |
| `o` | open the issue in the browser (S5) |
| `r` | reload the active list from the head |
| `esc`/`ctrl+c`/`q` | close |

There is no `?` key-help overlay: the footer shortcut legend is the only
key reference, and every shortcut it names stays on screen. It is also the
legend of the interaction in progress — the search keys while the search box
is open, the list keys otherwise — on ONE row.

The legend spends ONE token per scroll target rather than repeating every
alias: `ctrl+shift+j/k doc` (or `shift+j/k doc` when the host does not confirm
the extended protocol) for the preview and `]/[ list` for the list, so the two
targets stay distinguishable at a glance. The alternates — `Shift+J/K`,
`PgDn`/`PgUp`, `ctrl+d`/`ctrl+u`, `home`/`end` — keep working exactly as
documented above; they are described here instead of spending footer cells.

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
- **No worktree association (S1):** worktrees receive no issues any more, so
  the view has nothing to mark, toggle or save. A malformed or unreadable
  worktree registry therefore changes nothing here: the command opens and
  stays fully usable.
- **`gh` unavailable:** the command stays registered and stays in the
  command list, but it refuses to open, names the install plus login fix,
  and the view's own `gh unavailable` state says the same thing.
- **No TUI overlay:** when the TUI helpers cannot be loaded, the command
  falls back to one muted line naming the issue count across the pages.

## Limits

GitHub's **search** API cannot enumerate more than 1000 matches, and that is
what the three scoped tabs and every typed search use. When a search reaches
that cap the client fails the read and the view names the limit, asking you to
narrow the filter instead of silently treating a partial result as complete.
The unfiltered **All** tab is not a search: it reads the repository's own issue
connection, cursor-paged to its end with the exact `totalCount`, so open issues
past 1000 remain reachable there — a single read is still bounded by the
viewport-derived page size, and further pages arrive as you scroll. A count
taken from a page whose walk has not finished is shown as a lower bound
(`N+`). That `totalCount` is the server's count at request time, so a walk is
not a snapshot: issues updated while you page can shift what the next page
returns. Scope is the current checkout only — the
session's cwd resolved to its Git root. The issue body and the comments
show as plain wrapped text (no markdown styling).
