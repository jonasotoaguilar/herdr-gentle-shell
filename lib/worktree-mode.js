'use strict';
// Shared worktree mode flag (P2-S1 foundation).
//
// A JSON mode file in the plugin state directory, default enabled (same
// shape and resolution as the sidebar's in lib/gentle-sidebar.js) —
// GENTLE_STATUS_STATE_DIR first (HERDR_PLUGIN_STATE_DIR as fallback),
// else $XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents. Missing means
// enabled; malformed content never enables.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Stored state segment. Deliberately NOT renamed with the S15 plugin id
// (herdr-gentle-shell): the rename keeps the existing directory so
// upgrades keep their mode flag with no migration step. Note this
// constant alone does NOT preserve override behavior: HERDR_PLUGIN_STATE_DIR
// is Herdr-injected and changes with the plugin id, so stateDir() below
// falls back to the stored dir when the injected one holds none of our
// files (same decision as the sidebar/daemon/diagnostics resolvers).
const PLUGIN_ID = 'herdr-gentle-agents';
const MODE_VERSION = 1;
const MODE_NAME = 'gentle-worktree-mode.json';
// The other two "Plugin tools" toggles (ODD command, Issues command). They
// share one file with their own keys so each flip is independent, and both
// live in the same state directory as the legacy worktree flag. Missing means
// enabled: both commands were registered unconditionally before the toggles
// existed, so an upgrade must not disable them.
const PLUGIN_TOOLS_VERSION = 1;
const PLUGIN_TOOLS_NAME = 'gentle-plugin-tools.json';
// Family of files proving a state dir is ours. This list intentionally
// extends the sidebar/daemon/diagnostics family with the worktree flag
// itself: a stored dir holding ONLY this flag (a worktree-only toggle by
// a user who never ran the installer or touched the other switches) must
// still win over an empty injected dir. That is also why this module does
// not reuse lib/gentle-sidebar.js's stateDir: its probe set cannot see
// this file, and requiring that heavier module would add a cross-lib
// dependency for wrong semantics. No new dependency is introduced here.
const STATE_KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
  'gentle-plugin-tools.json',
];

function storedStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'herdr')
    : path.join(os.homedir(), '.local', 'state', 'herdr');
  return path.join(base, 'plugins', PLUGIN_ID);
}

function dirHasKnownFiles(dir) {
  for (const name of STATE_KNOWN_FILES) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // A single unreadable entry never decides; keep scanning.
    }
  }
  return false;
}

function stateDir(env = process.env) {
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  // Historical quirk, preserved exactly: an explicit-but-empty (or
  // non-string) value ignores every override and uses the stored default.
  // This differs from the sidebar/daemon/diagnostics resolvers, which
  // consider the injected dir in that case (admitted in the prior S15
  // handoff and reported for independent verification); the delta is not
  // extended here.
  if (explicit !== undefined && explicit !== null) return storedStateDir(env);
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  const stored = storedStateDir(env);
  if (typeof injected !== 'string' || injected.length === 0) return stored;
  if (injected === stored) return injected;
  try {
    if (dirHasKnownFiles(injected)) return injected;
    if (dirHasKnownFiles(stored)) return stored;
  } catch {
    // Fall through to the injected dir on unexpected failure.
  }
  return injected;
}

function modePath(env = process.env) {
  return path.join(stateDir(env), MODE_NAME);
}

// Read one JSON state document from `file`, or the given verdicts for a
// missing (`ENOENT`) and an unreadable/unparseable file.
function readJsonState(file, onMissing, onFailure) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return onMissing;
    return onFailure;
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return onFailure;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return onFailure;
  return doc;
}

