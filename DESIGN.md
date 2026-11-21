# herdr-gentle-shell — DESIGN.md (Task 4, as implemented)

Status protocol for the Herdr sidebar: producer (Pi sidecar extension) →
pane-metadata tokens → consumer (plugin daemon) → sidebar state + badges.

Scope note: despite the filename, this file is the normative *protocol*
authority (token grammar, lifecycle, ownership), not an Impeccable visual
DESIGN.md (no design-token frontmatter by design — sidebar colors live as
hardcoded hex in the manifest/docs). Status: implemented; the file is the
normative protocol record. Unresolved product/policy decisions are listed
explicitly in §10 and are not decided here.

## 1. Context

### Consumers

- Herdr sidebar (`[ui.sidebar.agents]` + `[ui.sidebar.spaces]` blocks): shows
  one state label per pane plus an optional session-changes badge.
- The human operator watching Pi + Gentle Shell agents: needs to distinguish
  the principal session's own pink `gentle` (machine key `orchestrating` —
  its working status and its generic status) from a delegate's own word: the
  active TaskStore role abbreviation (`explorer`, `worker`, `verify`,
  `judge`, `rdd`) or, for a non-contemplated subagent, that subagent's
  sanitized name on the amber `working` cell — plus `ask` (blocked on user
  input), `blocked` (the row word for the `error` key), `done`, and `idle` at
  a glance. No visible text ever carries a subagent count, exactly one
  user-facing `gentle` exists (the pink one), the amber `working` cell never
  renders that word, and `gentle` never renders on an idle session.

### Current boundary and interaction

- Transport already exists and is not redesigned: Pi extensions publish
  per-pane key=value tokens via `pane.report_metadata` /
  `workspace.report_metadata` over `HERDR_SOCKET_PATH`, with a CLI fallback
  (`herdr pane report-metadata <pane> --source <src> --token name=value`).
- The consumer polls the Herdr snapshot and reduces pane tokens to sidebar
  state. Drawing is subscription-driven: the daemon also holds ONE long-lived
  socket `events.subscribe` for `pane.updated` (plus the roster kinds), which
  only marks a dirty flag and wakes the existing sleep, so a landed token
  report is drawn without waiting for the poll. Polling stays the fallback and
  remains authoritative for everything no Herdr event can drive (§8). No new
  socket, webhook, broker, or dependency is introduced: this is the existing
  plugin socket, used read-only.
- The existing native producer `herdr-agent-state.ts` (managed-by-herdr, v9,
  source `herdr:pi`) already reports main-agent `working`/`blocked`/`idle` +
  session ref. It is **read-only evidence**: never edited, reinstalled, or
  removed by this plugin.

### Style choice and reason

- Style: **polled token sidecar** (same style as `herdr-pi-tree`): short-TTL
  `name=value` tokens on the pane, reduced by a snapshot poller, with one
  `events.subscribe` wake so the drawing follows the report instead of the
  clock (§8).
- Reason (smallest fitting style): the transport, snapshot source, 16-token
  budget, TTL/expiry convention, and sidebar token-name mapping already exist
  and are deployed. A new push channel (SSE/WebSocket/webhook) or a new RPC
  would add infrastructure without changing the authoritative outcome, which
  remains "what does the sidebar show for this pane right now". The design
  therefore **extends the established boundary** (new `gentle_*` token names,
  same value grammar, same report path) instead of introducing another style.

### Non-goals (tasks 5–8 scope excluded — all shipped since Task 4)

- Task-5+ scope (now shipped: `herdr-plugin/herdr-plugin.toml`, `README.md`,
  the `extensions/` producer, the `herdr-plugin/bin/` + `herdr-plugin/lib/`
  consumer, directory scaffold) was
  excluded from the Task-4 design pass, not from the repo.
- No fork or modification of `herdr-pi-tree`; no edit of
  `~/.pi/agent/extensions/herdr-agent-state.ts`.
- No toast/notification UI design beyond exactly-once ownership rules (§7).
- No deep security, performance, or observability design beyond contract
  properties (trust expectations, limits, failure semantics).

## 2. Existing API evidence

All paths verified read-only by scout `mu8wojpu-1-aia3` (2026-09-19).
Do-not-edit sources are marked.

| # | File | Lines | Observable fact (contract surface) |
|---|------|-------|-------------------------------------|
| E1 | `~/.pi/agent/extensions/herdr-agent-state.ts` (DO NOT EDIT, managed-by-herdr) | v9 header; `HERDR_INTEGRATION_ID=pi`, source `herdr:pi` | Publishes main-agent `working`/`blocked`/`idle` + session ref only; transport `HERDR_SOCKET_PATH` via `pane.report_agent_session` / `pane.report_agent` |
| E2 | `~/.config/herdr/plugins/github/herdr-pi-tree-41b1ee3237d2/lib/state.js` | 356–358 | Token `pi_subagents_work_v1` grammar verbatim `/^([A-Za-z0-9_-]{43}):(0\|[1-9]\d{0,15}):([1-9]\d{0,15})$/` = `<sessionHash>:<count>:<expiry>` |
| E3 | same `lib/state.js` | `sessionHash` def | `sessionHash = sha256(agent_session path).base64url` (43 chars) |
| E4 | same plugin | expiry rule | `expiry <= now + 60000` (60 s TTL horizon) |
| E5 | same plugin | reducer | `delegatedStatus = working` when native in `{idle, done}` and `count > 0` |
| E6 | same plugin | `composeBadge` | Badge = indent + delegated glyph `↳` (U+21B3) + count, e.g. `↳3`, default heading placement |
| E7 | same plugin | token-name encoding | State encoded in token NAMES `state_working` / `state_done` / `state_blocked` / `state_idle_fresh` / `state_idle` / `state_idle_stale` / `state_unknown` + `title_<state>` |
| E8 | same plugin | `MAX_TOKENS_PER_REPORT=16` | Reports chunked to fit 16 tokens per report; transport `pane.report_metadata` / `workspace.report_metadata` via socket IPC with CLI fallback `herdr pane report-metadata <pane> --source <src> --token name=value` |
| E9 | same plugin | attention rule | NO toast from plugin side; Herdr fires native attention on `blocked` |
| E10 | Herdr sidebar config | `[ui.sidebar.agents]` + `[ui.sidebar.spaces]` | Sidebar consumes managed blocks; token-name → label/badge mapping is configuration |
| G1 | `/home/jona/repos/gentle-shell/lib/session-changes.ts` | `SESSION_CHANGE_ENTRY`, `gentle-pi.session-change/v1` | `SessionChanges` model: `files[{path,status,added,deleted}]` + `added`/`deleted` totals |
| G2 | `/home/jona/repos/gentle-shell/lib/session-change-capture.ts` | capture rule | Captured ONLY from explicit `write`\|`edit` tool outcomes; never `git status` |
| G3 | `/home/jona/repos/gentle-shell/lib/agents-protocol.ts` | `TASK_STATUS`, `TaskStore` | `queued`/`running`/`waiting`/`finished` + `TaskStore` `list`/`summary` (`running`, `queued`, `waiting`, `finished`); labels = `TaskRecord.label`/`agent` |
| G4 | `/home/jona/repos/gentle-shell/extensions/ask-user-choice.ts` | `ASK_USER_CHOICE_BLOCKED_EVENT`, `gentle-pi:ask-user-choice:blocked` | Authoritative in-process `ask` signal |
| G5 | `/home/jona/repos/gentle-shell/extensions/gentle-ai.ts` | review tools | Registers `gentle_review` tools; contract `gentle-ai.review-integration/v2` |

## 3. Overlap reconciliation (chosen modes)

Prefixing with `gentle_` is necessary but not sufficient. Each overlap gets
an explicit writer-ownership decision. Rationale follows each choice.

### O1. Pane-token namespace + 16-token budget → SINGLE-WRITER HANDOFF

- **Chosen:** while this plugin is installed and enabled for a pane, it is
  the sole writer of subagent/work/changes tokens for that pane;
  `herdr-pi-tree` must be disabled (`enabled:false`, its current state) for
  the same panes. The consumer never writes `pi_subagents_work_v1`,
  `state_*`, or `title_*` names owned by pi-tree.
- **Budget rule:** the gentle producer keeps its own per-report token count
  ≤ 16 (same chunking discipline as E8) so a single writer can never overflow
  the budget; two concurrent writers could, which is why dual-write is banned.
- **Why not dual-write:** two writers sharing one namespace and one budget
  produce badge collisions (`↳N` vs changes suffix) and silent token eviction
  on chunking. Single-writer makes the budget a local invariant.
- **Fallback:** if foreign `pi_subagents_work_v1` tokens are observed while
  gentle owns the pane, the consumer ignores them (read-only, never deletes
  foreign tokens). If gentle is disabled, it writes nothing and leaves
  pi-tree output untouched.

### O2. Reuse vs replace `pi_subagents_work_v1` → REPLACE (do not reuse count)

- **Chosen:** the gentle producer publishes its own `gentle_work_v1` token;
  the consumer treats it as source of truth and ignores
  `pi_subagents_work_v1` while gentle owns the pane.
- **Why not reuse:** the two counts have different name sources that will
  disagree — `TaskStore.label`/`agent` (G3, authoritative for Gentle
  delegation) vs pi-tree's session-file scan. Reusing the foreign count would
  show names the Gentle orchestrator never assigned. Same value grammar, new
  token name, authoritative local source.

### O3. `blocked` → notification ownership → NATIVE ONLY; CONSUMER NEVER (v0.3.1)

- **Chosen:** producer signals via `herdr:blocked` labels (`ask:`/`review:`/
  `error:`) plus the native `pane.report_agent` state; desktop attention is
  native Herdr exclusively (E9 unchanged): `Blocked` fires the `NeedsAttention`
  toast and background `Working|Blocked → Idle` fires `Finished`, both
  Herdr-owned. Native `blocked` is emitted for an actual human-wait
  intervention only: an error is sidebar-only, so no attention fires for it. The consumer emits `herdr notification` for nothing — its
  former ask toast fired on the poll after the native one for the same
  question, a systematic duplication, so the toast path, its copy, the
  notification ledger and the send machinery were removed in v0.3.1. The ask
  token still drives the sidebar ask display; sounds, suppression, and delay
  stay Herdr's. `review` never notifies (the user is already engaged in the
  review flow; review attention stays native).
- **Why:** `ask` needs an out-of-band nudge (the run cannot proceed without
  the user); `review` does not (the user is mid-ritual). Dedup is Herdr's
  native edge-triggered toast semantics, not a plugin ledger.
  See §7 for ownership semantics.

### O4. Badge slot (`↳` taken) → TWO-ROW PI LAYOUT, NO SLOT SHARING

- **Chosen:** the `↳N` leading-badge slot stays owned by pi-tree and MUST be
  absent under single-writer handoff (O1). Gentle renders exactly two rows
  for the `pi` agent: row 1 is the heading context as exactly one active
  cell — the active `gentle_heading_*` value holds `<icon> <project>` plus
  compact nonempty changes segments (` +N`, ` -N`) in that same
  cell (e.g. `● myproj +110 -22`). Exactly one row-1 cell is nonempty,
  so Herdr inserts zero inter-cell `·` separators. The cell sits on white
  `#ffffff` (SIDEBAR_PROJECT) so the project text stays white; symbol
  `contains` rules recolor the icon (unchanged state mapping) plus ` +`
  green (added), and ` -` red (deleted, leading-space match so hyphens inside
  project names never turn red). `gentle_project`,
  `gentle_changes_summary`, and the change-segment tokens stay published
  and owned for compatibility but are wired into no visible row; row 2 is
  the agent context (the
  dedicated `gentle_agent` identity cell plus the presence-encoded
  `gentle_title_*` state labels — Herdr's native `·` separator renders the
  visible `pi · worker`). The consumer never writes
  `↳`, never parses it, never arithmetically combines segments, and never
  emits the retired combined `~N` badge (no subtraction, no merging).
- **Why:** sharing one glyph slot between "delegated count" and "files
  changed" makes the badge unreadable and couples two independent facts.
  Two fixed rows keep each fact independently observable and match the
  herdr-pi-tree tree shape.

### O5. `done`/`idle` freshness vs pi-tree done-hold + idle grace → TTL WINS; SWEEP OWN TOKENS ONLY

- **Chosen:** every gentle token carries an absolute `expiry <= now + 60000`
  (same 60 s horizon as E4), except `gentle_done_v1`, which carries the unseen
  cap (§4.3). The consumer treats missing or expired gentle
  tokens as `unknown → idle` fallback (never holds `done` past expiry).
  On handover (gentle disabled/uninstalled) the consumer sweeps only token
  names it wrote (`gentle_*`, `herdr:blocked` labels it set); it never deletes
  pi-tree or native tokens.
- **Why:** holding `done` past TTL shows a finished state for a pane that may
  have started new work; expiring to `idle` (native fallback) is the safe
  direction. Scoped sweep prevents orphan `gentle_*` badges without
  destroying a successor writer's state.

