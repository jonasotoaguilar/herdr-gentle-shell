// gentle-herdr-state.ts — Gentle Herdr producer sidecar (Pi extension).
//
// Publishes Gentle session facts as Herdr pane-metadata tokens plus
// namespaced `herdr:blocked` labels, for the herdr-gentle-agents consumer
// daemon (task 7) to reduce into sidebar state. Ships ALONGSIDE the
// managed-by-herdr sidecar `herdr-agent-state.ts` (HERDR_INTEGRATION_ID=pi,
// v9); never modifies, reinstalls, or imports it.
//
// DESIGN.md §4 producer contract (abridged, normative details there):
//   source id `gentle:v1`; sessionHash = base64url(sha256(agent_session path))
//   (43 chars, same derivation as herdr-pi-tree so pane correlation matches
//   without reusing its tokens); every token carries absolute expiry with
//   `expiry <= now + 60000`; writes are idempotent full-state snapshots per
//   beat (at-least-once, no ack; a lost beat is repaired by the next one);
//   ≤ 16 tokens per report; counts are normative, names advisory.
//
// Tokens (§4.3):
//   gentle_work_v1    = <hash>:<count>:<expiry>
//                       (normative running total — only `running` counts as
//                       executing; queued/waiting/pending never count. The
//                       consumer renders the oldest running role plus this
//                       total in parentheses only when above one.)
//   gentle_roles_v1   = CSV of canonical role slugs from TaskRecord.agent
//                       (oldest-first by immutable firstSeen, e.g.
//                       `worker,explorer` with worker oldest; null /
//                       clear when no active recognized roles). Authoritative
//                       for the visible activity state: explorer / worker /
//                       verify / judge / rdd (review agents) collapse to the
//                       sidebar role; unrecognized agents fall back to
//                       `working`.
//   gentle_orchestrating_v1 = <hash>:<expiry>
//                       (root-session marker, session-bound + TTL-fresh like
//                       gentle_work_v1 but carrying no count: emitted only by
//                       the root Pi session (rootSession) while the main
//                       session is actively working (agentActive, even with
//                       zero subagents) or an authoritative running|queued
//                       TaskStore subagent exists or a
//                       subagent_run/subagent_continue launch is pending;
//                       null / clear once the main session settles (or any
//                       non-root session). Never alters the authoritative
//                       work count or the roles CSV.)
//   gentle_principal_v1 = <hash>:<expiry>
//                       (principal-only activity marker, same session binding
//                       and TTL discipline as gentle_orchestrating_v1 but
//                       carrying no count: emitted while THIS session's own
//                       agent is active (agentActive) — the principal input
//                       of computeNativeState, never its delegate aggregate
//                       — and null / clear once the principal settles, so an
//                       idle principal with running delegates never looks
//                       busy. The consumer uses it for the working-vs-idle
//                       decision; the aggregate native status keeps its own
//                       meaning. Never alters the work count or roles CSV.)
//   gentle_pending_v1 = <hash>:<role>:<expiry>
//                       (blocking-delegate marker, session-bound + TTL-fresh
//                       like gentle_work_v1: the role word of the oldest
//                       in-flight `subagent_run`/`subagent_continue` call,
//                       republished on every beat while the call blocks, null
//                       / clear the beat it settles, the agent settles, or
//                       the session resets. A synchronous launch blocks the
//                       principal's own turn, so agentActive stays true and
//                       the principal marker would paint generic `gentle`
//                       while the child runs; this marker is the evidence
//                       that the row must show the child's role instead.
//                       Background launches resolve their tool call
//                       immediately, so they never leave a marker: a running
//                       background delegate never changes the principal's
//                       own display. Never alters the work count or roles
//                       CSV.)
//   gentle_changes_v2 = <hash>:<files>:<added>:<deleted>:<expiry>
//                       (normative; exact added/deleted totals kept separate)
//   gentle_changes_v1 = <hash>:<files>:<added+deleted>:<expiry>
//                       (dual-emitted for rollback consumers only)
//   gentle_names_v1   = CSV of TaskRecord.label/agent (sanitized, ≤64 chars
//                       each, oldest-first, total ≤ 512 UTF-8 BYTES; excess
//                       advisory names are dropped whole, never chunked — the
//                       §4.5 #p= overflow form never triggers by construction;
//                       a record whose label and agent are both absent has no
//                       identity to publish and is skipped, never replaced by a
//                       placeholder or a stringified absent value)
//                       Compatibility transport only: the consumer renders
//                       roles, never names. Null (clear) when the active
//                       TaskStore list has no names; null change tokens when the session model has
//                       zero changed files — refreshed/cleared from the live
//                       session model, never carried across sessions.
//   gentle_ask_v1         = <hash>:<intentId>:<expiry>
//                       (durable ask signal, session-bound + TTL-fresh like
//                       gentle_orchestrating_v1: emitted on every beat while
//                       ask is active (rpiv questionnaire, Gentle Shell
//                       choice, permission, or in-flight ask tool calls),
//                       null / clear when inactive. Repairs a missed
//                       edge-triggered `herdr:blocked` ask label; the
//                       consumer reduces a fresh token to `ask` with the
//                       existing error > ask > review priority.)
//   gentle_review_v1      = <hash>:<reviewId>:<expiry>
//                       (durable review signal, session-bound + TTL-fresh
//                       like gentle_ask_v1: emitted on every beat while
//                       effective review is active (an exact review tool
//                       call in flight or the reserved review hook active),
//                       null / clear the beat the last call resolves — NO
//                       GRACE, no timers, no agent_settled holds. Reuses
//                       the sanitized reviewId episode; never a verdict,
//                       authority, lineage, lens, or provider result.
//                       Repairs a missed edge-triggered `herdr:blocked`
//                       review label; the consumer reduces a fresh token to
//                       `review` (visible `rdd`) with the existing error >
//                       ask > review priority, independently of work token
//                       presence.)
//   herdr:blocked     = "ask:" intentId / "review:" reviewId / "error:" code
//                       (single effective label, priority error > ask >
//                       review, edge-triggered so the native counter in
//                       herdr-agent-state.ts stays balanced)
//   gentle_error_v1       = <hash>:<code>:<expiry>
//                       (durable run-error signal, session-bound + TTL-fresh
//                       like gentle_ask_v1: emitted on every beat while the
//                       run-error leg stands, null / clear the beat it
//                       releases. It is the sidebar's ONLY error carrier —
//                       the native pane report never claims `blocked`, so an
//                       error raises no host NeedsAttention toast or sound
//                       and sends no phone envelope. The consumer reduces a
//                       fresh token to `error` (row word `blocked`) with the
//                       same error > ask > review priority the label leg
//                       uses, independently of work token presence.)
//
// Event seams (all in-process; this extension imports nothing from
// gentle-shell — DESIGN §10 U6 source pin is unresolved, so the producer is
// self-contained and observes only the Pi extension API):
//   subagent activity : structured details.gentleAgents
//                       {taskId,agent,status,mode} from subagent_*
//                       tool_results (authoritative TaskStore projection;
//                       active = running|queued per §4.2) plus background
//                       Gentle Agents lifecycle as custom messages
//                       (customType `gentle-agents.result`,
//                       details.gentleAgents {taskId,agent,status}) observed
//                       via `message_end`: ACTIVE statuses
//                       (running|queued) promote a background start into the
//                       task record, and Final statuses
//                       (completed|failed|cancelled|timed_out) replace the
//                       task record so the next beat counts only
//                       running|queued as active; the rendered card is never
//                       parsed. Pending subagent
//                       tool calls are label correlation only for a later
//                       gentleAgents.taskId result and never count.
//   ask               : ASK_USER_CHOICE_BLOCKED_EVENT (choice) +
//                       gentle-pi:ask-user-question:blocked (native
//                       questionnaire) + rpiv:ask-user:blocked (legacy
//                       questionnaire) — three independent legs sharing one
//                       intent episode, so closing one never erases another —
//                       +
//                       pi-permission-system:permission-request waiting state
//                       (tool-gated confirmation leg) + direct in-process
//                       `tool_execution_start` opens / `tool_execution_end`
//                       / `tool_result` closes for the exact Pi tools
//                       `ask_user_question` and `ask_user_choice`, tracked by
//                       toolCallId in a call-id set (a `tool_call` proposal
//                       alone never opens; an abort/error end with no result
//                       still closes). One intentId minted per
//                       ¬ask→ask episode; stable across beats in the episode.
//                       `gentle_review` starts (any operation, incl.
//                       ordinary-mode `start` / `select-intended-untracked`)
//                       never enter ask: the old consent-eligible pending
//                       signal fired before any outcome/UI, so a pre-granted
//                       session read blocked with no actual prompt. Only a
//                       real prompt leg (event, permission, structured tool,
//                       or in-flight UI span) holds ask.
//                       Generic Pi `ui_prompt_start` / `ui_prompt_end` spans
//                       gated on in-flight `tool_execution_start` /
//                       `tool_execution_end` (installed herdr-pi-tree
//                       herdr-prompt-state pattern): a prompt contributes to
//                       ask only when it opens while at least one tool
//                       execution is active, so commands/widgets that prompt
//                       while idle never become ask; nested/duplicate
//                       lifecycle coalesces into one boolean leg.
//                       Boundary: this leg observes only what Pi emits as a
//                       `tool_execution_start` event in this root extension.
//                       A host-side ask UI that emits no execution for those names
//                       is not observable here and stays covered only by the
//                       event-based legs above; no host-tool observation is
//                       claimed beyond the emitted events.
//   review            : ACKNOWLEDGED `gentle_review_capture` /
//                       `gentle_review_capture_group` EXECUTION, tracked by
//                       toolCallId from `tool_execution_start` (actual
//                       execution — a `tool_call` proposal alone never
//                       opens) to `tool_execution_end` / `tool_result`
//                       (thrown / cancelled / error closes clear on this
//                       beat — zero grace, per-id overlap). Acknowledged
//                       means the runtime args carry
//                       `reviewerRunAcknowledged: true`, authorizing exactly
//                       one host-relay reviewer run. Nothing else qualifies:
//                       forecast-only calls (no ack), correction-plan calls
//                       (`correctionLines` is native planning, never a
//                       reviewer), invalid combinations, `gentle_review` in
//                       any operation (inspect / status / start / ack /
//                       assess / select-intended-untracked / ...), and
//                       `gentle_review_scope` never enter. Legacy
//                       provider-rendered captures carry no ack key and the
//                       upstream sidebar publishes `reviewing` at any bound
//                       capture entry BEFORE the forecast branch runs, so no
//                       sidebar/event signal can prove a legacy reviewer
//                       route — unknown legacy shapes stay dark
//                       (documented conservative limitation; bindings stay
//                       opaque, never parsed). The reserved
//                       `gentle-pi:review:blocked` hook has no producer and
//                       is not observed. During capture-group's fan-out the
//                       multiple reviewers the single parent capture-group
//                       call stays in flight for the whole span, so that one
//                       call alone holds `review:` — no per-reviewer tracking
//                       is needed or attempted. The consumer renders this leg
//                       as user-facing `rdd` (machine key stays `review`).
//                       Fail-safe: no provider verdicts are
//                       invented; the id is a sanitized correlation id only.
//   error             : the agent run itself stopped on an error (an assistant
//                       message whose `stopReason` is `error` — the same
//                       signal Pi derives `turn_end.outcome === "error"`
//                       from). Never a tool-level failure, never a failed
//                       delegate record, never our own transport: those are
//                       detected and logged, and change no state. Sidebar-only:
//                       the pane keeps reporting native `working` while the
//                       label stands, so an error never fires the host's
//                       NeedsAttention toast or sound. Released by the next
//                       non-error beat (agent_start, any tool activity, or a
//                       non-error assistant message), never latched.
//   changes           : SESSION_CHANGE_ENTRY facts mirroring the Gentle Shell
//                       SessionChanges model semantics from the session
//                       transcript (write|edit tool outcomes only, never git
//                       status) on `gentle-pi:session-change`. Files keyed by
//                       (root, path) with evidence-ID dedup, first-before /
//                       latest-after preservation, unavailable on broken
//                       snapshot continuity or kind:unavailable snapshots
//                       (unavailable files stay in the file count with 0/0),
//                       and the same unified-patch accounting as
//                       SessionChanges.changed() (generateUnifiedPatch +
//                       first-@@ +N/-N counts; absent maps to empty text) —
//                       published as separate v2 totals so the sidebar
//                       renders exact +N/-N segments.
//
// Security (implementation mode): principal = local Pi agent process;
// asset = pane tokens + session hash; untrusted sources = tool inputs, task
// details, event payloads, transcript entries (all shape/charset/bound
// validated before token inclusion; fail closed — no session binding means
// no tokens); sinks = Herdr socket IPC + fixed-argv `herdr` CLI fallback +
// in-process event bus. Logs carry no session IDs, paths, labels, hashes,
// or payloads (debug gate only, kinds/counts).
//
// Async semantics (async-and-realtime guidance): at-least-once snapshot
// beats + TTL expiry; no end-to-end exactly-once claim. Desktop toast dedup
// is Herdr's native edge-triggered semantics; the producer's contribution is
// a stable per-episode intentId (ask label correlation, and the Moshi
// approval action id when the phone channel is enabled).
// @ts-nocheck

import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, dirname, join, resolve as resolvePath, relative as pathRelative, basename as pathBasename, isAbsolute as pathIsAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const nodeRequire = createRequire(import.meta.url);
// Inlined presence reconciliation (T1). Single-file deployment boundary:
// the installed copy/symlink of this file ships WITHOUT the sibling
// helper module, so the bounded passive reader lives here and this file
// carries no relative imports. Logic mirrors the Gentle Shell orchestrator
// presence protocol (profile order, hex session-hash binding, header /
// activity validation, 15 s freshness); all `presence`-prefixed internals
// are collision-scoped to this block and the four exported helpers below
// are the only surface the harness extracts.

export const PRESENCE_HEADER_LIMIT = 16 * 1024;
export const PRESENCE_ACTIVITY_LIMIT = 16 * 1024 * 1024;
export const PRESENCE_FRESH_MS = 15_000;
export const PRESENCE_MAX_DIR_ENTRIES = 128;
export const PRESENCE_MAX_WITNESSED = 256;

const PRESENCE_HEX64 = /^[a-f0-9]{64}$/;
const PRESENCE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PRESENCE_KNOWN_STATUSES = new Set([
  "running",
  "queued",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const FINAL_PRESENCE_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const PRESENCE_LOCAL_FINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const PRESENCE_SUMMARY_KEYS = [
  "id",
  "agent",
  "label",
  "status",
  "model",
  "createdAt",
  "startedAt",
  "endedAt",
  "lastActivityAt",
];

function presenceIsObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presenceIsNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function presenceDigestHex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function presenceSanitizedLabel(text) {
  const clean = stripVTControlCharacters(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, 120).join("").trimEnd();
}

function presenceSessionHash(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return presenceDigestHex(sessionId);
}

function presenceSafeDirectory(path, owned, ownerMask) {
  let stat;
  try {
    stat = fs.lstatSync(path);
  } catch {
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (owned && process.platform !== "win32") {
    if (typeof stat.uid !== "number" || stat.uid !== process.getuid?.()) return false;
    if ((stat.mode & ownerMask) !== 0) return false;
  }
  return true;
}

// Gentle Shell agent home (GENTLE_PI_AGENT_HOME, else PI_CODING_AGENT_DIR,
// else `~/.pi/agent`), tilde-expanded and realpathed. Undefined when the two
// env vars disagree or the path cannot be resolved, so every caller degrades
// instead of guessing.
function resolveAgentHome(env = process.env, home = homedir()) {
  const gentle = env?.GENTLE_PI_AGENT_HOME;
  const piDir = env?.PI_CODING_AGENT_DIR;
  const hasGentle = typeof gentle === "string" && gentle.length > 0;
  const hasPiDir = typeof piDir === "string" && piDir.length > 0;
  if (hasGentle && hasPiDir && gentle !== piDir) return undefined;
  const selected = hasGentle ? gentle : hasPiDir ? piDir : join(home, ".pi", "agent");
  if (typeof selected !== "string" || selected.length === 0) return undefined;
  let expanded = selected;
  if (selected === "~") expanded = home;
  else if (selected.startsWith("~/") || (process.platform === "win32" && selected.startsWith("~\\"))) {
    expanded = join(home, selected.slice(2));
  }
  try {
    return fs.realpathSync(resolvePath(expanded));
  } catch {
    return undefined;
  }
}

export function resolvePresenceProfile(env = process.env, home = homedir()) {
  const real = resolveAgentHome(env, home);
  if (real === undefined) return undefined;
  const shared = join(real, "gentle-agents");
  const presenceRoot = join(shared, "presence");
  if (!presenceSafeDirectory(real, false, 0)) return undefined;
  if (!presenceSafeDirectory(shared, true, 0o022)) return undefined;
  if (!presenceSafeDirectory(presenceRoot, true, 0o077)) return undefined;
  for (let path = dirname(real); ; path = dirname(path)) {
    if (!presenceSafeDirectory(path, false, 0)) return undefined;
    if (dirname(path) === path) break;
  }
  return presenceRoot;
}

function presenceBoundedRead(path, limit) {
  const before = fs.lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("unsafe-file");
  if (process.platform !== "win32" && before.uid !== process.getuid?.()) {
    throw new Error("unsafe-file");
  }
  if (before.size > limit) throw new Error("oversized");
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe-file");
    if (process.platform !== "win32" && stat.uid !== process.getuid?.()) {
      throw new Error("unsafe-file");
    }
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error("unsafe-file");
    if (stat.size > limit) throw new Error("oversized");
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used !== stat.size) throw new Error("changed-file");
    return bytes.subarray(0, used);
  } finally {
    fs.closeSync(fd);
  }
}

function presenceHeaderFilename(header) {
  return `${header.sessionHash}.${header.incarnation}.header.json`;
}

function presenceValidHeader(value, sessionHash, entryName) {
  if (!presenceIsObject(value)) return false;
  const keys = Object.keys(value);
  const want = [
    "schema",
    "sessionHash",
    "incarnation",
    "label",
    "heartbeat",
    "generation",
    "counts",
    "digest",
    "unavailable",
  ];
  if (keys.length !== want.length || !want.every((key) => Object.hasOwn(value, key))) return false;
  if (value.schema !== 1) return false;
  if (value.sessionHash !== sessionHash || !PRESENCE_HEX64.test(value.sessionHash)) return false;
  if (typeof value.incarnation !== "string" || !PRESENCE_UUID.test(value.incarnation)) return false;
  if (typeof value.label !== "string" || value.label !== presenceSanitizedLabel(value.label)) return false;
  if (!presenceIsNonNegativeInt(value.heartbeat)) return false;
  if (!presenceIsNonNegativeInt(value.generation) || value.generation <= 0) return false;
  const counts = value.counts;
  if (!presenceIsObject(counts)) return false;
  const countKeys = Object.keys(counts);
  if (
    countKeys.length !== 4 ||
    !["running", "queued", "waiting", "finished"].every((key) => presenceIsNonNegativeInt(counts[key]))
  ) {
    return false;
  }
  const digestOk =
    value.unavailable === null && typeof value.digest === "string" && PRESENCE_HEX64.test(value.digest);
  const unavailableOk =
    value.unavailable === "activity-too-large" && value.digest === null;
  if (!digestOk && !unavailableOk) return false;
  if (presenceHeaderFilename(value) !== entryName) return false;
  return true;
}

function presenceValidTask(row) {
  if (!presenceIsObject(row)) return false;
  const keys = Object.keys(row);
  if (keys.length !== 2 || !Object.hasOwn(row, "summary") || !Object.hasOwn(row, "thread")) {
    return false;
  }
  const summary = row.summary;
  if (!presenceIsObject(summary)) return false;
  const summaryKeys = Object.keys(summary);
  if (summaryKeys.length !== PRESENCE_SUMMARY_KEYS.length || !PRESENCE_SUMMARY_KEYS.every((key) => Object.hasOwn(summary, key))) {
    return false;
  }
  for (const key of ["id", "agent", "label", "status", "model"]) {
    if (typeof summary[key] !== "string") return false;
  }
  if (!PRESENCE_KNOWN_STATUSES.has(summary.status)) return false;
  if (!presenceIsNonNegativeInt(summary.createdAt) || !presenceIsNonNegativeInt(summary.lastActivityAt)) return false;
  for (const key of ["startedAt", "endedAt"]) {
    if (summary[key] !== null && !presenceIsNonNegativeInt(summary[key])) return false;
  }
  const thread = row.thread;
  if (!presenceIsObject(thread)) return false;
  if (!presenceIsNonNegativeInt(thread.version) || !presenceIsNonNegativeInt(thread.dropped)) return false;
  if (!Array.isArray(thread.items)) return false;
  return true;
}

export function readPresenceSnapshot(sessionId, now = Date.now(), opts = {}) {
  const sessionHash = presenceSessionHash(sessionId);
  if (!sessionHash) return undefined;
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) return undefined;
  let presenceRoot;
  try {
    presenceRoot = resolvePresenceProfile(opts.env ?? process.env, opts.home ?? homedir());
  } catch {
    return undefined;
  }
  if (!presenceRoot) return undefined;
  let names;
  try {
    const dir = fs.opendirSync(presenceRoot);
    try {
      names = [];
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        names.push(entry.name);
        if (names.length > PRESENCE_MAX_DIR_ENTRIES) return undefined;
      }
    } finally {
      dir.closeSync();
    }
  } catch {
    return undefined;
  }
  let match;
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".header.json")) continue;
    if (!name.startsWith(`${sessionHash}.`)) continue;
    let header;
    try {
      header = JSON.parse(presenceBoundedRead(join(presenceRoot, name), PRESENCE_HEADER_LIMIT).toString("utf8"));
    } catch {
      continue;
    }
    if (!presenceValidHeader(header, sessionHash, name)) continue;
    // Selection eligibility before ambiguity count: a stale or unavailable
    // leftover prior incarnation carries no live evidence and must neither
    // suppress nor outrank the fresh current owner. Only fresh, available
    // headers elect; two elected owners stay ambiguous (fail closed).
    if (!(now >= header.heartbeat && now - header.heartbeat <= PRESENCE_FRESH_MS)) continue;
    if (header.unavailable !== null) continue;
    if (match) return undefined;
    match = { name, header };
  }
  if (!match) return undefined;
  const { header } = match;
  let raw;
  try {
    raw = presenceBoundedRead(
      join(presenceRoot, `${header.sessionHash}.${header.incarnation}.activity.json`),
      PRESENCE_ACTIVITY_LIMIT,
    );
  } catch {
    return undefined;
  }
  if (presenceDigestHex(raw) !== header.digest) return undefined;
  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!presenceIsObject(envelope)) return undefined;
  const envelopeKeys = Object.keys(envelope);
  const want = ["schema", "sessionHash", "incarnation", "generation", "activity"];
  if (envelopeKeys.length !== want.length || !want.every((key) => Object.hasOwn(envelope, key))) {
    return undefined;
  }
  if (envelope.schema !== 1) return undefined;
  if (envelope.sessionHash !== header.sessionHash) return undefined;
  if (envelope.incarnation !== header.incarnation) return undefined;
  if (envelope.generation !== header.generation) return undefined;
  const activity = envelope.activity;
  if (!presenceIsObject(activity) || !Array.isArray(activity.tasks)) return undefined;
  if (Object.keys(activity).length !== 1) return undefined;
  const tasks = [];
  let activeCount = 0;
  for (const row of activity.tasks) {
    if (!presenceValidTask(row)) return undefined;
    const { summary } = row;
    // createdAt/startedAt ride along so the producer can order by immutable
    // first-seen (T2b): sound same-session timestamps improve ordering,
    // otherwise the local firstSeen stands (fallback, never recency).
    tasks.push({
      id: summary.id,
      agent: summary.agent,
      label: summary.label,
      status: summary.status,
      createdAt: summary.createdAt,
      startedAt: summary.startedAt,
    });
    if (!FINAL_PRESENCE_STATUSES.has(summary.status)) activeCount += 1;
  }
  if (activeCount !== header.counts.running + header.counts.queued + header.counts.waiting) {
    return undefined;
  }
  return {
    sessionHash: header.sessionHash,
    incarnation: header.incarnation,
    generation: header.generation,
    heartbeat: header.heartbeat,
    tasks,
  };
}

