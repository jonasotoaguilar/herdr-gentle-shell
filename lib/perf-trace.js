'use strict';
// Writer half of the performance trace (S18/S24).
//
// Two plugin-owned files in the resolved plugin state directory:
// GENTLE_STATUS_STATE_DIR (explicit override), else
// $XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents, else
// ~/.local/state/herdr/plugins/herdr-gentle-agents — the stored dir wins
// whenever it holds any of our files, and HERDR_PLUGIN_STATE_DIR is used only
// when the stored dir holds none while that one does; one stray known file in
// the injected dir may never outrank the stored state. The stored canonical dir
// is the FINAL fallback, so a fresh install resolves the same directory in a
// context that receives the injected variable and one that never does. The
// resolution and its known-file family are byte-for-byte the ones the sidebar
// switch, the Herdr daemon and its diagnostics use, so all four read and write
// one directory per install — which is why it lives here rather than in a
// worktree module.
//
//   perf-trace.jsonl         one JSON object per line — the trace
//   perf-trace.1.jsonl       the single previous log, created on rotation
//
// Activation is a shell-level fact, never a UI option (S24): the trace is ON
// only when GENTLE_PERF_TRACE is exactly `1` or `true`. Every other value —
// absent, empty, `0`, anything else — leaves it OFF. The check reads the
// process environment and nothing else, so it cannot throw, cannot write and
// probes no file: a disabled trace costs one string comparison per event and
// creates no log, no directory and no scratch file.
//
// Every event is reduced to a per-kind ALLOWLIST before it is serialized, so a
// caller can pass whatever it has and still never leak prompt text, paths or
// tool output into a log the user may share.
//
// What this can and cannot record (S16a/S18): the identity of the run that
// wrote each line (run id on every line, plus pid, uptime and the host TUI mode
// on the session line), this package's own view render timings, the
// observer/host/event-loop context that surrounds one of those frames, the Pi
// PROCESS cost (RSS, heap, CPU) sampled at an interval, and its daemon poll
// timings. Pi's own renderer is not instrumented here: the public host surface
// exposes a full-redraw COUNTER but no render-duration observer, so a full-host
// duration is recorded as absent rather than derived from the counter.
//
// No shell, no child process and no dependency beyond the state-dir resolution
// this package already owns. The only host file it reads is settings.json,
// through the read-only lib/host-settings.js, for the tui mode.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readHostValues } = require('./host-settings.js');

// Files that prove a state dir is ours. This family is IDENTICAL in
// lib/gentle-sidebar.js, herdr-plugin/bin/gentle-status.js,
// herdr-plugin/lib/gentle-diagnostics.js and the producer extension; it keeps
// the retired worktree/plugin-tools flag names because an upgraded install
// still carries them, and a family that differs between consumers splits the
// state across two directories.
const STATE_SEGMENT = 'herdr-gentle-agents';
// The active plugin lookup id: what Herdr injects as HERDR_PLUGIN_STATE_DIR, and
// where a legacy install may still keep its live flags. Every context resolves
// it, not only the daemon that receives the variable.
const ACTIVE_PLUGIN_ID = 'herdr-gentle-shell';
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

function storedStateDir(env) {
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'herdr')
    : path.join(os.homedir(), '.local', 'state', 'herdr');
  return path.join(base, 'plugins', STATE_SEGMENT);
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

// The active-id dir: the injected one when this process has it, else the same
// sibling of the stored dir derived from the state home (the segment is the only
// difference, so the parent of the stored dir is the plugins dir).
function activeStateDir(env) {
  if (typeof env.HERDR_PLUGIN_STATE_DIR === 'string' && env.HERDR_PLUGIN_STATE_DIR.length > 0) {
    return env.HERDR_PLUGIN_STATE_DIR;
  }
  return path.join(path.dirname(storedStateDir(env)), ACTIVE_PLUGIN_ID);
}

// The explicit-but-empty (or non-string) override keeps using the stored
// default, so a trace log written before the injected dir was introduced is
// still the same file after an upgrade. The stored dir wins over the active-id
// (injected) one whenever it holds a known file: the daemon writes its pidfile
// into the dir it resolves, so one stray known file there would make the split
// self-perpetuating. The active-id dir wins only when the stored dir holds no
// known file and it does; the stored canonical dir is the final fallback, so a
// fresh install resolves the same dir with or without the injected variable.
function resolveStateDir(env) {
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const stored = storedStateDir(env);
  if (explicit !== undefined && explicit !== null) return stored;
  const active = activeStateDir(env);
  if (active === stored) return stored;
  try {
    if (dirHasKnownFiles(stored)) return stored;
    if (dirHasKnownFiles(active)) return active;
  } catch {
    // Fall through to the stored canonical dir on unexpected failure.
  }
  return stored;
}

