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
for My issues, `assignee:@me` for Assigned, `involves:@me` for Involved),
paginated with a totals line (`page n/m · N issues`) and a search box above
the list. Typing filters live: author `@user`, `#number`, title words.
By default only open issues show; `f` alternates between open-only and
all. Each row shows the issue number and title.

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

The title adds `· unsaved` while any toggle is pending.

## Keys

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | move the selection in the list |
| `tab` / `→`, `shift+tab` / `←` | next / previous page (My issues, Assigned, Involved — the `stats-view` convention) |
| `ctrl+j`/`ctrl+k`, `pgDn`/`pgUp` | scroll the issue pane |
| `home`/`end` | first / last issue in the current page |
| `[` / `]` | previous / next list page, with the totals line showing `page n/m · N issues` |
| `T` (also `/`) | open the search box above the list; typing filters live (author `@user`, `#number`, title words); `Enter`/`Esc` leave the box keeping the filter |
| `f` | toggle the state filter open <-> all/closed (S4) |
| `space` | toggle "assigned to this checkout" (S5), applied only on save |
| `ctrl+s` | save the pending assignment through the worktree registry `issues[]`, exactly the odd viewer's path and guards |
| `L` | open the label editor (S3) |
| `n` | create a new label inside the label editor |
| `c` | open the comment input (S7) |
| `x` / `X` | close / reopen the issue (S4), after the host's own confirm |
| `o` | open the issue in the browser (S5) |
| `r` | reload the current page from `gh` |
| `?` | key help overlay |
| `esc`/`ctrl+c`/`q` | close (discarding unsaved toggles, like the odd viewer) |

Reserved keys this view must not steal: `ctrl+c`, `ctrl+u`, `ctrl+d`, `alt+*` shortcuts registered elsewhere.

The label editor lists every repository label with a toggle plus a final
`create new…` row: `space` toggles, `n` jumps to create-new, `ctrl+s`
applies, `esc` leaves without applying. The comment input takes multiple
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

Listing, search, paging, filtering, scrolling and help never write
anything. Only these four actions write, each after an explicit key, each
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
  plus the error (`failed to load issues: …`).
- **Unreadable assignment:** the stored `issues[]` loads fail-soft — the
  view opens with nothing marked and stays usable; the failure is reported
  only if a save is attempted, and a refusing registry is left untouched.
- **`gh` unavailable:** the gated command is never registered, and the
  view's own `gh unavailable` state names the install plus login fix.
- **No TUI overlay:** when the TUI helpers cannot be loaded, the command
  falls back to one muted line naming the issue count across the pages.

## Limits

The list total is a bounded count: when the fetch bound is reached the
totals line renders it as `N+` (a lower bound, not the exact total). Scope
is the current checkout only — the session's cwd resolved to its Git root,
and the assignment marks belong to the checkout the session runs in. The
issue body and the comments show as plain wrapped text (no markdown
styling).
