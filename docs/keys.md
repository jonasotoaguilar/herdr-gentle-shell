# Key map for the `/herdr-gentle:*` views

One key per action, in every view. The canonical key is defined per ACTION,
not per view, so a new view inherits it instead of inventing one, and the
same action answers the same key wherever it exists.

`c` = customize panel · `w` = warp selector · `z` = warp create/edit panel ·
`o` = odd viewer · `i` = issues viewer.

| Action | Key | c | w | z | o | i |
| --- | --- | --- | --- | --- | --- | --- |
| Move the selection | `↑`/`↓`, `j`/`k` | ✓ | ✓ | ✓ | ✓ | ✓ |
| Scroll the right pane | `ctrl+j`/`ctrl+k`, `pgUp`/`pgDn` | – | – | – | ✓ | ✓ |
| First/last | `home`/`end` | wraps | clamp | clamp | ✓ | ✓ |
| Next/previous page or pane | `tab` / `→`, `shift+tab` / `←` | ✓ panes | – | ←/→ tab | – | ✓ pages |
| Search/filter | `T` (issues also `/`) | – | ✓ | ✓ | ✓ | ✓ |
| List pagination | `[` / `]` | – | ✓ | ✓ | – | ✓ |
| Toggle a row | `space` | – | – | ✓ | ✓ assign when enabled | ✓ assign when enabled |
| Confirm/apply | `enter` | ✓ | ✓ | ✓ | – | ✓ sub-panels |
| Save/persist | `ctrl+s` | – | – | ✓ | ✓ when enabled | ✓ when enabled |
| Refresh | `r` | – | ✓ | – | ✓ | ✓ |
| Edit the focused row | `e` | – | ✓ issues/odd | – | – | – |
| Open outside Pi | `o` | – | – | – | ✓ editor | ✓ browser |
| Copy number / URL | `y` / `Y` | – | – | – | – | ✓ |
| Cancel/close | `esc` (aliases `ctrl+c`, `q`) | ✓ | `esc`/`ctrl+c` | `esc`/`ctrl+c` | ✓ | ✓ |

## Deliberate divergences

- **The create/edit panel is two content panes, never three columns.** The
  active dataset's list is on the left and that row's read-only preview on
  the right, in the miniature shape of the issues and odd commands. `tab`
  (and `←`/`→` inside the list) toggles the dataset — the panel's "next
  pane" — while each dataset keeps its own cursor, filter and selections;
  `space` toggles the focused row's association. The header stacks `Type`
  above `Name` with the derived branch/path and the selected association
  counts beneath them: `↓` walks Type → Name → list and `↑` on the first
  list row walks back to Name and then Type, so no field is a dead end. The
  preview is read-only and is never focused.
- **The create/edit filter is a dedicated `Search Issues:` / `Search Odd:`
  row directly under the title**, showing the active dataset's query in the
  Commands-palette shape instead of burying it in a dataset heading or the
  footer. It stays opened by the same `T` or by any printable key in a pane,
  with the same paging and confirm keys; the row adds no shortcut and is not
  a focus stop.
- **There is no `?` help overlay.** Each view keeps its shortcuts visible
  instead of repeating them in a second screen. Performance previews explain
  behavior, benefit and tradeoff in plain language; benchmark evidence belongs
  in the documentation, not in the panel.
- **`tab` switches the create panel's Issues and Odd panes; it never means
  "back one step".** The sequential create wizard is gone — the single panel
  has no steps — so there is no previous step to return to, and `tab` keeps
  its "next pane" meaning everywhere.
- **The warp popup and the create panel do not close on `q`**, because in
  both a printable key is meaningful: with the popup on screen a printable
  (other than a bound key) opens the extended list's always-active filter,
  and in the create panel it opens the focused pane's filter or types into
  the name. `q` is therefore filter text or a typed value there, and `esc`
  (or `ctrl+c`) is the close key.
- **`T` opens a search box only where a list can be filtered** (the warp
  selector, the create panel's panes, the odd viewer, the issues viewer).
  Inside a text entry step, typing is the value, so no filter key exists
  there.
- **`home`/`end` wrap in the customize panel** because its lists are short and
  circular by design, and clamp elsewhere.
- **`esc` closes, except where it steps back**: in the warp selector's
  extended list it steps back to the popup, and in the issues viewer's
  label editor and comment box it returns to the list, where a non-empty
  comment draft asks once before being discarded.

## Limits worth knowing

- **Clipboard (`y`/`Y`)**: the copy is written through the first available of
  `pbcopy`/`wl-copy`/`xclip`/`xsel`. `wl-copy` keeps running to serve the
  selection, so it is detached rather than awaited; it also takes roughly half
  a second to take ownership of the selection, so pasting immediately after
  `y` can still yield the previous clipboard contents. The keys report a miss
  when no tool exists, and never claim a copy that did not happen.
- **External open (`o`)**: resolves `$VISUAL` then `$EDITOR`. When the
  configured editor cannot be executed, the opener falls back to the system's
  default editor and reports which one it used; with no editor configured at
  all it reports the miss instead of opening nothing silently.
