# Odd viewer (`/herdr-gentle:odd`)

Full-screen two-pane overlay over the current checkout's odd documents:
the left pane lists every `odd/tasks/*.md` file, the right pane renders
the selected document as styled markdown. The viewer is read-only about the
checkout's worktree association: it never marks, toggles or saves which
document belongs to a worktree — that association lives in the worktree
detail (S10b). `Esc` closes.

## What it shows

The list reads exactly `odd/tasks/*.md` (non-recursive, `*.md` only) in the
checkout the session runs in — inside a worktree that is that worktree,
never the principal — sorted by name. Each row shows the document NAME
only: the `.md` extension stripped, no path. The title stays short, just
the viewer and the document count (`✎ Odd · 4 documents`).

Below the title the fixed search row carries the live query and list-page
indicator (`› Search · page 1/4`), including one-page and empty lists. The
selected document's reading position sits at the right edge when space allows;
it yields before the list-page indicator on narrow terminals. The `T` hint
belongs only in the footer. The header never repeats checkout/branch identity
or the focused name already marked in the list.

All fullscreen readers use the shared 40% list / 60% preview allocation, subject
to minimum widths on small terminals. Names wrap at spaces and hyphens, keeping
all characters; a segment is split only if it cannot fit the entire text width.
Page capacity is not a fixed document count: the viewer reserves four chrome
rows (frame top, Search, footer, frame bottom), then packs whole names according
to their wrapped row cost into the remaining height. A taller name therefore
reduces the number of entries on that page.

Rows carry no association mark and the status row carries no assigned or
unsaved fact: the viewer never claims which document belongs to the
checkout's worktree (S10b). Reading, filtering, the external open and
scrolling all work; the checkout↔document association lives in the
worktree detail.

The right pane reads the selected document from disk and renders its full
content as styled markdown rather than raw text: `##`/`###` section
headings (`Specs`, `Tasks`, `Log`, and any other heading a document
carries), list items, task table rows, inline `code`, bold, fenced code
blocks, and rules each get a distinguishable rendering. Every source line
with content reaches the pane (consecutive blank lines collapse to one
separator). Moving the selection resets the scroll to the top of that
document.

## Keys

| Key | Effect |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move the selection |
| `ctrl+shift+j/k` when negotiated; `Shift+J/K` fallback; PageDown/PageUp always | Scroll the document down/up one page |
| `ctrl+d` / `ctrl+u` | Scroll down/up half a page |
| mouse wheel | Scroll the document up/down, never the selection |
| `home` / `end` | Jump to the top / bottom of the document |
| `T` (or `/`) | Filter the list by document name; the query stays on the search row, and while the box holds the keyboard the footer names that interaction's keys (`type to filter · bksp edit · enter/esc keep`) |
| `r` | Re-list `odd/tasks/*.md` |
| `o` | Open the focused document in `$VISUAL`/`$EDITOR` |
| `esc` (`ctrl+c`, `q`) | Close; writes nothing |

These are plugin bindings, not Pi native defaults. The footer names
Ctrl+Shift+J/K only when the host confirms the extended keyboard protocol;
otherwise it names Shift+J/K. It never guesses from the OS. Bare LF/CR and
legacy Ctrl+J/K are not preview-scroll aliases.

The document pane scrolls independently of the list. Each hint is named
once: the footer names `T`, and while searching that same footer switches to
the actions available in the search input.

## The association is not here

The checkout↔document association lives in the worktree detail, not in this
viewer (S10b): the viewer never marks, toggles or saves it, so nothing here
writes. The documents are still only read.

## States

- **Empty checkout:** the command answers with one muted line — `No odd
  documents under odd/tasks/ in this checkout.` — and opens no overlay,
  the same way the changes view answers an empty repository.
- **Unreadable document:** the document's own error line renders in the
  right pane; the list stays usable.
- **Not in a Git checkout:** the command notifies and opens nothing.
- **No TUI overlay:** when the TUI helpers cannot be loaded, the command
  falls back to the plain host select menu naming the file it would show.

## Limits

Only the documents are read; nothing in the view writes. Scope is the
current checkout only — the session's cwd resolved to its Git root.
Discovery and rendering live in
`lib/odd-docs.js` (listing plus reads), `lib/odd-markdown.js` (the
package's own markdown renderer, no new dependency), and
`lib/odd-view.js` (the two-pane view); the command is registered in
`extensions/gentle-worktree-tools.ts` next to
`/herdr-gentle:customize` and `/herdr-gentle:warp`.

Two rendering limits are known and accepted: a table cell that escapes a
pipe as `\|` renders the backslash (the text is kept, not dropped), and a
single word wider than the document pane is split to fit, since nothing may
be cut.
