# Viewer feedback round — ODD reader and worktree detail

Behaviours implemented for the user's tested complaints about the ODD reader
and the worktree detail surface (spec `odd/tasks/worktree-ui-feedback.md`,
S1, S3, S5, S10, S11, S15). Each item below is covered by a public
input/output test; no item claims a live-host result.

**Verification status:** all of this is verified with unit tests only
(`node --test tools/worktree-detail-view.test.js`, `tools/odd-view.test.js`,
`tools/view-layout.test.js`). One test replays the installed Pi 1.4 key
matcher on raw bytes, but that is still a library call, not a manual run in a
real terminal on real hardware. Keyboard behaviour in a real host, on a real
terminal and on the user's machine is **not** claimed as verified.

## Keyboard scrolling through the real input path (S1)

`ctrl+j`/`ctrl+k` reach the component as a bare `0x0a` / `0x0b` byte, and the
installed host matcher reports `0x0a` as **both** `ctrl+j` and `enter` while
the Kitty protocol is inactive. The detail view therefore resolves the scroll
keys before the `enter` alias, so `ctrl+j` scrolls the preview instead of
being swallowed as "select". A real Enter still arrives as `\r` and still
selects.

The scroll offset is clamped inside the key handler, not only in the next
render: `state.scroll` never reports a negative or past-the-end value that the
reader could observe before a repaint. Equivalent keys: `pageup`/`pagedown`,
`ctrl+d`/`ctrl+u`, `J`/`K`.

## Footer legend (S4, S11)

Every hint lives on **one** footer row and nowhere else. The row has two
tiers and then drops its lowest-priority hint:

- full tier, e.g. `↑↓ move · tab Issues/ODD · ←/→ page · space assign ·
  ctrl+j/k scroll · T search · r refresh · ctrl+s save · esc`;
- short tier (`↑↓`, `space`, `⌃j/k`, …) when the full tier does not fit;
- pruning, by priority, when even the short tier does not fit.

`tab Issues/ODD` and `←/→ page` are spelled out in **both** tiers and carry
the highest priorities, because conflating "switch datasets" with "page the
active list" was the reported confusion. At 40 columns (36 inner cells) the
footer row reads `tab Issues/ODD · ←/→ page · esc`; that width cannot also
hold `space` and `ctrl+s`, so those appear from 60 columns up and the verbose
verbs from 120 columns up.

## Tabs and paging (S11/D3)

`tab`/`shift+tab` switch between the Issues and ODD datasets. `←`/`→` page the
active list only and never switch tabs. A page holds as many whole items as
the body budget allows once every title is wrapped, so capacity follows the
terminal instead of a fixed item count.

## Header: three wrapped logical rows (S11)

The header keeps three separate data rows and lets each wrap to the number of
terminal rows it needs:

1. the worktree details (branch, changes, ahead/behind, created, modified);
2. the one assigned ODD document — name and path;
3. the assigned issue numbers, comma-separated, wrapping onto extra rows when
   there are many.

The wrapped row count is what the height budget subtracts, so a long
assignment list never overflows the frame and never eats the footer: the
header is clipped only when the terminal is too short to hold the frame at
all, and the body keeps at least one row.

## Left list and preview (S3, S15)

The left list takes about half the inner width (shared rule in
`lib/view-layout.js`), shows `[ ]`/`[x]` plus the **full** title wrapped over
as many rows as it needs, and carries **no issue number**; the number stays in
the preview header (`#12 title`). Facts are brief: a verbose reason handed in
for `modified` renders as `modified —`, never as the explanation sentence, and
no date is invented.

## Refresh (S10)

`r` re-reads the focused issue or document with `{refresh: true}` and replaces
the cached read. A failed refresh is reported in the status row and in the
pane (`refresh failed: …`, `unreadable: …`); the old data is never presented
as refreshed.

## Read-only and purity

The component performs no filesystem, network or registry access: its only
imports are `lib/odd-markdown.js` and the pure `lib/view-layout.js`, and every
read/write arrives through injected seams. A rejected save reports
`save failed: <reason>` and changes nothing locally; the initial assignment and
the ODD association are only replaced by a successful save.