## 4. Producer contract (Pi sidecar extension; events → tokens)

Sidecar only: ships beside `herdr-agent-state.ts`, never modifies it.

### 4.1 Identity and trust

- Source id: `gentle:v1` (token `--source` value and `herdr:blocked` origin).
- Session binding: `sessionHash = base64url(sha256(agent_session path))`,
  43 chars `[A-Za-z0-9_-]{43}` (same derivation as E3 so pane correlation
  matches pi-tree conventions without reusing its tokens).
- Trust: producer runs in-process with the Pi agent; it reports only facts
  from Gentle tool outcomes and protocol stores (G1–G5). It never reports
  `git status` diffs (G2) and never invents review state (see §10 U4).

### 4.2 Events → tokens mapping

| Producer event (source) | Tokens written | v1 state contribution |
|---|---|---|
| `agent_start` / `isIdle=false` (main actively working, incl. 0 active subs) | `gentle_work_v1=<hash>:0:<exp>` + `gentle_principal_v1=<hash>:<exp>` (principal-only activity marker) + `gentle_orchestrating_v1=<hash>:<exp>` (root marker while main actively works) + clear `herdr:blocked` labels | the pink `gentle` (machine key `orchestrating`, with or without a fresh root marker) while the principal session actively works, even with zero subagents |
| TaskStore `running` non-empty (G3; queued/waiting never execute) | `gentle_work_v1=<hash>:<count>:<exp>` (total delegates — snapshot-confirmed running records plus distinct in-flight `subagent_run`/`subagent_continue` calls, §4.2 — never a principal-working signal) + `gentle_roles_v1=<csv>` (roles from `TaskRecord.agent`, authoritative, oldest-first) + `gentle_names_v1=<csv>` (compat transport only, never rendered) + `gentle_orchestrating_v1=<hash>:<exp>` (root-only marker, §4.3) | the oldest running role word (known short word or unknown sanitized name) whenever the principal itself is not working; a working principal reads `gentle` instead; role labels show the total when two or more delegates run |
| `ASK_USER_CHOICE_BLOCKED_EVENT` / `gentle-pi:ask-user-choice:blocked` (G4), incl. questionnaire + tool-gated `ui_prompt` dialog spans (`kind` other than `custom` — a panel or overlay such as the agents view, ODD viewer, changes view or design canvas never counts, because opening a panel is navigation, not a question; and a prompt span the agent proves it is not waiting on never counts either — a top-level `tool_execution_start` (never a nested `codemode` call, which starts while a sibling dialog is still awaited) or an assistant `message_end` while the span is open withdraws it until `ui_prompt_end`, because a run genuinely blocked on its own dialog cannot also start new top-level executions or finish assistant messages, while a slash-command option menu such as `/rdd`, the `/warp` list or the `customize` fallback renders through `ctx.ui.select` and keeps the agent working; the host gives no origin signal, so entry stays immediate and only those two signals withdraw, never `tool_execution_update` — live background jobs emit it while a real ask may be open), plus direct Pi in-process `tool_execution_start` opens / `tool_execution_end` / `tool_result` closes for the exact tools `ask_user_question` and `ask_user_choice`, tracked by `toolCallId` in a call-id set (a `tool_call` proposal alone never opens; an abort/error end with no result still closes; overlapping calls correct; cleared on result/end/reset/shutdown; event legs and error > ask > review precedence unchanged; boundary: only what Pi emits as execution events is observable — a host ask UI that never emits one stays covered by the event legs only). `gentle_review` starts (any operation) never enter ask: the former consent-eligible pending signal fired before any outcome/UI and falsely blocked pre-granted sessions | `herdr:blocked` label `ask:<intentId>` + durable `gentle_ask_v1=<hash>:<intentId>:<exp>` on every beat while ask is active (null/clear when inactive — repairs a missed label edge; §4.3) | `ask` (existing machine key, user-facing `ask`, amber/orange, native `?`) |
| Pi in-process `tool_execution_start` opens / `tool_execution_end` / `tool_result` closes (by `toolCallId`; a `tool_call` proposal alone never opens) for the exact tools `gentle_review_capture`, `gentle_review_capture_group` with `reviewerRunAcknowledged: true` in the runtime args; `correctionLines` (native planning, never a reviewer), forecast-only calls, `gentle_review` (any operation), `gentle_review_scope`, and all sidebar/hook signals never enter — unknown legacy shapes stay dark (conservative) | `herdr:blocked` label `review:<reviewId>` | `review` (machine key `review`) — during a capture-group run the single parent capture-group call stays in flight across the whole multi-reviewer span, so that one call alone holds the label. Bounded approximation: the acknowledged capture interval contains preparation and admission; no exact reviewer internal events exist today |
| the agent run itself stops on an error (an assistant message whose `stopReason` is `error` — the same signal Pi derives `turn_end.outcome === "error"` from) | durable `gentle_error_v1=<hash>:run-failed:<exp>` on every beat while the leg stands (null/clear the beat it releases, §4.3) + `herdr:blocked` label `error:run-failed`; no native state is derived from it (the pane stays on its lifecycle state — `working` — while the leg stands, so the host raises no NeedsAttention toast or sound) | `error` (row word `blocked`) — never a native `blocked` |
| a tool call fails, a delegate record ends `failed`, or a beat transport fails | nothing — detection only (a counter and a debug line under `GENTLE_HERDR_DEBUG=1`) | nothing: no label, no native state, no finish hold, no notification |
| `agent_settled` + 0 active subs | `gentle_work_v1=<hash>:0:<exp>`; clear `blocked` labels | `done` — an observed turn only: the settle the beat reconciles from the host's live truth mints no finish (§4.5) |
| `SESSION_CHANGE_ENTRY` `gentle-pi.session-change/v1` tool outcome (G1/G2) | `gentle_changes_v2=<hash>:<files>:<added>:<deleted>:<exp>` (+ legacy `gentle_changes_v1` dual-emit, §4.3) | change segments only (orthogonal to state) |

`waiting`/`finished` TaskStore entries never count as active, and `queued`
never counts as executing for the visible role + total (T2b): only `running`
feeds `gentle_work_v1` and `gentle_roles_v1`. Liveness/marker coverage
retains `running`/`queued`/pending (the root marker still covers a queued
subagent or a pending launch). The count is the UNION of two live sources:
the Gentle Shell TaskStore `running` records carried in
`event.details.gentleAgents`, narrowed on every beat to the ids the read
presence snapshot lists running, and the DISTINCT
`subagent_run`/`subagent_continue` calls still in flight that record set does
not list yet, deduplicated by call id so one delegate is counted once. The
in-flight leg is why a synchronous (task-mode) launch now counts at all: it
creates no TaskStore record until it returns `tool_result`, so the records
alone read two live synchronous delegates as zero, while the union renders
`explorer (2)` for as long as both calls are in flight. It is not a
pending-call estimate: a call is counted exactly while it is in flight and
drops out on `tool_result`, cancellation, and settle, and a cancelled call
keeps blocking the terminal state only through the separate pending-call leg.
Names stay record-only (an in-flight call adds no name), and a record the
upstream store no longer lists contributes no name, no role word
and no count, even when the local map never received its final. When no
snapshot is usable (stale heartbeat, mismatched generation, inconsistent
counts) the local map stands in full, never at zero — a zero fallback would
flip the `done` gate and hide genuinely running work.
Background launches (`subagent_run` with `mode: background`) announce their
lifecycle over `message_end` custom results instead of `tool_result`
details: an ACTIVE status (running|queued) there promotes the background
start into the tasks map exactly like a task-mode record (settle-safe,
oldest-first, cleared by its FINAL), so a background delegate keeps the pane
on the delegate's role word instead of settling to `idle`/`done`.
The visible activity state
is the bounded `gentle_roles_v1` CSV derived from `TaskRecord.agent`
(oldest-first by immutable firstSeen): exact `gentle-ai-explore` (actual
package agent name, verified in the project registry alongside
`gentle-ai-worker` / `gentle-ai-verify` / review agents; the legacy
`gentle-ai-explorer` alias is preserved for compatibility) → `explorer`,
exact `gentle-ai-worker` → `worker`, exact `gentle-ai-verify` → `verify`,
`jd-judge-a` / `jd-judge-b` / `jd-fix-agent` (plus the `jd-judge-` /
`jd-fix-` families) → the distinct `judge` slug (never `rdd`), and a
review agent / `gentle-ai-review*` / any role containing `review` → `rdd`;
any other agent keeps its original sanitized name (lowercase `[a-z0-9_-]`
slug, 32-char bound — never a generic collapse; unsalvageable shapes and the
reserved slugs `gentle`, `working`, and `subagent` read
the pink generic `gentle`, machine key `orchestrating`).
The consumer displays the oldest role word (known short word or unknown
sanitized name) whenever the principal itself is not working, regardless of
how many delegates run; a working principal renders the pink `gentle` instead.
Role labels carry that total count in parentheses when greater
than one — the §4.2 union, so two in-flight synchronous delegates of one role
render `explorer (2)` while the roles CSV still names `explorer` once. Role
order is immutable first-seen (progress reads never reorder;
sound same-session presence createdAt/startedAt may correct a late local
first-sighting, otherwise the local firstSeen stands); the in-flight launches
sort after the running records, both oldest-first, so the oldest-role choice
is unchanged.
Pending subagent tool calls are label correlation state for a later
`gentleAgents.taskId` result and a role-only display hint while the call is
in flight; the marker itself carries no count. WHY the hint stays role-only:
task-mode `subagent_run` stays in
flight with no TaskStore record until it returns `tool_result`, so the exact
agent name in the pending `tool_call` input is the only live role evidence;
publishing its role slug as a bounded-CSV hint keeps the
sidebar on the active role (`worker`, never the amber `working` cell —
generic activity reads the pink `gentle`), while the total itself comes from
the §4.2 union (one entry per in-flight call id), never from the hint. The
hint merges with authoritative active TaskStore roles
(oldest-first) and clears when the tool result arrives, the call is
cancelled, or the agent settles. On a tool
result the producer reads the pending record before deleting it and uses it
only to preserve the task label on the authoritative task record; no task
record is created when `details.gentleAgents` is missing. A live `running`
record is never regressed by a racy non-final read: status observations via
any tool other than the authoritative `subagent_run`/`subagent_continue`
launch outcomes keep `running` (and its agent) against `queued`/`waiting`/
`unknown`, while FINAL statuses still apply as completion truth and
re-resolve oldest-first — so a working principal with live delegates keeps
`gentle`, and a settle with running delegates keeps the oldest role word
instead of settling to `idle`/`done`. A sanitized unknown slug exactly equal to
`working` degrades to no role (the pink generic `gentle`) on both the producer
(`agentToRole`) and the consumer (`roleToDisplay`) sides. No local
age/staleness timeout is applied — Gentle Shell owns lifecycle/status truth.
Finished/failed/cancelled records may linger in the map but never count;
old records are dropped only on session reset (plus the bounded-map guard).
The root session emits `gentle_orchestrating_v1` while the main session is
actively working (`agentActive`, even with zero subagents), retaining
coverage while the authoritative active list is non-empty or any
`subagent_run`/`subagent_continue` launch is pending, and clears it (null)
once the main session settles — settled, or any non-root session. The marker carries no
count and changes neither the work total nor the roles CSV: it is a pure
freshness-bound presence flag (`<hash>:<exp>`, same binding/TTL style as
gentle_work_v1) that the consumer reduces to the same pink `gentle` the
principal's own activity renders, only with no role word above it (§5.2):
below attention (error/ask/review), terminal `done`/native-`blocked`, and
role words; ahead of the positive-count generic fallback only, which renders
that same pink `gentle`.
The root session also emits `gentle_principal_v1` while its own agent is
active (`agentActive`) and clears it (null) the moment the principal
settles, keeping the same binding/TTL discipline. This is the principal-only
signal: it carries exactly the principal input of `computeNativeState`, never
the delegate aggregate, because the native status answers `working` for a
running delegate or a pending launch — neither of which says the
principal itself works. The native status keeps that aggregate meaning for
Herdr's own pane state; the row's working-vs-idle decision reads only
`gentle_principal_v1` (§5.2). It carries no count and alters neither the work
total nor the roles CSV. `agentActive` alone would render that blocked call
as the pink generic `gentle`.
The root session additionally emits `gentle_pending_v1` (`<hash>:<role>:<exp>`)
while a synchronous (task mode) `subagent_run`/`subagent_continue` tool call
is still in flight: such a call blocks the principal's own turn, so the
session is executing a tool call and waiting on the child rather than doing
its own model work. The value is the role word of the OLDEST in-flight
recognized launch (`agentToRole` of the pending record), republished on every
beat so a long child run stays covered by the ordinary beat, and cleared to
null the beat the call resolves, the agent settles, or the session resets.
It carries no count and alters neither the work total nor the roles CSV. A
background launch resolves its tool call immediately, so a queued or running
background delegate never publishes this marker and never changes the
principal's own display (S3).

