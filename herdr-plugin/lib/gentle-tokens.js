'use strict';

// Gentle-sidecar token contract: validation + reducer (DESIGN.md §4.3, §5).
//
// Pure module: no I/O, no Herdr calls. The daemon (bin/gentle-status.js)
// supplies snapshot entries; every function takes `now` explicitly so the
// rules stay testable without clocks.
//
// Security posture (security-and-hardening, implementation mode): every token
// shape is validated with an anchored grammar before use; the session binding
// (sha256 of the pane's agent_session path, base64url, 43 chars) must match
// exactly or the signal is dropped; malformed or foreign-session tokens fail
// closed to "no signal", never to a guessed state. Names are advisory only:
// a bad names token degrades the label to `gentle` (machine key `working`),
// never a guessed role.
// The running/queued count stays internal (gentle_work_v1) and never renders.

const { createHash } = require('node:crypto');

// DESIGN §4.3 grammars. COUNT allows "0"; WORK/CHANGES expiry fields require
// >= 1 (an expiry of 0 is never fresh, so it is rejected at parse time).
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const WORK_RE = /^([A-Za-z0-9_-]{43}):(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/;
const CHANGES_RE = /^([A-Za-z0-9_-]{43}):(0|[1-9]\d{0,15}):(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/;
// v2 keeps exact added/deleted totals separate (v1 summed them into one
// delta, which forced the single combined badge). v1 is legacy: parsed for
// backward compatibility by parseChanges, but never used for display.
const CHANGES_V2_RE =
  /^([A-Za-z0-9_-]{43}):(0|[1-9]\d{0,15}):(0|[1-9]\d{0,15}):(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/;
// Authoritative role signal (DESIGN §4.3): bounded CSV of canonical role
// slugs derived from TaskRecord.agent (never task labels), oldest-first
// by immutable first-seen, e.g. `worker,explorer` (worker oldest). The
// consumer renders the oldest recognized role word whenever the principal
// itself is not working; the label carries a count when above one. Null
// (clear) when no active recognized roles. `review` is accepted as a legacy alias of `rdd` (rollback
// producers); new producers emit `rdd`. `explore` is accepted as a legacy
// wire alias of `explorer`; the machine key stays `explorer` and the
// visible rendered word is `explorer`. `judge` is distinct from `rdd` (never collapsed).
const ROLES_TOKEN = 'gentle_roles_v1';
const ROLE_RE = /^(explorer|explore|worker|verify|judge|rdd|review)$/;
// Unknown-delegation passthrough (producer sanitizeAgentSlug mirror): a
// lowercase `[a-z0-9_-]` slug, 1–32 chars, starting alphanumerically.
// Anything else is dropped (fail-closed). The producer truncates to 32,
// so an overlong entry here is foreign/malformed, never a truncation.
const ROLE_PASSTHROUGH_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Herdr's ceiling for one pane-metadata token value, in UTF-8 BYTES: the
// producer bounds every published value against it, so an over-cap value here
// is foreign or malformed and is rejected whole (see parseRoles).
const MAX_TOKEN_BYTES = 512;
// Root-session orchestrating marker (DESIGN §4.3): `<hash>:<expiry>` — the
// same session binding and TTL discipline as gentle_work_v1 but carrying no
// count. Emitted by the root Pi session while the main session is actively
// working (agentActive, even with zero subagents), retaining coverage while
// an authoritative running|queued subagent exists or a subagent launch is
// pending; null (clear) once the main session settles. The consumer reduces
// a fresh marker to the `orchestrating` display — below attention
// (error/ask/review), terminal (done/native-blocked), a working principal,
// and a delegate role word, and above generic activity. It is not a
// principal-working signal: it stays live while the principal is idle with
// queued or running delegates.
const ORCH_TOKEN = 'gentle_orchestrating_v1';
// Principal-only activity marker (DESIGN §4.3): `<hash>:<expiry>`, the same
// session binding and TTL discipline as gentle_orchestrating_v1, emitted
// while the principal session's own agent is active and cleared once it
// settles. It is the deciding signal for working-versus-idle: Herdr's native
// status aggregates delegates (it reads `working` whenever any delegate
// runs), so using it here would paint an idle principal `gentle`. The native
// status keeps its own aggregate meaning everywhere else in this module.
const PRINCIPAL_TOKEN = 'gentle_principal_v1';
// Blocking-delegate marker (DESIGN §4.3): `<hash>:<role>:<expiry>` — one role
// word, the same session binding and TTL discipline as gentle_roles_v1.
// Emitted on every beat while a synchronous `subagent_run`/
// `subagent_continue` tool call is in flight. That call blocks the
// principal's own turn, so `gentle_principal_v1` stays fresh for the whole
// child run and would otherwise paint generic `gentle`; this marker is the
// evidence that the row shows the child's role instead. Background launches
// resolve their tool call immediately, so a running background delegate
// never publishes one and never changes the principal's own display. The
// consumer renders a fresh recognized role at role precedence: below
// attention and the terminal `done`, above the principal marker. Stale,
// foreign, malformed, or unrecognized evidence falls through to today's
// behavior (fail closed).
const PENDING_TOKEN = 'gentle_pending_v1';
const PENDING_RE = /^([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{1,32}):([1-9]\d{0,15})$/;
// Synthesized finish signal (DESIGN §4.3, S2): `<hash>:<expiry>` — the same
// session binding and absolute-expiry discipline as the presence markers,
// minted by the producer ONCE at the settled-and-empty edge (principal
// settled, no running/queued delegate, no pending launch, no live background
// job). The consumer reduces a fresh token to `done`. Since T3 the expiry is
// the UNSEEN cap, not the visible dwell: the row holds `done` until the human
// views the pane, then one `DONE_VIEW_DWELL_MS` and `idle` (the daemon owns
// that recede, because `focused` rides the snapshot it already reads), and a
// pane nobody looks at recedes at the cap. The producer clamps its override to
// the ceiling below; the consumer accepts no expiry beyond it.
const DONE_TOKEN = 'gentle_done_v1';
const FINISH_HOLD_MAX_MS = 3600000;
// The dwell between the first `focused: true` observation of a finish and the
// recede to `idle` (S6/S9). It is a consumer constant, deliberately separate
// from the producer's unseen cap: the dwell starts at the observation the
// daemon makes, the cap starts at the mint the producer stamps.
const DONE_VIEW_DWELL_MS = 5000;
// Presence-marker grammar shared by both markers above: `<hash>:<expiry>`,
// no count.
const MARKER_RE = /^([A-Za-z0-9_-]{43}):([1-9]\d{0,15})$/;
// Durable ask signal (DESIGN §4.3): `<hash>:<intentId>:<expiry>` — the same
// session binding and TTL discipline as gentle_work_v1. Emitted on every
// producer beat while ask is active (rpiv questionnaire or Gentle Shell
// choice/permission/tool legs), null (clear) when inactive. Repairs a
// missed edge-triggered `herdr:blocked` ask label: the reducer treats a
// fresh token as ask with the existing error > ask > review priority.
// Null on any grammar, binding, or freshness failure — fail closed.
const ASK_TOKEN = 'gentle_ask_v1';
const ASK_RE = /^([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{1,64}):([1-9]\d{0,15})$/;
// Durable review signal: `<hash>:<reviewId>:<expiry>` — the same session
// binding and TTL discipline as gentle_ask_v1. Emitted on every producer
// beat while effective review is active (exact review tool call in flight
// or the reserved review hook active), null (clear) the beat the last call
// resolves — NO GRACE, no timers. Reuses the sanitized reviewId episode;
// never a verdict, authority, lineage, lens, or provider result. Repairs a
// missed edge-triggered `herdr:blocked` review label: the reducer treats a
// fresh token as `review` (visible `rdd`) with the existing error > ask >
// review priority, independently of work token presence. Null on any
// grammar, binding, or freshness failure — fail closed.
const REVIEW_TOKEN = 'gentle_review_v1';
const REVIEW_RE = /^([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{1,64}):([1-9]\d{0,15})$/;
// Durable run-error signal (DESIGN §4.3): `<hash>:<code>:<expiry>` — the same
// session binding and TTL discipline as gentle_ask_v1. Emitted on every
// producer beat while the run-error leg stands (the agent run itself stopped
// on an error), null (clear) the beat it releases. This is the sidebar's only
// error carrier: the producer never claims native `blocked` for it, because
// that is what fires the host NeedsAttention toast and sound. The reducer
// treats a fresh token as `error` (row word `blocked`, silent) with the same
// error > ask > review priority the blocked-label leg uses, independently of
// work token presence. Null on any grammar, binding, or freshness failure —
// fail closed.
const ERROR_TOKEN = 'gentle_error_v1';
const ERROR_RE = /^([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{1,64}):([1-9]\d{0,15})$/;
// herdr:blocked labels, DESIGN §4.2. Id charset mirrors the producer's ID_RE.
const BLOCKED_RE = /^(ask|review|error):([A-Za-z0-9_-]{1,64})$/;
// Advisory names: printable, no CSV separators or quotes (producer strips
// \x00-\x1f\x7f-\x9f and , " \n \r, then truncates to 64 chars).
const NAME_BAD_RE = /[\x00-\x1f\x7f-\x9f",]/;

// DESIGN §3 O5 / §8: absolute expiry, 60 s horizon at write. Readers use
// `now` at read; clock skew is documented, not compensated.
const TTL_MS = 60000;

// Reduced displays, DESIGN §5.2. Activity states are the TaskStore roles
// (explorer/worker/verify/judge) plus the root-session `orchestrating`
// marker (fresh while the main session actively works, even with zero
// subagents) plus the amber `working` display, which exists only to carry a
// non-contemplated subagent's own name — it never renders the word `gentle`.
// The principal's own activity marker decides working vs idle, never the
// delegate count and never the aggregate native status: a working principal
// renders `gentle` (the pink `orchestrating` display) with or without a
// fresh root marker, and outranks a delegate role word, while an idle
// principal shows the oldest role word however many delegates run.
// Attention states (ask/review/error) outrank both and sit above the
// terminal `done`. Role labels carry the running delegate total when it
// exceeds one. No background-job display exists: a live job is pending work
// the producer keeps out of `done`, never a row state of its own.
const DISPLAYS = ['working', 'orchestrating', 'explorer', 'worker', 'verify', 'judge', 'ask', 'review', 'error', 'done', 'idle'];

const STATE_TOKENS = {
  working: 'gentle_state_working',
  orchestrating: 'gentle_state_orchestrating',
  explorer: 'gentle_state_explorer',
  worker: 'gentle_state_worker',
  verify: 'gentle_state_verify',
  judge: 'gentle_state_judge',
  ask: 'gentle_state_ask',
  review: 'gentle_state_review',
  error: 'gentle_state_error',
  done: 'gentle_state_done',
  idle: 'gentle_state_idle',
};

const TITLE_TOKENS = {
  working: 'gentle_title_working',
  orchestrating: 'gentle_title_orchestrating',
  explorer: 'gentle_title_explorer',
  worker: 'gentle_title_worker',
  verify: 'gentle_title_verify',
  judge: 'gentle_title_judge',
  ask: 'gentle_title_ask',
  review: 'gentle_title_review',
  error: 'gentle_title_error',
  done: 'gentle_title_done',
  idle: 'gentle_title_idle',
};

// Display-only agent-identity tokens (compat, DESIGN §5.3): each carries the
// snapshot's validated agent name (pi, op, codex, ...) as its value. Only
// the current display's token is non-null; the rest are null
// (presence-encoding, like state/title). The per-display agent names and the
// single AGENT_TOKEN below stay published for compatibility but are wired
// into no visible row in the current layout (native row 1 + title/changes
// row 2, DESIGN §5.3); the sweeper still clears them.
const AGENT_TOKENS = {
  working: 'gentle_agent_working',
  orchestrating: 'gentle_agent_orchestrating',
  explorer: 'gentle_agent_explorer',
  worker: 'gentle_agent_worker',
  verify: 'gentle_agent_verify',
  judge: 'gentle_agent_judge',
  ask: 'gentle_agent_ask',
  review: 'gentle_agent_review',
  error: 'gentle_agent_error',
  done: 'gentle_agent_done',
  idle: 'gentle_agent_idle',
};

const BADGE_TOKEN = 'gentle_badge'; // legacy v1 combined badge: never written, swept (see LEGACY_TOKENS).

// Dedicated current-agent token (compat, DESIGN §5.3): carries the
// snapshot's validated agent name and nothing else — never state text,
// never a count. Published and owned for compatibility but wired into no
// visible row in the current layout (row 1 is native `state_icon` +
// `workspace` + `agent`, row 2 is title + changes). Null when no validated
// name (fail-closed, never a guessed vendor).
const AGENT_TOKEN = 'gentle_agent';

// Display-only presence-encoded state icon tokens (DESIGN §5.3, legacy
// row-1 wiring): each carries the current state's glyph (native Herdr
// vocabulary: working `●`, done `✓`, blocked `?`, idle `○`; ask is also
// `?`, distinguished from blocked by state color/text)
// as its value. Only the current display's token
// is non-null; the rest are null (presence-encoding, like
// state/title/row). Superseded by the gentle_heading_* icon-only tokens
// plus the dedicated gentle_project token (structural icon/project split);
// these stay published for compatibility but are wired into no visible
// row, and the sweeper still clears them.
const ICON_TOKENS = {
  working: 'gentle_icon_working',
  orchestrating: 'gentle_icon_orchestrating',
  explorer: 'gentle_icon_explorer',
  worker: 'gentle_icon_worker',
  verify: 'gentle_icon_verify',
  judge: 'gentle_icon_judge',
  ask: 'gentle_icon_ask',
  review: 'gentle_icon_review',
  error: 'gentle_icon_error',
  done: 'gentle_icon_done',
  idle: 'gentle_icon_idle',
};

// Presence-encoded heading tokens (compat, DESIGN §5.3): the active
// `gentle_heading_*` value holds `<icon> <project>` (e.g. `● myproj`) —
// never change segments, never `·`. Published and owned for compatibility
// but wired into no visible row in the current layout (row 1 is native
// `state_icon` + `workspace` + `agent` with no custom cells and no colors).
// Only the current display's token is non-null; the rest are null
// (presence-encoding, like state/title/row).
const HEADING_TOKENS = {
  working: 'gentle_heading_working',
  orchestrating: 'gentle_heading_orchestrating',
  explorer: 'gentle_heading_explorer',
  worker: 'gentle_heading_worker',
  verify: 'gentle_heading_verify',
  judge: 'gentle_heading_judge',
  ask: 'gentle_heading_ask',
  review: 'gentle_heading_review',
  error: 'gentle_heading_error',
  done: 'gentle_heading_done',
  idle: 'gentle_heading_idle',
};

// Presence-encoded combined row tokens (compat, DESIGN §5.3): agent
// identity + state in one value, one current token only. Superseded by the
// current structural row-2 wiring (eleven `gentle_title_*` state cells plus
// three change-segment cells, no agent cell, no rules — native separators
// on row 2 are acceptable): the combined value needed a substring rule to
// recolor the state word, which cannot color identity vs state
// structurally. These stay published for compatibility but are wired into
// no visible row, and the sweeper still clears them.
// Values are built from the
// snapshot's validated agent name plus the reduced role/state label — never
// a subagent name. Role labels may carry a running-count suffix. No icon is
// wired in row 2; row 1 is native (`state_icon` carries the
// Herdr-native glyph, not plugin-controlled), so no plugin icon alignment
// is claimed.
const ROW_TOKENS = {
  working: 'gentle_row_working',
  orchestrating: 'gentle_row_orchestrating',
  explorer: 'gentle_row_explorer',
  worker: 'gentle_row_worker',
  verify: 'gentle_row_verify',
  judge: 'gentle_row_judge',
  ask: 'gentle_row_ask',
  review: 'gentle_row_review',
  error: 'gentle_row_error',
  done: 'gentle_row_done',
  idle: 'gentle_row_idle',
};

// State glyphs carried by the gentle_heading_* values (row 1) and the
// gentle_icon_* compat tokens: native Herdr vocabulary (herdr-pi-tree
// lib/state.js lead/spaceMark) — working `●`, done `✓`, blocked `?`,
// idle `○`. Every subagent role (explorer, worker, verify, judge,
// review/rdd) plus working and the root-session `orchestrating` marker uses the
// working icon `●`; only its color changes by role (`orchestrating` takes
// pink). Ask keeps
// `?` amber; error (label `blocked`) uses the native blocked `?` red —
// the two `?` glyphs stay distinguished by state color/text. The machine
// key `review` renders the user-facing word `rdd`; the machine key
// `orchestrating` renders the user-facing word `gentle`; the machine key
// `explorer` renders the user-facing word `explorer`.
const ROW_ICONS = {
  working: '●',
  orchestrating: '●',
  explorer: '●',
  worker: '●',
  verify: '●',
  judge: '●',
  ask: '?',
  review: '●',
  error: '?',
  done: '✓',
  idle: '○',
};

// User-facing words per display (DESIGN §5.3). The machine keys `review`,
// `error`, `orchestrating`, `explorer`, and `working` stay stable; their
// rendered words are `rdd`/`blocked`/`gentle`/`explorer` and, for `working`,
// the caller's label override (the subagent's own name). `working` has no
// generic word: the amber cell must never render `gentle` (S1), so a bare
// `working` display fails closed to `orchestrating` in `out`, and an override
// that resolves to a reserved word fails closed the same way in `outRole`
// (`failClosedRoleDisplay`). Role labels
// may carry a running-count suffix and never contain a subagent label.
const DISPLAY_LABELS = {
  orchestrating: 'gentle',
  explorer: 'explorer',
  worker: 'worker',
  verify: 'verify',
  judge: 'judge',
  ask: 'ask',
  review: 'rdd',
  error: 'blocked',
  done: 'done',
  idle: 'idle',
};

// Dedicated project-name token (compat, DESIGN §5.3): carries only the
// snapshot's validated workspace/group name (fallback `workspace`), never
// state text. Published and owned for compatibility but wired into no
// visible row in the current layout (row 1 is native; the workspace name
// renders via the native `workspace` token).
const PROJECT_TOKEN = 'gentle_project';

// Change tokens for the two-row sidebar layout (DESIGN §5.3):
// exact added/deleted line counts from SessionChanges evidence plus the
// behind-upstream pull marker. Each renders a compact symbol or null
// (absent) so empty segments collapse instead of showing stale counts.
// The three segment tokens are published and wired as the visible row-2
// color cells after the eleven title cells (added green `+N`, deleted red
// `-N`, pull blue `↑N`, each its own cell, no rules, never swapped).
const CHANGES_ADDED_TOKEN = 'gentle_changes_added'; // "+N" or null
const CHANGES_DELETED_TOKEN = 'gentle_changes_deleted'; // "-N" or null
const CHANGES_PULL_TOKEN = 'gentle_changes_pull'; // "↑N" behind/upstream or null
// Compact changes-summary value (compat, DESIGN §5.3): the nonempty
// `+N`/`-N`/`↑N` segments joined with single spaces (`+N -N ↑N`), or null
// when all are absent so the value collapses. Still published and owned
// but wired into no visible row: the visible row-2 change cells carry the
// same segments structurally (added/deleted/pull tokens). Inputs are
// already-validated segment strings (or empty); anything else fails closed
// to null, never a guessed count.
const CHANGES_SUMMARY_TOKEN = 'gentle_changes_summary';

// Every token name this daemon may write: 11 state + 11 title + 11 agent +
// 11 icon + 11 heading + 11 row + 1 current-agent + 1 project + 3 changes
// segments + 1 changes summary = 72, published
// chunked <= 16 per report by the daemon (DESIGN §8). The state/agent/icon/
// row/project/change-summary names stay published for compatibility; the
// visible sidebar rows wire the eleven `gentle_title_*` state tokens plus the
// three change-segment tokens (row 2: 11 state + 3 changes = 14 cells,
// each color structural with no rules); row 1 is native `state_icon` +
// `workspace` + `agent` (3 cells, no custom wiring, no plugin colors),
// each within Herdr's 16-token-per-row ceiling
// (DESIGN §5.3). The sweeper clears
// exactly these names plus LEGACY_TOKENS and nothing else (DESIGN §3 O5).
const OWNED_TOKENS = [
  ...Object.values(STATE_TOKENS),
  ...Object.values(TITLE_TOKENS),
  ...Object.values(AGENT_TOKENS),
  ...Object.values(ICON_TOKENS),
  ...Object.values(HEADING_TOKENS),
  ...Object.values(ROW_TOKENS),
  AGENT_TOKEN,
  PROJECT_TOKEN,
  CHANGES_ADDED_TOKEN,
  CHANGES_DELETED_TOKEN,
  CHANGES_PULL_TOKEN,
  CHANGES_SUMMARY_TOKEN,
];
// Retired names a previous install may have left behind. Cleared on sweep,
// never written: the v1 combined badge has no exact split, so it stays
// fail-closed (absent) rather than rendering a stale "~N". The retired
// `*_working_subs` family held the old `working (n)` count display; the role
// model (explorer/worker/verify/judge + `working`) supersedes it, so those names
// are swept to leave no orphan count row behind.
const LEGACY_TOKENS = [
  BADGE_TOKEN,
  'gentle_state_working_subs',
  'gentle_title_working_subs',
  'gentle_agent_working_subs',
  'gentle_icon_working_subs',
  'gentle_heading_working_subs',
  'gentle_row_working_subs',
];
const SWEEP_TOKENS = [...OWNED_TOKENS, ...LEGACY_TOKENS];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Expected sessionHash for a pane: base64url(sha256(agent_session path)).
// Mirrors pi-tree lib/state.js delegatedCount. Null when the session ref is
// missing or malformed — every gentle signal for that pane then fails
// closed (foreign-session protection).
function expectedSessionHash(entry) {
  const session = entry?.agent_session;
  if (!isRecord(session)) return null;
  if (session.agent !== 'pi' || session.kind !== 'path') return null;
  if (typeof session.value !== 'string' || session.value.length === 0) return null;
  const hash = createHash('sha256').update(session.value, 'utf8').digest('base64url');
  return HASH_RE.test(hash) ? hash : null;
}

function expiryFresh(expiry, now) {
  return Number.isSafeInteger(expiry) && expiry > now && expiry <= now + TTL_MS;
}

// Snapshot-provided agent identity (pi, op, codex, ...) for the
// display-only gentle_agent_* tokens. Validated charset, fail-closed to ''
// (caller emits null) — never guessed, never a vendor color. Today the
// plugin ships pi-only sidebar rows; the value still comes from the
// snapshot so other identities flow through without code changes.
const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
function parseAgentName(entry) {
  const session = entry?.agent_session;
  if (isRecord(session) && typeof session.agent === 'string' && AGENT_NAME_RE.test(session.agent)) {
    return session.agent;
  }
  if (typeof entry?.agent === 'string' && AGENT_NAME_RE.test(entry.agent)) return entry.agent;
  return '';
}

// Snapshot-provided workspace/project name for the display-only
// gentle_heading_* tokens. Validated and bounded, fail-closed to the
// literal `workspace` — taken from `entry.group` (observed live as the
// project name, e.g. `raguard` / `eventcommerce`). When group is absent the
// name is derived as a safe basename from `entry.foreground_cwd` ??
// `entry.cwd` (last path segment, sanitized, 64 chars). The Herdr
// `workspace_id` is NEVER used: it carries opaque ids (observed `wA2`), not
// project names. Never Git, never pane ids, never inferred. Control
// characters are stripped and the value truncates to 64 chars, mirroring
// the advisory-names bound; the heading value degrades to the fallback
// instead of carrying raw snapshot text.
function parseWorkspaceName(entry) {
  const group = entry?.group;
  if (typeof group === 'string') {
    const clean = group.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64);
    if (clean) return clean;
  }
  const cwd = entry?.foreground_cwd ?? entry?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    const base = cwd
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
      .replace(/[/\\]+$/g, '')
      .split(/[/\\]/)
      .pop()
      .trim()
      .slice(0, 64);
    if (base) return base;
  }
  return 'workspace';
}

// gentle_work_v1 = <hash>:<count>:<expiry>. Null on any grammar, binding,
// or freshness failure — one bad token never poisons the other signals.
function parseWork(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = WORK_RE.exec(value);
  if (!match) return null;
  const [, hash, rawCount, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const count = Number(rawCount);
  const expiry = Number(rawExpiry);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (!expiryFresh(expiry, now)) return null;
  return { count, expiry };
}

// `<hash>:<expiry>` presence marker: the same session binding and TTL
// discipline as gentle_work_v1 but carrying no count. Null on any grammar,
// binding, or freshness failure — a bad marker is no evidence at all, it
// simply falls through to the next branch.
function parseMarker(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = MARKER_RE.exec(value);
  if (!match) return null;
  const [, hash, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const expiry = Number(rawExpiry);
  if (!expiryFresh(expiry, now)) return null;
  return { expiry };
}

// gentle_orchestrating_v1 / gentle_principal_v1 = <hash>:<expiry>. Both are
// presence markers with one grammar and one failure rule, so each name keeps
// its own parser over the shared implementation.
const parseOrchestrating = parseMarker;
const parsePrincipal = parseMarker;

// gentle_pending_v1 = <hash>:<role>:<expiry>. The blocking-delegate marker:
// session-bound + TTL-fresh like gentle_work_v1, one role word. Canonical
// aliases collapse exactly like parseRoles (`review`→`rdd`,
// `explore`→`explorer`); anything else is returned verbatim and left to
// roleToDisplay, which drops unrecognized slugs. Null on any grammar,
// binding, or freshness failure — a bad marker is no evidence at all, it
// simply falls through to the branches below.
function parsePending(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = PENDING_RE.exec(value);
  if (!match) return null;
  const [, hash, rawRole, rawExpiry] = match;
  if (sessionHash === null || hash !== sessionHash) return null;
  const expiry = Number(rawExpiry);
  if (!expiryFresh(expiry, now)) return null;
  const role = rawRole === 'review' ? 'rdd' : rawRole === 'explore' ? 'explorer' : rawRole;
  return { role, expiry };
}

// gentle_done_v1 = <hash>:<expiry>. The synthesized finish signal: the same
// grammar, session binding, and fail-closed rule as the presence markers, with
// its own freshness ceiling because the hold (not the 60 s token TTL) is what
// bounds it. Null on any grammar, binding, or freshness failure — a bad token
// never asserts a finish, it simply falls through to the label legs below.
function parseDone(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = MARKER_RE.exec(value);
  if (!match) return null;
  const [, hash, rawExpiry] = match;
  if (sessionHash === null || hash !== sessionHash) return null;
  const expiry = Number(rawExpiry);
  if (!Number.isSafeInteger(expiry)) return null;
  if (expiry <= now || expiry > now + FINISH_HOLD_MAX_MS) return null;
  return { expiry };
}

// T3/S6-S9: the per-pane "done until viewed" ledger, kept by the daemon across
// frames. `previous` is the record this pane carried on the last frame, or
// undefined. The token's absolute expiry is the episode identity: the producer
// republishes one mint unchanged, so a different expiry is a NEW finish, never
// a refresh of the old one.
//
// The row holds `done` while no focus has been observed (up to the unseen cap
// the producer stamped). The first snapshot with `focused: true` starts the
// dwell; `recedeAt` is that deadline so the daemon can wake for it, and from it
// on `receded` is true and a later look changes nothing. Returns undefined when
// there is no fresh finish token to track: the caller drops the record, so a
// reactivation (token cleared) or the cap (token expired) clears the episode.
function observeDoneView(previous, entry, now = Date.now()) {
  const tokens = isRecord(entry?.tokens) ? entry.tokens : {};
  const done = parseDone(tokens[DONE_TOKEN], expectedSessionHash(entry), now);
  if (done === null) return undefined;
  if (previous === undefined || previous.expiry !== done.expiry) {
    const focusedAt = entry?.focused === true ? now : undefined;
    return {
      expiry: done.expiry,
      focusedAt,
      receded: false,
      recedeAt: focusedAt === undefined ? undefined : focusedAt + DONE_VIEW_DWELL_MS,
    };
  }
  if (previous.receded === true) return previous;
  let focusedAt = previous.focusedAt;
  if (focusedAt === undefined && entry?.focused === true) focusedAt = now;
  if (focusedAt === undefined) return previous;
  const recedeAt = focusedAt + DONE_VIEW_DWELL_MS;
  if (now >= recedeAt) {
    return { expiry: done.expiry, focusedAt, receded: true, recedeAt: undefined };
  }
  return { expiry: done.expiry, focusedAt, receded: false, recedeAt };
}

// gentle_ask_v1 = <hash>:<intentId>:<expiry>. The durable ask signal:
// session-bound + TTL-fresh like gentle_work_v1. Null on any grammar,
// binding, or freshness failure — a bad token never asserts ask, it simply
// falls through to the label legs below (fail closed).
function parseAsk(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = ASK_RE.exec(value);
  if (!match) return null;
  const [, hash, intentId, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const expiry = Number(rawExpiry);
  if (!expiryFresh(expiry, now)) return null;
  return { intentId, expiry };
}

// gentle_review_v1 = <hash>:<reviewId>:<expiry>. The durable review signal:
// session-bound + TTL-fresh like gentle_ask_v1. Null on any grammar,
// binding, or freshness failure — a bad token never asserts review, it
// simply falls through to the label legs below (fail closed). Never carries
// a verdict, authority, lineage, lens, or provider result — the reviewId is
// a sanitized correlation id only.
function parseReview(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = REVIEW_RE.exec(value);
  if (!match) return null;
  const [, hash, reviewId, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const expiry = Number(rawExpiry);
  if (!expiryFresh(expiry, now)) return null;
  return { reviewId, expiry };
}

// gentle_error_v1 = <hash>:<code>:<expiry>. The durable run-error signal:
// session-bound + TTL-fresh like gentle_ask_v1. Null on any grammar, binding,
// or freshness failure — a bad token never asserts an error, it simply falls
// through to the lower branches (fail closed). The code is the producer's
// sanitized reason slug (today only `run-failed`), never tool output.
function parseError(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = ERROR_RE.exec(value);
  if (!match) return null;
  const [, hash, code, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const expiry = Number(rawExpiry);
  if (!expiryFresh(expiry, now)) return null;
  return { code, expiry };
}

// gentle_changes_v1 = <hash>:<files>:<added+deleted>:<expiry>. Legacy:
// the summed delta cannot be split into exact +N/-N, so the consumer keeps
// this parser only for backward compatibility and never displays v1 values.
function parseChanges(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = CHANGES_RE.exec(value);
  if (!match) return null;
  const [, hash, rawFiles, rawDelta, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const files = Number(rawFiles);
  const delta = Number(rawDelta);
  const expiry = Number(rawExpiry);
  if (!Number.isSafeInteger(files) || files < 0) return null;
  if (!Number.isSafeInteger(delta) || delta < 0) return null;
  if (!expiryFresh(expiry, now)) return null;
  return { files, delta, expiry };
}

// gentle_changes_v2 = <hash>:<files>:<added>:<deleted>:<expiry>.
// The normative session-changes signal: exact added/deleted totals from
// Gentle Shell SessionChanges evidence (never git status). Null on any
// grammar, binding, or freshness failure — fail closed, never guessed.
function parseChangesV2(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = CHANGES_V2_RE.exec(value);
  if (!match) return null;
  const [, hash, rawFiles, rawAdded, rawDeleted, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const files = Number(rawFiles);
  const added = Number(rawAdded);
  const deleted = Number(rawDeleted);
  const expiry = Number(rawExpiry);
  if (!Number.isSafeInteger(files) || files < 0) return null;
  if (!Number.isSafeInteger(added) || added < 0) return null;
  if (!Number.isSafeInteger(deleted) || deleted < 0) return null;
  if (!expiryFresh(expiry, now)) return null;
  return { files, added, deleted, expiry };
}

// gentle_names_v1 = CSV of sanitized labels. Advisory + compatibility:
// the reducer no longer renders names (visible text is the roles signal
// below), but the producer still emits them and this parser stays exported
// for probes and rollback consumers. Invalid entries are dropped
// individually; a wholly unusable value yields [] (caller falls back to
// `working`).
function parseNames(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const names = [];
  for (const part of value.split(',')) {
    if (part.length === 0 || part.length > 64) continue;
    if (NAME_BAD_RE.test(part)) continue;
    if (names.includes(part)) continue;
    names.push(part);
  }
  return names;
}

// gentle_roles_v1 = CSV of role words (DESIGN §4.3), oldest-first by
// immutable first-seen. Known slugs canonicalize (`review`→`rdd`,
// `explore`→`explorer`); unknown entries matching the passthrough slug rule
// are kept verbatim so the delegation's original sanitized name renders —
// never collapsed to a generic word. Anything else is dropped individually
// and a wholly unusable value yields [] (caller falls back to `gentle`,
// machine key `working`). Overlong values fail closed to [] — a truncated
// CSV would misorder oldest-first priority, so it is dropped whole rather
// than guessed.
function parseRoles(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  if (Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES) return [];
  const roles = [];
  for (const part of value.split(',')) {
    let role;
    if (ROLE_RE.test(part)) {
      role = part === 'review' ? 'rdd' : part === 'explore' ? 'explorer' : part;
    } else if (ROLE_PASSTHROUGH_RE.test(part)) {
      role = part;
    } else {
      continue;
    }
    if (roles.includes(role)) continue;
    roles.push(role);
  }
  return roles;
}

// Canonical role word -> machine display key. `rdd` (and its legacy alias)
// collapses onto the stable `review` display key, whose user-facing word is
// `rdd` (DISPLAY_LABELS); `judge` stays distinct (never rdd/review);
// activity roles map 1:1. A passthrough slug routes to the `working` machine
// key — the title cell then carries the slug itself via the caller's label
// override (visible name, never a generic word). Null for anything else
// (fail-closed: the caller falls through to `gentle`).
function roleToDisplay(role) {
  if (role === 'rdd' || role === 'review') return 'review';
  if (role === 'explorer' || role === 'explore') return 'explorer';
  if (role === 'worker' || role === 'verify' || role === 'judge') return role;
  // The bare visible words `working`, `subagent`, and `gentle` are banned: a
  // passthrough slug exactly equal to one of them (foreign or legacy wire)
  // degrades to null so the caller falls through to generic `gentle` instead
  // of rendering it on the amber cell. `subagent` is the producer's
  // launch-correlation placeholder, never an agent name, so a legacy wire value
  // must not become the row label, and `gentle` is the pink generic's own word
  // (S1): it may only ever render on the pink `orchestrating` display.
  if (role === 'working' || role === 'subagent' || role === 'gentle') return null;
  if (typeof role === 'string' && ROLE_PASSTHROUGH_RE.test(role)) return 'working';
  return null;
}

// Fail-closed role-label guard (S1/S5): the amber `working` cell renders the
// caller's label override — a delegate's own name — and nothing else. An
// override that resolves to a reserved word has no name to show: `gentle` is
// the pink generic's word (S1 allows exactly one, and it is not this one) and
// `working` is the bare machine word the amber cell must never render. Both
// degrade to the pink `orchestrating` display, exactly like a bare `working`
// display does in `out`.
const RESERVED_LABELS = new Set(['gentle', 'working']);
function failClosedRoleDisplay(display, label) {
  return RESERVED_LABELS.has(label) ? 'orchestrating' : display;
}

// Fail-closed display guard (S1): the amber `working` machine key exists only
// to carry a resolvable subagent name through `outRole`'s label override. A
// bare `working` display has no name to show, so it degrades to the pink
// generic `orchestrating` instead of resurrecting a generic word on the amber
// cell. Every other display passes through unchanged.
function failClosedDisplay(display) {
  return display === 'working' ? 'orchestrating' : display;
}

// Strongest fresh blocked label wins: error > ask > review (DESIGN §5.2).
// Reads the snapshot's state_labels map (populated from pane.report_agent
// `message`, which the managed herdr-agent-state.ts sets to the
// `herdr:blocked` label). Foreign values that miss the grammar are ignored.
function parseBlockedLabel(stateLabels) {
  if (!isRecord(stateLabels)) return null;
  let found = null;
  const rank = { error: 0, ask: 1, review: 2 };
  for (const value of Object.values(stateLabels)) {
    if (typeof value !== 'string') continue;
    const match = BLOCKED_RE.exec(value);
    if (!match) continue;
    const [, kind, id] = match;
    if (found === null || rank[kind] < rank[found.kind]) found = { kind, id };
  }
  return found;
}

// DESIGN §3 O1 single-writer handoff: a pane pi-tree owns is never written.
// pi-tree claims a pane with a FRESH pi_subagents_work_v1 (same grammar and
// session binding we enforce on our own tokens) or with presence-encoded
// pi-tree-DISTINCTIVE state/title display tokens. Bare `state_idle` /
// `title_idle` are EXCLUDED: Herdr's native sidebar publishes those names on
// every ordinary pane (observed live 2026-09-19: pi-tree disabled, tokens
// cleared at unconfigure, yet state_idle/title_idle present), so treating
// them as foreign ownership bricks the plugin on all normal panes. Stale
// foreign work tokens do NOT claim the pane (TTL wins, O5). Any other
// lingering distinctive foreign presence still claims it — that residue is a
// handover-verification item, and yielding stays the fail-safe direction.
const PITREE_DISTINCTIVE = new Set([
  'state_working',
  'state_done',
  'state_blocked',
  'state_idle_fresh',
  'state_idle_stale',
  'state_unknown',
  'title_working',
  'title_done',
  'title_blocked',
  'title_idle_fresh',
  'title_idle_stale',
  'title_unknown',
]);
function piTreeOwnsPane(tokens, sessionHash, now) {
  const foreign = tokens.pi_subagents_work_v1;
  if (typeof foreign === 'string' && parseWork(foreign, sessionHash, now) !== null) return true;
  // Ungrammatical-but-present foreign work tokens are ignored (read-only,
  // never deleted, never parsed for state).
  for (const name of Object.keys(tokens)) {
    if (PITREE_DISTINCTIVE.has(name)) return true;
  }
  return false;
}

// Reducer, DESIGN §5.2. First match wins:
//   error > ask > review > done (terminal) >
//   blocking pending delegate role (fresh `gentle_pending_v1` with a
//   recognized role: the principal's turn is blocked on that child) >
//   principal working (fresh `gentle_principal_v1`: the pink `orchestrating`
//   display, with or without a fresh root marker) > role activity (oldest
//   recognized role — the principal is not working) > orchestrating (marker
//   fallback) > generic activity from a positive running count with no role
//   word (pink `orchestrating`) > idle (including a live count-0 beat whose
//   native status is neither done nor idle). The amber `working` display has
//   exactly one producer, the passthrough name path below. The
//   deciding signal is the principal's own activity marker, never the delegate
//   count and never the aggregate native status; role labels carry the running
//   count as a suffix when above one.
// `notify` is set only for ask (DESIGN §7; review/error stay silent). The
// error leg has two carriers — a fresh `gentle_error_v1` durable token and the
// `error:` blocked label — sharing that one priority, so the sidebar still
// shows a stopped run when the label edge never reached state_labels.
// A native `blocked` with no fresh gentle label clears our family (fail
// closed): the block belongs to another writer or the producer died, so we
// must not paint `working` over it — native attention still fires.
function reducePane(entry, now = Date.now()) {
  const tokens = isRecord(entry?.tokens) ? entry.tokens : {};
  const native = typeof entry?.agent_status === 'string' ? entry.agent_status : 'unknown';
  const sessionHash = expectedSessionHash(entry);
  const agent = parseAgentName(entry);
  const workspace = parseWorkspaceName(entry);
  const idle = { display: 'idle', label: 'idle', agent, workspace, added: '', deleted: '', pull: '', notify: null };

  if (piTreeOwnsPane(tokens, sessionHash, now)) return { ...idle, owned: false };

  const work = sessionHash === null ? null : parseWork(tokens.gentle_work_v1, sessionHash, now);
  // Normative changes signal is v2 (exact added/deleted). A v1-only pane
  // stays fail-closed: no change tokens, never a guessed split.
  const changes = sessionHash === null ? null : parseChangesV2(tokens.gentle_changes_v2, sessionHash, now);
  const added = changes !== null && changes.added > 0 ? `+${changes.added}` : '';
  const deleted = changes !== null && changes.deleted > 0 ? `-${changes.deleted}` : '';
  // Blocked labels are fresh iff the producer beat is alive (full-state
  // snapshots every beat carry a fresh work token while the session lives).
  const blocked = work === null ? null : parseBlockedLabel(entry?.state_labels);
  // Durable ask-token repair: fresh iff its own session binding and TTL
  // hold (parseAsk). Independent of the work-token gate above on purpose —
  // the token IS the ask liveness proxy, so a missed label edge cannot
  // suppress it while the producer beat is alive.
  const askToken = sessionHash === null ? null : parseAsk(tokens[ASK_TOKEN], sessionHash, now);
  // Durable review-token repair: fresh iff its own session binding and TTL
  // hold (parseReview). Independent of the work-token gate on purpose —
  // the token IS the review liveness proxy, so a missed `review:` label
  // edge cannot suppress it while the producer beat is alive, and the
  // review display no longer depends on work token presence. Stale,
  // foreign, or malformed tokens fail closed (null) above.
  const reviewToken = sessionHash === null ? null : parseReview(tokens[REVIEW_TOKEN], sessionHash, now);
  // Durable run-error-token repair: fresh iff its own session binding and TTL
  // hold (parseError). Independent of the work-token gate and of the
  // blocked-label leg on purpose — the token IS the error liveness proxy, so
  // a missed label edge (or a beat that never reached state_labels) cannot
  // hide a stopped run. Stale, foreign, or malformed tokens fail closed.
  const errorToken = sessionHash === null ? null : parseError(tokens[ERROR_TOKEN], sessionHash, now);
  // Synthesized finish signal (S2/D2): the producer mints it at the
  // settled-and-empty edge, so a fresh token is the ONLY reachable `done`
  // evidence in practice — the host never reports `agent_status === 'done'`.
  const done = sessionHash === null ? null : parseDone(tokens[DONE_TOKEN], sessionHash, now);

  const out = (display, notify = null) => {
    const resolved = failClosedDisplay(display);
    return {
      display: resolved,
      label: DISPLAY_LABELS[resolved] ?? resolved,
      agent,
      workspace,
      added,
      deleted,
      pull: '', // filled by the daemon from branch-ab status (DESIGN §5.3)
      notify,
      owned: true,
    };
  };

  // Role labels carry the total running-delegate count when above one.
  // The label rides the title cell via displayTokens. The label resolves
  // fail-closed first (`failClosedRoleDisplay`): a reserved word is no name,
  // so the row degrades to the pink generic instead of painting it on the
  // amber cell — with or without the count suffix.
  const outRole = (display, labelOverride = null, notify = null) => {
    const base = labelOverride ?? DISPLAY_LABELS[display] ?? display;
    const resolved = failClosedRoleDisplay(display, base);
    if (resolved !== display) return out(resolved, notify);
    return {
      display,
      label: `${base}${work !== null && work.count > 1 ? ` (${work.count})` : ''}`,
      agent,
      workspace,
      added,
      deleted,
      pull: '',
      notify,
      owned: true,
    };
  };
  const roles = parseRoles(tokens[ROLES_TOKEN]);
  const hasDelegatedReview = roles.some((role) => role === 'rdd' || role === 'review');

  if (blocked !== null && blocked.kind === 'error') {
    // The sidebar-facing words for error/review/orchestrating are
    // `blocked`/`rdd`/`gentle`; the machine keys stay
    // `error`/`review`/`orchestrating` (DISPLAY_LABELS). The `error:` label
    // itself is silent — native attention is raised only by a native
    // `blocked`, which the producer never claims for an error.
    return out('error');
  }
  // Durable run-error repair: a fresh session-bound gentle_error_v1 asserts
  // `error` (row word `blocked`, silent — no notify) on its own TTL, checked
  // before the ask/review legs below so the durable token and the label share
  // one precedence: error > ask > review.
  if (errorToken !== null) return out('error');
  if (blocked !== null) {
    if (blocked.kind === 'ask') {
      return out('ask', { sessionHash, intentId: blocked.id, expiry: work.expiry });
    }
    // A fresh durable ask token still asserts ask against a review label
    // (error > ask > review holds — error already returned above).
    if (askToken !== null) {
      return out('ask', { sessionHash, intentId: askToken.intentId, expiry: askToken.expiry });
    }
    // Only a delegated review may display the running-delegate count.
    return hasDelegatedReview ? outRole('review') : out('review');
  }
  // Edge-miss repair: the producer kept publishing work/orchestrating beats
  // but the `herdr:blocked` ask edge never reached state_labels. A fresh
  // session-bound gentle_ask_v1 asserts ask on its own TTL; stale, foreign,
  // or malformed tokens fail closed (askToken null) above.
  if (askToken !== null) {
    return out('ask', { sessionHash, intentId: askToken.intentId, expiry: askToken.expiry });
  }
  // Edge-miss repair for review (mirrors the ask repair above): a fresh
  // session-bound gentle_review_v1 asserts `review` (visible `rdd`, silent
  // — no notify) on its own TTL, independently of work token presence.
  // Priority holds: error and ask (label or durable token) already returned
  // above; roles, the marker, and main working all rank below.
  // NO GRACE on this side either: a cleared/expired token simply stops
  // asserting review on the next frame.
  if (reviewToken !== null) return hasDelegatedReview ? outRole('review') : out('review');
  if (native === 'blocked') return out('idle');
  // Marker computed once, before the terminal gate: a session-bound fresh
  // marker is live activity evidence (it covers running/queued subs and
  // pending launches — the count alone excludes queued). Stale, malformed,
  // or foreign markers parse to null and veto nothing (fail closed).
  const orchestrating =
    work === null ? null : parseMarker(tokens[ORCH_TOKEN], sessionHash, now);
  // Principal-only activity: its own fresh marker decides working vs idle.
  // The native status cannot: the producer's computeNativeState aggregates
  // delegate activity, so it reads `working` for an idle principal with a
  // running delegate.
  const principal =
    sessionHash === null ? null : parseMarker(tokens[PRINCIPAL_TOKEN], sessionHash, now);
  // Blocking-delegate role: a synchronous launch keeps the principal's own
  // agent active for the whole child run, so the principal marker above would
  // paint generic `gentle` while the child works. The marker is its own
  // liveness proxy (like the ask/review/error tokens), so it needs no work
  // token present; it renders through the same role helpers as every other
  // role row, and its role word is validated exactly like a roles entry, so
  // unrecognized evidence falls through instead of guessing.
  const pending =
    sessionHash === null ? null : parsePending(tokens[PENDING_TOKEN], sessionHash, now);
  // Terminal `done` NEVER outranks live evidence: the principal Pi session
  // may settle while background delegates run, and that is NOT terminal.
  // Done requires settled-plus-empty — a fresh native done OR the producer's
  // fresh finish token (the reachable path, §4.3: the host never emits `done`)
  // plus a fresh count 0 (no running delegates) plus no role evidence (a fresh
  // role-only pending hint means a launch is still pending) plus no fresh
  // marker (which covers queued subs the running-only count excludes) plus no
  // working principal. Anything else falls through to the principal-state and
  // role branches below; without a fresh work token the settle is either
  // ancient or was never observed here — both fall through to idle (native
  // fallback, O5). This claims no positive settled proof beyond the existing
  // TTL/freshness discipline: it only refuses terminal while live evidence is
  // fresh. The finish token expires by design, so `done` yields to `idle`
  // after the hold instead of sticking.
  if (
    (native === 'done' || done !== null) &&
    work !== null &&
    work.count === 0 &&
    roles.length === 0 &&
    orchestrating === null &&
    principal === null
  ) {
    return out('done');
  }
  // The principal's own activity decides, never the delegate count: a
  // working principal renders the session's own pink generic `gentle`, which
  // outranks every delegate role word. The display is always `orchestrating`:
  // a fresh root marker does not change the color, and absent, stale, or
  // foreign markers must not fall back to the amber generic either.
  // WHY not the count: `gentle_work_v1` counts RUNNING DELEGATES, so a
  // positive count says nothing about the principal — gating on it would
  // turn an idle principal with running delegates into `gentle` instead of
  // its delegate role word. WHY not the native status: it aggregates the
  // same delegate activity (running delegates, pending launches), so
  // an idle principal with a running explorer would read `gentle` too. The
  // marker is no substitute either: it stays live while the principal is
  // idle with queued or running delegates.
  // EXCEPTION, checked first: a synchronous launch blocks the principal's own
  // turn. The principal marker is legitimately fresh for the whole child run,
  // but the session is executing a tool call and waiting on the child, not
  // doing its own model work — so the child's role decides the row. Attention
  // and the terminal `done` gate already returned above; a background delegate
  // publishes no marker, so it changes nothing here.
  if (pending !== null) {
    const display = roleToDisplay(pending.role);
    if (display !== null) {
      if (display === 'working') return outRole(display, pending.role);
      return outRole(display);
    }
  }
  if (principal !== null) {
    return out('orchestrating');
  }
  // Principal not working: the oldest role word wins, however many delegates
  // run. Visible text is the oldest role (oldest-first): known agents render
  // their short word, unknown delegations their sanitized passthrough slug
  // (label override on the `working` machine key — never a generic word). The
  // role hint may also arrive at count 0 — the pending `subagent_run` tool
  // call is in flight with no TaskStore record yet. An unrecognized shape
  // falls through to generic activity below.
  if (work !== null) {
    for (const role of roles) {
      const display = roleToDisplay(role);
      if (display === null) continue;
      if (display === 'working') return outRole(display, role);
      return outRole(display);
    }
  }
  // Root marker fallback: fresh while the main session works or while a
  // queued/running sub or a pending launch exists, so it keeps covering
  // queued subs the running-only count excludes once no role word is left.
  if (orchestrating !== null) return out('orchestrating');
  // Generic activity from a positive running count with no resolvable name
  // (S5): the fallback is the principal session's pink generic `gentle`, never
  // a delegate `gentle` on the amber cell.
  if (work !== null && work.count > 0) return out('orchestrating');
  // A live count-0 work-token beat whose native status is neither done nor
  // idle used to read generic activity; the producer's unsettled beat made
  // that pin `gentle` on an idle session (S2), so it no longer asserts
  // activity and falls through to the terminal `idle` below.
  return out('idle');
}

// Icon value for one display: the state glyph for the gentle_icon_*
// presence-encoded token. Null for any unknown display (fail-closed).
function iconValueFor(display) {
  const icon = ROW_ICONS[display];
  return typeof icon === 'string' ? icon : null;
}

// Heading value for one display: `<icon> <project>` only (e.g.
// `● myproj`). Compat output for the published-but-unwired
// `gentle_heading_*` family (current layout wires no heading cell; row 1
// is native). The project is
// the snapshot's validated workspace/group name (fallback `workspace` via
// projectValueFor); change segments never render here — they ride the
// row-2 change cells. The value carries no `·` and no segments. Extra args
// beyond workspace are accepted for caller compatibility and ignored.
// Null for any unknown display (fail-closed).
function headingValueFor(display, workspace) {
  const icon = ROW_ICONS[display];
  if (typeof icon !== 'string') return null;
  return `${icon} ${projectValueFor(workspace)}`;
}

// Project value for the dedicated `gentle_project` token: the snapshot's
// validated workspace/group name, or the literal `workspace` fallback —
// never empty, never a guessed name. Carries identity only, never state.
function projectValueFor(workspace) {
  return typeof workspace === 'string' && workspace.length > 0 ? workspace : 'workspace';
}

// Compact changes-summary value: the nonempty `+N`/`-N`/`↑N` segments
// joined with single spaces (`+N -N ↑N`), or null when all are absent so
// the cell collapses. One token means one Herdr cell. Inputs are already-validated segment strings
// (or empty); anything else fails closed to null, never a guessed count.
function changesSummaryValue(added, deleted, pull) {
  const parts = [];
  for (const part of [added, deleted, pull]) {
    if (typeof part === 'string' && part.length > 0) parts.push(part);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

// Current-agent value for the dedicated gentle_agent token: the
// snapshot's validated agent name, or null when absent (fail-closed — the
// cell collapses, never a guessed vendor). Carries identity only, never
// state text: state renders in the sibling gentle_title_* cell.
function agentValueFor(agent) {
  return typeof agent === 'string' && agent.length > 0 ? agent : null;
}

// Combined visible-row value for one display: `<agent> · <label>`
// from the snapshot's validated agent name and the reduced role/state label
// (role words like `worker`, never a subagent label, optionally with a
// running-count suffix). With no
// validated agent name the value degrades to `<label>` — never a
// guessed vendor. No icon: the state glyph renders in the row-1
// gentle_heading_* token. Null for any unknown display (fail-closed).
function rowValueFor(display, agent, label) {
  if (!ROW_ICONS[display] || typeof label !== 'string' || label.length === 0) return null;
  if (typeof agent === 'string' && agent.length > 0) return `${agent} · ${label}`;
  return `${label}`;
}

// Full publish family for a reduced pane: the current state/title/agent/
// icon/heading names carry values, every other owned name is null
// (presence-encoding: a stale name left behind would render beside the
// current one). State values carry the machine key, title values the
// user-facing word (`rdd` for `review`, `blocked` for `error`, `gentle`
// for `orchestrating`, `explorer` for `explorer`), agent values the snapshot's validated agent name (only the
// current display's agent token is non-null — compat output, wired into no
// visible row), icon values the state glyph (compat only —
// wired into no visible row), heading values the `<icon> <project>`
// compat value (only the current display's heading token is non-null;
// published but wired into no visible row — row 1 is native `state_icon`
// + `workspace` + `agent` with no custom cells and no plugin colors);
// the dedicated `gentle_project`
// token carries the validated workspace name (compat output, wired into no
// visible row) and the dedicated `gentle_agent`
// token carries the validated agent name (compat output, wired into no
// visible row in the current layout — row 2 carries title + changes with
// no agent cell) and the combined gentle_row_* token for
// the current display carries `<agent> · <label>` (compat output, wired
// into no visible row — only the eleven `gentle_title_*` state cells plus the
// three change-segment cells are visibly wired, DESIGN §5.3);
// the change segment tokens ride as the visible row-2 color cells after
// the eleven title cells (green
// `+N`, red `-N`, blue `↑N`, each its own cell with no rules, never
// swapped) and the
// `gentle_changes_summary` token carries the space-joined nonempty
// segments (compat output, wired into no visible row),
// so state and session changes stay independently observable (DESIGN §3
// O4 — never ↳, never merged, never the combined v1 badge). `result.pull`
// is the daemon-resolved behind-upstream marker ("↑N" or empty);
// stale/invalid input yields nulls (fail-closed), never held values.
function displayTokens(result) {
  const patch = {};
  for (const display of DISPLAYS) {
    patch[STATE_TOKENS[display]] = display === result.display ? display : null;
    patch[TITLE_TOKENS[display]] = display === result.display ? result.label : null;
    patch[AGENT_TOKENS[display]] = display === result.display && result.agent ? result.agent : null;
  }
  patch[CHANGES_ADDED_TOKEN] = result.added || null;
  patch[CHANGES_DELETED_TOKEN] = result.deleted || null;
  patch[CHANGES_PULL_TOKEN] = result.pull || null;
  patch[CHANGES_SUMMARY_TOKEN] = changesSummaryValue(result.added, result.deleted, result.pull);
  for (const display of DISPLAYS) {
    patch[ICON_TOKENS[display]] =
      display === result.display ? iconValueFor(display) : null;
  }
  for (const display of DISPLAYS) {
    patch[HEADING_TOKENS[display]] =
      display === result.display ? headingValueFor(display, result.workspace) : null;
  }
  for (const display of DISPLAYS) {
    patch[ROW_TOKENS[display]] =
      display === result.display ? rowValueFor(display, result.agent, result.label) : null;
  }
  patch[AGENT_TOKEN] = agentValueFor(result.agent);
  patch[PROJECT_TOKEN] = projectValueFor(result.workspace);
  return patch;
}

module.exports = {
  TTL_MS,
  DISPLAYS,
  DISPLAY_LABELS,
  ROLES_TOKEN,
  ORCH_TOKEN,
  PRINCIPAL_TOKEN,
  PENDING_TOKEN,
  ASK_TOKEN,
  REVIEW_TOKEN,
  ERROR_TOKEN,
  DONE_TOKEN,
  FINISH_HOLD_MAX_MS,
  DONE_VIEW_DWELL_MS,
  STATE_TOKENS,
  TITLE_TOKENS,
  AGENT_TOKENS,
  AGENT_TOKEN,
  PROJECT_TOKEN,
  ICON_TOKENS,
  HEADING_TOKENS,
  ROW_TOKENS,
  ROW_ICONS,
  failClosedDisplay,
  failClosedRoleDisplay,
  BADGE_TOKEN,
  CHANGES_ADDED_TOKEN,
  CHANGES_DELETED_TOKEN,
  CHANGES_PULL_TOKEN,
  CHANGES_SUMMARY_TOKEN,
  OWNED_TOKENS,
  LEGACY_TOKENS,
  SWEEP_TOKENS,
  expectedSessionHash,
  parseWork,
  parseChanges,
  parseChangesV2,
  parseNames,
  parseRoles,
  parseOrchestrating,
  parsePrincipal,
  parsePending,
  parseAsk,
  parseReview,
  parseError,
  parseDone,
  observeDoneView,
  roleToDisplay,
  parseBlockedLabel,
  parseAgentName,
  parseWorkspaceName,
  piTreeOwnsPane,
  reducePane,
  iconValueFor,
  headingValueFor,
  projectValueFor,
  changesSummaryValue,
  agentValueFor,
  rowValueFor,
  displayTokens,
};
