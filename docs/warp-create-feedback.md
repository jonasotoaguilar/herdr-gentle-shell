# Tabbed bottom creation

Warp's `c` action opens a compact bottom interaction, not a centered popup.
The **Type · Name** tab strip shows only the active field below it. Human
creation has no Issues/ODD selectors; agent tools retain their independent
optional associations.

| Action | Keys |
| --- | --- |
| Choose type from the inline list | `↑` / `↓` |
| Switch Type/Name tabs | `tab`, `shift+tab`, `←` / `→` |
| Advance to Name / create | `enter` (the only create key) |
| Cancel without mutation | `esc` |

A printable character on the type list starts the name. Branch and path previews
appear **above** the tabs and are derived from the repository's own convention
helpers — the branch slug, the published branch format and the canonical
principal-anchored worktree path — over one memoized repository identity, so no
`git` child runs while the human types (S1): the live preview used to run
`git check-ref-format` from `render()`, so every typed character froze Pi for the
child's whole lifetime. The authoritative branch check therefore belongs to the
create path, which awaits it
(`worktree_create` → `validateBranchAsync`) and refuses an invalid branch with
its own message and nothing created.

Until a valid candidate can be derived, both previews
remain neutral (`-`), not red errors. A refused submission shows the reason
below the active field, never a guessed path.
The result remains `{ok:true,type,name}`; no association state is added.

The view derives content height from its fixed rows and visible type-list rows.
A terminal too short for the form gets an enlargement message rather than an
overflow. `warpCreateAndEnter` mounts with `WARP_PANEL_OVERLAY`: bottom-center,
100% width, no margin, maximum 24 rows. There is no editing surface any more:
a worktree is created here and never modified from the warp popup.

Cancel, field navigation and typing create no branch, checkout or registry write.
Only confirmation enters the guarded creation path; creation precedes the single
registry write.

When the invoking checkout has uncommitted work, confirmation asks ONE question
before anything is written — the same `YES COPY` / `NO COPY` choice, through the
same shared helper, that a dirty warp asks: carry the pending changes into the
new worktree, or create it empty from the base commit. `Esc`/`Ctrl+C` at that
question cancels the creation with nothing written (no branch, no checkout, no
registry row) and returns to the selector, exactly like `esc` on the panel. The
answer is the create path's own `changes` selection (`"all"` or `"none"`), so
the transfer and its refusals — an unknown file, a destination that already
modifies a selected path — stay in one place. A clean checkout is never asked,
and only a POSITIVE "nothing pending" answer skips the question: if the pending
changes cannot be read at all (a broken index, a failed `git status`/`git diff`,
a missing helper), the creation fails closed — the reason is reported once, no
branch/checkout/registry row is written, and the selector comes back — rather
than creating a worktree that silently leaves the human's pending work behind.
The create's own `changes` accepts exactly `"all"`, `"none"` or a list of file
paths (an empty/whitespace-only string is refused, an empty list is legal);
the warp command's optional `changes` keeps its older rule (omitted, `""` or
`[]` copy nothing), which a separate test pins.
Every new branch is born from local `main` (S2) — a repository with no local
`main` refuses the creation in plain words and writes nothing (adoption of an
existing branch needs no base) — which is also why a pending change written
against another branch's tree can be refused by the dry-run: the worktree is
created, the copy is reported as failed, and neither is hidden.

Creation ends there (S7). The panel closes into the **selector**, freshly read,
with the checkout just made as a row like any other; nothing warps
automatically, and `esc` on that returned selector moves nothing. That pick is
the flow's one warp. A refused creation closes the same way and reports why: the
create path's own words reach the human verbatim (a tool result carries its text
in `content[].text`, so the refusal is never notified as an empty message),
with no branch, checkout or registry row created. A CANCEL (`esc` in the panel)
closes the same way too: the form is discarded silently and the selector returns,
so "close and go back to Warp" is the same gesture whether the creation succeeded,
was refused, or was abandoned. Tests exercise the real helpers, the selected type, the
payload and the public warp flow. Physical-terminal proof is tracked separately.

Tests: `tools/warp-create-panel.test.js`, creation and pending-change cases in
`tools/warp-selector.test.js`, the selection and base cases in
`tools/worktree-create-tool.test.js` and `tools/worktree-create.test.js`, the
bottom-mount/cancel case in `tools/worktree-detail-command.test.js`, and the
host-loop budget (creation and copy) in `tools/worktree-blocking-budget.test.js`.

See [warp-selector-feedback.md](warp-selector-feedback.md) for delete/search
shortcuts and concise unavailable facts.