### 4.3 Token formats (ABNF-ish, strict)

```text
sessionHash = 43*[A-Za-z0-9_-]   ; base64url(sha256(agent_session path))
expiry      = 1*15DIGIT           ; unix-ms, MUST satisfy expiry <= now+60000 at write
count       = "0" / [1-9] 0*15DIGIT
gentle_work_v1    = sessionHash ":" count ":" expiry
                    ; count = the §4.2 union: snapshot-confirmed running
                    ; records plus distinct in-flight launches, deduped
gentle_changes_v1 = sessionHash ":" count ":" count ":" expiry
                    ; <hash>:<files>:<added+deleted>:<expiry> — LEGACY, see below
gentle_changes_v2 = sessionHash ":" count ":" count ":" count ":" expiry
                    ; <hash>:<files>:<added>:<deleted>:<expiry>
                    ; normative: exact added/deleted totals kept separate so
                    ; the sidebar renders +N/-N without a guessed split
gentle_names_v1   = label *("," label)   ; label = TaskRecord.label/agent, 1*64 chars
                    ; total <= 512 UTF-8 bytes (see §4.5)
                    ; compat transport only — never rendered
role            = "explorer" / "worker" / "verify" / "judge" / "rdd" / passthrough
                    ; known TaskRecord.agent derivations, oldest-first
                    ; (`review` accepted as a legacy alias of `rdd`; `judge`
                    ; stays distinct, never `rdd`)
                    ; passthrough = 1*32 lowercase [a-z0-9_-], leading [a-z0-9]
                    ; (unknown delegation keeps its sanitized original name —
                    ; never a generic collapse; producer truncates to 32;
                    ; the reserved words `gentle`, `working`, and `subagent`
                    ; resolve to no role on both sides — producer and reducer —
                    ; so they degrade to the pink generic `gentle`)
gentle_roles_v1   = role *("," role)       ; total <= 512 UTF-8 bytes; null (clear)
                    ; when no delegation is active (no role words)
gentle_orchestrating_v1 = sessionHash ":" expiry
                    ; root-only presence marker, no count — fresh while the
                    ; root main session actively works (even with zero subs),
                    ; retaining running/queued-sub, pending-launch, or live
                    ; background-job coverage; null (clear) once the main
                    ; session settles
gentle_principal_v1   = sessionHash ":" expiry
                    ; principal-only activity marker, no count — fresh while
                    ; the principal session's own agent is active
                    ; (agentActive: the principal input of computeNativeState,
                    ; never its delegate aggregate), null (clear) once the
                    ; principal settles; decides working vs idle in §5.2
                    ; while the native status keeps its aggregate meaning
                    ; (running delegate / pending launch = working)
                    ; caveat: a synchronous launch keeps it fresh for the
                    ; whole blocked call — gentle_pending_v1 below carries the
                    ; child's role for that window
gentle_pending_v1     = sessionHash ":" role ":" expiry
                    ; blocking-delegate marker — fresh while a synchronous
                    ; (task mode) subagent_run/subagent_continue tool call is
                    ; in flight, carrying the role word of the OLDEST
                    ; in-flight recognized launch; republished on every beat
                    ; (same TTL discipline as gentle_work_v1) and null (clear)
                    ; the beat the call resolves, the agent settles, or the
                    ; session resets. Renders at role precedence in §5.2:
                    ; below attention and terminal done, above the principal
                    ; marker — the principal's turn is blocked on that child.
                    ; Background launches resolve immediately and never
                    ; publish it, so they never change the principal's row.
gentle_done_v1        = sessionHash ":" expiry
                    ; synthesized finish signal, no count — minted ONCE at the
                    ; settled-and-empty edge (principal settled, zero
                    ; running/queued delegates, zero pending launches, zero
                    ; live background jobs, no ask/review/error leg), then
                    ; republished with the SAME expiry (never refreshed) until
                    ; it lapses; null (clear) whenever work reappears or the
                    ; session resets. Its expiry IS the unseen cap: default
                    ; 900000 ms (15 min, S8), overridden by
                    ; GENTLE_DONE_UNSEEN_CAP_MS clamped to [100, 3600000], so a
                    ; finish nobody looks at recedes at the cap. The consumer
                    ; accepts no expiry beyond now+3600000 at read (the only
                    ; token whose ceiling is not the 60 s TTL). A VIEWED finish
                    ; recedes far sooner: the daemon starts one 3 s dwell
                    ; (DONE_VIEW_DWELL_MS) at the first frame that observes the
                    ; pane focused and then renders `idle` (§5.2). That ledger
                    ; of views is keyed by the token's absolute expiry and is
                    ; daemon memory only: a cleared token (reactivation,
                    ; session reset) drops its view and a new mint starts a new
                    ; episode, while a restart during a still-fresh token can
                    ; show `done` once more for one dwell and never mints a
                    ; second finish. The daemon also caps its next sleep at
                    ; that expiry and at the
                    ; pending dwell deadline (§8). The settle-edge hold that
                    ; withholds the mint while an in-flight launch may still
                    ; report back is a DIFFERENT bound:
                    ; GENTLE_HERDR_DONE_HOLD_MS, default 5 s, clamped
                    ; [1000, 300000]. A session that never worked never mints
                    ; one.
gentle_ask_v1         = sessionHash ":" intentId ":" expiry
                    ; durable ask signal, session-bound + TTL-fresh like
                    ; gentle_orchestrating_v1 — emitted on every beat while
                    ; ask is active, null (clear) when inactive; repairs a
                    ; missed edge-triggered herdr:blocked ask label
gentle_review_v1      = sessionHash ":" reviewId ":" expiry
                    ; durable review signal, session-bound + TTL-fresh —
                    ; emitted on every beat while acknowledged capture/group
                    ; execution is in flight, null (clear) otherwise; silent
                    ; working natively, never a notification (full def:
                    ; extensions/gentle-herdr-state.ts, herdr-plugin/lib/gentle-tokens.js)
gentle_error_v1       = sessionHash ":" code ":" expiry
                    ; durable run-error signal, session-bound + TTL-fresh —
                    ; emitted on every beat while the run-error leg stands
                    ; (the agent run itself stopped on an error), null
                    ; (clear) the beat it releases; the sidebar's ONLY error
                    ; carrier (the native report never claims `blocked`, so
                    ; no toast, no sound, no phone envelope). Tool-level
                    ; failures never reach it (they are telemetry only).
                    ; Consumer: fresh token => `error` display (row word
                    ; `blocked`, silent) with the same
                    ; error > ask > review priority as the label leg.
herdr:blocked     = "ask:" intentId / "review:" reviewId / "error:" code
```

Versioning rule: v2 is a new token name, not a grammar change to v1 (§9).
The producer dual-emits v1 (combined delta, for rollback consumers) and v2
(exact split, normative). The consumer reduces ONLY v2 for display: a
v1-only pane renders no change segments (fail-closed — the split cannot be
recovered from the sum). The retired combined `~N` badge is never emitted;
the sweeper clears the legacy `gentle_badge` name where a previous install
left it.

Validation: consumers MUST reject tokens failing the grammar (wrong hash
length, `expiry` in the past or `> now+60000` at read, non-numeric counts)
and treat the pane as `unknown → idle` for that signal (§7). `gentle_done_v1`
is the one ceiling exception: it is validated against `now+3600000` so an
overridden unseen cap stays readable, and it still fails closed on a past
expiry.

### 4.4 Examples

```text
pane.report_metadata --source gentle:v1 --token gentle_work_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:2:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_roles_v1=worker,explorer
pane.report_metadata --source gentle:v1 --token gentle_orchestrating_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_principal_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_pending_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:worker:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_names_v1=planner,code-writer
pane.report_metadata --source gentle:v1 --token gentle_changes_v2=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:5:110:22:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_error_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:run-failed:1789000000000
herdr:blocked labels: ["ask:q-7f3a"] | ["review:r-42"] | ["error:run-failed"]
```

