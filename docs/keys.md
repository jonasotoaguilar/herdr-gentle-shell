# Key map for the `/herdr-gentle:*` views

Every view has one compact shortcut row. Search has its own interaction-scoped
legend; keys are not repeated above and below the same control.

In every footer and panel header a shortcut's KEY stands apart from the words
beside it: the key is a BUTTON and carries the theme's primary accent role plus
bold, its description the muted role, static labels are dim and counts are
muted. A TITLE — a frame title, a section heading, the active tab — takes the
`customMessageLabel` title role the Pi Agents view paints its own frame title
with, and ordinary
text (a derived branch or path, a typed name, a search query, a page number)
takes the normal `text` role, so a heading never reads as a control and the
accent stays with the buttons. In the reference, which names its roles
separately, a primary button is `solid`/`solid_foreground`; pi's theme has no
`solid`, so its documented primary — `accent` — is what every button here uses. A selected row is told apart from that ordinary text by its own
`selectedBg` band. One shared palette (`lib/tui-paint.js`) decides those roles
for the warp panel, the create flow, odd, issues and the customize panel, so the
five surfaces cannot drift apart. A theme that answers no colour (or throws)
still renders every key and row: plain text is the fallback, and focus stays
readable through its `▸` mark.

## Warp

`/herdr-gentle:warp` opens the bottom panel. The current checkout owns the
header; up to five other checkouts follow, principal first when not current.

| Action | Keys |
| --- | --- |
| Move selection | `↑`/`↓`, `j`/`k` |
| Enter focused checkout | `enter` |
| Create a checkout | `c` |
| Delete the focused checkout | `ctrl+d` |
| View every checkout, when some are hidden | `v` or the `view all worktrees` row |
| Reload | `r` |
| Close | `esc`, `ctrl+c` |

Warp moves the session and creates worktrees; it edits nothing. There is no
edit key: the worktree edit panel, the fullscreen worktree detail and the
issue/ODD association were removed, so `e` is inert here. The extended list
supports typing to filter and `[`/`]` or `pgUp`/`pgDn` to page. Escape leaves
search first, then returns to the bottom panel. Printable text is meaningful, so
`q` is not close.

`ctrl+d` (in the panel and in the extended list, while the search is closed)
ASKS to delete the focused checkout. It never deletes on its own, and no
permission mode shortens the path: YOLO is not consulted here, so the human
answer is always required. The question names the checkout, its branch and —
when it has any — the uncommitted changes that would be lost, as
`Pending changes: N files, +A/-D` line counts. It also names the files git
IGNORES there, because they are deleted with the checkout while the working
tree reads clean. Any read that cannot answer — the change summary, the pending
bytes, the ignored files — refuses the delete without a question: nothing can
say what would be lost, so there is nothing honest to confirm. Answering no
changes nothing.

Deleting removes the checkout and keeps the branch, and it is refused before
any question for the principal checkout and for the checkout the session is
running in — warp out first, or close it with the `worktree_close` tool. After
the answer the target is read again and compared with what the question
described: a row that vanished, a checkout that stopped being live, a moved
branch, different pending BYTES behind identical `+A/-D` counts, or an ignored
file that appeared all abort the delete with the difference named and nothing
removed. A live branch that already differs from the stored registry branch is
not a change — that is what the checkout is on, and it never blocks a delete.
The extended list's data line shows the pending size as bare `+A −D`; only an
unreadable size keeps the word `changes` in front of it.


## Create

`c` opens the compact bottom type/name flow, with branch/path preview above.
`tab`, `shift+tab` or `←`/`→` move between fields; `↑`/`↓` choose the type.
There are no Issues/ODD panes or associations, and this is the only key map the
panel has. `enter` advances/confirms, and `esc` cancels without creating a
branch or checkout. There is ONE create key: `ctrl+s` is not a binding any
more (it duplicated `enter`).

A dirty checkout adds ONE question before anything is written, in the same
bottom overlay as the panel:

| Action | Keys |
| --- | --- |
| Carry the pending changes into the new checkout | `YES COPY` (`↑`/`↓`, then `enter`) |
| Create it empty from the base commit | `NO COPY` (`↑`/`↓`, then `enter`) |
| Cancel the creation (nothing written) | `esc`, `ctrl+c` |

