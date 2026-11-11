# Herdr Gentle Shell

![Herdr Gentle Shell banner](docs/images/banner.png)

Local Herdr plugin so the sidebar recognises Pi + Gentle Shell agents.

## What It Does

Reports per-pane agent state (exactly one user-facing `gentle` — pink
`#f5c2e7`, machine key `orchestrating`: the principal session's own working
status and its generic status; a non-contemplated subagent renders its own
sanitized name on the amber `working` cell `#f9e2af` — never the word
`working`, never `gentle` — and a recognized gentle role keeps its
abbreviation — `explorer`, `worker`,
`verify`, `judge`, `rdd` — with the total running count in parentheses when
two or more subagents run, for example `explorer (3)`). The principal's own
activity marker (`gentle_principal_v1`, published while the principal session
itself works and cleared when it settles) decides the row — never the
delegate count, and never Herdr's aggregate native status (which reads
`working` whenever any delegate runs): the default is still the principal's
own state, so while the principal works its own turn it reads pink `gentle`,
with or without a fresh root marker, and no delegate word wins; while the
principal is idle the oldest running delegate role shows, or that subagent's
own name when no role word is recognized. `gentle` never renders on an idle
session. The single exception is a
blocking synchronous subagent call (`gentle_pending_v1`): a task-mode
`subagent_run`/`subagent_continue` holds the principal's turn open until the
child returns, so the principal is waiting on that child rather than working
and the in-flight child's role renders instead. A queued or running
background delegate publishes no such marker and leaves the principal's
display untouched),
`ask` (three independent event legs — choice, native questionnaire, legacy rpiv — plus
executed `ask_user_question`/`ask_user_choice` tool calls (execution opens, end/result closes;
proposals never block), tool-gated `ui_prompt` dialog spans (a `custom` panel — agents view, ODD
viewer, changes view, design canvas — never counts: opening a panel is navigation, not a
question), and
permission waiting; `gentle_review` starts never speculate ask, amber/orange `?`), `blocked`, `done`, `idle`) plus compact
changes segments folded into the single row-1 heading cell (nonempty ` +N`/` -N`/` ↑N`
with leading spaces, symbols color-distinguished by `contains` rules: ` +` green for added,
` -` red for deleted, ` ↑` blue for pull — added stays green, deleted stays red),
reduced from `gentle_*`
pane-metadata tokens. It coexists with `herdr-pi-tree` through a single-writer handoff: while
this plugin owns a pane, `herdr-pi-tree` stays disabled for that pane, so the
two never share token names or the 16-token budget. Details live in
[DESIGN.md](DESIGN.md).

## What It Looks Like

<p align="center">
  <img src="docs/images/sidebar-example.png" width="420" alt="Agents panel showing gentle states with change counts">
</p>

The Agents panel renders the active role (`worker`), the principal state (`gentle`),
and compact `+N` / `-N` change segments in one row per pane.

## Quick Start

Prerequisites: Linux, Node >= 18, Herdr meeting `min_herdr_version` in
`herdr-plugin/herdr-plugin.toml`, and
`herdr-pi-tree` installed (it stays installed but disabled for gentle-owned
panes).

Two packages install separately: the Herdr plugin (`herdr-plugin/`) and the
Pi package (the repository root, published to npm as `herdr-gentle-shell`
with the `pi-package` keyword). The two
packages version independently and release from two tag series —
`pi-vX.Y.Z` (npm publish) and `herdr-vX.Y.Z` (GitHub Release) — so either
side may lag the other; the Herdr side is not bumped when it carries no
change.

Source repository: `github.com/jonasotoaguilar/herdr-gentle-shell`, the
origin that publishes both packages and creates the releases.

### Install the Herdr plugin (always)

```sh
herdr plugin install jonasotoaguilar/herdr-gentle-shell/herdr-plugin
```

The Herdr side is always installed; the Pi package below is not optional
either, since the sidebar states come from it.

### Install the Pi package

```sh
pi install npm:herdr-gentle-shell
```

Inside a Gentle Shell session, the same package is installed through the shell's launcher:

```sh
gentle-shell install npm:herdr-gentle-shell
```

Both hosts install the same npm package,
`herdr-gentle-shell` — the Pi extension that publishes the
session facts behind the sidebar states — and only the host command differs.

Running Pi sessions still need `/reload` (or a restart) to pick up the
updated extension.

### Apply the sidebar override

```sh
herdr plugin action invoke configure --plugin herdr-gentle-shell
```

