'use strict';
// Reader half of S18: turns the performance trace into conclusions.
//
// Pure by design — no fs, no clock, no network — so the same text always
// produces the same summary and a report can be tested without a running Pi.
//
// `analyzeLog` groups the JSONL text by run and sums up what each run actually
// recorded. `compareRuns` then decides whether two runs are comparable at all
// and only reports deltas when every comparability guard passed:
//
//   different pi version        the two runs are not the same build
//   identical switch snapshot   nothing was switched, so nothing was compared
//   different tui mode          a fullscreen run is not a regular one
//   fewer than MIN_FRAMES       too few traced frames to average
//
// What a comparison can say is deliberately narrow: this package's own view
// renderings plus the Pi PROCESS cost (RSS, heap, CPU) the trace recorded. Pi's
// renderer is not instrumented, so no field here is a host frame time and no
// verdict claims one.

const MIN_FRAMES = 30;

// The views the trace can write, so a foreign or edited log cannot invent a
// view name in the report. Unknown names are counted and reported as a warning.
const RENDER_VIEWS = Object.freeze(['warp', 'odd', 'issues', 'create', 'detail']);
const KNOWN_KINDS = Object.freeze(['session', 'render', 'observer', 'resource', 'daemon']);
const TUI_MODES = Object.freeze(['fullscreen', 'regular']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMeasure(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function rounded(value, digits) {
  return isMeasure(value) ? Number(value.toFixed(digits)) : undefined;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

// Nearest-rank percentile on an ascending array: the smallest value at or above
// the requested share of the samples. Deterministic and easy to read back.
function percentile(sorted, share) {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil(share * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function summarizeViews(renders) {
  const values = new Map();
  for (const record of renders) {
    if (!RENDER_VIEWS.includes(record.view)) continue;
    if (!isMeasure(record.ms) || record.ms < 0) continue;
    if (!values.has(record.view)) values.set(record.view, []);
    values.get(record.view).push(record.ms);
  }
  const views = {};
  for (const [view, samples] of values) {
    const sorted = [...samples].sort((left, right) => left - right);
    views[view] = {
      n: sorted.length,
      p50: rounded(percentile(sorted, 0.5), 3),
      p95: rounded(percentile(sorted, 0.95), 3),
      max: rounded(sorted[sorted.length - 1], 3),
      mean: rounded(mean(sorted), 3),
    };
  }
  return views;
}

function summarizeAppend(observers) {
  const samples = observers.filter((record) => isMeasure(record.prevAppendMs) && record.prevAppendMs >= 0);
  const summary = { samples: samples.length };
  if (samples.length === 0) return summary;
  const values = samples.map((record) => record.prevAppendMs);
  const sorted = [...values].sort((left, right) => left - right);
  summary.meanMs = rounded(mean(values), 3);
  summary.p95Ms = rounded(percentile(sorted, 0.95), 3);
  return summary;
}

function summarizeLoop(observers) {
  const samples = observers.filter(
    (record) => isMeasure(record.processLoopUtilization)
      && record.processLoopUtilization >= 0
      && record.processLoopUtilization <= 1,
  );
  const summary = { samples: samples.length };
  if (samples.length === 0) return summary;
  summary.meanUtilization = rounded(mean(samples.map((record) => record.processLoopUtilization)), 4);
  return summary;
}

function summarizeMemory(resources) {
  const rss = resources.filter((record) => isMeasure(record.rssMB) && record.rssMB >= 0).map((record) => record.rssMB);
  const heap = resources
    .filter((record) => isMeasure(record.heapUsedMB) && record.heapUsedMB >= 0)
    .map((record) => record.heapUsedMB);
  const summary = { samples: rss.length };
  if (rss.length > 0) {
    summary.startRssMB = rounded(rss[0], 1);
    summary.endRssMB = rounded(rss[rss.length - 1], 1);
    summary.maxRssMB = rounded(Math.max(...rss), 1);
    summary.deltaRssMB = rounded(rss[rss.length - 1] - rss[0], 1);
  }
  if (heap.length > 0) summary.meanHeapUsedMB = rounded(mean(heap), 1);
  return summary;
}

function summarizeCpu(resources) {
  const samples = resources.filter((record) => isMeasure(record.cpuUserMs) || isMeasure(record.cpuSystemMs));
  const summary = { samples: samples.length };
  const withUser = resources.filter((record) => isMeasure(record.cpuUserMs) && record.cpuUserMs >= 0);
  const withSystem = resources.filter((record) => isMeasure(record.cpuSystemMs) && record.cpuSystemMs >= 0);
  const user = withUser.length > 0 ? withUser[withUser.length - 1].cpuUserMs : undefined;
  const system = withSystem.length > 0 ? withSystem[withSystem.length - 1].cpuSystemMs : undefined;
  if (isMeasure(user)) summary.userMs = rounded(user, 1);
  if (isMeasure(system)) summary.systemMs = rounded(system, 1);
  if (isMeasure(user) && isMeasure(system)) {
    summary.totalMs = rounded(user + system, 1);
  }
  // A percentage without a positive window is not a rate, so it is ignored
  // rather than averaged as if it were one.
  const percents = resources
    .filter((record) => isMeasure(record.cpuPercent) && isMeasure(record.windowMs) && record.windowMs > 0)
    .map((record) => record.cpuPercent);
  if (percents.length > 0) summary.meanPercent = rounded(mean(percents), 1);
  return summary;
}

function summarizeTimes(records) {
  const timed = records.filter((record) => typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)));
  if (timed.length === 0) return { startedAt: undefined, endedAt: undefined, durationMs: undefined };
  let first = timed[0];
  let last = timed[0];
  for (const record of timed) {
    const value = Date.parse(record.at);
    if (value < Date.parse(first.at)) first = record;
    if (value >= Date.parse(last.at)) last = record;
  }
  const span = Date.parse(last.at) - Date.parse(first.at);
  return {
    startedAt: first.at,
    endedAt: last.at,
    durationMs: isMeasure(span) ? Math.round(span) : undefined,
  };
}

function summarize(run, records) {
  const sessions = records.filter((record) => record.kind === 'session');
  const renders = records.filter((record) => record.kind === 'render');
  const observers = records.filter((record) => record.kind === 'observer');
  const resources = records.filter((record) => record.kind === 'resource');

  let piVersion;
  let tuiMode;
  let perf;
  let support;
  for (const session of sessions) {
    if (typeof session.piVersion === 'string' && session.piVersion.length > 0) piVersion = session.piVersion;
    if (TUI_MODES.includes(session.tuiMode)) tuiMode = session.tuiMode;
    if (isPlainObject(session.perf)) perf = session.perf;
    if (isPlainObject(session.support)) support = session.support;
  }

  const frames = renders.length;
  const cpu = summarizeCpu(resources);
  if (isMeasure(cpu.totalMs) && frames > 0) cpu.perFrameMs = rounded(cpu.totalMs / frames, 3);

  return Object.assign({
    run,
    piVersion,
    tuiMode,
    perf,
    support,
    frames,
    views: summarizeViews(renders),
    append: summarizeAppend(observers),
    loop: summarizeLoop(observers),
    memory: summarizeMemory(resources),
    cpu,
  }, summarizeTimes(records));
}

// Group the JSONL text by run. Blank lines, non-JSON, run-less records,
// truncated stubs and unknown kinds are ignored and reported as warnings: a
// reader has to know what it could not use.
function analyzeLog(text) {
  if (typeof text !== 'string') {
    return { runs: [], warnings: ['log text is not a string; nothing was analyzed'] };
  }
  const groups = new Map();
  const counters = { unparsable: 0, unlabeled: 0, truncated: 0, unknownKind: 0, unknownView: 0 };
  const unknownViews = new Set();

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      counters.unparsable += 1;
      continue;
    }
    if (!isPlainObject(record)) {
      counters.unparsable += 1;
      continue;
    }
    if (record.truncated === true) {
      counters.truncated += 1;
      continue;
    }
    if (typeof record.run !== 'string' || record.run.length === 0) {
      counters.unlabeled += 1;
      continue;
    }
    if (!KNOWN_KINDS.includes(record.kind)) {
      counters.unknownKind += 1;
      continue;
    }
    if (record.kind === 'render' && typeof record.view === 'string' && !RENDER_VIEWS.includes(record.view)) {
      counters.unknownView += 1;
      unknownViews.add(record.view.slice(0, 24));
    }
    if (!groups.has(record.run)) groups.set(record.run, { index: groups.size, records: [] });
    groups.get(record.run).records.push(record);
  }

  const warnings = [];
  if (counters.unparsable > 0) warnings.push(`${counters.unparsable} line(s) were not JSON objects and were ignored`);
  if (counters.unlabeled > 0) {
    warnings.push(`${counters.unlabeled} record(s) carry no run id and were ignored (written before a run id existed)`);
  }
  if (counters.truncated > 0) warnings.push(`${counters.truncated} truncated stub(s) were ignored`);
  if (counters.unknownKind > 0) warnings.push(`${counters.unknownKind} record(s) of an unknown kind were ignored`);
  if (counters.unknownView > 0) {
    warnings.push(`${counters.unknownView} render record(s) name an unknown view and were not summarized: ${[...unknownViews].join(', ')}`);
  }

  const runs = [...groups.entries()].map(([run, group]) => summarize(run, group.records));
  runs.sort((left, right) => {
    const leftTime = Date.parse(left.startedAt);
    const rightTime = Date.parse(right.startedAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return groups.get(left.run).index - groups.get(right.run).index;
  });

  return { runs, warnings };
}

// The switches as a comparable string. Only booleans count, and an empty or
// missing snapshot yields null, which can never match a real one.
function perfSignature(perf) {
  if (!isPlainObject(perf)) return null;
  const keys = Object.keys(perf).filter((key) => typeof perf[key] === 'boolean').sort();
  if (keys.length === 0) return null;
  return keys.map((key) => `${key}=${perf[key]}`).join(',');
}

function labelOf(value) {
  if (value === undefined) return 'unrecorded';
  return JSON.stringify(value);
}

function pair(left, right) {
  if (!isMeasure(left) || !isMeasure(right)) return null;
  return { a: rounded(left, 3), b: rounded(right, 3), delta: rounded(right - left, 3) };
}

function readPath(source, path) {
  let value = source;
  for (const key of path) {
    if (!isPlainObject(value)) return undefined;
    value = value[key];
  }
  return value;
}

// Only the differences this trace can actually support: this package's render
// ms per view, the append cost, event-loop utilization, RSS and process CPU.
// A host renderer duration is never one of them.
function deltasFor(a, b) {
  const deltas = {};

  const views = {};
  for (const view of Object.keys(a.views || {}).sort()) {
    const comparison = pair(readPath(a, ['views', view, 'mean']), readPath(b, ['views', view, 'mean']));
    if (comparison) views[view] = comparison;
  }
  if (Object.keys(views).length > 0) deltas.views = views;

  const named = [
    ['meanAppendMs', ['append', 'meanMs']],
    ['meanLoopUtilization', ['loop', 'meanUtilization']],
    ['rssDeltaMB', ['memory', 'deltaRssMB']],
    ['rssEndMB', ['memory', 'endRssMB']],
    ['cpuTotalMs', ['cpu', 'totalMs']],
    ['cpuPerFrameMs', ['cpu', 'perFrameMs']],
  ];
  for (const [name, path] of named) {
    const comparison = pair(readPath(a, path), readPath(b, path));
    if (comparison) deltas[name] = comparison;
  }
  return deltas;
}

// Is B comparable with A at all, and if so, what differs? Each failed guard is
// named with the evidence that failed it, so a not-conclusive verdict explains
// itself instead of hiding behind a number.
function compareRuns(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return {
      ok: false,
      verdict: 'not-conclusive',
      reasons: ['two run summaries are required to compare anything'],
      deltas: {},
    };
  }

  const reasons = [];
  if (a.piVersion !== b.piVersion) {
    reasons.push(`different-pi-version: run A ${labelOf(a.piVersion)} vs run B ${labelOf(b.piVersion)}`);
  }
  const signatureA = perfSignature(a.perf);
  const signatureB = perfSignature(b.perf);
  if (signatureA === null || signatureB === null || signatureA === signatureB) {
    reasons.push('identical-perf-snapshot: both runs recorded the same switches, so nothing was switched between them');
  }
  if (a.tuiMode !== b.tuiMode) {
    reasons.push(`different-tui-mode: run A ${labelOf(a.tuiMode)} vs run B ${labelOf(b.tuiMode)}`);
  }
  const framesA = isMeasure(a.frames) ? a.frames : 0;
  const framesB = isMeasure(b.frames) ? b.frames : 0;
  if (framesA < MIN_FRAMES || framesB < MIN_FRAMES) {
    reasons.push(`insufficient-frames: run A ${framesA} frames, run B ${framesB} frames (minimum ${MIN_FRAMES})`);
  }

  if (reasons.length > 0) return { ok: true, verdict: 'not-conclusive', reasons, deltas: {} };
  return { ok: true, verdict: 'conclusive', reasons: [], deltas: deltasFor(a, b) };
}

module.exports = {
  MIN_FRAMES,
  RENDER_VIEWS,
  KNOWN_KINDS,
  analyzeLog,
  compareRuns,
};