function writeStateFile(file, payload, label) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Inspect the destination BEFORE writing: writeFileSync follows a
  // symlink, so a symlinked state path would overwrite its target. A
  // symlinked or non-regular destination is refused and nothing is
  // touched. The normal path stays atomic: a sibling temp file renamed
  // into place.
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write ${label}: ${file} is a symlink; remove it or replace it with a regular file first`);
    }
    if (!stat.isFile()) {
      throw new Error(`refusing to write ${label}: ${file} is not a regular file`);
    }
  }
  // The sibling temp file is created exclusively (`wx`) with an
  // unpredictable suffix so a planted symlink or file is never followed
  // or reused: on collision a new name is retried a bounded number of
  // times, then the write is refused with a clear message.
  let tmp = null;
  let wrote = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix;
    try {
      suffix = crypto.randomBytes(8).toString('hex');
    } catch (err) {
      throw new Error(`cannot write ${label} ${file}: cannot generate a temporary file name: ${(err && err.message) || err}`);
    }
    tmp = `${file}.tmp.${process.pid}.${Date.now()}.${suffix}`;
    try {
      fs.writeFileSync(tmp, payload, { flag: 'wx' });
      wrote = true;
      break;
    } catch (err) {
      // A non-EEXIST failure may still have created the temp file
      // (e.g. ENOSPC mid-write): unlink it best-effort so a failed
      // write never leaves litter behind, then rethrow (never success).
      const failedTmp = tmp;
      tmp = null;
      if (err && err.code === 'EEXIST') continue;
      if (failedTmp) {
        try {
          fs.unlinkSync(failedTmp);
        } catch {
          // Best effort: the rethrow below is what matters.
        }
      }
      throw err;
    }
  }
  if (!wrote || !tmp) {
    throw new Error(`cannot write ${label} ${file}: could not create a unique temporary file after 10 attempts; refusing to follow or reuse an existing path`);
  }
  try {
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Either renamed (gone) or never created; nothing to clean.
    }
  }
}

function writeMode(enabled, env = process.env) {
  writeStateFile(modePath(env), `${JSON.stringify({ version: MODE_VERSION, enabled: Boolean(enabled) })}\n`, 'worktree mode');
}

// Missing means enabled (compatibility); malformed never enables.
function readMode(env = process.env) {
  const doc = readJsonState(
    modePath(env),
    { state: 'missing', enabled: true },
    { state: 'malformed', enabled: false },
  );
  if (doc.state === 'missing' || doc.state === 'malformed') return doc;
  if (doc.version !== MODE_VERSION || typeof doc.enabled !== 'boolean') return { state: 'malformed', enabled: false };
  return doc.enabled ? { state: 'enabled', enabled: true } : { state: 'disabled', enabled: false };
}

// ---------------------------------------------------------------------------
// Plugin tools toggles (ODD command, Issues command)
//
// Two keys in one document, and a copy can sit in two places: the SHARED
// CANONICAL source (the explicit `GENTLE_STATUS_STATE_DIR`, else the stored
// pre-rename dir — the one path every session computes identically, plain Pi or
// Herdr) and a legacy copy in Herdr's injected dir, left behind by an older
// writer. A read that silently preferred one of them FAILED OPEN: a copy with
// the toggles DISABLED became invisible as soon as the other directory held any
// other state file, and a missing toggle file means enabled.
//
// The rules implemented below:
//  * every location that holds the file is read, canonical first; one existing
//    copy always wins over the other location's absence;
//  * two copies that both parse and DISAGREE are AMBIGUOUS: the disagreeing
//    keys read as disabled, the verdict carries an actionable diagnostic
//    naming both files; a flip of a disputed key is refused rather than
//    silently picking or overwriting either copy, while a flip of an UNDISPUTED
//    key still lands (each copy keeps its own value for the disputed one);
//  * a copy that does not parse holds no information, so the parseable copies
//    decide and the next write repairs the unreadable one; when NO copy parses
//    both toggles fail closed exactly as a single malformed file always did;
//  * a write guarantees the CANONICAL path (created when it is the only thing
//    missing) and rewrites every other copy that already exists — never to a
//    third location, and never to the legacy worktree file. Writing the
//    canonical path is what keeps the state out of an injected dir a plain
//    session cannot discover;
//  * flipping ONE toggle is a read-merge-write inside a lock taken for the
//    canonical path and every legacy copy that exists (see the lock comment
//    below; a lock per *resolved* dir serialized nothing, because a Herdr
//    session writes the stored copy a plain session resolved).
//    Waiting is async (never `Atomics.wait`, never a synchronous sleep, so the
//    event loop keeps running), locks are taken in one deterministic order and
//    released in reverse (so two sessions cannot wait on each other), and a
//    lock is only ever removed when the process that owns it is proven gone —
//    plus a token check around the commit, so a lock taken over mid-update can
//    never produce a lost update.
// ---------------------------------------------------------------------------
const PLUGIN_TOOLS_LOCK_NAME = 'gentle-plugin-tools.lock';
const LOCK_VERSION = 1;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 20;
const LOCK_BREAK_ATTEMPTS = 3;
const PLUGIN_TOOL_IDS = ['odd', 'issues'];

// The ONE source every session computes identically, whatever Herdr injects:
// the explicit override, else the stored dir (`$XDG_STATE_HOME/herdr/plugins/<id>`
// or the home fallback). `HERDR_PLUGIN_STATE_DIR` is deliberately NOT consulted
// here — a plain Pi session cannot discover an arbitrary injected dir, so a
// copy written there is invisible to it, and a missing toggle file means
// "enabled": the invisible copy would silently re-enable the command. Every
// writer therefore guarantees this path, and it is the default write target.
function pluginToolsCanonicalDir(env = process.env) {
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return storedStateDir(env);
}

function pluginToolsPath(env = process.env) {
  return path.join(pluginToolsCanonicalDir(env), PLUGIN_TOOLS_NAME);
}

// A copy an older writer published into Herdr's injected dir. It is READ so a
// value stored there is never lost and never re-enabled by a missing file, and
// it is kept in step by the sessions that can see it — but this module never
// creates one, so the state can no longer end up in the injected dir only. An
// explicit override keeps its documented single location.
function pluginToolsLegacyFiles(env = process.env) {
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (explicit !== undefined && explicit !== null) return [];
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  if (typeof injected !== 'string' || injected.length === 0) return [];
  const file = path.join(injected, PLUGIN_TOOLS_NAME);
  if (path.resolve(file) === path.resolve(pluginToolsPath(env))) return [];
  return [file];
}

// Canonical first: `files[0]` is always the shared source a flip creates.
function pluginToolsFiles(env = process.env) {
  return [pluginToolsPath(env), ...pluginToolsLegacyFiles(env)];
}

// One candidate file: `missing`, `ok` with its two booleans, or `unusable`
// with the reason. Never throws: an unreadable candidate is data, not a crash.
function readPluginToolsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { file, state: 'missing' };
    return { file, state: 'unusable', reason: (err && (err.code || err.message)) || 'unreadable' };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return { file, state: 'unusable', reason: 'not JSON' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { file, state: 'unusable', reason: 'not a JSON object' };
  }
  if (doc.version !== PLUGIN_TOOLS_VERSION) {
    return { file, state: 'unusable', reason: `unsupported version ${JSON.stringify(doc.version)}` };
  }
  if (typeof doc.odd !== 'boolean' || typeof doc.issues !== 'boolean') {
    return { file, state: 'unusable', reason: 'odd and issues must be booleans' };
  }
  return { file, state: 'ok', values: { odd: doc.odd, issues: doc.issues } };
}

function describeCopies(reads) {
  return reads.map((read) => `${read.file} (odd=${read.values.odd}, issues=${read.values.issues})`).join(' and ');
}

const PLUGIN_TOOL_LABELS = { odd: 'ODD command', issues: 'Issues command' };

function describeToolKeys(keys) {
  return keys.map((id) => PLUGIN_TOOL_LABELS[id] || id).join(' and ');
}

// The full verdict: per-key values, which copies exist, which keys are
// ambiguous, and one actionable sentence for the caller to show.
function readPluginToolsDetail(env = process.env) {
  const files = pluginToolsFiles(env);
  const reads = files.map(readPluginToolsFile);
  const present = reads.filter((read) => read.state !== 'missing');
  const usable = present.filter((read) => read.state === 'ok');
  const unusable = present.filter((read) => read.state !== 'ok');
  const base = {
    files,
    reads,
    path: files[0],
    paths: present.map((read) => read.file),
    odd: false,
    issues: false,
    conflicts: [],
    diagnostic: null,
  };
  if (present.length === 0) {
    return { ...base, state: 'missing', reason: 'missing', odd: true, issues: true };
  }
  if (usable.length === 0) {
    const named = unusable.map((read) => `${read.file} (${read.reason})`).join(' and ');
    return {
      ...base,
      state: 'malformed',
      reason: 'unreadable',
      conflicts: PLUGIN_TOOL_IDS.slice(),
      diagnostic: `the plugin tools state ${named} is unreadable, so the ODD command and Issues command toggles stay disabled. Flipping either one in /herdr-gentle:customize rewrites the file; deleting it also returns both toggles to their enabled default.`,
    };
  }
  const conflicts = [];
  const values = {};
  for (const id of PLUGIN_TOOL_IDS) {
    const seen = new Set(usable.map((read) => read.values[id]));
    if (seen.size > 1) {
      conflicts.push(id);
      values[id] = false;
    } else {
      values[id] = usable[0].values[id];
    }
  }
  if (conflicts.length > 0) {
    return {
      ...base,
      state: 'conflict',
      reason: 'disagreement',
      odd: values.odd,
      issues: values.issues,
      conflicts,
      diagnostic: `the ODD command and Issues command toggles are stored twice with different values: ${describeCopies(usable)}. ${describeToolKeys(conflicts)} stays disabled until the copies agree; flipping that toggle is refused and writes nothing, while flipping the other one still applies and each copy keeps its own value for the disputed key. Keep one copy — make both files identical, or delete the copy you do not want — then flip again.`,
    };
  }
  return {
    ...base,
    state: 'ok',
    reason: unusable.length > 0 ? 'unreadable' : 'ok',
    odd: values.odd,
    issues: values.issues,
    diagnostic: unusable.length > 0
      ? `the plugin tools state ${unusable.map((read) => `${read.file} (${read.reason})`).join(' and ')} is unreadable; the readable copy decides and the next flip rewrites the unreadable one.`
      : null,
  };
}

// Missing means both enabled, malformed never enables either. `state` reports
// which of those applied so a caller can tell a fresh default from a
// fail-closed read; `conflict` means two readable copies disagree.
function readPluginTools(env = process.env) {
  const detail = readPluginToolsDetail(env);
  if (detail.state === 'missing') return { state: 'missing', odd: true, issues: true };
  if (detail.state === 'malformed') return { state: 'malformed', odd: false, issues: false };
  if (detail.state === 'conflict') return { state: 'conflict', odd: detail.odd, issues: detail.issues };
  return { state: 'ok', odd: detail.odd, issues: detail.issues };
}

function pluginToolsPayload(values) {
  return `${JSON.stringify({ version: PLUGIN_TOOLS_VERSION, odd: Boolean(values.odd), issues: Boolean(values.issues) })}\n`;
}

// Refuse a destination the guarded writer cannot replace, BEFORE any copy is
// touched, so a two-copy write can never land half-applied.
function assertPluginToolsDestinations(files) {
  for (const file of files) {
    let stat = null;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write plugin tools: ${file} is a symlink; remove it or replace it with a regular file first`);
    }
    if (!stat.isFile()) {
      throw new Error(`refusing to write plugin tools: ${file} is not a regular file`);
    }
  }
}

