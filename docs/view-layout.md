# Shared reader layout

`lib/view-layout.js` is a pure layout module shared by Issues, ODD and worktree
detail. It performs no I/O and changes no assignments.

- `paneWidths` allocates roughly half the inner frame to the list while retaining
  a readable preview. Old 34/36-column caps are not part of the rule.
- `wrapLabel` accounts for selection markers and breaks overwide words.
- `rowCost` measures wrapped rows; `paginate` groups whole items by that budget.
- `pageOf` and `pageForIndex` resolve page boundaries without dropping items.

The viewport owns the budget; there is no fixed 20-item page. Callers retain
responsibility for their header/footer reservations and terminal clipping.
Structural and width/budget boundaries are covered by `tools/view-layout.test.js`.
