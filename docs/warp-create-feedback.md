# Two-field bottom creation

Warp's `c` action opens a compact bottom interaction, not a centered popup.
Only **type** and **name** are collected; human creation has no Issues/ODD
selectors. Agent tools retain their independent optional associations.

| Action | Keys |
| --- | --- |
| Choose type from the inline list | `↑` / `↓` |
| Switch type/name fields | `tab`, `shift+tab`, `←` / `→` |
| Advance / confirm | `enter` |
| Create from either field | `ctrl+s` |
| Cancel without mutation | `esc` |

A printable character on the type list starts the name. Branch and path previews
appear **above** the fields and use the existing Git validators and canonical
worktree-path helper. Invalid names show the refusal, never a guessed path.
The result remains `{ok:true,type,name}`; no association state is added.

The view derives content height from its fixed rows and visible type-list rows.
A terminal too short for the form gets an enlargement message rather than an
overflow. `warpCreateAndEnter` mounts with `WARP_PANEL_OVERLAY`: bottom-center,
100% width, no margin, maximum 24 rows. Editing uses the separate fullscreen
worktree detail, never this create flow.

Cancel, field navigation and typing create no branch, checkout or registry write.
Only confirmation enters the guarded creation path; creation precedes the single
registry write. Tests exercise the real validators, selected type, payload and
public warp flow. Physical-terminal proof is tracked separately.

Tests: `tools/warp-create-panel.test.js`, creation cases in
`tools/warp-selector.test.js`, and the bottom-mount/cancel case in
`tools/worktree-detail-command.test.js`.

See [warp-selector-feedback.md](warp-selector-feedback.md) for delete/search
shortcuts and concise unavailable facts.
