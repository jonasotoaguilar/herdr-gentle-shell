'use strict';
// Writer half of the S16 Performance trace.
//
// Two plugin-owned files in the resolved plugin state directory — the same
// resolution as lib/worktree-mode.js (GENTLE_STATUS_STATE_DIR, else
// HERDR_PLUGIN_STATE_DIR when it already holds our files, else
// $XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents, else the home fallback
// that module uses), so the panel and the trace can never disagree:
//
//   gentle-perf-trace.json   { version: 1, enabled: boolean } — the switch
//   perf-trace.jsonl         one JSON object per line — the trace
//   perf-trace.1.jsonl       the single previous log, created on rotation
//
// Fail-closed in both directions. A missing OR malformed flag means DISABLED, so
// a broken file never starts writing, and writeTraceMode refuses to replace a
// flag it could not parse. Every event is reduced to a per-kind ALLOWLIST
// before it is serialized, so a caller can pass whatever it has and still never
// leak prompt text, paths or tool output into a log the user may share.
//
// What this can and cannot record (S16a): the four-switch snapshot, this
// package's own view render timings and its daemon poll timings. Pi's own
// renderer is not instrumented here.
//
// No shell, no child process, no dependency beyond the state-dir resolution and
// the performance-key list this package already owns.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const modeLib = require('./worktree-mode.js');
const { PERF_KEYS } = require('./pi-perf-settings.js');

const TRACE_VERSION = 1;
const FLAG_NAME = 'gentle-perf-trace.json';
const LOG_NAME = 'perf-trace.jsonl';
const ROTATED_NAME = 'perf-trace.1.jsonl';

// A traced line is an envelope plus a handful of numbers and short names, so a
// 2 KiB line is already generous; a pathological field cannot bloat the log.
const MAX_LINE_BYTES = 2000;
// One long session of render and daemon events fits in 256 KiB, and rotation
// keeps the total disk cost at exactly twice that, forever.
const MAX_LOG_BYTES = 256 * 1024;
const TRUNCATION_MARKER = '[truncated]';
const TEMP_ATTEMPTS = 10;
const CREATE_MODE = 0o600;

const KINDS = Object.freeze(['session', 'render', 'daemon']);
const RENDER_VIEWS = Object.freeze(['warp', 'odd', 'issues', 'create']);
const SUPPORT_STATES = Object.freeze(['declared', 'absent', 'unknown']);
const RENDER_MEASURES = Object.freeze(['ms', 'width', 'height', 'rows']);
const DAEMON_MEASURES = Object.freeze(['ms', 'panes', 'tokens']);

// state dir -> the last flag verdict read there. The trace exists to measure
// performance, so its hot path must not re-read and re-parse the flag on every
// event; the entry points that change the flag refresh this cache instead.
const cache = new Map();

function message(err) {
  return err && err.message ? err.message : String(err);
}

function resetTraceCacheForTests() {
  cache.clear();
}

function asEnv(env) {
  if (env === undefined) return process.env;
  if (env !== null && typeof env === 'object') return env;
  return null;
}

// Every entry point goes through here, because "never throws" includes a caller
// that hands over a missing or nonsensical env.
function resolvePaths(env) {
  const usable = asEnv(env);
  if (usable === null) {
    return { ok: false, path: '', error: 'a state environment object is required' };
  }
  let dir;
  try {
    dir = modeLib.stateDir(usable);
  } catch (err) {
    return { ok: false, path: '', error: `cannot resolve the plugin state directory: ${message(err)}` };
  }
  return {
    ok: true,
    dir,
    flag: path.join(dir, FLAG_NAME),
    log: path.join(dir, LOG_NAME),
    rotated: path.join(dir, ROTATED_NAME),
  };
}

function tracePath(env = process.env) {
  const resolved = resolvePaths(env);
  return resolved.ok ? resolved.log : '';
}

