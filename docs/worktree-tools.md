# Agent worktree tools (`worktree_*`)

Five Pi extension tools plus one mode command, so an agent can manage its
own checkouts the way `~/.pi/agent/AGENTS.md` prescribes — a session owns the
checkouts it creates and may own several at once (S9) — and open delegated Pi
sessions inside those checkouts — without hand-rolled `git worktree` argv. Everything below is
checkable against `extensions/gentle-worktree-tools.ts` and
`lib/worktree-*.js`; nothing here is plan, only code.

## Tools

All five are registered with `pi.registerTool()` from
`extensions/gentle-worktree-tools.ts` (listed in the Pi package's
`pi.extensions`). Failures return `isError: true` with structured
`details`; success output is terse, one line per worktree at most. Every
tool draws its own native compact/expandable card (`lib/worktree-card.js`
through `renderShell: "self"`): one git-branch glyph (⎇) and the
warning theme role — the closest documented role to git orange, since the
Pi theme schema exposes no orange — on the opening rule, the `ctrl+o to
expand`/`to collapse` hint right-aligned on that SAME opening rule (the
card's top, where the eye starts), and the evidence-backed duration
alone right-aligned on the closing rule. The two corners carry one fact
each: the hint says how to open the card, the bottom-right says how long
the call took — `NNNms` under a second, `N.Ns` above it. The duration is
read only from the host's `ToolRenderContext.durationMs`, so a card with no
lifecycle timing evidence shows a bare closing rule and never a fabricated
or placeholder time. Collapsed bodies identify the action and outcome only:
create states ONLY its status row (`status: created`, or
`status: already existed` for the requested branch that was already there —
S8); list says `listed: N checkouts` without inferring the current checkout
from array order; close says `removed:` plus branch kept/deleted; session open
names its worktree/session and a resume; warp names the source and
destination. Expanded bodies use ordered labelled rows for paths, branches,
status and warnings, rather than repeating raw output dumps: the create card
is `status:`, `path:`, `registered:` and `codegraph:` — no `name:` and no
`branch:` row, because the name is implied by the path and the branch is the
tool's own input (S8); a listing entry is its identity — name, branch, path
and thread — and no card row carries an issue number or an ODD document,
since a worktree carries neither. Failure diagnostics remain visible.

S6 makes the expanded listing a LIST instead of one coupled column of label
rows: every checkout is its own block (`<name> · <branch>`, then `path:`,
then `thread:` when it has one), and exactly one blank row separates each
block from the next — never a trailing one. Being listed IS the checkout's
existence proof (a row whose path is gone is pruned and never listed), so the
expanded body prints no `status: live`/`status: exists` row at all; the
statuses that DO carry information ride the trailing cell of the entry's own
identity row instead of costing a row each: `<name> · <branch> · missing` (the
path exists but git no longer lists the checkout) and
`<name> · <branch> · unregistered` (a live checkout the registry does not own,
only with `all: true`). The count row `checkouts: N` still leads, and the
collapsed card is unchanged (`listed: N checkouts`). The card is only the
human half: the agent-facing listing is minimized the same way in
`lib/worktree-model-result.js` (see "Model-facing listing text" below), and
`details.worktrees[]` keeps `status` and `kind` byte for byte, so a caller
still gets the structured facts neither display repeats.

The cards follow gentle-shell's float recipe (`gentle-shell/lib/shell-card.ts`,
`CARD_STYLE.FLOAT`): one-column transparent margins, every row padded to the
full target width, a blank padding row above the heading and between heading
and body, and every row painted behind the tone background (`toolSuccessBg`
for info/success, `toolPendingBg` for warning, `toolErrorBg` for error —
`customMessageBg` is used nowhere in gentle-shell), re-armed after every inner
reset; a theme without the role, or a width under 10, keeps the outlined
card; the hint rides the heading band's right edge, and the duration rides the
closing rule only when it fits, never as a placeholder dash. The agent-facing
text stays precise and
short; the longer prose lives in `details` and the expanded view.

## Expanding a card: keyboard, click, and the host mouse contract

`ctrl+o` (`app.tools.expand`) is the key path and stays the single source of
truth: it toggles the transcript's expanded state, both card renderers are
re-invoked with it, and the hint flips between `to expand` and `to collapse` as
the body swaps between the compact rows and the formatted detail. The card
itself keeps no expansion state, so nothing can drift from the host's flag.

Clicking the hint is supported through an OPT-IN seam in
`lib/worktree-card.js`: `createWorktreeCardRenderer(tool, { …, toggleExpanded })`
and `createWarpMessageRenderer({ …, toggleExpanded })` accept a callback, and
only when it is injected does the returned component expose a `handleMouse`.
The callback is the host's own toggle (both methods are part of the extension
UI contract, `getToolsExpanded()`/`setToolsExpanded()`), and the extension
wires it to the CURRENT session's `ctx.ui`:

- A render hook receives theme plus `ToolRenderContext` only — never an
  `ExtensionContext` — and the message renderer is registered at load, before
  any session exists. So `extensions/gentle-worktree-tools.ts` remembers the
  session's `ui` handle on `session_start` and drops it on `session_shutdown`,
  and the injected callback reads that handle when the click arrives, calling
  `ui.setToolsExpanded(!ui.getToolsExpanded())`.
- Nothing outlives its session. The handle is replaced on every session start,
  so a card re-rendered after a switch toggles the session that is live, never
  a context the runtime has already invalidated; `ctrl+o` and a click therefore
  drive the same flag and cannot disagree.
- A session with no usable UI injects nothing, so those cards keep exactly the
  previous component (`render`/`invalidate`, no `handleMouse`) and stay
  keyboard-only: `hasUI: false` (json/print mode), or a `ui` missing either
  expansion method (an older host or a test double). With the seam present the
  rendered bytes are unchanged, which is what makes this safe to inject only
  when there is something to toggle.

The seam's shape is dictated by how the installed host routes mouse input:

- Both host shells DO reach a renderer component. Tool cards: `MouseRegion`
  wraps the call and result components (`renderShell: "self"` included) and
  dispatches to its child first. Message cards: `CustomMessageComponent` is a
  `Container`, and containers forward a mouse event to the child component
  with a row offset (`pi-tui` `Container.handleMouse`).
- A click is delivered to the component that CLAIMED the press. `tui-alt-screen`
  records `mousePressTarget` from the press dispatch result and, on release at
  the same cell, synthesizes a `click` retargeted to that exact component — so
  the press must return `{ handled: true }` or the click never arrives. The
  card's press reply is `{ handled: true, render: false }`: it claims the
  gesture without a repaint, keeping the row it just measured valid.
- The card claims ONLY the hint's own cells — the rectangle is read back from
  the rendered line it was drawn on, so it follows the real geometry (float
  heading band, `outputPad` margin, wrapped heading) — and only for a LEFT
  `press`/`click`. The toggle fires on the click, never on the press. Every
  other event (right/middle button, wheel, move, drag, release, any cell
  outside the hint, a narrow card that dropped the hint) returns `undefined`,
  so outside the hint the host's own behavior is untouched: its `MouseRegion`
  toggle, text selection and OSC 8 links work exactly as before. On the hint
  cells themselves the card is the only responder — the host region does not
  toggle a second time — and a press there does not start a text selection.
- A card with no rendered hint advertises no click region at all, which is why
  a still-running call is keyboard-only until it settles and why a card too
  narrow to show the hint cannot be clicked open.

Mode limitation, stated plainly: Pi routes mouse events to components only in
fullscreen mode (`tuiMode: "fullscreen"`, the default; see `docs/tui.md`).
Regular mode leaves mouse input to the terminal because the terminal owns
scrollback, so a click there scrolls or selects text instead of toggling a card
— and nothing in a renderer can change that. In every mode `ctrl+o` works, and
the rendered card is byte-identical whether or not the toggle callback is
injected.

The registered tool result text is built from the SAME `details` object by
`lib/worktree-model-result.js` (`formatWorktreeModelResult`): ordered
`label: value` rows, one fact per row, no `key=value` dump, no repeated tool
name, no truncation, and every untrusted value folded onto one escape-free
line. A failure, a partial result, or details that cannot describe the
outcome are returned UNCHANGED, so diagnostics never turn into a fabricated
success row. The presentation adapter only rewrites text content: `details`,
`isError` and non-text content pass through untouched, and the exported
`executeWorktree*` helpers keep the terse line format the commands and the
backend tests pin. The
declared `min_herdr_version` in `herdr-plugin/herdr-plugin.toml` tracks
the version this code has actually been exercised against: `0.9.4`,
verified read-only (`herdr --version`, `herdr plugin list --json`, and
`--help` for every command the plugin depends on — `plugin list`,
`plugin install`, `plugin update`, `worktree list`, `worktree create`,
`worktree remove`, `worktree open`, `pane list`, `agent start`, `agent get`,
`agent list` — all present with the flags the
allowlist uses). It is never lowered to a version that cannot be tested.

