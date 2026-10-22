# Worktree times: created and modified (S12)

`created` and `modified` are the two ages every worktree surface shows (warp
data line, focused row, detail header). This document records **where those two
values come from** — the derivation in `lib/checkout-facts.js` and
`lib/worktree-git.js`. How they are rendered is not repeated here: the views
already format a timestamp as a relative age (`1d`, `2hr`, `1w`, `1m`) and
accept either an epoch-ms number or an ISO string, so the facts below stay
strings/epochs.

## Two facts, one envelope each

`createdAt` and `lastActivity` are separate facts with the same envelope as
every other fact of the checkout:

```js
{ available: true,  value: '<ISO timestamp>', reason: null, source: '<provenance>' }
{ available: false, value: null,              reason: '<why>', source: null }
```

Nothing is ever a zero time and never an absolute date rendered as such. The
`source` field names which answer came back, so a reader (and a test) can tell a
recorded registration from a filesystem birth time from git history.

## The two kinds of checkout

The rule depends on the **kind** of checkout, because the two kinds have
genuinely different histories.

**Principal** — the checkout `git worktree list` prints FIRST. That is git's
documented order (the main worktree first), so the principal is never "the
checkout this process happens to run in" and never deduced from a branch name:
a session running inside a linked worktree still resolves the real principal,
and nothing assumes `main` or `master` exists.

| fact | derivation | `source` |
| --- | --- | --- |
| created | oldest root-commit committer timestamp of the history reachable from `HEAD` | `root-commit` |
| modified | newest of the last commit and the newest still-existing uncommitted file | `commit` / `dirty` |

Read as one fixed-argv call, `git log --max-parents=0 --format=%ct HEAD`, which
prints one line per root commit. A history with several independent roots (an
unrelated branch merged in) is answered with the **minimum**, so the answer is
deterministic and does not depend on the order git prints them in. The last
commit is `git log -1 --format=%ct HEAD`, as before.

**Linked worktree** — every other checkout.

| fact | derivation | `source` |
| --- | --- | --- |
| created | the registry row's `createdAt` when it parses as a date, else the checkout directory's birth time | `registry` / `birthtime` |
| modified | same rule as the principal, with inherited commits dropped (below) | `commit` / `dirty` |

The registry's discovery timestamp (`registeredAt`) is **never** used for
`createdAt`: recording that a checkout was discovered says nothing about when
it was created. A row whose `createdAt` is missing or unreadable falls through
to the directory's birth time, and the `source` says so.

An **inherited commit** — one older than the checkout's own creation — is not
local modification: it is dropped, and with no local evidence left `modified` is
unavailable rather than a date before the checkout existed.

## What Git cannot expose, so it is never invented

- **Git records no checkout or worktree creation time.** `git worktree list` has
  no birth field, so a linked worktree's creation is only knowable from the
  registry or the directory itself — never read out of git.
- **The root commit is when the first commit was made**, not when the repository
  or the project directory was created, and it moves if history is rewritten
  (rebase, amend, graft). It is the only beginning git records.
- **Only `HEAD`-reachable history counts.** A root commit on a branch that was
  never merged in is invisible to both reads.
- **Commit timestamps are whole seconds** and filesystem mtimes come from the
  filesystem: a copy, restore or checkout can reset an mtime.
- **With no readable `git worktree list`, the kind is unknown** and the checkout
  is never treated as the principal — the git-project-beginning answer is never
  claimed without evidence.

## Failure is unavailable, never an estimate

- The principal with no commit yet (an initialized repository) has no creation
  time: `createdAt` is unavailable with the reason from the failed read, and the
  directory's birth time is **not** substituted for it.
- A checkout whose dirty summary or commit read fails reports the reason and
  keeps `value: null`; the other facts (branch, issues, odd, changes,
  ahead/behind) are unaffected, exactly as before.

## Cost

The oldest-root-commit read runs only for the principal, and only inside the
cached per-path read (`lib/checkout-facts.js`'s TTL and in-flight sharing), so a
selector repainting per keystroke does not pay for it again. Linked worktrees pay
nothing extra.
