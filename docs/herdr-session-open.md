# Herdr session opener

`herdr_session_open` opens a **Herdr panel running a Pi session at a path**.
The panel kind follows the path:

| The path is | The panel opened |
| --- | --- |
| a linked Git worktree (a checkout whose `git rev-parse --git-dir` differs from its `--git-common-dir`) | **worktree panel** — `herdr worktree open --path <path>` |
| a repository's primary checkout, including `git init --separate-git-dir` | **normal panel** — `herdr workspace create --cwd <path>` |
| any other existing directory, including a subdirectory of a checkout | **normal panel** — `herdr workspace create --cwd <path>` |

Panel kind is decided from git itself: a **linked worktree** is the only
checkout whose `git rev-parse --git-dir` differs from its `--git-common-dir`.
That holds for a plain repository, for `git init --separate-git-dir` (where
`.git` is a FILE), and for a linked worktree of either — and a path git does
not report as its *own* checkout root is never treated as a worktree, so a
plain directory, a bare repository and a subdirectory all open where the caller
asked. When git reports a repository but cannot name its own directories, the
kind cannot be proven: the tool refuses and opens nothing rather than guessing.

## Identity versus spelling

The requested path is canonicalized (symlinks resolved) **before any side
effect**, and every identity decision uses the canonical path: the panel kind,
the worktree listing match, and the guarantee that the pane's cwd is the target
or inside it. So a symlinked directory or a symlinked worktree resolves to the
directory it really is instead of being refused after Herdr already created a
panel, and a worktree Herdr lists under its real path is still reused when the
caller passed the symlink (no duplicate panel).

The caller's spelling is kept where it is safe and meaningful: a normal panel
opens at the path as requested (`--cwd <requested>`), the default agent name
follows that spelling, and `details.path` / the `path:` row report the
canonical path.

Extension: `extensions/herdr-session-open.ts`
Libraries: `lib/herdr-session-open.js` (path classification, herdr argv,
reply parsers), `lib/herdr-session-notifications.js` (finish subscription)

## What it does, step by step

1. **Resolve the path.** Absolute paths are used as given; a relative path
   resolves against the session's own cwd. The path must exist and be a
   directory, and it is canonicalized (symlinks resolved) before anything else
   happens — identity is settled before any side effect.
2. **Classify it** with one `git rev-parse --show-toplevel` /
   `--git-common-dir` / `--git-dir` triple through the fixed-argv runner:
   linked worktree, primary checkout (separate git dir included), generic
   directory, or `unproven` (git cannot name its own directories → refused, no
   panel).
3. **Open (or reuse) the panel.**
   - Worktree panel: `herdr worktree list --cwd <path>` first. A workspace
     already open for that checkout is reused; two different workspace ids
     claiming it fail closed. Otherwise `herdr worktree open --path <path>
     --no-focus`, and a failed open is re-checked against one fresh list rather
     than assumed to have done nothing.
   - Normal panel: `herdr workspace create --cwd <requested> --no-focus`, where
     `<requested>` is the caller's own spelling of the path.
4. **Verify the pane before starting anything.** The pane Herdr names must
   belong to the workspace it named (the pane id carries its workspace), the
   pane's reported workspace (when reported) must agree, and the pane's `cwd`
   must be the requested path or inside it. A reply that fails any of these is
   refused with nothing started.
5. **Start Pi in it.** `herdr agent start <name> --kind pi --pane <pane>
   --timeout 120000 -- --name <name> --session-id <uuid>` — or `--session <id>`
   when a session id is passed to resume. No `--session-dir` is needed: the
   pane's cwd is already the requested path.
6. **Subscribe to the finish** unless `notify: false` was passed.

The result is compact, ordered `label: value` rows — `outcome`, `path`,
`panel` (`worktree` or `normal`), `branch` (only for a Git checkout), `session`,
`workspace`, `pane`, `agent` — and the same facts ride in `details` as `path`,
`kind` (`worktree` / `primary` / `generic`), `branch`, `paneId`, `workspaceId`,
`sessionId`, `resumed`, `agentName`, `notify`.