export function createPresenceReconciler() {
  return { binding: undefined, lastGeneration: 0, seen: new Map() };
}

function presenceBindingKey(snapshot) {
  return `${snapshot.sessionHash}.${snapshot.incarnation}`;
}

export function reconcilePresenceTasks(tasks, reconciler, snapshot, now = Date.now()) {
  const none = { applied: [] };
  if (!presenceIsObject(reconciler) || !(reconciler.seen instanceof Map)) return none;
  if (!(tasks instanceof Map)) return none;
  if (!presenceIsObject(snapshot) || !Array.isArray(snapshot.tasks)) return none;
  if (typeof snapshot.generation !== "number" || !presenceIsNonNegativeInt(snapshot.generation)) return none;
  if (typeof snapshot.heartbeat !== "number" || !presenceIsNonNegativeInt(snapshot.heartbeat)) return none;
  const key = presenceBindingKey(snapshot);
  if (typeof snapshot.sessionHash !== "string" || typeof snapshot.incarnation !== "string") return none;
  if (reconciler.binding !== key) {
    reconciler.binding = key;
    reconciler.lastGeneration = 0;
    reconciler.seen = new Map();
  }
  if (snapshot.generation <= reconciler.lastGeneration) return none;
  // Generation — never the header heartbeat — ages activity. The header is
  // rewritten on every 5 s heartbeat tick without touching the activity
  // file (its mtime tracks liveness too), so heartbeat freshness says
  // nothing about when a task entry was written; wall-clock is only used to
  // reject stale headers on read, never to authorize completion here. Each
  // witness binds the immutable execution epoch of the task (an integer
  // counter that advances only on a new launch, resume, or inactive→active
  // transition — never on same-status progress reads or Date.now recency),
  // captured alongside the generation that listed it active: any new local
  // execution starts a new epoch the old witness cannot authorize. Stale
  // witness records are retained but never consulted for another epoch, and
  // skip paths never delete witness state — only a successful apply
  // resolves an entry.
  const witnessFor = (id) => {
    const record = reconciler.seen.get(id);
    const local = tasks.get(id);
    if (!record || !presenceIsObject(local)) return undefined;
    const epoch = typeof local.epoch === "number" ? local.epoch : 0;
    return record.epoch === epoch ? record : undefined;
  };
  const applied = [];
  const listedNow = new Set();
  // T2b sound timestamp for first-seen ordering: a same-binding presence
  // createdAt (fallback startedAt) that is a positive int not newer than
  // the snapshot heartbeat. Earlier sound timestamps correct a late local
  // first-sighting; later ones never move firstSeen (fallback stands).
  const soundFirstSeen = (entry) => {
    for (const key of ["createdAt", "startedAt"]) {
      const value = entry?.[key];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= snapshot.heartbeat
      ) {
        return value;
      }
    }
    return undefined;
  };
  for (const entry of snapshot.tasks) {
    if (!presenceIsObject(entry) || typeof entry.id !== "string") continue;
    listedNow.add(entry.id);
    let local = tasks.get(entry.id);
    // First-seen refinement (T2b, epoch-preserving): adopt a sound earlier
    // presence timestamp for ordering only — never a recency bump, never
    // an epoch change, never witness state.
    if (local && presenceIsObject(local)) {
      const sound = soundFirstSeen(entry);
      const current =
        typeof local.firstSeen === "number" ? local.firstSeen : undefined;
      if (sound !== undefined && (current === undefined || sound < current)) {
        local = { ...local, firstSeen: sound };
        tasks.set(entry.id, local);
      }
    }
    if (FINAL_PRESENCE_STATUSES.has(entry.status)) {
      if (!local || PRESENCE_LOCAL_FINAL.has(local.status)) continue;
      const witness = witnessFor(entry.id);
      // Race-safe epoch binding: the terminal status must come from
      // activity strictly newer than the witness for THIS local epoch. The
      // live publisher omits finals, so a first-ever terminal with no
      // witness is an older epoch's leftover and fails closed. A previous
      // epoch's terminal status resurfacing after a resume is likewise
      // skipped with the witness record preserved untouched.
      if (witness === undefined || snapshot.generation <= witness.gen) continue;
      tasks.set(entry.id, { ...local, status: entry.status });
      reconciler.seen.delete(entry.id);
      applied.push({ id: entry.id, status: entry.status, via: "explicit" });
    } else if (PRESENCE_KNOWN_STATUSES.has(entry.status)) {
      if (local) {
        reconciler.seen.set(entry.id, {
          gen: snapshot.generation,
          epoch: typeof local.epoch === "number" ? local.epoch : 0,
        });
      }
    }
  }
  for (const [id, local] of tasks) {
    if (!presenceIsObject(local) || PRESENCE_LOCAL_FINAL.has(local.status)) continue;
    if (listedNow.has(id)) continue;
    // Absence completes only with a present witness for the CURRENT epoch
    // plus a strictly newer absent generation: the task was active in older
    // activity of this binding and is gone from newer activity without any
    // newer local execution in between (progress reads never void it).
    const witness = witnessFor(id);
    if (witness === undefined || snapshot.generation <= witness.gen) continue;
    tasks.set(id, { ...local, status: "completed" });
    reconciler.seen.delete(id);
    applied.push({ id, status: "completed", via: "absence" });
  }
  while (reconciler.seen.size > PRESENCE_MAX_WITNESSED) {
    reconciler.seen.delete(reconciler.seen.keys().next().value);
  }
  reconciler.lastGeneration = snapshot.generation;
  return { applied };
}

// ---------------------------------------------------------------------------
// Contract constants (DESIGN §4.3 / §8)
// ---------------------------------------------------------------------------

const SOURCE = "gentle:v1";
const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;

const TTL_MS = 60000;
const BEAT_MS = 15000;
const BEAT_MIN_MS = 100;
const BEAT_MAX_MS = 300000;
const BEAT_ENV = "GENTLE_HERDR_BEAT_MS";
// Bounded budget of quiet beats a producer may publish while it has no work
// evidence and no host truth to settle on (`quietWithoutTruth` in the
// factory): three beats, one BEAT_MS each. See the comment there.
const QUIET_BEAT_LIMIT = 3;
// Consecutive beats a producer must see the lost-settle contradiction (it
// believes a turn is running, the host answers `isIdle() === true`, and
// nothing else keeps the session busy) before it applies the settle the host
// already reports (`reconcileSettled` in the factory). One beat is not enough:
// the host flips to idle at the very end of a run, so a genuine `agent_settled`
// can reach the producer one host tick later, and a single sample would repaint
// a still-settling turn as idle. Two consecutive samples — 30 s of
// host-confirmed idle at the 15 s beat — cannot be that race, and a lost edge
// still recovers within one beat period after the window closes.
const LOST_SETTLE_BEATS = 2;
// Synthesized finish signal (DESIGN §4.3, S2/D2). The host never reports
// `done`, so the producer mints the finish itself: one session-bound
// `<hash>:<expiry>` token per finish at the settled-and-empty edge, carrying
// the hold as its absolute expiry. The sidebar reads it as `done` while it is
// fresh and recedes to `idle` once it expires — the delay IS that expiry, so
// no timer and no extra idle hold exists. The hold is short on purpose (5 s):
// it exists to make a finish visible, never to pin a settled row, so `idle`
// follows the finish within seconds. Overridden through
// GENTLE_HERDR_DONE_HOLD_MS, clamped to [1 s, 5 min]; the consumer rejects any
// expiry beyond the same ceiling.
const DONE_TOKEN = "gentle_done_v1";
const DONE_HOLD_MS = 5000;
const DONE_HOLD_MIN_MS = 1000;
export const DONE_HOLD_MAX_MS = 300000;
const DONE_HOLD_ENV = "GENTLE_HERDR_DONE_HOLD_MS";
// Staleness bound for the background-job snapshot. Gentle Shell emits
// `gentle-ai:jobs-sidebar` on job EDGES only — start, monitor line batch, stop,
// exit, session shutdown (`refreshJobStatus` in extensions/gentle-agents.ts has
// no periodic caller) — so a silent `bash_background` job never refreshes it. A
// snapshot older than this bound therefore counts as ZERO jobs: fail OPEN.
// Finishing while a job silently runs is a nuisance; latching the session
// non-terminal on a snapshot that no longer describes the session is the
// incident this bound exists to prevent (odd/tasks/restore-done-idle.md). Five
// minutes is the generous end of the [30 s, 5 min] band: a job longer than this
// fails open early, and a missed exit event delays `done` by at most this long.
export const JOBS_SNAPSHOT_TTL_MS = 300000;
const JOBS_TTL_ENV = "GENTLE_HERDR_JOBS_TTL_MS";
const JOBS_TTL_MIN_MS = 100;
const JOBS_TTL_MAX_MS = 3600000;

// Same discipline as doneHoldMs: an absent or unparseable value keeps the
// default and anything outside the band is clamped, so a debugging session (or
// a test that cannot wait five minutes) can shorten the bound without ever
// making every snapshot instantly stale.
export function jobsSnapshotTtlMs(raw = process.env[JOBS_TTL_ENV]) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return JOBS_SNAPSHOT_TTL_MS;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return JOBS_SNAPSHOT_TTL_MS;
  return Math.min(JOBS_TTL_MAX_MS, Math.max(JOBS_TTL_MIN_MS, Math.round(parsed)));
}
const MAX_TOKENS_PER_REPORT = 16;
const MAX_LABEL_CHARS = 64;
// Herdr's wire ceiling for a single pane-metadata token value, measured in
// UTF-8 BYTES: one value over it rejects the WHOLE `pane.report_metadata`
// beat, so nothing in that report lands and the pane falls back to its 60 s
// TTL. Character counts are not a substitute — eight 64-character Japanese
// labels are inside every character cap and ~1.3 KB on the wire — so every
// published value is bounded in bytes (Buffer.byteLength), never in JS
// characters. The session-bound values (`<hash>:<count>:<expiry>` families,
// markers, ask/review) are ASCII and ≤ 125 bytes by construction; the CSV
// values (names, roles, subs) are the only ones that can carry multibyte
// text, and they are measured against this ceiling as they are built.
const MAX_TOKEN_BYTES = 512;
const MAX_TRACKED_TASKS = 128;
const MAX_CHANGE_PATHS = 256;
const CLI_FALLBACK_TIMEOUT_MS = 2500;

const ASK_EVENT = "gentle-pi:ask-user-choice:blocked";
const ASK_QUESTION_EVENT = "gentle-pi:ask-user-question:blocked";
const QUESTIONNAIRE_EVENT = "rpiv:ask-user:blocked";
const PERMISSION_EVENT = "pi-permission-system:permission-request";
// Gentle Shell's live background jobs (`bash_background` / `monitor`) are
// published on the Pi event bus, session-scoped and display-only:
// `{ sessionId, snapshot: { jobs: [{ id, label, startedAt }] } }`.
const JOBS_SIDEBAR_EVENT = "gentle-ai:jobs-sidebar";
// Neither `gentle-pi:review:blocked` (reserved hook: no producer exists) nor
// `gentle-ai:review-sidebar` snapshots (entry publishes fire before the
// forecast branch, so they prove no reviewer route) are observed: no handler
// is registered for either, and no constants are retained for them.
// Exact Pi tool registrations verified in the installed Gentle Shell source
// (extensions/gentle-ai.ts): only the two capture tools can execute a
// reviewer run. `gentle_review` (controller: inspect / status / start /
// ack / assess / select-intended-untracked / ...) and `gentle_review_scope`
// (read-only page read) never execute reviewers and never enter this leg.
const REVIEW_TOOLS = new Set([
  "gentle_review_capture",
  "gentle_review_capture_group",
]);
// Acknowledged capture args (runtime `tool_execution_start` args): the call
// carries `reviewerRunAcknowledged: true`, authorizing exactly one host-relay
// reviewer run (capture or group). Nothing else qualifies: `correctionLines`
// is native correction planning (captureCorrectionPlan), never a reviewer;
// both keys together is rejected upstream without executing; a call with no
// ack key is forecast-only or a legacy provider-rendered vector whose route
// is unprovable (sidebar `reviewing` fires at any bound capture entry BEFORE
// the forecast branch, so it proves nothing) — never acknowledged here (fail
// closed). Anything unparseable is unacknowledged.
// Direct Pi ask tools observed via the execution seam only (exact
// registrations `ask_user_question`, `ask_user_choice`): a
// `tool_execution_start` opens, `tool_execution_end` / `tool_result`
// closes (a `tool_call` proposal alone never opens; an abort/error end
// with no result still closes). While any tracked execution is pending
// the ask leg holds `ask:`; overlapping calls are counted by call id,
// never by a single boolean.
const ASK_TOOLS = new Set(["ask_user_question", "ask_user_choice"]);
function isAcknowledgedCaptureArgs(args) {
  if (!isRecord(args)) return false;
  // `correctionLines` anywhere disqualifies: it is native correction
  // planning (or an invalid combination upstream), never a reviewer run.
  if (args.correctionLines !== undefined) return false;
  return args.reviewerRunAcknowledged === true;
}
const CHANGE_EVENT = "gentle-pi:session-change";
const CHANGE_ENTRY = "gentle-pi.session-change/v1";
const BLOCKED_EVENT = "herdr:blocked";
// Durable ask token name (DESIGN §4.3): session-bound + TTL-fresh
// `<hash>:<intentId>:<expiry>`, emitted on every beat while ask is active.
const ASK_TOKEN = "gentle_ask_v1";
// Durable review token name: session-bound + TTL-fresh
// `<hash>:<reviewId>:<expiry>`, emitted on every beat while effective
// review is active (acknowledged capture/group execution only). Null /
// clear the beat the last execution resolves — NO GRACE, no timers.
const REVIEW_TOKEN = "gentle_review_v1";
// Durable run-error token name (DESIGN §4.3): session-bound + TTL-fresh
// `<hash>:<code>:<expiry>`, emitted on every beat while the run-error leg
// stands and cleared to null the beat it releases. This is the sidebar's only
// error carrier: the native report stays `working` while the leg stands, so an
// error never raises the host's NeedsAttention toast, its sound, or a phone
// envelope (DESIGN §7).
const ERROR_TOKEN = "gentle_error_v1";
// Principal-only activity marker (DESIGN §4.3): session-bound + TTL-fresh
// `<hash>:<expiry>`, emitted while this session's own agent is active and
// cleared when it settles. It carries the principal input of
// computeNativeState alone — the aggregate native status answers `working`
// for any delegate, so the consumer cannot use it to decide the row.
const PRINCIPAL_TOKEN = "gentle_principal_v1";
// Blocking-delegate marker: session-bound + TTL-fresh `<hash>:<role>:<expiry>`,
// the role word of the oldest in-flight synchronous
// `subagent_run`/`subagent_continue` call. It exists because such a call
// blocks the principal's turn (agentActive stays true) while the child runs,
// so the principal marker alone renders generic `gentle`. Recognized roles
// only; null / clear when no blocking call is in flight.
const PENDING_TOKEN = "gentle_pending_v1";

const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const COUNT_RE = /^(0|[1-9]\d{0,15})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE_TASK = new Set(["running", "queued"]);
// T2b display set: only `running` counts as executing for the visible
// role + total count. Queued/waiting never count and never supply a role;
// pending tool calls stay role-only hints with no double count. ACTIVE_TASK
// above is unchanged for epochs/witness/marker coverage (T1 preserved).
const FINAL_TASK = new Set(["completed", "failed", "cancelled", "timed_out"]);
const AGENTS_RESULT_TYPE = "gentle-agents.result";

// Immutable task execution epoch, separate from recency (`at`, which bumps on
// every observation) and from display order (`firstSeen`, which never moves).
// A new epoch starts only on an actual new execution: first sighting of the id (new launch — upstream
// launch and subagent_continue both allocate new task ids, so a fresh id is
// a fresh execution), an explicit resume result (subagent_continue), or a
// transition from inactive (waiting or final) into active (running|queued).
// Same-status progress reads (running→running status polls/results) keep the
// epoch so they never void a presence witness. Unknown→active is status
// discovery within one execution, not a new epoch. Integer counter, never a
// timestamp, so no Date.now collision can authorize an older execution.
function taskEpochFor(previous, status, isResume) {
  const prevEpoch = typeof previous?.epoch === "number" ? previous.epoch : 0;
  if (!previous) return 0;
  if (isResume) return prevEpoch + 1;
  const wasInactive = previous.status === "waiting" || FINAL_TASK.has(previous.status);
  if (wasInactive && ACTIVE_TASK.has(status)) return prevEpoch + 1;
  return prevEpoch;
}

const DEBUG = process.env.GENTLE_HERDR_DEBUG === "1";

