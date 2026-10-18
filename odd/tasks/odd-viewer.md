# Odd viewer: one overlay that lists and reads the checkout's odd documents

Add `/herdr-gentle:odd`: a two-pane overlay that lists the current checkout's `odd/tasks/*.md` on the left and renders the selected document, styled and scrollable, on the right — the same interaction shape as `/gentle:changes`.

Branch: `feat/odd-viewer`. Worktree: `/home/jona/mnt/sv-home/dev/projects/herdr-gentle-shell-worktrees/feat-odd-viewer`. Base: `main` 10aa5f2.
Delivery: single commit per task on this branch; `node --test tools/*.test.js` is the runner CI uses.

## Specs

S1. Original request, verbatim: "agrega un nuevo commando de /herdr-gentle:odd, el cual abra una vista como changes /tmp/gp279byI/pi-clipboard-a292adb1-cc53-4049-9436-bd445de3d433.png con los archivos odd del repo. A la izquierda salen todos los odd crearo, los md (pero sale solo en nombre claro) y a la derecha el archvio/contedido del md para leerlo, donde puede hacer scroll y mvoerme para leerlo completo claro, igual que changes. De hecho podrias hasta mostrarlo como un "md estilisado" ya que en general tiene las mismas secciones y formato, como que primero va el nombre y descrip, tiene las taks, las specs, logs, (opcionalemnte a veces tiene otras creo, puede revisar los diferentes odd.md para verlas)."

S2. Scope, answered by the user: the list reads the CURRENT checkout only (the session's cwd resolvable to a Git root), never the principal or another worktree when the session runs inside a worktree. The listed files are exactly `odd/tasks/*.md` (non-recursive, `*.md` only), sorted by name.

S3. Left pane shows the document NAME only — the `.md` extension stripped and no path — one selectable row per document, with the selection marker and the same key-driven movement the reference view uses. The count of documents travels in the overlay title.

S4. Right pane shows the selected document's full content, read from disk, with vertical scrolling that reaches every line: the reader may move through the whole file. The pane scrolls independently of the list, and moving the selection resets the scroll to the top of that document.

S5. The content is rendered as styled markdown rather than raw text: the document's sections (`Specs`, `Tasks`, `Log`, and any other `##`/`###` heading a document carries), list items, task table rows, inline `code`, bold, and fenced code blocks each get a distinguishable rendering. The renderer is this package's own (no new dependency, no import from gentle-shell, no hand-off of candidate bytes to an external tool). Nothing may be dropped: every line of the source reaches the pane.

S6. Empty and unavailable states are explicit and never fake content: a checkout with no `odd/tasks/*.md` renders an empty-list state instead of an empty frame; a document that cannot be read renders its own error line; a session whose cwd is not inside a Git checkout renders an unavailable state. `Esc` closes and writes nothing — the view is read-only and never mutates the checkout.

## Tasks

T1 | S1,S2 | explore | Implementation map resolved: reference view contract (`lib/shell-changes-view.ts` in gentle-shell), this repo's panel/command patterns, and the real heading inventory of `odd/tasks/*.md`. Commit: evidence only.
T2 | S5 | implement | `lib/odd-markdown.js`: pure `.md` -> styled line renderer (headings by level, list items and task rows, inline code, bold, fenced blocks, rules), width-aware, never dropping a line; own unit tests.
T3 | S2,S3,S4,S6 | implement | `lib/odd-view.js`: pure view model and renderer for the two-pane frame (title with count, list rows, right pane scroll, empty/unavailable/error states, key handling map) with an injectable TUI seam so it renders headless in tests.
T4 | S1,S3,S4 | implement | `/herdr-gentle:odd` command in `extensions/gentle-worktree-tools.ts`: discovery of `odd/tasks/*.md` in the session cwd's Git root, lazy `pi-tui` import seam, `ctx.ui.custom` overlay wiring, `done()` on close, graceful fallback when the TUI module is unavailable.
T5 | S3,S4,S6 | verify | End-to-end functional checks: real discovery on isolated fixtures, scrolling to the last line of the largest real document, empty/unavailable/error paths, and the full suite green.
T6 | S1 | docs | Name the new command wherever the other commands are described (`README.md`, `DESIGN.md`, and any doc listing `/herdr-gentle:*`), so no surface omits it.

## Log

L1. User request, verbatim: "agrega un nuevo commando de /herdr-gentle:odd, el cual abra una vista como changes /tmp/gp279byI/pi-clipboard-a292adb1-cc53-4049-9436-bd445de3d433.png con los archivos odd del repo. A la izquierda salen todos los odd crearo, los md (pero sale solo en nombre claro) y a la derecha el archvio/contedido del md para leerlo, donde puede hacer scroll y mvoerme para leerlo completo claro, igual que changes. De hecho podrias hasta mostrarlo como un "md estilisado" ya que en general tiene las mismas secciones y formato, como que primero va el nombre y descrip, tiene las taks, las specs, logs, (opcionalemnte a veces tiene otras creo, puede revisar los diferentes odd.md para verlas)."
L2. Product decisions answered by the user before any source edit: the list is scoped to the CURRENT checkout only, and it lists exactly `odd/tasks/*.md`. Recorded as S2; the alternative (all checkouts of the clone grouped like Changes) was offered and declined.