## Parameters

| Parameter | Meaning |
| --- | --- |
| `path` (required) | Directory to open the panel in: a Git worktree, a repository checkout, or any other directory |
| `session` | Pi session id to resume; absent mints a new id |
| `name` | Agent/pane name; defaults to the branch for a worktree panel and to the directory name otherwise, sanitized into Herdr's shape |
| `notify` | Subscribe the caller to the finish notification (default `true`) |

Agent names must match Herdr's documented shape — lowercase letters, digits,
dash and underscore, starting with a letter, at most 32 characters
(`^[a-z][a-z0-9_-]{0,31}$`). A name Herdr would reject is refused here, because
the alternative is a launch that fails after a panel already exists.

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
input and never counts as `working`. A pane bound to a *different* Pi session is
never reported as ours, and a launch grace window keeps the delegate's idle
state right after `agent start` from being read as a finish.

The delivery route is the host's own message channel —
`pi.sendMessage({ customType: "herdr-agent-sessions.finished", display: true,
content, details }, { deliverAs: "followUp", triggerTurn: true })` — so the
orchestrator is woken with the outcome instead of having to poll. A send that
throws or rejects is retried, not swallowed; a send that never settles stops the
watcher at the maximum wait.

## Safety checks

- **Fixed argv, never a shell.** Every herdr call is an argument vector, so a
  path or an agent name can never become a command.
- **Closed herdr allowlist.** `herdrArgv` accepts only the operations this tool
  uses (`worktree list`, `worktree open`, `workspace create`, `pane list`,
  `agent start`, `agent get`) and, per operation, only the flags it passes.
  Unknown operations and flags throw. `--trust-repository` is on no allowlist —
  trusting a repository is a human decision this tool never takes — and
  `--focus` is not either: panels open with `--no-focus`.
- **No unsafe guesses.** A missing path, a file instead of a directory, an
  unparseable reply, two workspaces claiming one checkout, a pane that belongs
  to another workspace, a pane whose cwd left the path, a reply that names no
  pane, and a repository whose git directories git cannot name are all
  refusals with no session started. Identity (symlink-resolved) is proven
  before any panel is created, so an identity problem can never leave a stray
  panel behind; a panel Herdr did create before a later reply check failed is
  named in the refusal, never silently retried into a second one.
- **No live-binary trust bypass under a test harness.** When
  `GENTLE_HERDR_SESSION_LIB_DIR` (or an inherited `GENTLE_WORKTREE_LIB_DIR`)
  marks the test harness, `HERDR_BIN_PATH` is honored only when the path proves
  it cannot be a live Herdr (missing, non-executable, or inside the OS temp
  directory), or when the test opts in with
  `GENTLE_HERDR_ALLOW_LIVE_HERDR=1`. Any other inherited path is refused
  instead of spawned.
- **Non-blocking.** Every herdr call and every `agent get` poll runs off the
  event loop with a bounded timeout that reaps the child, so a slow or hung
  daemon cannot freeze the session that opened the panel.

## Relation to the rest of the package

The worktree tools, the ODD panel and the issues panel live in the
`odd-worktree` Pi package; this package keeps the Herdr producer, the Moshi
channel and this opener. The opener reads no worktree registry and shares no
code with `odd-worktree` — it needs only a path.

## Tests

`node --test tools/herdr-session-open.test.js` covers the three path classes
(linked worktree, primary checkout, generic directory including a subdirectory
and a relative path), workspace reuse, the panel verification refusals, the
herdr failures, the finish subscription, the binary-allowlist refusal and the
agent-name rules. `node --test tools/herdr-session-open-paths.test.js` covers
symlinked generic/worktree/primary paths (including worktree reuse through a
symlink), `git init --separate-git-dir` checkouts, and the refuse-before-panel
identity rules. Both drive real fixture repositories and a stub `herdr` binary,
never a live Herdr session.