function debug(kind, extra) {
  if (DEBUG) console.error(`[gentle-herdr-state] ${kind}${extra === undefined ? "" : ` ${extra}`}`);
}

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeId(value, fallbackPrefix) {
  if (typeof value === "string" && ID_RE.test(value)) return value;
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${fallbackPrefix}${rand}`;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

// Finish-hold override: an absent or unparseable value keeps the 5 s
// default, and anything outside the ceiling is clamped, so the producer can
// never publish an expiry the consumer reads as foreign.
export function doneHoldMs(raw = process.env[DONE_HOLD_ENV]) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return DONE_HOLD_MS;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return DONE_HOLD_MS;
  return Math.min(DONE_HOLD_MAX_MS, Math.max(DONE_HOLD_MIN_MS, Math.round(parsed)));
}

// Beat cadence override, the same discipline as doneHoldMs: an absent or
// unparseable value keeps the 15 s default and anything outside the band is
// clamped, so a debugging session (or a test that cannot wait 15 s per beat)
// can shorten the beat without touching the 60 s token TTL or the transport's
// own 500/1500 ms bounds. The 100 ms floor keeps every beat far slower than a
// single send.
function beatMs(raw = process.env[BEAT_ENV]) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) return BEAT_MS;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return BEAT_MS;
  return Math.min(BEAT_MAX_MS, Math.max(BEAT_MIN_MS, Math.round(parsed)));
}

// Cap a label at MAX_LABEL_CHARS UTF-16 units — the same unit the consumer's
// `parseNames` checks, so a label the producer writes is never one the
// consumer drops — while backing off one unit when the cut would split a
// surrogate pair and leave a lone half behind.
function truncateChars(value, maxChars) {
  if (value.length <= maxChars) return value;
  let cut = maxChars;
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return value.slice(0, cut);
}

// Truncate on a character boundary so the result is always valid UTF-8 and
// never exceeds `maxBytes`. Only the last-resort wire clamp needs this: the
// CSV builders below drop whole entries instead of chunking one.
function truncateBytes(value, maxBytes) {
  if (utf8Bytes(value) <= maxBytes) return value;
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

function sanitizeLabel(value, fallback) {
  const raw = typeof value === "string" && value.length > 0 ? value : fallback;
  const clean = truncateChars(
    String(raw)
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
      .replace(/[,\"\n\r]/g, " ")
      .trim(),
    MAX_LABEL_CHARS,
  );
  return clean.length > 0 ? clean : truncateChars(String(fallback), MAX_LABEL_CHARS);
}

// Unknown-agent fallback (slug rules, 32-char bound): a delegation agent
// outside the known vocabulary is NOT collapsed to a generic word — its
// original name is sanitized to a lowercase `[a-z0-9_-]` slug (runs of
// other characters become one `-`, leading/trailing `-` stripped,
// truncated to 32 chars) and travels as the visible role word. Returns
// undefined when nothing salvageable remains. Pure and exported for tests.
export function sanitizeAgentSlug(agent) {
  if (typeof agent !== "string" || agent.length === 0) return undefined;
  const slug = stripVTControlCharacters(agent)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length > 0 ? slug : undefined;
}

function sessionHashOf(sessionFile) {
  if (typeof sessionFile !== "string" || sessionFile.length === 0) return undefined;
  const hash = createHash("sha256").update(sessionFile, "utf8").digest("base64url");
  return HASH_RE.test(hash) ? hash : undefined;
}

// ---------------------------------------------------------------------------
// Transport: socket IPC with one CLI fallback per beat (DESIGN §4.5 / §6)
// ---------------------------------------------------------------------------

function sendRequestAttempt(request, timeoutMs) {
  if (!enabled()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    let timeout;
    const finish = (delivered) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      try {
        socket.destroy();
      } catch { /* best effort: a failure here is non-fatal */ }
      resolve(delivered);
    };
    let socket;
    try {
      socket = net.createConnection(socketEndpoint);
    } catch {
      finish(false);
      return;
    }
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {
        finish(false);
      }
    });
    socket.on("data", (chunk) => {
      let body;
      try {
        body = JSON.parse(String(chunk));
      } catch {
        // Fail closed on unparseable bodies: retry + CLI fallback engage.
        finish(false);
        return;
      }
      if (isRecord(body) && body.error !== undefined && body.error !== null) {
        finish(false);
        return;
      }
      finish(true);
    });
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    if (timeout.unref) timeout.unref();
  });
}

async function sendTokens(tokens) {
  const names = Object.keys(tokens);
  for (let at = 0; at < names.length; at += MAX_TOKENS_PER_REPORT) {
    const patch = {};
    for (const name of names.slice(at, at + MAX_TOKENS_PER_REPORT)) {
      const value = tokens[name];
      // Last-resort net at the wire boundary: Herdr rejects the whole beat for
      // one over-cap value, so a value that ever escapes the builders is
      // clamped on a character boundary instead of taking every sibling token
      // (work, roles, subs, markers) down with it. The builders above already
      // keep their values inside the ceiling, so this never fires in practice.
      patch[name] = typeof value === "string" ? truncateBytes(value, MAX_TOKEN_BYTES) : value;
    }
    const delivered =
      (await sendRequestAttempt(
        {
          id: `${SOURCE}:${Date.now()}:${randomUUID()}`,
          method: "pane.report_metadata",
          params: { pane_id: paneId, source: SOURCE, tokens: patch },
        },
        500,
      )) ||
      (await sendRequestAttempt(
        {
          id: `${SOURCE}:${Date.now()}:${randomUUID()}`,
          method: "pane.report_metadata",
          params: { pane_id: paneId, source: SOURCE, tokens: patch },
        },
        1500,
      ));
    if (delivered) continue;
    if (!(await cliFallback(patch))) return false;
  }
  return true;
}

// Never spawnSync on the agent event loop (R4-stall): async spawn with a
// short timeout keeps beats off the critical path; on failure the beat is
// skipped and the next beat repairs (at-least-once already holds). Fixed
// argv, no shell; 60 s TTL discipline untouched.
function cliFallback(patch) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child;
    try {
      const args = ["pane", "report-metadata", paneId, "--source", SOURCE];
      for (const [name, value] of Object.entries(patch)) {
        // Null clears must never serialize as the literal string "name=null":
        // socket metadata carries null for clear, CLI uses --clear-token <name>.
        if (value === null || value === undefined) args.push("--clear-token", name);
        else args.push("--token", `${name}=${value}`);
      }
      child = spawn("herdr", args, { windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch { /* best effort: a failure here is non-fatal */ }
      finish(false);
    }, CLI_FALLBACK_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Native state owner (always on): this extension is the single publisher of
// pane.report_agent (working|blocked|idle) alongside its
// pane.report_metadata beats. The managed native extension file is deleted
// and the user controls installs (no auto-restore), so no opt-in flag
// gates publishing. Transport mirrors the metadata socket IPC
// (pane.report_agent with pane_id + session path-or-id binding + monotonic
// seq), serial latest-wins coalesced queue with bounded retries, no CLI
// fallback (native CLI shape unverified), no notification methods, never
// done/finished (only working|blocked|idle; host idle->finished mapping
// unverified) and no new imports (self-contained single file). Do NOT
// reinstall the native publisher from Herdr: two publishers for the same
// pane collide (dual-publish).
//
// T2 (the pane must never freeze at `working`): the settle this owner gates on
// is reconciled from the host's own live truth on every beat instead of being
// inferred — including when a turn was seen to start but its settle edge was
// lost, which needs a bounded window of contradictory beats rather than a
// single sample; a quiet producer the host never confirms stops beating after a
// bounded budget instead of republishing a count-0 work token forever; and the
// settle-time pending latch stops counting once the finish hold that raised it
// expires.
// ---------------------------------------------------------------------------

export const NATIVE_STATES = ["working", "blocked", "idle"];
const NATIVE_MAX_ATTEMPTS = 2;

// Principal-gated native state (pure, testable): blocked on the `hasError`
// input OR an actual human-wait intervention leg
// (ask/choice/question/questionnaire/permission — never
// review/RDD execution, which stays working and silent); working while the
// principal is active OR running/queued delegates exist OR pending launches
// exist OR review execution holds; idle ONLY on authoritative principal
// settled plus zero running+queued plus zero pending plus no human-wait
// prompt and no review execution. The producer never sets `hasError`: native
// `blocked` is what fires the host's NeedsAttention toast and sound, so an
// `error:` label stays sidebar-only and the pane reports `working` while it
// stands. Never infer terminal from child
// completion, timeout, or count0 alone (settled required). Never
// done/finished (only working|blocked|idle) and never a notification
// method — the host owns finished text plus toast/sound, and desktop ask
// attention (including toast dedup) is host-owned (DESIGN §7).
//
// The `settled` input is never inferred here: the beat reconciles it from the
// host's own live truth (`ctx.isIdle()`), so a missed `agent_settled` cannot
// leave this producer unable to reach `idle` — not when no turn was observed,
// and not when a turn this producer saw start never delivered its settle edge.
export function computeNativeState({
  agentActive,
  settled,
  activeCount,
  pendingCount,
  askActive,
  reviewActive,
  hasError,
}) {
  if (hasError) return "blocked";
  if (askActive) return "blocked";
  if (agentActive || activeCount > 0 || pendingCount > 0 || reviewActive) {
    return "working";
  }
  if (settled && !agentActive && activeCount === 0 && pendingCount === 0 && !askActive && !reviewActive) {
    return "idle";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Live session-changes metric (S62: authoritative publisher, never transcript)
//
// Gentle-shell shows the CURRENT working tree against HEAD for the session's
// subscribed roots. The transcript aggregate below (aggregateChanges over
// SESSION_CHANGE_ENTRY before/after patches) is retained as legacy evidence
// for other needs but is NOT the publisher authority: beats publish the
// live Git scan instead, so external/untracked edits and scope registration
// reflect immediately with numerical equality to the reference.
// ---------------------------------------------------------------------------

function sameSnapshot(before, after) {
  return (
    before?.kind === after?.kind &&
    (before?.kind === "absent" ||
      (before?.kind === "text" &&
        after?.kind === "text" &&
        before?.text === after?.text))
  );
}

function snapshotPatchText(snapshot) {
  return snapshot && snapshot.kind === "text" && typeof snapshot.text === "string" ? snapshot.text : "";
}

function unavailableReason(snapshot) {
  if (snapshot?.kind === "unavailable" && typeof snapshot?.reason === "string" && snapshot.reason.length > 0) {
    return snapshot.reason;
  }
  return "Snapshot unavailable.";
}

// Unified-patch accounting identical to Gentle Shell
// SessionChanges.changed(): generateUnifiedPatch(path, before, after),
// enter after the first @@ hunk, count lines beginning + and -. Fail-closed
// to 0/0 so token bounds hold when the patch cannot be built.
function safePatchPath(path) {
  if (typeof path !== "string") return "change";
  const clean = path.replace(/[\0\r\n]/g, "").slice(0, 256);
  return clean.length > 0 ? clean : "change";
}

function patchLineCounts(pathLabel, before, after) {
  try {
    const patch = generateUnifiedPatch(pathLabel, before, after);
    const patchLines = patch.split("\n");
    const firstHunk = patchLines.findIndex((line) => line.startsWith("@@"));
    const lines = firstHunk < 0 ? [] : patchLines.slice(firstHunk + 1);
    return {
      added: lines.filter((line) => line.startsWith("+")).length,
      deleted: lines.filter((line) => line.startsWith("-")).length,
    };
  } catch {
    return { added: 0, deleted: 0 };
  }
}

function isPlausibleEvidence(evidence) {
  return (
    isRecord(evidence) &&
    typeof evidence.id === "string" &&
    evidence.id.length > 0 &&
    typeof evidence.root === "string" &&
    evidence.root.length > 0 &&
    typeof evidence.path === "string" &&
    evidence.path.length > 0 &&
    isRecord(evidence.before) &&
    isRecord(evidence.after)
  );
}

function aggregateChanges(entries, sessionId) {
  const seen = new Set();
  const perRoot = new Map();
  let paths = 0;
  for (const entry of entries ?? []) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CHANGE_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || data.sessionId !== sessionId || !isPlausibleEvidence(data.evidence)) continue;
    const evidence = data.evidence;
    if (seen.has(evidence.id)) continue;
    seen.add(evidence.id);
    if (sameSnapshot(evidence.before, evidence.after)) continue;
    let perPath = perRoot.get(evidence.root);
    if (!perPath) {
      perPath = new Map();
      perRoot.set(evidence.root, perPath);
    }
    let slot = perPath.get(evidence.path);
    if (!slot) {
      if (paths >= MAX_CHANGE_PATHS) continue;
      paths += 1;
      slot = { before: evidence.before, after: evidence.after };
      if (evidence.before?.kind === "unavailable") slot.unavailable = unavailableReason(evidence.before);
      if (evidence.after?.kind === "unavailable" && !slot.unavailable) {
        slot.unavailable = unavailableReason(evidence.after);
      }
      perPath.set(evidence.path, slot);
    } else {
      if (!slot.unavailable && !sameSnapshot(slot.after, evidence.before)) {
        slot.unavailable =
          "Snapshot continuity lost (external or unobserved edit); session diff unavailable.";
      }
      if (evidence.before?.kind === "unavailable" && !slot.unavailable) {
        slot.unavailable = unavailableReason(evidence.before);
      }
      if (evidence.after?.kind === "unavailable" && !slot.unavailable) {
        slot.unavailable = unavailableReason(evidence.after);
      }
      slot.after = evidence.after;
    }
  }
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const perPath of perRoot.values()) {
    for (const [changePath, { before, after, unavailable }] of perPath) {
      if (!unavailable && sameSnapshot(before, after)) continue;
      files += 1;
      if (unavailable) continue;
      const { added: fileAdded, deleted: fileDeleted } = patchLineCounts(
        safePatchPath(changePath),
        snapshotPatchText(before),
        snapshotPatchText(after),
      );
      added += fileAdded;
      deleted += fileDeleted;
    }
  }
  return { files, added, deleted };
}

// ---------------------------------------------------------------------------
// Live Git scope + scan (S62, mirrored from gentle-shell shell-changes.ts +
// session-changes.ts + bounded-writer-admission.ts). Self-contained like the
// rest of this file: no relative imports. lib/live-session-changes.js is the
// extracted canonical copy; this inline mirror keeps the installed single-file
// copy working with zero sibling files. A parity test pins them equal.
// Reference argv, never -z/-M on numstat: `diff --numstat HEAD` +
// `status --porcelain=v1 --untracked-files=all -z`.
// ---------------------------------------------------------------------------

const LIVE_GIT_TIMEOUT_MS = 5000;
const LIVE_DIFF_MAX_BYTES = 1024 * 1024;
const LIVE_NUMSTAT_ARGS = ["diff", "--numstat", "HEAD"];
const LIVE_PORCELAIN_ARGS = ["status", "--porcelain=v1", "--untracked-files=all", "-z"];
const LIVE_SESSION_WORKTREE_ENTRY = "gentle-pi.session-worktree/v1";
const LIVE_STATUS_BY_CODE = { A: "added", D: "deleted", R: "renamed", C: "added", "?": "untracked" };
const LIVE_RENAME_BRACES = /\{([^{}]*) => ([^{}]*)\}/g;
const LIVE_HAS_RENAME_BRACES = /\{[^{}]* => [^{}]*\}/;
const LIVE_RENAME_ARROW = " => ";
const LIVE_BROAD_HOME_FOLDER = /^(?:documents|desktop|downloads|onedrive(?: - .+)?)$/i;
const LIVE_BROAD_ONEDRIVE_FOLDER = /^(?:documents|desktop)$/i;

export function liveRenamedPath(p) {
  if (LIVE_HAS_RENAME_BRACES.test(p)) return p.replace(LIVE_RENAME_BRACES, "$2").replace(/\/\//g, "/");
  const arrow = p.indexOf(LIVE_RENAME_ARROW);
  return arrow === -1 ? p : p.slice(arrow + LIVE_RENAME_ARROW.length);
}

export function liveCount(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function liveParseNumstat(text) {
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    const [added, deleted, ...rest] = line.split("\t");
    if (added === undefined || deleted === undefined || rest.length === 0) continue;
    entries.push({ path: liveRenamedPath(rest.join("\t")), added: liveCount(added), deleted: liveCount(deleted) });
  }
  return entries;
}

export function liveParsePorcelain(text) {
  const statuses = new Map();
  const records = String(text ?? "").split("\0").filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const p = record.slice(3);
    if (!p.endsWith("/")) statuses.set(p, LIVE_STATUS_BY_CODE[code[0]] ?? LIVE_STATUS_BY_CODE[code[1]] ?? "modified");
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return statuses;
}

export function liveSnapshotChanges(snapshot) {
  const counts = new Map(liveParseNumstat(snapshot.numstat).map((entry) => [entry.path, entry]));
  const files = [];
  for (const [p, status] of liveParsePorcelain(snapshot.porcelain)) {
    if (status === "untracked" && /(?:^|\/)node_modules\.backup-[^/]+\//.test(p)) continue;
    const entry = counts.get(p);
    files.push({ path: p, added: entry?.added ?? 0, deleted: entry?.deleted ?? 0, status });
  }
  return files;
}

export function liveIsHomeOrBroad(targetPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const fold = (value) => (platform === "win32" ? String(value).toLowerCase() : String(value));
  let home;
  try {
    home = options.home ?? fs.realpathSync.native(homedir());
  } catch {
    return true;
  }
  const target = fold(targetPath);
  const canonicalHome = fold(home);
  const towardHome = pathRelative(target, canonicalHome);
  if (towardHome === "" || (!pathIsAbsolute(towardHome) && towardHome !== ".." && !towardHome.startsWith("..\\") && !towardHome.startsWith("../"))) return true;
  const parent = dirname(target);
  if (parent === canonicalHome) return LIVE_BROAD_HOME_FOLDER.test(pathBasename(targetPath));
  return dirname(parent) === canonicalHome
    && /^onedrive(?: - .+)?$/i.test(pathBasename(parent))
    && LIVE_BROAD_ONEDRIVE_FOLDER.test(pathBasename(targetPath));
}

function liveValidEvidence(evidence) {
  if (!isRecord(evidence)) return false;
  if (typeof evidence.id !== "string" || evidence.id.length === 0) return false;
  if (typeof evidence.root !== "string" || !pathIsAbsolute(evidence.root)) return false;
  if (typeof evidence.path !== "string" || evidence.path.length === 0) return false;
  if (pathIsAbsolute(evidence.path) || /[\0\r\n]/.test(evidence.root + evidence.path)) return false;
  if (evidence.path.split(/[\\/]/).some((part) => part === ".." || part === ".git")) return false;
  return true;
}

export function liveSessionChangeRoots(sessionId, entries) {
  const roots = new Set();
  for (const entry of entries ?? []) {
    if (!isRecord(entry) || entry.type !== "custom" || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (data.sessionId !== sessionId) continue;
    if (entry.customType === LIVE_SESSION_WORKTREE_ENTRY && typeof data.root === "string" && pathIsAbsolute(data.root)) roots.add(data.root);
    if (entry.customType === CHANGE_ENTRY && liveValidEvidence(data.evidence)) roots.add(data.evidence.root);
  }
  return [...roots];
}

function liveRootExists(root) {
  try {
    return fs.existsSync(join(root, ".git"));
  } catch {
    return false;
  }
}

export function liveResolveScopeRoots(entries, sessionId, cwdRoot) {
  const candidates = [];
  if (typeof cwdRoot === "string" && cwdRoot.length > 0) candidates.push(cwdRoot);
  for (const root of liveSessionChangeRoots(sessionId, entries)) candidates.push(root);
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    let exists = false;
    try {
      exists = liveRootExists(real);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    try {
      if (liveIsHomeOrBroad(real)) continue;
    } catch {
      continue;
    }
    out.push(real);
  }
  return out;
}

function liveSanitizedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
}

function liveRunGit(root, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn("git", ["-C", root, ...args], { env: liveSanitizedEnv(), shell: false, windowsHide: true, timeout: LIVE_GIT_TIMEOUT_MS });
    } catch (err) {
      finish({ stdout: "", code: 1, error: (err && err.message) || String(err) });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort: a failure here is non-fatal */ }
      finish({ stdout, code: 1, error: `timed out after ${LIVE_GIT_TIMEOUT_MS}ms` });
    }, LIVE_GIT_TIMEOUT_MS + 500);
    if (timer.unref) timer.unref();
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ stdout, code: 1, error: (err && err.message) || String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ stdout, code: typeof code === "number" ? code : 1 });
    });
  });
}

async function liveReadUntrackedLines(root, rel) {
  const target = join(root, rel);
  let info;
  try {
    info = await fs.promises.lstat(target);
  } catch {
    return 0;
  }
  if (!info.isFile() || info.size > LIVE_DIFF_MAX_BYTES) return 0;
  let text;
  try {
    text = await fs.promises.readFile(target, "utf8");
  } catch {
    return 0;
  }
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export async function liveSummarizeRoots(roots) {
  const list = Array.isArray(roots) ? roots.slice() : [];
  if (list.length === 0) return { ok: true, files: 0, added: 0, deleted: 0, failedRoots: [] };
  const perRoot = [];
  const failedRoots = [];
  await Promise.all(list.map(async (root) => {
    let numstat;
    let porcelain;
    try {
      [numstat, porcelain] = await Promise.all([liveRunGit(root, LIVE_NUMSTAT_ARGS), liveRunGit(root, LIVE_PORCELAIN_ARGS)]);
    } catch {
      failedRoots.push(root);
      return;
    }
    if (!porcelain || porcelain.code !== 0) {
      failedRoots.push(root);
      return;
    }
    const files = liveSnapshotChanges({ numstat: (numstat && numstat.code === 0 ? numstat.stdout : ""), porcelain: porcelain.stdout });
    await Promise.all(files.map(async (file) => {
      if (file.status !== "untracked") return;
      try {
        file.added = await liveReadUntrackedLines(root, file.path);
      } catch {
        file.added = 0;
      }
    }));
    perRoot.push({ files });
  }));
  if (failedRoots.length > 0) return { ok: false, error: `cannot read git changes in ${failedRoots.length} checkout(s)`, failedRoots };
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const tree of perRoot) {
    for (const file of tree.files) {
      files += 1;
      added += file.added;
      deleted += file.deleted;
    }
  }
  return { ok: true, files, added, deleted, failedRoots: [] };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// Producer state, resolved once for both flag files below. GENTLE_STATUS_STATE_DIR
// (explicit user override) is used as-is; HERDR_PLUGIN_STATE_DIR is
// Herdr-injected and changes with the plugin id, so the stored dir wins
// whenever it holds any of our files — one stray known file in the injected
// dir may never outrank it, because the daemon writes its pidfile into the dir
// it resolves and that made the split self-perpetuating. The injected dir is
// used only when neither holds a known file (fresh install).
//
// S15 identity rename: the active plugin lookup id is herdr-gentle-shell, but
// every stored state path keeps the herdr-gentle-agents segment (no migration
// step, no orphaned flags). This family is IDENTICAL in lib/worktree-mode.js,
// lib/gentle-sidebar.js, herdr-plugin/bin/gentle-status.js and
// herdr-plugin/lib/gentle-diagnostics.js, so every consumer agrees on which
// directory is ours. Entries are kept even for flags this package no longer
// writes: an upgraded install still carries them, and a family that differs
// between consumers splits the state across both dirs.
const SIDEBAR_STATE_SEGMENT = "herdr-gentle-agents";
const SIDEBAR_STATE_KNOWN_FILES = [
  "gentle-sidebar-mode.json",
  "gentle-moshi.json",
  "pi-extension-exclusion-owned",
  "gentle-status.pid",
  "gentle-interruptions.json",
  "installer-state",
  "gentle-worktree-mode.json",
  "gentle-plugin-tools.json",
];

function sidebarStoredDir() {
  const env = process.env;
  const base = env.XDG_STATE_HOME
    ? join(env.XDG_STATE_HOME, "herdr")
    : join(homedir(), ".local", "state", "herdr");
  return join(base, "plugins", SIDEBAR_STATE_SEGMENT);
}

function sidebarEffectiveDir() {
  const env = process.env;
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const stored = sidebarStoredDir();
  // HEAD parity: an explicit-but-empty (or otherwise invalid non-nullish)
  // value ignores every override and uses the stored default. Only an
  // omitted (null/undefined) explicit falls through to the injected dir.
  if (explicit !== undefined && explicit !== null) return stored;
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  if (typeof injected !== "string" || injected.length === 0) return stored;
  if (injected === stored) return injected;
  try {
    for (const name of SIDEBAR_STATE_KNOWN_FILES) {
      try {
        if (fs.existsSync(join(stored, name))) return stored;
      } catch {
        // A single unreadable entry never decides; keep scanning.
      }
    }
    let injectedHas = false;
    for (const name of SIDEBAR_STATE_KNOWN_FILES) {
      try {
        if (fs.existsSync(join(injected, name))) {
          injectedHas = true;
          break;
        }
      } catch {
        // A single unreadable entry never decides; keep scanning.
      }
    }
    if (injectedHas) return injected;
  } catch {
    // Fall through to the injected dir on unexpected failure.
  }
  return injected;
}

// Status-refresh request file, owned by the consumer daemon: a single
// timestamp that `bin/gentle-status.js --refresh` also writes. Reading it (not
// spawning) is the whole point — the daemon loop deletes it and draws one
// frame, so N beats in one window collapse into one wake and this extension
// never renders a frame, never writes a pidfile, and never starts a second
// writer loop (DESIGN §8, §10 U2).
const STATUS_REFRESH_FILE = "gentle-status.refresh";

// Event-synchronized drawing: the daemon CANNOT see a report as it lands — it
// polls the Herdr snapshot — so without this request a state change stays
// invisible for up to one whole baseline poll, which is the sidebar lag. Every
// landed beat therefore requests the daemon's coalesced refresh: the drawing
// follows the report, and polling stays pure fallback. Best effort by design:
// a missing state dir or a read-only filesystem degrades to polling only.
function requestStatusRefresh() {
  if (!enabled()) return false;
  try {
    fs.writeFileSync(join(sidebarEffectiveDir(), STATUS_REFRESH_FILE), String(Date.now()), "utf8");
    return true;
  } catch {
    return false;
  }
}

// Optional Moshi notification mirror (DESIGN §7): one flag file, read per
// event. The producer extension owns it; the consumer daemon never publishes
// to Moshi (single emitter). Enabling is the flag plus, while
// `extensions/moshi-hooks.ts` is installed, adding `-extensions/moshi-hooks.ts`
// to the Pi settings `extensions` list so the Moshi-managed hook cannot notify
// in parallel. The flag path mirrors the daemon's stateRoot() resolution above,
// so both sides agree without a shared helper — this file must stay
// self-contained.
function moshiFlagPath() {
  return join(sidebarEffectiveDir(), "gentle-moshi.json");
}

function moshiFlagEnabled(path) {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    return isRecord(raw) && raw.enabled === true;
  } catch {
    return false;
  }
}

// Sidebar mode file under the same resolved state directory:
// {version:1,enabled:boolean}. Missing defaults to enabled for current-install
// compatibility; malformed never publishes. The switch that writes it ships as
// the package CLI (bin/gentle-sidebar.js), which owns the managed Herdr rows and
// the owned native-extension exclusion.
const SIDEBAR_MODE_VERSION = 1;

function sidebarModePath() {
  return join(sidebarEffectiveDir(), "gentle-sidebar-mode.json");
}

function readSidebarMode() {
  let raw;
  try {
    raw = fs.readFileSync(sidebarModePath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", publish: true };
    return { state: "malformed", publish: false };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { state: "malformed", publish: false };
  }
  if (!isRecord(doc) || doc.version !== SIDEBAR_MODE_VERSION || typeof doc.enabled !== "boolean") {
    return { state: "malformed", publish: false };
  }
  return doc.enabled ? { state: "enabled", publish: true } : { state: "disabled", publish: false };
}

function sidebarPublishingEnabled() {
  try {
    return readSidebarMode().publish;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ moshi */

// Optional Moshi replacement (DESIGN §7). With the flag on, this extension
// takes over the whole integration the Moshi-managed Pi hook used to provide
// — the same `session.update` envelopes over the Moshi daemon socket — so
// Chat View, Live Activity, the session row and the terminal context keep
// working, while notifications follow OUR policy: one per real ask episode
// and one per real finish, never per prompt or per turn. Moshi still owns
// pairing and credentials (this code never reads a token), and every send is
// best effort: an absent daemon is a silent no-op that never interrupts Pi.
//
// This file ships as plain JavaScript inside a .ts file (Pi loads it through
// jiti; the tests load a copy as .mjs), so it carries no type annotations.
const MOSHI_AGENT = "pi";
const MOSHI_MAX_CHILD_HEADER = 16 * 1024;

function moshiSocketPath() {
  const override = process.env.MOSHI_SOCKET_PATH;
  if (typeof override === "string" && override.length > 0) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Moshi", "moshi-hook.sock");
  }
  if (process.platform === "win32") return "\\\\.\\pipe\\moshi-hook";
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (typeof runtime === "string" && runtime.length > 0) return join(runtime, "moshi-hook.sock");
  return "/tmp/moshi-hook.sock";
}

const moshiInFlight = new Set();

// One envelope per connection: JSON line, half-close, drain the ack — the
// wire protocol of the Moshi daemon socket. Every failure resolves silently.
function moshiSendEnvelope(envelope) {
  try {
    const sock = net.connect({ path: moshiSocketPath() });
    const done = new Promise((resolve) => sock.once("close", () => resolve()));
    moshiInFlight.add(done);
    void done.then(() => moshiInFlight.delete(done));
    sock.setNoDelay(true);
    sock.on("error", () => {
      try {
        sock.destroy();
      } catch { /* best effort: a failure here is non-fatal */ }
    });
    sock.once("connect", () => {
      sock.write(`${JSON.stringify(envelope)}\n`);
      sock.end();
    });
    sock.on("data", () => {});
  } catch {
    // Moshi absent is never an error for Pi.
  }
}

// session_shutdown is awaited by the host: without draining, the process can
// exit before the socket connects and the session never closes in Moshi.
function moshiFlushSends(timeoutMs) {
  if (moshiInFlight.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void Promise.all([...moshiInFlight]).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function moshiCommandOutput(command, args, timeout) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true });
    return typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return "";
  }
}

// Terminal identity for the envelopes (Chat View, jump-to, approval routing).
// Resolved once, lazily: enabling Moshi is what pays for the tmux probe.
// Herdr identity comes straight from the environment Herdr stamps into every
// pane; labels are resolved daemon-side from these ids.
let moshiTerminalCache;

function moshiTerminal() {
  if (moshiTerminalCache) return moshiTerminalCache;
  const tmuxPane = process.env.TMUX_PANE ?? "";
  const tmuxEnv = process.env.TMUX ?? "";
  const comma = tmuxEnv.indexOf(",");
  const tmuxSocket = comma > 0 ? tmuxEnv.slice(0, comma) : "";
  let tmuxSession = "";
  let tmuxWindow = "";
  if (tmuxEnv) {
    const args = ["display-message", "-p"];
    if (tmuxPane) args.push("-t", tmuxPane);
    args.push("#S\t#I");
    const text = moshiCommandOutput("tmux", args, 200).trim();
    if (text) {
      const parts = text.split("\t", 2);
      tmuxSession = parts[0] ?? "";
      tmuxWindow = parts[1] ?? "";
    }
  }
  const zellijSession = process.env.ZELLIJ_SESSION_NAME ?? "";
  const zellijPane = process.env.ZELLIJ_PANE_ID ?? "";
  const inHerdr = process.env.HERDR_ENV === "1";
  const terminalKind = tmuxSession
    ? "tmux"
    : inHerdr
      ? "herdr"
      : process.env.ZELLIJ || zellijSession || zellijPane
        ? "zellij"
        : "";
  moshiTerminalCache = {
    terminalKind,
    tmuxSession,
    tmuxWindow,
    tmuxPane,
    tmuxSocket,
    zellijSession,
    zellijPane,
    herdrSession: inHerdr ? (process.env.HERDR_SESSION ?? "") : "",
    herdrPane: inHerdr ? (paneId ?? "") : "",
    herdrWorkspaceId: inHerdr ? (process.env.HERDR_WORKSPACE_ID ?? "") : "",
    herdrTabId: inHerdr ? (process.env.HERDR_TAB_ID ?? "") : "",
  };
  return moshiTerminalCache;
}

const moshiChildCache = new Map();

// A Pi session created by fork/clone/newSession carries a parent in its
// transcript header; those stay out of the Moshi inbox (the managed hook
// applied the same rule). An unreadable or half-written header is retried on
// the next call.
function moshiSessionIsChild(file) {
  if (!file) return false;
  const cached = moshiChildCache.get(file);
  if (cached !== undefined) return cached;
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  let child = false;
  try {
    const buffer = Buffer.alloc(MOSHI_MAX_CHILD_HEADER);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    const header = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
    const parent = header?.parentSession ?? header?.parentSessionId;
    child = typeof parent === "string" && parent.length > 0;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch { /* best effort: a failure here is non-fatal */ }
  }
  moshiChildCache.set(file, child);
  return child;
}

let moshiFlagCache = { key: "", enabled: false };

function moshiEnabled() {
  const path = moshiFlagPath();
  try {
    const stat = fs.statSync(path);
    // Identity, not just mtime: a rewrite that lands inside the same timestamp
    // tick (or on a coarse or network filesystem) must still flip the gate. A
    // stale "enabled" is exactly the notification the user asked not to get.
    const key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (key === moshiFlagCache.key) return moshiFlagCache.enabled;
    moshiFlagCache = { key, enabled: moshiFlagEnabled(path) };
  } catch {
    moshiFlagCache = { key: "", enabled: false };
  }
  return moshiFlagCache.enabled;
}

function moshiFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function moshiModelLabel(model) {
  if (!isRecord(model)) return "";
  return moshiFirstString(model.displayName, model.display_name, model.name, model.id, model.modelId);
}

function moshiContextRemaining(ctx) {
  let usage;
  try {
    const call = ctx?.getContextUsage;
    if (typeof call !== "function") return undefined;
    usage = call.call(ctx);
  } catch {
    return undefined;
  }
  if (typeof usage?.percent !== "number" || !Number.isFinite(usage.percent)) return undefined;
  return Math.max(1, Math.min(100, Math.round(100 - usage.percent)));
}

// Visible project name for the notification copy: the multiplexer session
// name when there is one, else the cwd basename, else `Gentle`. Never a full
// path.
function moshiProjectName(cwd, terminal) {
  const trimmed = typeof cwd === "string" ? cwd.replace(/[\\/]+$/, "") : "";
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = at >= 0 ? trimmed.slice(at + 1) : trimmed;
  return terminal.tmuxSession || terminal.herdrSession || terminal.zellijSession || base || "Gentle";
}

// Last-finished task label for the finish notification body: the most
// recently completed/cancelled record, sanitized like advisory labels and
// bounded so a notification (history, lock screen) never carries ids,
// paths, or prompt content. Undefined when no terminal record exists (the
// fallback body covers a session with no tracked tasks).
function lastFinishedLabel(taskMap) {
  let bestLabel;
  let bestAt = -1;
  if (taskMap instanceof Map) {
    for (const task of taskMap.values()) {
      if (task?.status !== "completed" && task?.status !== "cancelled") continue;
      if (typeof task?.label !== "string" || task.label.length === 0) continue;
      if (typeof task.at !== "number" || task.at < bestAt) continue;
      bestAt = task.at;
      bestLabel = task.label;
    }
  }
  if (bestLabel === undefined) return undefined;
  const clean = bestLabel.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 80);
  return clean || undefined;
}

// ---------------------------------------------------------------------------
// `/herdr-gentle:customize`: exactly two switches, offered in the floating panel
// shaped like Gentle Shell's own card (odd/tasks/restore-customize-panel.md T1;
// odd/tasks/customize-parity-done-idle.md T1/T3).
//
// The command is registered BEFORE the `enabled()` gate in the factory below,
// so it stays reachable from a plain Pi session outside a Herdr pane; the
// producer itself still needs a pane. The two switches are:
//
// - Sidebar agent rows. The marked `[ui.sidebar.agents.rows_by_agent]` block
//   belongs to the Herdr plugin's own `bin/configure.js`, which is installed as
//   its own package, so this command only drives it — `--check` to read the
//   current state, `--apply --reload` / `--uninstall --reload` to change it —
//   and re-reads `--check` as the completion proof instead of trusting an exit
//   code. This file never edits the Herdr config itself.
// - Moshi notifications. The flag file plus, while `extensions/moshi-hooks.ts`
//   is installed, the `-extensions/moshi-hooks.ts` exclusion in Pi's
//   settings.json, so the Moshi-managed hook cannot notify in parallel.
//   Enabling runs the `moshi-hook` prerequisite gate first (exact-name PATH scan
//   plus `moshi-hook status --json` reporting `paired: true`); a refusal writes
//   nothing at all. Disabling skips the gate and stays unconditional. A Pi
//   reload is requested only when the settings entry actually changed, because
//   that entry is the only part that waits for the next Pi extension load.
//
// No argument opens the recovered panel from lib/customize-panel.js through
// `ctx.ui.custom` with the overlay options the former implementation pinned;
// Enter runs the same apply path the plain `ctx.ui.select` menu uses, and that
// menu remains the fallback when the TUI helpers or `ctx.ui.custom` are
// unavailable. The removed `Plugin tools` and `Reset` sections and the
// cross-extension provider slot are deliberately NOT restored: they switched
// worktree/ODD/issues surfaces this package no longer contains.
// ---------------------------------------------------------------------------

const CUSTOMIZE_TITLE = "Customize · Herdr Gentle Shell";
const CUSTOMIZE_SIDEBAR_LABEL = "Sidebar agent rows";
const CUSTOMIZE_MOSHI_LABEL = "Moshi notifications";
const CUSTOMIZE_ON = "On";
const CUSTOMIZE_OFF = "Off";

// The former panel's geometry and overlay options, unchanged. The helpers
// module (@earendil-works/pi-tui) is resolved lazily through the injectable
// seam below so registering the extension never depends on it and tests can
// stub measurement and key matching.
const CUSTOMIZE_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" },
};
// The overlay caps its own box at `maxHeight` of the terminal, so the panel's
// row budget is that box and never the whole terminal: a card taller than the
// box is clipped by the host, and the pointer would then hit-test rows the user
// cannot see (the reported "the switch never changes" bug).
const CUSTOMIZE_OVERLAY_MAX_HEIGHT = 0.85;
let customizeTuiLoader = () => import("@earendil-works/pi-tui");

export function setCustomizeTuiLoader(loader) {
  customizeTuiLoader = loader;
}

// The panel module lives in lib/, resolved relative to this file in the
// installed package. Tests load a copy from a temp directory and point the
// documented override at the real lib dir. A single-file deployment (the
// installed copy or symlink without sibling helpers) has no panel module, so
// the callback returns null and the command keeps the plain menu below.
function customizePanelModule() {
  try {
    const override = process.env.GENTLE_CUSTOMIZE_LIB_DIR;
    const dir = typeof override === "string" && override.length > 0
      ? override
      : join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
    return nodeRequire(join(dir, "customize-panel.js"));
  } catch {
    return null;
  }
}

function customizePanelModel() {
  const panel = customizePanelModule();
  if (!panel) return null;
  return panel.customizePanelModel({
    sidebar: sidebarRowsState().state,
    moshi: moshiFlagEnabled(moshiFlagPath()) ? "on" : "off",
  });
}

// bin/configure.js lives in the Herdr plugin (installed as its own package), so
// the Pi side resolves that root exactly like lib/gentle-sidebar.js does:
// read-only `herdr plugin list --json`, with GENTLE_HERDR_PLUGIN_ROOT as the
// documented override for isolated runs. The active (renamed) id is queried
// first; a zero match falls through to one explicit lookup by the retired id.
// Ambiguous roots fail closed on either id.
const HERDR_PLUGIN_ACTIVE_ID = "herdr-gentle-shell";
const HERDR_PLUGIN_LEGACY_ID = "herdr-gentle-agents";

function herdrPluginRoots(id) {
  let result;
  try {
    result = spawnSync(
      process.env.HERDR_BIN_PATH || "herdr",
      ["plugin", "list", "--plugin", id, "--json"],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
  } catch (error) {
    return { ok: false, note: `could not resolve the installed plugin root: ${error?.message ?? error}.` };
  }
  if (result.error) {
    return { ok: false, note: `could not resolve the installed plugin root: ${result.error.message}.` };
  }
  if (result.status !== 0) {
    return { ok: false, note: `could not resolve the installed plugin root (plugin list exited ${result.status}).` };
  }
  try {
    const doc = JSON.parse(result.stdout || "");
    const arr = (doc && doc.result && doc.result.plugins) || doc.plugins || [];
    if (!Array.isArray(arr)) throw new Error("no plugins array");
    const hits = arr.filter((p) => p && (p.plugin_id === id || p.id === id));
    const roots = [...new Set(hits.map((hit) => hit.plugin_root).filter((root) => typeof root === "string" && root.length > 0))];
    return { ok: true, roots };
  } catch (error) {
    return { ok: false, note: `could not resolve the installed plugin root: malformed plugin list (${error?.message ?? error}).` };
  }
}

function checkConfigureScript(roots) {
  if (roots.length !== 1 || !pathIsAbsolute(roots[0])) {
    const why = roots.length === 0 ? "no match" : "ambiguous or non-absolute";
    return { ok: false, note: `could not resolve the installed plugin root (${why}).` };
  }
  const script = join(roots[0], "bin", "configure.js");
  if (!fs.existsSync(script)) {
    return { ok: false, note: `could not resolve the installed plugin root (${roots[0]} has no bin/configure.js).` };
  }
  return { ok: true, script };
}

function resolveConfigureScript() {
  const override = process.env.GENTLE_HERDR_PLUGIN_ROOT;
  if (typeof override === "string" && override.length > 0) {
    return { ok: true, script: join(resolvePath(override), "bin", "configure.js") };
  }
  const active = herdrPluginRoots(HERDR_PLUGIN_ACTIVE_ID);
  if (!active.ok) return active;
  if (active.roots.length > 0) return checkConfigureScript(active.roots);
  const legacy = herdrPluginRoots(HERDR_PLUGIN_LEGACY_ID);
  if (!legacy.ok) return legacy;
  if (legacy.roots.length > 0) return checkConfigureScript(legacy.roots);
  return { ok: false, note: `could not resolve the installed plugin root (no match for ${HERDR_PLUGIN_ACTIVE_ID} or ${HERDR_PLUGIN_LEGACY_ID}).` };
}

// Fixed argv, no shell, bounded time. `--check` output is only used to explain a
// refusal, so it is trimmed and capped.
function runConfigureScript(script, op, reload) {
  const args = [script, op];
  if (reload) args.push("--reload");
  let result;
  try {
    result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, windowsHide: true });
  } catch (error) {
    return { exit: -1, output: `configure ${op} could not start: ${error?.message ?? error}.` };
  }
  if (result.error) {
    return { exit: -1, output: `configure ${op} could not start: ${result.error.message}.` };
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(0, 300);
  return { exit: result.status, output };
}

// `--check` verdict: 0 = managed rows present and current, 1 = absent (needs
// --apply), anything else = refuse (unmanaged override, unreadable config).
function readSidebarRows(script) {
  const ran = runConfigureScript(script, "--check", false);
  if (ran.exit === 0) return { state: "on", output: ran.output };
  if (ran.exit === 1) return { state: "off", output: ran.output };
  return { state: "unknown", output: ran.output };
}

// Never throws: an unresolvable plugin root or an inconclusive check reports
// `unknown` instead of guessing, and nothing is written by a read.
function sidebarRowsState() {
  const resolved = resolveConfigureScript();
  if (!resolved.ok) return { state: "unknown", note: resolved.note };
  return readSidebarRows(resolved.script);
}

async function applySidebarRows(want) {
  const verb = want ? "enable" : "disable";
  const target = want ? "on" : "off";
  const resolved = resolveConfigureScript();
  if (!resolved.ok) {
    return { changed: false, needsReload: false, level: "error", text: `Could not ${verb} the sidebar agent rows: ${resolved.note}` };
  }
  const before = readSidebarRows(resolved.script);
  if (before.state === target) {
    return {
      changed: false,
      needsReload: false,
      level: "info",
      text: `Sidebar agent rows already ${target === "on" ? "enabled" : "disabled"}; nothing was changed.`,
    };
  }
  const ran = runConfigureScript(resolved.script, want ? "--apply" : "--uninstall", true);
  const after = readSidebarRows(resolved.script);
  if (after.state !== target) {
    const detail = ran.exit !== 0
      ? `configure exited ${ran.exit}${ran.output ? `: ${ran.output}` : "."}`
      : `configure reported success but the managed rows are still ${after.state}.`;
    return { changed: false, needsReload: false, level: "error", text: `Could not ${verb} the sidebar agent rows: ${detail} Nothing was changed.` };
  }
  return {
    changed: true,
    needsReload: false,
    level: "info",
    text: want
      ? "Sidebar agent rows enabled; the managed block is in place and Herdr reloaded its config."
      : "Sidebar agent rows disabled; the managed block is gone and Herdr reloaded its config.",
  };
}

// Moshi flag + exclusion. Both helpers mirror what the Moshi switch needs and
// nothing else: the flag file is re-read per event, the settings entry is the
// only edit that waits for the next Pi load.
const MOSHI_HOOKS_REL = "extensions/moshi-hooks.ts";
const MOSHI_EXCLUSION_ENTRY = "-extensions/moshi-hooks.ts";

function writeMoshiFlag(path, enabled) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify({ enabled, updatedAt: new Date().toISOString() })}\n`);
}

