# Issue edit permissions

The Issues viewer (`/herdr-gentle:issues`, `lib/issues-view.js`) edits labels and
assignees only when the repository grants the capability. Being signed in to
`gh` grants nothing: authentication is not an edit permission.

## Contract

Issue detail carries `permissions`:

```js
{
  permissions: {
    canEditLabels: true,      // TRIAGE and above: apply/remove existing labels
    canEditAssignees: true,   // TRIAGE and above: add/remove assignees
    canCreateLabels: false,   // WRITE and above: create a new label
  },
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'octo' }],
}
```

Only a literal `true` confirms a capability. A missing field, an unknown role,
a `null` or any non-boolean value reads as **false** — the view never guesses.
`getIssueMetadata` (in `lib/gh-issues.js`) derives the three booleans from
GitHub's `viewerPermission`, and the viewer only receives them when the host
passes `{includeMetadata: true}` to its `loadIssue` seam.

## What the view does with them

| Capability | Footer hint | Key | Effect |
| --- | --- | --- | --- |
| `canEditLabels` | `L labels` | `l` | Opens the label toggle editor |
| `canCreateLabels` | — (row inside that editor) | `n` | Adds the `+ create new…` row and the create action |
| `canEditAssignees` | `a assign` | `a` | Opens the assignee toggle editor |

- An unconfirmed capability removes the hint **and** refuses the key: the
  editor never opens, `loadLabels()` / `loadAssignees()` is never called, and no
  write action runs. The status row says which permission is missing.
- Both editors are toggles. Existing labels and existing assignees start
  selected; selecting adds and deselecting removes. Saves send only the delta:
  `actions.editLabels(number, add, remove, created)` and
  `actions.editAssignees(number, {add, remove})`.
- Creating a label needs `canCreateLabels`. Applying labels that already exist
  needs only `canEditLabels`, so a triage-level viewer sees no create row.
- A rejected save is reported in the status row, keeps the editor open, and
  leaves the issue, the stored selections and the local toggles unchanged. A
  failed save never refetches and never claims success.
- A successful save refetches the detail through `loadIssue(number, {refresh:
  true})`, so the preview shows GitHub's answer instead of the pre-save cache.
- Moving focus to another issue re-evaluates its own permissions: hints and keys
  follow the focused issue, so a permitted issue never leaks an editor onto an
  unpermitted one.

## Assignable users

`loadAssignees()` returns `{ok: true, users: [{login, name}]}` (from GitHub's
`repository.assignableUsers`) or `{ok: false, error}`. It is called on the
assignee editor's first open, never at mount, and a failure is shown in the
editor and retried on the next open. Current assignees missing from that list
are still listed so they can be removed.

## Extension wiring

`executeIssues` (in `extensions/gentle-worktree-tools.ts`) is the only place
that binds these seams to a repository. Every seam carries this checkout's cwd
(`oddCheckoutRoot(ctx.cwd)`), so a session inside a worktree reads and writes
that worktree's issues, never the principal checkout's:

- `loadIssue(number)` calls the real `getIssue(number, {cwd, includeMetadata:
  true})`. The metadata flag is what delivers `permissions`, `assignees`,
  `projects` and `linkedPullRequestCount`; without it every capability reads as
  unconfirmed and no editor opens.
- `loadAssignees()` calls the real `listAssignableUsers({cwd})`.
- `actions.editAssignees(number, {add, remove})` calls the real
  `editAssignees(number, {add, remove}, {cwd})` inside `issuesWrapFailure`, so a
  thrown client becomes `{ok: false, error}` instead of escaping the view.

There is no extra cache at this layer: `getIssue` is always a fresh read, and a
viewer that wants updated data after a successful save asks `loadIssue` again.

## Tests

`tools/issues-view.test.js`, suite `S16: repository permissions gate the label
and assignee editors`, covers: hint presence for confirmed/absent/unknown
permissions, refused keys with no loader and no write, prefill plus add/remove
deltas, the `canCreateLabels` split from `canEditLabels`, a rejected save
keeping editor and toggles, the refresh-after-save, and no permission leakage
when focus moves.

`tools/issues-command.test.js`, suite `mounted wiring (S8,S16)`, captures the
options the extension mounts the view with and proves the seams above reach the
real exported client helpers: `listAssignableUsers` and `getIssue` with this
checkout's cwd and `includeMetadata: true`, `editAssignees` writing the delta as
one fixed argv, and a read-only repository role being refused with no `gh issue
edit` reaching the runner at all.