That answer is taken once per flow: the warp that follows the creation reuses
it instead of asking again. Confirming does not wait for dependency install or
the CodeGraph index — the selector comes back with the new checkout as a row as
soon as the path and the pending copy exist, and the setup reports itself when
it finishes.

## Worktree detail

There is no worktree detail view any more. Worktrees no longer receive issues
or ODD documents, so the surface that assigned them — its tabs, its
`ctrl+s` save and the warp `e` that opened it — was removed with the
association. `/issues` and `/odd` remain read-only readers with respect to
worktrees; the mode switch remains in Customize, not this command.

## Odd and issues readers

`/herdr-gentle:odd` and `/herdr-gentle:issues` do not assign worktrees: no row
marks, assignment toggle or list-level save shortcut. Issues lists open issues
only; there is no `f` state toggle or reopen path.

| Action | Odd | Issues |
| --- | --- | --- |
| Navigate | `↑`/`↓`, `j`/`k` | `↑`/`↓`, `j`/`k` |
| Search | `T`, `/` | `T`, `/` |
| Reload | `r` | `r` |
| Open externally | `o` (editor; the terminal is released until it exits) | `o` (browser) |
| Switch bucket | — | `tab`, `shift+tab` |
| Page active list | `←`/`→` | `←`/`→` |
| Edit labels (when permitted) | — | `l`, `L` |
| Edit assignees (when permitted) | — | `a` |
| Comment | — | `c` |
| Close issue | — | `x`, `X`, then confirmation |
| Leave view | `esc` | `esc` |

Labels and assignees are preselected multi-select toggles: `space` adds/removes,
`ctrl+s` applies and Escape leaves the editor. Missing or unconfirmed permissions
hide both the shortcut and editor entry; creating labels needs its separate
capability. Comments refetch detail after a successful post. A nonempty draft asks
before discarding. These actions do not assign a worktree, and Copy is removed.

In an active search, Delete clears the whole query and Backspace removes one
character; only that search footer advertises clearing. Lists page by viewport
rows and wrapped titles, not a fixed item count. Issues page changes and `r` read
fresh data; `r` also refreshes the focused detail. In Odd the list scroll pair is
movement, not a documented action, so it carries no footer token (the keys still
work), and `r` names its outcome in the footer: `r reload` before the first
press, `r reloaded` after a re-list that also re-reads the open document, and
`r failed` (full `r reload failed` where the row holds it) when the re-read could
not happen and the current list stays. The reload token outranks the `o open`
hint, so the ~60-column row gives that hint up rather than dropping the answer.

In Odd, `o` releases the terminal for the editor's whole lifetime instead of
sharing it: Pi paints nothing and reads no key while `$VISUAL`/`$EDITOR` runs,
so Escape stays with nvim and the reader is still open behind it when the editor
exits. Pi's own suspend plus a repaint re-arms the view afterwards — see
[Opening in an editor](odd-viewer.md#opening-in-an-editor).

## Preview scrolling

Odd and Issues share preview paging: `ctrl+shift+j/k`
when the terminal reports it, printable `Shift+J/K` as the fallback, and
`PgDn`/`PgUp` always. `ctrl+d`/`ctrl+u` remain half-page actions; lowercase
`j`/`k` select list rows. The footer names the extended pair only when the
host confirms that protocol, never based on the OS. These are plugin
bindings, not Pi native defaults. Bare LF/CR and legacy Ctrl+J/K do not
scroll the preview; Enter keeps its editor/selection meaning.

## Customize

Use `tab` or `←`/`→` to switch panes, `↑`/`↓` to move and `enter` to apply.
Escape closes. The panel offers four categories — sidebar, moshi, worktree and
reset — and no performance switch of any kind. Its title, section label,
choices, position count and footer paint through the same shared palette, so
the `esc` hint and the footer keys read apart from the words beside them here
too: the panel title and the section heading take `customMessageLabel`, the role
the Pi Agents view paints its own frame title with, the keys keep the
primary accent, an unselected choice is ordinary text
and the focused row is told apart by its own `selectedBg` band — the panel never
paints every row in the accent.

The performance trace is not a panel option: it is switched on by exporting
`GENTLE_PERF_TRACE=1` before starting Pi. See
[Performance trace](performance-trace.md) for its measured scope and limits.