function piAgentDir() {
  const env = process.env;
  const selected = env.GENTLE_PI_AGENT_HOME ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  if (selected === "~") return homedir();
  if (selected.startsWith("~/")) return join(homedir(), selected.slice(2));
  return selected;
}

function moshiHooksPath() {
  return join(piAgentDir(), "extensions", "moshi-hooks.ts");
}

function piSettingsPath() {
  return join(piAgentDir(), "settings.json");
}

// Fail closed: null means "do not touch it" (unreadable, invalid JSON, a
// non-object document, or an `extensions` value that is not a list of strings).
// A missing file yields an empty document, exactly like Pi.
function readSettingsDoc(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { doc: {}, exists: false };
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (doc.extensions !== undefined && !Array.isArray(doc.extensions)) return null;
  if (Array.isArray(doc.extensions) && doc.extensions.some((entry) => typeof entry !== "string")) return null;
  return { doc, exists: true };
}

// Atomic and mode-preserving. A symlinked settings.json keeps pointing at its
// target because the temp file is created next to the resolved target.
function writeSettingsDoc(path, doc) {
  let target = path;
  try {
    target = fs.realpathSync(path);
  } catch {
    // Missing or dangling: write where the path points.
  }
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // Fresh file.
  }
  const temp = join(dirname(target), `.settings.json.gentle-${randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch { /* best effort: a failure here is non-fatal */ }
    throw error;
  }
}

function moshiExclusionPresent() {
  const loaded = readSettingsDoc(piSettingsPath());
  if (loaded === null) return null;
  const list = Array.isArray(loaded.doc.extensions) ? loaded.doc.extensions : [];
  return list.includes(MOSHI_EXCLUSION_ENTRY);
}

// Only ever appends or removes the exact entry, preserving every other key,
// value and entry. Both directions are gated on the Moshi-managed hook
// existing: with no hook file there is nothing to exclude, so settings.json is
// never touched.
function setMoshiExclusion(want) {
  if (!fs.existsSync(moshiHooksPath())) {
    return { ok: true, note: `${MOSHI_HOOKS_REL} is not installed; settings.json untouched.` };
  }
  const settings = piSettingsPath();
  const loaded = readSettingsDoc(settings);
  if (loaded === null) {
    return { ok: false, note: `could not update ${settings}: unreadable or invalid JSON.` };
  }
  const list = Array.isArray(loaded.doc.extensions) ? loaded.doc.extensions : [];
  const present = list.includes(MOSHI_EXCLUSION_ENTRY);
  if (want === present) {
    return { ok: true, note: want ? "exclusion already present." : "no exclusion to remove." };
  }
  const next = want
    ? [...list, MOSHI_EXCLUSION_ENTRY]
    : list.filter((entry) => entry !== MOSHI_EXCLUSION_ENTRY);
  try {
    writeSettingsDoc(settings, { ...loaded.doc, extensions: next });
  } catch (error) {
    return { ok: false, note: `could not write ${settings}: ${error?.message ?? error}.` };
  }
  return { ok: true, note: want ? `added ${MOSHI_EXCLUSION_ENTRY}.` : `removed ${MOSHI_EXCLUSION_ENTRY}.` };
}

// Moshi enable prerequisites. Before the switch flips to On: (a) `moshi-hook`
// resolves on PATH by exact name (join + stat, never a shell), and (b)
// `moshi-hook status --json` (fixed argv, short timeout) reports a top-level
// `paired: true`. Pairing is what lets a notification reach the phone; only the
// `paired` flag is read, never a token. Either check missing refuses with one
// message naming the fix and changes NOTHING: no flag write, no settings write,
// no exclusion entry, no reload, and the switch stays Off. The `pi` hooks entry
// is deliberately NOT required — enabling excludes `extensions/moshi-hooks.ts`
// on purpose, so this plugin is the single notifier.
const MOSHI_BIN_NAME = "moshi-hook";
const MOSHI_STATUS_ARGS = ["status", "--json"];
const MOSHI_STATUS_TIMEOUT_MS = 5000;

function resolveMoshiHook() {
  const names = process.platform === "win32"
    ? ["moshi-hook.exe", "moshi-hook.cmd", "moshi-hook.bat", MOSHI_BIN_NAME]
    : [MOSHI_BIN_NAME];
  const pathEnv = process.env.PATH ?? "";
  for (const dir of String(pathEnv).split(pathDelimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable entries never decide; keep scanning.
      }
    }
  }
  return null;
}

function runMoshiStatus(cliPath) {
  let result;
  try {
    result = spawnSync(cliPath, [...MOSHI_STATUS_ARGS], {
      encoding: "utf8",
      timeout: MOSHI_STATUS_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return { ok: false, reason: "spawn-failed" };
  }
  if (!result || result.status !== 0) {
    return { ok: false, reason: "non-zero-exit", status: result ? result.status : null };
  }
  const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!out) return { ok: false, reason: "unparseable" };
  let doc;
  try {
    doc = JSON.parse(out);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!isRecord(doc)) return { ok: false, reason: "missing-field" };
  if (doc.paired !== true) return { ok: false, reason: doc.paired === false ? "not-paired" : "missing-field" };
  return { ok: true };
}

function moshiMissingCliText() {
  return "Moshi notifications cannot be enabled: the `moshi-hook` CLI was not found on PATH; install the Moshi CLI, then re-apply On from /herdr-gentle:customize.";
}

function moshiNotPairedText() {
  return "Moshi notifications cannot be enabled: `moshi-hook status --json` reports paired:false (this device is not paired); run `moshi-hook pair --token <pairing-token>`, then re-apply On from /herdr-gentle:customize.";
}

function moshiStatusFailedText(reason, status) {
  let detail = "could not be run";
  if (reason === "non-zero-exit") detail = `exited with status ${status ?? "unknown"}`;
  else if (reason === "unparseable") detail = "produced no parseable JSON";
  else if (reason === "missing-field") detail = "reported no paired flag";
  return `Moshi notifications cannot be enabled: \`moshi-hook status --json\` did not confirm pairing (${detail}); make sure the Moshi CLI is installed and paired (\`moshi-hook pair --token <pairing-token>\`), then re-apply On from /herdr-gentle:customize.`;
}

