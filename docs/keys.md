# Key map for the `/herdr-gentle:*` views

Every view has one compact shortcut row. Search has its own interaction-scoped
legend; keys are not repeated above and below the same control.

In every footer and panel header a shortcut's KEY stands apart from the words
beside it: the key carries the theme's accent role plus bold, its description
the muted role, static labels are dim, live values (a derived branch or path, a
typed name, a search query, the page number) are accent and counts are muted.
One shared palette (`lib/tui-paint.js`) decides those roles for the warp panel,
the create flow, odd, issues and the customize panel, so the five surfaces
cannot drift apart. A theme that answers no colour (or throws) still renders
every key and row: plain text is the fallback, and focus stays readable through
its `▸` mark.

## Warp

`/herdr-gentle:warp` opens the bottom panel. The current checkout owns the
header; up to five other checkouts follow, principal first when not current.

| Action | Keys |
| --- | --- |
| Move selection | `↑`/`↓`, `j`/`k` |
| Enter focused checkout | `enter` |
| Create a checkout | `c` |
| View every checkout, when some are hidden | `v` or the `view all worktrees` row |
| Reload | `r` |
| Close | `esc`, `ctrl+c` |

Warp moves the session and creates worktrees; it never modifies one. There is
no edit key and no delete key: the worktree edit panel, the fullscreen worktree
detail and the keyboard delete view were removed with the issue/ODD
association, so `e` and `ctrl+d` are inert here. The extended list supports
typing to filter and `[`/`]` or `pgUp`/`pgDn` to page. Escape leaves search
first, then returns to the bottom panel. Printable text is meaningful, so `q`
is not close.

## Create

`c` opens the compact bottom type/name flow, with branch/path preview above.
`tab`, `shift+tab` or `←`/`→` move between fields; `↑`/`↓` choose the type.
There are no Issues/ODD panes or associations, and this is the only key map the
panel has. `enter` advances/confirms, and `esc` cancels without creating a
branch or checkout. There is ONE create key: `ctrl+s` is not a binding any
more (it duplicated `enter`).

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
| Open externally | `o` (editor) | `o` (browser) |
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
fresh data; `r` also refreshes the focused detail.

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
too.

The performance trace is not a panel option: it is switched on by exporting
`GENTLE_PERF_TRACE=1` before starting Pi. See
[Performance trace](performance-trace.md) for its measured scope and limits.
