# Key consistency across this package's views

Make every `/herdr-gentle:*` view answer the same key for the same action, keep gentle-shell's own conventions where they exist, and record the one divergence that is a user requirement.

Branch: `feat/odd-viewer` (same thread). Worktree: `/home/jona/mnt/sv-home/dev/projects/herdr-gentle-shell-worktrees/feat-odd-viewer`. Base: `main` 10aa5f2.
Delivery: recorded with the issues unit; push, PR and merge stay with the user.

## Specs

S1. User request, verbatim: "recuerda revisar que las teclas/atajos de todas nuestras vistas sean consistentes".

S2. The survey this rests on (read-only, already done): gentle-shell's `changes`, `agents`, `command-palette`, `visual-customize-view` and `stats-view` plus this package's `customize`, `warp` selector, warp create wizard, `odd` and `issues`. Consolidated conventions, with the view that currently violates each marked:

| Action | Canonical key | Sources | Violations to fix |
| --- | --- | --- | --- |
| move selection | `↑`/`↓` AND `j`/`k` | changes, agents, stats, odd, issues | `customize` and the `warp` selector accept only `↑`/`↓` |
| switch page/tab/pane | `tab` (+ `→`) | customize (pane), stats (view), issues (page) | `Tab` is "back" inside the warp create wizard — a user requirement (S58/S60), kept and documented, not changed |
| scroll the right pane | `ctrl+j`/`ctrl+k`, `pgUp`/`pgDn` | changes, agents, odd, issues | none |
| first/last | `home`/`end` | odd (document), issues (row) | none |
| list pagination | `[` / `]` | issues | the warp wizard multi-select paginates with `←`/`→` or `pgUp`/`pgDn` only: `[`/`]` are added as aliases, the existing keys stay (no regression) |
| search box | `T` (issues also `/`) | warp wizard (`T`), issues (`T`/`/`) | none |
| toggle | `space` | warp wizard, odd, issues | none |
| confirm/apply | `enter` | customize, warp wizard | none |
| save/persist | `ctrl+s` | odd, issues | none |
| refresh | `r` | odd, issues | none |
| cancel/close | `esc` (aliases `ctrl+c`, `q`) | all views | none |
| external open | `o` | changes (editor), issues (browser) | none |

S5. User requirement, verbatim: "sigan mapa igual/similar para acciones iguales o parecidas." The canonical key is therefore defined for every action that appears in more than one view, INCLUDING the ones only one view has today when another view has its analogue, and each view gets that key: `?` help (issues already has it; `odd` and `customize` get it), `T`/`/` filter the list (wizard and issues already; `odd` filters its document list by name), `r` reload the current data (odd and issues already; the `warp` selector reloads the checkout list), `o` open the focused item outside Pi (`changes` opens the editor, `issues` opens the browser; `odd` opens the document in `$VISUAL`/`$EDITOR`). An action keeps its canonical key even when only one view implements it, so a later view inherits it instead of inventing one.

S3. Corrections are ADDITIVE: `j`/`k` join the existing movement keys in `customize` and the `warp` selector, `[`/`]` join the wizard's pagination keys, and the `?`/`T`/`r`/`o` keys above are added where they are missing. No shipped key changes meaning, so nothing a user already learned breaks.

S4. The consolidated table is recorded for maintainers, including the deliberate divergences and their reason: `Tab` is "back one step" inside the warp create wizard (the user fixed that in the wizard's own spec) while it is "next page/pane" everywhere else, and `T` opens search in the multi-select steps only (inside a text step, typing is the value).

## Tasks

K1 | S1,S2,S3 | implement | pending | `j`/`k` move the selection in the customize panel and in the warp selector (additive to `↑`/`↓`), and `[`/`]` page the wizard's issues/odd multi-selects (additive to `←`/`→`/`pgUp`/`pgDn`); every existing key keeps its behaviour, pinned by the suites that already cover them.
K3 | S5 | implement | pending | The shared-action keys land where they were missing: `?` help overlay in `odd` and `customize`; `T`/`/` filters the `odd` document list by name (with the filter kept on leaving the box, as elsewhere); `r` reloads the `warp` selector's checkout list; `o` opens the focused `odd` document through `$VISUAL`/`$EDITOR` with the same "no editor configured" honesty as any other external open (report the miss, never fail silently). One test per key per view, RED first, and the footer of each view names the keys it gained.
K2 | S2,S4 | docs | pending | Record the table, the canonical keys and the two deliberate divergences where the package's other view docs live, and name it from the README surface table.

S6. Keys adopted from the reference the user pointed at (`/home/jona/mnt/sv-home/dev/upstream/gh-dash`, read-only, mined for ideas), each verified as cheap and consistent with our conventions: `y` copies the focused issue's number and `Y` its URL through an injected clipboard writer that tries the system tools in order and reports honestly when none exists (never silently doing nothing); and discarding a NON-EMPTY comment draft asks once (`y` discards, `n`/`esc` keeps editing) instead of throwing the text away on a single `esc`. NOT adopted, with reasons: its shell-string execution of custom commands (violates our fixed-argv rule), its writes that fire with no confirmation, its process-global label cache (our view stays pure), its `C` checkout action (it mutates the user's worktree; we model assignment in the registry only), its assignee toggles `a`/`A` (they need a user picker we do not have yet — recorded as a future unit), and its `ctrl+s` prefix meaning (ours means save/post; never import theirs).

S7. The reference's silent truncation is not copied: `gh-dash` requests `comments(last: 15)` and never says so. Where we limit comments we say it (`showing last K of N`), because a cut that is not named reads as the whole set.

K4 | S6,S7 | implement | pending | `y`/`Y` copy the number and URL through an injected clipboard seam with an honest miss; a non-empty comment draft asks before discarding; a limited comment list names what it cut. One test per rule, RED first, and the footer of the affected view names the two new keys.

## Log

L1. User request, verbatim: "recuerda revisar que las teclas/atajos de todas nuestras vistas sean consistentes". Answered with the consolidated survey in S2: three additive fixes (K1) and one documented divergence that is a prior user requirement rather than a defect.
L2. User requirement, verbatim: "sigan mapa igual/similar para acciones iguales o parecidas." Recorded as S5 and implemented as K3: the canonical key is defined per action, not per view, so help, filter, reload and external-open use one key everywhere they exist and the missing ones are added now instead of being invented later.
L3. User pointer, verbatim: "/home/jona/mnt/sv-home/dev/upstream/gh-dash el ejemplo de la imaggen era ese igual por si quieres verlo para ideas/implementacion". Read-only survey of that checkout recorded the adoptions and refusals in S6/S7 with `path:line` evidence; each adopted item is in our own style, and each refusal names the rule it would break.