function checkMoshiEnablePrereqs() {
  let cliPath = null;
  try {
    cliPath = resolveMoshiHook();
  } catch {
    cliPath = null;
  }
  if (typeof cliPath !== "string" || cliPath.length === 0) return { ok: false, text: moshiMissingCliText() };
  let status;
  try {
    status = runMoshiStatus(cliPath);
  } catch {
    status = { ok: false, reason: "spawn-failed" };
  }
  if (status && status.ok === true) return { ok: true, cliPath };
  if (status && status.reason === "not-paired") return { ok: false, text: moshiNotPairedText() };
  const reason = status && typeof status.reason === "string" ? status.reason : "spawn-failed";
  return { ok: false, text: moshiStatusFailedText(reason, status ? status.status : null) };
}

function applyMoshiNotifications(want) {
  const file = moshiFlagPath();
  const current = moshiFlagEnabled(file);
  if (current === want) {
    return {
      changed: false,
      needsReload: false,
      level: "info",
      text: `Moshi notifications already ${want ? "on" : "off"}; nothing was changed.`,
    };
  }
  if (want) {
    // The gate runs before any write, so a refusal leaves the flag, the
    // settings file and the exclusion exactly as found.
    const gate = checkMoshiEnablePrereqs();
    if (!gate || gate.ok !== true) {
      return {
        changed: false,
        needsReload: false,
        level: "error",
        text: (gate && typeof gate.text === "string" && gate.text) || moshiStatusFailedText("spawn-failed", null),
      };
    }
  }
  const exclusionBefore = moshiExclusionPresent();
  try {
    writeMoshiFlag(file, want);
  } catch (error) {
    return { changed: false, needsReload: false, level: "error", text: `Could not write ${file}: ${error?.message ?? error}; nothing was changed.` };
  }
  let exclusion;
  try {
    exclusion = setMoshiExclusion(want);
  } catch (error) {
    exclusion = { ok: false, note: `could not update the Moshi hook exclusion: ${error?.message ?? error}.` };
  }
  const exclusionAfter = moshiExclusionPresent();
  return {
    changed: true,
    needsReload: exclusionBefore !== exclusionAfter,
    level: exclusion.ok === false ? "error" : "info",
    text: `Moshi notifications ${want ? "enabled" : "disabled"}. ${exclusion.note}`,
  };
}

// One apply path for both switches: notify once with the verdict and reload Pi
// only when the Moshi settings entry actually changed.
async function applyCustomizeSwitch(id, value, ctx) {
  const result = id === "sidebar"
    ? await applySidebarRows(value === "on")
    : applyMoshiNotifications(value === "on");
  const notify = ctx?.ui?.notify;
  if (typeof notify === "function") {
    notify(`${result.text}${result.needsReload ? " Reloading now to apply the change." : ""}`, result.level);
  }
  if (result.needsReload && typeof ctx?.reload === "function") await ctx.reload();
}

// The single apply path shared by the overlay and the menu fallback. The choice
// the panel resolves names the switch it drives (`switchId`) and the value to
// apply; that switch id is the only thing read here, so a row can never apply a
// switch its category does not own. An inconclusive sidebar verdict is never a
// refusal: choosing On still attempts the repair and reports the apply step's
// own error, exactly like the baseline menu did.
const CUSTOMIZE_SWITCH_IDS = ["sidebar", "moshi"];

async function applyCustomizeChoice(choice, ctx) {
  if (!isRecord(choice)) return;
  const switchId = choice.switchId;
  const valueId = choice.valueId;
  if (!CUSTOMIZE_SWITCH_IDS.includes(switchId)) return;
  if (valueId !== "on" && valueId !== "off") return;
  await applyCustomizeSwitch(switchId, valueId, ctx);
}

// The former plain menu, kept as the fallback when the TUI helpers or
// `ctx.ui.custom` are unavailable. It reads the same model and applies
// through the same path as the overlay.
async function runCustomizeFallback(ctx) {
  const select = ctx?.ui?.select;
  if (typeof select !== "function") return;
  let picked = null;
  try {
    picked = await select(CUSTOMIZE_TITLE, [CUSTOMIZE_SIDEBAR_LABEL, CUSTOMIZE_MOSHI_LABEL]);
  } catch {
    picked = undefined;
  }
  // Esc/cancel (null or undefined) writes nothing and reloads nothing.
  if (picked === undefined || picked === null) return;
  const id = picked === CUSTOMIZE_SIDEBAR_LABEL ? "sidebar" : picked === CUSTOMIZE_MOSHI_LABEL ? "moshi" : null;
  if (!id) return;
  const current = id === "sidebar"
    ? sidebarRowsState().state
    : (moshiFlagEnabled(moshiFlagPath()) ? "on" : "off");
  let choice = null;
  try {
    choice = await select(`${picked} (currently ${current})`, [CUSTOMIZE_ON, CUSTOMIZE_OFF]);
  } catch {
    choice = undefined;
  }
  if (choice !== CUSTOMIZE_ON && choice !== CUSTOMIZE_OFF) return;
  await applyCustomizeChoice({ switchId: id, valueId: choice === CUSTOMIZE_ON ? "on" : "off" }, ctx);
}

async function executeCustomize(rawArgs, ctx) {
  const notify = ctx?.ui?.notify;
  const raw = String(rawArgs ?? "").trim();
  const head = (raw.split(/\s+/).filter((part) => part.length > 0)[0] || "").toLowerCase();
  if (head === "status") {
    // One read-only line: nothing is written and nothing is reloaded.
    const sidebar = sidebarRowsState();
    const moshi = moshiFlagEnabled(moshiFlagPath()) ? "on" : "off";
    if (typeof notify === "function") {
      notify(`customize status: sidebar=${sidebar.state} moshi=${moshi}`, "info");
    }
    return;
  }
  if (head !== "") {
    if (typeof notify === "function") {
      notify(`Unknown option "${raw}". Use /herdr-gentle:customize or /herdr-gentle:customize status.`, "error");
    }
    return;
  }
  // The helpers module is loaded lazily, never at registration: a host
  // without @earendil-works/pi-tui keeps every other surface working and
  // degrades this command to the menu below.
  let helpers = null;
  try {
    helpers = await customizeTuiLoader();
  } catch {
    helpers = null;
  }
  if (helpers && ctx?.ui && typeof ctx.ui.custom === "function") {
    const panel = customizePanelModule();
    const model = customizePanelModel();
    let choice = null;
    if (panel && model) {
      try {
        choice = await ctx.ui.custom(
          // Theme and terminal rows travel through the real factory arguments:
          // the card paints with the host theme and clips to the live height.
          (hostTui, theme, _keybindings, done) => panel.createCustomizePanel({
            helpers,
            hostTui,
            theme,
            rowsAvailable: () => {
              try {
                const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
                return Number.isFinite(rows)
                  ? Math.floor(rows * CUSTOMIZE_OVERLAY_MAX_HEIGHT)
                  : undefined;
              } catch {
                return undefined;
              }
            },
            model,
            done,
          }),
          CUSTOMIZE_OVERLAY_OPTIONS,
        );
      } catch {
        // A host that rejects the overlay degrades to the menu below.
        await runCustomizeFallback(ctx);
        return;
      }
    } else {
      await runCustomizeFallback(ctx);
      return;
    }
    // Esc (null) does nothing at all: no notification, no write, no reload.
    // Anything else runs the single apply path once the overlay is disposed.
    if (!choice || typeof choice !== "object") return;
    await applyCustomizeChoice(choice, ctx);
    return;
  }
  await runCustomizeFallback(ctx);
}

