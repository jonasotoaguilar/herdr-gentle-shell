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

`c` opens the type/name flow. Choose the change type, enter its name, then
confirm. There are no Issues/ODD panes, associations or dataset tabs here.
`enter` advances/confirms, `ctrl+s` submits, and `esc` cancels.

## Worktree detail

`e` in warp and `/herdr-gentle:worktree` use the same fullscreen detail.

| Action | Keys |
| --- | --- |
| Switch Issues/ODD tab | `tab`, `shift+tab` |
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
| Copy number/URL | — | `y`, `Y` |
| Edit labels | — | `L` |
| Comment | — | `c` |
| Close issue | — | `x`, `X`, then confirmation |
| Leave view | `esc` | `esc` |

Issue sub-editors keep their local actions: `space` toggles a label, `ctrl+s`
applies labels or posts a comment, and Escape leaves the editor. These are not
worktree-assignment operations. A nonempty comment draft asks before discarding.

## Preview scrolling

Odd, issues and worktree detail accept `ctrl+j`/`ctrl+k` and `pgDn`/`pgUp` for
page movement, plus `ctrl+d`/`ctrl+u` and uppercase `J`/`K` for half pages.
Lowercase `j`/`k` always select list rows. The alternate pairs are useful when
a terminal or multiplexer intercepts the original shortcuts.

## Customize and performance

Use `tab` or `←`/`→` to switch panes, `↑`/`↓` to move and `enter` to apply.
Escape closes. Performance trace is OFF by default; leave tracing ON for both
comparison runs and change only the optimization switches between runs.
See [Performance trace](performance-trace.md) for its measured scope and limits.
