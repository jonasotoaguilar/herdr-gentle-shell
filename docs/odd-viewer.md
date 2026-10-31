# Odd viewer (`/herdr-gentle:odd`)

Full-screen two-pane overlay over the current checkout's odd documents:
the left pane lists every `odd/tasks/*.md` file, the right pane renders
the selected document as styled markdown. Worktrees carry no ODD association
any more (S1), so the viewer has nothing to mark, toggle or save: no surface
assigns a document to a worktree. `Esc` closes.

## What it shows

The list reads exactly `odd/tasks/*.md` (non-recursive, `*.md` only) in the
checkout the session runs in — inside a worktree that is that worktree,
never the principal — in modification order, most recently modified
first (S12). That sequence is the loader's own order
(`lib/odd-docs.js` sorts by modification time), so the viewer never re-sorts
it; `s` alternates it with a case-insensitive alphabetical order by
document name and the footer names the order that is active. Each row shows
the document NAME only: the `.md` extension stripped, no path. The title
stays short, just the viewer and the document count (`✎ Odd · 4
documents`).

Below the title the fixed search row carries the live query (`› Search`),
including empty and one-document lists; the page indicator is gone with the
pager (S3). The selected document's reading position sits at the right edge
when space allows. The `T` hint belongs only in the footer. The header never
repeats checkout/branch identity or the focused name already marked in the
list. The viewer name and the count are separate palette tokens in the header
- title accent+bold, count muted — not one painted run.

The issues and ODD readers use the smaller 30% list / 70% reading allocation,
subject to minimum widths on small terminals. Names wrap at spaces and
hyphens, keeping all characters; a
segment is split only if it cannot fit the entire text width.

The list is ONE continuous window, never a pager: the viewer reserves four
chrome rows (frame top, Search, footer, frame bottom) and paints the documents
whose wrapped rows fit the remaining height. `←`/`→` (also `[`/`]`) move that
window a screenful, and the focused document always stays inside it, so the
window follows the selection instead of snapping to a page. A taller name
simply reduces how many entries the window holds, and the window is kept full at
the end of the list rather than trailing blank rows.

Changing the order keeps the reader on the same document: the focused
document is re-found in the new sequence, its reading position is untouched,
and the window re-anchors on its new place, so the focused row is painted even
when its alphabetical position is far from the recent one. The name filter
composes with both orders — it narrows the list, and the matching rows are
shown in the active order.

Rows carry no association mark and the status row carries no assigned or
unsaved fact: no surface claims which document belongs to a checkout any more
(S1), so there is nothing here to show. Reading, filtering, the external open
and scrolling all work.

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
| `↑` / `↓`, `j` / `k` | Move the selection; the list window follows it |
| `←` / `→`, `[` / `]` | Scroll the list one screenful (no pages: the window just moves); the footer token reads `←/→ list` |
| `s` | Toggle the list order: modification order, most recent first (the default) ↔ alphabetical by name, case-insensitive |
| `ctrl+shift+j/k` when negotiated; `Shift+J/K` fallback; PageDown/PageUp always | Scroll the document down/up one page (the footer names this target once, as `ctrl+shift+j/k doc` or `shift+j/k doc`) |
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

The footer spends ONE token per scroll target instead of repeating every
alias: `ctrl+shift+j/k doc` (or `shift+j/k doc` when the extended protocol is
not confirmed) for the document pane and `←/→ list` for the list. The
alternates — `Shift+J/K`, PageDown/PageUp, `ctrl+d`/`ctrl+u`, `home`/`end` —
keep working exactly as documented above; they are described here instead of
spending footer cells.

The `s` hint rides the same ONE footer row and names the order that is active
(`s sort: recent` / `s sort: name`), keeping the key/description palette split
the rest of the legend uses. On a narrow terminal the row compacts to its short
tokens (`s`, `T`, `r`, …) instead of wrapping onto a second row; the labelled
scroll tokens survive that compaction, and `s` is the first entry dropped at
the narrowest width.

The document pane scrolls independently of the list. Each hint is named
once: the footer names `T`, and while searching that same footer switches to
the actions available in the search input.

## Palette

Every token paints through the injected theme with a role that says what it is
(S11), so the header, the search row and the footer read as ONE palette and the
view hardcodes no colour:

| Token | Role |
| --- | --- |
| frame title (`✎ Odd`) | `accent` + bold |
| the document count (`4 documents`) and status words | `muted` |
| the `·` separator and the `›` prompt / idle `Search` label | `dim` |
| the live search value and its caret | `accent` |
| shortcut KEY in the footer (`↑↓`, `←/→`, `ctrl+shift+j/k`, `s`, `T`, `esc`, …) | `accent` + bold |
| a key's description (`select`, `list`, `doc`, `sort: recent`, `search`, …) | `muted` |
| frame rules and pane divider | `border` |
| the document title (the markdown heading) | its heading role + bold |

A key is therefore distinguishable from the words beside it by BOTH colour and
weight, and focus never depends on colour: the focused document keeps its `▸`
mark, so a monochrome terminal shows the same information. A missing, partial or
throwing theme degrades to plain text rather than breaking a frame.

## The association is not here

Worktrees receive no ODD document any more (S1), so no surface marks, toggles
or saves an association: nothing here writes. The documents are still only
read.

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