| Tool | Parameters | Approval | Success text |
| --- | --- | --- | --- |
| `worktree_create` | `branch: string` (required), `changes: "all" \| "none" \| string[]` (**required** — the pending changes of the invoking checkout to carry into the new worktree: `"all"` copies every uncommitted change, `"none"` copies nothing so the worktree is born from the commit, an array of checkout-relative paths copies only those. The field is mandatory twice over: the host validates the declaration before the tool runs, and the create itself refuses an omitted, `null` or EMPTY/whitespace-only string before anything is written (the only child that ran before that check is the read-only branch-name probe, which mutates nothing) — so nothing is ever copied or left behind on the caller's behalf, and "no text" is never read as "copy nothing". The three accepted values are exactly the word `"all"`, the word `"none"`, and a list of checkout-relative paths (an empty list is a legal, if empty, list). A value that is none of the three forms, an unknown file, or a destination that already modifies a selected path refuses the whole create before anything is written. There is no `issues` or `odd`, and a caller that still sends one is neither obeyed nor refused) | None — a create touches no existing data: the checkout and its registry row are both new, so it never asks, exactly as the panel's create path never did | `created: <slug> · <branch>` (`· already exists` only when the REQUESTED branch already has a worktree — another checkout the session owns never answers for it), then `path:`, then `registered: new|replaced|appended|unchanged` (what the registry write actually did: a new row, a row that replaced this branch's stale one, a row recorded beside a live checkout that kept the branch, or no write at all because the requested branch's checkout was returned), then exactly one CodeGraph row — `codegraph: initialized` / `codegraph: not initialized` on the existing-checkout path (the index state read from the checkout, never initialized there) and `codegraph: initialized`, `codegraph: not initialized (<reason>)`, or `codegraph: not run (<reason>)` for a fresh create — then `changes: already registered for this session` when the created checkout joined the current session's scope, then `copied: N files, +N/-N` when the selection transferred pending work, then one `warning:` row per summarized warning. A worktree carries no issue or ODD association, so no association is verified, written or printed. A session may own several checkouts: the requested branch is created and registered even when this session already owns another one, and idempotency is keyed on the requested branch alone. A real creation registers the checkout through gentle-shell's `session_worktree_register` host tool when that tool is available (the created checkout joins the current session's `/gentle:changes` scope, so the agent does not re-register it); when it is unavailable or its call fails, nothing is appended and the create still succeeds. The four principal-directory links are handled by the creation hooks described below |
| `worktree_list` | `all?: boolean` (optional) | None — prunes dead rows (see below), otherwise read-only | `worktrees: <count> (name · branch · path)` then one ` · `-joined row per checkout in listing order (principal, the session checkout when distinct, then the rest), each row being that checkout's identity — `<name> · <branch> · <path>` — plus exactly ONE trailing state cell when the row is not the ordinary registered-and-live case: `missing` (the path exists but git no longer lists the checkout) or `unregistered` (a live checkout the registry does not own; only with `all: true`). Being listed IS the existence proof — a checkout whose path is gone is pruned before it can be listed — so no `live`/`exists` cell is ever printed, and a `kind` that only repeats the row is not a cell either (`principal` repeats the row's own name, `agent` repeats "a registered worktree", `unregistered` repeats the status beside it); a kind the row does not already state still prints (S6). No issue or ODD cell appears: a worktree carries no association, so none is printed even when the registry still stores one. Then one `warning:` row per prune warning. `details.worktrees[]` keeps `name`, `path`, `branch`, `thread`, `status` and `kind` unchanged, so a caller retains every structured fact the compact text elides |
| `worktree_close` | `name?: string`, `path?: string`, `branch?: string` (at most one required — exactly one selector; `name` accepts a name OR a path, name first then path), `force?: boolean` | `ctx.ui.confirm` when the host offers dialog UI (`ctx.hasUI`), naming pending changes as `Pending changes: N files, +N/-N` when dirty and nothing when clean; waived only when gentle-shell YOLO is active for this live session AND the checkout is proven clean — a dirty checkout and an unreadable summary both keep asking. A refusal keeps checkout and entry, and `force` still comes only from the caller | `outcome: removed`, then `name:`, `branch:`, `path:` and `branch state: kept|deleted`, plus `session: warped to <name> · <path>` when a live session was warped out first, `herdr workspace: <status> · <notice>` when that step reconciled, skipped or half-failed, and one `warning:` row per summarized warning. No association line, association warning or dropped-document list can appear: a worktree carries no issue and no ODD document |
| `worktree_session_open` | `worktree: string` (required — the NAME `worktree list` prints, a branch name, or the checkout path; name first then path), `session?: string` (a Pi session id to RESUME; absent means a new session), `name?: string` (the agent/pane name, defaulting to the worktree name), `notify?: boolean` (default true; accepted and reported here, honoured by the finish subscription) | None — worktree-scoped by construction (see scope guard) | `outcome: opened|resumed`, then `worktree:`, `branch:`, `path:`, `session:`, `workspace:`, `pane:` and `agent:` — the routing ids the caller needs to reach the session it just started |
| `worktree_warp` | `name: string` (required — the worktree NAME `worktree list` prints, or the checkout path; name first then path), `changes?: string \| string[]` (optional — pending changes to carry into the destination checkout: omit or pass `""` or `[]` for no copy, `"all"` for everything, a list of files for selected changes only; the word `"none"` is not one of its values — that spelling belongs to `worktree_create` alone; there is no selector in the tool) | None — never opens a selector (selectors are human-only); warping to the checkout the session already runs in changes nothing | `outcome: handoff queued` — the tool QUEUES the move and never performs it: `worktree warp: handoff queued — the session moves when this turn ends`, then `to: <name>`, `path: <checkout path>`, `branch: <branch>`, plus `changes: <all \| N files> (copied when the move lands)` when its `changes` selection is PENDING — the tool copies nothing, so it never prints a completed `copied:` row. A selection naming no pending file is refused in the tool before anything is queued (`worktree warp: unknown changed file … (nothing was copied); nothing was queued`), because the command could only refuse it later. The move itself is the queued `/herdr-gentle:warp` command, which switches after the turn settles, applies the selection and starts the continuation turn in the new checkout. `outcome: already there` keeps its byte-identical no-op text. The tool never claims a switch it did not perform, and its result carries no completed-move row |

The session moves between checkouts through `/herdr-gentle:warp <name>` (its own command for humans — a selector, or an explicit name) and through the `worktree_warp` agent tool (a required name-or-path, an optional `changes` selection, no selector, then a continuation turn so the agent keeps working). The host keeps session control on the COMMAND context, so the tool never switches anything itself (S14): it resolves the checkout, validates the selection and QUEUES that command, whose handler waits for idle, re-runs every refusal check, applies the requested copy and then moves the session with the same fork/resume rules the human path uses — see [The agent warp is a queued handoff](#the-agent-warp-is-a-queued-handoff). The command's success text is the two-line compact `moved: <name> · <branch>` / `to: <name> · <branch>` (a raw path only when the checkout left sits outside every known checkout); the tool's result is the pending handoff rows (`to:` / `path:` / `branch:`, never `moved:`), and the ONE `moved:`-shaped confirmation is the styled card the switched-to session paints after the real move. Warping to the checkout the session already runs in returns `worktree warp: <name> (already there)` (byte-identical text) but shows nothing and changes nothing, and it queues nothing.

Pending changes travel only when asked (S61). Before the command moves the session it summarizes the source checkout's uncommitted changes through the shared `lib/worktree-changes.js` helper (staged and unstaged combined against HEAD, untracked files measured from disk, deletions and renames covered, binary files labelled never faked — `N files, +N/-N`). A clean checkout warps with no prompt; a dirty one opens a concise `YES COPY` / `NO COPY` choice where `Esc`/`Ctrl+C` cancels the warp with no switch and no copy. `YES COPY` copies every pending change into the destination checkout and then warps ordinarily; `NO COPY` warps ordinarily with nothing copied. The copy never mutates the source or either index, and a destination that already modifies a selected path rejects the whole warp with nothing copied, warped or switched. The tool's `changes` option is the same transfer without a prompt: omitted/empty means no copy, `"all"` carries everything, a list of files carries only those; an unknown file is refused in the tool BEFORE anything is queued (nothing is copied and nothing is claimed), and a destination overlap fails the MOVE with no copy, no switch and no mutation of either checkout. That is why the tool itself copies nothing: it validates the selection and puts it in the handoff token, and the command applies it at move time, after every refusal check — a copy made before the handoff was queued would be stranded in a checkout the command then refused, and the retry the refusal asks for would fail on its own leftover copy. A failure AFTER that copy (the host cancels or throws the switch, a fork step fails) is reported with the destination, every copied file and the count, is never rolled back automatically, and the retry either PROVES byte identity and skips the copy or fails closed with the recovery — see [The agent warp is a queued handoff](#the-agent-warp-is-a-queued-handoff). Its value set is UNCHANGED by the create work: an omitted, `""` or `[]` selection copies nothing, and any other string — `"none"` included — is refused with the original message (`invalid changes selection "<value>": pass "all", a list of files, or leave it empty for no copy`). `worktree_create` is the only surface that accepts the word `"none"`, and it adapts locally for it instead of widening this shared contract.

Deleting a checkout confirms first unless gentle-shell YOLO is active for this live session **and** the checkout is proven clean: a checkout with pending changes is never waived, YOLO or not, and an unreadable summary reads as dirty. The confirmation names the checkout's pending changes when it has any (`Pending changes: N files, +N/-N`, read through the same helper; a clean checkout omits the warning). The shared close still needs `force: true` for a dirty checkout — the confirmation alone never smuggles force in — except in the warp selector's `Ctrl+D` flow, where the explicit Yes for that approved row passes `force: true` deliberately for exactly that target (never the principal, never protected/foreign, whose refusals run first).

Structured `details` on success:

- create: `{path, branch, registered, codegraph, hooks, warnings, pruned, replacedRows, changesRegistered, base, copied?, copyError?, alreadyExists?}` —
  `registered` is what the registry write did (`new`, `replaced`,
  `appended`, or `unchanged` when the requested branch's checkout was
  returned without a write); `alreadyExists: true` appears only on that
  returned-checkout path (see request idempotency); `branchCreated` is
  `false` when the worktree
  adopted an existing branch and `true` when the branch was created with
  the checkout (see branch adoption); on the adopt path `herdrAssociated`
  reports whether the best-effort `herdr worktree open` association
  happened (`true`/`false`, absent on the create path); `pruned` lists the stale git records a
  `git worktree prune` recovery dropped (empty when nothing was stale);
  `replacedRows` lists the stale registry rows dropped by the one-owner-per-path
  rule below (`[{branch, path}]`, empty when nothing shared the target path);
  The `link-principal-entries` hook reports directory-link outcomes in
  `hooks.steps`; `base` is the base the NEW branch was created from, read
  through one `git rev-parse` and reported, never guessed —
  `{source: 'main', ref: 'main', commit}`. It is absent on an ADOPTED branch
  (adoption needs no base) and on a refused create, and there is no fallback:
  a repository without a local `main` refuses the create instead of reporting
  some other base. `copied` is `{files, added, deleted,
  paths}` for a selection that transferred pending work (absent when nothing
  was copied); a copy the destination rejects keeps the created checkout,
  reports `copyError` and returns an error result naming the worktree it did
  make. `changesRegistered` is `true` when the
  created checkout was registered on the current session via
  `session_worktree_register` (the trailing `changes:` line is then present)
  and `false` otherwise;
  when the recovery itself fails, the create fails with the row intact and
  `pruneError` carries the cause; `hooks` is the creation-hook report (`{ok,
  steps, warnings}`), so a failed hook step stays visible there and never
  turns success into an error. When the write replaced a malformed
  registry, the sibling backup path travels as `registryBackup`; when no
  backup could be written, the failure travels as `registryBackupError`
  (best-effort, never fatal). `warnings` carries the hook warnings plus,
  when a same-branch row pointing at a different live checkout was kept,
  the conflict line naming that checkout; on the adopt path, the adoption
  line naming the adopted branch (plus the Herdr-association outcome when
  it failed).
- list: `{worktrees: [{name, path, branch, thread, status, kind}], count,
  all, pruned, warnings, pruneError}` — `name` is the printed first column (slug or `principal`); `path` is the absolute checkout path; `status` is `live`, `missing`
  (registered and still on disk but no live checkout, or a non-absolute
  path that can never name one), or `unregistered` (only with `all:
  true`); `kind` is `principal` for the principal checkout, `agent` for a
  registry row, or `unregistered` (only with `all: true`). No entry
  carries an `issues`, `assignedOdd` or `odd` field: a worktree has no
  issue and no ODD association (S1), so neither the stored association nor
  the checkout's document inventory is read, scanned or published — and the
  registry keeps those legacy records byte for byte (see "Registry
  preservation" below).
  `pruned` lists the registry paths dropped by the self-heal
  below (empty when nothing was dead, or when the prune write failed —
  then `pruneError` carries the cause); `warnings` carries the one line
  naming them (see below) and is empty otherwise.
- close: `{path, branch, removed: true, branchKept: true, thread}` —
  `thread` is the owning thread, or `null` when none was recorded. No
  `warnings`/`droppedOdd` pair exists: the write that drops the closed row
  carries every other row through untouched, so there is no association loss
  to report and no association content in the output. The
  checkout is selected by `name`, `path`, or `branch` (at most one): a
  `name` is the flattened branch slug the listing prints (or `principal`)
  resolved through the same resolver the warp uses — and `name` also
  accepts a checkout path (name first, then path; a path resolves only
  when it exists and belongs to this project's worktrees). An unknown name fails
  closed like an unknown path, naming the closest names, and two registry
  rows flattening to one name are ambiguous and fail closed naming both,
  never picking one. `principal` cannot be closed, even though it has a
  metadata row: a name or path resolving to it is refused before any
  approval, removal or registry write, with checkout and registry left
  untouched (S32). When the close warped a live session out first,
  `details.warp` carries `{name: 'principal', path, branch, sessionFile}`
  (the warped session now living in the principal); when the Herdr
  workspace step reconciled or skipped, `details.herdrWorkspace` carries
  `{status: 'reconciled', closedWorkspace, closedWorkspaces, openedWorkspace, session}` or
  `{status: 'skipped' | 'reconciled-partial', notice, closedWorkspaces?, failedWorkspace?, ...}` (see the
  close sequence).
- warp tool (`worktree_warp`, S14): `{tool: 'worktree_warp', handoff: true, pending: true, pendingName, pendingPath, pendingBranch, from, target, kind}` — a QUEUED handoff, never a move: the keys the card renders as completed-move rows (`fromName`, `fromDesc`, `name`, `path`, `branch`, `alreadyThere`, `resumed`, `cancelled`) are deliberately absent, so the card falls back to the result's own first line (`handoff queued`) instead of painting a switch that has not happened. Refusals keep the tool's own error text and list the available checkouts; the already-there no-op keeps `{name, path, branch, kind, alreadyThere: true, cancelled: false}`.
- warp command (`/herdr-gentle:warp`, human path and interior of the tool's handoff): `{name, path, branch, kind, alreadyThere, cancelled}` — `kind` is `principal`, `agent`, or `unregistered` (a lone live checkout the registry does not own); `alreadyThere` is `true` only for the `worktree warp: <name> (already there)` no-op; `cancelled` is `true` only when the session switch was cancelled, in which case the forked target session file was removed and nothing else changed. A handoff invocation carries the same details and adds no field beyond the copy facts a handoff can produce: `copyDestination` and `copiedFiles` on a handoff result (success or failure) whose pending changes were copied into the destination, and `copyAlreadyPresent: true` when a retry proved the destination already held exactly those bytes and skipped the copy. A refusal that proves only PART of the copy carries only the files it could prove in `copiedFiles` and names the differing files in its text. The queued argument is an internal `@<token>`, not a documented surface.
- session open: `{worktree, branch, path, paneId, workspaceId, sessionId,
  resumed, agentName, notify}` — exactly these nine keys. `worktree` is
  the printed NAME (the slug, even when a branch spelling was passed);
  `sessionId` is the resumed id or the minted UUID; `resumed` tells which;
  `agentName` is `name` or the worktree-name default; `notify` is the
  accepted subscription flag (`true` unless `notify: false` was passed).
  Failures are errors, never partial successes: each names the herdr call
  that failed and its exit, and a failure after the workspace was opened
  by this call names that workspace id so no half-created workspace goes
  unmentioned.

Model-facing listing text (pinned by the tool and model-result tests) —
the registered tool returns the rows below, built from `details`:

```text
worktrees: <count> (name · branch · path)
<name> · <branch> · <path>
<name> · <branch> · <path> · missing
<name> · <branch> · <path> · unregistered            # only with all: true
<name> · <branch> · <path> · <kind>                  # only when the row does not already say it
warning: <summarized prune warning>                  # only when something was pruned
```

S6 picks the compact form the same way the expanded card does. The legend
declares only the three cells every row carries; the state cell is trailing and
self-describing, so it needs no column. A listing is read for what it names and
for what is wrong with it, so exactly one state survives — `missing` (the path
exists but git no longer lists the checkout) and `unregistered` (a live
checkout the registry does not own, only with `all: true`) — while everything
that only repeated the row is gone: `live`/`exists` (being listed IS the
existence proof, and a vanished path is pruned before it can be listed), the
`agent` kind (it means "a registered worktree", which the row already is), the
`principal` kind (it repeats the row's own name) and the `unregistered` kind
(it repeats the status beside it — stated once, never twice). A kind the row
does not already state is still printed, because dropping it would hide a fact
the details carry, and an existence spelling in `kind` (`live`/`exists`) is
treated as that same ordinary case rather than earning a second cell. Removing
those cells costs the reader nothing and saves the context they used to spend
on rows that said nothing.

A row is therefore the checkout's identity plus that one state: no `issues`
cell and no `odd` cell, because a worktree carries neither — and
`details.worktrees[]` carries no `issues`, `assignedOdd` or `odd` field
either, so the structured result matches the text. The registry's legacy
association records are still preserved byte for byte (a listing rewrites
nothing) and the checkout's `odd/` directory is never scanned for an
inventory, so no stored data is lost and no read is spent on an association
the tool will not publish. The structured `details` keep every fact the text
elides — `status` (`live`, `missing`, `unregistered`) and `kind`
(`principal`, `agent`, `unregistered`) arrive complete, unchanged and in the
same order, so compacting the text never removes a field a caller can act on.

The raw text the tool returns is the same terse line format the backend
tests pin:

```text
worktree list: <name> <branch> principal
worktree list: <name> <branch> thread=<thread>
worktree list: <name> <branch> thread=<thread> missing
worktree list: <name> <branch> unregistered        # only with all: true
```

No raw row carries `issues=` or `odd=`: a worktree carries no issue and no
ODD association, so neither the stored association nor the checkout's
document inventory is read, published or printed.

The FIRST column is the NAME (S24): the flattened branch slug
(`feat/worktree-warp` → `feat-worktree-warp`), or `principal` for the
principal checkout — the identifier the warp command accepts and the close
`name` selector takes for every registered row and for the principal. The
absolute path is not dropped: it stays in `details.worktrees[].path`
(alongside `details.worktrees[].name`). One case is printed but NOT
selectable by close-by-name, and fails closed instead of picking a checkout:
any name that more than one live checkout carries — including `principal`,
which is reserved, so a branch whose slug is also `principal` makes that name
ambiguous. Pass the path or the branch in that case. An unregistered checkout
is shown with `all: true` while close (and session-open) act on registered
rows only; the warp moves to a lone unregistered checkout, and a name shared
with a registered row stays ambiguous and fails closed.

The principal checkout (S19) is the main worktree of git's listing — the
entry whose resolved path equals the main root recovered from the shared
common dir (`<principal>/.git` is the common dir for a normal
repository). It is always listed when git's listing names it, printed
distinguished as `principal` (never carrying an agent thread/issue
association), never
pruned (the registry holds agent rows only), and never reported as
`unregistered`. When git's listing names no such entry, no principal row
is invented. `worktree list: none` is retired: with no agent worktrees the
output is exactly the principal row.

The session's own checkout is the FIRST row after the header, whether that
is the principal or a registered worktree: the checkout containing or equal
to the tool context's working directory, deepest match winning, the
principal as a candidate. A session inside a registered worktree sees that
worktree first, then the principal, then the remaining agent rows in
registry order. A session in the principal, or outside every checkout, sees
the principal first. A session in an unregistered checkout sees the
principal first too, unless `all: true` asks for unregistered checkouts:
then that checkout leads the listing and the order of everything else is
unchanged. Every row keeps its identity cells regardless of position.

`all: true` appends live checkouts the registry does not know about,
sorted by path — except the session's own unregistered checkout, which
leads the listing instead, and is therefore listed as `unregistered`
whenever the session runs inside one. Close refuses an unregistered target and names the three
closest registered candidates (common-prefix rank on branch, small bonus
on path match) instead of removing anything; passing both `path` and
`branch` that disagree is an error telling the caller to pass only one.

`worktree_list` self-heals (S16) through the one consolidated liveness
definition (`checkoutState` in `extensions/gentle-worktree-tools.ts`, plus
`isLiveGitRecord`/`liveIdentities` built on it): a live checkout is a path
whose state exists AND is a directory, resolved without the process cwd
(absolute inputs directly, relative inputs against the repository root)
and matched by resolved realpath identity — a row reaching a live checkout
through a symlink IS live, a FILE at the path is never live even when git
names it, and a dangling symlink reads as absent. Every absolute
registered path is checked
on every call. A row is `live` only when its state exists, is a
directory, and its realpath matches a live checkout's realpath — a FILE at the path is never
`live`, even when git names it. A path where nothing exists (the user
deleted the checkout by hand) is removed from the listing AND pruned from
the registry in one atomic write, so the tool always exposes only real
checkouts; the pruned paths travel in `details.pruned` and in a warning
line that also says git may still record the checkout until `git worktree
prune`. When the prune write itself fails, the listing still excludes
them and the warning says so (plus `details.pruneError`). A path that
exists but git no longer lists stays `missing` and is never pruned; a
non-absolute entry can never be verified without the process cwd, so it
stays `missing` (never live), exactly as before. The `all: true` extras
obey the same rule: they are built from the post-prune registry, and every
git entry is existence-checked on its absolute form (a relative entry
resolves against the repository root, never the process cwd) — a path that
does not exist is never reported, in any status, so a hand-deleted checkout
git still records cannot reappear as `unregistered` on the next call, and
`details.worktrees` never carries a path that fails the existence check.

## Registry

`<git-common-dir>/pi-worktrees.json` (`REGISTRY_NAME =
'pi-worktrees.json'` in `lib/worktree-registry.js`, resolved through `git
rev-parse --git-common-dir`). That is inside `.git`: it never lives in a
working tree, is never committed, and is shared by every checkout of the
repository. Entries carry `{branch, path, thread, issues[], odd, updatedAt}`
and an optional creation timestamp `createdAt` or discovery timestamp
`registeredAt`. Discovery time is not checkout creation time.

### Registry preservation (S1): a write destroys nothing it does not address

`odd` is ONE odd document path (`odd/tasks/<file>`) or `null` when the row has
none — never a list. That is an invariant of the in-memory entity: **reads**
normalize it through `normalizeOddDoc`, so no consumer sees a second
association.

A **write** is a different matter, because the tool only creates and closes
checkouts: a worktree carries no issue and no ODD document any more, so a
write has no business destroying one. The contract is:

* **A row the write does not address is written back byte for byte** — its
  legacy `odd[]` list, its `issues` list, an unknown field and even the absence
  of a field are carried through exactly as they were read. Every write path
  (upsert, append, update, all three removals, prune, discovery) goes through
  one projection for this, so no caller can reintroduce a loss. The rows are
  read with non-enumerable stamps (`storedEntry`, and `oddDropped` for the
  report) that never serialize.
* **The row the write addresses keeps the one-document rule.** A supplied
  legacy list collapses to its FIRST entry and the entries left behind are
  reported once as `dropped: [...]`; `addOddDoc` is a *select* that names the
  replaced document in `replaced`. An upsert that says nothing about `odd`
  leaves the stored value exactly as it is on disk.
* **An addressed row keeps its other fields too**: unknown fields the row
  already carried are carried into the rewritten row (the fields this version
  models are the ones it rewrites).
* Because an unaddressed row never loses a document, **no worktree tool output
  reports one**: `worktree_create` and `worktree_close` carry no association
  line, no association warning and no `droppedOdd` field. A warning there would
  mean a loss that cannot happen.
* **Reads still tell an older row the truth**: a legacy `odd[]` reads as its
  first entry, and a write that addresses that row collapses it once (the
  `dropped` report), so a stored association never disappears silently.
* **The agent tool** accepts one `odd` path and REFUSES a list with a clear
  error (`odd accepts ONE document, not a list`), before any checkout or
  registry write.

Discovery registers the canonical principal once and places its row first.
Repeated discovery preserves its associations and leaves unchanged registry
bytes alone. Tool listing places the principal first, then the session's
checkout when distinct. The warp destination list pins the principal first. A principal
metadata row never grants permission to remove that checkout.

Reads tolerate damage: a missing file reads as empty, malformed content is
reported (`{ok: false, error}`) instead of thrown, and the file is left
untouched — malformed never silently enables anything. Writes are atomic
(a sibling temp file created exclusively with an unpredictable suffix
plus rename, retrying a new name a bounded number of times and refusing
with a clear error rather than following or reusing anything; a write that
fails after the temp file was created unlinks it best-effort before
rethrowing, so a failed write never leaves a temp file behind and never
reports success) and
serialized by `withRegistryLock`, an
exclusive lock file beside the registry with a bounded wait and
stale-lock recovery. A malformed file is replaced on the next upsert,
never merged — and before the replacement the previous bytes are copied
to a sibling backup named `<registry>.corrupt-<timestamp>-<random>` in the same
directory (best-effort, never fatal, never clobbering: created exclusively
with an unpredictable suffix, retrying a new name a bounded number of
times, and continuing without a backup when none can be written), whose path is reported in the
create result and in the `worktree_create` details as `registryBackup` (or
`registryBackupError` when no backup could be written) so
the caller can name it. A valid registry is never backed up.

`worktree_create` never unregisters a live checkout (S14): when a row
already carries the branch being created but points at a DIFFERENT live
checkout, that row is not replaced — it keeps its registration, the new
checkout is recorded alongside it (`appendWorktree`, which always appends
instead of replacing by branch), and the conflict is reported in the
create `warnings` naming the kept checkout. Liveness is one consolidated
predicate (`checkoutState` in `extensions/gentle-worktree-tools.ts`): a
path names a live checkout only when something exists there AND it is a
directory (a FILE is never a checkout; a dangling symlink reads as
absent) AND its resolved realpath matches a live checkout's realpath —
relative inputs resolving against the repository root, never the process
cwd — so a row that reaches a live checkout through a symlink is live
and is kept and warned about, while a row whose path git still lists but
which no longer exists is never a live conflict. Every
same-branch row is examined, so the warning names the live checkout
regardless of row order — even when a dead row comes first. Replacement by
branch still applies to every other row.

One owner per path: when a create lands on its target path, that path ends
with exactly ONE registry row — the one just created. Any other row whose
path resolves to the same path (whatever its branch or thread: the same
absolute spelling, the same spelling with a trailing slash, or a symlink to
the target) is stale by definition and is dropped as part of the create, in
addition to the thread-owned stale row dropped after verification. A row for
a different path is never dropped, and relative rows never match. The dropped
rows travel in `details.replacedRows` (`[{branch, path}]`) and in a warning
line naming each dropped branch (for example `replaced 1 stale registry
row(s) at the same path <target>: branch 'feat/foo' at <path>; one path has
one owner ...`). Without this rule a slug collision (`feat/foo` deleted by
hand, then `feat-foo` created on the same flattened path) left two rows for
one path, and closing the old branch deleted the new checkout.

Registry entry paths must be absolute. A `worktree_close` whose entry
path is not absolute is refused with an error naming the entry and the
reason, with no mutation of any checkout and no registry change; the
pre-removal liveness check goes through the same predicate (the target
must exist as a directory AND be recorded by git, so a hand-deleted
checkout git still records, or a path replaced by a FILE, is refused as a
stale entry with the row kept), and the pre-removal check, any removal,
and the post-removal verification all use
the same absolute value derived from the entry, and `worktree_list`'s
live cross-check likewise never resolves a registry path against the
process cwd (a non-absolute entry is reported `missing`, never live).
Entry lookup matches by exact branch equality or exact absolute path
equality only. The close drops its entry by resolved identity (`removeWorktreeByPath`
with `pathIdentities`): every row that reaches the removed checkout
is dropped — the same absolute value, a realpath-equal row, or a row
whose path is a symlink (live or dangling) to it, resolved through an
explicit readlink walk that never touches the process cwd — so no stale
duplicate and no hand-written symlink row survives the close: one path
identity end to end from resolve
through verify and remove to drop, so duplicate branches or a branch that
equals another entry's path can never divert the drop; a relative row
still cannot be matched, which stays documented. The readlink walk is
bounded: a hand-written chain longer than 10 links is not followed, so a
row behind a longer chain can survive a close. That is a stated bound, not
a silent bug. `removeWorktree`'s
branch-first behaviour is kept for any other caller and is unreachable in
the close flow. A Herdr workspace id is used only when its list entry's
path resolves to exactly that same absolute target: absolute entries
compare directly, relative entries resolve against the repository root
derived from the caller's checkout (never the process cwd) for the
comparison only and are never used as a removal base. When more than one
list entry resolves to the target with different workspace ids, that is
ambiguity: no id is returned, Herdr is skipped entirely, and the close
uses the git path instead. One entry, or several entries carrying the
same id, still resolves. When no entry
matches, Herdr is skipped entirely and the close falls back to `git
worktree remove` with fixed argv; no removal argv ever names a workspace
that is not the verified target. After a removal completes, on both the
herdr and the git paths — and also when the remover itself exits
non-zero — the close compares the live checkouts against the
pre-removal snapshot BEFORE any early return: when a checkout other than
the target
disappeared, the close fails naming the vanished path (on a non-zero exit
the backend's own reason is quoted first, then the vanished path),
refuses to treat the close as successful, and leaves the registry entry
in place in both cases.
Removing only the target never trips this check. The comparison never
depends on the post-removal listing alone and compares resolved realpath
identity, never bare spellings: when that listing fails, the
close falls back to an existence check on the pre-removal live paths
through the same consolidated predicate (`checkoutState`, relative
entries resolving against the repository root) — a pre-removal live
checkout where nothing exists anymore has vanished and is named, on both
exit codes and both
removal paths, with the registry entry kept in every case. A path replaced
by a FILE reads `missing`, never vanished, so both legs agree on files.

## Close sequence (S33/S34)

`worktree_close` removes in a fixed order — warp, workspace, checkout —
and every step before the removal refuses or skips without mutating
anything it does not own:

1. **Resolve, then refuse the principal.** Name first, then path (S29),
   through the same resolver the warp uses; a name or path resolving to
   the principal checkout is refused before any approval, removal or
   registry write (S32).
2. **Warp a live session out first.** After approval, and only then:
   - A Pi session that is NOT ours but is live in that checkout
     (evidenced by `herdr agent list` agents cwd'd in the checkout)
     refuses the close with an actionable message — warp it to the
     principal from that session and retry — and changes nothing:
     checkout, branch and registry entry are left untouched. A failing
     or unparseable agent list is no evidence, so a missing Herdr never
     blocks the removal on this leg.
   - Our own session (the tool context's cwd inside the target) warps
     to the principal FIRST through the existing warp machinery
     (`executeWorktreeWarp`), and the close continues only when that
     warp actually succeeded; a failed warp stops the close before
     anything is removed. A plain tool context cannot warp (session
     control lives on the command context), so from there this fails
     closed with the warp's own message instead of removing the
     checkout from under the session. It is deliberately NOT turned into
     a queued handoff (S14): a queued switch lands only after the turn
     settles, so the removal would run while the session is still parked
     in the checkout being deleted. The agent warps out first with
     `worktree_warp` (or `/herdr-gentle:warp principal`) and closes after.
3. **Reconcile the Herdr workspaces — only after such a warp, group-aware (S35/S36).** Herdr
   exposes no workspace path move, so the recorded fallback runs: EVERY
   workspace of the removed checkout's group is closed in order — the
   linked worktree workspaces whose list entry resolves exactly to the
   removed checkout FIRST, then the group's root — and only then a single
   normal workspace is opened at the principal (`herdr workspace create
   --cwd <principal> --no-focus`), resuming the warped session now living
   there (`lib/worktree-close-herdr.js`). The group is resolved through a
   bare `herdr workspace list` (JSON by default — `--json` is never passed,
   it yields empty output) from the fields that actually exist: every
   workspace whose `worktree.repo_key` matches the target's belongs to the
   group, the root is the member whose `worktree.checkout_path` equals its
   own `worktree.repo_root` (equivalently `is_linked_worktree === false`),
   and the linked members are the rest — live entries carry no group-id key,
   so a group derived from one would miss the root. Hypothetical group-id
   keys survive only as a fallback for entries that name no `repo_key`.
   Closing the root while a linked member is still
   open fails with `workspace_group_close_required`, so linked-first order
   is mandatory and that code is handled into a friendly order message,
   never surfaced raw. A member that is already gone (`workspace_not_found`)
   is tolerated without failing. A foreign workspace — any `worktree.repo_key`
   that matches none of the target's — is never touched. A member that cannot
   be closed stops the sequence with a partial-group report naming that
   member (`details.herdrWorkspace.failedWorkspace`, notice `herdr workspace
   step partially reconciled (…)`, `closedWorkspaces` listing what did
   close), and no reopen is claimed; a failed reopen is likewise partial,
   never success. Without a warped session this step stays silent: the
   removal below already retires the workspace with the checkout. Any other
   Herdr failure (unavailable CLI, failed lookup) skips this step with a
   short visible notice (`herdr workspace step skipped (…)`, in the result
   rows as `herdr workspace: skipped · <notice>` and in
   `details.herdrWorkspace`) while the checkout removal still
   proceeds.
4. **Only then remove the checkout exactly as before** (`git worktree
   remove` + registry deletion, herdr-first with the git fallback and
   the vanished-checkout guards above). After a warp the removal and its
   verification run anchored on the principal the warp moved to — the
   caller's checkout is the doomed target itself — instead of spawning
   inside the checkout being removed; without a warp the anchor is the
   caller's checkout and the removal is byte-identical to before.

## Creation path

`worktree_create` validates in order: mode gate, branch, thread identity,
then repository/path refusals. There is no association step: the tool never
reads `issues` or `odd`. Branch validation is `git
check-ref-format --branch` as the authority, after up-front rejection of
empty names, a leading `-`, whitespace, control characters, and Unicode
bidi marks. Refusals: the branch is already checked out at a LIVE path,
the target path is already a live worktree, or the target sits inside any
existing checkout or the shared git common dir. LIVE is the one
consolidated definition below (`checkoutState`): a path whose state exists
AND is a directory, resolved without the process cwd and matched by
resolved identity — so a git record whose path is gone (the user deleted
the checkout by hand) or was replaced by a FILE never blocks a create on
its own. When such stale records are the ONLY thing holding the branch or
the target path, the tool recovers with a scoped `git worktree prune`
(which drops only records whose directories are missing) and proceeds to
create; the pruned paths travel in `details.pruned` and in a warning line.
A branch genuinely checked out at a LIVE path is refused exactly as before.
No worktree path in any tool is ever resolved against the process cwd:
absolute inputs resolve directly, relative inputs (registry rows, relative
listing paths) resolve against the repository root.

The target path flattens the branch into one component
(`feat/foo-bar` → `feat-foo-bar`) at
`<repo-parent>/<repo-name>-worktrees/<slug>` (`slugifyBranch` /
`worktreePath` in `lib/worktree-git.js`). `worktree_create` only creates:
the worktree is always created in that sibling layout, and there is no
update path — a live checkout of the branch, whether this session's or
another session's, is either returned as `already exists` (this session's own
row for that branch) or refused. The principal checkout is never created,
edited or removed by this tool. A registry row the write replaces keeps the
legacy `issues`/`odd` values it already stored; a brand-new row records an
empty `issues` list and no `odd`, because the tool writes no association of
its own. Branch adoption (S20) is
resolved BEFORE creating: when `refs/heads/<branch>` already exists (and
the branch is not checked out at a live checkout — already refused), the
worktree checks out that EXISTING branch with `git worktree add <path>
<branch>` — no `-b`, no base, the ref never created, rewritten or deleted
— and the result reports `branchCreated: false` plus a warning naming the
adopted branch. Because `herdr worktree create` cannot adopt an existing
branch, the adopt case goes through git and then associates the Herdr
workspace best-effort with `herdr worktree open --path <path> --cwd
<root>` (values as separate elements, like every other backend call);
whether that association happened travels in `details.herdrAssociated`,
and the checkout succeeding never depends on herdr. When the ref does not
exist, creation is herdr-first (`herdr
worktree create` with fixed argv, values as separate elements because
herdr rejects `--flag=value`) with a `git worktree add -b` fallback and
reports `branchCreated: true`; when
the branch ref already exists (the same-branch recovery above) the fallback
checks the existing branch out at the fresh path instead of failing on
`-b`. The
base ref is the repository's current `HEAD`. Neither backend passes
`--focus` or `--trust-repository`: trusting a repository is a human
decision these tools never take. Success is verified against `git
worktree list --porcelain -z` before anything is claimed, never trusted
from Herdr JSON. Every external process uses a fixed argv array — no
shell string is ever built. The herdr binary resolves from `HERDR_BIN_PATH`
when set, else `herdr` on `PATH`; under the test harness
(`GENTLE_WORKTREE_LIB_DIR` set by the test loaders) with no explicit
binary injected, resolution fails closed instead of spawning a live Herdr,
so tests must always inject `HERDR_BIN_PATH`. No issue is verified on this path: the create takes the branch alone, so
no `gh` read happens and a supplied `issues` value is ignored.

A pre-existing entry of ANY kind at the target path — an empty or
non-empty directory, a file, a FIFO, a socket, or a symlink — is refused
before any backend runs: `target path <path> is occupied by a <kind>:
remove it by hand or pick another branch; the registry was left
untouched` (the article follows the kind: `an empty directory`). `<kind>`
names what is actually there: a symlink reports `symlink to a file` or
`symlink to a directory` when its referent is one, and a bare `symlink`
otherwise — dangling, or a referent that is neither. Git's raw `fatal: '<path>' already exists` never surfaces
(and the empty directory is refused precisely because git would silently
adopt it), and no registry row is written, so removing the occupant lets
the next create at the same path succeed. The single exception is this
session's own checkout of the REQUESTED branch, which the idempotency
contract returns with `alreadyExists: true`.

The remaining path decisions share the one predicate (exists AND is a
directory, realpath identity where identity is the question):
`isPathInAnyCheckout` (`lib/worktree-git.js`) skips non-directory records and
compares both spellings and realpaths (resolving non-existent tails through
their parents), so a symlink spelling of a checkout gives the same
inside-verdict as the real spelling; `vanishedCheckouts` excludes the close
target by absolute-or-realpath identity (never lexical spelling alone) and
names only paths where nothing exists on both legs, so a FILE reads `missing`
and is never reported vanished — list, create and close cannot disagree about
the same path in any shape.

## Creation hooks

`runCreationHooks` (`lib/worktree-hooks.js`) runs after the registry
write, in order. Every step records `{name, status, detail}` with status
`done` / `skipped` / `failed`; a non-zero exit is a `failed` step plus a
warning and never aborts the remaining steps.

- **Untracked env copies.** Candidates `.env`, `.env.local`,
  `.env.development`, `.env.production`, `.env.test`. Each is copied from
  the principal checkout only when it exists there, is NOT tracked by git
  (`git ls-files --error-unmatch`, failing closed toward "tracked" on any
  runner failure), and does not already exist in the worktree. Never
  overwrites, never copies a tracked file, never fails for a missing
  source.
- **Principal directory links.** `link-principal-entries` handles exactly
  `.agents/`, `.pi/`, `.claude/` and `odd/`. Each existing source directory
  is linked independently only if Git tracks nothing under it and ignores it
  in the principal checkout. Untracked but nonignored entries are skipped.
  Tracked entries arrive through checkout. An occupied destination is never
  deleted or replaced; a correct existing link is idempotent. Missing sources
  are not created, and unreadable Git evidence skips linking rather than
  guessing. The same policy runs once in the synchronous agent-tool and
  asynchronous command hooks; outcomes and warnings are in `hooks.steps`.
- **Dependency install by detected lockfile.** Every detected stack runs,
  in table order: `bun.lockb`/`bun.lock` → `bun install`,
  `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` →
  `yarn install --frozen-lockfile`, `package-lock.json` → `npm ci` with a
  single fallback to `npm install`, `uv.lock`/`pyproject.toml` → `uv
  sync`, `Cargo.toml` → `cargo fetch`, `go.mod` → `go mod download`. A
  missing binary is `skipped`, never a failure. No lockfile at all is one
  `skipped` install step.
- **`codegraph init`** when the CLI is on `PATH` (`skipped` with a reason
  when absent). The tools do not index for you beyond this.

The source of these links is the principal checkout, never whichever linked
checkout invoked creation. The hook does not copy directory contents or share
`.codegraph/`. A tracked `odd/` arrives as a regular checkout directory; a
Git-ignored `odd/` can be shared through its principal link. Closing may still
need `force` when creation hooks leave untracked files or links; those files
are never silently removed by setup.

The principal checkout is recovered from the shared common dir (for a
normal repository, `<principal>/.git` is the common dir), not assumed
from the caller's checkout.

## Mode switch (`/herdr-gentle:customize` — `Plugin tools` section)

The panel's `Plugin tools` section groups three independent toggles:
`Worktree tools`, `ODD command` and `Issues command`. Each row names its stored
value (`Worktree tools · Enabled` / `· Disabled`) and `Enter` flips that one
toggle; the other two are never touched. The section applies to the registered
command and tool surfaces only — automatic ODD naming (see "ODD writes: session
naming only") keeps running whatever the `ODD command` row says.

The `Worktree tools` row flips the shared mode file. The old
`/herdr-gentle:worktree` is removed entirely: worktrees are no longer
modified, so neither its mode verbs nor its fullscreen detail have a job
left. `customize status` is the read-only replacement for the old status
verb.
Writing the mode refuses a symlinked or
non-regular mode path with a clear error and touches nothing (the normal
path stays atomic: a sibling temp file created exclusively with an
unpredictable suffix and renamed into place, retrying a new name a
bounded number of times and refusing with a clear message rather than
following or reusing anything; a write that fails after the temp file was
created unlinks it best-effort before rethrowing, so a failed write never
leaves a temp file behind and never reports success), and the
command surfaces that refusal instead of claiming success. The shared mode file is
`gentle-worktree-mode.json` (`{version: 1, enabled: boolean}`) in the
plugin state directory — `GENTLE_STATUS_STATE_DIR`, else
`HERDR_PLUGIN_STATE_DIR`, else
`$XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents` — exactly like the
sidebar's. Missing means **enabled**; malformed never enables.

Gating is two-level: at load, the tools and `/herdr-gentle:warp` register
only when the mode reads enabled, and `/herdr-gentle:odd` and
`/herdr-gentle:issues` follow their own toggles the same way. Customize stays
registered so every toggle can be flipped back. The two commands' toggles live
in `gentle-plugin-tools.json` (`{version: 1, odd: boolean, issues: boolean}`)
beside the mode file, at a canonical path every session computes identically
(the next section spells out why it is not the mode file's precedence): missing
means **enabled** (both commands were registered unconditionally before the
toggles existed) and malformed never enables either one. Both files go through
the same guarded writer, so a symlinked or non-regular path is refused and
nothing is followed.

### The canonical toggle file and its duplicate

Herdr injects a state dir (`HERDR_PLUGIN_STATE_DIR`) while an upgraded install
keeps the stored `herdr-gentle-agents` dir, so the toggle document can exist in
both. Its **canonical** location is the one every session computes identically,
plain Pi or Herdr: `GENTLE_STATUS_STATE_DIR` when it is set (which keeps its
documented scope of one location), else the stored
`$XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents` dir. The mode file keeps its
own precedence untouched, but this document deliberately does **not** consult
`HERDR_PLUGIN_STATE_DIR` when choosing the canonical path: a plain Pi session
cannot discover an arbitrary injected dir, and a missing toggle file means
enabled, so a copy written only there would silently re-enable a command the
user disabled. Every writer therefore guarantees the canonical path.

Reads cover **every** location that holds the document, so a stored copy with
the toggles **disabled** can never be shadowed by an injected dir that holds
only unrelated state and then read as missing — missing means enabled, and that
fail-open is exactly the bug this replaces. Writes cover the canonical path
(created when no copy exists at all) plus every other copy that already exists
— never a third location, and never the legacy worktree file. The outcomes:

- **one copy** — it is authoritative for reading *and* writing: a flip rewrites
  that file and never creates a second copy beside it;
- **two copies that agree** — a flip rewrites **both**, so a duplicate pair
  cannot diverge, and the notification names every path it wrote. Two copies
  are never silently collapsed into one, and neither is deleted;
- **two copies that disagree** — the disagreeing keys read as **disabled**, the
  panel row and `customize status` carry a diagnostic naming both files with
  their two values, and a flip of such a key is **refused**: nothing is written
  to either file. That judgement is deliberately narrow so a duplicate never
  freezes a command nobody disputed: only the keys the flip actually changes
  can block it, and a flip of an undisputed key still lands — each copy keeps
  its own value for the disputed one, so the flip never guesses which of the two
  values the user meant. The fix is the user's: make the copies identical, or
  delete the one they do not want, then flip again;
- **a copy that does not parse** holds no information, so the parseable copy
  decides and the next flip **repairs** the unreadable one. Repairing discards
  whatever that file held, so the notification names the path it overwrote and
  says the contents were discarded; when no copy parses, both toggles fail
  closed exactly as a single malformed file always did.

A write covers every copy, so it can stop half-way. A half-applied flip is
reported as what it is, never as a clean no-op: the notification names the
copies that already hold the new value and the copy left untouched, says the
pair now disagrees (so the toggle reads Disabled until it agrees again) and
keeps the cause; only a failure that really wrote nothing says
`nothing was changed`.

### Flipping a toggle from two sessions at once

A flip is a **read-merge-write of one key**, never a write of a snapshot taken
before the read. Serialization covers **every path a flip writes**, one lock
file (`gentle-plugin-tools.lock`) per candidate state dir: the canonical dir's
lock — the one every session computes identically — plus the lock beside every
legacy copy that exists and is rewritten in the same flip. A lock per
*resolved* dir serialized nothing that mattered: a plain Pi session held the
stored dir's lock while a Herdr session held the injected dir's, both took
their snapshot from the same shared copy, and one flip was lost. With the set
covered, two sessions flipping `ODD command` and `Issues command` at the same
time keep **both** flips: the second waits, then merges its one key into the
state the first left behind.

The locks are taken in **one global order** — lexicographic by the resolved
absolute path of each directory, identical in every process because the paths
are — and released in reverse, so a session only ever waits on the next path in
that order and no two sessions can wait on each other. The deadline is shared
across the whole set, so a flip never waits longer than it always did (2 s).
Waiting is asynchronous — the locks are polled with a short, jittered
`setTimeout` delay and never block the event loop (no `Atomics.wait`, no
synchronous sleep), so the UI keeps painting while a session waits.

A lock is only ever removed on evidence that its owner is gone: the payload
names a pid and a host, and a lock is broken only when it belongs to **this**
host and that pid is provably dead. Age alone never breaks a lock, and a lock
this process cannot read or parse is never deleted — the flip fails instead
with the lock path, its holder and the sentence `Nothing was changed — retry in
a moment. If no other session is running, delete that lock file.` A lock judged
abandoned is moved aside and its token compared with the one that was judged:
if a fresh owner created the path inside that window, the fresh lock is linked
back rather than stolen. Ownership of the whole set is re-checked immediately
before every copy is written, so a session whose lock was taken over aborts
instead of losing an update. The boundary: sessions that share any path contend
on that path's lock, and the canonical dir is the path every session shares, so
a plain Pi session and a Herdr session always contend there. Sessions that
resolve a *different* canonical dir (a different `XDG_STATE_HOME`, or a
different explicit `GENTLE_STATUS_STATE_DIR`) hold genuinely separate state and
contend on nothing — that is two stores, not two views of one.
ODD and Issues are always read-only with respect to worktree
associations, and no worktree surface assigns them any more: the worktree
detail (formerly reached from the warp's `e`) and the create panel's editing
mode were removed with the association, so the mode gates creation, close,
warp and session open only.
The two viewers are handed no association props and no write callback at all —
`/herdr-gentle:odd` and `/herdr-gentle:issues` read documents and issues, and
their view options carry no `assigned`, `saveAssignment` or `assignmentEnabled`,
so opening one performs zero registry writes (the shared guarded saver that
backed those callbacks is gone). The automatic pipeline hook likewise only
names the session from an ODD write; it records no association (see "ODD
writes: session naming only").
At execution, each worktree tool re-reads the mode and fails with
`worktree tools are disabled; open /herdr-gentle:customize and apply the
Plugin tools Worktree tools toggle to enable them` when disabled, and
`/herdr-gentle:warp` refuses the same way. One switch covers
all five tools — create, list, close, warp, and session open share the same gate
and the same registration, with no separate session toggle; the panel's
`Worktree tools` row names that coverage outright (`agents can create, list,
close, warp between and open sessions in agent worktrees; the warp command
follows this toggle`). Registration
changes reload the extension runtime automatically when the registration
must change; `customize status` reports the mode and the two command
toggles, e.g. `customize status: sidebar=gentle moshi=off worktree=enabled
odd=enabled issues=enabled`.
When the host cannot reload (`ctx.reload` is absent or refuses), the toggles
still hold: every gated surface re-reads the stored flag on invocation, so a
disabled `/herdr-gentle:odd` or `/herdr-gentle:issues` refuses to open and a
disabled worktree surface refuses to act even though the runtime still holds
its old registration. The notification then says the change applies from the
next session instead of claiming a reload happened.

### Herdr plugin version check at startup

At session startup the extension compares the installed Herdr plugin for
id `herdr-gentle-shell` against the version this package ships in
`herdr-plugin/herdr-plugin.toml` (read-only `herdr plugin list --json`, the
same lookup the sidebar wiring uses). The check never throws, never blocks
loading, never repeats its message within the session, and never mentions
`/reload`; the logic lives in `lib/herdr-plugin-check.js` and is pinned in
`tools/herdr-plugin-check.test.js` with every external call stubbed.

When the verdict is `missing` or `disabled` **and** the sidebar option still
reads `gentle`, startup no longer merely alerts: it switches the sidebar
OFF through the same writer the customize panel uses — the owned Pi
`settings.json` exclusion is removed and the mode is written native — so a
missing prerequisite never leaves a dead option on. The plugin-owned managed
`config.toml` rows are LEFT AS FOUND (the absent plugin is the only thing
that converges them, and nothing reads them while it is absent) and the one
message says so, names the fix
(`herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin --ref
herdr-vX.Y.Z`, then `herdr plugin enable herdr-gentle-shell` — the enable
command alone for a disabled install) and states plainly that the sidebar
was switched off because the plugin is not installed. If that switch-off
write fails, the message reports the true outcome — still on, and why —
never a false success. When the plugin is present and usable the check is
quiet; when it is unusable but the sidebar is already native, the plain
once-per-session plugin alert still fires and the sidebar option is left
untouched. The other verdicts
(installed under the retired id, or at another version) keep the alert shape
and name the update (`herdr plugin update herdr-gentle-shell`) or enable.
A locally linked plugin counts as installed and is reported as linked, never
as missing; an absent or erroring Herdr CLI, or unreadable metadata, fails
silent and harmless.

Turning the sidebar ON is gated symmetrically. Enabling `Gentle` without the
installed, enabled plugin is refused BEFORE any write: no mode flag, no
settings exclusion, no `config.toml` rows, no ownership marker, and the
switch stays native. Retrying while the plugin is still absent re-emits the
same message, which names the concrete install command (without an explicit
`--ref`, so `install.sh` resolves the newest `herdr-vX.Y.Z` release tag).
Disabling never runs
this gate — a missing prerequisite may block turning a feature ON, never OFF.

### Reset every option to its defaults (`/herdr-gentle:customize` — `Reset` row)

The panel's `Reset` row returns the user-visible options to the
defaults their own read sites define — `sidebar` Gentle **when the Herdr plugin
is installed and usable and OFF when it is not** (see below), `moshi` off and
`worktree` enabled — by writing each default THROUGH the same writer the
corresponding row uses, never by deleting a flag file. The moshi reset
therefore also clears its Pi `settings.json` exclusion, and the sidebar reset
lets its Herdr `config.toml` managed rows and ownership marker converge
exactly as choosing `Gentle` would. Per-option outcomes are reported: a full
run notifies `Defaults saved.`; a failure notifies `Partial reset: <option>
changed|unchanged, …`, naming the failed option as unchanged together with its
reason. A run where nothing succeeds says `Nothing was changed.` — but only
when no write truly landed anything: a plugin-tools write that **half landed**
is reported as `Half applied` instead, naming the copies that already hold the
new value, the copy left untouched, and the fact that the pair now disagrees
(the toggle reads Disabled until it agrees); a duplicate copy the run
**repaired** is named by path with the note that its previous contents were
discarded. When
every option already matches the default that applies in the current state the row
notifies `Nothing to reset: the sidebar is already OFF by default, and moshi
and worktree already match their defaults.` and writes
nothing at all.

The row never depends on the Herdr plugin being installed: the reset is always
attempted. The sidebar's default is CONDITIONAL — Gentle when the plugin is
installed and usable, OFF when it is not — because enabling the sidebar is
refused while the plugin is missing. A sidebar left OFF without the plugin is
therefore reported as that default APPLYING, never as a change that failed:
the notice leads with `Defaults saved.` and adds that the Gentle sidebar cannot
be enabled until `herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin && herdr plugin enable herdr-gentle-shell`
succeeds. A writer that genuinely FAILS is still reported as
`Partial reset: <option> changed|unchanged, …`, naming it with its reason, so an
unreachable default and a real error never read the same way. Because the
default itself moves with the plugin's presence, "nothing to reset" is judged
against the default that applies in the current state: without the plugin an OFF
sidebar is nothing to reset, while with the plugin present an OFF sidebar is
something to reset. The
`gentle-sidebar-mode.json`, `gentle-moshi.json` and
`gentle-worktree-mode.json` files are rewritten, never removed.

### The agent warp is a queued handoff (S14)

The host keeps session control — `waitForIdle` and `switchSession` — on the
**extension command context**. A tool's context has neither, and a tool that
awaited `waitForIdle` would wait for the very turn it runs inside (a
self-deadlock). The agent-facing `worktree_warp` tool therefore cannot move the
session, and it does not pretend to: it resolves the checkout, validates the
requested `changes` selection and **queues** the move to the one verb that can
perform it. The tool mutates NOTHING — the copy of the requested changes happens
inside the command, at move time.

How the queue works: the tool calls
`pi.sendUserMessage("/herdr-gentle:warp @<token>", { expandPromptTemplates:
true })` — the host's documented route for a tool that needs a command (its own
`examples/extensions/reload-runtime.ts` does the same for `reload`). The host
dispatches a registered extension command immediately, even while the turn is
still running, and binds the command context to it. The token is base64url of
`{v, name, target, from, branch}` plus, only when a copy was asked for,
`changes: {mode: "all"}` or `changes: {mode: "paths", paths: [...]}`: one
opaque argument whose charset cannot carry a space, a newline, a control
character, a second argument or a second command, so nothing from a checkout
name or path can be injected into the command line. It carries checkout
identity and the selection only — never file contents, environment or
credentials. The command decodes it, refuses anything malformed (naming nothing
it carried), and then warps through the same resolver, fork/resume rules,
records, rename and card a human invocation uses.

The token is bounded — 2048 characters — and the bound is enforced on the way
OUT as well as in. The tool encodes the request, checks the cap and round-trips
the produced token through the command's own decoder before it queues anything,
so "handoff queued" can only ever be claimed for a request the command accepts. A
selection too large to fit refuses in the tool (`the warp handoff is too large to
queue: … exceeds the 2048-character handoff limit; select fewer files in
changes, or pass "all", and warp again`) with nothing queued, nothing copied and
nothing claimed. Enforcing the cap only on decode was the defect: the tool
happily queued a token the command always rejected, reporting a success that
could never happen.

What the handoff guarantees:

- The switch waits for the turn. The command handler calls `await
  ctx.waitForIdle()` first, so the assistant message, every tool result and the
  session's own writes are persisted before the session is replaced; nothing is
  torn mid-turn and the source session keeps its whole transcript.
- The tool never claims the move. Its result is the pending handoff, its first
  line says the session moves when the turn ends, and its details carry none of
  the completed-move rows the tool card renders. The ONE `Warp · moved` card
  comes from the switched-to session, after the real switch.
- The move is exactly one switch. A queued command holds a command context of
  the runtime it was queued in; if a second handoff from the same turn ever won
  the race, the loser's context is stale and the host refuses it
  (`This extension ctx is stale after session replacement`), so it cannot switch
  a second time.
- Drift fails closed. The handoff records the destination it resolved and the
  checkout the session was in; when the command runs, the destination must still
  be the checkout the name resolves to AND the session must still sit in the
  recorded source. Otherwise it refuses (`changed since the handoff was queued`
  / `the session moved since the handoff was queued`) before anything is copied,
  so the destination is untouched and the retry is not blocked by a leftover
  copy.
- A handoff refused BEFORE the copy mutates nothing. Decode failures, an
  oversized token, drift, a selection naming no pending file (refused in the
  tool, before queueing) or a source that changed during confirmation all refuse
  with ZERO destination mutation: the tool wrote nothing, and the shared copy
  helper rejects before its first write.
- A failure AFTER the copy is reported, never hidden and never "cleaned up". The
  copy lands before the switch, so a host that then cancels or throws the switch
  (or a fork step that fails) leaves real files in the destination. Nothing is
  rolled back — deleting or reverting files is not this code's call to make, and
  it would destroy the agent's own uncommitted work — so the result names the
  destination, EVERY copied file and the count (`copied into <dest> before the
  move failed: 2 files: a.txt, b.txt`), states that nothing was rolled back and
  that the source keeps its pending work, and offers the recovery: warp again
  with the same changes, or commit or revert those files in the destination and
  warp again, or warp again without changes to leave the copy in place.
  `details.copyDestination` and `details.copiedFiles` carry the same facts for a
  machine reader.
- A retry never guesses. An earlier copy makes the source and destination
  overlap, so the copy cannot simply run again; instead the command PROVES the
  state, read-only. It skips the copy only when EVERY selected path is proved: the
  same bytes on both sides, or — for a TRACKED DELETION only — absent on both. A
  read that fails for any reason other than "no such file" (a permission error,
  an I/O error), a symlink or any other non-regular file, a path escaping either
  checkout, an untracked entry whose source file is gone, or content that differs
  all mean NOT proved. An unreadable file is never evidence of an absent one:
  treating the two as the same would let the session move while silently omitting
  the file. Anything unproved fails closed — the refusal names the destination,
  the files that no longer match and, separately, the files that could not be
  read, says nothing was rolled back or overwritten, and gives the recovery (warp
  again without changes, or reconcile those files in the destination and warp
  again). A proved skip reports `copyAlreadyPresent: true` with the file list. No
  file is ever deleted, reverted or overwritten by this path, and neither index
  is touched.
- A handoff never prompts. The interactive `YES COPY` / `NO COPY` choice is a
  human path; the tool's `changes` selection is the same transfer without a
  question, so a queued command can never block on a picker nobody asked for.
- The work continues. The switched-to session sends the card and
  `Continue the task from here.` with `triggerTurn: true` and `deliverAs:
  "followUp"` — on the fork AND on the resume path (a human invocation still
  resumes silently, R2) — so the agent keeps working in the new checkout.

What it does not guarantee, stated rather than hidden: the tool's result goes
back to the model, and the model may take **one more turn in the checkout being
left** before the run settles and the switch lands. Those writes stay in the
source checkout (nothing is lost or overwritten). Because the copy runs at move
time and re-reads the source then, `"all"` carries whatever is pending when the
move actually happens (those late writes included), while an explicit file list
carries only the files it names. The pending text says so (`the session moves
when this turn ends`). It also does not guarantee a copy that has already landed
is undone: see the post-copy rule above — the failure names it, and the recovery
is the agent's decision, not an automatic revert. A host with no `sendUserMessage`
route refuses the tool before reading anything (`the host cannot dispatch the warp
command`).

### Warp command (`/herdr-gentle:warp`, S23)

`/herdr-gentle:warp <name>` moves the session to the named
checkout, where `<name>` is the flattened branch slug the listing prints
(`feat/worktree-warp` → `feat-worktree-warp`), or `principal`. With no
argument it opens the redesigned selector as a BOTTOM PANEL (S3, L6): it is
still a focusable `ctx.ui.custom()` overlay — a `setWidget()` panel is
display-only and cannot receive keys — anchored `bottom-center` at full
width with no margin, and its height is the content's own, so the frame always
fills what it draws. It is laid out top to bottom (S4): the title line
`Warp`, the current session's worktree, that worktree's data line, a blank
separator, at most five worktree rows, an optional `view all worktrees` row,
the focused worktree's data line, and the ONE key-legend row. The current
worktree owns the header and is never one of the rows; the rest are ordered
most recently modified first (`lastActivity`, the same activity the data
lines already render — ordering adds no git call), with the principal always
first whenever it is not the current worktree (S4b). The
`view all worktrees` row appears if and only if at least one worktree is not
shown (S4c, reconciled in L2): with five or fewer others every row fits and
neither the row nor its key exists. Rows show checkout names only; a branch
appears in a data line, never in a redundant second column. Creation is a
hotkey (`c`), never a row (S6). The selector mounts before
slow facts complete and refreshes the visible data asynchronously. `v` (or the
`view all worktrees` row) opens the extended list of
every checkout of the project, with an always-active filter (`T` or `/`
opens it empty, any other printable opens it with that character, and once
open every printable — space included — is text), pagination with
`pgUp`/`pgDn`, and `esc` to step back to the panel. Both data lines are
honest: branch, the
change size as LINE counts (`changes +A −D` — the tracked diff plus the
lines each untracked file adds), the commits ahead/behind `main` and both
ages (`created <age> · modified <age>`). A worktree carries no issue or ODD
association any more, so neither a count nor an identity of one is rendered —
a legacy registry value is ignored, never migrated and never printed. Creation uses an actual recorded
creation timestamp or filesystem birth time, never the time a checkout was
merely discovered or registered. With a known creation time, an inherited
older commit is not checkout-local modification; without newer local evidence,
activity is unavailable rather than dated before creation. Otherwise activity
uses the newer readable commit or dirty-file timestamp. A measured zero is
omitted from the line for the change size and for each of `↑`/`↓`
independently — a clean checkout therefore shows neither, and only the
non-zero direction of ahead/behind appears. `unavailable` is not a zero
and stays on the line, with its reason where one was supplied, whenever git
or the registry cannot answer (S9) or an untracked file's lines cannot be
read (S16), so "nothing to report" and "could not read it" never look
alike. Every label on a data line is English (`branch`, `changes`, `created`,
`modified`). The current worktree's line reads the same
way as the focused one (S4a). The principal checkout comes first among destinations when it is not current.
Other rows are ordered by readable activity, newest first; unavailable activity
sorts after known activity. The panel warps and creates, and it DELETES only through the confirmation
below: `Ctrl+D` on an eligible row requests a delete, and a keypress alone
removes nothing. There is no edit key.

There is no fullscreen worktree detail any more, and no `e` that opens one.
Worktrees no longer receive issues or ODD documents, so the surface that
assigned them — its Issues/ODD tabs, its `space` toggles, its `ctrl+s` save and
the verification sweep that re-read the registry — was removed with the
association. `/issues` and `/odd` keep their own read-only viewers; a legacy
stored association stays exactly as stored (nothing migrates it, nothing
prints it) and no key in the warp sets, clears or verifies one.

Creation uses a compact bottom panel with **Type · Name** tabs and only the
active field visible. `tab`/`shift+tab` or `←`/`→` switch fields; `↑`/`↓`
choose the type. `enter` on the Type tab advances and on the Name tab creates
(it is the only create key), and `esc` cancels. Typing on Type starts Name. The
derived branch and path appear above the tabs; both remain neutral `-` until a
valid candidate exists. Neither the preview nor the submit key spawns a `git`
child while the human types: the preview derives from the pure halves of the
shared helpers, so painting a keystroke asks git for nothing (S1 — the live
preview used to run `git check-ref-format` from `render()` on every keystroke,
which froze Pi for the child's whole lifetime), and the only child it keeps is
the memoized `git rev-parse` identity probe, read once when the preview first
derives. The authoritative branch check is the create
path's own awaited `validateBranchAsync`, so an invalid branch is still refused
with the create tool's message and nothing created. A refused submission names
its error without colouring an incomplete preview red. No Issues/ODD selector
or association state is added to human creation. See
[Tabbed bottom creation](warp-create-feedback.md).
The type plus the typed name derives branch `<type>/<slug>` and checkout
`<type>-<slug>` per the branch-pr skill's
`^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$`,
then creates through a git-only creation (a plain git checkout plus the
registry row through the same `worktree_create` validations — never a
Herdr workspace; the checkout lands beside the PRINCIPAL checkout even
when the panel runs inside a linked worktree) and STOPS there (S7).
Every NEW branch is born from local `main` (S2), never from whatever the
invoking checkout has checked out, so a session working inside a linked
worktree cannot seed a "fresh" worktree with its own unmerged commits. The
commit used is reported as `base` in the details, and a repository with NO
local `main` refuses the create before anything is written (`cannot create
worktree for branch '<b>': this repository has no local 'main' branch, and a
new worktree is always born from local main — … nothing was created`) — there
is no HEAD fallback to guess a base from. An existing branch is adopted as-is
(its own commit, no `-b`, no base), so adoption needs no `main` at all. Before anything is
written, the panel's creation offers the invoking checkout's pending work
(S2/S3): a dirty checkout asks the same `YES COPY` / `NO COPY` question the
warp asks (`Esc`/`Ctrl+C` cancels the creation with nothing written), and the
answer becomes the create path's `changes` selection — `"all"` or `"none"` —
so the transfer, its preflight and its refusals stay in one place. The question
is a step of this flow like the panel is, so it mounts with the same bottom
overlay (`bottom-center`, full width, no margin): mounted bare it painted as a
fullscreen component in the middle of the flow. It is also asked ONCE per flow:
the create remembers that the human answered, and the ONE warp that follows it —
and only when it targets the checkout that create made — reuses that answer
instead of asking again. Without that, the same pending work would be offered
twice, and a second copy would be refused by the destination as an overlap the
human cannot resolve. A clean
checkout asks nothing. Only a POSITIVE "nothing pending" answer skips the
question: when the pending-change summary cannot be read (a broken index, an
unreadable `git status`/`git diff`, a missing helper) the creation FAILS CLOSED —
one visible error naming what could not be read, no branch, no checkout, no
registry row — and the selector returns, because silently creating without the
copy would leave the human's pending work behind right after they asked for a
worktree. The warp's own optional `changes` keeps the older, documented
degradation (an unreadable summary still warps ordinarily with no copy); the two
contracts differ on purpose and each is pinned by its own test. Creating is creation:
nothing is warped by itself. Once the creation flow closes — created, refused
with the reason shown, or cancelled with `esc` — the SELECTOR comes back with a
freshly read listing that includes the checkout just made, and the human picks
where the session goes,
including that new row; only that pick warps, and `esc` on the returned selector
moves nothing. A cancel is not a way out of the flow: it discards the form (no
branch, no checkout, no registry row, no notification) and reopens the selector,
which is what "volver a warp" asks for.

The selector comes back as soon as the PATH exists, not when the checkout is
finished: the slow half of the creation hooks — dependency install by detected
stack and `codegraph init` — used to be awaited, so a confirmed create sat
behind a package manager and read as a hang. It is now handed to a managed
background task (`backgroundHooks`), which is the interactive create's route
only: the `worktree_create` tool still awaits its hooks, because its result is
the agent's only report. What the flow guarantees about the background task:

- **Nothing is skipped.** The same phases run, through one `setup()` callable
  the hooks library returns; a second call returns the same promise, so a retry
  can never install twice.
- **The copy is never backgrounded.** The selected pending changes are copied
  inside the create and awaited, and the setup starts only AFTER that copy
  settles: a `codegraph init` writing into the destination while the copy
  preflights it would read as a destination overlap and turn a good copy into a
  reported failure. The human therefore never switches into a checkout that is
  missing the work they asked to carry.
- **Nothing is orphaned and nothing is swallowed.** Every task is tracked until
  it settles, each settles into exactly ONE report, and the task never rejects.
  A failure is reported at `error` level with the failing step and its reason,
  plus the fact that the checkout stays usable; a setup where at least one step
  COMPLETED reports what ran at `info`. `awaitPendingCreationSetups` is the seam
  that waits for the last one.
- **A no-op setup reports nothing.** Every deferred step can be skipped (no
  lockfile detected, `codegraph` not on PATH), and a run where no step completed
  has nothing to announce: announcing `setup finished` there was a success toast
  for work that never happened, and the interactive create showed it on every
  such checkout. Silence therefore means exactly "nothing ran, nothing failed" —
  a failed step, a failed outcome or any warning is still reported, and it is
  checked FIRST, so no failure can be suppressed by the no-op rule. The create's
  own text keeps the honest `pending` line either way.
- **The create's own answer stays honest.** The result names the setup as
  pending (`setupPending`, a `pending` step per deferred phase, and
  `codegraph: pending (setup runs in the background)`) instead of claiming an
  init it has not seen; `codegraph: initialized` is reported only by a create
  that really ran it.

A refused copy never overstates what happened either. The shared transfer can
fail PARTWAY and reports the files that already landed (`N of M files already
copied`); the create says the pending changes `were NOT copied in full`, and the
warp's refusal scopes its safety sentence to `nothing was rolled back and
nothing was overwritten beyond the files listed above`. Neither path ever claims
an unqualified "nothing was overwritten" when the destination holds files the
attempt put there.

Because creation no longer ends in a warp, it needs no fork
source: a session Pi has not written to disk yet creates normally instead of
being refused by a session preflight. A creation carries no `issues`
and no `odd` on the create call — the row is born without an association —
so the invalid, duplicate, occupied and principal
refusals keep their exact shape; an empty or unrepresentable name refuses
with an actionable message, and a duplicate branch refuses with the create
tool's own message — which is exactly what the human reads: a refusal is
reported verbatim from the create path's tool result, never swallowed, and the
selector comes back as it does after a successful creation; an
explicit `<name>` skips the selector and also resolves a lone unregistered
checkout. In either the panel or extended list, `Ctrl+D` on an eligible
focused row always requests explicit human confirmation, even with YOLO active.
The dialog names the target/path, pending changes (`N files, +N/-N`) and commits
ahead of local `main` when present. Unavailable evidence is reported as unknown,
not zero; a missing `main` is never silently replaced with an upstream ref.
Cancellation or an unavailable confirmation UI deletes nothing. An explicit Yes
then invokes the guarded close once; only positive dirty evidence adds
`force: true`. This keyboard confirmation is not waived by the separately
invoked agent close tool's permission policy.

The checkout's IDENTITY is pinned, because a path is a pointer and a removal
resolves it. Every row the selector offers is a live checkout's own realpath,
so that value is the approved identity: it is compared before the question is
asked, compared again with the reading taken after the answer, and carried into
the shared close, which re-reads it immediately before any remover runs. A path
replaced by a symbolic link to another checkout — the dangerous shape, because
two `detached` checkouts can present an identical disclosure (unknown live
branch, same counts, same bytes) — is refused with the link and the checkout it
now resolves to named, before and after the answer alike, and no remover is
invoked. `git worktree remove` resolves the spelling it is given, so without
this pin a swapped path would name a checkout nobody approved; a change to any
other part of the reading is refused the same way, naming what moved.

The pin is the DIRECTORY, not just its spelling: the approved reading also
records the `dev`/`ino` pair of the object at that path, and the close requires
it to still match. A realpath comparison cannot see the one swap that keeps
every string identical — the approved checkout moved aside and a different
directory put at the same path — while an inode cannot be reused by another
directory. A path that is itself a symbolic link is refused too, since every
offered row is a realpath. If the identity of the directory cannot be read, the
delete is refused rather than downgraded to the weaker check.

WHO CHECKS LAST IS THE PROTECTION. The close resolves the Herdr workspace from
`herdr worktree list` BEFORE its final identity read, because that listing is a
child process: it is an await, and an await is the longest window a swap gets
between a check and the remover. A reproduced race replaced the approved path
with a symbolic link to another detached checkout exactly while that listing
ran, after the check that used to sit above it, and the remover was launched
naming the other checkout. Now the listing resolves first and the identity check
is the LAST thing before the remover is launched, with no await between the two.

Limitation, stated rather than papered over: the check and the removal cannot be
one atomic act. `git worktree remove` and `herdr worktree remove` take a path (or
a workspace id) and resolve it in ANOTHER process, and neither Node nor the
filesystem offers a handle-based "remove this exact directory" (no
`openat`/`O_NOFOLLOW` removal, no compare-and-swap), so a swap landing between
the final check and the remover's own `stat` is still possible. What is closed:
every await-sized window, plus any replacement of the path (a link, or a
different directory at the same path, caught by the pinned inode). An attacker
must now win a race measured in microseconds inside another process instead of
one measured in an arbitrarily slow child. Nor is a backend's own validation a
substitute: git 2.56 refuses a symlinked spelling because the checkout's `.git`
does not point back to the admin directory that spelling implies, which is
incidental to this surface and not present in every remover or version — the
Herdr route removes by workspace id, so a test asserts the refusal here happens
with NO remover launched at all, before any backend gets a say. A remover that
deletes any checkout
other than the target is still caught afterwards and reported (see the vanished
comparison above), with the registry entry kept.
Only a REGISTERED agent worktree is deletable — the principal checkout,
the current checkout and an unregistered live checkout are safe no-ops,
and the `view all worktrees` row is not a checkout. The project's live checkouts are discovered at session startup
(S28: every repository worktree through git is registered when missing —
the creation path is only where new ones are born) and freshly on every
Warp invocation. The agent tool (`worktree_warp`) resolves the same way — a required name-or-path, name first then path, unknown/foreign/ambiguous failing closed with the available checkouts listed — and never opens a selector. It also never waits for idle and never switches: both live on the command context, which is what it queues (S14). The command keeps the idle-slot wait (`await ctx.waitForIdle()` before forking) and the fork/resume, records, rename and card; the only difference on a queued handoff is that the switched-to session always sends the card AND the continuation sentence with `triggerTurn: true` / `deliverAs: "followUp"` — on the resume path too, where a human invocation stays silent (R2). Session control
(`waitForIdle`/`switchSession`) lives on the extension command context, so
a tool context cannot do this. The name resolves through the same resolver
as close-by-name — one place, never two: an unknown name fails closed
naming the closest names (up to three), and a name that more than one live
checkout carries is ambiguous and fails closed naming each of them, with the
unregistered one marked as such when the warp is not allowed to take it.
`principal` is reserved, so a branch whose
slug is also `principal` makes that name ambiguous too.

Success text is the two-line compact `moved: <name> · <branch>` / `to: <name> · <branch>`, both read from the checkout's CURRENT branch and head in git (a stale registry row never shows); warping to the checkout
the session already runs in returns `worktree warp: <name> (already there)`
(the text is byte-identical) and changes nothing and shows nothing — no fork,
no switch, no OSC-7, no notification, no message, no record write (R1). Exactly ONE visible confirmation exists per real first move: the fork's styled card — one short notice naming the new checkout (`Worktree warp: now in <path> (branch '<branch>').`). A resume switches silently (R2: the recorded session already carries its notice, so re-entering appends no copy); already-there warps show nothing at all, and cancelled switches (the host never runs the session callback for those) and refusals send none. A target whose path does not exist or is not a checkout of this repository fails closed before any fork or notice (`no live checkout for "<name>" at <path>`, naming `git worktree list`). The command itself stays silent on success (no duplicate notification), and the notice renders as a styled card — not Pi's default `[worktree-warp]` block — through the `worktree-warp` message renderer the extension registers. The card carries the shared branch glyph, the capitalised label `Warp · moved`, and the compact ordered name-only lines `moved: <source name>` / `to: <target name>` (no branch, no path on either row) read from the message details; expanded (ctrl+o) it appends exactly `path: now in "<current absolute path>"` and `branch: now in "<current branch>"` in that order, never the prose notice. The expand hint right-aligns on the card's heading row (`⎇ Warp · moved`) and the closing rule stays empty, exactly like the tool cards; a click on those hint cells toggles the transcript through the same opt-in `toggleExpanded` seam the tool cards use (see "Expanding a card" above), so its keyboard path stays `ctrl+o`. In the expanded form nothing is cut: long lines wrap to the inner width, and only the compact row may clip. Its tone is the documented `warning` role: the installed Pi theme schema exposes no orange role, so warning (yellow in the built-in themes) is the closest documented match for git-orange. Like the tool cards it follows gentle-shell's float recipe: full-width rows in one-column transparent margins with a blank padding row above the heading and between heading and body, every row painted behind `toolPendingBg` (the tone-table role for warning; `customMessageBg` is used nowhere in gentle-shell) and re-armed after every inner reset — a theme without the role, or a width under 10, keeps the outlined card. Refusals and cancellations send no card, so only failures notify. Fork vs resume is a filtered-point comparison (S43): the point of a session is its ACTIVE branch — the live leaf's `parentId` path exactly as `getBranch(leaf)` walks it, never all append-only entries (an abandoned leg after a branch-off does not count) — filtered to entries that are not our own bookkeeping, and it still travels on the records for inspection. Bookkeeping is exactly four proven shapes: the `custom` warp marker, the `custom_message` warp notice the switched-to session sends (it persists through the runtime's message entry, which is why the old filter re-forked every warp back), the `custom` session-worktree registration entry startup appends, and every `session_info` checkout rename. Anything else — user/assistant/tool entries, model/thinking changes, unknown custom shapes — is session content and counts, so a fresh fork's filtered point still equals its source's. The leaf of a session file is recovered the way the runtime itself does (its index keeps the last entry's id; no separate leaf pointer is persisted). Every transition records BOTH sides at their post-transition points read FRESH — the destination file as re-read after the switch (the file the live runtime kept appending to, never the stale pre-switch manager and never copied from the source) and the session file just left, each its OWN point — and a warp resumes the destination file only when that record names an absolute session file that still exists AND the destination file's actual point equals the current session's point (same content, no fork, no notice); a checkout with no usable record, an unreadable destination, or a different point because real work happened, forks. Limitation: a model or thinking-level change counts as content (it changes the effective session), so a hop across one forks; concurrent warps may each fork with the last writer winning. Every fork branches from the highest identical ancestor: the warp climbs the session tree's `parentSession` chain while each ancestor's filtered point equals the current session's and forks from the highest such ancestor (bounded, failing safe to the last good file), so an untouched fork yields a sibling of the first fork while an advanced session yields its own child. Because a sibling fork was cut from the ancestor, the current leaf (a notice or rename the fork appended later) is not in it: positioning then falls back to the deepest non-bookkeeping entry of the current active branch, which the climb guarantees the fork holds. Each fork is renamed through `SessionManager.open(path).appendSessionInfo(name)` to carry its checkout (the session's original name — its first `session_info` entry, else the current name, else the checkout label alone — + " · " + the checkout name written once, never on resume, never rewritten when already there). Work written after a visit stays in the thread where it was written: warping back later resumes each checkout's own session instead of copying the new work over. A missing, corrupt, or stale record (its
session file is gone) forks once more and overwrites the record; a corrupt
record never fails the warp. The record lives in its own repo-scoped file
`<git-common-dir>/pi-warp-sessions.json` (beside `pi-worktrees.json`, never
inside it), mapping each checkout realpath to `{sessionFile, tipId, count,
updatedAt}` (`{sessionFile, leafId, entryCount, updatedAt}` reads identically
for records written before the fix); it is written only after a successful switch, so refusals, `Esc`,
and the already-there no-op write nothing. The mechanism is
`await ctx.waitForIdle()`, capture the session file/leaf/cwd, refuse when
there is no persisted session, refuse when the target is not a live checkout
of this repository, resume the recorded session file when it is still usable
and its point equals the current session's (status update only, no message), else `SessionManager.forkFrom` from the highest identical ancestor (or, for a session
Pi has not written to disk yet — brand-new, living only in memory — clone
the in-memory entries into a session allocated for the target cwd via
`SessionManager.create` + `open`), `branch(leaf)` (or `resetLeaf()` when
there is no leaf) plus one `appendCustomEntry` transition record naming both
cwds — skipped when the target already carries that exact transition, so the
custom-entry sequence never accumulates duplicates — then `ctx.switchSession`
with a status update and the one-line transition notice (triggering no
turn). `cancelled` is a real outcome, not a success:
it removes the forked target session file (a cancelled resume keeps the
recorded file, which still belongs to the checkout), reports it, and changes
nothing else.

Honest scope of the move: the SESSION cwd changes and the tools operate in
the target, while the PROCESS cwd does not (Pi never calls `process.chdir`).
After a successful switch the command emits OSC-7
(`ESC ] 7 ; <file-url> ESC \`, a percent-encoded `file://` URL of the new
cwd, only when the output stream is a TTY) so
the TERMINAL learns the new cwd, and Herdr follows it natively: it embeds
ghostty-vt, whose `pwd_changed` callback is documented as fired by OSC 7,
so its pane pwd tracks the emission and new panes, tabs and workspaces with
`new_cwd = "follow"` inherit it; no cmux-style socket protocol is needed.
That Herdr leg is documented from herdr's own source and changelog and is
NOT exercised end to end here — herdr's CLI offers no way to inject bytes
into a pane and no field for the terminal pwd (`herdr api snapshot` reports
only each agent's `cwd` and `foreground_cwd`) — while the emission itself is
unit-tested for its exact bytes and its TTY guard. The open interactive
shell never changes directory: a child process cannot change its parent
shell's cwd.

## Session open (S25)

`worktree_session_open` opens a Pi session in a Herdr worktree, and only
in a worktree. The scope guard is enforced, not documented: the `worktree`
value resolves through the S24 name resolver (`resolveCheckoutByName` in
`extensions/gentle-worktree-tools.ts` — one resolver, never a second
one) against THIS repository's registered live worktrees only. A branch
spelling resolves through its flattened slug; a name is tried first and
then a path (S29) — a path resolves only when it exists and belongs to
this project's worktrees, while a foreign path is refused before any
backend runs with `pass the worktree NAME
'worktree list' prints, not a path`, so every command it runs is about a
worktree of THIS repository and never about another checkout. The
principal checkout is refused (a session there
delegates nothing), an unknown name fails closed naming the known ones,
and a registered row whose checkout is gone is refused as stale — only a
registered, live worktree proceeds.

Launching is composed, because no single Herdr command starts a worktree
AND a command in it (`herdr worktree create`/`open` and `herdr pane
split` take no command, while `herdr agent start <NAME> --kind <KIND>
--pane <ID> [OPTIONS] [-- [AGENT_ARG]...]` starts an interactive agent in
an EXISTING pane at a shell prompt):

1. `herdr worktree list --cwd <repoRoot>`; the worktree's workspace is the
   entry matching that branch/path, read as `open_workspace_id`.
2. When there is none, `herdr worktree open --branch <branch> --cwd
   <root> --no-focus` opens one, and `root_pane.pane_id` plus
   `workspace.workspace_id` from its JSON (the same shape `worktree
   create` returns) are used. When the open of an already-open worktree
   fails, one fresh list decides whether a workspace appeared anyway
   (proceed) or the failure stands — the open is deliberately not assumed
   idempotent, because that was never tested against the live binary.
3. When there IS one, `herdr pane list --workspace <id>` names the panes
   and the ROOT pane — the lowest `<workspace>:pN` index, the convention
   every observed workspace uses — is used.
4. `herdr agent start <agentName> --kind pi --pane <paneId> --timeout
   <ms> -- <pi argv>`, where the Pi argv is `--name <agentName>` plus
   `--session <id>` when resuming or `--session-id <minted>` for a new
   session. The id is minted as a UUID (`crypto.randomUUID()`), valid in
   Pi's `[A-Za-z0-9._-]` session-id charset, so it is known immediately
   and returned. The pane's id must carry the worktree's workspace — and the
owner a pane reports, when it reports one, must agree with it — and its
cwd, when the pane reports one, must be the worktree or inside it, before
Pi starts, so Pi's own session directory is the worktree's: no
`--session-dir` is ever passed. A pane whose shell moved elsewhere is
refused, because a session started there would not be in the worktree.

Success text is exactly the two ordered lines `opened: <worktree> · <session-id>` and `path: <path>` — or `resumed` as the second line when an existing session id is resumed.
The `herdrArgv` allowlist (`lib/worktree-git.js`) gains exactly the
commands and flags this uses — `worktree open` (`--branch`, `--cwd`,
`--no-focus`), `pane list` (`--workspace`), `agent start` (positional
name, `--kind`, `--pane`, `--timeout`, `--` plus the Pi argv), `agent get`
(positional target) and `agent list` (no flags) — and keeps its refusal
of `--trust-repository`, because trusting a repository is a human
decision these tools never take. The session tool itself only ever passes
`--no-focus`; the allowlist still accepts `--focus` for the `worktree
create`/`open` calls that predate it. The version floor
stays `0.9.4`: every one of those flags was run against the installed
binary before the spec was written.

### Finish subscription (S26)

Opening a session subscribes the creator to that delegate's real finish:
with `notify !== false` (the default) `worktree_session_open` starts ONE
watcher for the pane it just opened; `notify: false` starts none and never
polls. Watchers coexist in a registry keyed by pane id (opening a pane that
already has a watcher replaces it).

The watcher polls `herdr agent get <paneId>` — the pane id the tool returns
in `details.paneId`, never the kind name — on a bounded interval, never a
busy loop: every 15 s by default, with a 60 s launch grace window before
anything is concluded (the delegate is idle right after `agent start`, so a
finish inside it is impossible) and a 4 h maximum wait. The timer is cleared
and unref'd when it ends.

A finish is `agent_status` reading `idle` AFTER that same pane was observed
`working` at least once, and only for the session this tool opened: the
session file the pane publishes must name that session. `blocked` is the
delegate waiting for input and is not a finish. Exactly one of four outcomes
is reported — and delivered, unless the host never accepts the message, in
which case it is dropped when the maximum wait passes rather than retried
forever:

- `finished` — idle after working.
- `never-started` — idle without ever reporting working.
- `vanished` — the pane or agent disappeared (`agent_not_found`).
- `timed-out` — the maximum wait passed with no finish.

None of the last three claims a finish. Delivery is one custom message to
the creating session — the next send waits for the previous one to settle,
and a send that fails is retried rather than repeated, so the creating
session is told once — `customType` `herdr-agent-sessions.finished`, sent as
`{deliverAs: "followUp", triggerTurn: true}`, the route incoming session
messages already use, because the orchestrator has to act on it (verify,
merge, report). The content states which outcome was observed and names the
worktree, the pane and the session id; `details` carries the same facts as
data (`{worktree, branch, path, paneId, workspaceId, sessionId, agentName,
outcome, seenWorking}`).

Honest limits, recorded not hidden: the watched state is another process's
published view, so "never started" and "never reported anything" are
indistinguishable — the never-started message says so — and a vanished pane
is reported as vanished, never as a finish. A finish is concluded only for
the session this tool opened, matched against the session file the pane
publishes, and that leaves three cases worth naming:

- A pane whose agent publishes NO session binding at all leaves the
  published status as the only fact, so a finish is concluded from it. This
  is the pre-binding contract, and the one case where a pane holding
  something other than the delegate could be reported as our finish.
- Resuming with a PARTIAL session id (Pi resolves it to a file) cannot be
  proven ours from the file name, so it reports `never-started` instead of
  claiming a finish.
- Resuming with a RELATIVE path has the same effect: the pane publishes an
  absolute path, and the file name is compared against the id you passed.

## Request idempotency (several worktrees per session)

A session owns the checkouts it creates and may own **several** at once
(S9/L31). Thread identity resolves from `GENTLE_WORKTREE_THREAD` first, else
the Pi host session id via `ctx.sessionManager.getSessionId()`; without either,
`worktree_create` fails closed (`cannot resolve thread identity: …`) and never
adopts another thread's checkout.

`already exists` is keyed ONLY to the requested branch: when this session
already registered a row for THAT branch and its checkout is still live, the
call returns that checkout — the same shape with `· already exists` on the
first line, `registered: unchanged`, the checkout's real CodeGraph index state
(`codegraph: initialized` / `codegraph: not initialized`, read from the
checkout and never initialized on this path) and `alreadyExists: true` in
details — never a second checkout and no second `codegraph init`. Any other
checkout the session owns neither blocks the request, substitutes itself, nor
answers `already exists`: asking for branch B while owning A creates and
registers B. Still-live is the same consolidated predicate (`checkoutState`):
the row's state must exist AND be a directory AND its realpath must match a
live checkout (relative inputs resolving against the repository root, never the
process cwd), so a row that reaches a live checkout through a symlink is live
and is returned, never dropped. Idempotency consequence: a tool-created row
whose checkout the user deleted by hand is stale even while git still lists it
— the stale git record is pruned (`git worktree prune`), creation proceeds
fresh at the same path (checking out the surviving branch ref), and the result
reports the prune instead of answering `already exists` at a missing path.
A stale entry
(checkout gone) is remembered and dropped only after its replacement
checkout verifies — a refusal or a failed creation leaves the row intact,
so the tool either creates successfully or fails with the row still
registered and an actionable message, never an empty registry behind a
refusal.
The cleanup drops the one row it identified for this request by row
identity — the (branch, path) pair of the selected entry
(`removeWorktreeExact`) — never by branch alone and never by a path-key
lookup that can match a different row, so a live entry sharing the branch
survives whether the stale path is absolute or relative. A dead row that names
another branch is left alone by the create: the listing's own self-heal
(`pruneWorktrees`) is what drops dead checkouts.

The one-owner-per-path guard is untouched by S9: a live checkout already
sitting on the requested target path is refused, so two branches flattening to
the same slug can never share (or steal) one directory.

`worktree_list` shows each entry's owning thread; `worktree_close`
reports it (`details.thread`, plus `This checkout is owned by thread
'…'.` in the approval prompt, or `This checkout has no recorded owning
thread.`) rather than refusing — a delivered thread is routinely closed
from a later session.

## ODD writes: session naming only

The extension observes the Pi tool pipeline (`pi.on("tool_call")` and
`pi.on("tool_result")`) for the `read`, `edit`, and `write` tools. The hook is
gated by the worktree mode, read fresh from `lib/worktree-mode.js` on every
event: a disabled or malformed mode does nothing and performs no registry
write at all.

It records **no association**. S1 removed the issue/ODD association from every
worktree surface, so a worktree carries no ODD document: the hook does not
associate a touched document, does not scan the worktree's `odd/` directory,
and never writes the registry — the registry's stored legacy records are
byte-for-byte untouched by every tool event. The worktree of the **agent's
context** (the invoking context's working directory matched to the longest
enclosing registry entry, never the file path itself, because `odd/` is a
symlink into the principal checkout) is resolved only to supply the branch
suffix of the session name, and the detector stays inactive while the session
runs in the principal checkout (S30).

`bash` commands touching `odd/` carry no reliably parseable path (arbitrary
shell text, redirections, quoting) and contribute nothing. The hook never
throws and never blocks the pipeline: any failure is swallowed.

## Automatic session naming

The same pipeline event also names the session after the ODD task document
that was **written**: a write to `odd/tasks/<feature>.md` inside a
registered worktree sets the session name to `<heading> @ <branch>`
(`lib/session-auto-name.js` derives it, the extension only calls
`pi.setSessionName`). The heading is the document's own first level-1
heading — the honest statement of what the work is about — trimmed, with
inner whitespace collapsed and truncated to 48 characters on a word
boundary. A document with no readable heading falls back to the filename
slug (`odd/tasks/pi-fullscreen-perf.md` → `pi-fullscreen-perf`). Reading
never triggers — an agent reads many ODD documents for context, so a read
would make the name jump to whatever was opened last. Writing the same
document again derives the same label and writes nothing, so the hook can
run on every event without spamming the session record.

The session NAME is the channel because Pi exposes no subject or alias
write; the extension's event context has no `executeTool`, so gentle-pi's
private subject cache is unreachable. Never-clobber is therefore decided by
**pattern**, not by a stored flag: the plugin writes only when the current
name is empty or is one it can account for as its own. That covers the
label this session already applied (remembered in the module), a name
ending in ` @ <this worktree's branch>` (what makes a resume recognizable
with no memory), the plain filename slug an earlier version wrote, and the
document's current heading. Any other name was chosen by a human and is
left alone, and a hand rename after an automatic one sticks. The admitted
consequence: a session a human names exactly like one of those shapes is
indistinguishable from the plugin's own label and may be updated.

Collisions are always resolved with the branch suffix rather than only when
a peer is detected: the host exposes nothing that enumerates the live
sessions of a clone, and the branch is already unique per worktree, so
always suffixing is the conservative choice that guarantees two concurrent
forks of the same feature never share a name. The principal checkout is
never named — a call whose context is the principal resolves no worktree
entry and stops before the naming step.

An ODD **phase transition** re-applies the label the session last derived
from a write. `gentle_odd_phase` names the phase, never the feature, so the
module remembers the last derived label per session and the phase trigger
only re-applies it through the same ownership test; a session that never
wrote an ODD document has nothing to re-apply and is left alone. The
transition is observed on `tool_result` (that tool is gentle-pi's, not a
host event). A resumed session carries its name in the session record, so
the derivation also runs again on the next write and moves the name to the
document now being edited. Both triggers sit behind the worktree-tools
toggle: with it off the handler reads the mode first and returns before any
naming, so neither trigger can fire.

## Viewport capacity and search

There is no fixed 20-item page. `H` is the host terminal's current row count:

- Issues reserves six chrome rows: body budget `max(1, H - 6)`.
- ODD reserves four: `max(1, H - 4)`.
- Worktree detail normally reserves five plus the actual wrapped header rows;
  its row planner clips chrome/header only on tiny terminals and preserves a
  body row when possible.

Each item spends the rows its complete wrapped label needs, so a two-line
item costs two rows. Pages contain whole items; a taller-than-page item gets
its own page. With 40 terminal rows and single-line items, Issues fits 34,
ODD 36, and detail 32 when its header occupies three rows. A narrower pane
or longer header reduces that capacity through measured row costs, not a
second guessed item limit. The shared width rule allocates roughly 40/60,
reserving the divider and narrow-terminal minimums.

## Issue snapshot cache (S10/S7d)

The issues reader keeps ONE complete open-issue snapshot per repository and
session, keyed by its shared Git common directory. A worktree carries no issue
association (S1), so this snapshot exists for the READER's freshness: the
margin it records is the only evidence a stored page row may be invalidated
with. The interactive Issues list is a separate server-paged reader, not a
projection of that snapshot.
Session start takes it in full through GitHub's own cursor pagination
(`lib/gh-issues.js`, `listAllOpenIssues`): `gh api graphql` asks
`repository.issues(states: OPEN, first: 100, after: $cursor)` for
`pageInfo { hasNextPage endCursor }` and `totalCount`, one request per page,
then a repository lookup plus one request per 100 issues — never a repeated
download of the whole set, and no fixed issue cutoff. GraphQL is used instead
of `gh issue list --search` because the search API caps its own result set.
Both this snapshot and the interactive reads are scoped to the checkout's OWN
repository — the unambiguous NON-BASE remote (branch `pushRemote`,
`remote.pushDefault`, `origin`, or the tracking remote when not named like a
base, else the only non-base remote) — because `gh` resolves the upstream base
for a fork checkout with `origin` and `upstream` remotes. A fork whose remotes
are `upstream` + `myfork` while the branch tracks `upstream` therefore still
reads `myfork`; several non-base remotes with no attach point fail closed rather
than guess. The scope travels as a HOST-QUALIFIED `GH_REPO`
(`<host>/<owner>/<repo>`), and a single-remote checkout keeps `gh`'s own
resolution (the reader then pins gh's host-qualified answer). The scope is used
only when the selected remote proves the GitHub server `gh` will actually
target (the remote's own `github.com` host, or the exact host named by
`GH_HOST` — an enterprise or self-hosted server requires `GH_HOST`, because
`gh api`/GraphQL use the default host) and a valid `owner/name`: a
local/`file://` or non-GitHub remote, a `GH_HOST`/remote host mismatch, an
unreadable URL, an invalid identifier or a git resolution error fails the read
and the write closed without running `gh`,
and another remote is never substituted; a config read that fails for any
reason other than "not a git repository" (a corrupt or unreadable
configuration) fails closed too. Before the list loads the scope is revalidated
against the checkout's live git configuration; once loaded, the repository
identity is PINNED for the reader, host included: reads and actions carry it,
and if the checkout's remote moves (even to another server under the same
`owner/name`) the list keeps the loaded repository while the writing actions
refuse with a request to reopen and `o` still opens the issue it was read from.
A `GH_HOST` that no longer selects the pinned server fails bound reads and
actions closed, and an ambient `GH_REPO` never overrides the pin.
An Issues open refreshes a primed snapshot's newest-20-UPDATED margin
(one `--state all --limit 20` call) after mounting, separately from the
interactive page read. It never primes a cold snapshot just to show that
list. Repeated `session_start` reuses the primed snapshot or the prime
already in flight rather than resetting it.

Interactive Issues reads My issues, Assigned, Involved and All independently
through GitHub cursor search. Request size comes from available body rows;
wrapped titles determine how many fetched items are actually shown, and the
next cursor follows the last shown item. Search covers the complete active
bucket rather than filtering only its loaded page, with a short debounce and
query-bound cursors. Loaded tabs/pages are reused until explicit `r` or a
successful write invalidates them. GitHub search above 1000 matches is
reported as a limit requiring a narrower filter, never silently truncated.

The retained three-bucket snapshot helpers serve the noninteractive fallback;
All is not added to their totals. Their count-based completeness proof is not
the interactive pager's loading strategy.
ODD discovery is local and bounded; its paging/search is over the discovered
inventory, and `r` rediscovers it. See [Issues viewer](issues-viewer.md) and
[ODD viewer](odd-viewer.md) for their limits.

Completeness is checked, page by page, and reported instead of assumed. A
page carrying GraphQL errors, a `hasNextPage` without a new non-empty cursor,
a repeated cursor, or a terminal page whose distinct issues do not equal the
reported `totalCount` fails the WHOLE snapshot: nothing is primed and no
margin is produced, so no cached page row is invalidated on evidence that
does not exist, and the reader is never handed an empty or short set in place
of the real one. Nothing is derived from absence — no row is marked closed
because it is missing, and no worktree association is re-verified, because no
worktree holds one any more (S1). A repository-level `Not Found (HTTP 404)` —
a private, renamed or unreadable repository — is reported as unverifiable,
exactly like authentication, permission, transport and timeout failures.

These are the limits of what `gh` output proves, not a promise that a live
call is always conclusive: the loop assumes `totalCount` and `pageInfo`
describe one consistent connection, so an issue opened or closed while it
pages shifts the counts and makes that snapshot fail rather than half-apply.
Each page runs under the runner's bounded timeout (30 s), and a runaway page
counter stops a connection that never terminates.

## Responsiveness (S21)

Every subprocess reached from an interactive path — the create tool (its base
read, its pending-change summary and its copy), close/delete, warp, open/enter
and the warp selector's per-row reads — runs through the async runner and is
awaited, so a slow or hanging child can never freeze repaint or keyboard input.
The base read and the pending-change summary added by S2/S3 are two extra
awaited children, never a synchronous one: the create stays responsive while it
copies, which `tools/worktree-blocking-budget.test.js` measures. The create
PANEL reaches no child at all: its
live preview derives from the pure halves of the shared helpers and its branch
check is the create path's awaited one (S1). What does not
change: the binary, the fixed argv and its element order, the per-call timeout,
the refusal and confirmation text, and the order of side effects.

Two sync children remain by design, and neither can stretch to a timeout
freeze: the memoized `git rev-parse` identity probe (~20 ms, once per
directory — and once per open create panel), and the Herdr reconcile that only
runs when the session closes its OWN checkout after warping out of it.

### The interactive create does not wait for setup

A responsive event loop was not enough on its own: the create still AWAITED a
dependency install and `codegraph init`, so the selector came back minutes
after the human confirmed — the wait was honest but it was still a wait. The
path is all the warp needs, so the interactive create (`backgroundHooks`, the
warp panel's route only) returns once the checkout, its registry row and the
pending copy are settled, and hands install/codegraph to a tracked background
task that reports itself when it settles. The agent tool is deliberately
unchanged: its result is the agent's only report, so `worktree_create` still
awaits its hooks and still returns the settled steps.
`tools/worktree-hooks.test.js` pins the deferred contract (file steps inline,
`pending` rows, one `setup()` that runs once and never rejects), and
`tools/worktree-create-tool.test.js` plus `tools/warp-selector.test.js` pin the
return-before-setup behaviour with a `codegraph` shim that sleeps and drops a
marker — plus the ONE report each settled task produces, that a failed setup
reaches the human as an error without failing the create, and that a run in
which no step completed reports nothing at all instead of a no-op success
toast.

## Registry and identity reads (S22)

The registry lives at `<git-common-dir>/pi-worktrees.json`, and locating it used
to cost two `spawnSync` git probes on EVERY read and write — around 19 ms here,
several times per tool event and per repaint. Two caches remove that:

- the shared git common dir is resolved once per checkout and reused by the
  registry, the warp-session store and the change summary;
- the parsed registry is cached per file identity (inode, size, nanosecond
  mtime), and every write invalidates it, so a cached read can never outlive a
  write — ours or another process's. Callers receive a clone, including the
  non-enumerable drop report a later write needs.

Measured here: `readRegistry` went from 18.8 ms to 0.016 ms per call, which is
what made every tool call and every list/detail/selector read feel heavy.

## Paint cost (S23)

The reading views never re-wrap content that did not change. The issue preview
(the Issues viewer) memoizes its wrapped body
and comments by exact text plus width in a bounded cache, and the ODD list
memoizes its label rows by exact label, width and row
prefix, so moving the cursor costs one wrap of the newly focused row, not the
list. Any content or width change recomputes once; a stale row is unpaintable.

Measured here, per repaint at 80 columns: the issue preview 0.79 ms → 0.02 ms,
a 300-issue detail list 1.60 ms → 0.26 ms, a 500-document ODD list 1.70 ms →
0.20 ms. The ODD document body was already width-keyed before this change, so
it is unchanged on purpose.

## Known limitations

- **Closing normally needs `force: true`.** `git worktree remove`
  refuses a checkout containing untracked files or modifications unless
  `--force`, and the creation hooks deliberately create untracked files
  (env copies, and the `.codegraph/` index when the CLI is present)
  without ever deleting them silently — so a
  normally-created worktree is "dirty" from git's point of view from day
  one whenever those steps land anything. Pass `force: true` (forwarded as `--force` to herdr or git, only
  when asked) to close it. Without `force`, the backend's own refusal is
  the whole error and nothing is mutated: checkout, branch, and registry
  entry are left untouched.
- **The issue check (only when issues are supplied) requires `gh` and a GitHub remote, and fails closed
  otherwise.** Missing binary, unauthenticated `gh`, no GitHub remote,
  timeouts, and unparseable output each report their own cause instead of
  treating the issue as valid; a number `gh` cannot resolve is reported
  as nonexistent. An omitted or empty `issues` field needs no `gh` at all.
  There is deliberately no `status:approved` requirement:
  association plus existence is the whole contract.
- **Linux-scoped, like the rest of the project** (see the README
  prerequisites). There is no separate platform gate in the tools.
- **`.codegraph/` is never shared** and the tools do not index for you:
  creation runs `codegraph init` when the CLI is available and nothing
  more; each worktree builds its own fresh index.
