# Fresh issue pages and permission-aware metadata

`getIssuePage({query, after, first}, opts)` performs fresh GraphQL search using
repository scope, open issues and last-updated ordering. `first` is a caller's
viewport-derived upper bound (1–1000), not a fixed page length. Requests above
GitHub's 100-row connection size are split without losing per-issue `cursor`
values. The view must advance after the last **displayed** issue, not the final
unused fetched row. Search sets above GitHub's 1000-match limit fail explicitly;
they are never presented as complete. Existing full-snapshot reads are unchanged.

`listAssignableUsers(opts)` traverses the repository's actual assignable-user
connection. It returns `{ok, users:[{login,name}]}`, deduplicates logins and rejects
non-advancing or malformed pages. It does not approximate collaborators from
issue authors.

`getIssue(number, {...opts, includeMetadata:true})` adds `issue.permissions`, all
assignees, nonempty `projects:[{title,url}]` and a nonzero
`linkedPullRequestCount` when accessible. This count uses GitHub's linked closing
PR references, including closed PRs, not arbitrary mentions. Optional metadata
failure is available as `issue.metadataError`; it is not proof of no relations.
Default detail calls retain their existing shape and request behavior.

Permissions use GitHub's repository role: Triage/Write/Maintain/Admin can apply
existing labels and edit assignees; creating labels requires Write or higher.
Unknown permissions deny editor entry. The view must gate both keys and hints,
and preselect existing values. See [GitHub's repository-role matrix](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization).

`editAssignees(number,{add,remove},opts)` validates before subprocesses, confirms
the current role and uses fixed `gh issue edit` argv. Both lists are toggles;
rejected saves are failures, never optimistic local success. GitHub remains the
final authority if permissions change between checking and saving.

Project visibility needs separate token scopes. The read-only live probe found
that this session lacks `read:project`; project errors therefore do **not** disable
confirmed triage permissions, assignees or linked PR counts. No token scopes or
live issues were changed. UI wiring and real-host input verification are separate.