The action appends the managed pi-only `[ui.sidebar.agents.rows_by_agent]`
override described below and reloads the server; `herdr server reload-config`
and the daemon start (`node bin/gentle-status.js`) are the same commands run by
hand.

### Local development

Point Herdr at this checkout's plugin subdirectory (from this directory).
`herdr plugin link` only registers the directory; it runs no build.

```sh
herdr plugin link --enabled ./herdr-plugin
herdr plugin action invoke configure --plugin herdr-gentle-shell
```

The repository root is the Pi package (`herdr-gentle-shell`)
and `herdr-plugin/` is the Herdr plugin. Then run `/reload` in Pi to pick up
the local package.

For isolated/local use point Pi at a throwaway agent dir, e.g. from this
checkout `PI_AGENT_DIR=/tmp/pi-agent-test pi install .`.

### Update

The two packages update independently. The Pi package updates with:

```sh
pi update --extensions
```

and the Herdr plugin updates with:

```sh
herdr plugin update herdr-gentle-shell
```

To move the Herdr side to an explicitly older `herdr-vX.Y.Z` release, install
that ref after removing the current one:

```sh
herdr plugin install jonasotoaguilar/herdr-gentle-shell/herdr-plugin --ref herdr-vX.Y.Z
```

If the installed plugin is locally linked, the remote install replaces it
automatically and warns naming the plugin id; to restore a checkout afterwards
re-link it:

```sh
herdr plugin link --enabled ./herdr-plugin
```

### Removal

```sh
herdr plugin action invoke unconfigure --plugin herdr-gentle-shell
pi remove npm:herdr-gentle-shell
herdr plugin uninstall herdr-gentle-shell
```

The `unconfigure` action takes the managed sidebar override out of the Herdr
config and reloads it; the user-owned `[ui.sidebar.agents]` table is left
intact. The settings exclusion is likewise
ownership-checked: only the entry this plugin added is removed, while a
pre-existing identical entry and unrelated settings are preserved. A foreign,
invalid, or misbound ownership record fails closed: removal warns, preserves
the entry, and still removes the plugin.

Path convention used below: `node bin/...` runs from the installed plugin
root, while `herdr-plugin/bin/...` is a repository location in this checkout.
`bin/configure.js` lives in the Herdr plugin and is no longer shipped by the
Pi package: `lib/gentle-sidebar.js` and the extension resolve the installed
Herdr plugin root through `herdr plugin list --json` (override
`GENTLE_HERDR_PLUGIN_ROOT` for isolated runs) and run that install's copy.

The `configure` action runs `node bin/configure.js --apply --reload`: it
appends one marked pi-only `[ui.sidebar.agents.rows_by_agent]` override for
canonical agent `pi` and reloads the server. Direct equivalents:

```sh
node bin/configure.js --check
node bin/configure.js --apply
node bin/configure.js --apply --reload   # apply + `herdr server reload-config`
node bin/configure.js --uninstall --reload
```

### Sidebar override (non-destructive, pi-only)

