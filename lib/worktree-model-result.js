'use strict';
// T8/S12 model-facing half: compact, agent-useful result text for the five
// own worktree tools.
//
// The extension's execute() prints one raw line per fact (for a listing:
// `worktree list: <name> <branch> thread=<id> issues=<csv> odd=<csv>` per
// checkout). That shape spends the agent's context on thread ids and on the
// list of ODD documents a checkout HAPPENS TO HOLD, which the agent can
// discover by reading files when it actually needs them. This module builds
// the model-facing text from the SAME `details` object execute() already
// returns, so:
//
//   * `details` (and every other result field) is preserved byte for byte —
//     the UI card and runtime callers keep their contract;
//   * only the text content is replaced, and non-text content (images and
//     anything else) survives in place;
//   * an error, partial, malformed or unrecognized result is returned
//     UNCHANGED — a failure's prose is its diagnostics, and this module
//     never turns "not enough structured evidence" into an invented
//     success.
//
// Text style (chosen once, used everywhere): short `label: value` rows with
// a stable order, plus one `·`-separated row per checkout for listings whose
// field order is declared in the header line. No key=value dumps, no quoted
// path prose, no repeated title, no truncation: values are emitted whole.
//
// Free of side effects: no filesystem, network, registry, process or timing
// access, so it can run inside any execute() wrapper.
//
// ASSIGNED vs AVAILABLE ODD (S2/S6/S8): `details.worktrees[].odd` is the
// checkout's AVAILABLE document inventory, not the assigned association, so
// it is NEVER printed and the first item is NEVER inferred as the assigned
// one. The assigned document is printed only from a scalar the details
// actually carry: `details.odd` for a worktree_upsert, and
// `details.worktrees[].assignedOdd` for a listing — the extension publishes
// the stored registry value (a document path, or null when the checkout is
// known to hold none). A row whose producer supplies no `assignedOdd` at all
// is UNKNOWN, so its odd cell is omitted rather than asserted empty; an
// explicit null prints `-`.

const WORKTREE_MODEL_TOOLS = [
  'worktree_upsert',
  'worktree_list',
  'worktree_close',
  'worktree_session_open',
  'worktree_warp',
];

// ANSI SGR/OSC-8 sequences and C0/C1 controls (multi-line structure is
// irrelevant here: every value is folded onto one line).
const ANSI_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const LIST_LEGEND = 'name · branch · path · kind · status · associations';

// One-line, escape-free, whitespace-folded value. Branch names and paths are
// untrusted input: a raw escape or newline must never reshape a row.
function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