function pluginToolsConflictError(detail) {
  return pluginToolsDisagreeError(detail, detail.conflicts);
}

// A flip that would have to overwrite a DIFFERING value for the very key it is
// changing: which copy the user means is unknowable, so the copies are left
// exactly as they are and the caller names both files. Flipping a key the
// copies agree on is still allowed (see updatePluginTools) — the disputed key's
// own values are preserved per copy, never guessed at.
function pluginToolsDisagreeError(detail, keys) {
  const usable = detail.reads.filter((read) => read.state === 'ok');
  const err = new Error(`the ODD command and Issues command toggles are stored twice with different values: ${describeCopies(usable)}. ${describeToolKeys(keys)} cannot be flipped until the copies agree, because the flip would overwrite a value this session cannot prove is stale — nothing was written to either file. Keep one copy — make both files identical, or delete the copy you do not want — then flip again.`);
  err.code = 'plugin_tools_state_conflict';
  return err;
}

// Every copy a write must touch: the canonical source ALWAYS (created when a
// first flip finds no copy at all), plus every other copy that already exists.
function pluginToolsWriteTargets(detail) {
  const targets = [detail.path];
  for (const read of detail.reads) {
    if (read.state === 'missing') continue;
    if (read.file === detail.path) continue;
    targets.push(read.file);
  }
  return targets;
}

