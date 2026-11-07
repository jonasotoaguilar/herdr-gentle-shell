# Herdr Pi session opener

`worktree_session_open` opens a Pi session **inside a registered agent
worktree** through Herdr, and leaves the session running there. It is the one
worktree tool this package keeps: worktree creation, listing, closing, warp,
the ODD panel and the issues panel moved to the `odd-worktree` Pi package, and
the Customize panel is gone. Nothing here is gated by a plugin-tools toggle any
more — there is no toggle left to read, so the tool is always registered.

Extension: `extensions/herdr-session-open.ts`
Libraries: `lib/herdr-session-open.js` (resolution, herdr argv, reply parsers),
`lib/herdr-session-notifications.js` (finish subscription)

## What it does, step by step

1. **Resolve the name.** The single `worktree` argument accepts the name the
   worktree listing prints (the flattened branch slug), a branch spelling, or
   the absolute path of a registered worktree. Name resolution runs first; the
   path leg only accepts a path that exists, is a directory, is a live checkout
   `git worktree list` reports, and belongs to a registry row by resolved
   identity.
2. **Prove the target is an agent worktree.** The registry row must be
   registered, **live** (the checkout exists, is a directory, and git still
   records it) and must not be the **principal** checkout — a session in the
   principal delegates nothing.
3. **Find or open its Herdr workspace.** `herdr worktree list --cwd <root>`
   names the workspace already open for that branch or path. When none is open,
   `herdr worktree open --branch <branch> --cwd <root> --no-focus` opens one.
   Two different workspace ids claiming the same worktree fail closed.
4. **Choose the root pane, and verify it.** The lowest-numbered pane of *that*
   workspace, whose reported `cwd` is the worktree or inside it. A pane of
   another workspace is never used, even when Herdr lists it first.
5. **Start Pi in it.** `herdr agent start <name> --kind pi --pane <pane>
   --timeout 120000 -- --name <name> --session-id <uuid>` — or `--session
   <id>` when a session id is passed to resume. No `--session-dir` is needed:
   the pane's cwd is already the worktree.
6. **Subscribe to the finish** unless `notify: false` was passed (see below).

The result is compact, ordered `label: value` rows (`outcome`, `worktree`,
`branch`, `path`, `session`, `workspace`, `pane`, `agent`), and the same facts
ride in `details`, so a caller can reach the session it just started.

## Parameters

| Parameter | Meaning |
| --- | --- |
| `worktree` (required) | Worktree name, branch spelling, or the absolute path of a registered worktree |
| `session` | Pi session id to resume; absent mints a new id |
| `name` | Agent/pane name; defaults to the worktree name. Letters, digits, dot, underscore, dash — never starting with `-` |
| `notify` | Subscribe the caller to the finish notification (default `true`) |

## The finish notification

With `notify` left on, the opener starts **one** watcher for the pane it just
opened and polls `herdr agent get <paneId>` on a bounded interval:

- **finished** — `agent_status` reads `idle` *after* that same pane was observed
  `working` at least once;
- **never-started** — the pane went idle without ever reporting `working`;
- **vanished** — the agent is gone (`agent_not_found`);
- **timed-out** — nothing conclusive before the maximum wait (four hours by
  default).

Only `finished` claims a finish. `blocked` means the delegate is waiting for
input and never counts as `working`. A pane bound to a *different* Pi session
is never reported as ours, and a launch grace window keeps the delegate's idle
state right after `agent start` from being read as a finish.

The delivery route is the host's own message channel —
`pi.sendMessage({ customType: "herdr-agent-sessions.finished", display: true,
content, details }, { deliverAs: "followUp", triggerTurn: true })` — so the
orchestrator is woken with the outcome instead of having to poll. A send that
throws or rejects is retried, not swallowed; a send that never settles stops
the watcher at the maximum wait.

## Safety checks

These are the checks the pre-split worktree tools carried, and every one of
them is still enforced:

- **Registered, live, non-principal only.** An unregistered live checkout, a
  stale registry row, an unknown name and the principal checkout are all
  refused before any backend runs, and nothing is mutated.
- **Never a path-free guess.** An explicit or relative path that is not a
  registered worktree is refused with the actionable message.
- **Herdr argv is a closed allowlist.** `herdrArgv` accepts only the
  operations this tool uses (`worktree list|open`, `pane list`, `agent
  start|get`) and, per operation, only the flags it passes. Unknown operations
  and flags throw, and `--trust-repository` and `--focus` are not on any
  allowlist: trusting a repository is a human decision, and this tool only
  opens workspaces with `--no-focus`.
- **Fixed argv, no shell.** Every herdr call is an argument vector; a branch
  name, path or agent name can never become a command. An agent name that Herdr
  would read as an option (starting with `-`) is refused.
- **No live-binary trust bypass under a test harness.** When
  `GENTLE_HERDR_SESSION_LIB_DIR` (or an inherited `GENTLE_WORKTREE_LIB_DIR`)
  marks the test harness, `HERDR_BIN_PATH` is honored only when the path proves
  it cannot be a live Herdr (missing, non-executable, or inside the OS temp
  directory), or when the test opts in with
  `GENTLE_HERDR_ALLOW_LIVE_HERDR=1`. Any other inherited path is refused
  instead of spawned.
- **Non-blocking.** Every herdr call and every `agent get` poll runs off the
  event loop with a bounded timeout that reaps the child, so a slow or hung
  daemon cannot freeze the session that opened the delegate.

## What it needs from `odd-worktree`

The registry this tool reads is the one the `odd-worktree` package writes:
`pi-worktrees.json` beside the repository's git common dir, holding
`{ version, worktrees: [{ branch, path }] }`. A missing file is an empty
registry (so every name is refused); an unreadable or malformed file is a
refusal that names the problem, never a silently empty registry. The two
packages share that file format, not code: this package keeps no dependency on
`odd-worktree`.

## Tests

`node --test tools/herdr-session-open.test.js` covers registration, the scope
guard, workspace reuse and creation, the exact herdr argv, the finish
subscription and the binary-allowlist refusal, against real fixture
repositories and a stub `herdr` binary — never a live Herdr session.