function asRecord(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

// Mirrors lib/worktree-git.js slugifyBranch and the extension's slugPart, so
// the model text names the same identifier `warp`/`close` accept.
function slugify(value) {
  const slug = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'worktree' : slug;
}

function baseName(value) {
  const text = clean(value).replace(/\/+$/, '');
  if (text.length === 0) return '';
  const parts = text.split('/');
  return parts[parts.length - 1];
}

// S6 association convention: issue numbers carry `#` and a known-empty
// association reads `-` instead of being indistinguishable from "unknown".
function issuesCell(issues) {
  const numbers = Array.isArray(issues)
    ? issues.filter((number) => typeof number === 'number' && Number.isFinite(number))
    : [];
  return numbers.length === 0 ? '-' : numbers.map((number) => `#${number}`).join(', ');
}

function outcomeOfUpsert(details) {
  if (details.updated === true) return 'updated';
  if (details.created === false) return 'already existed';
  return 'created';
}

// Warnings are already the summarized, agent-useful form the extension
// produced (failed hook steps, pruned stale records, dropped legacy
// associations). They are kept verbatim, deduplicated, and never replaced by
// raw hook/command output. `pruneError` is a bare reason string, so it is
// added only when no warning already carries it; a FAILED creation-hook step
// is added the same way from its own detail line, so a hook failure stays
// visible even if the warning list ever stops summarizing it. Skipped steps
// and stdout are never copied: they cost context and the warnings already say
// what matters.
function warningRows(details) {
  const rows = [];
  const seen = [];
  // A warning the extension already summarized is kept once, verbatim.
  const pushNew = (text) => {
    if (text.length === 0 || seen.includes(text)) return;
    seen.push(text);
    rows.push(`warning: ${text}`);
  };
  // A bare reason field is dropped when a warning already carries it.
  const pushDerived = (text) => {
    if (text.length === 0 || seen.some((known) => known.includes(text))) return;
    pushNew(text);
  };
  const warnings = Array.isArray(details.warnings) ? details.warnings : [];
  for (const warning of warnings) pushNew(clean(warning));
  pushDerived(clean(details.pruneError));
  const hooks = asRecord(details.hooks);
  const steps = Array.isArray(hooks.steps) ? hooks.steps : [];
  for (const step of steps) {
    const record = asRecord(step);
    if (record.status !== 'failed') continue;
    pushDerived(clean(record.detail));
  }
  return rows;
}

function upsertRows(details) {
  const branch = clean(details.branch);
  const target = clean(details.path);
  if (branch.length === 0 && target.length === 0) return null;
  const name = branch.length > 0 ? slugify(branch) : baseName(target);
  const rows = [`outcome: ${outcomeOfUpsert(details)}`];
  if (name.length > 0) rows.push(`name: ${name}`);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  if (target.length > 0) rows.push(`path: ${target}`);
  rows.push(`issues: ${issuesCell(details.issues)}`);
  // The ONE assigned document lives in `details.odd` as a normalized scalar
  // (a path or `odd/<name>.md`). A null/'' value is a known "no association";
  // an absent field is unknown and prints nothing.
  const assigned = clean(details.odd);
  if (assigned.length > 0) rows.push(`odd: ${assigned}`);
  else if (details.odd === null || details.odd === '') rows.push('odd: -');
  if (details.changesRegistered === true) rows.push('changes: registered');
  rows.push(...warningRows(details));
  return rows;
}

function listRows(details) {
  if (!Array.isArray(details.worktrees)) return null;
  const entries = details.worktrees;
  const count = typeof details.count === 'number' && Number.isFinite(details.count)
    ? details.count
    : entries.length;
  const rows = [entries.length > 0 ? `worktrees: ${count} (${LIST_LEGEND})` : `worktrees: ${count}`];
  for (const entry of entries) {
    const row = asRecord(entry);
    const name = clean(row.name) || baseName(row.path);
    const cells = [
      name,
      clean(row.branch),
      clean(row.path),
      clean(row.kind),
      clean(row.status),
    ].filter((cell) => cell.length > 0);
    if (cells.length === 0) continue;
    cells.push(`issues ${issuesCell(row.issues)}`);
    // ONLY the scalar the extension supplies; the available-document
    // inventory (row.odd) is deliberately never printed and never mined for
    // this. A stored null is a KNOWN empty association (S6 reads it `-`); an
    // absent field is unknown and prints nothing.
    if (row.assignedOdd === null) cells.push('odd -');
    else {
      const assigned = clean(row.assignedOdd);
      if (assigned.length > 0) cells.push(`odd ${assigned}`);
    }
    rows.push(cells.join(' · '));
  }
  rows.push(...warningRows(details));
  return rows;
}

function closeRows(details) {
  const branch = clean(details.branch);
  const target = clean(details.path);
  if (branch.length === 0 && target.length === 0) return null;
  const name = branch.length > 0 ? slugify(branch) : baseName(target);
  const rows = ['outcome: removed'];
  if (name.length > 0) rows.push(`name: ${name}`);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  if (target.length > 0) rows.push(`path: ${target}`);
  rows.push(`branch state: ${details.branchKept === false ? 'deleted' : 'kept'}`);
  // A pre-removal warp is part of the outcome: the caller's session is no
  // longer where it was, so the destination must stay visible.
  const warp = asRecord(details.warp);
  const warpTarget = [clean(warp.name), clean(warp.path)].filter((part) => part.length > 0).join(' · ');
  if (warpTarget.length > 0) rows.push(`session: warped to ${warpTarget}`);
  // A skipped or partially reconciled Herdr workspace never fails the close,
  // so its status (and the notice explaining it) has to reach the agent.
  const workspace = asRecord(details.herdrWorkspace);
  const workspaceStatus = clean(workspace.status);
  if (workspaceStatus.length > 0) {
    const notice = clean(workspace.notice);
    rows.push(notice.length > 0 ? `herdr workspace: ${workspaceStatus} · ${notice}` : `herdr workspace: ${workspaceStatus}`);
  }
  rows.push(...warningRows(details));
  return rows;
}

function sessionOpenRows(details) {
  const worktree = clean(details.worktree);
  const session = clean(details.sessionId);
  const target = clean(details.path);
  if (worktree.length === 0 && session.length === 0 && target.length === 0) return null;
  const rows = [`outcome: ${details.resumed === true ? 'resumed' : 'opened'}`];
  if (worktree.length > 0) rows.push(`worktree: ${worktree}`);
  const branch = clean(details.branch);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  if (target.length > 0) rows.push(`path: ${target}`);
  // The session id, workspace and pane are the routing ids a caller needs to
  // reach the session it just started; the agent name names the agent.
  if (session.length > 0) rows.push(`session: ${session}`);
  const workspace = clean(details.workspaceId);
  if (workspace.length > 0) rows.push(`workspace: ${workspace}`);
  const pane = clean(details.paneId);
  if (pane.length > 0) rows.push(`pane: ${pane}`);
  const agent = clean(details.agentName);
  if (agent.length > 0) rows.push(`agent: ${agent}`);
  rows.push(...warningRows(details));
  return rows;
}

function warpRows(details) {
  const name = clean(details.name);
  const target = clean(details.path);
  if (name.length === 0 && target.length === 0) return null;
  const rows = [`outcome: ${details.alreadyThere === true ? 'already there' : 'moved'}`];
  const source = [clean(details.fromName), clean(details.from)].filter((part) => part.length > 0).join(' · ');
  if (source.length > 0) rows.push(`from: ${source}`);
  // `to` carries the continuation target: the name the next call accepts and
  // the absolute path the session now works in.
  const destination = [name, target].filter((part) => part.length > 0).join(' · ');
  if (destination.length > 0) rows.push(`to: ${destination}`);
  const branch = clean(details.branch);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  rows.push(...warningRows(details));
  return rows;
}

const ROW_BUILDERS = {
  worktree_upsert: upsertRows,
  worktree_list: listRows,
  worktree_close: closeRows,
  worktree_session_open: sessionOpenRows,
  worktree_warp: warpRows,
};

// Replace every text entry with ONE formatted entry at the position of the
// first one, keeping non-text entries (images, …) untouched and in order. The
// caller guarantees at least one text entry (hasTextContent below).
function rebuildContent(content, text) {
  const entries = [];
  let placed = false;
  for (const entry of content) {
    if (entry && entry.type === 'text' && typeof entry.text === 'string') {
      if (!placed) {
        entries.push({ ...entry, text });
        placed = true;
      }
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function hasTextContent(content) {
  return content.some((entry) => entry && entry.type === 'text' && typeof entry.text === 'string');
}

/**
 * Format one own worktree tool result for the model.
 *
 * @param {string} toolName One of WORKTREE_MODEL_TOOLS.
 * @param {object} result The tool result ({content, details, isError?}).
 * @returns {object} The same result with the text content replaced when the
 *   tool is known, the result is a successful structured one, and the details
 *   carry enough evidence; otherwise the INPUT UNCHANGED (same reference).
 */
function formatWorktreeModelResult(toolName, result) {
  if (typeof toolName !== 'string' || !Object.prototype.hasOwnProperty.call(ROW_BUILDERS, toolName)) {
    return result;
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  // A failure's prose IS its diagnostics, and a partial result is not
  // settled: both are returned untouched rather than reformatted.
  if (result.isError === true || result.isPartial === true) return result;
  const content = result.content;
  if (!Array.isArray(content) || !hasTextContent(content)) return result;
  const details = result.details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return result;
  const rows = ROW_BUILDERS[toolName](details);
  if (rows === null || rows.length === 0) return result;
  return { ...result, content: rebuildContent(content, rows.join('\n')) };
}

module.exports = {
  formatWorktreeModelResult,
  WORKTREE_MODEL_TOOLS,
};
