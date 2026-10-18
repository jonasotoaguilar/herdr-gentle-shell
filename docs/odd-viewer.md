# Odd viewer (`/herdr-gentle:odd`)

Full-screen two-pane overlay over the current checkout's odd documents:
the left pane lists every `odd/tasks/*.md` file, the right pane renders
the selected document as styled markdown. Each list row also marks
whether that document is assigned to the checkout the session runs in;
`space` toggles the assignment locally and `ctrl+s` saves it through the
worktree registry. `Esc` closes.

## What it shows

The list reads exactly `odd/tasks/*.md` (non-recursive, `*.md` only) in the
checkout the session runs in — inside a worktree that is that worktree,
never the principal — sorted by name. Each row shows the document NAME
only: the `.md` extension stripped, no path. The overlay title names the
checkout and carries the document count and the assigned count.

Every row carries its assignment mark:

| Mark | Meaning |
| --- | --- |
| `✓` | assigned to this checkout and stored |
| `·` | not assigned |
| `✎` | changed but unsaved — differs from the stored assignment |

The title adds `· unsaved` while any toggle is pending.

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
| `ctrl+j` / PageDown | Scroll the document down one page |
| `ctrl+k` / PageUp | Scroll the document up one page |
| `home` / `end` | Jump to the top / bottom of the document |
| `r` | Re-list `odd/tasks/*.md` |
| `space` | Toggle the focused row's assignment (local only, writes nothing) |
| `ctrl+s` | Save the pending set as this checkout's `odd[]` and apply it |
| `esc` (`ctrl+c`, `q`) | Close; discards unsaved toggles, writes nothing |

The document pane scrolls independently of the list.

## Save semantics

The assignment lives in the checkout's registry row (`odd[]`, the
`odd/tasks/<file>` names the registry already stores); the checkout is
the one the session runs in, the principal included, and a row that does
not exist yet is created on the first save. `space` only flips the
pending set — nothing is written. `ctrl+s` persists the whole pending
set, replacing the stored `odd[]` exactly as the registry's own
overwrite semantics do, and only then is the assignment applied: a
successful save clears the pending state and updates the marks. A failed
save keeps every `✎` mark and shows `save failed: <error>` above the
document instead of claiming success. Nothing else in the view writes:
the documents are still only read.

## States

- **Empty checkout:** no `odd/tasks/*.md` renders an empty-list state
  instead of an empty frame. The view still opens.
- **Unreadable document:** the document's own error line renders in the
  right pane; the list stays usable.
- **Unreadable registry:** the stored assignment loads fail-soft — the
  view opens with nothing marked and stays usable; the failure is
  reported only if a save is attempted (`save failed: …`), and a
  refusing registry is left untouched.
- **Not in a Git checkout:** the command notifies and opens nothing.
- **No TUI overlay:** when the TUI helpers cannot be loaded, the command
  falls back to the plain host select menu naming the file it would show.

## Limits

Only the assignment field writes, and only through `ctrl+s` as described
above; `esc` always discards. Scope is the current checkout only — the
session's cwd resolved to its Git root. Discovery and rendering live in
`lib/odd-docs.js` (listing plus reads), `lib/odd-markdown.js` (the
package's own markdown renderer, no new dependency), and
`lib/odd-view.js` (the two-pane view); the command is registered in
`extensions/gentle-worktree-tools.ts` next to
`/herdr-gentle:customize` and `/herdr-gentle:warp`, and it persists
through `lib/worktree-registry.js` (its own read/update path, creating
the row on demand — never a parallel store).

Two rendering limits are known and accepted: a table cell that escapes a
pipe as `\|` renders the backslash (the text is kept, not dropped), and a
single word wider than the document pane is split to fit, since nothing may
be cut.