// A write that failed after another copy had already been written. Truthful by
// construction: it names every path that already holds the new value, so the
// caller never reports "nothing changed" over a half-applied pair.
function pluginToolsPartialWriteError(file, written, cause) {
  const reason = (cause && cause.message) || String(cause);
  const writtenText = written.length > 0
    ? `already written: ${written.join(', ')}; those copies now hold the new value and the remaining copies were left untouched`
    : 'nothing was written';
  const err = new Error(`could not write the plugin tools state ${file}: ${reason} — ${writtenText}. Retry once the cause is fixed.`);
  err.code = 'plugin_tools_write_partial';
  err.failed = file;
  err.written = written.slice();
  return err;
}

// Whole-document write (both keys): the seeding/reset primitive. The canonical
// copy is always written (created when absent) and every copy that already
// exists is rewritten, so duplicates stay identical; a conflicting pair is
// refused instead of silently overwritten. It takes no lock because it is not a
// production writer — the toggles are only ever flipped through
// `updatePluginTools`, which is serialized against every other session.
function writePluginTools(values, env = process.env) {
  const detail = readPluginToolsDetail(env);
  if (detail.state === 'conflict') throw pluginToolsConflictError(detail);
  const targets = pluginToolsWriteTargets(detail);
  assertPluginToolsDestinations(targets);
  const payload = pluginToolsPayload({ odd: Boolean(values && values.odd), issues: Boolean(values && values.issues) });
  const written = [];
  for (const file of targets) {
    try {
      writeStateFile(file, payload, 'plugin tools');
    } catch (err) {
      throw pluginToolsPartialWriteError(file, written, err);
    }
    written.push(file);
  }
}