`bin/configure.js` manages only its marked block and never edits the
user-owned `[ui.sidebar.agents]` table it sits under. The managed override is
exactly two pi-only rows: row 1 is the native Herdr tokens `state_icon`,
`workspace`, `agent` in that order as plain native token strings (no custom
cells, no colors wired here — row-1 glyph and identity coloring, including
the native `state_icon`, is Herdr-native and not plugin-controlled); row 2
wires the eleven presence-encoded `gentle_title_*` state cells (state word
only, one current title per frame, each in its state's semantic color as
base fg with no rules; role words carry a running-count suffix above one)
followed by the three
change-segment tokens (added green `+N`, deleted red `-N`, pull blue `↑N`,
each its own color cell with no rules, never swapped). The review leg
renders the user-facing word `rdd` in blue `#89b4fa` (same as
explorer/pull; internal TaskStore role slug stays `rdd`, machine display key
and token names stay `review` — review execution is silent, never a
notification; only an actual waiting prompt renders `ask` (desktop attention
is Herdr's native `blocked` toast); the judge delegate role renders `judge` in
purple `#cba6f7` (distinct from explorer blue, verify teal, and
orchestrating pink); the error value renders `blocked` as the row word for
the `error` machine key (never the pane's native state — an error is
sidebar-only, DESIGN §7; it rides the durable session-bound
`gentle_error_v1` token, republished on every beat while the run-error leg
stands and cleared the beat it releases, so a beat the sidebar missed is
repaired by the next one); the orchestrating
leg renders the one user-facing `gentle` (machine key stays
`orchestrating`, pink `#f5c2e7`), while the `working` leg (amber `#f9e2af`)
carries a non-contemplated subagent's own sanitized name and never renders
the word `gentle` or `working`. Remaining state colors:
working/worker amber `#f9e2af`, explorer blue `#89b4fa`, verify teal
`#94e2d5`, ask orange `#fab387`, error red `#f38ba8`, done green `#a6e3a1`,
idle grey `#7c7f93`. Added stays green and deleted stays red; the mapping
is never swapped. The custom `$gentle_heading_*` / `$gentle_project` /
`$gentle_agent` cells and `gentle_changes_summary` stay published and owned
for compatibility but are wired into no visible row.
Only one `gentle_title_*` token carries a value per frame (presence
encoding), so row 2 shows the current state word plus any nonempty change
segments while the rest render empty; native separators on row 2 are
acceptable. Row 1 holds 3 native cells and row 2 holds 14 cells (11 state
+ 3 changes), each within Herdr's 16-token per-row ceiling (full block below).
The `gs` label of an isolated Gentle Shell pane needs no key here: `gs` is not
one of Herdr's canonical agents, so `rows_by_agent.gs` is a configuration error
rather than an inert key. Only the daemon's label ladder (DESIGN.md §5.5)
makes that row appear, and `rows_by_agent` stays keyed by the canonical `pi`.

```toml
# BEGIN herdr-gentle-agents (managed; do not edit)
# Sidebar override owned by herdr-gentle-agents: two pi-only rows —
# row 1 native state_icon + workspace + agent, row 2 state word + changes.
# The parent [ui.sidebar.agents] table is user-owned and never touched here.
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "workspace", "agent"], [{ token = "$gentle_title_working", fg = "#f9e2af" }, { token = "$gentle_title_orchestrating", fg = "#f5c2e7" }, { token = "$gentle_title_explorer", fg = "#89b4fa" }, { token = "$gentle_title_worker", fg = "#f9e2af" }, { token = "$gentle_title_verify", fg = "#94e2d5" }, { token = "$gentle_title_judge", fg = "#cba6f7" }, { token = "$gentle_title_ask", fg = "#fab387" }, { token = "$gentle_title_review", fg = "#89b4fa" }, { token = "$gentle_title_error", fg = "#f38ba8" }, { token = "$gentle_title_done", fg = "#a6e3a1" }, { token = "$gentle_title_idle", fg = "#7c7f93" }, { token = "$gentle_changes_added", fg = "#a6e3a1" }, { token = "$gentle_changes_deleted", fg = "#f38ba8" }, { token = "$gentle_changes_pull", fg = "#89b4fa" }]]
# END herdr-gentle-agents
```

The
single row-1 heading cell mirrors the Gentle Shell SessionChanges model semantics
(write/edit tool outcomes, never `git status`, never an approximate
reaggregation): files keyed by `(root, path)` with snapshot-continuity and
unavailable counts (unavailable files stay in the file count with 0/0); `↑N` shows when the pane
branch is behind its upstream (branch-ab status only, no diff). `gentle_project`,
`gentle_changes_summary`, and the segment
tokens (`gentle_changes_added`/`_deleted`/`_pull`) stay published for
compatibility but render no visible row. Pink `gentle` (machine key
`orchestrating`, pink palette unchanged) is the
only user-facing `gentle`: it renders while the principal session actively
works — even with zero subagents, with or without a fresh root marker — and
as its generic status when a running delegate has no resolvable name, when
only unsalvageable role shapes remain, or when the root marker covers a
queued/running sub or a pending launch; it never renders on an idle session.
A non-contemplated subagent renders its own sanitized name on the amber
`working` cell instead, and a recognized gentle role keeps its abbreviation
(`explorer`, `worker`, `verify`, `judge`, `rdd`). The principal's own
activity decides the row, never the delegate count and never Herdr's
aggregate native status (the work token counts running delegates, and the
native status reads `working` for any running delegate or pending launch — so
neither can say the principal works): the dedicated
`gentle_principal_v1` marker is published while the principal session itself
works and cleared when it settles. That is the default: a **working
principal** reads the pink `gentle` — machine key `orchestrating`, fresh root
marker or not — and no delegate role word
wins; an **idle principal** shows the oldest running TaskStore role
(`explorer`, `worker`, `verify`, `judge`, `rdd`), however many delegates run.
The one exception is a blocking synchronous subagent call: while a task-mode
`subagent_run`/`subagent_continue` is in flight the principal's own turn is
blocked on the child, so the producer publishes that child's role in
`gentle_pending_v1` and it renders instead of `gentle`, for as long as the
call lasts. A resume (`subagent_continue`) carries no agent, so its role is
the tracked task record's agent for its `task_id`; when neither the input nor
a record names one, the call publishes no role and the row keeps its generic
display. Background launches resolve their tool call immediately, so a
queued or running background delegate publishes no such marker and leaves
the principal's own display untouched. These yield to `ask`/`rdd`/`blocked`
and terminal `done` — where `done` needs
settled-plus-empty (principal settled with no running delegates and no
pending launches; a settled principal with running delegates keeps the role
word, never `done`). A role word is not a subagent label; it carries the
total running delegate count in parentheses when that count exceeds one. The
work total is a direct projection of the
Gentle Shell TaskStore `running` records (only `running` counts as
executing; queued/waiting never count), never a calculated
pending-call estimate: pending tool calls are role-only display hints (exact
in-flight subagent agent -> role slug, resolved from the tool input or, for a
resume, from the tracked task record, so task-mode launches show the active
role even at count 0) plus label correlation, and
true concurrent tasks all count. A live `running` record is never regressed
by a racy non-final status read (only the authoritative launch outcomes,
completions, and presence terminals move it), so principal activity with
live delegates keeps `gentle` while an idle principal keeps the role word; a
sanitized unknown slug exactly
equal to `working` or `subagent` degrades to the pink `gentle` (neither bare word ever
renders; `subagent` is the producer's launch-correlation placeholder, never
an agent name).
Background launches (`subagent_run` with `mode: background`) announce
lifecycle over `message_end` custom results: an ACTIVE status promotes the
start into the tasks map like a task-mode record, so an active background
worker keeps the pane on live activity and shows the worker role word rather
than settling to `idle`/`done`.
Errors render as user-facing `blocked`.
Other agents are unaffected. `--apply` refuses (exit 2, no write) when an
unmanaged `rows_by_agent` override already exists; remove or rename it, then
re-run. Writes are atomic (temp file plus rename) with a backup at
`<config>.herdr-gentle-agents.bak`. The config path resolves exactly like the installed plugin's
`bin/gentle-status.js` (`HERDR_CONFIG_PATH`, then `XDG_CONFIG_HOME`, then
the platform default).

### Verification

```sh
node --check herdr-plugin/bin/configure.js
node --check herdr-plugin/bin/gentle-status.js
HERDR_CONFIG_PATH=/tmp/herdr-fixture.toml node herdr-plugin/bin/configure.js --apply
HERDR_CONFIG_PATH=/tmp/herdr-fixture.toml node herdr-plugin/bin/configure.js --check
HERDR_CONFIG_PATH=/tmp/herdr-fixture.toml node herdr-plugin/bin/configure.js --uninstall
herdr plugin action invoke configure --plugin herdr-gentle-shell
herdr server reload-config
```

Live check: with the daemon running and the override applied, open a Pi pane
and confirm row 2 shows pink `gentle` (machine key
`orchestrating`) while
the principal session actively works — even with zero subagents, and with or
without a fresh root marker — and keeps `gentle` while its delegates run (a
role word such as `worker`, `explorer`,
`verify`, `judge`, or a non-contemplated subagent's own name in amber, shows
once the principal itself is idle — and also while a
task-mode subagent call blocks the principal's turn, until it returns), that
a row never reads `gentle` on an idle pane; row 1
shows the single heading cell (`● <project>` plus ` +N`/` -N`/` ↑N` inline, zero `·`) after edits / when behind upstream; then `ask` on an open
question (choice / native-questionnaire / legacy event legs, executed `ask_user_question`/`ask_user_choice`, tool-gated `ui_prompt` dialog spans (a `custom` panel — agents view, ODD viewer, changes view, design canvas — never counts, because opening a panel is navigation, not a question), or permission waiting; `gentle_review` starts never speculate ask, and no failed tool ever does either: a tool error changes nothing, see the error rule below). `rdd` (machine key `review`) applies during acknowledged native capture/group execution only (`reviewerRunAcknowledged: true` at execution start — never proposal, never forecast-only, never `correctionLines` planning, never `gentle_review`/`gentle_review_scope` in any operation; no hook/sidebar signal observed; unknown legacy shapes stay dark; call-id tracked so thrown/cancelled calls still clear, read-only `assess` excluded). Bounded approximation: the acknowledged interval contains preparation and admission; no exact reviewer internal events exist today. The orchestrator-host `ask_user_choice` prompt emits no Pi tool/event observable by this extension and stays covered only by the event legs above. Never point the fixture commands at the live config: keep
`HERDR_CONFIG_PATH` on a temp file for apply/uninstall checks.

## Core Workflow

A Pi sidecar extension publishes `gentle_*` tokens per pane; a plugin daemon
reduces the Herdr snapshot to sidebar state on a poll cadence. Same transport
and TTL discipline as `herdr-pi-tree`, new token names, no new socket or
webhook. `[[startup]] node bin/gentle-status.js` (no args) is the polling-daemon
bootstrap (ensures the adaptive poll daemon is running: 10 s baseline,
`GENTLE_STATUS_POLL_MS`-overridable, with a 2 s fast cycle while recent ask
activity, a rendered non-idle display, or send/publish failures are observed);
`[[events]] on = "pane.agent_detected"`, `pane.agent_status_changed`,
`pane.exited`, and
`pane.closed` each run `node bin/gentle-status.js --refresh`, which ensures the
adaptive poll daemon is running and requests one coalesced immediate frame
so a newly opened project name/state renders without waiting for the next
poll tick. Drawing follows the report, not the clock: the daemon also holds one
long-lived `events.subscribe` for `pane.updated`, so a token write Herdr already
repaints for wakes the same single frame loop (bounded reconnect, floored at
250 ms, no second loop, no per-event frame), and the producer requests that same
coalesced refresh after every landed token beat, so a status change
it publishes is drawn at once, and the daemon caps each sleep at the nearest
live `done` expiry, so a settled row reaches `idle` when its short hold (5 s by
default, `GENTLE_HERDR_DONE_HOLD_MS`-overridable) lapses instead of one poll
later. The producer's own beat is 15 s by default and
`GENTLE_HERDR_BEAT_MS`-overridable for tests and debugging (clamped to
[100, 300000]); the override changes the cadence only, never the 60 s token
TTL. Reports in one window collapse into one frame, and refresh-driven frames
are floored at 250 ms, so a burst can never spin the daemon. Polling stays the
fallback for every lifecycle signal and the only source for what no Herdr event
carries (the git-derived `+N/-N` and `↑N` row data and the presence prefix), so a
missed, undelivered, or rejected event never sticks. Read-only
supervision triage ships beside it: the `doctor` and `whois` plugin actions
(`node bin/gentle-doctor.js`, `node bin/gentle-whois.js`) plus the explicit-pane
`node bin/gentle-trace.js <pane-id>` CLI — all read-only, none mutating state.
See [DESIGN.md](DESIGN.md) §4 (producer) and §5 (consumer), and
[docs/diagnostics.md](docs/diagnostics.md) for the triage commands.

## Key Features You Should Know About

- Full v1 state matrix including the root-session `orchestrating` marker
  (pink `●` + the one user-facing word `gentle`, the principal session's
  working and generic status: it shows while the principal actively works —
  even with zero subagents and with or without a fresh root marker — and
  covers queued/running subagents and pending launches; yielding only to
  `ask`/`rdd`/`blocked` and terminal `done` (done needs settled-plus-empty);
  never on an idle session) and the authoritative TaskStore role signal
  (`explorer` / `worker` / `verify` / `judge` / `rdd` from `TaskRecord.agent`,
  oldest running first by immutable first-seen, shown while the principal
  itself is idle — a working principal's own turn keeps `gentle`, asserted by
  the principal-only `gentle_principal_v1` marker rather than by the delegate
  count or Herdr's aggregate native status, with one exception: a blocking
  synchronous `subagent_run`/`subagent_continue` call holds the principal's
  turn open, so the in-flight child's role shows instead (the
  `gentle_pending_v1` role marker) until that call resolves, while a
  background delegate never takes that path; an unknown delegation
  keeps its original sanitized name, 32-char bound — never a generic
  collapse — and renders on the amber `working` cell, which never carries the
  word `gentle`), with a running-count suffix on role labels when two or more
  delegates run, `ask` on blocked user input,
  `rdd` during native review execution (machine key stays `review`; execution
  is silent — desktop attention fires only for a waiting `ask` intent, as
  Herdr's native toast), and
  user-facing `blocked` as the row word for the `error` machine key (an
  error never claims the native `blocked` state — that is the host's
  NeedsAttention toast and sound, so the sidebar carries the error on the
  durable `gentle_error_v1` token while the pane stays quiet on `working`,
  and no phone envelope is sent).
- Single-cell row-1 heading (`<icon> <project>` plus ` +N`/` -N`/` ↑N`
  inline, exactly one nonempty cell so zero `·` separators; white base with
  `contains` rules keeping ` +` green (added), ` -` red (deleted,
  leading-space match), ` ↑` blue (pull)) mirroring the Gentle Shell
  SessionChanges model semantics over Gentle tool outcomes, never `git`
  status and never an approximate reaggregation (root+path continuity and
  unavailable counts); behind-upstream `↑N` from branch-ab status only.
  Session-change tokens are refreshed/cleared from the current Gentle Shell
  session model and never carried across sessions.
- Single-writer coexistence with `herdr-pi-tree`: no shared token names, no
  dual-write, scoped sweep of own tokens on handover.
- An isolated Gentle Shell pane gets a `gs` row in the Agents sidebar, and the
  label never lies. Herdr identifies an agent from the pane's foreground
  process group, whose canonical aliases are `pi` and `gentle-shell` — never
  `gs` — so an isolated pane is detected only when its foreground group exposes
  the gentle-shell process, and otherwise has no row at all. Qualification uses
  that same input first: a pane belongs to the isolated install when a member of
  its foreground process group exposes an argv/`argv0`/cmdline path under
  `$XDG_DATA_HOME/gentle-shell/install` (else
  `~/.local/share/gentle-shell/install`, anchored by `install/installation.json`)
  — a real pane is launched from the user's project directory, so its cwd is
  never the install, and cwd is only the fallback for an unreadable group. When
  Herdr detects the pane, the daemon keeps Herdr's truthful identity and state
  and only reports the presentation-only `--display-agent gs` label; when Herdr
  detects nothing, it reports `pane report-agent --agent gs --state idle` from a
  stable per-session source (`plugin:<plugin-id>:gs`) so the row exists at all.
  That reported label is the last resort and is reversible: a changed foreground
  group (the only thing that can make a new detection appear) releases exactly
  this plugin's authority and re-decides within one beat, and `pane.exited` /
  `pane.closed`, a pane leaving the install, a disabled sidebar, and daemon
  shutdown all release it too. Discovery is one bounded `pane list` read plus
  one `pane.process-info` per pane at start, on an explicit `--refresh`, and on
  roster events — never per frame; writes are deduped, and a failure does
  nothing and logs one line per reason. The gs pane's own live state stays
  unobservable until the isolated install forwards `HERDR_ENV` to its agent (a
  gentle-ai concern, out of scope here).
- Gentle mode is enabled by default: while selected, this extension is the single publisher of native `pane.report_agent` (`working`/`blocked`/`idle`) alongside its metadata beats, with session path-or-id binding, monotonic seq, and a serial latest-wins coalesced queue. Parity contract: `working` carries the specific working role in the message (oldest running role word — known short word, unknown sanitized name, or the pink generic `gentle` with no delegation; never bare generic `working`; machine keys unchanged); terminal `idle` fires only on a truly empty settle (principal settled plus zero running/queued plus zero pending plus zero live background jobs plus no human-wait prompt; settle-with-delegates/pending/jobs stays `working`, emitted once). A settle is reconciled from the host's own live truth (`isIdle()`) whenever nothing is active and no work evidence remains, so a run whose settle never reached the producer still reaches `idle` instead of freezing the pane on native `working`; a quiet producer the host never answers stops beating after a bounded budget instead of republishing a count-0 work token forever, and every work edge re-arms it; the settle-time pending latch is bounded by that settle's finish hold. A reconciled settle is not an observed turn, so it mints no `done` and sends no `task_complete`. Live background jobs (`bash_background` / `monitor`) are read from Gentle Shell's session-scoped `gentle-ai:jobs-sidebar` bus event, so waiting on a CI run or a long command keeps the row on `gentle` and never reaches `done`; `blocked` fires only for an actual human-wait intervention leg with its label (review/RDD execution stays `working`, silent). `blocked` is never derived from an error: native `blocked` is what fires the host's NeedsAttention toast and sound, so a failed run shows our own `error` state — the durable, session-bound `gentle_error_v1` token (republished every beat while the leg stands, cleared when it releases) that the sidebar reduces to the `error` row word — while the pane stays on `working`, and a failed tool call (or a delegate that ended `failed`, or a failed beat transport) changes nothing at all: it is detected and logged, never published, and never reaches the error token. The native status keeps its aggregate meaning — it reads `working` while any delegate runs — while the sidebar row's working-vs-idle decision reads the principal-only `gentle_principal_v1` marker, so an idle principal with a running delegate shows that delegate's own role word or name instead of the principal's `gentle`. Our code never emits `done`/`finished` native states or a Herdr notification (the opt-in Moshi replacement below is a separate, off-by-default channel): the host owns finished text on `done`, `blocked`/unknown presentation, sound, and all desktop attention toasts (ask + finish) — there is no consumer toast path left to dedup. Single publisher by design: the managed native extension file stays on disk and is excluded through an ownership-bound Pi settings entry while Gentle mode is selected. `node bin/gentle-sidebar.js disable` removes only our owned exclusion and managed rows, gates our producer/daemon, and hands the sidebar back to the native publisher (running Pi sessions need `/reload`); never run both publishers on the same pane. Limits (unverified, host-owned): the host `idle`→`done`→`finished` mapping and unknown-state handling are owned by Herdr.
- Sidebar switch (`enable` / `disable` / `status` / `toggle`):
  `node bin/gentle-sidebar.js <verb>` picks between this plugin's sidebar rows
  and the native Herdr sidebar. `status` is read-only; `enable` converges the
  managed Herdr rows and records the owned native-extension exclusion;
  `disable` removes only our owned rows and exclusion, never a user table.
  See [docs/sidebar-control.md](docs/sidebar-control.md).
- In-Pi switches (`/herdr-gentle:customize`): two switches, both local
  state and both reachable from a plain Pi session outside a Herdr pane. With
  no argument the command opens the floating panel in Gentle Shell's own
  layout: one left `CATEGORIES` list (`Herdr Sidebar`, `Moshi notifications`)
  and one right pane headed `<Category> · n/m` with its setting rows, each row
  painting the stored value with `●` and the other with `○`; one line above the
  footer describes the focused setting (`<setting> — <what it changes>`), and
  the footer reads
  `←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close`, while `←/→` or
  `Tab` moves between the category and value panes, `↑/↓` or `j/k` moves the
  cursor, `Enter` applies the focused row and `Esc` closes without a write. The
  legend names only keys: it never advertises `Click`, because every token in
  it is a key the panel answers to, and a narrow card compacts it instead of
  wrapping. Pointer input still works without being advertised — a click on a
  category selects it, a click on a row applies it, and a click outside the
  panes is ignored. Each category owns exactly one switch: `Herdr Sidebar`
  shows the single `Sidebar agent rows` row, and the only Moshi switch is the
  `Notifications` row under `Moshi notifications`. The two are never mixed —
  `Sidebar agent rows` neither reads nor writes `gentle-moshi.json`, so turning
  the agent rows off never turns the notification channel off. Herdr's own
  done/ask attention (the finished and needs-attention pop-ups and their
  sound) is Herdr's native behavior, configured in Herdr itself — its config
  and its settings — and this package deliberately offers no switch for it:
  the optional Moshi channel below is the only notification surface the
  package owns. The plain
  two-step menu stays as the fallback
  when the TUI helpers or `ctx.ui.custom` are unavailable.
  `Sidebar agent rows` drives the Herdr plugin's own `bin/configure.js`
  (`--check` to read, `--apply --reload` / `--uninstall --reload` to change) and
  never edits the Herdr config itself; `Moshi notifications` writes the flag
  below and adds or removes the `-extensions/moshi-hooks.ts` exclusion in Pi's
  `settings.json`, running the `moshi-hook` pairing gate before enabling (a
  refusal writes nothing) and reloading Pi only when that settings entry
  actually changed. `/herdr-gentle:customize status` prints one read-only line
  (`customize status: sidebar=<on|off|unknown> moshi=<on|off>`); an unknown
  argument, Esc, or a cancelled menu writes nothing. A sidebar verdict of
  `unknown` is never a refusal: the panel says the state is unknown and
  choosing `On` still runs the apply step, reporting that step's own error
  when it refuses (the same behavior the menu always had). The run-by-hand
  equivalents are the CLI and the flag file shown below.
- Optional Moshi replacement (off by default): one flag file,
  `<state dir>/gentle-moshi.json` containing `{"enabled":true}` (the state dir
  is `GENTLE_STATUS_STATE_DIR`, else the stored `herdr-gentle-agents` state dir
  under `$XDG_STATE_HOME/herdr` or `~/.local/state/herdr`):

  ```sh
  dir="${GENTLE_STATUS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/herdr-gentle-agents}"
  mkdir -p "$dir" && echo '{"enabled":true}' > "$dir/gentle-moshi.json"
  ```

  `/herdr-gentle:customize` → `Moshi notifications` writes this flag for you,
  and enabling there first
  requires the `moshi-hook` CLI on `PATH` with `moshi-hook status --json`
  reporting `paired: true` (an unpaired host is refused and nothing is
  written).

  With the flag on, this plugin **replaces the
  Moshi-managed Pi hook**: the same Moshi integration (Chat View, Live Activity,
  session row, terminal context, phone-side approvals) keeps working, but
  notifications follow this plugin's policy — one when Pi really needs your
  input (`ask`) and one when Pi really finishes. Nothing per prompt, nothing per
  turn, and nothing at all while the flag is off: every envelope path requires
  the flag at send time, so a context captured for Chat View while the channel
  was on can never authorize a notification after it is turned off. If
  `extensions/moshi-hooks.ts` is installed, add
  `-extensions/moshi-hooks.ts` to the `extensions` list in your Pi
  `settings.json` so the Moshi-managed hook cannot notify in parallel; that edit
  leaves every other settings key and entry untouched. Removal of the flag (or
  `{"enabled":false}`) silences this channel immediately — the flag is re-read
  per event — and restoring the hook entry brings the original notifier back.
  Moshi owns pairing and credentials; this plugin never
  reads or stores a token, an absent daemon or unpaired host is a silent
  no-op, and Pi is never interrupted by a Moshi failure.
- Delegation completion reconciled from Gentle Shell presence files, not chat
  delivery: a delegate resolves only from an explicit terminal status or a
  witnessed absence in a strictly newer verified activity generation of the
  same session, bound to an immutable per-task execution epoch (new launch,
  resume, or inactive-to-active transition — never a progress read or
  heartbeat tick). Ambiguous, stale, or oversize snapshots never clear
  tasks. Known limits: delegates that launch and finish between presence
  publications never appear and still depend on chat delivery, and
  absence-driven completion records `completed` without touching the error
  leg; a delegate that ended `failed` is detected and logged, never published
  as state.
- TTL-bounded tokens: stale panes fall back to native `idle`.
- Herdr session opener (`herdr_session_open`): opens a Herdr panel running a
  Pi session at a path. A linked Git worktree opens as a **worktree panel**
  (reusing the workspace Herdr already has for that checkout); a repository's
  primary checkout, a subdirectory or any generic directory opens as a
  **normal panel**. Panel kind is decided from git, the pane Herdr names is
  verified to belong to its workspace and to sit in the requested path before
  Pi starts, and (unless `notify: false`) the caller is woken when that session
  really finishes. The other worktree tools and the ODD and issues panels live
  in `odd-worktree` now; the sidebar and Moshi switches stayed here and are
  reached through `/herdr-gentle:customize`. See
  [docs/herdr-session-open.md](docs/herdr-session-open.md).

## Documentation

| Your task | Start here |
| --- | --- |
| Protocol, token grammar, reducer, and coexistence rules | [DESIGN.md](DESIGN.md) |
| Compatibility, migration, and rollback | [DESIGN.md](DESIGN.md) §9 |
| Open decisions blocking implementation | [DESIGN.md](DESIGN.md) §10 |
| Supervision triage (read-only doctor/trace/whois) | [docs/diagnostics.md](docs/diagnostics.md) |
| Lifecycle recovery and interruption (polling fallback) | [docs/supervision.md](docs/supervision.md) |
| Sidebar switch (`bin/gentle-sidebar.js`) | [docs/sidebar-control.md](docs/sidebar-control.md) |
| Herdr session opener (`herdr_session_open`) | [docs/herdr-session-open.md](docs/herdr-session-open.md) |
| Performance trace and its report | [docs/performance-trace.md](docs/performance-trace.md) |

## Next Steps

- Ship the Pi producer extension (`extensions/`) and the Herdr consumer daemon
  (`herdr-plugin/bin/` plus `herdr-plugin/lib/`); the daemon ships, the sidebar
  override installs via the `configure` plugin action above.
- Resolve the open decisions in [DESIGN.md](DESIGN.md) §10 before implementing
  against them.
- Live sidebar eyeball with subagents/`ask` remains the final acceptance check
  (see Verification above).

## License

MIT — see [LICENSE](LICENSE).
