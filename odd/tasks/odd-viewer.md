# Odd viewer: one overlay that lists and reads the checkout's odd documents

Add `/herdr-gentle:odd`: a two-pane overlay that lists the current checkout's `odd/tasks/*.md` on the left and renders the selected document, styled and scrollable, on the right — the same interaction shape as `/gentle:changes`.

Branch: `feat/odd-viewer`. Worktree: `/home/jona/mnt/sv-home/dev/projects/herdr-gentle-shell-worktrees/feat-odd-viewer`. Base: `main` 10aa5f2.
Delivery: `single-pr`, decided when the work units landed: 1676 authored changed lines in 4 commits, past the review budget. The slice cannot be split into independently landable pieces — the renderer has no consumer without the view, the view has no entry point without the command, and the command is dead without the renderer — so the exception is recorded here instead of hiding the dependency behind an artificial chain. Expected label: `size:exception` with this rationale. Runner: `node --test tools/*.test.js` (what CI runs). Push, PR creation and merge stay with the user.

## Specs

S1. Original request, verbatim: "agrega un nuevo commando de /herdr-gentle:odd, el cual abra una vista como changes /tmp/gp279byI/pi-clipboard-a292adb1-cc53-4049-9436-bd445de3d433.png con los archivos odd del repo. A la izquierda salen todos los odd crearo, los md (pero sale solo en nombre claro) y a la derecha el archvio/contedido del md para leerlo, donde puede hacer scroll y mvoerme para leerlo completo claro, igual que changes. De hecho podrias hasta mostrarlo como un "md estilisado" ya que en general tiene las mismas secciones y formato, como que primero va el nombre y descrip, tiene las taks, las specs, logs, (opcionalemnte a veces tiene otras creo, puede revisar los diferentes odd.md para verlas)."

S2. Scope, answered by the user: the list reads the CURRENT checkout only (the session's cwd resolvable to a Git root), never the principal or another worktree when the session runs inside a worktree. The listed files are exactly `odd/tasks/*.md` (non-recursive, `*.md` only), sorted by name.

S3. Left pane shows the document NAME only — the `.md` extension stripped and no path — one selectable row per document, with the selection marker and the same key-driven movement the reference view uses. The count of documents travels in the overlay title.

S4. Right pane shows the selected document's full content, read from disk, with vertical scrolling that reaches every line: the reader may move through the whole file. The pane scrolls independently of the list, and moving the selection resets the scroll to the top of that document.

S5. The content is rendered as styled markdown rather than raw text: the document's sections (`Specs`, `Tasks`, `Log`, and any other `##`/`###` heading a document carries), list items, task table rows, inline `code`, bold, and fenced code blocks each get a distinguishable rendering. The renderer is this package's own (no new dependency, no import from gentle-shell, no hand-off of candidate bytes to an external tool). No source line with content is dropped — consecutive blank lines collapse to one separator — and a line too long for the pane wraps instead of being cut.

S6. Empty and unavailable states are explicit and never fake content: a checkout with no `odd/tasks/*.md` renders an empty-list state instead of an empty frame; a document that cannot be read renders its own error line; a session whose cwd is not inside a Git checkout renders an unavailable state. `Esc` closes and writes nothing — the view is read-only and never mutates the checkout.

## Tasks

T1 | S1,S2 | explore | done | Implementation map resolved: reference view contract (`lib/shell-changes-view.ts` in gentle-shell), this repo's panel/command patterns, and the real heading inventory of `odd/tasks/*.md`. Commit: evidence only, folded into 9cef844.
T2 | S5 | implement | done | `lib/odd-markdown.js`: pure `.md` -> styled line renderer (headings by level, list items and task rows, inline code, bold, fenced blocks, rules), width-aware, no content dropped; own unit tests (7/7). Commit: 9cef844.
T3 | S2,S3,S4,S6 | implement | done | `lib/odd-docs.js` (discovery plus reads) and `lib/odd-view.js` (framed two-pane view model with independent scroll, empty/unreadable/unavailable states, injectable TUI seam); `tools/odd-docs.test.js` 5/5, `tools/odd-view.test.js` 7/7. Commit: 1691d0c.
T4 | S1,S3,S4 | implement | done | `/herdr-gentle:odd` in `extensions/gentle-worktree-tools.ts`: discovery over the session cwd's Git root, lazy `pi-tui` loader seam, full-screen `ctx.ui.custom` overlay, `done()` on close, plain select fallback; `tools/odd-command.test.js` 4/4. Commit: 0058e0e.
T5 | S3,S4,S6 | verify | done | End-to-end checks over the six real `odd/tasks/*.md`: every document reached by `end`, no content token lost (the two remaining hits are a 143-character word split to fit and an escaped table pipe), suite 1276/1277 with the single failure proven pre-existing on `main` (the user's global `core.excludesFile` ignores `.env.*` for a test fixture). Commit: 3f474a6 plus the verification record in this document.
T6 | S1 | docs | done | `docs/odd-viewer.md` plus the README surface-table row, README feature bullet and DESIGN command enumeration. Commit: 3f474a6.

## Log

L1. User request, verbatim: "agrega un nuevo commando de /herdr-gentle:odd, el cual abra una vista como changes /tmp/gp279byI/pi-clipboard-a292adb1-cc53-4049-9436-bd445de3d433.png con los archivos odd del repo. A la izquierda salen todos los odd crearo, los md (pero sale solo en nombre claro) y a la derecha el archvio/contedido del md para leerlo, donde puede hacer scroll y mvoerme para leerlo completo claro, igual que changes. De hecho podrias hasta mostrarlo como un "md estilisado" ya que en general tiene las mismas secciones y formato, como que primero va el nombre y descrip, tiene las taks, las specs, logs, (opcionalemnte a veces tiene otras creo, puede revisar los diferentes odd.md para verlas)."
L2. Product decisions answered by the user before any source edit: the list is scoped to the CURRENT checkout only, and it lists exactly `odd/tasks/*.md`. Recorded as S2; the alternative (all checkouts of the clone grouped like Changes) was offered and declined.
L3. Suite triage (independent verifier, read-only): the `tools/worktree-hooks.test.js` failure that appears in the full suite reproduces identically on `main` and `git diff --stat main...HEAD` does not touch that test or its module. Proven environmental: the user's global `core.excludesFile` (`~/.config/git/.gitignore`, `.env`, `.env.*`) makes the test's `git add .env.local` fail in its temporary repository. Not a defect of this feature; fixing it would touch an existing test outside this scope.
L4. Renderer fidelity defect found by the parent while checking the six real documents: glued punctuation was separated from an inline span (`` `/x`, `` rendered as `/x ,`). Fixed test-first with one RED test and one GREEN (worker evidence: `see /x/y , and bold , done.` before, `7/7` after), re-verified by the parent over the real documents.
L5. Delivery decision recorded before the final tracking commit: one PR with `size:exception` rather than a recut chain, because the four units are mutually dependent (renderer -> view -> command) and a chain would only hide that. Push, PR and merge remain the user's decisions.
