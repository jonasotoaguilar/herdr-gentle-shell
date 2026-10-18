# Odd viewer (`/herdr-gentle:odd`)

Read-only, full-screen two-pane overlay over the current checkout's odd
documents: the left pane lists every `odd/tasks/*.md` file, the right pane
renders the selected document as styled markdown. Nothing is written and
nothing asks for `/reload`; `Esc` closes.

## What it shows

The list reads exactly `odd/tasks/*.md` (non-recursive, `*.md` only) in the
checkout the session runs in — inside a worktree that is that worktree,
never the principal — sorted by name. Each row shows the document NAME
only: the `.md` extension stripped, no path. The overlay title carries the
document count.

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
| `esc` (`ctrl+c`, `q`) | Close; writes nothing |

The document pane scrolls independently of the list.

## States

- **Empty checkout:** no `odd/tasks/*.md` renders an empty-list state
  instead of an empty frame. The view still opens.
- **Unreadable document:** the document's own error line renders in the
  right pane; the list stays usable.
- **Not in a Git checkout:** the command notifies and opens nothing.
- **No TUI overlay:** when the TUI helpers cannot be loaded, the command
  falls back to the plain host select menu naming the file it would show.

## Limits

Read-only: the view never mutates the checkout. Scope is the current
checkout only — the session's cwd resolved to its Git root. Discovery and
rendering live in `lib/odd-docs.js` (listing plus reads),
`lib/odd-markdown.js` (the package's own markdown renderer, no new
dependency), and `lib/odd-view.js` (the two-pane view); the command is
registered in `extensions/gentle-worktree-tools.ts` next to
`/herdr-gentle:customize` and `/herdr-gentle:warp`.

Two rendering limits are known and accepted: a table cell that escapes a
pipe as `\|` renders the backslash (the text is kept, not dropped), and a
single word wider than the document pane is split to fit, since nothing may
be cut.
