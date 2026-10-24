# Key map for the `/herdr-gentle:*` views

Every view has one compact shortcut row. Search has its own interaction-scoped
legend; keys are not repeated above and below the same control.

## Warp

`/herdr-gentle:warp` opens the bottom panel. The current checkout owns the
header; up to five other checkouts follow, principal first when not current.

| Action | Keys |
| --- | --- |
| Move selection | `↑`/`↓`, `j`/`k` |
| Enter focused checkout | `enter` |
| Create a checkout | `c` |
| Open focused checkout's fullscreen detail | `e` |
| Delete eligible focused checkout | `ctrl+d` |
| View every checkout, when some are hidden | `v` or the `view all worktrees` row |
| Reload | `r` |
| Close | `esc`, `ctrl+c` |

Deletion reuses the existing confirmation and safety checks. Principal, current
and unregistered checkouts are not eligible. The extended list supports typing
to filter and `[`/`]` or `pgUp`/`pgDn` to page. Escape leaves search first, then
returns to the bottom panel. Printable text is meaningful, so `q` is not close.

## Create

`c` opens the compact bottom type/name flow, with branch/path preview above.
`tab`, `shift+tab` or `←`/`→` move between fields; `↑`/`↓` choose the type.
There are no Issues/ODD panes or associations. `enter` advances/confirms,
`ctrl+s` submits, and `esc` cancels without creating a branch or checkout.

## Worktree detail

`e` in warp and `/herdr-gentle:worktree` use the same fullscreen detail.

| Action | Keys |
| --- | --- |
| Switch Issues/ODD tab | `tab`, `shift+tab` |
| Page active list (never switch tabs) | `←`/`→` |
| Refresh focused preview | `r` |
| Move selection | `↑`/`↓`, `j`/`k` |
| Toggle an open issue | `space` |
| Select one ODD document | `enter` or `space` |
| Clear the selected ODD document | `space` on that document |
| Search current tab | `T`, `/` |
| Save associations | `ctrl+s` |
| Close | `esc` |

Selecting another ODD replaces the old selection; a worktree never stores a
list of ODD associations. The mode switch remains in Customize, not this command.

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

Odd, Issues and worktree detail share preview paging: `ctrl+shift+j/k`
when the terminal reports it, printable `Shift+J/K` as the fallback, and
`PgDn`/`PgUp` always. `ctrl+d`/`ctrl+u` remain half-page actions; lowercase
`j`/`k` select list rows. The footer names the extended pair only when the
host confirms that protocol, never based on the OS. These are plugin
bindings, not Pi native defaults. Bare LF/CR and legacy Ctrl+J/K do not
scroll the preview; Enter keeps its editor/selection meaning.

## Customize

Use `tab` or `←`/`→` to switch panes, `↑`/`↓` to move and `enter` to apply.
Escape closes. The panel offers four categories — sidebar, moshi, worktree and
reset — and no performance switch of any kind.

The performance trace is not a panel option: it is switched on by exporting
`GENTLE_PERF_TRACE=1` before starting Pi. See
[Performance trace](performance-trace.md) for its measured scope and limits.