// --- the plugin tools family locks ----------------------------------------
//
// A flip READS every candidate copy and WRITES every copy that exists — but the
// set of copies a session can see depends on its environment: a Herdr session
// resolves the injected dir plus the stored one, while a plain Pi session (no
// `HERDR_PLUGIN_STATE_DIR`) resolves, and writes, only the stored copy. Both
// write that shared stored copy, so a lock per resolved state dir serialized
// nothing that mattered: the plain session held the stored dir's lock while the
// Herdr session held the injected dir's, both took their snapshot from the same
// shared copy, and one flip was lost (and, once the Herdr session had also
// rewritten its own copy, the pair was left disagreeing).
//
// Serialization therefore covers every path a flip WRITES: the canonical source
// (which every session computes identically, so plain and Herdr sessions always
// contend on the same lock) plus every legacy copy that exists and is rewritten
// in the same flip. Locks are taken in one global order (lexicographic by
// absolute path, identical in every process because the paths are) and released
// in reverse, which is what makes deadlock impossible: a session only ever waits
// on the next path in that order. Waiting is asynchronous and jittered, so the
// event loop keeps painting.

function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pluginToolsLockPathFor(dir) {
  return path.join(canonicalLockDir(dir), PLUGIN_TOOLS_LOCK_NAME);
}

