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
// What this can and cannot record (S16a/S18): the four-switch snapshot, the
// identity of the run that wrote it (run id on every line, plus pid, uptime and
// the host TUI mode on the session line), this package's own view render
// timings, the observer/host/event-loop context that surrounds one of those
// frames, the Pi PROCESS cost (RSS, heap, CPU) sampled at an interval, and its
// daemon poll timings. Pi's own renderer is not instrumented here: the public
// host surface exposes a full-redraw COUNTER but no render-duration observer,
// so a full-host duration is recorded as absent rather than derived from the
// counter.
//
// No shell, no child process, no dependency beyond the state-dir resolution and
// the performance-key list this package already owns.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const modeLib = require('./worktree-mode.js');
const { PERF_KEYS, readValues, readHostValues } = require('./pi-perf-settings.js');

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

const KINDS = Object.freeze(['session', 'render', 'observer', 'resource', 'daemon']);
const RENDER_VIEWS = Object.freeze(['warp', 'odd', 'issues', 'create', 'detail']);
const SUPPORT_STATES = Object.freeze(['declared', 'absent', 'unknown']);
const HOST_TUI_MODES = Object.freeze(['fullscreen', 'regular']);
const RENDER_MEASURES = Object.freeze(['ms', 'width', 'height', 'rows']);
const DAEMON_MEASURES = Object.freeze(['ms', 'panes', 'tokens']);

// Bounds for the observer sample. Every value is a duration in ms or a count,
// so a nonsense clock or a hostile host cannot put a 10^12 number — or a
// negative one — into a log a user may share.
const APPEND_CAP_MS = 60000;
const COUNTER_CAP = 1e9;
const LOOP_WINDOW_CAP_MS = 3600000;
const MAX_APPENDS = 100;
// Process-resource samples. Memory is reported in MB and CPU in ms, both
// bounded so a nonsense clock or a hostile host cannot put a 10^12 number into
// a log a user may share. CPU may legitimately exceed 100% on a multi-core
// host, so its own cap is wider than a ratio.
const MEMORY_CAP_MB = 100000;
const CPU_CAP_MS = 1e9;
const CPU_PERCENT_CAP = 100000;
const UPTIME_CAP_MS = 1e10;
const PID_CAP = 4194304;
const DEFAULT_RESOURCE_INTERVAL_MS = 1000;

