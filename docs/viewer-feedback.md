# Viewer feedback round — ODD reader and worktree detail

Behaviours implemented for the user's tested complaints about the ODD reader
and the worktree detail surface (spec `odd/tasks/worktree-ui-feedback.md`,
S1, S3, S5, S10, S11, S15). The round-3 corrections that superseded part of
that round (`odd/tasks/ui-consistency-round3.md`: shared key decision,
40/60 split, header order, fixed page marker) are folded into the sections
below. Each item is covered by a public input/output test; no item claims a
live-host result.

**Verification status:** all of this is verified with unit tests only
(`node --test tools/worktree-detail-view.test.js`, `tools/odd-view.test.js`,
`tools/issues-view.test.js`, `tools/preview-scroll-keys.test.js`,
`tools/view-layout.test.js`). Some tests replay the installed Pi 1.4 key
matcher on raw bytes, but that is still a library call, not a manual run in a
real terminal on real hardware. Keyboard behaviour in a real host, on a real
terminal and on the user's machine is **not** claimed as verified.

## Preview scrolling through the shared key decision (S1)

Paging the preview is one shared decision (`lib/preview-scroll-keys.js`) used
by ODD, Issues and this detail, so the handler and the footer cannot
disagree. `ctrl+shift+j/k` pages when the host confirms the extended
keyboard protocol, printable `Shift+J/K` is the fallback on a legacy
terminal, `PgDn`/`PgUp` always page, and `ctrl+d`/`ctrl+u` move half a page.
Lowercase `j`/`k` only select list rows. Bare LF/CR and the legacy Ctrl+J/K
bytes are not preview-scroll aliases; the byte the installed host matcher
reports as both `ctrl+j` and `enter` keeps its Enter meaning here, so it
selects the focused ODD document instead of paging.

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

- full tier, e.g. `↑↓ move · tab Issues/ODD · ←/→ page · space assign ·
  ctrl+shift+j/k scroll · PgUp/PgDn · ctrl+d/u half · T search · r refresh ·
  ctrl+s save · esc`;
- short tier (`↑↓`, `space`, `ctrl+shift+j/k`, …) when the full tier does not
  fit;
- pruning, by priority, when even the short tier does not fit.

`tab Issues/ODD` and `←/→ page` are spelled out in **both** tiers and carry
the highest priorities, because conflating "switch datasets" with "page the
active list" was the reported confusion. At 40 columns (36 inner cells) the
footer row reads `tab Issues/ODD · ←/→ page · esc`; the short tier from 60
columns adds `↑↓`, `space` and `ctrl+s`, and the verbose verbs return only at
about 150 columns.

The scroll hint is the shared legend, so it names `ctrl+shift+j/k` only when
`isKittyProtocolActive()` returns true and `shift+j/k` otherwise — never a
version guessed from the OS, and never the stale `ctrl+j/k` claim.

## Tabs and paging (S11/D3)

`tab`/`shift+tab` switch between the Issues and ODD datasets. `←`/`→` page the
active list only and never switch tabs. A page holds as many whole items as
the body budget allows once every title is wrapped, so capacity follows the
terminal instead of a fixed item count.

## Header: three wrapped logical rows (S11, S6)

The header keeps three separate data rows, in the order the reader asked for,
and lets each wrap to the number of terminal rows it needs:

1. the worktree details (branch, changes, ahead/behind, created, modified);
2. the assigned issue numbers, `#`-prefixed and comma-separated
   (`issues: #76, #77`);
3. the ONE associated ODD document by name alone (`odd: alpha`), never its
   path.

A missing association renders `-` in its own row, never `0` and never a
vanishing row. The wrapped row count is what the height budget subtracts, so
a long assignment list never overflows the frame and never eats the footer:
the header is clipped only when the terminal is too short to hold the frame at
all, and the body keeps at least one row.

## Left list and preview (S3, S5, S15)

The left list takes the 40% share of the shared 40/60 split (the preview owns
the larger 60%) and shows `[ ]`/`[x]` plus the `#`-prefixed number and the
**full** title wrapped over as many rows as it needs, with ODD names wrapping
at hyphens and word boundaries before any word is split. Facts are brief: a
verbose reason handed in for `modified` renders as `modified —`, never as the
explanation sentence, and no date is invented.

## Refresh (S10)

`r` re-reads the focused issue or document with `{refresh: true}` and replaces
the cached read. A failed refresh is reported in the status row and in the
pane (`refresh failed: …`, `unreadable: …`); the old data is never presented
as refreshed.

## Read-only and purity

The component performs no filesystem, network or registry access: its imports
are the pure `lib/odd-markdown.js`, `lib/view-layout.js`, the shared
`lib/issue-preview.js` formatter and the shared pure
`lib/preview-scroll-keys.js` key decision, and every read/write arrives
through injected seams. A rejected save reports `save failed: <reason>` and
preserves the draft. Verified initialization may update a clean assignment
baseline, but never overwrites a dirty selection; pending or failed
initialization blocks saving rather than inventing an empty baseline.