Example reads: worker oldest + explorer active with count 2 → sidebar
`worker (2)` while the principal is idle (the oldest role word and total)
and `gentle` while it works (the principal's own activity marker wins); three
explorers with count 3 → `explorer (3)`; 5 files
/ +110/−22 session delta → the single row-1 heading cell
`● myproj +110 -22` (` +` green for added, ` -` red for deleted with a
leading-space match, zero `·` separators because exactly one heading cell
is nonempty).
A review label renders `rdd` with a blue `●` (`#89b4fa`, same as explorer). A
`gentle_orchestrating_v1` marker renders the pink `gentle` (machine display
key `orchestrating`, pink palette unchanged): it covers the principal's
queued/running subs and pending launches, and it yields to a delegate role
word and to attention (`ask`/`review`/`blocked`) and terminal `done` states.
The marker is not a principal-working signal: it stays live while the
principal is idle with queued or running delegates, so it never decides the
working state. That state comes from `gentle_principal_v1` alone, and it is
the same pink `gentle` with or without a fresh root marker: the amber
`working` cell is never the principal's own. With no fresh principal marker
the pane shows the oldest role word, the pink generic `gentle` when a running
delegate has no resolvable name, or `idle` — but never an amber generic
because delegates run.

### 4.5 Publication and chunking

- Same transport as E8: socket IPC `pane.report_metadata` /
  `workspace.report_metadata`, CLI fallback
  `herdr pane report-metadata <pane> --source gentle:v1 --token name=value`.
- One report carries at most 16 tokens; `gentle_names_v1` never chunks:
  excess advisory names are dropped whole at 512 UTF-8 bytes total
  (fail-closed).
  The `#p=<i>/<m>` suffix form is retired and never emitted; a consumer
  must not expect reassembly.
- Token values are bounded in UTF-8 BYTES, never in JS characters: Herdr
  rejects the WHOLE `pane.report_metadata` beat when a single value exceeds
  512 bytes, so nothing in that report lands and the pane falls back to its
  60 s TTL. A character count is not a substitute — eight 64-character
  Japanese labels stay inside every character cap and are ~1.3 KB on the
  wire. Every published value (work, names, roles, changes, markers,
  ask, review) is measured with `Buffer.byteLength(value, 'utf8')`, and the
  publisher clamps any value that ever escapes its builder on a character
  boundary (never splitting a surrogate pair) so one token can never take
  its siblings down with it.
- Writes are idempotent full-state snapshots per pane (all gentle tokens
  re-emitted each beat), never deltas — a lost report is repaired by the next
  beat.
- The producer beats every 15 s by default; `GENTLE_HERDR_BEAT_MS` overrides
  the cadence for tests and debugging (clamped to [100, 300000]). The
  override changes no TTL: the write horizon stays `now+60000` (§8).
- Every beat first reconciles the settle from the host's own live truth: with
  no turn active and no work evidence (no running/queued delegate, no pending
  launch, no live background job), the retained context's `isIdle()` flips
  `settled`, so a run whose `agent_settled` never reached the producer still
  reaches native `idle` instead of republishing a fresh count-0 work token
  forever. A turn this producer saw start is never overridden from there.
  When the host offers no truth at all, a producer that observed no turn stops
  beating after a bounded budget (three beats) instead of publishing a native
  state the host never confirmed; a turn this producer saw start is never
  bounded, so the budget cannot trade a truthful `working` for a false `idle`
  on a host with no truth to settle on. The beat is re-armed by the edges that
  schedule a publish (ask, review, launch, session changes, jobs), while an
  ordinary tool edge reaches the row through the host's own truth rather than
  by re-arming it. A settle recovered this way is not an observed turn, so it
  mints no `gentle_done_v1` and sends no finish notification.
- The settle-time pending latch (`pendingCount`) is bounded by that settle's
  finish hold (`GENTLE_HERDR_DONE_HOLD_MS`, default 5 s, clamped
  [1000, 300000]) — the settle-edge bound, not the finish token's unseen cap:
  past that hold a launch that never reports
  back stops counting, so it cannot pin the native report at `working`.
- Session-change tokens are refreshed/cleared from the current Gentle Shell
  session model every beat and never carried across sessions: zero changed
  files publishes a clear (null over socket metadata, `--clear-token <name>`
  on the CLI fallback) for `gentle_changes_v1` and `gentle_changes_v2`, so a
  new/reloaded session under a different session hash cannot retain the prior
  session's change token. `gentle_names_v1` clears the same way when the
  authoritative active TaskStore list has no labels, and `gentle_roles_v1`
  clears (null) when no delegation is active. `gentle_pending_v1` clears
  (null) on the first beat after the blocking call resolves, the agent
  settles, or the session resets — the same full-state discipline, never a
  lingering edge. The retired disclosure token is
  cleared to remove any stale metadata. v2 stays the visible
  normative source; v1 remains legacy only.

## 5. Consumer contract (daemon; snapshot → sidebar)

### 5.1 Snapshot inputs (read-only)

Per pane: native `working`/`blocked`/`idle` + session ref (E1), `herdr:blocked`
labels (§4.2), `gentle_ask_v1` (durable ask signal + freshness gate for `ask` — repairs a missed `ask:` label edge, §4.3), `gentle_work_v1` (running total + freshness
gate — the total counts running delegates, not the principal; role labels
carry it as a suffix only when above one), `gentle_orchestrating_v1` (root-only presence marker
+ freshness gate for the `orchestrating` display — never rendered as a
count), `gentle_principal_v1` (principal-only activity marker + freshness
gate for the working-vs-idle decision — never rendered as a count),
`gentle_pending_v1` (blocking-delegate role marker + freshness gate for the
in-flight synchronous launch — renders the child's role word while the
principal's own turn is blocked on it),
`gentle_done_v1` (synthesized finish signal + its own unseen-cap freshness
gate for the reachable `done` display, receded by the daemon after the viewed
dwell — the host never reports `done`, §4.3),
`gentle_error_v1` (durable run-error signal + freshness gate for the `error`
display — repairs a missed `error:` label edge, §4.3),
`gentle_roles_v1` (authoritative activity roles,
oldest-first by immutable firstSeen), `gentle_names_v1` (compat transport only — never
rendered), `gentle_changes_v2` (normative; a
v1-only pane renders no change segments, §4.3).
Foreign `pi_subagents_work_v1` / `state_*` / `title_*` are observed only to
ignore them under O1 (never parsed for state, never deleted).

### 5.2 Reducer (priority order, first match wins)

```text
error         := fresh `gentle_error_v1` (durable per-beat token, §4.3)
                 OR herdr:blocked has error:* (fresh, §5.4) — one shared
                 priority: error > ask > review
ask           := fresh `gentle_ask_v1` (durable per-beat token, §4.3)
                 OR herdr:blocked has ask:* (fresh)
review        := herdr:blocked has review:* (fresh)
blockingRole  := fresh gentle_pending_v1 (session-bound, TTL-fresh) whose
                 role word is recognized — a synchronous subagent call is in
                 flight, so the principal's turn is blocked on that child;
                 renders exactly like the role branch below (display +
                 label via the role helpers, count suffix unchanged) and
                 outranks the principal marker, which stays fresh for the
                 whole blocked call. Stale, foreign, malformed, or
                 unrecognized evidence falls through. Background launches
                 resolve their tool call immediately, so a running background
                 delegate never reaches this branch.
principalWorking := fresh gentle_principal_v1 (session-bound, TTL-fresh) —
                 the principal's OWN activity, never the delegate count and
                 never the aggregate native status (which reads working for
                 any running delegate or pending launch); renders the pink
                 `gentle` (machine key `orchestrating`) with or without a
                 fresh gentle_orchestrating_v1; outranks every delegate role
                 word; stale, foreign, or absent falls through to the
                 branches below
role          := gentle_work_v1 fresh AND gentle_roles_v1 yields a
                 recognized role (oldest first, incl. the in-flight pending
                 role hint at count = 0 for task-mode launches with no
                 TaskStore record yet) — the principal is not working, so the
                 delegate word wins. A non-contemplated subagent renders on
                 the `working` display, whose label is that subagent's own
                 sanitized name (never `gentle`). Role and name labels append
                 the total when at least two delegates run. Tool-only review
                 has no suffix.
orchestrating := gentle_orchestrating_v1 fresh with no role word above
                 (root-only per §4.2: fresh while the main session actively
                 works, even with zero subagents, retaining running/queued-sub,
                 pending-launch, or live background-job coverage; absent/stale
                 falls through to the
                 branches below; attention, terminal `done`/native-`blocked`,
                 a working principal, and role words stay higher)
generic       := gentle_work_v1 fresh AND count > 0 with no role word —
                 renders the pink `gentle` (machine key `orchestrating`), the
                 principal session's generic status; a count = 0 beat asserts
                 no activity — it reaches `done` only through the terminal
                 gate, otherwise `idle`
done          := (native done OR fresh gentle_done_v1) AND gentle_work_v1
                 fresh with count = 0 (no running delegates) AND no roles AND
                 no fresh gentle_orchestrating_v1 AND no fresh
                 gentle_principal_v1 — count 0 alone never implies empty,
                 since the running-only count excludes queued subs the fresh
                 marker still covers; a fresh marker, any roles, or a working
                 principal veto terminal (queued cover, pending-launch hint).
                 The producer's finish token is the reachable path (the host
                 never emits done); the daemon holds `done` until it first
                 views the pane focused (one DONE_VIEW_DWELL_MS dwell) or the
                 unseen cap lapses, so `done` recedes to `idle` then and is
                 never skipped in between
idle          := otherwise (native fallback; also all-gentle-tokens-missing-or-expired)
```

Priority: `error > ask > review > done > blockingRole > principal working > role > orchestrating > generic > idle`.
`done` is matched before the principal/role branches in the reducer; it is
listed here below the activity branches only so its settled-and-empty
precondition reads together.
`blocked` labels are namespaced, so simultaneous
`ask:` + `review:` resolves deterministically to `ask`. Attention states
(error/ask/review) and the terminal `done` state always outrank principal
status and activity roles. Below them the principal's own activity decides,
never the delegate count and never the aggregate native status: a **working
principal** renders the pink `gentle` (machine key `orchestrating`, fresh
root marker or not) and outranks every delegate role word; an **idle
principal** shows the oldest running role word
(`explorer`, `worker`, `verify`, `judge`, or `rdd` when it is the oldest)
however many delegates run, and falls back to that same pink `gentle` when a
running delegate has no resolvable name (that row is not idle: a delegate
runs). A live count-0 work token asserts no activity: it reaches `done` only
through the terminal gate above, otherwise `idle`, so `gentle` never renders
on an idle session. The one exception sits between them and is
evidence-based, never a precedence guess: while a **synchronous**
`subagent_run`/`subagent_continue` call is in flight the principal's own turn
is blocked on the child, so the fresh `gentle_pending_v1` role word decides
the row (below attention and the terminal `done`, above the principal
marker). Background launches resolve their tool call immediately, so a queued
or running background delegate never changes the principal's own display. The fresh marker is not a principal-working
signal (it stays live while the principal is idle with queued or running
delegates), so it never outranks a role word. An in-flight attention `review`
(fresh `review:` label or durable `gentle_review_v1` token) overrides the
role list; a settled session renders `done` even against a stale-fresh
marker, and only after the pane has been viewed for one dwell, or its unseen
cap has lapsed, does it recede to `idle` (§4.3).

### 5.3 Publication (sidebar tokens)

- The consumer publishes its reduced state under `gentle_`-prefixed token
  names only (never bare `state_*`/`title_*`). The visible first row is
  native and carries no plugin wiring: `state_icon`, `workspace`, `agent`
  in that order as plain native token strings. Row-1 glyph and identity
  coloring, including the native `state_icon`, is Herdr-native and not
  plugin-controlled, so no plugin icon/color claim is made for row 1. The
  custom `$gentle_heading_*` / `$gentle_project` / `$gentle_agent` cells
  stay published and owned for compatibility but are wired into no visible
  row. Deleted lines stay red and added lines stay green (never swapped).
  The visible second row is structural, with no rules: the eleven
  presence-encoded
  `gentle_title_<working|orchestrating|explorer|worker|verify|judge|ask|review|error|done|idle>`
  state tokens (a state word only: `gentle` (pink, machine key
  `orchestrating`) / `explorer` / `worker` /
  `verify` / `judge` / `ask` / `blocked` / `done` / `idle` / `review` — with
  the one exception that the amber `working` cell carries a
  non-contemplated subagent's own sanitized name, never the word `working`
  and never `gentle`; role and name words carry a running-count suffix above
  one).
  Only the current display's title token carries a value; the rest are null.
  Each state cell carries its state's semantic color as its base fg with
  no rules — working/worker golden `#f9e2af`, orchestrating pink fuchsia
  `#f5c2e7`, explorer blue `#89b4fa`, verify teal `#94e2d5`, judge purple
  `#cba6f7` (distinct from explorer blue, verify teal, orchestrating pink),
  ask orange `#fab387`, blocked red `#f38ba8`, done green `#a6e3a1`,
  idle grey `#7c7f93` (recedes), review blue `#89b4fa` (same as
  explorer; internal TaskStore role slug stays `rdd`, machine display
  key stays `review`). Native separators on row 2 are acceptable. The
  `gentle_state_*` / `gentle_agent_*` / `gentle_icon_*` /
  `gentle_row_*` combined names stay published for compatibility but are
  not wired into any visible row. Sidebar config maps the native row-1
  tokens plus the row-2 title and change-segment tokens to
  the pi-only `rows_by_agent` override (E10); exact block wiring is
  install configuration, not protocol.
- Label shapes: exactly one `gentle` — pink `#f5c2e7`, machine key
  `orchestrating`: the principal session's own working status (asserted by a
  fresh `gentle_principal_v1`, with or without a fresh root marker and with
  or without delegated roles) and its generic status (a positive running
  count with no resolvable name, only unsalvageable role shapes, or a fresh
  root-session marker covering queued/running subs and pending launches);
  never rendered on an idle session | the amber `working` cell (`#f9e2af`)
  carries a non-contemplated subagent's own sanitized name from
  `gentle_roles_v1` / `gentle_pending_v1` — never the word `working` and
  never `gentle`, so a bare `working` display fails closed to the pink
  `gentle` | `explorer` / `worker` / `verify` / `judge` (oldest
  TaskStore role word while the principal itself is idle, however many
  delegates run) | `ask` | `rdd` (user-facing word for the `review`
  machine key; a delegated rdd and a tool-only review both render `rdd` —
  review execution is silent, never a notification; only
  a waiting `ask` intent notifies once) | `blocked` (user-facing row word for the `error`
  machine key; carried by the durable `gentle_error_v1` token or the `error:`
  label, and the pane's native state never claims `blocked` for it) | `done` (settled-plus-empty only: principal settled with no
  running delegates and no pending launches; a settled principal with
  running delegates keeps the role word) | `idle`. Role labels append the
  total count when at least two delegates run.
- Row-2 changes: the nonempty `+N`/`-N` segments ride as their own
  structural row-2 cells after the eleven title cells (each its own color
  cell with no rules — added green, deleted red, never
  swapped; empty segments collapse so nothing renders). `+N`/`-N` come
  from fresh `gentle_changes_v2`
  (exact SessionChanges evidence totals, never git status). The row carries
  no ahead/behind marker relative to the branch: only the exact added and
  deleted line counts.
- Each `+N`/`-N` segment renders only when its total is > 0; each
  rides its own structural row-2 cell (added green, deleted red,
  no rules, never swapped; empty segments collapse). `gentle_project`,
  `gentle_heading_*`, `gentle_agent` (both the single and per-display
  forms), and `gentle_changes_summary` stay published for compatibility
  but render no visible row. The retired
  combined `~N`
  badge is never emitted (see the §4.3 versioning rule).
- Placement: exactly two pi-only rows — row 1 the native `state_icon` +
  `workspace` + `agent` strings (3 cells, no custom wiring, no plugin
  colors), row 2 the eleven `gentle_title_*` state cells plus the two
  change-segment cells (13 cells: 11 state + 2 changes), each row within
  Herdr's 16-token per-row ceiling — with the
  herdr-pi-tree palette (added green `#a6e3a1`,
  removed red `#f38ba8`, working golden `#f9e2af`, ask
  orange `#fab387`, orchestrating pink fuchsia `#f5c2e7`, explorer/rdd blue `#89b4fa` (same color; internal role slug stays `rdd`,
  visible word is `rdd`, machine key stays `review`), judge purple `#cba6f7` (distinct),
  blocked/error red `#f38ba8`,
  done green `#a6e3a1`, idle grey `#7c7f93` (recedes)). The rows stay pi-keyed (pi-only by
  intent); each row value still carries the snapshot-provided identity,
  with no vendor colors invented. The consumer never emits `↳` (O4).

### 5.4 Freshness

A signal is *fresh* iff its token parses (§4.3) and `expiry > now`. Stale or
unparseable signals are dropped individually (one bad token never poisons the
other two). All gentle signals stale/missing → `idle` (native fallback, O5).

### 5.5 `gs`: the label for an isolated Gentle Shell pane

Herdr identifies an agent from the pane's foreground process group, and its
canonical aliases include `pi` and `gentle-shell` but never `gs`; a path prefix
is never consulted. An isolated Gentle Shell pane therefore has no Agents row
of its own unless this plugin supplies a label, which is why the label follows
a strict ladder that never lies about who owns the pane:

**Which panes belong to an isolated install.** The verified installation shape
is a user install under the XDG data dir — `<data>/gentle-shell/install`
(`$XDG_DATA_HOME/gentle-shell/install`, else
`~/.local/share/gentle-shell/install`), anchored by
`install/installation.json` (`gentle-shell-user-install/v1`, `Mode:
"separate"`), whose launcher starts the pane as `node
<root>/runtime/<channel>/bin/gentle-shell.mjs`. Qualification uses the same
input Herdr's detection reads, in this order:

- **Primary — the foreground process group.** A pane qualifies when any member
  of its foreground process group exposes an argv / `argv0` / cmdline path that
  resolves at or under the install root (a relative script path resolves
  against that process's own cwd). This is what real panes look like: the
  isolated pane is launched from the user's PROJECT directory, so its cwd is
  never inside the install. A readable group with no install member is an
  authoritative "no" — a cwd inside the root cannot override it.
- **Secondary — cwd.** Only when the group cannot be read at all (no
  `pane.process-info` answer) does `cwd` / `foreground_cwd` at or under the root
decide, and an unreadable group never throws and never logs more than one
  bounded line.

The root resolves from `GENTLE_SHELL_INSTALL_ROOT`, else the launcher's
`GENTLE_SHELL_HOME`, else the XDG data dir default. Windows keeps its own user
data dir (mirroring Herdr's `LOCALAPPDATA` state-dir convention) but is
unverified, which is why the manifest ships linux-only.

1. **Detection first: display agent only.** A qualifying pane Herdr already
   detects keeps Herdr's own truthful identity and live state. The plugin only
   reports `--display-agent gs` through `pane.report-metadata`, which is
   presentation-only and changes nothing about the state Herdr publishes.
2. **Reported label as the last resort.** A qualifying pane Herdr does not
   detect gets `pane report-agent --agent gs --state idle --source
   plugin:<plugin-id>:gs`, because a row exists only for an agent terminal and
   an undetected pane is not one. This is the only case in which the plugin
   states an agent identity, and it states `gs` — never `pi`.
3. **The report is reversible, never a mask.** Detection is a function of the
   pane's foreground process group, so an unchanged group owes no re-check
   while a changed one means a real agent may now be present. On that change the
   plugin releases exactly its own authority (`pane release-agent`, same
   source, label `gs`) and re-decides, keeping the display label: `gs` never
   masks a real `pi` / `gentle-shell` detection for longer than one beat.
4. **Release on the way out.** `pane.exited` / `pane.closed`, a pane that
   leaves the qualifying set, a disabled sidebar, and daemon shutdown all clear
   what this plugin reported — authority first, then the display label.
   Authority this plugin did not set is never touched: both the source and the
   label are part of every release.

`gs` is not a canonical Herdr agent, so `rows_by_agent.gs` is a configuration
error rather than an inert key: `rows_by_agent` stays keyed by a canonical
agent (`pi`), and `gs` exists only as a label.

Discovery — one bounded `pane list` read plus one `pane.process-info` per pane
(the read qualification needs; capped, and a scan pays for no answer twice) —
runs at daemon start, on an explicit `--refresh` (a separate request marker, so
the producer's per-beat refresh never triggers one), and on a roster event
(`pane.created`, `pane.closed`, `pane.moved`, `pane.exited`,
`pane.agent_detected`); never per frame. The only per-frame call is the
foreground re-check of a pane this plugin currently reports. Every write is
deduped against what the plugin already reported, every interpolated value is
checked against a strict identifier grammar before it reaches a fixed argv, and
any failure (no `pane list`, a CLI error, a disabled sidebar, an unreadable mode
flag) does nothing to the existing behavior and logs one bounded line per
distinct reason.

One thing this design cannot fix: the gs pane's own live state. Herdr reports
state for an agent terminal it knows, and the isolated install does not forward
`HERDR_ENV` to the pane's agent, so `gs` is a label on a row whose state is
Herdr's own (`idle` in the reported fallback). Forwarding that environment is a
gentle-ai concern and explicitly out of scope for this plugin.

## 6. Failure, retry, idempotency

- Delivery is at-least-once snapshots over an unreliable beat: producer
  re-emits full pane state every beat; consumer reduces the latest snapshot.
  There is no commit/ack; a timeout or lost report never implies the pane
  stopped — only TTL expiry changes the reduced state.
- Retry: producer retries a failed `report_metadata` via CLI fallback once
  per beat, then drops the beat (next beat re-sends full state). No unbounded
  queue; no backlog replay past TTL.
- Duplicate suppression: identical consecutive snapshots are a no-op for the
  consumer (no sidebar rewrite; desktop toasts are Herdr's native
  edge-triggered semantics, never re-fired by the plugin).
- Idempotency keys: ask intents carry `intentId` (`ask:<intentId>`); review
  spans carry `reviewId`. Re-emitting the same intent is safe; a new intent
  id is a new sidebar ask episode (and a new native toast edge). The
  `intentId` doubles as the Moshi `approval_required` action id when the
  phone channel is enabled (§7).
- Error containment: a failed beat transport is telemetry (a counter and a
  debug line), never state: it is our own report mechanism failing, not the
  agent, so it neither paints `error:` nor raises native `blocked`, and the
  next landed beat resets the counter. The one real error leg — the run
  itself stopping on an error — is released by the next non-error beat
  (`agent_start`, any tool activity, or a non-error assistant message), never
  latched; no exception path ever stops the producer beat (a quiet producer
  with no host truth and no work evidence ends its own bounded budget instead,
  §4.5). While the leg
  stands it publishes the durable `gentle_error_v1` token on every beat, so
  an error the sidebar missed on one beat is repaired by the next, and the
  release beat clears it (the missed-beat discipline of the ask/review
  tokens).
- No exactly-once end-to-end claim: at-least-once beats + TTL expiry is the
  engineered scope (consistent with the async/events guidance: never claim
  exactly-once without a deliberate mechanism). Desktop toast dedup is
  Herdr's native edge-triggered semantics; the phone channel dedups
  per ask episode producer-side (§7).

## 7. Notification ownership (native desktop, plugin phone)

- Desktop attention is native Herdr exclusively: `Blocked` fires the
  `NeedsAttention` toast (`<agent> needs attention`, request sound) and a
  background `Working|Blocked → Idle` transition fires the `Finished` toast
  (`<agent> finished`, done sound), both with Herdr's own focus-aware
  suppression and delay. The consumer daemon emits `herdr notification` for
  nothing — since v0.3.1 it owns no toast path: its former ask toast fired on
  the poll after the native one for the same question, a systematic
  duplication. The ask token still drives the sidebar ask display; sounds,
  suppression, and delay stay Herdr's.
- Herdr's own done/ask attention — the finished and needs-attention pop-ups and
  their sound — is Herdr's native behavior, configured in Herdr itself (its
  config and its settings). This package deliberately offers no switch for it;
  its only notification surface is the optional Moshi channel.
- `review` and `error` never emit a plugin notification: `review` attention
  stays in-flow/native; `error` is sidebar state only — our own `error:` label
  with the pane left on native `working`, so neither the `NeedsAttention`
  toast nor its sound fires and no phone envelope is sent. Tool-level failures
  (a failed tool call, a delegate record ending `failed`, a failed beat
  transport) never touch state at all: they are detected and logged, nothing
  more.
- Optional Moshi replacement (off by default): one flag file,
  `gentle-moshi.json` in the plugin state root, holding
  `{"enabled":true}` and re-read per event by the producer extension. While
  `extensions/moshi-hooks.ts` is installed, enabling also means adding
  `-extensions/moshi-hooks.ts` to the Pi settings `extensions` list by hand so
  the Moshi-managed hook cannot notify in parallel; that edit preserves every
  other key and entry and is reverted by removing the entry again. With it
  on, the producer extension replaces the Moshi-managed Pi hook entirely: it
  speaks the same wire protocol (category-less `session.update` carriers plus
  categorized events over the Moshi daemon socket), so Chat View, Live
  Activity, the session row, the terminal context and Moshi's own approval
  routing keep working, while notifications follow this plugin's policy —
  `approval_required` once per real ask episode (`actionId` = the ask
  `intentId`, subtitle `Answer in terminal`, title `Gentle ask: <project>`,
  message `<project> has a question and is waiting for your answer. Return
  to Pi to respond.`) and
  `task_complete` once per real finish (the synthesized `done` edge: the beat
  that delivers a fresh minted `gentle_done_v1` — settled plus zero
  running/queued plus zero pending plus zero live background jobs plus no
  human wait — never a raw native `working → idle` transition, which fires
  with work still left and skipped `done` entirely),
  never per prompt and never per turn. Every envelope path requires the flag at
  send time: a context captured for Chat View while the channel was on is
  prefill only and never authorizes a notification after it is turned off, and
  `task_complete` is announced at the minted `done` edge itself rather than
  after a successful Herdr publish, so a failed token beat cannot drop it. A
  `session.closed` (`session_ended`)
  envelope closes the row on shutdown, and the host-awaited handler flushes
  in-flight sends. `task_complete` carries title `Gentle finished: <project>`
  and names the last finished task: `<project> finished — <label>. Return to
  Pi for what's next.`, falling back to `<project> finished and is waiting
  for your next instruction.` with no tracked task. `<label>` is the most
  recent completed/cancelled TaskStore label only — short work names,
  sanitized and bounded to 80 characters, failing closed to the fallback;
  never ids, paths, or prompt content. `<project>` here is the
  multiplexer-session/cwd name (the extension never sees the Herdr workspace
  group), failing closed to `Gentle`. Lineage child sessions (transcript header
  `parentSession`/`parentSessionId`) are never published. Enabling mid-session
  still opens the row: the carrier is sent on demand, once per session.
  `enable`/`disable` also add/remove the `-extensions/moshi-hooks.ts` entry
  in the Pi `settings.json` `extensions` list so the original hook cannot
  notify in parallel (and is restored on disable); both settings edits happen
  only while `extensions/moshi-hooks.ts` exists, preserve every other key and
  entry, write atomically, and fail closed on an unreadable or invalid
  settings file (reported, never rewritten). The consumer daemon never
  publishes to Moshi (single emitter). Moshi owns pairing and credentials
  (host secret in its own store); the plugin never reads or stores a token,
  and an absent daemon or unpaired host is a silent no-op that never
  interrupts Pi. `review` and `error` never notify; a failed tool never even
  changes state. Limits (host-owned,
  unverified): the phone-side approval round-trip through Moshi's TUI bridge,
  the Live Activity lifecycle, and whether a `task_complete` renders as a
  separate banner or only updates a running Live Activity are Moshi's.
- The flag is re-read per event, so flipping it silences or activates our
  sender immediately; a settings-exclusion edit only takes effect on the next
  Pi extension load, so a running session needs `/reload` after that one edit.
  Fresh sessions are single-emitter by construction (exclusion entry + flag).
- Gentle mode is enabled by default: while selected, the gentle producer is the single publisher of native `pane.report_agent` (`working`/`blocked`/`idle`) alongside its metadata beats (session path-or-id binding, monotonic seq seeded from the clock as
`Date.now() * 1000` exactly like Herdr's own plugin SDK, serial latest-wins
coalesced queue, bounded retries; never `done`/`finished`, never a
notification method). The clock seed is load-bearing: Herdr ignores a report
whose `seq` loses to the stored one, so a zero-based counter makes every
report after a Pi restart or `/new` (both recreate the extension runtime)
lose, freezing the pane's `agent_session` binding at the old session while
the producer keeps beating for the new one — the consumer then rejects those
fresh tokens as a session-hash mismatch and the pane stays on `idle` until a
report with a higher seq lands. Parity contract: `working` carries the specific working role in the message (oldest running role word from the same roles resolution — known short word, unknown sanitized name, or the pink generic `gentle` with no delegation; never bare generic `working`; machine keys unchanged); terminal `idle` only on a truly empty settle (principal settled plus zero running/queued plus zero pending plus zero live background jobs plus no human-wait prompt; settle-with-delegates/pending/jobs stays `working`, emitted once with no re-emit on repeat settles). A settle the producer missed is recovered from the host's own live truth: a beat with nothing active and no work evidence reconciles `settled` from `isIdle()`, a quiet producer the host never answers stops beating after a bounded budget instead of republishing a count-0 work token forever, and only an observed turn mints `done`, so a reconciled settle announces nothing. Live background jobs come from Gentle Shell's own bus event `gentle-ai:jobs-sidebar` (`bash_background` / `monitor`), session-scoped and emitted on job edges only, so a snapshot counts only while it is fresh — a stale or foreign snapshot is zero jobs; an absent Gentle Shell simply reports none (today's behavior). Only an entry with no `status` is pending work: Gentle Shell keeps a finished job in the array as a result tail (`status: exited|stopped|failed`), and counting that tail is what pinned the row on the pink generic `gentle` — and blocked `done` — while the panel read no running job. One `unref()`-ed timer per live snapshot publishes a single beat at the instant the snapshot goes stale, so a missed exit event cannot leave the settle without a beat. While such a job waits with the principal settled and no delegate running or launching, the producer keeps the root marker live so the row stays on the pink generic `gentle` (§5.2) and the finish is held back; the wait ends on the beat the principal resumes, a delegate starts, the last job ends, or the snapshot ages past its staleness bound. `blocked` only for an actual human-wait intervention leg with its label (review/RDD execution stays `working`, silent); an error never claims native `blocked` — while our `error:` label stands the pane reports `working`, the only native state that raises no host attention, and returns to the lifecycle state on the next non-error beat. The native status keeps its aggregate meaning (it reads `working` while any delegate runs, which is what Herdr's own pane state means): the sidebar row's working-vs-idle decision reads the principal-only `gentle_principal_v1` instead (§5.2), so an idle principal with a running delegate shows that delegate's own role word or name rather than the principal's `gentle`. Single publisher by design: the managed native extension file is excluded
  reversibly (`-extensions/herdr-agent-state.ts` in Pi settings, bytes
  preserved on disk, never auto-loaded next to ours). `node
  bin/gentle-sidebar.js (enable|disable|status|toggle)` selects the
  publisher: native gates
  our producer/daemon, removes only our ownership-bound native exclusion and
  managed sidebar rows, and reports that the running session needs `/reload`
  (the exclusion and the native sidebar only take effect on the next Pi
  extension load). Its shared
  `gentle-sidebar-mode.json` uses `{version:1,enabled:boolean}`; missing means
  enabled, malformed fails closed. Never run both publishers on the same pane
  (dual publishers collide). See [docs/sidebar-control.md](docs/sidebar-control.md). Limits (unverified, host-owned): the host `idle`->`done`->`finished` mapping (finished text, toast/sound) and unknown-state handling are owned by Herdr.

### Command surface

The package ships one CLI switch command,
`node bin/gentle-sidebar.js (enable|disable|status|toggle)` (§7), and one in-Pi
command, `/herdr-gentle:customize`, with exactly three switches: the managed
sidebar agent rows, the Moshi notification channel and the Herdr theme sync
(§12). The command registers before the `enabled()` pane gate, so every switch
stays reachable from a plain Pi session outside a Herdr pane. It owns no state of its own and reimplements
nothing:

- `Sidebar agent rows` drives the Herdr plugin's own `bin/configure.js` —
  `--check` to read the current state, `--apply --reload` /
  `--uninstall --reload` to change it — and re-reads `--check` as the
  completion proof. The extension never edits the Herdr config itself.
- `Moshi notifications` writes `gentle-moshi.json` and, while
  `extensions/moshi-hooks.ts` is installed, adds or removes the
  `-extensions/moshi-hooks.ts` entry in Pi's `settings.json`. Enabling runs the
  `moshi-hook` prerequisite gate first (exact-name PATH scan plus
  `moshi-hook status --json` reporting `paired: true`) and a refusal writes
  nothing at all; disabling skips the gate. Pi is reloaded only when the
  settings entry actually changed, because that entry is the only part that
  waits for the next Pi extension load.

`/herdr-gentle:customize status` prints one read-only line; an unknown
argument, Esc, or a cancelled menu writes nothing. With no argument the
command opens the floating panel (`lib/customize-panel.js`, painted through its
own palette) over `ctx.ui.custom` in Gentle Shell's own layout: one left
`CATEGORIES` list, one right pane headed `<Category> · n/m`, and one line per
setting with its options inline — `●` the stored option, `›` the cursor while it
sits elsewhere, `○` the rest. The arrows move the option cursor and only `Enter`
applies; `Enter` keeps the card open (only a Moshi settings change that needs a
Pi reload closes it), `Esc` closes without a write, `Tab`
switches panes and `↑/↓` (or `j/k`) moves between settings. A line whose options
do not fit scrolls sideways behind muted `‹`/`›` markers with an `n/m` counter,
falling back to a compact `‹ value ›`; the Preview block below the panes reads
`Preview · <option> · <title>` plus a sample, and a theme option is painted in
that theme's own palette; the footer carries one of three legends (categories,
option row, panes) after the `Click · ` prefix, chosen by what the keys do right
now and compacted instead of wrapped on a narrow card, with no `p profiles` key
because this plugin owns no profiles concept. A click on an option applies
exactly that option, a click on a setting's name only moves the focus, a click
on a category selects it, and a click outside the panes is ignored (a press only
captures the gesture, so a drag never applies anything).
Each category owns its own settings: `Herdr Sidebar` shows the single
`Sidebar agent rows` setting, the only Moshi switch is the `Notifications`
setting under `Moshi notifications`, which applies the `gentle-moshi.json` flag
through `applyMoshiNotifications`, and `Herdr Theme` owns the `Theme sync`
toggle plus the inline `Gentle Shell theme` list (§12). The two channels are
never mixed: the sidebar-rows
switch neither reads nor writes that flag, so disabling the agent rows leaves
the notification channel exactly as it was.
An inconclusive sidebar verdict (`unknown`) renders with no option marked `●`
and a note instead of hiding the setting: toggling still attempts the repair and
reports the apply step's own error, exactly like the menu. The plain
two-step `ctx.ui.select` menu remains the
fallback when the TUI helpers or `ctx.ui.custom` are unavailable. The removed
`Plugin tools` and `Reset` sections and the in-process provider slot
`globalThis[Symbol.for("herdr-gentle.customize.v1")]` are not restored: they
switched worktree/ODD/issues surfaces this package no longer contains, so
exactly one mechanism writes each piece of state.

## 8. Limits

- Token budget: ≤ 16 tokens per report per pane (E8 discipline); the
  producer emits at most 12 tokens per beat (including the retired
  `gentle_subs_v1` clear) (`gentle_work_v1`,
  `gentle_roles_v1`, `gentle_names_v1`,
  `gentle_orchestrating_v1`, `gentle_principal_v1`, `gentle_done_v1`,
  `gentle_ask_v1`, `gentle_review_v1`, `gentle_error_v1`,
  `gentle_changes_v2`,
  `gentle_changes_v1`) and the daemon publishes its 71-token owned family
  chunked ≤ 16 per report (row 1 is the 3 native tokens
  `state_icon`/`workspace`/`agent`; the legacy 11 `gentle_heading_*` compat
  family stays published but wired into no visible row. Row 2 wires 11
  title + 2 change cells = 13 — each within the per-row ceiling). Names are
  advisory; roles are authoritative for display and role labels carry the
  running total as a suffix when at least two delegates run.
- TTL: `expiry <= now + 60000` at write; readers use `now` at read.
  Clock skew assumption ≤ 5 s (documented; not compensated).
- Field bounds: `count` ≤ 16 digits; `label` ≤ 64 chars; names/roles
  CSV totals ≤ 512 UTF-8 bytes each; `intentId`/`reviewId`/`code` ≤ 64 chars,
  `[A-Za-z0-9_-]+`.
- Poll cadence: resolved — must be ≪ 60 s TTL to avoid flapping
  (see §10 U2). The daemon runs an adaptive poll (10 s baseline,
  `GENTLE_STATUS_POLL_MS`-overridable, 2 s fast cycle
  (`GENTLE_STATUS_FAST_POLL_MS`) while recent ask activity, a rendered
  non-idle display, or send/publish failures are observed, recovering after
  N quiet frames
  (`GENTLE_STATUS_FAST_QUIET_FRAMES`) or a TTL-bounded window
  (`GENTLE_STATUS_FAST_WINDOW_MS`), 250 ms floor, single dynamic
  `setTimeout` chain. The active-display trigger exists because the row data
  the daemon refreshes by a frame rather than from a producer report —
  `agent.list` plus the presence prefix — cannot be driven by a
  producer report; only `idle` counts as settled, so an idle pane keeps the
  baseline exactly.
  Drawing is event-synchronized; polling is only the fallback. Every landed
  producer beat requests the daemon's ONE coalesced refresh (the same request
  file `--refresh` touches, §10 U2), so a report that changes state draws an
  immediate frame instead of waiting for the next poll — the event lands on
  time AND the drawing follows it. N reports in one window collapse into one
  frame, and refresh-driven frames are floored at 250 ms after the frame that
  started the sleep, so a report storm can never spin the loop.
  The token path is also subscription-driven: the daemon holds exactly ONE
  long-lived socket `events.subscribe` for `pane.updated` (plus the roster
  kinds `pane.created`, `pane.closed`, `pane.moved`), because
  `pane.report_metadata` bumps the pane revision and Herdr then emits
  `pane.updated` with the full pane payload. Herdr repaints push-driven on that
  write plus its metadata-TTL expiry, so a token write no longer waits for the
  poll. An event does nothing but set ONE dirty flag and wake that
  same sleep: the flag is consumed with the refresh request into a single
  frame, so a burst collapses to one frame, there is no second frame loop, no
  timer, no per-event frame, no queue (bounded memory is that one boolean) and
  no frame sooner than the same `refreshGateMs`/`POLL_MIN_MS` floor. A
  manifest `[[events]]` hook cannot do this and must not be tried again:
  `pane.updated` is deliberately excluded from the 22-name hook surface
  (`PLUGIN_HOOK_EVENT_KINDS`), and the runtime filter drops non-hook kinds, so
  `on = "pane.updated"` in `herdr-plugin.toml` is inert. Reconnect is bounded
  and single-flight: 1 s doubling to a 60 s cap, reset only after a connection
  that stayed live 5 s, so a Herdr restart reconnects promptly while a server
  that accepts and drops climbs to the cap instead of flapping. A rejected,
  closed, or unanswered subscription logs one line per distinct reason and
  changes nothing else — the poll below is unchanged and correct without it.
  Shutdown closes the socket and its retry timer, and neither keeps the process
  alive. Idle cost with no events is exactly today's: an idle subscription is
  silent and the loop sleeps as before.
  What the subscription can never drive stays poll-only: the daemon's own
  `agent.list` snapshot and the presence prefix, because Herdr emits no event
  for either. That is why the fast cycle is armed
  by a rendered non-idle display, and why polling is never removed.
  The sleep is also capped at the nearest live `gentle_done_v1` expiry AND the
  nearest pending view-dwell deadline (`DONE_VIEW_DWELL_MS`) among
  the panes just rendered (never below the 250 ms floor), so a held `done`
  row reaches `idle` when the cap or the dwell lapses rather than up to one
  poll later.
  A pending expiry may only SHORTEN the delay: with no pending expiry the
  delay is exactly the adaptive value above, and an already-expired or
  unparseable value falls to the floor (fail closed, like every parser)
  rather than returning 0.
  The four lifecycle hooks (`pane.agent_detected`, `pane.agent_status_changed`,
  `pane.exited`, `pane.closed`) each run `node bin/gentle-status.js --refresh`
  (daemon ensure plus one coalesced immediate frame), not the cadence itself;
  `[[startup]]` (no args) remains the polling-daemon bootstrap and polling
  remains the fallback for every lifecycle signal.
- Scale: one producer per Pi pane; one consumer daemon per host; no
  cross-pane aggregation in v1.

## 9. Compatibility and migration

- Additive only in v1: new token names (`gentle_work_v1`,
  `gentle_roles_v1`, `gentle_names_v1`,
  `gentle_orchestrating_v1`, `gentle_principal_v1`, `gentle_done_v1`,
  `gentle_ask_v1`, `gentle_review_v1`, `gentle_changes_v1`, `gentle_changes_v2`,
  `gentle_state_*`, `gentle_title_*`, `gentle_agent_*`, `gentle_agent`,
  `gentle_icon_*`,
  `gentle_heading_*`, `gentle_project`, `gentle_row_*` (each family now
  includes the `judge` display alongside the original ten), plus display-only
  `gentle_changes_added`, `gentle_changes_deleted`,
  `gentle_changes_summary`); no change to `pi_subagents_work_v1`, `state_*`,
  `title_*`, or native `working`/`blocked`/`idle` semantics.
  `gentle_title_error` keeps its machine-key-derived token name; only its
  user-facing value is `blocked` (§5.3). `gentle_title_review` likewise
  keeps its machine-key-derived token name; only its user-facing value is
  now `rdd` (aligned from `review` by the native-owner T1). `gentle_title_orchestrating` likewise keeps its machine-key-derived
  token name; only its user-facing value is `gentle`. `gentle_title_working`
  likewise keeps its machine-key-derived token name; its user-facing value is
  a non-contemplated subagent's own sanitized name, never the word `working`.
  The retired `*_working_subs` token family (the old `working (n)`
  count display) is swept, never written. The retired
  `gentle_changes_pull` name (the removed behind-upstream `↑N` marker) is
  swept the same way, never written.
- Coexistence: `herdr-pi-tree` stays installed but disabled for gentle-owned
  panes (O1). No uninstall, no token migration, no dual-run merge — ownership
  handoff is by enable/disable switch, reversible at any time.
- Removed surfaces: the worktree tools (`worktree_create` / `worktree_list` /
  `worktree_close` / `worktree_session_open` / `worktree_warp`), the warp
  panel, the ODD and Issues readers, and the `Plugin tools` toggles no longer
  ship. This package publishes the Herdr producer sidecar and the Moshi channel
  only; `bin/gentle-sidebar.js` is its one CLI and `/herdr-gentle:customize`
  its one in-Pi command, carrying just the sidebar-rows, Moshi and theme-sync
  switches. Its provider slot `globalThis[Symbol.for("herdr-gentle.customize.v1")]`
  stays removed, so no other extension renders those switches.
- Rollback: disable this plugin → producer stops writing; consumer sweeps
  only `gentle_*` tokens + labels it set (O5); pi-tree re-enable restores
  `↳N` behavior with zero data migration.
- Future breaking changes (grammar change, TTL change, badge-slot change)
  require a new token version suffix (`_v2`) with a dual-emit period; old
  names are removed only after observed zero-read evidence. Token-name
  versioning (not sidebar-config versioning) is the compatibility mechanism.
- Packaging (two-package split): the repository ships two independently
  versioned packages — the Pi package at the repository root (published to
  npm as `herdr-gentle-shell`, installed with
  `pi install`, updated with `pi update --extensions`) and the Herdr plugin
  in `herdr-plugin/` (installed with `herdr plugin install
  jonasotoaguilar/herdr-gentle-shell/herdr-plugin`, updated with
  `herdr plugin update herdr-gentle-shell`). Releases run on two tag
  series, `pi-vX.Y.Z` and `herdr-vX.Y.Z`; the Herdr side is not bumped when
  it carries no change. The repository ships no install script: the
  documented path is the two plain package installs above. The old
  managed-copy install (copying `extensions/gentle-herdr-state.ts` into the
  Pi agent dir) is retired and needs no migration step of its own.
  Ownership split: the Pi package owns the Pi-side helpers (the extension,
  the exclusion helper, the sidebar bridge); the Herdr plugin owns the
  runtime Herdr consumes (manifest, daemon, configure, diagnostics, token
  contract). Cross-package calls resolve the installed plugin root through
  `herdr plugin list --json`, never through a repo-relative path.

## 10. Unresolved decisions (do not implement against guesses)

- **U1. Notification CLI + dedup:** resolved (v0.3.1 — the consumer emits no
  toast, so its CLI syntax is moot). Herdr-side semantics verified in source
  (`notification_toast_for_state_change`): edge-triggered per state change,
  `Blocked → NeedsAttention`, background `Working|Blocked → Idle` →
  `Finished`, focus-aware suppression, global delivery switch only (no
  per-agent mute, no plugin veto).
- **U2. Event catalog + poll cadence:** full `[[events]]` catalog of the
  plugin host and the daemon's snapshot poll cadence (must be ≪ TTL).
  Resolved: `pane.agent_detected`, `pane.agent_status_changed`, `pane.exited`,
  and `pane.closed` — all confirmed in the installed 0.9.4 schema (T1 probe)
  — each invoke `node bin/gentle-status.js --refresh` (L6: daemon ensure
  plus one coalesced immediate frame, never a second writer loop), while
  `[[startup]]` (no args) remains the polling-daemon bootstrap and polling
  remains the fallback for every lifecycle signal. The producer extension is
  the second requester of that same coalesced refresh — it requests one after
  every landed token beat, so a status change it publishes is drawn at once
  rather than at the next poll — and the daemon caps each sleep at the nearest
  live `gentle_done_v1` expiry (§8), so `idle` does not wait for a poll either.
  Neither requester renders a frame or writes tokens. `--once` keeps its
  existing one-frame public behavior for manual use and is not wired as a
  hook. Runtime proofs of the `--refresh` contract belong to the lifecycle
  unit's tests, not this protocol record.
- **U3. pi-tree producer file:** which file in `herdr-pi-tree` emits
  `pi_subagents_work_v1` (only `lib/state.js` consumers were traced); needed
  to confirm no shared writer path.
- **U4. Review-in-progress matcher — RESOLVED (task 8), narrowed (L2, corrected):** Pi in-process `tool_execution_start` opens / `tool_execution_end` / `tool_result` closes (by `toolCallId`; a `tool_call` proposal alone never opens) for the exact tools `gentle_review_capture`, `gentle_review_capture_group` (G5) with `reviewerRunAcknowledged: true` in the runtime args — the sole reviewer-capable predicate. `correctionLines` is native correction planning (captureCorrectionPlan), never a reviewer, and disqualifies (including combinations invalid upstream). Sidebar `reviewing` fires at any bound capture entry BEFORE the forecast branch, so no sidebar/event signal proves a legacy reviewer route: unknown legacy shapes stay dark (documented conservative limitation; bindings stay opaque, never parsed). The reserved `gentle-pi:review:blocked` hook has no producer and is not observed. `gentle_review` in any operation (inspect / status / start / ack / assess / select-intended-untracked), `gentle_review_scope`, and forecast-only calls never enter. Fail-safe semantics: `review:` label only while acknowledged capture/group execution is in flight; `reviewId` is a sanitized correlation id, never a provider verdict. During a capture-group run the single parent capture-group call stays in flight across the whole multi-reviewer span, so that one call alone holds `review:` — no per-reviewer tracking. The consumer renders this leg as user-facing `rdd` (machine key stays `review`); execution never implies human waiting and never notifies. Exact limitation: the acknowledged capture interval contains preparation and admission; no exact reviewer internal events exist today, so the span is a bounded approximation, never exact interval proof.
- **U5. Changes badge — RESOLVED (two-row contract):** the `±N` vs `~N`
  selection no longer exists — the combined badge is retired in favor of
  independent `+N`/`-N` segments from exact `gentle_changes_v2` added/deleted
  totals, plus the daemon-side change cells (§5.3). The producer mirrors
  the Gentle Shell `SessionChanges` model semantics over the same transcript
  `SESSION_CHANGE_ENTRY` evidence (never git and never an approximate
  reaggregation): files keyed by `(root, path)`, evidence-ID dedup,
  identical before/after records skipped, first `before` preserved with
  latest `after`, unavailable on broken snapshot continuity or any
  `kind: unavailable` snapshot (unavailable files stay in the file count
  with 0 added/0 deleted), and unified-patch line accounting for available
  text/absent snapshots (absent maps to empty text for patch counts).
  Remaining transport note: cross-process delivery of entry facts to the Pi
  producer extension still rides the session transcript.
- **U6. Gentle source pin:** canonical `gentle-shell` checkout vs versioned
  package pin the producer/consumer build against.

## 11. Verification criteria (task 4 close)

Docs-only task: no test runner (TDD n/a). Verify by re-reading this file and
confirming each criterion has a normative section:

| # | Criterion (sidebar behavior) | Normative section |
|---|------------------------------|-------------------|
| V1 | Sidebar shows the active TaskStore role with live subagents | §4.2 (role source G3 + `gentle_roles_v1`), §5.2–§5.3 |
| V2 | Sidebar shows `ask` on open question | §4.2 (G4 → `ask:`), §5.2 priority, §7 notify-once |
| V3 | Sidebar shows `review` during native review | §4.2 (review tool lifecycle → `review:`, incl. capture-group parent call), §5.2 priority |
| V4 | Change segments render from Gentle session-changes | §4.2/§4.4 (`gentle_changes_v2`), §5.3 `+N`/`-N` |
| V5 | No collision with pi-tree `↳N` / `state_*` names | §3 O1/O2/O4, §9 rollback |
| V6 | Stale panes fall back to `idle`, orphans swept on handover | §3 O5, §5.4, §6 |

Task closes when V1–V6 are all traceable above and the file re-read reports
path + line count. Any untraceable cell → `status: partial` with the gap
list, not silent.

## 12. Theme sync (Pi palette → Herdr theme)

Herdr's palette follows the theme active in Gentle Shell / Pi, or one theme
pinned while the sync is off (S1–S7). The switch lives with the other two in
`/herdr-gentle:customize`; the user-facing reference is
[docs/theme-sync.md](docs/theme-sync.md). Six modules with one owner — this Pi
package — and one direction of data:

| Module | Owns |
| --- | --- |
| `lib/theme-store.js` | The one persisted document (`gentle-theme.json`): the state-dir resolution copied verbatim from the sidecar's Moshi flag, a normalised read, and the atomic replace. |
| `lib/theme-projection.js` | The pure translation: assignable Herdr theme names, Herdr token order, `HERDR_ROLE_SOURCES`, the `DOTS_FIXED` surface tables, `projectPalette`, `paletteFingerprint`, and the `Off` label the projection exposes. No filesystem, no host import. |
| `lib/herdr-theme-config.js` | The pure planner — a **line splicer, not a TOML validator**: table-boundary scanning (headers only at real line starts), opaque bytes outside the two theme tables, a strict theme-table grammar, the whole-line `was` marker with byte-exact restoration (the user's latest trailing comment wins), the single regenerated block (`begin` / `begin created` … `end` / `end after a missing line ending`) and the created table it removes again, the ambiguity refusal for a marker-shaped comment above a block being removed or moved, the 1.8.0 marker-pair migration, the BOM, and the enforced splice invariant. |
| `lib/herdr-theme-apply.js` | The writer: the availability guard matrix, the bounded snapshot, the two compare-and-swap checks, the atomic non-overwriting backup (a regular existing file is accepted as it is), retried temp cleanup that names a survivor and only ever removes a path it created itself, the growth limit, `forceReload`, the exclusive temp + `fchmod` (all mode bits) + `fsync` + `rename`, and the reload. |
| `extensions/herdr-theme-sync.ts` | The follower: session-start evaluation, 500 ms tick, the two identities, one in-process apply per change, the notices. |
| `lib/customize-panel.js` + the theme wiring in `extensions/gentle-herdr-state.ts` | The switch and the card: `applyThemeSync`, `writeThemeChoice`, `applyCustomizePanel`, `customize status`, and the setting lines, Preview block, legends and pointer hits. |

**In process, and why that is the fix.** The 1.8.0 follower spawned
`bin/configure-theme.js` from the *separately installed* Herdr plugin, found
through `herdr plugin list`, and that writer refused any `[theme]` table outside
its own marker block. A Pi-only update therefore kept running the old plugin's
writer — or, on an install that never shipped it, ran no writer at all — while
the user's real config, which already owns `[theme]`, was never touched. The
reference implementation
([gentle-herdr](https://github.com/MarsSall/gentle-herdr), MIT License,
Copyright (c) MarsSall) applies from Pi itself, so this package does the same:
`applyHerdrTheme` edits the config inside the running Pi process, and the
plugin-side `configure-theme.js`, its planner and the
`# BEGIN herdr-gentle-theme` managed block are gone. The plugin is not involved
in theme sync and needs no update for it. A config written by 1.8.0 keeps
working: the planner drops those two marker lines only when they are the nearest
pair and the pair actually encloses a `[theme]`/`[theme.custom]` table (a stale
pair around unrelated keys is the user's text and stays, and a pair closing on an
unterminated last line migrates without changing the file's final-newline state),
then edits the table between them like any other. Pi colours become hex
strings in the follower through `colorToHex` from `@earendil-works/pi-tui`,
which is why the follower is its own extension rather than a section of the
state sidecar: the sidecar is loaded by every suite as a renamed copy with one
stubbed host import, and the projection needs no host at all.

**Ownership rule, and the two classes it implies.** Sync is a switch the user
turns on deliberately, so with the sync on — or a theme pinned — this package
OWNS the `name` line and every token it projects, and it must be able to give
them back. Two classes, which is what makes switching Pi themes safe:

- **a value the user already had** is replaced in place and remembered by one
  comment recording **the whole original line** (minus its indentation, so
  trailing spaces and an inline comment are part of the record) above it: the
  first original wins, a later palette change reuses it, and a projection that
  stops carrying that token — or comes back to the recorded value — **restores
  the line byte for byte** and drops the comment. The one exception is the
  **latest edit wins**: if the user changed the line's trailing comment after the
  planner wrote its value, the restore keeps the recorded key/value and the
  user's *current* comment. A comment is only a marker when
  its payload parses as the strict `key = <string> [comment]` line for the key
  under it, and two markers for one key are refused;
- **a token the user did not have** is written inside ONE marked block
  (`# herdr-gentle-shell: begin` … `# herdr-gentle-shell: end`, or
  `# herdr-gentle-shell: begin created` when the planner also creates the table,
  and closed with `# herdr-gentle-shell: end after a missing line ending` when
  placing the block also added the file's missing final line ending, so a later
  clear takes back only what the planner added)
  at the end of `[theme.custom]`, regenerated on every plan, and removed entirely
  when nothing is left to own — so leaving a projection never leaves a stale
  colour behind. A table the planner created is removed again once its block
  empties and nothing else lives in it, which is what makes a cycle of
  projections ending in an empty custom projection return the original
  `[theme.custom]` byte for byte; only `<token> = "#rrggbb"` lines may sit
  inside the block, and anything else there is refused rather than deleted.
  Removing or moving a block is refused
  (`line <n>: ambiguous herdr-gentle-shell marker above the managed block`) when a
  marker-shaped comment directly above `begin` would become adjacent to the token
  key under the block, because the next plan would promote the user's ordinary
  comment to ownership.

A token the user owns with no marker (`panel_bg`, `blue`, `yellow`, …) is never
written, merged or repaired, even when the projection stops carrying it: it was
never ours. A `[theme.custom]` header the **user** wrote stays even when it ends
up empty, because the planner cannot prove it created that line. Two
consequences are stated rather than papered over: a tool that rewrites the same
keys (a desktop-theme sync such as DMS/Niri, for example) overwrites the
projected values on its next run, and the next palette change here overwrites
them back; and the revert is per token, not per file — a user-written empty header
and the `name` marker stay. This is also where
the port deliberately differs from the reference: it accepts
`auto_switch = false` untouched — the reference refuses that line outright,
which is exactly why the user's real config was never written — and it edits
tables the reference treats as foreign.

**The state file is the only persisted truth.** `gentle-theme.json` holds
`{sync, theme, updatedAt}` and nothing else is cached, mirrored or inferred: the
panel and the follower read the same document, so the setting, the switch and
the applied palette can never disagree. Missing is inert (`sync:false`,
`theme:null`); a document that cannot be read or parsed is a refusal — `ok:false`,
no option marked, a `state unknown` note, follower silent — never a guess, and
it is written over only
when the user acts. The default install (sync off, no theme) therefore writes
nothing at all (S7), and a stored pin is carried across a sync toggle so turning
the sync off restores that choice instead of unassigning it.

**Tick, fingerprint and the follower repairs.** The host publishes no
theme-change event, so the palette is a pull-read of `ctx.ui.theme` (or
`ctx.ui.getTheme(name)` for a pin): one immediate evaluation on `session_start`
and then one every 500 ms, on an unreferenced timer so an idle follower never
keeps Pi alive, cleared on `session_shutdown` (a shutdown that lands during the
first evaluation wins: no tick is armed afterwards). Each evaluation computes two
identities — the requested `[sync, chosen]` and the palette fingerprint
(`[theme name, sorted token/hex pairs]`) — and acts only when one differs from
the last one it recorded, so a theme recoloured in place (same name, new
colours) is noticed without a restart, and the same palette is never applied
twice. The observation is recorded **before** the apply, so a failed or refused
write is never retried on the next tick and never blocks the next real change
either; one apply is in flight at a time. With the sync off and no theme pinned
the follower asks for nothing at all (no write, no removal) **and forgets what it
applied**, which is what makes re-enabling the sync always re-apply: without that
reset the next `On` would look unchanged and a config the user repaired in
between would never be written (an already-matching config then answers
`unchanged`). A projection with no concrete token is refused before the writer is
called — `Herdr theme not applied: <name> has no concrete colours to project.`,
once per session — because it would otherwise rewrite the theme name and paint
nothing. Availability is decided once, by `applyHerdrTheme`, so the follower can
never disagree with the writer about who may write; a subagent child
(`GENTLE_PI_AGENTS_CHILD=1`) never registers the follower at all, and every
user-visible outcome is one of the fixed notices in
[docs/theme-sync.md](docs/theme-sync.md). A `partial/reload` sets an **owed
reload**: the next apply attempt of the same session is sent with
`forceReload`, and a success pays the debt off. It is session memory on purpose
(a tick never reloads while the debt stands), which is why the notice ends with
`Run 'herdr server reload-config' to apply it.`

**A splicer, and a strict core.** The writer edits the user's own `[theme]` and
`[theme.custom]` tables and preserves every byte it does not own: other tables
and keys, comments, blank lines, ordering, indentation, spacing around `=`, a
trailing comment on a rewritten line, CRLF or mixed endings, a leading UTF-8 BOM
and a missing final newline. **Outside those two tables nothing is validated**:
the planner only tracks the three contexts that can hide a line
break (multi-line strings, multi-line arrays, inline tables) plus comments, so it
can find table boundaries — a header-shaped line must parse and a multi-line
construct must be terminated, or the plan refuses — and it treats the rest of the
document as opaque bytes: an input that is already invalid TOML there is the
user's pre-existing breakage (Herdr refuses to load it) and is left exactly as it
is. Escapes there are never validated (a backslash only consumes the next
character, in single-line and multi-line strings alike) and a run of three or
more quotes closes a multi-line string; the scan validates escapes only where it
must read a value back (a quoted key and a strict theme-table line).
**Inside the two tables it is strict**: comments, blank lines and
`key = value [comment]` with a single-line string, boolean, integer or float; a
key the plan must touch in any other form is refused with its line number, while
a key it does not touch is kept byte for byte whenever the scanner can find where
that line ends. It refuses: `auto_switch` with a value other than `false`,
`dark_name`/`light_name`, a top-level `theme` key, a dotted key extending
`[theme]` or a Herdr token in `[theme.custom]`, a second `[theme]`/`[theme.custom]`
table, a third `[theme.*]` table, `[[theme]]` array-of-tables, `name`/
`auto_switch` repeated in `[theme]`, a token repeated in `[theme.custom]` or in
both the block and the user's keys, two markers for one key, a touched value that
is not a strict single-line string (or a multi-line form, refused as "cannot
record the original value … safely"), a control character, a bare carriage
return, a malformed block (outside `[theme.custom]`, unterminated, a second
begin, an end without a begin, any line in it that is not
`<token> = "#rrggbb"`), the ambiguous marker above a block that is about to be
removed or moved (`ambiguous herdr-gentle-shell marker above the managed
block`), and a table header or unterminated multi-line string/array/inline table
the boundary scan cannot resolve. A malformed
projection is refused the same way without a line number, because that one is a
package bug. **The splice invariant is enforced in code**: before `ok: true` the
planner re-derives the non-theme lines of its own output and compares them with
the input's (only the 1.8.0 marker lines it wrote may be missing, and only the
single terminator needed to append a table after an unterminated last line may be
added); a mismatch returns `internal splice invariant violated; no changes
proposed.` rather than a document that moved a byte it promised not to touch. The
file-level refusals belong to the snapshot and the write: a non-absolute or
non-canonical path, a symlinked parent directory, not a regular single-link
file, over 256 KiB, invalid UTF-8, a backup path that is not a regular file, a
planned document past the 256 KiB limit, bytes that changed between the snapshot
and the replacement (`Herdr config changed before replacement`), a backup temp
that cannot be removed, a missing config (never bootstrapped), and a failed
rename. Every refusal writes nothing, backs up nothing and reloads nothing.

**Safe write, and exactly one reload.** The snapshot is one bounded strictly
decoded read with stat identity checks; a leading BOM is decoded as part of the
text (`ignoreBOM`) so a changed write keeps it and the backup and the file agree
on those bytes. The plan is refused **before anything is written** if the
document would grow past the same 256 KiB limit. The original bytes are re-read
and compared immediately before the backup and again immediately before the
swap, so a projection computed from stale bytes is never renamed into place. The new text
is staged at a path chosen **before the file exists**, so every failure — open,
write, `fsync`, `fchmod` — leaves the writer able to remove it: exclusive `0600`,
`fchmod`-ed to the original mode (`0o7777`, so setuid/setgid/sticky survive),
compared once more, then `rename`d. Temp cleanup is best-effort **and never
silent**: the unlink is retried once and then force-removed, and a survivor is
reported instead of hiding — if the **backup's** temp survives, the apply fails
with `Herdr backup temporary could not be removed: <path>` (so it can never
answer `requested` with a stray file), and a surviving **staged** temp appends
`; temporary file left behind: <path>` to the `partial`/`config` error. Cleanup
only ever removes a path the call created itself: a foreign file at that exact
temp name makes the exclusive open fail with `EEXIST`, the apply answers
`partial`/`config` with that text, and the file is left alone (config and backup
untouched). The
backup itself is **published atomically and never overwritten**: written to a
temp name and hard-linked into place, so a crash or a full disk leaves no
truncated `.bak` that a later run would mistake for "already backed up". A
regular file already at the backup path — pre-existing or raced — **is** the
existing backup: accepted as it is, never compared and never overwritten (it may
be an older original from before the user's last edit), while a non-regular
entry (directory, symlink, socket) is refused. `unchanged` writes
nothing and reloads nothing — Herdr already holds that palette, and a reload on
every tick would make the sidebar flicker for nothing. `forceReload` is the one
exception, and it exists for the owed-reload repair above: it reloads an
unchanged plan and answers `requested`. A real write is followed by exactly one
`herdr server reload-config` through `execFile` with `HERDR_BIN_PATH` (default
`herdr`), no shell, a 5 s timeout and a 4096-byte output cap; a reload failure is
reported as partial state because the config is already committed. **CAS limit:**
an edit that lands between the final compare and the `rename` cannot be detected
without holding a lock on the config, which this writer deliberately does not
do — everything earlier (snapshot, plan, backup, staging) is still caught. A
**pre-existing truncated backup** is a second documented limit: because a regular
file at that path is accepted as it is and never repaired or compared, a `.bak`
damaged by an earlier failure or another tool stays damaged.

**The guard matrix.** `applyHerdrTheme` answers `unavailable` with one reason
before it opens any file: `not-herdr` (no `HERDR_ENV=1` plus a pane id and an
absolute socket path), `child` (a subagent's Pi must never write the user's
config), `remote` (an SSH session, where Herdr reads another machine's config),
and `unsupported` (a `herdr-dev` binary, a non-Linux host, or a non-absolute
socket/config path). The follower reports `not-herdr`, `remote` and
`unsupported` as one `info` notice per session and asks again only when the
palette itself changes.

**The panel.** `/herdr-gentle:customize` reuses Gentle Shell's own card shape:
one left `CATEGORIES` list, one right pane headed `<Category> · n/m`, one line
per setting with its options inline (`●` stored, `›` cursor elsewhere, `○` the
rest). The arrows move the option cursor and only Enter applies; Enter keeps the
card open (only the Moshi reload closes it), Esc closes without a write, Tab
switches panes. A line whose options do not fit scrolls sideways behind muted
`‹`/`›` with an `n/m` counter, falling back to a compact `‹ value ›`. The
Preview block below the panes is `Preview · <option> · <title>` plus a sample
painted with the host theme, where a theme option shows that theme's own palette
through the raw SGR the host hands back. Three footer legends (categories,
option row, panes) are chosen by what the keys do right now and compact instead
of wrapping. The theme list comes from `ctx.ui.getAllThemes()` in the host's own
order with `None` first, the `Gentle Shell theme` setting is painted dim and
refused with `Turn Theme sync off to pick a specific theme.` while the sync is
on, and a host that exposes no list shows one note instead of an empty picker.
The panel writes nothing itself: it calls the extension's apply path, swaps in
the model that path re-read, and keeps the cursor by structural option ids.

**Limits** (the §10 style, none of them a promise this design makes):

- The 500 ms tick is the whole observation granularity — there is no event to
  subscribe to, so a theme change is noticed within one tick and not sooner.
- The automated evidence is a stubbed Pi host plus a real binary stand-in on
  disk; **no live Pi TUI run is recorded**. `ctx.ui.theme`, `getTheme`,
  `getAllThemes`, `notify` and the host component contract are used as
  documented, and a host missing one degrades to "nothing changed" rather than
  to a guess.
- Remote sessions are inactive: in SSH the Herdr client reads the config of the
  machine it runs on, so writing the server-side file would change nothing on
  screen and the guard refuses.
- Two writers of the same keys fight. The sync owns what it projects, so a
  desktop-theme sync and this feature overwrite each other on their next run;
  there is no merge, lock or arbitration, only the `was` comments, the marked
  block and the one-time backup.
- The compare-and-swap has one unavoidable window: an edit between the final
  compare and the rename is undetectable without a config lock, which this
  writer does not take.
- The planner is a **splicer, not a validator**: it guarantees table boundaries
  for terminated multi-line constructs and byte-identical non-theme lines (checked
  by the splice invariant), and it deliberately checks nothing outside the theme
  tables — invalid TOML there is left as it is, because Herdr already refuses
  that file. A theme-table line the plan must touch has to be the strict
  single-line form; the revert is per token, so a user-written empty
  `[theme.custom]` header and the `name` marker stay behind (a table the planner
  created is removed, so a full cycle is byte-identical).
- A pre-existing truncated backup is kept, not repaired (see above), which is why
  the `was` comments are the per-value revert path.
- There is no "full clear" distinct from an empty custom projection: a projection
  always carries the theme name, so a `name` line the planner inserted stays (an
  existing name is restored) and a `[theme]` table it created is not removed —
  only the `[theme.custom]` table it created is, once its block empties.
- Herdr's surface tokens (`sidebar_bg`, `panel_bg`, `active_row_bg`,
  `selection_bg`, `surface*`) and `peach` are not projected: Pi names
  foregrounds and accents, not panel backgrounds, so backgrounds and status
  colours stay with the Herdr base theme — except the `DOTS_FIXED` tables for
  `Gentleman-Cute`, `Gentleman-Sexy` and `Gentle`, which are the surfaces the
  user's own Herdr profiles already use.
- One machine: another Herdr client reads its own `config.toml`, so this is a
  local sync and not a fleet setting.
- No automatic repair: a `[theme]` table the user or another tool keeps editing
  is re-projected on the next palette change and never reconciled, and a document
  whose table boundaries cannot be found (an unterminated multi-line string,
  array or inline table) stops the writer until it is fixed. A missing
  `config.toml` is refused, never created.