// One run = one Pi process. Every line carries this id, so a rotated log with two
// interleaved processes still groups correctly, and a comparison never mixes a
// baseline with the run that followed it. Short on purpose: it rides on every
// record and the line budget is 2 KiB.
const RUN_ID = `${process.pid.toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

// state dir -> { sig, verdict }. The trace exists to measure performance, so
// its hot path must not re-read and re-parse the flag on every event. `sig` is
// the flag file's identity (inode, size, mtime) taken by one stat: the flag is
// written by a DIFFERENT process than the one that reads it (the panel in Pi
// versus this daemon), so a verdict cached without that check would freeze the
// first read forever and leave the feature inert until a restart.
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

// One stat per call decides whether the cached verdict still describes the
// file on disk. A flag written by another process changes this signature, so
// the next event re-reads instead of trusting a stale answer.
function flagSignature(file) {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'missing';
    return 'unreadable';
  }
}

function cachedFlag(resolved) {
  const sig = flagSignature(resolved.flag);
  const hit = cache.get(resolved.dir);
  if (hit && hit.sig === sig) return hit.verdict;
  const verdict = sig === 'missing'
    ? { enabled: false, reason: 'missing' }
    : sig === 'unreadable'
      ? { enabled: false, reason: 'unreadable' }
      : readFlag(resolved.flag);
  cache.set(resolved.dir, { sig, verdict });
  return verdict;
}

function readTraceMode(env = process.env) {
  const resolved = resolvePaths(env);
  if (!resolved.ok) return { enabled: false, path: '', reason: 'unresolved' };
  const verdict = cachedFlag(resolved);
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
  // Drop rather than seed: the next read re-stats, so the cache can never
  // disagree with bytes another process may have written in between.
  cache.delete(resolved.dir);
  return { ok: true, changed: true, path: file, error: null };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMeasure(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function within(value, min, max) {
  return isMeasure(value) && value >= min && value <= max;
}

function isCount(value, min, max) {
  return within(value, min, max) && Number.isInteger(value);
}

// Durations keep three decimals and ratios four: enough to tell runs apart,
// small enough that a line stays a line.
function roundTo(value, digits) {
  if (!isMeasure(value)) return undefined;
  return Number(value.toFixed(digits));
}

function defaultNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
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
    // Run identity, supplied by traceSession only: which process ran, for how
    // long, and which TUI it drove. A value outside the bounds is not an
    // identity, so it is dropped instead of written.
    if (isCount(source.pid, 1, PID_CAP)) out.pid = source.pid;
    if (within(source.uptimeMs, 0, UPTIME_CAP_MS)) out.uptimeMs = source.uptimeMs;
    if (HOST_TUI_MODES.includes(source.tuiMode)) out.tuiMode = source.tuiMode;
    return out;
  }
  if (kind === 'render') {
    const out = {};
    if (RENDER_VIEWS.includes(source.view)) out.view = source.view;
    return Object.assign(out, pickMeasures(source, RENDER_MEASURES));
  }
  // The observer sample is context for a frame, never a second render timing:
  // the component duration stays on the `render` line above.
  if (kind === 'observer') {
    const out = {};
    if (RENDER_VIEWS.includes(source.view)) out.view = source.view;
    if (isCount(source.frame, 1, COUNTER_CAP)) out.frame = source.frame;
    if (isCount(source.measuredAppends, 0, MAX_APPENDS)) out.measuredAppends = source.measuredAppends;
    if (within(source.prevAppendMs, 0, APPEND_CAP_MS)) out.prevAppendMs = source.prevAppendMs;
    if (SUPPORT_STATES.includes(source.hostFullRedrawsState)) out.hostFullRedrawsState = source.hostFullRedrawsState;
    if (SUPPORT_STATES.includes(source.hostRenderMsState)) out.hostRenderMsState = source.hostRenderMsState;
    if (isCount(source.hostFullRedraws, 0, COUNTER_CAP)) out.hostFullRedraws = source.hostFullRedraws;
    if (isCount(source.hostFullRedrawsDelta, 0, COUNTER_CAP)) out.hostFullRedrawsDelta = source.hostFullRedrawsDelta;
    if (within(source.processLoopUtilization, 0, 1)) out.processLoopUtilization = source.processLoopUtilization;
    if (SUPPORT_STATES.includes(source.processLoopState)) out.processLoopState = source.processLoopState;
    for (const key of ['processLoopActiveMs', 'processLoopIdleMs', 'processLoopWindowMs']) {
      if (within(source[key], 0, LOOP_WINDOW_CAP_MS)) out[key] = source[key];
    }
    return out;
  }
  // Process resource sample. `frames` counts traced frames since the previous
  // sample, the memory fields are MB and the CPU fields milliseconds; every
  // value is a non-negative reading under its cap, never a derived guess.
  if (kind === 'resource') {
    const out = {};
    if (isCount(source.frames, 0, COUNTER_CAP)) out.frames = source.frames;
    for (const key of ['rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB']) {
      if (within(source[key], 0, MEMORY_CAP_MB)) out[key] = source[key];
    }
    for (const key of ['cpuUserMs', 'cpuSystemMs']) {
      if (within(source[key], 0, CPU_CAP_MS)) out[key] = source[key];
    }
    if (within(source.windowMs, 0, LOOP_WINDOW_CAP_MS)) out.windowMs = source.windowMs;
    if (within(source.cpuPercent, 0, CPU_PERCENT_CAP)) out.cpuPercent = source.cpuPercent;
    return out;
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
    run: record.run,
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

  const verdict = cachedFlag(resolved);
  if (!verdict.enabled) return { written: false, path: resolved.log, reason: verdict.reason };

  const record = Object.assign({ at: new Date().toISOString(), kind }, allowlisted(kind, fields));
  // Assigned last, from the module constant, so a caller passing its own `run`
  // cannot split one process's records into two runs.
  record.run = RUN_ID;
  const text = encodeLine(record);
  try {
    appendLine(resolved, text);
  } catch (err) {
    return { written: false, path: resolved.log, reason: `write-failed: ${message(err)}` };
  }
  return { written: true, path: resolved.log, reason: 'written' };
}

// The four switches as they take effect: a key absent from settings.json is
// the OFF default the panel already reports, so the snapshot always carries
// all four booleans and two runs are comparable field by field. A settings
// file this module cannot read leaves the field out entirely, so the log never
// claims a snapshot it did not see.
function readSwitchValues(env) {
  try {
    const read = readValues(PERF_KEYS, env);
    if (!read || read.ok !== true) return undefined;
    const out = {};
    for (const key of PERF_KEYS) out[key] = read.values[key] === true;
    return out;
  } catch {
    return undefined;
  }
}

// Run identity for the session snapshot: the pid and uptime identify this Pi
// process, and the host TUI mode (read-only from settings.json) says which
// renderer the numbers belong to. Unreadable or out-of-bounds values are left
// out, so the log never claims an identity it did not observe.
function hostIdentity(env) {
  const identity = { pid: process.pid };
  try {
    const uptimeMs = roundTo(Number(process.uptime()) * 1000, 1);
    if (within(uptimeMs, 0, UPTIME_CAP_MS)) identity.uptimeMs = uptimeMs;
  } catch {
    // No uptime reading, no uptime field.
  }
  try {
    const host = readHostValues(env);
    if (host && host.ok === true && HOST_TUI_MODES.includes(host.values.tuiMode)) {
      identity.tuiMode = host.values.tuiMode;
    }
  } catch {
    // A settings file this module cannot read is not a tui mode.
  }
  return identity;
}

// The S16 session snapshot: the four-switch state plus, per key, whether the
// installed Pi build declares the setting at all. Written at session start and
// again whenever the switches change, so each run in the log is identified by
// the snapshot that precedes it. Only runs while the trace is enabled: the
// support scan reads the whole installed package, which a disabled trace must
// never pay for.
function traceSession(env = process.env, options = {}) {
  const resolved = resolvePaths(env);
  if (!resolved.ok) return { written: false, path: '', reason: 'unresolved' };
  const verdict = cachedFlag(resolved);
  if (!verdict.enabled) return { written: false, path: resolved.log, reason: verdict.reason };
  const opts = isPlainObject(options) ? options : {};
  const fields = Object.assign({ perf: readSwitchValues(env) }, hostIdentity(env));
  let support = opts.support;
  let piVersion = opts.piVersion;
  if (support === undefined) {
    let scan = null;
    try {
      scan = typeof opts.scan === 'function'
        ? opts.scan(env)
        : require('./pi-perf-support.js').scanSupport({ env });
    } catch {
      // A scanner that cannot load or run leaves the evidence out; the
      // snapshot still records the switches it could read.
      scan = null;
    }
    if (isPlainObject(scan) && isPlainObject(scan.keys)) {
      support = {};
      for (const key of PERF_KEYS) {
        const entry = scan.keys[key];
        if (entry && SUPPORT_STATES.includes(entry.state)) support[key] = entry.state;
      }
      if (piVersion === undefined && typeof scan.piVersion === 'string' && scan.piVersion.length > 0) {
        piVersion = scan.piVersion;
      }
    }
  }
  if (isPlainObject(support)) fields.support = support;
  if (typeof piVersion === 'string' && piVersion.length > 0) fields.piVersion = piVersion;
  return traceEvent('session', fields, env);
}

// What the PUBLIC root host object exposes about its own rendering. `fullRedraws`
// is a counter, so it is recorded as a count with the state that describes how it
// was obtained — never converted into a duration. Pi's public host surface
// (`pi-tui` 1.4 `dist/tui.d.ts`: `fullRedraws`, `renderNow`, `requestRender`,
// `addInputListener`) publishes no render-duration observer, so a full-host frame
// duration can only come from a future public core hook: it is reported as
// absent while the host is inspectable and unknown when it is not.
function readHostCapabilities(host) {
  if (host === null || host === undefined || (typeof host !== 'object' && typeof host !== 'function')) {
    return { fullRedrawsState: 'unknown', renderMsState: 'unknown' };
  }
  let raw;
  try {
    raw = host.fullRedraws;
  } catch {
    // A throwing getter means the surface could not be read, which is not the
    // same claim as "the host does not have it".
    return { fullRedrawsState: 'unknown', renderMsState: 'unknown' };
  }
  const caps = { renderMsState: 'absent' };
  if (raw === undefined || raw === null) return Object.assign({ fullRedrawsState: 'absent' }, caps);
  if (!within(raw, 0, COUNTER_CAP)) return Object.assign({ fullRedrawsState: 'unknown' }, caps);
  return Object.assign({ fullRedrawsState: 'declared', fullRedraws: Math.floor(raw) }, caps);
}

// Process-level, not component-level: `eventLoopUtilization` counts this Node
// process's event-loop active/idle time since start, so a delta between two
// samples describes the interval between them. It is not a frame latency and not
// a host render time. `monitorEventLoopDelay` would report real loop delay, but
// it needs a running interval timer, and a trace must not add one; loading
// perf_hooks happens only when a frame is actually sampled, so the disabled path
// never touches it.
function readLoopSample() {
  try {
    const { performance } = require('node:perf_hooks');
    const sample = performance.eventLoopUtilization();
    if (!isPlainObject(sample) || !isMeasure(sample.active) || !isMeasure(sample.idle)) return null;
    return { active: sample.active, idle: sample.idle };
  } catch {
    return null;
  }
}

// Two ELU samples -> the bounded delta for the interval between them plus the
// state that says whether the interval is real. A missing, backwards or absurd
// reading yields no numbers. A zero window may precede event-loop bootstrap,
// so it is unknown, never evidence of either missing support or healthy 0% load.
function loopInterval(previous, next) {
  if (!isPlainObject(next) || !isMeasure(next.active) || !isMeasure(next.idle)) return { state: 'unknown', fields: {} };
  if (!isPlainObject(previous)) return { state: undefined, fields: {} };
  const active = next.active - previous.active;
  const idle = next.idle - previous.idle;
  if (!isMeasure(active) || !isMeasure(idle) || active < 0 || idle < 0) return { state: 'unknown', fields: {} };
  const windowMs = active + idle;
  if (windowMs <= 0) return { state: 'unknown', fields: {} };
  if (windowMs > LOOP_WINDOW_CAP_MS) return { state: 'unknown', fields: {} };
  return {
    state: 'declared',
    fields: {
      processLoopUtilization: roundTo(Math.min(1, active / windowMs), 4),
      processLoopActiveMs: roundTo(active, 3),
      processLoopIdleMs: roundTo(idle, 3),
      processLoopWindowMs: roundTo(windowMs, 3),
    },
  };
}

function sampleOrNull(sampleLoop) {
  try {
    const sample = sampleLoop();
    return isPlainObject(sample) && isMeasure(sample.active) && isMeasure(sample.idle) ? sample : null;
  } catch {
    return null;
  }
}

// Process resource samplers. Both defaults are guarded: a host where either
// fails leaves the field out of the sample instead of writing a zero that would
// later be averaged as a real measurement.
function readMemorySample() {
  const usage = process.memoryUsage();
  return isPlainObject(usage) ? usage : null;
}

function readCpuSample() {
  const usage = process.cpuUsage();
  return isPlainObject(usage) ? usage : null;
}

function guardedSample(sample) {
  try {
    const value = sample();
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function megabytes(bytes) {
  if (!isMeasure(bytes) || bytes < 0) return undefined;
  return roundTo(bytes / (1024 * 1024), 1);
}

function microsecondsToMs(micros) {
  if (!isMeasure(micros) || micros < 0) return undefined;
  return roundTo(micros / 1000, 1);
}

// The per-view frame observer: one `render` line carrying the component's own
// duration, one `observer` line carrying the context that a package render
// timing cannot answer — what the trace writes themselves cost, what the public
// host counter did, and how busy the process event loop was between samples —
// and, at most once per interval, one `resource` line with the Pi process cost
// (memory and CPU) that the switches are supposed to move.
//
// The append cost is TRAILING on purpose: a write cannot report its own
// duration without inventing it, so each sample carries the measured cost of the
// previous sample's writes (and `measuredAppends` says how many). Nothing here
// is sampled or read while the trace is off at runtime either: an unwritten
// render ends the frame before the host, the loop or the process is touched.
function createFrameObserver(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const view = RENDER_VIEWS.includes(opts.view) ? opts.view : undefined;
  const host = opts.host;
  const terminalRows = typeof opts.terminalRows === 'function' ? opts.terminalRows : () => undefined;
  const nowMs = typeof opts.nowMs === 'function' ? opts.nowMs : defaultNowMs;
  const sampleLoop = typeof opts.sampleLoop === 'function' ? opts.sampleLoop : readLoopSample;
  const sampleMemory = typeof opts.sampleMemory === 'function' ? opts.sampleMemory : readMemorySample;
  const sampleCpu = typeof opts.sampleCpu === 'function' ? opts.sampleCpu : readCpuSample;
  const resourceIntervalMs = within(opts.resourceIntervalMs, 0, LOOP_WINDOW_CAP_MS)
    ? opts.resourceIntervalMs
    : DEFAULT_RESOURCE_INTERVAL_MS;
  const state = {
    frame: 0,
    appends: 0,
    appendMs: 0,
    fullRedraws: undefined,
    loop: null,
    framesSinceResource: 0,
    resourceAt: undefined,
    resourceBaseline: false,
    cpu: null,
  };

  // Brackets one write with the injected clock and adds it to the trailing
  // total the NEXT sample reports. A clock that fails or goes backwards records
  // no cost instead of a guessed one.
  function measured(fn) {
    let started;
    try {
      started = nowMs();
    } catch {
      started = undefined;
    }
    const verdict = fn();
    if (!isMeasure(started)) return verdict;
    let ended;
    try {
      ended = nowMs();
    } catch {
      ended = undefined;
    }
    if (!isMeasure(ended) || ended < started) return verdict;
    state.appends += 1;
    state.appendMs += ended - started;
    return verdict;
  }

  function frame(fields) {
    const source = isPlainObject(fields) ? fields : {};
    // Nothing measured in THIS frame may reach THIS sample: the trailing total
    // is what the previous frame's writes already cost.
    const carriedAppends = state.appends;
    const carriedMs = state.appendMs;
    state.appends = 0;
    state.appendMs = 0;
    const verdict = measured(() => traceEvent('render', {
      view,
      ms: roundTo(source.ms, 3),
      width: source.width,
      height: terminalRows(),
      rows: source.rows,
    }, opts.env));
    if (!verdict || verdict.written !== true) {
      // Disabled, unresolved or a failed append: no sample, and no host read or
      // loop read for a frame the log will not describe.
      state.appends = 0;
      state.appendMs = 0;
      return verdict;
    }

    state.frame += 1;

    const caps = readHostCapabilities(host);
    const nextLoop = sampleOrNull(sampleLoop);
    const interval = loopInterval(state.loop, nextLoop);
    if (nextLoop) state.loop = nextLoop;
    const delta = caps.fullRedraws === undefined || state.fullRedraws === undefined
      ? undefined
      : caps.fullRedraws - state.fullRedraws;
    if (caps.fullRedraws !== undefined) state.fullRedraws = caps.fullRedraws;

    const sampleVerdict = measured(() => traceEvent('observer', Object.assign({
      view,
      frame: state.frame,
      measuredAppends: carriedAppends,
      prevAppendMs: carriedAppends > 0 ? roundTo(carriedMs, 3) : undefined,
      hostFullRedrawsState: caps.fullRedrawsState,
      hostRenderMsState: caps.renderMsState,
      hostFullRedraws: caps.fullRedraws,
      hostFullRedrawsDelta: within(delta, 0, COUNTER_CAP) ? delta : undefined,
      processLoopState: interval.state,
    }, interval.fields), opts.env));
    if (sampleVerdict && sampleVerdict.written === true) maybeResource();
    return verdict;
  }

  // One process resource sample. The baseline is written with the first traced
  // frame so even a short run has a starting RSS and CPU; later samples wait
  // for `resourceIntervalMs` and carry the wall time they cover. CPU values are
  // this process's cumulative readings, so the run summary can report exactly
  // how much CPU the session consumed, while `cpuPercent` uses the difference
  // between two readings over the measured window.
  function maybeResource() {
    state.framesSinceResource += 1;
    const baseline = !state.resourceBaseline;
    let now;
    try {
      now = nowMs();
    } catch {
      now = undefined;
    }
    if (!baseline) {
      // Without two readable clock values there is no interval to claim.
      if (!isMeasure(now) || !isMeasure(state.resourceAt)) return;
      const elapsed = now - state.resourceAt;
      if (!isMeasure(elapsed) || elapsed < resourceIntervalMs) return;
    }

    const memory = guardedSample(sampleMemory);
    const cpu = guardedSample(sampleCpu);
    const fields = { frames: state.framesSinceResource };
    if (memory) {
      fields.rssMB = megabytes(memory.rss);
      fields.heapUsedMB = megabytes(memory.heapUsed);
      fields.heapTotalMB = megabytes(memory.heapTotal);
      fields.externalMB = megabytes(memory.external);
    }
    if (!baseline && isMeasure(now) && isMeasure(state.resourceAt)) {
      const windowMs = roundTo(now - state.resourceAt, 1);
      if (within(windowMs, 0, LOOP_WINDOW_CAP_MS)) fields.windowMs = windowMs;
      const userDelta = cpu && state.cpu && isMeasure(cpu.user) ? cpu.user - state.cpu.user : undefined;
      const systemDelta = cpu && state.cpu && isMeasure(cpu.system) ? cpu.system - state.cpu.system : undefined;
      if (
        fields.windowMs > 0
        && isMeasure(userDelta) && isMeasure(systemDelta)
        && userDelta >= 0 && systemDelta >= 0
      ) {
        const percent = roundTo((100 * ((userDelta + systemDelta) / 1000)) / fields.windowMs, 1);
        if (within(percent, 0, CPU_PERCENT_CAP)) fields.cpuPercent = percent;
      }
    }
    if (cpu) {
      fields.cpuUserMs = microsecondsToMs(cpu.user);
      fields.cpuSystemMs = microsecondsToMs(cpu.system);
      if (isMeasure(cpu.user) && isMeasure(cpu.system)) state.cpu = { user: cpu.user, system: cpu.system };
    }

    measured(() => traceEvent('resource', fields, opts.env));

    // The counter restarts from the sample, and an unreadable clock leaves
    // `resourceAt` unset so no later sample claims a window it never measured.
    state.framesSinceResource = 0;
    state.resourceBaseline = true;
    if (isMeasure(now)) state.resourceAt = now;
  }

  return { frame };
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
  HOST_TUI_MODES,
  RUN_ID,
  tracePath,
  readTraceMode,
  writeTraceMode,
  traceEvent,
  traceSession,
  createFrameObserver,
  resetTraceCacheForTests,
};