export default function (pi) {
  // Registered before the pane gate on purpose: the switches are local state and
  // must stay reachable from a plain Pi session outside a Herdr pane.
  if (typeof pi?.registerCommand === "function") {
    pi.registerCommand("herdr-gentle:customize", {
      description: "Customize Herdr Gentle Shell: sidebar agent rows and Moshi notifications",
      handler: async (args, ctx) => {
        await executeCustomize(args, ctx);
      },
    });
  }
  if (!enabled()) return;

  let rootSession = false;
  let sessionId;
  let sessionManager;
  let sessionFile;
  let sessionHash;
  let agentActive = false;
  let settled = false;

  // Subagent tracking: authoritative TaskStore projection only. The tasks
  // map mirrors Gentle Shell status records carried in
  // details.gentleAgents on subagent_* tool results; activeSubs() counts
  // exactly the entries whose status is running|queued. Gentle Shell owns
  // lifecycle/status truth: no local age/staleness timeout is applied.
  // pendingCalls holds label correlation state for a later
  // gentleAgents.taskId result plus a role-only display hint (exact pending
  // subagent agent -> gentle_roles_v1 slug) while the tool call is in
  // flight; it never increments the count. Task-mode `subagent_run` stays
  // in flight with no TaskStore record until tool_result, so without the
  // hint the active role would be invisible and the sidebar would show
  // generic `working` during execution.
  // Finished/failed/cancelled/waiting entries may linger in the map but
  // never count; the map is cleared only on session reset (plus the
  // bounded-map guard) — never by a local staleness timeout.
  const pendingCalls = new Map(); // toolCallId -> { agent, label, at }; agent/label are undefined when no agent is resolvable
  const tasks = new Map(); // taskId -> { agent, label, status, at }

  // Blocker legs. ask combines choice + native questionnaire + legacy
  // questionnaire + tool-gated confirmation + direct ask_user_* tool calls
  // in flight; exactly one intentId per ¬ask→ask episode. The three event
  // legs keep independent booleans so closing one never erases another.
  // askToolCalls tracks live `ask_user_question`/`ask_user_choice` calls by toolCallId so
  // overlapping calls stay correct; cleared on tool_result (by call id),
  // session reset, and shutdown. Event legs and permission/review
  // precedence (error > ask > review) are unchanged.
  let choiceActive = false;
  let questionActive = false;
  let questionnaireActive = false;
  const permissionPending = new Set();
  const askToolCalls = new Map(); // toolCallId -> at (ms)
  // Generic Pi UI prompt leg (mirrors the installed herdr-pi-tree
  // herdr-prompt-state pattern): `tool_execution_start` /
  // `tool_execution_end` track tool calls in flight by id; a
  // `ui_prompt_start` contributes to ask only when it opens while at least
  // one tool execution is active, so commands/widgets that prompt while
  // idle never become ask. A `custom` prompt is a panel or overlay — the
  // agents view, the ODD viewer, the changes view, the design canvas — and
  // never contributes at all: opening a panel is navigation, not a question,
  // and a false ask on every panel open is worse than missing one dialog.
  // Nested or duplicate prompt lifecycle coalesces into one boolean leg,
  // cleared on the matching `ui_prompt_end`, session reset, and shutdown.
  const runningTools = new Set(); // toolCallId -> in-flight tool execution
  let uiPromptActive = false;
  let askIntentId;
  let askCounter = 0;

  // Moshi replacement state (DESIGN §7): the session context the envelopes
  // carry (undefined while the toggle is off or for a lineage child), the last
  // ctx seen (so enabling mid-session still opens the row), and the tool that
  // opened the current ask episode.
  let moshiContext;
  let moshiCtxRef;
  // Last context the host handed us, retained so a beat can ask the host's own
  // live truth (`isIdle()`) instead of inferring a settle. Kept apart from
  // `moshiCtxRef`, whose capture leg owns that reference.
  let settleCtx;
  let lastAskToolName;

  // Live background jobs (Gentle Shell `bash_background` / `monitor`) from the
  // bus snapshot: session-scoped, edge-emitted, and therefore a hint with a
  // freshness bound rather than proof. A live job is PENDING WORK — it holds
  // the finish mint and keeps the row on the pink generic `gentle` wait — but
  // it is never a display state of its own: no job count is published and no
  // `job` token exists to render (odd/tasks/restore-done-idle.md).
  let jobsSnapshot;
  // One timer per live snapshot, armed for the instant that snapshot goes
  // stale. The bus is edge-emitted, so a job whose exit snapshot never arrives
  // would otherwise leave `freshRunningJobCount()` frozen at its last value
  // with nothing left to publish the settle that follows: no beat, no `done`,
  // and the row stays on the pink generic `gentle` for good. One beat at the
  // expiry is enough — from that instant the hint is zero jobs, so the beat
  // either mints `done` or reports the real activity that still holds it.
  // Never a poll: a new snapshot replaces the timer, the session reset and
  // shutdown drop it, and an empty snapshot drops it immediately.
  let jobsExpiryTimer;

  function clearJobsExpiry() {
    if (jobsExpiryTimer === undefined) return;
    clearTimeout(jobsExpiryTimer);
    jobsExpiryTimer = undefined;
  }

  function armJobsExpiry(at) {
    clearJobsExpiry();
    const delay = Math.max(0, at + jobsSnapshotTtlMs() - Date.now());
    jobsExpiryTimer = setTimeout(() => {
      jobsExpiryTimer = undefined;
      if (!rootSession) return;
      schedulePublish();
    }, delay);
    if (jobsExpiryTimer.unref) jobsExpiryTimer.unref();
  }

  function freshRunningJobCount() {
    if (!jobsSnapshot) return 0;
    if (Date.now() - jobsSnapshot.at > jobsSnapshotTtlMs()) return 0;
    const owner = jobsSnapshot.sessionId;
    const mine = sessionId;
    if (
      typeof owner === "string" &&
      owner.length > 0 &&
      typeof mine === "string" &&
      mine.length > 0 &&
      owner !== mine
    ) {
      return 0;
    }
    return jobsSnapshot.jobs.length;
  }

  // A job starting or ending is a state change: publish immediately so the
  // `gentle` wait and the finish gate follow it. `at` is the arrival time the
  // freshness bound measures from.
  function onJobsSnapshot(value) {
    if (!isRecord(value) || !isRecord(value.snapshot) || !Array.isArray(value.snapshot.jobs)) return;
    noteActivity();
    const jobs = value.snapshot.jobs.filter(
      (entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0,
    );
    // Gentle Shell publishes a FINISHED TAIL: a job that already ended stays in
    // the array carrying `status: "exited" | "stopped" | "failed"` (its
    // `RunningJobDisplay`, optional so older publishers that list running jobs
    // only keep validating). Only an entry with NO status is still running.
    // Counting a tail entry made `activity` true forever: the row stayed on the
    // pink generic `gentle` and the `done` mint — hence the finish token, the
    // host `idle` edge and the Finished toast — never happened, on a panel that
    // read `none running`. Any status, known or not, therefore stops counting.
    // `jobs` is only read by freshRunningJobCount, so the filter lives here.
    const live = jobs.filter((entry) => entry.status === undefined);
    jobsSnapshot = {
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      jobs: live,
      at: Date.now(),
    };
    if (live.length > 0) armJobsExpiry(jobsSnapshot.at);
    else clearJobsExpiry();
    schedulePublish();
  }

  // Subscribed before the `enabled()` guard would matter: the bus event is
  // session-scoped display data, so it is safe to observe anywhere. Hosts whose
  // runtime has no event bus never see it (jobs stay at zero).
  if (typeof pi?.events?.on === "function") pi.events.on(JOBS_SIDEBAR_EVENT, onJobsSnapshot);

  function moshiCapture(ctx) {
    const record = isRecord(ctx) ? ctx : undefined;
    const file = typeof sessionFile === "string" ? sessionFile : "";
    if (!file || moshiSessionIsChild(file)) {
      moshiContext = undefined;
      return;
    }
    const cwd = moshiFirstString(record?.cwd, process.cwd());
    moshiContext = {
      sessionId: moshiFirstString(sessionId, "pi"),
      transcriptPath: file,
      cwd,
      modelName: moshiModelLabel(record?.model),
      contextRemaining: moshiContextRemaining(record),
      project: moshiProjectName(cwd, moshiTerminal()),
    };
  }

  function moshiEmit(eventName, extra = {}) {
    if (!rootSession) return;
    // THE gate for every envelope path: the opt-in flag is required here, on
    // every path, with no per-event exception. A context captured while the
    // channel was on is Chat View prefill only — it never authorizes a send.
    if (!moshiEnabled()) return;
    if (!moshiContext && !moshiEnsureContext()) return;
    const context = moshiContext;
    if (!context) return;
    const envelope = {
      type: "session.update",
      source: MOSHI_AGENT,
      sessionId: context.sessionId,
      eventName,
      cwd: context.cwd,
      projectName: context.project,
      ...moshiTerminal(),
      modelName: context.modelName,
      transcriptPath: context.transcriptPath,
      requestedAt: new Date().toISOString(),
      ...extra,
    };
    if (typeof context.contextRemaining === "number" && context.contextRemaining > 0) {
      envelope.contextRemaining = Math.round(context.contextRemaining);
    }
    moshiSendEnvelope(envelope);
  }

  // The notifications name the project, so they must resolve it the way a send
  // resolves its context — capturing on demand, which also keeps a channel
  // enabled mid-session from announcing itself as a bare "Gentle".
  function moshiNotifyProject() {
    if (!moshiEnabled()) return "Gentle";
    moshiEnsureContext();
    return moshiContext?.project ?? "Gentle";
  }

  // Captures on demand and sends the silent carrier once per session, so
  // enabling Moshi mid-session still opens the Chat View row instead of
  // waiting for the next Pi session.
  function moshiEnsureContext() {
    if (moshiContext) return true;
    if (!rootSession || !moshiEnabled()) return false;
    moshiCapture(moshiCtxRef);
    if (!moshiContext) return false;
    moshiEmit("SessionStart");
    return true;
  }
  // Review leg: bounded acknowledged-execution signal. reviewCalls tracks
  // live ACKNOWLEDGED capture/group executions by toolCallId, opened only
  // on `tool_execution_start` with `reviewerRunAcknowledged: true` (a
  // `tool_call` proposal alone never opens) and closed by
  // `tool_execution_end` / `tool_result` by call id (thrown / cancelled /
  // error closes clear on this beat — zero grace, per-id overlap).
  // reviewActive holds exactly while the map is non-empty, so `review:`
  // emits only for genuine reviewer execution. `gentle_review` (any
  // operation) and `gentle_review_scope` never enter. During a
  // capture-group run the single parent capture-group call covers the
  // whole multi-reviewer span. reviewId stays a sanitized correlation
  // id; never a provider verdict.
  let reviewActive = false;
  let reviewId;
  const reviewCalls = new Map(); // toolCallId -> at (ms)

  function syncReviewActive() {
    reviewActive = reviewCalls.size > 0;
  }
  // Run-error leg: set ONLY when the agent run itself stops on an error, and
  // released by the next non-error beat (see setRunError/clearRunError). Tool
  // failures never touch it, so a failed tool can no longer repaint the row.
  let errorCode;
  const RUN_ERROR = "run-failed";
  // Tool-level failures are still detected (the reported defect asked for
  // detection) but are telemetry: a counter plus a debug line, never state.
  let toolErrors = 0;
  let emittedLabel;

  let changes = { files: 0, added: 0, deleted: 0 };
  // S62 live-scan state: session cwd for scope, generation guard so a stale
  // async scan never overwrites a newer session, coalesced in-flight flag.
  let liveGen = 0;
  let liveInFlight = false;
  let liveQueued = false;
  let sessionCwd;
  // T1 passive presence reconciliation state, per root-session binding
  // (session hash + incarnation) with monotonic generation. Reset with the
  // session so a new session never inherits another binding's witness set.
  let presenceReconciler = createPresenceReconciler();
  let transportFails = 0;
  let beatTimer;
  // Consecutive quiet beats published without host truth (see
  // `quietWithoutTruth`); bounded by QUIET_BEAT_LIMIT and reset by work.
  let quietBeats = 0;
  // Consecutive beats that contradict a turn this producer saw start (see
  // `lostSettleContradiction`); bounded by LOST_SETTLE_BEATS and reset by any
  // activity edge.
  let lostSettleBeats = 0;
  let publishQueued = false;
  let publishInFlight = false;
  // Native owner queue (always on): monotonic seq per logical report,
  // serial latest-wins coalescing, deduped emit-once per state+message.
  // Seq is never reset (host ordering); pending/last reset with the
  // session.
  // Seeded from the clock exactly like herdr's own plugin SDK
  // (`let reportSeq = Date.now() * 1000`): the counter must stay monotonic
  // ACROSS processes, because Herdr ignores a report whose seq loses to the
  // stored one. A zero-based counter makes every report after a Pi restart or
  // `/new` (both recreate this runtime) lose, which freezes the pane's
  // `agent_session` binding at the old session; the consumer then rejects the
  // fresh tokens (session-hash mismatch) and the sidebar stays on `idle`.
  let nativeSeq = Date.now() * 1000;
  let nativeInFlight = false;
  let nativePending = null;
  // The report currently on the wire. The drain loop clears `nativePending`
  // before the round trip and `nativeLastOk` only advances once the host
  // answers, so this is the only reference the dedupe has to the transition a
  // beat arriving mid-send is describing.
  let nativeSending = null;
  let nativeLastOk = undefined;
  // T2 native-only terminal guard: agent_settled clears the metadata
  // pending-launch hint below, but a settle that observes in-flight launches
  // retains pending evidence here so native idle gating stays working until
  // those launches resolve. Metadata/tasks untouched; the guard clears when a
  // launch resolves, on agent_start, with the session, and — when a launch
  // never reports back — at `nativeSettledPendingUntil`, the finish-hold
  // deadline of the settle that raised it. Past that hold the evidence stops
  // counting, so a lost launch result can never pin the native report at
  // `working` for good (seq itself never resets).
  let nativeSettledPending = false;
  let nativeSettledPendingUntil = 0;
  // Finish-hold episode (S2): minted once at the settled-and-empty edge so the
  // row reads `done`, then republished unchanged (never refreshed) until the
  // hold expires. `donePending` carries the unannounced finish to the beat
  // that actually delivers the token (S3), and `sawActivity` remembers that
  // the session did work, so a session that never ran a turn stays idle. All
  // three clear with the session and the moment any work reappears.
  let doneExpiry;
  let donePending = false;
  let sawActivity = false;
  // Whether the settle this row sits in came from an observed turn
  // (`agent_settled`) rather than from the host-truth reconcile: only an
  // observed turn can mint a finish, so non-turn activity (an ask, a review, a
  // job) on a producer that never saw a turn can never announce `done` or the
  // phone's `task_complete`.
  let turnSettled = false;
  // LIVE-1 startup latency: the session binding is still INITIATED on
  // session_start (so Herdr can attribute the pane from the first frame), but
  // the host no longer waits for it. The host awaits every session_start
  // handler in turn, and the binding's own bound is 500/1500 ms, which sat on
  // the path to the first prompt. The promise is kept here so the beats that
  // follow await it before sending: ordering (binding first, state after) is
  // unchanged, only the host's startup return is freed. Reset with the session
  // so a stale binding can never gate the next one.
  let sessionReportPending = null;

  // Retain the host context the settle reconcile reads (`isIdle()`), next to
  // the Moshi capture reference it already replaced. A lifecycle event that
  // arrives without a context must not erase the last truth we hold.
  function retainContext(ctx) {
    moshiCtxRef = ctx;
    if (ctx) settleCtx = ctx;
  }

  function clearSettledPending() {
    nativeSettledPending = false;
    nativeSettledPendingUntil = 0;
  }

  // Past the finish hold of the settle that raised it, the retained pending
  // evidence stops counting: the hold is the span it exists to cover.
  function settledPendingHeld() {
    return nativeSettledPending && Date.now() < nativeSettledPendingUntil;
  }

  // The settle state `agent_settled` applies, shared with the reconcile below
  // so both paths agree on every field except the finish episode.
  function applySettled(fromTurn) {
    agentActive = false;
    settled = true;
    turnSettled = fromTurn === true;
    lostSettleBeats = 0;
    clearSettledPending();
  }

  // Every activity edge restarts the lost-settle window: a tool call, a
  // delegate, a job, an ask/review/error leg (the contradiction predicate reads
  // those legs directly) or a new `agent_start`. Only consecutive beats that
  // still contradict the host may settle.
  function noteActivity() {
    lostSettleBeats = 0;
  }

  // Nothing observable keeps this session busy: no authoritative
  // running|queued delegate, no launch in flight, no live background job.
  // `agentActive` is not part of this evidence: it is this producer's own
  // inference from turn events, so the reconcile guards it separately and
  // never overrides a turn it saw start.
  function noWorkEvidence() {
    return (
      activeSubs().length === 0 &&
      pendingCalls.size === 0 &&
      freshRunningJobCount() === 0
    );
  }

  // Live host truth for the settle decision: the retained context's `isIdle()`.
  // `undefined` means the host offers no truth (no context yet, or one without
  // the method); `false` means the host still considers the agent busy, which
  // is never this producer's to override.
  function hostIdleTruth() {
    const probe = settleCtx?.isIdle;
    if (typeof probe !== "function") return undefined;
    try {
      return probe.call(settleCtx) === true;
    } catch {
      return undefined;
    }
  }

  // The lost-settle contradiction: this producer still believes its turn runs,
  // the host answers that nothing is processing, and no work evidence or
  // owning leg keeps the session busy. Both sides are live truth re-read on
  // every beat, so the contradiction is never remembered from a stale sample.
  function lostSettleContradiction() {
    return (
      agentActive &&
      hostIdleTruth() === true &&
      noWorkEvidence() &&
      !askActiveNow() &&
      !reviewActive &&
      errorCode === undefined
    );
  }

  // Recover a settle this producer missed. `settled` flips only in
  // `agent_settled`, which early-returns unless the host already reports idle,
  // so a session first observed while idle — or an aborted or failed run whose
  // `agent_settled` never arrived — leaves `settled` false: `computeNativeState`
  // returns undefined and the pane keeps the last native `working`. The host
  // answers the same question `agent_settled` asks, so read its live truth here
  // instead of inferring a terminal from a timeout or from a count.
  function reconcileSettled() {
    if (!rootSession || settled) return;
    // No turn edge was ever observed: nothing local contradicts the host, so
    // its answer settles the producer on the same beat.
    if (!agentActive) {
      if (!noWorkEvidence()) return;
      if (hostIdleTruth() !== true) return;
      applySettled(false);
      return;
    }
    // A turn the producer itself saw start is local evidence of a running
    // agent, and `isIdle()` turns true at the end of the run — so a genuine
    // settle edge can still be in flight. Only a bounded window of consecutive
    // contradictory beats proves the edge was lost.
    if (!lostSettleContradiction()) {
      lostSettleBeats = 0;
      return;
    }
    lostSettleBeats += 1;
    if (lostSettleBeats < LOST_SETTLE_BEATS) return;
    // `fromTurn` false: a recovered settle is never a turn, so it can mint no
    // finish episode (no `gentle_done_v1`, no finish notification).
    applySettled(false);
  }

  function refreshSessionRef(ctx) {
    try {
      const cwd = ctx?.cwd;
      if (typeof cwd === "string" && cwd.length > 0) sessionCwd = cwd;
    } catch { /* best effort: a failure here is non-fatal */ }
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (typeof file === "string" && file.length > 0) {
        sessionFile = file;
        sessionHash = sessionHashOf(file);
      }
    } catch {
      // Fail closed: keep the last bound hash; publish nothing without one.
    }
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id.length > 0) sessionId = id;
    } catch { /* best effort: a failure here is non-fatal */ }
  }

  function askActiveNow() {
    return (
      choiceActive ||
      questionActive ||
      questionnaireActive ||
      permissionPending.size > 0 ||
      askToolCalls.size > 0 ||
      uiPromptActive
    );
  }

  function desiredLabel() {
    if (errorCode) return `error:${errorCode}`;
    if (askActiveNow()) return `ask:${askIntentId}`;
    if (reviewActive) return `review:${reviewId}`;
    return undefined;
  }

  // Detection surface for tool-level failures: recorded, never published. The
  // state they reach (label, native state, finish hold) is untouched by design
  // — only a run that stops on an error may show `error:`.
  function recordToolFailure(site) {
    toolErrors += 1;
    debug("tool-error", `${site} count=${toolErrors}`);
  }

  function setRunError() {
    if (errorCode) return;
    errorCode = RUN_ERROR;
    updateBlocker();
  }

  function clearRunError() {
    if (!errorCode) return;
    errorCode = undefined;
    updateBlocker();
  }

  function ensureAskIntent() {
    if (askActiveNow() && !askIntentId) {
      askCounter += 1;
      askIntentId = sanitizeId(undefined, `q${askCounter.toString(36)}-`);
      // Moshi replacement (DESIGN §7): a real ask episode is the only
      // intervention that reaches the phone — one approval_required per
      // intentId, exactly like the Herdr toast, and never a speculative ask.
      // `moshiContext` alone never authorizes it: the flag gates every send.
      if (moshiEnabled()) {
        const project = moshiNotifyProject();
        moshiEmit("PermissionRequest", {
          category: "approval_required",
          phase: "waitingForApproval",
          actionId: askIntentId,
          title: `Gentle ask: ${project}`,
          subtitle: "Answer in terminal",
          message: `${project} has a question and is waiting for your answer. Return to Pi to respond.`,
          ...(lastAskToolName ? { toolName: lastAskToolName } : {}),
        });
      }
    }
  }

  function updateBlocker() {
    if (!rootSession) return;
    // Disabled sidebar hands the lifecycle back to native: no gentle
    // labels are claimed. A stale active label is released once so the
    // consumer can settle, then this leg stays silent.
    if (!sidebarPublishingEnabled()) {
      if (emittedLabel !== undefined) {
        emittedLabel = undefined;
        try {
          pi.events.emit(BLOCKED_EVENT, { active: false });
        } catch { /* best effort: a failure here is non-fatal */ }
      }
      return;
    }
    ensureAskIntent();
    if (!askActiveNow()) {
      askIntentId = undefined;
      lastAskToolName = undefined;
    }
    if (reviewActive && !reviewId) reviewId = sanitizeId(undefined, "r-");
    if (!reviewActive) reviewId = undefined;
    const next = desiredLabel();
    if (next === emittedLabel) return;
    emittedLabel = next;
    try {
      if (next === undefined) pi.events.emit(BLOCKED_EVENT, { active: false });
      else pi.events.emit(BLOCKED_EVENT, { active: true, label: next });
    } catch {
      // Event-bus emission must never break the beat.
    }
    schedulePublish();
  }

  // Authoritative TaskStore projection for liveness/marker coverage:
  // every entry whose status is running|queued is active here (T1
  // epochs/witness unchanged). Display count/roles use runningSubs()
  // below (running only). Pending tool calls never count;
  // finished/failed/cancelled/waiting entries never count.
  // WHY pending calls stay out of the count: task-mode `subagent_run` stays
  // in flight without a TaskStore record until it returns tool_result, so
  // counting pending calls would inflate `gentle_work_v1` with estimates.
  // The count is normative; role display below is the
  // only consumer of the pending hint.
  // Order is oldest-first by immutable firstSeen (fallback at): progress
  // reads bump `at` but never move `firstSeen`, so they never reorder.
  function activeSubs() {
    const out = [];
    for (const [id, task] of tasks) {
      if (ACTIVE_TASK.has(task.status)) {
        out.push({
          id,
          agent: task.agent,
          label: task.label,
          at: task.at,
          firstSeen: typeof task.firstSeen === "number" ? task.firstSeen : task.at,
        });
      }
    }
    out.sort((a, b) => a.firstSeen - b.firstSeen);
    return out;
  }

  // T2b display projection: only `running` counts as executing.
  // Queued/waiting never count and never supply a role; the total here is
  // the consumer's `(n)` suffix source (suffix only when > 1).
  function runningSubs() {
    const out = [];
    for (const [id, task] of tasks) {
      if (task.status === "running") {
        out.push({
          id,
          agent: task.agent,
          label: task.label,
          at: task.at,
          firstSeen: typeof task.firstSeen === "number" ? task.firstSeen : task.at,
        });
      }
    }
    out.sort((a, b) => a.firstSeen - b.firstSeen);
    return out;
  }

  // Role-only hint from in-flight `subagent_run`/`subagent_continue` tool
  // calls: task-mode launches stay in flight (no tool_result yet, hence no
  // TaskStore record) even though `tool_call` input already carries the
  // exact agent name. Publishing that agent's role slug keeps the sidebar
  // from showing generic `working` during execution. This is display-only:
  // it never enters `gentle_work_v1` or any displayed count, and each hint
  // is cleared when its tool_result arrives, the call is cancelled, or the
  // agent settles. The hint carries the mapped word or the sanitized
  // passthrough slug (unsalvageable names yield no hint and read gentle).
  function pendingRoleSubs() {
    const out = [];
    for (const pending of pendingCalls.values()) {
      if (agentToRole(pending.agent) !== undefined) {
        out.push({ agent: pending.agent, label: pending.label, at: pending.at });
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  // Role word of the OLDEST in-flight blocking launch, or undefined when no
  // recognized role is pending. `pendingRoleSubs` is already oldest-first by
  // call time, so the first entry is the one the row must show; recognized
  // filtering there means an unsalvageable agent name yields no role (the
  // consumer then stays on its own evidence instead of guessing).
  function pendingRole() {
    const oldest = pendingRoleSubs()[0];
    return oldest === undefined ? undefined : agentToRole(oldest.agent);
  }

  // Merged role sources, oldest-first by first-seen: authoritative running
  // TaskStore subs plus pending role hints. Authoritative entries win on
  // duplicates via rolesCsv dedup (first wins = oldest wins).
  function mergedRoleSubs() {
    const merged = [...runningSubs(), ...pendingRoleSubs()];
    merged.sort((a, b) => (a.firstSeen ?? a.at) - (b.firstSeen ?? b.at));
    return merged;
  }

  // Advisory names CSV, bounded in UTF-8 BYTES against Herdr's ceiling: an
  // entry that would push the value past MAX_TOKEN_BYTES is dropped whole
  // (never chunked, never truncated), so the consumer always sees whole
  // labels. A single 64-character label is at most 256 bytes, so the first
  // name always fits.
  function namesCsv(subs) {
    const parts = [];
    let length = 0;
    for (const sub of subs) {
      // An entry whose label and agent are both absent has no name to publish:
      // a record can carry no identity at all (an observation without an agent
      // and no previous record), and `sanitizeLabel` stringifies whatever
      // fallback it is handed, so passing the absence through would put the
      // literal `undefined` on the wire as a name.
      const label =
        typeof sub.label === "string" && sub.label.length > 0 ? sub.label : undefined;
      const subAgent =
        typeof sub.agent === "string" && sub.agent.length > 0 ? sub.agent : undefined;
      if (label === undefined && subAgent === undefined) continue;
      // Label first, agent as fallback, unchanged for every entry that has
      // either; the fallback is never absent here, so the sanitizer always has
      // a real string to fall back to.
      const name = sanitizeLabel(label, subAgent ?? label);
      if (parts.includes(name)) continue;
      const add = (parts.length === 0 ? 0 : 1) + utf8Bytes(name);
      if (length + add > MAX_TOKEN_BYTES) break;
      parts.push(name);
      length += add;
    }
    return parts.join(",");
  }

  // Unknown-agent fallback (slug rules, 32-char bound) lives at module
  // scope as sanitizeAgentSlug; agentToRole calls it below.
  // Authoritative role signal from TaskRecord.agent (never task labels):
  // the actual package agent `gentle-ai-explore` (verified in the project
  // registry `~/.pi/agent`, alongside `gentle-ai-worker`/`gentle-ai-verify`/
  // review agents) maps to `explorer`; the legacy `gentle-ai-explorer` alias
  // is preserved for compatibility. Exact worker/verify agents map 1:1;
  // `jd-judge-a`, `jd-judge-b`, and `jd-fix-agent` (plus the `jd-judge-` /
  // `jd-fix-` families) map to the distinct `judge` slug — never `rdd`;
  // the gentle-ai-review* family, a bare `review` agent, or any role
  // containing `review` collapses to the single `rdd` slug. Anything else
  // keeps its original sanitized name via sanitizeAgentSlug (never a
  // generic collapse). No counts, no labels enter the
  // signal.
  function agentToRole(agent) {
    if (typeof agent !== "string" || agent.length === 0) return undefined;
    if (agent === "gentle-ai-explore" || agent === "gentle-ai-explorer") return "explorer";
    if (agent === "gentle-ai-worker") return "worker";
    if (agent === "gentle-ai-verify") return "verify";
    if (
      agent === "jd-judge-a" ||
      agent === "jd-judge-b" ||
      agent === "jd-fix-agent" ||
      agent.startsWith("jd-judge-") ||
      agent.startsWith("jd-judge_") ||
      agent.startsWith("jd-fix-") ||
      agent.startsWith("jd-fix_")
    ) {
      return "judge";
    }
    if (
      agent === "gentle-ai-review" ||
      agent.startsWith("gentle-ai-review-") ||
      agent.startsWith("gentle-ai-review_") ||
      /review/i.test(agent)
    ) {
      return "rdd";
    }
    // The bare visible words `working`, `subagent`, and `gentle` are banned: a
    // sanitized unknown slug exactly equal to one of them degrades to no role
    // (generic `gentle`) in metadata roles and the native message alike.
    // `subagent` is the launch-correlation placeholder, never an agent name, so
    // it must never reach the wire as a role word. `gentle` is the pink
    // generic's own word (S1), so an agent literally named `gentle` must not
    // become a second one on the amber cell.
    const slug = sanitizeAgentSlug(agent);
    return slug === "working" || slug === "subagent" || slug === "gentle" ? undefined : slug;
  }

  // Bounded CSV of role words, oldest-first (subs already arrive
  // oldest-first by immutable firstSeen), deduped: known agents map to
  // their short words, unknown agents to their sanitized slugs. Empty when
  // no active roles at all — the caller null-clears the token so a
  // new/reloaded session never retains a prior roles value.
  function rolesCsv(subs) {
    const parts = [];
    let length = 0;
    for (const sub of subs) {
      const role = agentToRole(sub.agent);
      if (!role || parts.includes(role)) continue;
      const add = (parts.length === 0 ? 0 : 1) + utf8Bytes(role);
      if (length + add > MAX_TOKEN_BYTES) break;
      parts.push(role);
      length += add;
    }
    return parts.join(",");
  }

  function buildTokens() {
    if (!sessionHash) return {};
    const expiry = Date.now() + TTL_MS;
    // Liveness/marker coverage stays running|queued (T1); the visible
    // count + roles are running-only (T2b executing set).
    const subs = activeSubs();
    const running = runningSubs();
    const tokens = {};
    const count = String(running.length);
    if (COUNT_RE.test(count)) tokens.gentle_work_v1 = `${sessionHash}:${count}:${expiry}`;
    const csv = namesCsv(running);
    // Clear (null) when the authoritative active TaskStore list has no
    // labels, so a new/reloaded session never retains a prior names token.
    // Socket metadata carries null for clear; the CLI fallback maps null to
    // `--clear-token <name>`.
    if (csv.length > 0) tokens.gentle_names_v1 = csv;
    else tokens.gentle_names_v1 = null;
    // Authoritative role signal for the visible activity state (DESIGN
    // §4.3), merged with the in-flight pending role hint: running TaskStore
    // roles (oldest-first) plus the exact pending subagent agent while its
    // tool call is in flight (task-mode launches have no TaskStore record
    // yet). The hint is role-only — the count above stays running-only —
    // and is cleared with the pending call. Null (clear) when no active
    // recognized roles in either source — unrecognized agents degrade to
    // the consumer's `working` display.
    const roles = rolesCsv(mergedRoleSubs());
    if (roles.length > 0) tokens.gentle_roles_v1 = roles;
    else tokens.gentle_roles_v1 = null;
    // Clear the retired disclosure token left by older producers.
    tokens.gentle_subs_v1 = null;
    // Durable ask signal (DESIGN §4.3): session-bound + TTL-fresh
    // `<hash>:<intentId>:<expiry>`, emitted on every beat while ask is
    // active, null (clear) when inactive. Repairs a missed edge-triggered
    // `herdr:blocked` ask label — the consumer reduces a fresh token to
    // `ask` with the existing error > ask > review priority. Intent and
    // clearing discipline match the label leg (updateBlocker); the mint
    // here covers beats where the leg went active without an updateBlocker
    // pass (e.g. session handoff), so the token never lags the label.
    ensureAskIntent();
    if (askActiveNow() && askIntentId) tokens[ASK_TOKEN] = `${sessionHash}:${askIntentId}:${expiry}`;
    else tokens[ASK_TOKEN] = null;
    // Durable review signal: session-bound + TTL-fresh
    // `<hash>:<reviewId>:<expiry>`, emitted on every beat while effective
    // review is active, null (clear) the beat the last execution resolves — NO
    // GRACE, no timers, no agent_settled holds. Reuses the sanitized
    // reviewId episode minted by updateBlocker (minted here too so the
    // token never lags the label); never a verdict, authority, lineage,
    // lens, or provider result.
    if (reviewActive && !reviewId) reviewId = sanitizeId(undefined, "r-");
    if (!reviewActive) reviewId = undefined;
    if (reviewActive && reviewId) tokens[REVIEW_TOKEN] = `${sessionHash}:${reviewId}:${expiry}`;
    else tokens[REVIEW_TOKEN] = null;
    // Durable run-error signal: session-bound + TTL-fresh
    // `<hash>:<code>:<expiry>`, republished on every beat while the run-error
    // leg stands (durable, never edge-only, so a missed beat cannot strand the
    // row) and cleared to null on the beat the leg releases. It is the only
    // carrier of the error to the sidebar: the native report stays `working`
    // while it stands, which is what keeps the host from firing a
    // NeedsAttention toast or sound for it (DESIGN §7). Tool-level failures
    // never reach this leg (recordToolFailure is telemetry only).
    if (errorCode) tokens[ERROR_TOKEN] = `${sessionHash}:${errorCode}:${expiry}`;
    else tokens[ERROR_TOKEN] = null;
    // Root-only orchestrating marker (DESIGN §4.3): session-bound freshness
    // (<hash>:<expiry>, same binding/TTL style as gentle_work_v1, no count)
    // emitted by the root Pi session while the main session is actively
    // working (agentActive, even with zero subagents), retaining coverage
    // while an authoritative running|queued subagent exists or a
    // subagent_run/subagent_continue launch is pending, or while a fresh
    // background-job snapshot shows a live job (the settled wait on a
    // `bash_background` / `monitor` job renders the same pink generic
    // `gentle`); null (clear) once the main session settles (or any non-root
    // session) so a settled session never retains it. Carries no count and
    // never alters the work total or the roles CSV — the consumer reduces a
    // fresh marker to the
    // `orchestrating` display only when no recognized role is active (below
    // attention, terminal `done`, and recognized roles; ahead of main
    // `working`).
    if (rootSession && (agentActive || subs.length > 0 || pendingCalls.size > 0 || freshRunningJobCount() > 0)) {
      tokens.gentle_orchestrating_v1 = `${sessionHash}:${expiry}`;
    } else {
      tokens.gentle_orchestrating_v1 = null;
    }
    // Principal-only activity marker: session-bound freshness
    // (<hash>:<expiry>, same discipline as gentle_orchestrating_v1) emitted
    // while the principal's own agent is active — `agentActive` alone, the
    // same principal input computeNativeState uses, never the delegate
    // aggregate that native `working` carries — and null (clear) once it
    // settles. A settled principal therefore never publishes it, no matter
    // how many delegates keep running.
    if (agentActive) tokens[PRINCIPAL_TOKEN] = `${sessionHash}:${expiry}`;
    else tokens[PRINCIPAL_TOKEN] = null;
    // Blocking-delegate marker (same binding/TTL discipline): a synchronous
    // launch keeps the principal's agent active for the whole child run, so
    // the principal marker above is fresh while the row should instead show
    // the child's role. This carries that evidence per beat (never
    // edge-only), so a long child run stays covered by the ordinary beat and
    // a missed beat cannot strand the row. Cleared to null the beat the call
    // settles; background launches resolve their tool call immediately and so
    // never publish it.
    const pending = pendingRole();
    if (pending !== undefined) tokens[PENDING_TOKEN] = `${sessionHash}:${pending}:${expiry}`;
    else tokens[PENDING_TOKEN] = null;
    // Synthesized finish signal (S2/D2): minted once at the settled-and-empty
    // edge — principal settled with no running/queued delegate, no pending
    // launch, no live background job, and no human-wait, review, or error leg
    // — then republished with the SAME expiry so the hold can never be
    // extended. Any work appearing during the hold clears it on that beat, so
    // the row moves straight back to the role state. A session that never
    // worked never mints one. A live background job counts as activity: the
    // finish waits while the session still waits on it.
    const activity =
      agentActive ||
      subs.length > 0 ||
      pendingCalls.size > 0 ||
      freshRunningJobCount() > 0 ||
      askActiveNow() ||
      reviewActive ||
      !!errorCode;
    if (activity) {
      sawActivity = true;
      doneExpiry = undefined;
      donePending = false;
    } else if (settled && turnSettled) {
      if (doneExpiry === undefined && sawActivity) {
        doneExpiry = Date.now() + doneHoldMs();
        donePending = true;
        sawActivity = false;
      }
      if (doneExpiry !== undefined && Date.now() >= doneExpiry) {
        doneExpiry = undefined;
        donePending = false;
      }
    } else {
      doneExpiry = undefined;
      donePending = false;
    }
    tokens[DONE_TOKEN] = doneExpiry === undefined ? null : `${sessionHash}:${doneExpiry}`;
    if (changes.files > 0) {
      const files = String(changes.files);
      const added = String(changes.added);
      const deleted = String(changes.deleted);
      if (COUNT_RE.test(files) && COUNT_RE.test(added) && COUNT_RE.test(deleted)) {
        // v2 is normative (exact added/deleted for the +N/-N row);
        // v1 dual-emit keeps rollback consumers on the combined delta.
        tokens.gentle_changes_v2 = `${sessionHash}:${files}:${added}:${deleted}:${expiry}`;
        const delta = String(changes.added + changes.deleted);
        if (COUNT_RE.test(delta)) {
          tokens.gentle_changes_v1 = `${sessionHash}:${files}:${delta}:${expiry}`;
        }
      }
    } else {
      // Zero changed files in the current Gentle Shell session model clears
      // both change tokens (null = clear), so a new/reloaded session under a
      // different session hash cannot retain the prior session's v2 token.
      tokens.gentle_changes_v2 = null;
      tokens.gentle_changes_v1 = null;
    }
    return tokens;
  }

  function interesting() {
    // A pending role hint alone keeps the beat alive so the in-flight
    // task-mode role publishes even while the authoritative count is 0.
    // A pending ask tool call likewise keeps the beat alive so `ask:`
    // publishes while the call is in flight; the generic UI prompt leg
    // holds the beat the same way while its span is open. Effective
    // review (executing acknowledged capture/group calls) keeps the beat
    // alive so `review:` and the durable review token publish — NO GRACE:
    // the leg drops when the last execution ends or resolves. A live
    // background job keeps the beat alive too: that is what lets the wait end
    // on its own when the snapshot goes stale instead of the beat stopping
    // with the row still painted `gentle`.
    return (
      agentActive ||
      activeSubs().length > 0 ||
      pendingCalls.size > 0 ||
      freshRunningJobCount() > 0 ||
      askToolCalls.size > 0 ||
      uiPromptActive ||
      reviewActive ||
      // The standing run error keeps a beat alive so its durable token stays
      // republished (and TTL-fresh) until the leg releases, even after the
      // session settles.
      errorCode !== undefined ||
      emittedLabel !== undefined ||
      doneExpiry !== undefined
    );
  }

  function ensureBeat() {
    if (beatTimer || !rootSession) return;
    if (!interesting() && settled) return;
    beatTimer = setInterval(() => {
      // A tick with nothing interesting to publish has nothing to do. Stopping
      // here (instead of only after a landed publish) is what keeps a slow
      // send from re-arming the interval through `publishQueued` and spinning
      // a beat nobody needs.
      if (!interesting()) {
        stopBeat();
        return;
      }
      // T2 quiet bound: a beat with no work evidence, no host truth, and no
      // leg that still owns the row has nothing confirmed to publish — every
      // such beat republishes a fresh count-0 `gentle_work_v1`, and that
      // eternal fresh work token is what keeps the row from ever reaching
      // idle. The beat spends a bounded budget of quiet beats (one BEAT_MS
      // each) and then stops. Stopping is the honest outcome: a native state
      // the host never confirmed must not be published in its place. The
      // bound never applies to a turn this producer saw start (see
      // `quietWithoutTruth`), so it cannot leave live work unpainted; the
      // edges that schedule a publish (ask, review, launch, session changes,
      // jobs) re-arm the beat, while an ordinary tool edge reaches the row
      // through the host's own truth rather than by re-arming it.
      if (quietWithoutTruth()) {
        quietBeats += 1;
        if (quietBeats >= QUIET_BEAT_LIMIT) {
          stopBeat();
          return;
        }
      } else {
        quietBeats = 0;
      }
      void publishNow();
    }, beatMs());
    if (beatTimer.unref) beatTimer.unref();
  }

  function stopBeat() {
    if (!beatTimer) return;
    clearInterval(beatTimer);
    beatTimer = undefined;
  }

  function maybeStopBeat() {
    if (beatTimer && !interesting()) stopBeat();
  }

  // T2 quiet bound predicate (see the budget applied inside `ensureBeat`): the
  // host offers no truth at all, nothing is active by evidence, and no leg
  // still owns the row. A host that answers `false` is not quiet — it says the
  // agent is still running — and a host that answers `true` settles through
  // `reconcileSettled` instead. No native state is ever inferred here.
  //
  // `agentActive` is excluded on purpose: a turn this producer saw start is
  // live work, and the host offers no way to confirm its settle. Bounding that
  // beat would stop painting a running turn, which is exactly the pin the bound
  // exists to avoid (S2) — the bound must never trade a truthful "still
  // working" for a false `idle`. It therefore covers only a producer with no
  // observed turn behind it and no host truth to settle on.
  function quietWithoutTruth() {
    return (
      !agentActive &&
      !settled &&
      hostIdleTruth() === undefined &&
      noWorkEvidence() &&
      !askActiveNow() &&
      !reviewActive &&
      errorCode === undefined &&
      doneExpiry === undefined
    );
  }

  // N1 parity report: state + message. Working carries the SPECIFIC
  // working role in the message from the same oldest-running role
  // resolution as the metadata roles token (authoritative running roles
  // only — never a pending hint, never bare generic working; with no
  // running role the message is `gentle`; machine keys unchanged). Blocked carries the
  // corresponding herdr:blocked label (ask:<intentId> / error:<code> —
  // never review:, never done/finished). Idle carries no message. No
  // notification method is ever emitted from this code (state-only
  // pane.report_agent; host owns finished text + toast/sound, ask dedup
  // stays consumer-side per DESIGN §7).
  function desiredNativeReport() {
    if (!rootSession) return undefined;
    // `error:` is sidebar-only: native `blocked` is exactly what fires the
    // host's NeedsAttention toast and sound (DESIGN §7), so an error label
    // never claims it. While the label stands the pane reports `working` —
    // the only native state that raises no attention — and returns to the
    // lifecycle state on the next non-error beat. `hasError` stays out of
    // computeNativeState for this reason.
    const state = errorCode
      ? "working"
      : computeNativeState({
          agentActive,
          settled,
          activeCount: activeSubs().length,
          pendingCount: pendingCalls.size + (settledPendingHeld() ? 1 : 0),
          askActive: askActiveNow(),
          reviewActive,
        });
    if (!state) return undefined;
    if (state === "blocked") {
      ensureAskIntent();
      return { state, message: desiredLabel() };
    }
    if (state === "working") {
      // N1 parity: the message is always per-agent activity — the oldest
      // RUNNING role only (authoritative TaskStore records; a pending
      // launch hint is not a role and never leaks into the message). With
      // no running role the message is `gentle`: visible generic activity
      // is never bare `working`. Machine keys unchanged.
      const roles = rolesCsv(runningSubs());
      const first = roles.split(",")[0];
      if (first) return { state, message: first };
      return { state, message: "gentle" };
    }
    return { state, message: undefined };
  }

  function nativeBinding() {
    if (typeof sessionFile === "string" && sessionFile.length > 0) {
      return { agent_session_path: sessionFile };
    }
    if (typeof sessionId === "string" && sessionId.length > 0) {
      return { agent_session_id: sessionId };
    }
    return null;
  }

  // LIVE-1: the agent_session binding lives in pane.report_agent_session,
  // not in metadata token values (which only carry the derived hash the
  // consumer cannot validate without the binding). The deleted managed
  // publisher sent it on session_start (with session_start_source) and on
  // every agent_start; without it Herdr shows no agent_session for the
  // fresh pane and the sidebar stays static while metadata beats flow.
  // Identity mirrors the managed publisher (source herdr:pi, agent pi)
  // so the host sees the same single publisher, never a dual identity.
  // Session reports carry their own monotonic seq so the pinned
  // pane.report_agent state seq still starts at 1.
  const NATIVE_SOURCE = "herdr:pi";
  const NATIVE_AGENT = "pi";
  // Same clock-seeded rule as nativeSeq above: the session binding is the
  // report that must win after a restart, so it can never be zero-based.
  let nativeSessionSeq = Date.now() * 1000;

  async function reportSession(sessionStartSource) {
    if (!enabled() || !sidebarPublishingEnabled()) return;
    const binding = nativeBinding();
    if (!binding) return;
    nativeSessionSeq += 1;
    const seq = nativeSessionSeq;
    const params = {
      pane_id: paneId,
      source: NATIVE_SOURCE,
      agent: NATIVE_AGENT,
      seq,
      ...binding,
    };
    if (typeof sessionStartSource === "string" && sessionStartSource.length > 0) {
      params.session_start_source = sessionStartSource;
    }
    const base = `${SOURCE}:session:${seq}`;
    // The result is deliberately discarded: this is the fire-and-forget
    // session binding, and `void` states that intent for the linter.
    void (await sendRequestAttempt(
      {
        id: `${base}:0:${randomUUID()}`,
        method: "pane.report_agent_session",
        params,
      },
      500,
    ).catch(() => false) ||
      (await sendRequestAttempt(
        {
          id: `${base}:1:${randomUUID()}`,
          method: "pane.report_agent_session",
          params,
        },
        1500,
      ).catch(() => false)));
  }

  // Start the session binding without waiting for it (see
  // `sessionReportPending`). Never rejects: the binding leg is already
  // fail-silent, and the catch here keeps that true even if a future change
  // makes it throw.
  function startSessionReport(sessionStartSource) {
    let pending;
    try {
      pending = reportSession(sessionStartSource);
    } catch {
      sessionReportPending = null;
      return null;
    }
    sessionReportPending = Promise.resolve(pending).then(() => false, () => false);
    return sessionReportPending;
  }

  // The ordering seam every beat awaits: the binding lands before state. Absent
  // (or already settled) work costs one microtask.
  async function awaitSessionBinding() {
    const pending = sessionReportPending;
    if (!pending) return;
    try {
      await pending;
    } catch {
      // An unreadable binding never blocks a beat.
    }
  }

  // Moshi replacement (DESIGN §7, S3): the finish notification hangs off the
  // synthesized `done` edge — the beat that delivered the finish token, minted
  // only when the principal settled with zero delegates, pending launches, and
  // live jobs — never off a raw native working->idle transition, which fires
  // with work still left and used to skip `done` entirely.
  function emitFinish() {
    const project = moshiNotifyProject();
    const lastLabel = lastFinishedLabel(tasks);
    moshiEmit("AgentEnd", {
      category: "task_complete",
      title: `Gentle finished: ${project}`,
      message:
        lastLabel !== undefined
          ? `${project} finished \u2014 ${lastLabel}. Return to Pi for what\u2019s next.`
          : `${project} finished and is waiting for your next instruction.`,
    });
  }

  async function drainNative() {
    if (!enabled()) return;
    if (nativeInFlight) return;
    nativeInFlight = true;
    try {
      // The pane binding lands before any state beat (see
      // `sessionReportPending`), so a slow binding delays the beats instead of
      // being overtaken by them.
      await awaitSessionBinding();
      while (nativePending !== null) {
        const next = nativePending;
        nativePending = null;
        const binding = nativeBinding();
        if (!binding) continue;
        if (!NATIVE_STATES.includes(next.state)) continue;
        nativeSeq += 1;
        const seq = nativeSeq;
        let ok = false;
        nativeSending = next;
        try {
          for (let attempt = 0; attempt < NATIVE_MAX_ATTEMPTS && !ok; attempt += 1) {
            ok = await sendRequestAttempt(
              {
                id: `${SOURCE}:native:${seq}:${attempt}:${randomUUID()}`,
                method: "pane.report_agent",
                params: {
                  pane_id: paneId,
                  source: NATIVE_SOURCE,
                  agent: NATIVE_AGENT,
                  state: next.state,
                  message: next.message,
                  ...binding,
                  seq,
                },
              },
              attempt === 0 ? 500 : 1500,
            );
          }
        } finally {
          // Released on success AND failure: a send that never landed leaves
          // `nativeLastOk` behind, so the next beat still retries the
          // transition (attempt loop above, then beats — never a re-queue here).
          if (nativeSending === next) nativeSending = null;
        }
        if (ok) nativeLastOk = next;
      }
    } finally {
      nativeInFlight = false;
      if (nativePending !== null) void drainNative();
    }
  }

  function queueNative() {
    if (!enabled() || !sidebarPublishingEnabled()) return;
    const want = desiredNativeReport();
    if (!want) return;
    // Dedupe against the newest report the host has, is getting, or is
    // already queued to get: the pending slot, then the in-flight send, then
    // the last delivered report. The in-flight leg is what keeps one logical
    // transition to one seq — without it a beat landing inside the round trip
    // re-queues the report being sent and mints a duplicate.
    const known = nativePending ?? nativeSending ?? nativeLastOk;
    if (known && known.state === want.state && known.message === want.message) return;
    nativePending = want;
    void drainNative();
  }

  async function publishNow() {
    if (!rootSession || !sidebarPublishingEnabled()) return;
    if (publishInFlight) {
      // LIVE-3: an in-flight beat must never swallow a newer snapshot —
      // notably the true-empty settle idle, which has no later trigger
      // to repair it. Coalesce into one follow-up beat instead of
      // dropping (snapshots are idempotent full-state; idle-once dedup
      // is unchanged in queueNative).
      publishQueued = true;
      return;
    }
    // The pane binding lands before any state beat (see
    // `sessionReportPending`). A session that ended while the binding was in
    // flight publishes nothing: `rootSession` is re-read after the wait.
    await awaitSessionBinding();
    if (!rootSession || !sidebarPublishingEnabled()) return;
    // Host truth first: a settle this producer missed must be visible to both
    // the native report and the tokens built below.
    reconcileSettled();
    reconcilePresence();
    queueNative();
    const tokens = buildTokens();
    if (Object.keys(tokens).length === 0) {
      maybeStopBeat();
      return;
    }
    // The finish notification is a Moshi envelope, not a Herdr token: it hangs
    // off the minted done edge above, and announcing it here — before, and
    // regardless of, the token publish — keeps a transport failure from
    // swallowing it. Cleared with the announcement, so a retried beat can
    // never duplicate it.
    if (donePending) {
      donePending = false;
      emitFinish();
    }
    publishInFlight = true;
    try {
      const ok = await sendTokens(tokens);
      if (ok) {
        // One coalesced wake per landed beat, after the tokens are in Herdr
        // (a request written first could render a frame over stale tokens).
        requestStatusRefresh();
        if (transportFails > 0) debug("transport-ok", `after ${transportFails} failed beat(s)`);
        transportFails = 0;
      } else {
        // Our own report transport failing is not the agent failing: it is a
        // telemetry line, never an `error:` label and never native `blocked`
        // (that latched a stuck red row on a socket hiccup and fired the
        // host's toast for it). The next landed beat resets the counter.
        transportFails += 1;
        debug("transport-failed", `${transportFails} beat(s) in a row`);
      }
    } finally {
      publishInFlight = false;
      if (publishQueued) {
        publishQueued = false;
        schedulePublish();
      } else {
        maybeStopBeat();
      }
    }
    debug("beat", `tokens=${Object.keys(tokens).length} subs=${activeSubs().length}`);
  }

  // T1 passive presence reconciliation: resolve explicit terminal task
  // statuses (and witnessed absence in a newer complete snapshot) from the
  // Gentle Shell presence files before building tokens, so delegate
  // completion never waits on deferred chat delivery. Passive and bounded:
  // no timers, no writes, no imported upstream dependencies; any unreadable
  // or inapplicable snapshot leaves tasks untouched. Count, TTL, and
  // transport semantics below are unchanged.
  function reconcilePresence() {
    if (!sessionId) return;
    let snapshot;
    try {
      snapshot = readPresenceSnapshot(sessionId, Date.now());
    } catch {
      return;
    }
    if (!snapshot) return;
    let applied = [];
    try {
      applied = reconcilePresenceTasks(tasks, presenceReconciler, snapshot, Date.now()).applied;
    } catch {
      return;
    }
    if (!Array.isArray(applied) || applied.length === 0) return;
    // A delegate that ended failed is a tool-level outcome, not the run
    // stopping: detected and counted, and no state changes.
    if (applied.some((entry) => entry && entry.status === "failed")) {
      recordToolFailure("presence:failed");
    }
  }

  function schedulePublish() {
    ensureBeat();
    if (publishInFlight) {
      publishQueued = true;
      return;
    }
    setTimeout(() => {
      void publishNow();
    }, 100);
  }

  function refreshChanges() {
    void liveRefreshChanges();
  }

  // S62 authoritative publisher: live Git over the subscribed scope.
  // Async, fixed-argv, coalesced; fail-stale keeps the last good totals
  // (never 0/0, never partial) so a git failure cannot advertise clean.
  async function liveRefreshChanges() {
    if (!rootSession || !sessionManager || !sessionId) return;
    if (liveInFlight) {
      liveQueued = true;
      return;
    }
    liveInFlight = true;
    const gen = liveGen;
    try {
      let entries;
      try {
        entries = sessionManager.getEntries?.() ?? [];
      } catch {
        return;
      }
      let cwdRoot;
      if (typeof sessionCwd === "string" && sessionCwd.length > 0) {
        try {
          const probe = await liveRunGit(sessionCwd, ["rev-parse", "--show-toplevel"]);
          if (probe && probe.code === 0 && typeof probe.stdout === "string") {
            const top = probe.stdout.trim();
            if (top.length > 0) cwdRoot = top;
          }
        } catch { /* best effort: a failure here is non-fatal */ }
      }
      const roots = liveResolveScopeRoots(entries, sessionId, cwdRoot);
      const summary = await liveSummarizeRoots(roots);
      if (gen !== liveGen || !rootSession) return;
      if (!summary.ok) return;
      changes = { files: summary.files, added: summary.added, deleted: summary.deleted };
      schedulePublish();
    } finally {
      liveInFlight = false;
      if (liveQueued) {
        liveQueued = false;
        if (gen === liveGen) void liveRefreshChanges();
      }
    }
  }

  function resetSessionState() {
    pendingCalls.clear();
    tasks.clear();
    choiceActive = false;
    questionActive = false;
    questionnaireActive = false;
    permissionPending.clear();
    askToolCalls.clear();
    runningTools.clear();
    uiPromptActive = false;
    askIntentId = undefined;
    reviewCalls.clear();
    reviewActive = false;
    reviewId = undefined;
    presenceReconciler = createPresenceReconciler();
    nativePending = null;
    nativeSending = null;
    nativeLastOk = undefined;
    clearSettledPending();
    doneExpiry = undefined;
    donePending = false;
    sawActivity = false;
    turnSettled = false;
    jobsSnapshot = undefined;
    clearJobsExpiry();
    errorCode = undefined;
    toolErrors = 0;
    liveGen += 1;
    liveInFlight = false;
    liveQueued = false;
    sessionReportPending = null;
    sessionCwd = undefined;
    settleCtx = undefined;
    quietBeats = 0;
    lostSettleBeats = 0;
    changes = { files: 0, added: 0, deleted: 0 };
    agentActive = false;
    settled = false;
    turnSettled = false;
  }

  function clearEmittedLabel() {
    if (emittedLabel === undefined) return;
    emittedLabel = undefined;
    try {
      pi.events.emit(BLOCKED_EVENT, { active: false });
    } catch { /* best effort: a failure here is non-fatal */ }
  }

  // -- ask legs -------------------------------------------------------------

  pi.events.on(ASK_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === choiceActive) return;
    choiceActive = event.active;
    updateBlocker();
  });

  pi.events.on(QUESTIONNAIRE_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === questionnaireActive) return;
    questionnaireActive = event.active;
    updateBlocker();
  });

  // Native questionnaire leg (first-party ask_user_question): its own
  // boolean, OR-combined like the other two, so closing any one leg never
  // erases another still-open leg. All three share one intent episode.
  pi.events.on(ASK_QUESTION_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === questionActive) return;
    questionActive = event.active;
    updateBlocker();
  });

  pi.events.on(PERMISSION_EVENT, (event) => {
    if (!rootSession || !isRecord(event)) return;
    const { requestId, state } = event;
    if (typeof requestId !== "string" || requestId.length === 0) return;
    if (state === "waiting") {
      if (permissionPending.has(requestId)) return;
      permissionPending.add(requestId);
      updateBlocker();
    } else if (state === "approved" || state === "denied") {
      if (!permissionPending.delete(requestId)) return;
      updateBlocker();
    }
  });

  // -- generic tool-blocking UI prompt leg (state above) --

  pi.on("tool_execution_start", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolCallId !== "string") return;
    noteActivity();
    runningTools.add(event.toolCallId);
    // Structured ask tools open ONLY on genuine execution (never on
    // `tool_call` proposal), keyed by call id so the matching end or
    // result closes them.
    if (typeof event.toolName === "string" && ASK_TOOLS.has(event.toolName)) {
      lastAskToolName = event.toolName;
      askToolCalls.set(event.toolCallId, Date.now());
      if (askToolCalls.size > MAX_TRACKED_TASKS) {
        const oldest = askToolCalls.keys().next().value;
        askToolCalls.delete(oldest);
      }
      updateBlocker();
      schedulePublish();
    }
    // Review opens ONLY on actual acknowledged execution of a capture/group
    // tool. A `tool_call` proposal alone never opens — forecast-only calls,
    // correction-plan calls, `gentle_review` in any operation, and
    // `gentle_review_scope` never enter. Keyed by call id so the matching
    // end closes it.
    if (
      typeof event.toolName !== "string" ||
      !REVIEW_TOOLS.has(event.toolName) ||
      !isAcknowledgedCaptureArgs(event.args) ||
      reviewCalls.has(event.toolCallId)
    ) {
      return;
    }
    reviewCalls.set(event.toolCallId, Date.now());
    if (reviewCalls.size > MAX_TRACKED_TASKS) {
      const oldest = reviewCalls.keys().next().value;
      reviewCalls.delete(oldest);
    }
    syncReviewActive();
    updateBlocker();
    schedulePublish();
  });

  pi.on("tool_execution_end", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolCallId !== "string") return;
    runningTools.delete(event.toolCallId);
    // Abort/error ends with no tool_result still release: an executed ask
    // that never resolves must not latch ask.
    if (askToolCalls.delete(event.toolCallId)) {
      updateBlocker();
    }
    // Thrown/cancelled/error closes: the end seam clears a tracked
    // execution id even when its tool_result never arrives, so review
    // drops (and the principal row returns) on this beat, not the TTL —
    // zero grace, per-id overlap.
    if (reviewCalls.delete(event.toolCallId)) {
      const wasActive = reviewActive;
      syncReviewActive();
      if (reviewActive !== wasActive) updateBlocker();
      // NO GRACE coupling (same as the tool_result path): the token bytes
      // track the leg even when ask/error owns the visible label.
      schedulePublish();
    }
  });

  pi.on("ui_prompt_start", (event) => {
    if (!rootSession || uiPromptActive || runningTools.size === 0) return;
    // A `custom` prompt is a panel or overlay (agents view, ODD viewer, changes
    // view, design canvas), not a question: opening one is navigation and must
    // never change the session state. Ask stays reserved for real questions —
    // the choice/questionnaire/permission legs above and the ask tools tracked
    // by execution — so only the dialog kinds this leg exists for count.
    if (isRecord(event) && event.kind === "custom") return;
    uiPromptActive = true;
    updateBlocker();
  });

  pi.on("ui_prompt_end", () => {
    if (!rootSession || !uiPromptActive) return;
    uiPromptActive = false;
    updateBlocker();
  });

  // Neither the reserved hook (no producer) nor sidebar snapshots (entry
  // publishes fire before the forecast branch, so they prove no reviewer
  // route) are observed: no handlers are registered for either signal.

  // -- session changes -------------------------------------------------------
  // -- session changes -------------------------------------------------------

  pi.events.on(CHANGE_EVENT, (event) => {
    if (!rootSession || !isRecord(event)) return;
    if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
    refreshChanges();
    schedulePublish();
  });

  // S62 scope registration: a newly registered worktree affects the live
  // aggregate immediately (same trigger shape as the transcript event).
  pi.events.on("gentle-pi:session-worktree-changed", (event) => {
    if (!rootSession || !isRecord(event)) return;
    if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
    refreshChanges();
    schedulePublish();
  });

  // -- subagent activity -----------------------------------------------------

  // `subagent_run` carries the agent in its input, but `subagent_continue`
  // carries only `task_id`/`prompt`/`label`/`mode`: a resume names the task
  // whose record already holds the child's agent. Neither source means no
  // role evidence at all — the pending call still covers the blocking/
  // orchestrating marker, but it contributes no role and no name, and it
  // must never publish the launch-correlation placeholder as a role word.
  function launchInput(input) {
    if (!isRecord(input)) return undefined;
    const taskId = typeof input.task_id === "string" ? input.task_id : undefined;
    const inputAgent =
      typeof input.agent === "string" && input.agent.length > 0 ? input.agent : undefined;
    const agent =
      inputAgent ?? (taskId !== undefined ? tasks.get(taskId)?.agent : undefined);
    const labelSource =
      typeof input.label === "string" && input.label.length > 0 ? input.label : agent;
    const label = labelSource === undefined ? undefined : sanitizeLabel(labelSource, labelSource);
    return { agent: agent === undefined ? undefined : truncateChars(agent, MAX_LABEL_CHARS), label };
  }

  pi.on("tool_call", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolName !== "string") return;
    // A tool starting proves a run is alive: an error left over from a run that
    // already died is released here rather than sticking until the next turn.
    noteActivity();
    clearRunError();
    // Structured ask proposals never open ask (execution does); subagent
    // launch correlation below is unchanged.
    if (event.toolName === "subagent_run" || event.toolName === "subagent_continue") {
      const parsed = launchInput(event.input);
      if (!parsed || typeof event.toolCallId !== "string") return;
      pendingCalls.set(event.toolCallId, {
        ...parsed,
        at: Date.now(),
      });
      if (pendingCalls.size > MAX_TRACKED_TASKS) {
        const oldest = pendingCalls.keys().next().value;
        pendingCalls.delete(oldest);
      }
      schedulePublish();
    } else if (event.toolName === "subagent_cancel") {
      const taskId = isRecord(event.input) ? event.input.task_id : undefined;
      if (typeof taskId !== "string") return;
      const known = tasks.get(taskId);
      if (known) {
        // Progress/cancel bumps recency only; firstSeen never moves (T2b).
        tasks.set(taskId, { ...known, status: "cancelled", at: Date.now() });
        schedulePublish();
      }
    }
  });

  pi.on("tool_result", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolName !== "string") return;
    noteActivity();
    clearRunError();
    if (typeof event.toolCallId === "string" && askToolCalls.delete(event.toolCallId)) {
      updateBlocker();
    }
    const pending =
      typeof event.toolCallId === "string" ? pendingCalls.get(event.toolCallId) : undefined;
    const pendingResolved =
      typeof event.toolCallId === "string" ? pendingCalls.delete(event.toolCallId) : false;
    // A resolved launch releases the blocking-delegate marker on THIS beat,
    // not on the next periodic one: a failed/aborted launch carries no
    // gentleAgents details, so the record path below never publishes.
    if (pendingResolved) schedulePublish();
    // A launch resolution retires the settle-time pending guard: the
    // outcome is now covered by the task record (working via activeSubs),
    // the error latch (blocked), or genuine emptiness (idle on next beat).
    if (event.toolName === "subagent_run" || event.toolName === "subagent_continue") {
      clearSettledPending();
    }
    if (typeof event.toolCallId === "string" ? reviewCalls.delete(event.toolCallId) : false) {
      // The ended id was a known acknowledged execution; remaining tracked
      // executions keep their true state untouched.
      const wasActive = reviewActive;
      syncReviewActive();
      if (reviewActive !== wasActive) updateBlocker();
      // NO GRACE: a resolving review call changes the durable review token
      // even when a higher-priority leg (ask/error) owns the visible label
      // and updateBlocker() emits nothing — always republish so the clear
      // ships on this beat instead of lingering to the next beat/TTL.
      schedulePublish();
    } else if (REVIEW_TOOLS.has(event.toolName)) {
      const wasActive = reviewActive;
      syncReviewActive();
      if (reviewActive !== wasActive) updateBlocker();
    }
    const details = isRecord(event.details) ? event.details.gentleAgents : undefined;
    if (!isRecord(details) || typeof details.taskId !== "string") {
      // A tool that failed is detected and counted, and that is all: no label,
      // no native state, no finish hold, no notification.
      if (event.isError === true) recordToolFailure(`tool:${event.toolName}`);
      return;
    }
    const previous = tasks.get(details.taskId);
    // Never infer an active status: a missing status keeps the previous
    // record's status, else lands as unknown (never counted). The pending
    // record contributes only its label before it is deleted above.
    // firstSeen is immutable (T2b): set once at first sighting, preserved
    // across progress reads so they never reorder oldest-first display.
    // Epochs are untouched (T1): taskEpochFor still owns execution identity.
    // Interleave liveness guard: a racy non-final read (a status poll via
    // any tool other than the authoritative subagent_run/subagent_continue
    // launch outcomes) must never regress a live `running` record — a stale
    // `queued` observed while the principal works would otherwise erase the
    // running-only count/roles, flip the display to generic `gentle`, and
    // stick there after settle (queued-cover keeps the marker fresh while
    // the delegate still runs upstream). Only a FINAL status (completion
    // truth, still re-resolving oldest-first) may replace `running` from a
    // read; the authoritative drain path (T1 queued cover) is untouched.
    const incomingStatus =
      typeof details.status === "string" ? details.status : undefined;
    const isLaunchOutcome =
      event.toolName === "subagent_run" || event.toolName === "subagent_continue";
    let status = incomingStatus ?? (previous?.status ?? "unknown");
    let staleRead = false;
    if (
      !isLaunchOutcome &&
      previous?.status === "running" &&
      status !== "running" &&
      !FINAL_TASK.has(status)
    ) {
      status = "running";
      staleRead = true;
    }
    // LIVE-2: a background launch ack arrives QUEUED (the runner admits
    // QUEUED synchronously; the pump to RUNNING emits no tool_result and
    // live senders never emit a message_end ACTIVE start — completion is
    // the next signal). Recording the ack verbatim leaves the delegate
    // queued forever: count 0, no roles, marker-only. Promoting a
    // background-mode launch outcome to running is the only live start
    // evidence; task-mode queued stays uncounted (T2b, LIVE-2 guard).
    if (isLaunchOutcome && status === "queued" && details.mode === "background") {
      status = "running";
    }
    const incomingAgent =
      typeof details.agent === "string" && details.agent.length > 0
        ? truncateChars(details.agent, MAX_LABEL_CHARS)
        : undefined;
    // A stale read's agent is distrusted with its status, and a missing
    // agent keeps the previous record's agent (never reset to a guess).
    // With neither source the record has no agent at all: `subagent` is the
    // launch-correlation placeholder, never an identity, so inventing it here
    // would publish that word as the record's name.
    const agent =
      staleRead && previous?.agent
        ? previous.agent
        : (incomingAgent ?? previous?.agent);
    const now = Date.now();
    tasks.set(details.taskId, {
      agent,
      label: previous?.label ?? pending?.label ?? agent,
      status,
      at: now,
      firstSeen: typeof previous?.firstSeen === "number" ? previous.firstSeen : now,
      epoch: taskEpochFor(previous, status, event.toolName === "subagent_continue"),
    });
    if (tasks.size > MAX_TRACKED_TASKS) {
      const oldest = tasks.keys().next().value;
      tasks.delete(oldest);
    }
    if (status === "failed") recordToolFailure(`task:${details.taskId}`);
    schedulePublish();
  });

  // Background Gentle Agents lifecycle arrives as custom messages
  // (customType `gentle-agents.result`, details.gentleAgents
  // {taskId,agent,status}) rather than subagent_* tool_results: a
  // background START announces with an ACTIVE status (running|queued) and
  // enters the authoritative tasks map exactly like a task-mode record
  // (counted, oldest-first, settle-safe, cleared by its FINAL), while a
  // FINAL status replaces the record so the next beat counts only
  // running|queued as active; the rendered card is never parsed.
  // Waiting/unknown/other strings stay ignored (fail closed). This is the
  // background-mode tracking path: background launches run through
  // `subagent_run` with `mode: background`, so their TaskStore lifecycle
  // never passes through `tool_result` details.
  pi.on("message_end", (event) => {
    if (!rootSession || !isRecord(event)) return;
    noteActivity();
    const message = event.message;
    if (!isRecord(message)) return;
    if (message.role === "assistant") {
      // The one real error state. Pi derives `turn_end.outcome === "error"`
      // from exactly this stopReason, so a run that stopped on an error is
      // visible here without a second handler; any other assistant message
      // proves the run is alive again (a retry that succeeded) and releases
      // the label.
      if (message.stopReason === "error") setRunError();
      else clearRunError();
      return;
    }
    if (message.role !== "custom") return;
    if (message.customType !== AGENTS_RESULT_TYPE) return;
    const details = isRecord(message.details) ? message.details.gentleAgents : undefined;
    if (!isRecord(details) || typeof details.taskId !== "string") return;
    if (typeof details.status !== "string") return;
    if (!FINAL_TASK.has(details.status) && !ACTIVE_TASK.has(details.status)) return;
    const previous = tasks.get(details.taskId);
    // Same rule as the tool_result path: an observation without an agent keeps
    // the previous record's agent, and with neither there is no agent at all —
    // the launch-correlation placeholder must never become a record identity.
    const agent =
      typeof details.agent === "string" && details.agent.length > 0
        ? truncateChars(details.agent, MAX_LABEL_CHARS)
        : previous?.agent;
    // Record identity is immutable per taskId: firstSeen never moves (T2b
    // ordering only) whether this observation promotes a background start
    // or replaces the record with its terminal status; completion still
    // clears the count and re-resolves oldest-first.
    tasks.set(details.taskId, {
      agent,
      label: previous?.label ?? agent,
      status: details.status,
      at: Date.now(),
      firstSeen:
        typeof previous?.firstSeen === "number" ? previous.firstSeen : Date.now(),
      epoch: taskEpochFor(previous, details.status, false),
    });
    if (tasks.size > MAX_TRACKED_TASKS) {
      const oldest = tasks.keys().next().value;
      tasks.delete(oldest);
    }
    if (details.status === "failed") recordToolFailure(`background:${details.taskId}`);
    schedulePublish();
  });

  // -- agent lifecycle ---------------------------------------------------------

  pi.on("session_start", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    const nextId = (() => {
      try {
        return ctx?.sessionManager?.getSessionId?.();
      } catch {
        return undefined;
      }
    })();
    if (rootSession && typeof nextId === "string" && nextId !== sessionId) resetSessionState();
    rootSession = true;
    sessionManager = ctx.sessionManager;
    refreshSessionRef(ctx);
    retainContext(ctx);
    if (moshiEnabled()) moshiEnsureContext();
    // LIVE-1: bind the session before any state beat so Herdr attributes the
    // pane from the first frame (mirrors the managed publisher). The binding is
    // INITIATED here but not awaited: the host awaits this handler, and the
    // binding's own 500/1500 ms bound used to sit on the path to the first
    // prompt. Every beat awaits `sessionReportPending` first, so the binding
    // still lands ahead of the state it describes.
    startSessionReport(event?.reason);
    refreshChanges();
    agentActive = ctx?.isIdle?.() === false;
    settled = false;
    schedulePublish();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    refreshSessionRef(ctx);
    retainContext(ctx);
    // LIVE-1: re-bind the session like the managed publisher did, so a
    // restart or re-announcement never leaves the pane binding-less while
    // metadata beats flow.
    void reportSession();
    agentActive = true;
    settled = false;
    turnSettled = false;
    clearSettledPending();
    quietBeats = 0;
    noteActivity();
    clearRunError();
    refreshChanges();
    schedulePublish();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) return;
    retainContext(ctx);
    // Retain settle-time pending evidence for native gating before the
    // metadata hint clears (see nativeSettledPending above), bounded by the
    // finish hold this settle opens.
    const pendingAtSettle = pendingCalls.size > 0;
    pendingCalls.clear();
    applySettled(true);
    if (pendingAtSettle) {
      nativeSettledPending = true;
      nativeSettledPendingUntil = Date.now() + doneHoldMs();
    }
    // S62 turn-end: the working tree may have changed without transcript
    // evidence (external/untracked edits), so re-scan before publishing.
    refreshChanges();
    if (activeSubs().length === 0 && !askActiveNow() && !reviewActive && !errorCode) {
      clearEmittedLabel();
      void publishNow();
    } else {
      schedulePublish();
    }
  });

  pi.on("session_shutdown", () => {
    // Close the Moshi row before the session state is dropped. The host
    // awaits this handler, so the flush keeps the process alive until the
    // envelope lands (or the bound expires).
    if (moshiEnsureContext()) {
      moshiEmit("SessionEnd", {
        type: "session.closed",
        category: "session_ended",
        title: "Pi session ended",
      });
    }
    moshiContext = undefined;
    rootSession = false;
    if (beatTimer) {
      clearInterval(beatTimer);
      beatTimer = undefined;
    }
    if (emittedLabel !== undefined) {
      emittedLabel = undefined;
      try {
        pi.events.emit(BLOCKED_EVENT, { active: false });
      } catch { /* best effort: a failure here is non-fatal */ }
    }
    resetSessionState();
    return moshiFlushSends(1000);
  });
}