// One identity per directory, whatever spelling a session's environment used
// (`/tmp/x` and `/private/tmp/x` are one directory with one lock). Reals paths
// only when the directory already exists; a directory about to be created keeps
// its resolved spelling, which is the same in every process that computes it.
function canonicalLockDir(dir) {
  const absolute = path.resolve(dir);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

// The lock beside the canonical copy: the one every session takes, plain or
// Herdr. It is also the lock a caller seeds to hold a plain session's flip.
function pluginToolsLockPath(env = process.env) {
  return pluginToolsLockPathFor(path.dirname(pluginToolsPath(env)));
}

// Every lock a flip must hold, deduplicated and in ONE order that does not
// depend on which of the two directories this environment resolved first: the
// canonical source always, plus every legacy copy that exists (a flip writes
// those too, and an older version of this module may be writing them).
function pluginToolsLockPaths(env = process.env) {
  const locks = [];
  const seen = new Set();
  for (const file of pluginToolsFiles(env)) {
    if (file !== pluginToolsPath(env) && !fs.existsSync(file)) continue;
    const lock = pluginToolsLockPathFor(path.dirname(file));
    if (seen.has(lock)) continue;
    seen.add(lock);
    locks.push(lock);
  }
  return locks.sort(comparePaths);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockHolder(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'gone' };
    return { state: 'unreadable', reason: (err && (err.code || err.message)) || 'unreadable' };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', reason: 'not JSON' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { state: 'unreadable', reason: 'not a JSON object' };
  if (typeof doc.token !== 'string' || typeof doc.pid !== 'number' || typeof doc.host !== 'string') {
    return { state: 'unreadable', reason: 'missing token, pid or host' };
  }
  return {
    state: 'ok',
    token: doc.token,
    pid: doc.pid,
    host: doc.host,
    startedAt: typeof doc.startedAt === 'string' ? doc.startedAt : 'an unknown time',
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to someone else.
    return !(err && err.code === 'ESRCH');
  }
}

// Remove a lock whose owner is proven gone — and only that lock. The lock is
// moved aside first and its token compared with the one that was judged
// abandoned: if a fresh owner created the path inside the window, what we
// moved is NOT the abandoned lock, so it is linked back (never overwriting a
// newer one) and the caller keeps waiting instead of stealing it.
function breakStaleLock(file, holder) {
  const probe = `${file}.stale.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(file, probe);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'gone';
    throw err;
  }
  let moved = null;
  try {
    moved = JSON.parse(fs.readFileSync(probe, 'utf8'));
  } catch {
    moved = null;
  }
  const same = moved && typeof moved.token === 'string' && moved.token === holder.token;
  if (!same) {
    try {
      fs.linkSync(probe, file);
    } catch {
      // The path is already taken again: the newer lock stays, ours is dropped.
    }
    try {
      fs.unlinkSync(probe);
    } catch {
      // Best effort: nothing else to do with the probe.
    }
    return 'raced';
  }
  try {
    fs.unlinkSync(probe);
  } catch {
    // Best effort: the renamed lock is already out of the way.
  }
  return 'broken';
}

function lockTimeoutError(file, holder, timeoutMs, lockCount) {
  const who = holder && holder.state === 'ok'
    ? `held by pid ${holder.pid} on ${holder.host} since ${holder.startedAt}`
    : holder && holder.state === 'unreadable'
      ? `present but unreadable (${holder.reason})`
      : 'present';
  const scope = lockCount > 1 ? ` (one of the ${lockCount} copies of the toggle state, which are always written together)` : '';
  return new Error(`another session is updating the plugin tools toggles: the lock ${file}${scope} is ${who}, and it was not released within ${timeoutMs}ms. Nothing was changed — retry in a moment. If no other session is running, delete that lock file.`);
}

// One lock, taken last in the set or alone. `deadline` is shared across the
// whole set, so a flip never waits longer than it always did.
async function acquirePluginToolsLockFile(file, options) {
  const { deadline, pollMs, timeoutMs, lockCount } = options;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  const payload = `${JSON.stringify({ version: LOCK_VERSION, token, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() })}\n`;
  let breaks = 0;
  let holder = { state: 'gone' };
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw new Error(`cannot lock the plugin tools state ${file}: ${(err && err.message) || err}`);
      }
    }
    if (fd !== null) {
      try {
        fs.writeFileSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return { file, token };
    }
    holder = lockHolder(file);
    // A lock is only broken on evidence of a dead owner on this host — never
    // because it looks old, and never one we cannot read.
    if (holder.state === 'ok' && holder.host === os.hostname() && !processIsAlive(holder.pid) && breaks < LOCK_BREAK_ATTEMPTS) {
      breaks += 1;
      breakStaleLock(file, holder);
      continue;
    }
    if (Date.now() >= deadline) throw lockTimeoutError(file, holder, timeoutMs, lockCount);
    await sleep(pollMs + Math.floor(Math.random() * pollMs));
  }
}

// Never delete a lock that is not ours any more.
function releasePluginToolsLockFile(lock) {
  const current = lockHolder(lock.file);
  if (current.state !== 'ok' || current.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.file);
  } catch {
    // Already gone: released either way.
  }
}

function releasePluginToolsLockFiles(held) {
  // Reverse order: the set was taken in one global order, so giving it back in
  // the opposite order keeps every waiter on a single consistent chain.
  for (let index = held.length - 1; index >= 0; index -= 1) {
    releasePluginToolsLockFile(held[index]);
  }
}

// Every lock a flip needs, taken in the set's deterministic order. A failure
// part-way through releases what was already taken, so a session that cannot
// proceed never leaves another session blocked on its leftovers.
async function acquirePluginToolsLocks(options = {}) {
  const env = options.env || process.env;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : LOCK_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs >= 0 ? options.pollMs : LOCK_POLL_MS;
  const files = pluginToolsLockPaths(env);
  const deadline = Date.now() + timeoutMs;
  const held = [];
  try {
    for (const file of files) {
      held.push(await acquirePluginToolsLockFile(file, { deadline, pollMs, timeoutMs, lockCount: files.length }));
    }
  } catch (err) {
    releasePluginToolsLockFiles(held);
    throw err;
  }
  return {
    // Ownership of EVERY lock is re-checked immediately before every copy is
    // written: a lock taken over mid-update then aborts instead of losing a flip.
    assertOwned(written) {
      for (const lock of held) {
        const current = lockHolder(lock.file);
        if (current.state === 'ok' && current.token === lock.token) continue;
        const writtenText = Array.isArray(written) && written.length > 0 ? ` (already written: ${written.join(', ')})` : '';
        throw new Error(`another session took over the plugin tools state lock ${lock.file} while this update was running; nothing more was written${writtenText} — retry the toggle.`);
      }
    },
    release() {
      releasePluginToolsLockFiles(held);
    },
  };
}

// Flip one or both toggles: acquire the family locks, re-read every copy, merge
// into the CURRENT values (never into a stale snapshot taken before the locks),
// and write the canonical source plus every other copy that exists. A key the
// copies already disagree about is not touched — that stays a human decision.
// Resolves with the written paths and with any copy the flip had to repair.
async function updatePluginTools(patch, options = {}) {
  const env = options.env || process.env;
  const wanted = {};
  for (const id of PLUGIN_TOOL_IDS) {
    if (patch && typeof patch[id] === 'boolean') wanted[id] = patch[id];
  }
  if (Object.keys(wanted).length === 0) {
    throw new Error('updatePluginTools needs a boolean odd and/or issues value; nothing was changed');
  }
  const lock = await acquirePluginToolsLocks({ ...options, env });
  try {
    const detail = readPluginToolsDetail(env);
    // Only the keys this flip actually changes can block it: a key the copies
    // already disagree about is a human decision, while an unrelated flip must
    // still work (a plain session cannot see the injected copy, so its flip
    // alone leaves one behind, and that must not freeze the other session).
    const readable = detail.reads.filter((read) => read.state === 'ok');
    const disputed = Object.keys(wanted).filter((id) => {
      const seen = new Set(readable.map((read) => read.values[id]));
      return seen.size > 1;
    });
    if (disputed.length > 0) throw pluginToolsDisagreeError(detail, disputed);
    // The value a copy keeps for the keys this flip does not change: its OWN
    // readable value, so nothing the user never touched is rewritten. A copy
    // without readable values (unparseable, or the canonical file being created
    // by a first flip) adopts the READ verdict instead — which is fail-closed,
    // so flipping ODD on an unreadable copy writes `issues: false`, never the
    // "missing means enabled" default, exactly as the read reported it.
    const authority = { odd: detail.odd === true, issues: detail.issues === true };
    const targets = pluginToolsWriteTargets(detail);
    const baseOf = (file) => {
      const own = detail.reads.find((read) => read.file === file);
      return own && own.state === 'ok' ? own.values : authority;
    };
    assertPluginToolsDestinations(targets);
    const written = [];
    for (const file of targets) {
      const next = { ...baseOf(file), ...wanted };
      lock.assertOwned(written);
      try {
        writeStateFile(file, pluginToolsPayload(next), 'plugin tools');
      } catch (err) {
        // Half a multi-copy write is a real state: the copies now disagree.
        // Name what landed instead of reporting only the failing path.
        throw pluginToolsPartialWriteError(file, written, err);
      }
      written.push(file);
    }
    const merged = { ...baseOf(detail.path), ...wanted };
    // A copy that did not parse was overwritten by this flip. That discards
    // whatever the user had in it, so the caller can report it instead of the
    // repair staying silent.
    const repaired = detail.reads
      .filter((read) => read.state !== 'ok' && read.state !== 'missing' && written.includes(read.file))
      .map((read) => read.file);
    return {
      state: 'ok',
      odd: merged.odd,
      issues: merged.issues,
      values: merged,
      path: written[0],
      paths: written,
      repaired,
    };
  } finally {
    try {
      lock.release();
    } catch {
      // A lock we cannot re-check is left for its next owner's liveness probe.
    }
  }
}

module.exports = {
  PLUGIN_ID,
  MODE_VERSION,
  PLUGIN_TOOLS_VERSION,
  PLUGIN_TOOLS_LOCK_NAME,
  stateDir,
  modePath,
  pluginToolsPath,
  pluginToolsFiles,
  pluginToolsLockPath,
  pluginToolsLockPaths,
  readMode,
  writeMode,
  readPluginTools,
  readPluginToolsDetail,
  writePluginTools,
  updatePluginTools,
};
