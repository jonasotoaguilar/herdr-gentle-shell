# Viewer feedback round — reader keys, legend and header

Behaviours implemented for the user's tested complaints about the ODD reader
and the worktree detail surface (spec `odd/tasks/worktree-ui-feedback.md`,
S1, S3, S5, S10, S11, S15). The round-3 corrections that superseded part of
that round (`odd/tasks/ui-consistency-round3.md`: shared key decision,
40/60 split, header order, fixed page marker) are folded into the sections
below. Each item is covered by a public input/output test; no item claims a
live-host result.

**Surface status (S1/S4 of `odd/tasks/simplify-worktrees-issue-scroll.md`).**
The full-screen worktree detail this round was written about — the surface
reached from the warp's `e`, with its Issues/ODD tabs and its assignment
column — no longer exists: worktrees carry no issue and no ODD document, so
the panel that edited those associations, its `space`/`ctrl+s` keys and the
verification sweep that re-read the registry were removed with them (see
[worktree-tools.md](worktree-tools.md)). What survives that shift is the
shared machinery below — the preview-scroll key decision and the ONE-row
footer legend — and it is what `/herdr-gentle:issues` and
`/herdr-gentle:odd` use today. Those two readers are documented in
[issues-viewer.md](issues-viewer.md) and [odd-viewer.md](odd-viewer.md);
this page keeps the reasoning that produced their shared pieces.

**Verification status:** all of this is verified with unit tests only
(`node --test tools/odd-view.test.js`, `tools/issues-view.test.js`,
`tools/preview-scroll-keys.test.js`, `tools/view-layout.test.js`,
`tools/worktree-detail-command.test.js`). Some tests replay the installed Pi
1.4 key matcher on raw bytes, but that is still a library call, not a manual
run in a real terminal on real hardware. Keyboard behaviour in a real host,
on a real terminal and on the user's machine is **not** claimed as verified.

## Preview scrolling through the shared key decision (S1)

Paging the preview is one shared decision (`lib/preview-scroll-keys.js`) used
by the Issues and ODD readers, so the handler and the footer cannot disagree.
`ctrl+shift+j/k` pages when the host confirms the extended keyboard protocol,
printable `Shift+J/K` is the fallback on a legacy terminal, `PgDn`/`PgUp`
always page, and `ctrl+d`/`ctrl+u` move half a page. Lowercase `j`/`k` only
select list rows. Bare LF/CR and the legacy Ctrl+J/K bytes are not
preview-scroll aliases; the byte the installed host matcher reports as both
`ctrl+j` and `enter` keeps its Enter meaning here, so it selects the focused
document instead of paging.

The shared helper is consulted before the list selection and before the
`enter` alias, because a host key matcher folds letter case: `J` must never
answer for the list-selection key `j`. Releases are refused too, so a
released key neither pages nor paints.

The scroll offset is clamped inside the key handler, not only in the next
render: `state.scroll` never reports a negative or past-the-end value that
the reader could observe before a repaint.

## Footer legend (S4, S11, S1)

Every hint lives on **one** footer row and nowhere else. The row has two
tiers and then drops its lowest-priority hint:

- full tier, e.g. `↑↓ select · ←/→ list · ctrl+shift+j/k doc · T search ·
  r reload · o open · esc close` — one labelled token per scroll target, so
  the generic `PgUp/PgDn` and `ctrl+d/u half` hints no longer occupy cells
  (those bindings stay live and are documented in the key tables);
- short tier (`↑↓`, `←/→`, `ctrl+shift+j/k`, …) when the full tier does not
  fit;
- pruning, by priority, when even the short tier does not fit, so
  `esc close` outlives every other hint.

The keys read as keys: every shortcut token is painted with the theme's
`accent` role and emphasised with its `bold`, while its description is
`muted` (and a static label `dim`) — the role table lives once in
`lib/tui-paint.js`, so the two readers cannot drift into two palettes, and a
host theme that is absent or throws degrades to plain text instead of
breaking the row. In a monochrome terminal the roles collapse, and `bold`
alone still separates a key from the words next to it.

The scroll hint is the shared legend, so it names `ctrl+shift+j/k` only when
`isKittyProtocolActive()` returns true and `shift+j/k` otherwise — never a
version guessed from the OS, and never the stale `ctrl+j/k` claim.

There is no `space assign` token and no `ctrl+s save` token on either reader:
a worktree carries no association (S1), so no key exists that would create,
clear or verify one. `ctrl+s` survives only inside the issues editors (label
editor, comment input), where it applies a GitHub edit rather than a worktree
association, and those hints belong to the legend only while that editor holds
the keyboard.

## Buckets, not a paged list (S10, S3)

In the issues reader `tab`, `shift+tab` and `←`/`→` all switch buckets — the
arrows are the tab key, they do not page the list (S10 of
`simplify-worktrees-issue-scroll.md`). The list scrolls with `]`/`[`, and it
is ONE continuous window rather than a pager: no `page n/m` marker exists,
because scrolling to the loaded edge reads the next cursor page instead. A
bucket keeps its own window and focused row, so returning to it restores the
reader's place. The ODD reader has no tabs: it lists one checkout's documents
and scrolls the same continuous window.

## Header: the surface, never an association (S1, S25)

The readers keep a short title and their own scope — `◈ Issues` with its
bucket tabs and counts, `✎ Odd · <n> documents` — and neither repeats the
branch or the checkout name. The three wrapped rows this round introduced
belonged to the retired worktree detail: worktree facts, then the assigned
issue numbers, then the ONE associated ODD document. All three went with the
association (S1). A missing association is therefore not rendered as `0`,
`-` or a vanishing row — there is no such row, no assignment list and no
`odd:` row on any surface any more. The wrapped header row count is still
what the height budget subtracts, so a long title never overflows the frame
and never eats the footer.

## Left list and preview (S3, S5, S15)

The left list takes the smaller 30% share of the reading frame (the reading
pane owns the remaining 70%); the retired worktree detail used its own 40/60
split. The list shows the **full** title or document name wrapped over as many
rows as it needs, names wrapping at hyphens and word boundaries before any
word is split, and the focused row always stays inside the painted window.
The retired detail's third rule — a verbose reason handed in for `modified`
renders as `modified —`, never as the explanation sentence — went with the
facts that needed it: neither reader renders a computed date or an invented
value.

## Refresh (S10)

`r` re-reads the focused issue or document with `{refresh: true}` and replaces
the cached read. A failed refresh is reported in the status row and in the
pane (`refresh failed: …`, `unreadable: …`); the old data is never presented
as refreshed.

## Read-only and purity

Both components perform no filesystem, network or registry access of their
own: their imports are the pure `lib/odd-markdown.js`, `lib/view-layout.js`,
the shared `lib/issue-preview.js` formatter, the shared pure
`lib/preview-scroll-keys.js` key decision and the shared `lib/tui-paint.js`
palette, and every read arrives through injected seams. Neither is handed a
write callback at all: `/herdr-gentle:odd` and `/herdr-gentle:issues` pass no
`assigned`, `saveAssignment` or `assignmentEnabled` option, so opening either
reader performs zero registry writes in every worktree-mode state.