function readFlag(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { enabled: false, reason: 'missing' };
    return { enabled: false, reason: 'unreadable' };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { enabled: false, reason: 'malformed' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { enabled: false, reason: 'malformed' };
  if (doc.version !== TRACE_VERSION || typeof doc.enabled !== 'boolean') return { enabled: false, reason: 'malformed' };
  return doc.enabled ? { enabled: true, reason: 'enabled' } : { enabled: false, reason: 'disabled' };
}

function readTraceMode(env = process.env) {
  const resolved = resolvePaths(env);
  if (!resolved.ok) return { enabled: false, path: '', reason: 'unresolved' };
  const verdict = readFlag(resolved.flag);
  return { enabled: verdict.enabled, path: resolved.flag, reason: verdict.reason };
}

// Unique temp file plus rename, the same shape as lib/pi-perf-settings.js: an
// interrupted write leaves the previous flag intact and no partial JSON behind.
function writeAtomic(target, text) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let lastError = null;
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
    const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`);
    let fd = null;
    try {
      fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, CREATE_MODE);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        lastError = err;
        continue;
      }
      throw err;
    }
    try {
      fs.writeSync(fd, text);
      fs.closeSync(fd);
      fd = null;
      fs.chmodSync(tmp, CREATE_MODE);
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        // Best-effort descriptor cleanup.
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Best-effort temp cleanup.
      }
      throw err;
    }
    return;
  }
  throw lastError || new Error('could not create a unique temporary file');
}

function writeTraceMode(enabled, env = process.env) {
  const resolved = resolvePaths(env);
  if (!resolved.ok) return { ok: false, changed: false, path: '', error: resolved.error };
  const file = resolved.flag;
  if (typeof enabled !== 'boolean') {
    const got = enabled === null ? 'null' : Array.isArray(enabled) ? 'array' : typeof enabled;
    return { ok: false, changed: false, path: file, error: `trace mode must be a boolean, got ${got}` };
  }
  const current = readFlag(file);
  // A file this module cannot parse is never replaced with a guess: the user
  // gets the error and the bytes stay put, so no trace starts on a silent
  // "repair" of a file the panel was not allowed to understand.
  if (current.reason === 'malformed' || current.reason === 'unreadable') {
    return {
      ok: false,
      changed: false,
      path: file,
      error: `refusing to overwrite ${file}: it is not a valid version ${TRACE_VERSION} trace flag; fix or remove it first`,
    };
  }
  if (current.reason === (enabled ? 'enabled' : 'disabled')) {
    return { ok: true, changed: false, path: file, error: null };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify({ version: TRACE_VERSION, enabled })}\n`);
  } catch (err) {
    return { ok: false, changed: false, path: file, error: `cannot write trace flag ${file}: ${message(err)}` };
  }
  cache.set(resolved.dir, { enabled, reason: enabled ? 'enabled' : 'disabled' });
  return { ok: true, changed: true, path: file, error: null };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMeasure(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// The four switches are the only keys that may appear, so a renamed or invented
// key is dropped instead of turning the snapshot into a place to leak data.
function pickSwitches(source, accept) {
  if (!isPlainObject(source)) return undefined;
  const out = {};
  for (const key of PERF_KEYS) {
    if (accept(source[key])) out[key] = source[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickMeasures(source, keys) {
  const out = {};
  for (const key of keys) {
    if (isMeasure(source[key])) out[key] = source[key];
  }
  return out;
}

function allowlisted(kind, fields) {
  const source = isPlainObject(fields) ? fields : {};
  if (kind === 'session') {
    const out = {};
    if (typeof source.piVersion === 'string' && source.piVersion.length > 0) out.piVersion = source.piVersion;
    const perf = pickSwitches(source.perf, (value) => typeof value === 'boolean');
    if (perf) out.perf = perf;
    const support = pickSwitches(source.support, (value) => SUPPORT_STATES.includes(value));
    if (support) out.support = support;
    return out;
  }
  if (kind === 'render') {
    const out = {};
    if (RENDER_VIEWS.includes(source.view)) out.view = source.view;
    return Object.assign(out, pickMeasures(source, RENDER_MEASURES));
  }
  if (kind === 'daemon') return pickMeasures(source, DAEMON_MEASURES);
  return {};
}

// Never drop an event, and never emit half a JSON line: an oversized event
// becomes a stub that names the loss, so a reader can tell "too big to record"
// from "never happened".
function encodeLine(record) {
  const text = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_LINE_BYTES) return text;
  return `${JSON.stringify({
    at: record.at,
    kind: record.kind,
    truncated: true,
    marker: TRUNCATION_MARKER,
    bytes,
  })}\n`;
}

// Rotation replaces the single previous generation instead of appending to it,
// so a long session cannot grow the trace past two files.
function appendLine(resolved, text) {
  const bytes = Buffer.byteLength(text);
  let size = 0;
  try {
    size = fs.statSync(resolved.log).size;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (size > 0 && size + bytes > MAX_LOG_BYTES) fs.renameSync(resolved.log, resolved.rotated);
  fs.mkdirSync(resolved.dir, { recursive: true });
  // Synchronous on purpose: a line is small, and a lost or interleaved line
  // would corrupt the comparison this feature exists for.
  fs.appendFileSync(resolved.log, text, { mode: CREATE_MODE });
}

function traceEvent(kind, fields, env = process.env) {
  const resolved = resolvePaths(env);
  if (!resolved.ok) return { written: false, path: '', reason: 'unresolved' };
  if (!KINDS.includes(kind)) return { written: false, path: resolved.log, reason: 'unknown-kind' };

  let verdict = cache.get(resolved.dir);
  if (!verdict) {
    verdict = readFlag(resolved.flag);
    cache.set(resolved.dir, verdict);
  }
  if (!verdict.enabled) return { written: false, path: resolved.log, reason: verdict.reason };

  const record = Object.assign({ at: new Date().toISOString(), kind }, allowlisted(kind, fields));
  const text = encodeLine(record);
  try {
    appendLine(resolved, text);
  } catch (err) {
    return { written: false, path: resolved.log, reason: `write-failed: ${message(err)}` };
  }
  return { written: true, path: resolved.log, reason: 'written' };
}

module.exports = {
  TRACE_VERSION,
  FLAG_NAME,
  LOG_NAME,
  ROTATED_NAME,
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  TRUNCATION_MARKER,
  KINDS,
  RENDER_VIEWS,
  SUPPORT_STATES,
  tracePath,
  readTraceMode,
  writeTraceMode,
  traceEvent,
  resetTraceCacheForTests,
};