const LOG_NAME = 'perf-trace.jsonl';
const ROTATED_NAME = 'perf-trace.1.jsonl';

// The two literals that switch the trace on. Anything else is OFF, including a
// variable that is present but empty, `0`, `yes` or a differently-cased value:
// a shell-level switch that half-accepts typos is worse than an exact one.
const ENABLED_VALUES = Object.freeze(['1', 'true']);
const ENABLE_VAR = 'GENTLE_PERF_TRACE';

// A traced line is an envelope plus a handful of numbers and short names, so a
// 2 KiB line is already generous; a pathological field cannot bloat the log.
const MAX_LINE_BYTES = 2000;
// One long session of render and daemon events fits in 256 KiB, and rotation
// keeps the total disk cost at exactly twice that, forever.
const MAX_LOG_BYTES = 256 * 1024;
const TRUNCATION_MARKER = '[truncated]';
const CREATE_MODE = 0o600;

const KINDS = Object.freeze(['session', 'render', 'observer', 'resource', 'daemon']);
const RENDER_VIEWS = Object.freeze(['warp', 'odd', 'issues', 'create', 'detail']);
// States of a host capability probe: whether the surface was read and found,
// read and missing, or could not be read at all.
const CAPABILITY_STATES = Object.freeze(['declared', 'absent', 'unknown']);
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

function message(err) {
  return err && err.message ? err.message : String(err);
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
    dir = resolveStateDir(usable);
  } catch (err) {
    return { ok: false, path: '', error: `cannot resolve the plugin state directory: ${message(err)}` };
  }
  return {
    ok: true,
    dir,
    log: path.join(dir, LOG_NAME),
    rotated: path.join(dir, ROTATED_NAME),
  };
}

// Is the trace switched on for this environment? Read from the process
// environment only, so it never touches the disk and never throws — including
// for a caller that hands over a missing or hostile env object.
function isTraceEnabled(env = process.env) {
  const usable = asEnv(env);
  if (usable === null) return false;
  let raw;
  try {
    raw = usable[ENABLE_VAR];
  } catch {
    return false;
  }
  return typeof raw === 'string' && ENABLED_VALUES.includes(raw);
}

function tracePath(env = process.env) {
  const resolved = resolvePaths(env);
  return resolved.ok ? resolved.log : '';
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
    if (CAPABILITY_STATES.includes(source.hostFullRedrawsState)) out.hostFullRedrawsState = source.hostFullRedrawsState;
    if (CAPABILITY_STATES.includes(source.hostRenderMsState)) out.hostRenderMsState = source.hostRenderMsState;
    if (isCount(source.hostFullRedraws, 0, COUNTER_CAP)) out.hostFullRedraws = source.hostFullRedraws;
    if (isCount(source.hostFullRedrawsDelta, 0, COUNTER_CAP)) out.hostFullRedrawsDelta = source.hostFullRedrawsDelta;
    if (within(source.processLoopUtilization, 0, 1)) out.processLoopUtilization = source.processLoopUtilization;
    if (CAPABILITY_STATES.includes(source.processLoopState)) out.processLoopState = source.processLoopState;
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

  if (!isTraceEnabled(env)) return { written: false, path: resolved.log, reason: 'disabled' };

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

// The session snapshot — what a run is, written at session start, so every run
// in the log is identified by the snapshot that precedes it. A caller that
// knows which Pi build is running passes it as `options.piVersion`; nothing
// here inspects the installed package.
function traceSession(env = process.env, options = {}) {
  const resolved = resolvePaths(env);
  if (!resolved.ok) return { written: false, path: '', reason: 'unresolved' };
  if (!isTraceEnabled(env)) return { written: false, path: resolved.log, reason: 'disabled' };
  const opts = isPlainObject(options) ? options : {};
  const fields = hostIdentity(env);
  if (typeof opts.piVersion === 'string' && opts.piVersion.length > 0) fields.piVersion = opts.piVersion;
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
// (memory and CPU) that a session actually consumed.
//
// The append cost is TRAILING on purpose: a write cannot report its own
// duration without inventing it, so each sample carries the measured cost of the
// previous sample's writes (and `measuredAppends` says how many). Nothing here
// is sampled or read while the trace is off: an unwritten render ends the frame
// before the host, the loop or the process is touched.
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
  LOG_NAME,
  ROTATED_NAME,
  MAX_LINE_BYTES,
  MAX_LOG_BYTES,
  TRUNCATION_MARKER,
  KINDS,
  RENDER_VIEWS,
  CAPABILITY_STATES,
  HOST_TUI_MODES,
  RUN_ID,
  isTraceEnabled,
  tracePath,
  traceEvent,
  traceSession,
  createFrameObserver,
};
