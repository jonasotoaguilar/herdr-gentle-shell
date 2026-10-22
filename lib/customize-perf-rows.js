#!/usr/bin/env node
'use strict';

// The three performance rows of the customize panel.
//
// One row per shipped optimisation, each OFF by default. S30: the panel shows
// plain-language BEHAVIOUR, BENEFIT and TRADEOFF only — the measured evidence
// (timings, heap, turn counts, the SYNTHETIC apparatus) lives in
// docs/worktree-tools.md and the pi-side RESULTS.md, never in the UI. There is
// deliberately no help overlay and no benchmark disclosure for these rows.
//
// Row 1 is FUSED: `heightIndex` plus `evictOffscreenLines`, because eviction
// has no effect without the index it lives inside. A user can reach a state
// with one key on and the other off through pi's own `/settings`, so the row
// reports that state as PARTIAL and normalizes both keys to one value on the
// next toggle — it never claims they were already equal. Rows 2 and 3 write a
// single key each and therefore have no partial state.
//
// Writes go through lib/pi-perf-settings.js: atomic, fail-closed, and honest
// about a failure instead of silently assuming the change landed.

const { PERF_KEYS, settingsPath, readValues, writeSettings } = require('./pi-perf-settings.js');
const traceLib = require('./perf-trace.js');

// Measured at 5000 turns on SYNTHETIC content (see the pi-side RESULTS.md).
// Every note states the improvement first and the regression second, because
// none of these switches is free.
const ROWS = Object.freeze([
  {
    id: 'height-index',
    label: 'Height index + eviction',
    keys: Object.freeze(['heightIndex', 'evictOffscreenLines']),
    descriptionKey: 'heightIndex',
    resetLabels: Object.freeze({ heightIndex: 'height index', evictOffscreenLines: 'offscreen eviction' }),
    // S30: the UI states behaviour, benefit and tradeoff in plain language;
    // the measured evidence lives in docs/worktree-tools.md only.
    note:
      'Caches row heights and unloads far rows, so fullscreen frames repaint faster with less memory. Off-screen edits keep a stale height until you scroll back.',
  },
  {
    id: 'recent-output-expansion',
    label: 'Recent tool output expansion',
    keys: Object.freeze(['expandRecentToolOutput']),
    descriptionKey: 'expandRecentToolOutput',
    resetLabels: Object.freeze({ expandRecentToolOutput: 'recent output expansion' }),
    note:
      'Collapses older tool output to expandable stubs, so long transcripts stay compact and repaint faster. A stub is not searchable or copyable until you expand that row.',
  },
  {
    id: 'search-corpus',
    label: 'Incremental search corpus',
    keys: Object.freeze(['incrementalSearchCorpus']),
    descriptionKey: 'incrementalSearchCorpus',
    resetLabels: Object.freeze({ incrementalSearchCorpus: 'search corpus' }),
    note:
      'Keeps a per-row search corpus so the fullscreen search rebuilds only changed rows: search stays responsive while output streams. Costs extra memory while search is open; fullscreen only.',
  },
]);

const STATE_LABELS = Object.freeze({ on: 'ON', off: 'OFF', partial: 'PARTIAL', unknown: 'UNKNOWN' });

// S16: the Performance trace is an OPTION of this section, not a fourth
// optimisation. It toggles a log, so its default is OFF like the switches, and
// its state is read from the flag file (lib/perf-trace.js) rather than from
// settings.json. It sits LAST so the three optimisation rows keep their
// positions, their ON/OFF/PARTIAL states and their meaning: whether Pi declares
// a setting is evidence shown next to the trace, never a change to a row.
const TRACE_ROW = Object.freeze({
  id: 'trace',
  label: 'Performance trace',
});

// Descriptions shipped by the host, keyed by setting name. Empty until the
// extension primes them, so the pinned text above is what renders today.
let descriptionCache = Object.create(null);
let schemaLoader = null;

function sanitizeDescriptions(map) {
  const clean = Object.create(null);
  if (!map || typeof map !== 'object') return clean;
  for (const key of PERF_KEYS) {
    const text = map[key];
    if (typeof text === 'string' && text.trim().length > 0) clean[key] = text.trim();
  }
  return clean;
}

function setDescriptions(map) {
  descriptionCache = sanitizeDescriptions(map);
  return { ...descriptionCache };
}

function descriptions() {
  return { ...descriptionCache };
}

// Find the four descriptions inside whatever the host exports: any object
// graph carrying typebox-style `properties.<key>.description` at any depth.
// A host that exports nothing usable yields an empty map, and the pinned text
// keeps rendering.
function descriptionsFromModule(namespace) {
  const found = Object.create(null);
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return;
    seen.add(node);
    const properties = node.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const key of PERF_KEYS) {
        const entry = properties[key];
        if (!found[key] && entry && typeof entry.description === 'string' && entry.description.trim()) {
          found[key] = entry.description.trim();
        }
      }
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(namespace, 0);
  return found;
}

// Remember a loader for the host schema and prime the cache once. A host that
// exposes no schema, or a loader that throws, leaves the pinned text in place
// instead of clearing it.
async function primeDescriptions(loader) {
  if (typeof loader === 'function') schemaLoader = loader;
  if (typeof schemaLoader !== 'function') return descriptions();
  try {
    const namespace = await schemaLoader();
    const found = descriptionsFromModule(namespace);
    if (Object.keys(found).length > 0) descriptionCache = found;
  } catch {
    // No host schema available: the pinned measured text is the note.
  }
  return descriptions();
}

function wrap(text, width) {
  const size = Math.max(1, Math.floor(Number(width)) || 1);
  const words = String(text).split(/\s+/).filter((word) => word.length > 0);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= size) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

function rowById(rowId) {
  return ROWS.find((row) => row.id === rowId) || null;
}

function readTraceModeSafe(env) {
  try {
    const mode = traceLib.readTraceMode(env);
    return mode && typeof mode === 'object'
      ? { enabled: mode.enabled === true, path: mode.path || '', reason: mode.reason || 'unknown' }
      : { enabled: false, path: '', reason: 'unknown' };
  } catch {
    return { enabled: false, path: '', reason: 'unknown' };
  }
}

// Injectable seam for the installed-Pi scan (tests): returns the
// lib/pi-perf-support.js shape. Production leaves it null and the shipped
// package is scanned. The scan is expensive, so it only ever runs while the
// trace is enabled — a disabled trace costs no scan.
let supportScanner = null;

function setSupportScanner(scanner) {
  supportScanner = typeof scanner === 'function' ? scanner : null;
}

// Declared / absent / unknown, as counts. Deliberately no per-key claim beyond
// what the scan saw: 'absent' means no shipped file names the setting, which is
// evidence about the package, never proof that the optimisation does nothing.
function supportSummary(scan) {
  if (!scan || typeof scan !== 'object' || !scan.keys || typeof scan.keys !== 'object') return null;
  const counts = { declared: 0, absent: 0, unknown: 0 };
  for (const key of PERF_KEYS) {
    const entry = scan.keys[key];
    const state = entry && entry.state;
    if (state in counts) counts[state] += 1;
  }
  return {
    version: typeof scan.piVersion === 'string' && scan.piVersion.length > 0 ? scan.piVersion : '',
    ...counts,
  };
}

// The long form (the row's `detail`): the bounded claim in full.
function supportSentence(summary) {
  const version = summary.version ? ` ${summary.version}` : '';
  return `Pi${version} support evidence: ${summary.declared} declared, ${summary.absent} absent, ${summary.unknown} unknown — absent means no shipped file names the setting, which is evidence only, never proof of speedup.`;
}

// The short form: the panel's preview block shows two lines, so this one has to
// stay inside them without losing the word that bounds the claim.
function supportShort(summary) {
  const version = summary.version ? ` ${summary.version}` : '';
  return `Evidence (Pi${version}): ${summary.declared} declared, ${summary.absent} absent, ${summary.unknown} unknown.`;
}

function supportEvidence(env) {
  try {
    const scan = typeof supportScanner === 'function'
      ? supportScanner(env)
      : require('./pi-perf-support.js').scanSupport({ env });
    return supportSummary(scan);
  } catch {
    return null;
  }
}

// One way to write the session snapshot, so the panel, the row toggles and the
// session hook all record the same shape (and tests inject the scan once).
function traceSnapshot(env) {
  return traceLib.traceSession(env, typeof supportScanner === 'function' ? { scan: supportScanner } : {});
}

// The log path is always the REAL one the writer uses, so the panel and the
// file on disk cannot disagree about where a run is recorded.
function traceNote(env, mode) {
  const log = traceLib.tracePath(env);
  const lead = mode.enabled
    ? `Appends this package's own view and daemon timings to ${log}; Pi's transcript renderer is not measured.`
    : `Appends this package's own view and daemon timings to ${log} once enabled; Pi's transcript renderer is not measured.`;
  return `${lead} Keep it on for BOTH runs: record one with the optimizations OFF, then switch them ON.`;
}

// A flag that exists but cannot be used is reported on the row instead of being
// silently read as OFF: the user's click cannot start a trace until it is fixed.
function traceProblem(mode) {
  if (mode.reason === 'malformed') return ` ${mode.path} is not a valid trace flag; fix or remove it before tracing can start.`;
  if (mode.reason === 'unreadable') return ` ${mode.path} cannot be read; tracing cannot start.`;
  if (mode.reason === 'unresolved') return ' The plugin state directory cannot be resolved; tracing cannot start.';
  return '';
}
function stateFor(row, values) {
  const states = row.keys.map((key) => values[key] === true);
  if (states.every((on) => on)) return 'on';
  if (states.every((on) => !on)) return 'off';
  return 'partial';
}

function readRows(env = process.env) {
  const keys = ROWS.flatMap((row) => [...row.keys]);
  const read = readValues(keys, env);
  if (!read.ok) return { ok: false, path: read.path, error: read.error, values: null };
  return { ok: true, path: read.path, values: read.values, error: null };
}

// The panel model rows. `active` stays null on purpose: three independent
// switches have no single active value to point at, so the state travels in
// the label instead of a `→` marker.
//
// S30: the UI note is the pinned concise copy; the host's own setting
// descriptions are intentionally NOT read into the panel, so raw benchmark
// text from the host can never reappear on screen.
function panelModel(env = process.env) {
  const read = readRows(env);
  const rows = ROWS.map((row) => {
    const state = read.ok ? stateFor(row, read.values) : 'unknown';
    const note = row.note;
    return {
      id: row.id,
      label: `${row.label} · ${STATE_LABELS[state]}`,
      detail: note,
      state,
      noteLines: (width) => wrap(note, width),
    };
  });
  const traceMode = readTraceModeSafe(env);
  const evidence = traceMode.enabled ? supportEvidence(env) : null;
  const log = traceLib.tracePath(env);
  const problem = traceProblem(traceMode);
  const detail = `${traceNote(env, traceMode)}${evidence ? ` ${supportSentence(evidence)}` : ''}${problem}`;
  // The preview block renders exactly two note lines, so this row hands it two
  // lines that fit: the state plus the real path, then the A/B instruction and
  // the bounded evidence — or, for an unusable flag, what to fix. A narrower
  // terminal clips them, like every other row.
  let shortLines;
  if (problem) {
    shortLines = [
      `Trace OFF → ${traceMode.path}`,
      traceMode.reason === 'malformed'
        ? 'Not a valid trace flag; fix or remove it before tracing can start.'
        : traceMode.reason === 'unreadable'
          ? 'Cannot be read; tracing cannot start until it is fixed.'
          : 'The plugin state directory cannot be resolved; tracing cannot start.',
    ];
  } else {
    const head = traceMode.enabled ? `Trace ON → ${log}` : `Trace OFF → writes ${log}`;
    const tail = evidence
      ? supportShort(evidence)
      : ' This package\'s views and daemon only, never Pi\'s renderer.';
    shortLines = [head, `Keep it ON for BOTH runs.${evidence ? ` ${tail}` : tail}`];
  }
  rows.push({
    id: TRACE_ROW.id,
    label: `${TRACE_ROW.label} · ${STATE_LABELS[traceMode.enabled ? 'on' : 'off']}`,
    detail,
    state: traceMode.enabled ? 'on' : 'off',
    noteLines: () => shortLines,
  });
  return {
    id: 'perf',
    title: 'Performance',
    available: true,
    active: null,
    rows,
    ok: read.ok,
    path: read.path || settingsPath(env),
    error: read.error,
  };
}

// The trace row: read the flag, write its opposite, and report the real path.
// Enabling writes the session snapshot immediately, so the run that starts now
// is identified in the log without a restart.
function applyTraceRow(env) {
  const mode = readTraceModeSafe(env);
  const next = !mode.enabled;
  const log = traceLib.tracePath(env);
  const written = traceLib.writeTraceMode(next, env);
  const base = { trace: true, label: TRACE_ROW.label, enabled: mode.enabled, path: log };
  if (!written || written.ok !== true) {
    return { ...base, ok: false, changed: false, needsReload: false, state: mode.enabled ? 'on' : 'off', error: (written && written.error) || 'the trace flag could not be written' };
  }
  if (written.changed !== true) {
    return { ...base, ok: true, changed: false, needsReload: false, state: mode.enabled ? 'on' : 'off', error: null };
  }
  if (next) {
    traceSnapshot(env);
  }
  return { ...base, ok: true, changed: true, needsReload: false, enabled: next, state: next ? 'on' : 'off', error: null };
}

// Toggle one row. OFF (and a PARTIAL mix) turns every key of the row ON; ON
// turns every key OFF, so a mixed state is normalized rather than preserved.
function applyRow(rowId, env = process.env) {
  if (String(rowId ?? '') === TRACE_ROW.id) return applyTraceRow(env);
  const row = rowById(rowId);
  if (!row) {
    return { ok: false, changed: false, needsReload: false, label: String(rowId), error: `unknown performance row ${rowId}` };
  }
  const read = readRows(env);
  if (!read.ok) {
    return { ok: false, changed: false, needsReload: false, label: row.label, error: read.error };
  }
  const state = stateFor(row, read.values);
  const next = state !== 'on';
  const pairs = {};
  for (const key of row.keys) pairs[key] = next;
  const written = writeSettings(pairs, env);
  if (!written.ok) {
    return { ok: false, changed: false, needsReload: false, label: row.label, error: written.error, state };
  }
  if (!written.changed) {
    return { ok: true, changed: false, needsReload: false, label: row.label, state, error: null };
  }
  const normalized = state === 'partial' && next;
  // A switch change begins a new run: the snapshot recorded before the next
  // traced event must name the switches now in effect. A disabled trace writes
  // nothing here (and never scans).
  traceSnapshot(env);
  return {
    ok: true,
    changed: true,
    needsReload: true,
    label: row.label,
    state,
    normalized,
    pairs,
    path: written.path,
    error: null,
  };
}

// What a failed or successful toggle says to the user (the caller adds the
// reload sentence). A no-op keeps today's file and says so.
function applyRowMessage(result) {
  if (!result) return 'Nothing was changed.';
  if (result.trace === true) {
    if (result.ok !== true) return `${result.label} not changed. ${result.error}`;
    if (result.changed !== true) {
      return `${result.label} already ${result.enabled === true ? 'enabled' : 'disabled'}; nothing was changed.`;
    }
    if (result.enabled === true) {
      return `${result.label} enabled. Writing to ${result.path}. Keep it on for both runs: one with the optimizations OFF, then one with them ON.`;
    }
    return `${result.label} disabled. The log at ${result.path} is kept; nothing was deleted.`;
  }
  if (!result.ok) return `${result.label} not changed. ${result.error}`;
  if (!result.changed) return `${result.label} already ${result.state === 'on' ? 'enabled' : 'disabled'}; nothing was changed.`;
  const verb = result.pairs && Object.values(result.pairs)[0] ? 'enabled' : 'disabled';
  const suffix = result.normalized ? ' Both keys were out of step and now match.' : '';
  return `${result.label} ${verb}.${suffix}`;
}

// Every pi key the reset must return to its OFF default, with the label the
// reset summary uses for it.
function resetEntries() {
  return ROWS.flatMap((row) => row.keys.map((key) => ({ key, label: row.resetLabels[key] || key })));
}

function defaultsState(env = process.env) {
  const keys = ROWS.flatMap((row) => [...row.keys]);
  const read = readValues(keys, env);
  if (!read.ok) return { ok: false, allOff: false, error: read.error };
  const on = keys.filter((key) => read.values[key] === true);
  // The trace is an option too, and its default is OFF.
  const tracing = readTraceModeSafe(env).enabled === true;
  return { ok: true, allOff: on.length === 0 && !tracing, on: tracing ? [...on, TRACE_ROW.id] : on };
}

// Write all four keys OFF through the same atomic writer the rows use. Returns
// one entry per key so the reset summary can name each of them.
function resetToDefaults(env = process.env) {
  const entries = resetEntries();
  const read = readValues(entries.map((entry) => entry.key), env);
  if (!read.ok) return { ok: false, changed: false, entries: [], error: read.error };
  const off = {};
  for (const entry of entries) off[entry.key] = false;
  const written = writeSettings(off, env);
  if (!written.ok) {
    return {
      ok: false,
      changed: false,
      entries: entries.filter((entry) => read.values[entry.key] === true).map((entry) => ({ ...entry, applied: false })),
      error: written.error,
    };
  }
  const touched = entries.filter((entry) => read.values[entry.key] === true);
  const applied = touched.map((entry) => ({ ...entry, applied: true }));
  let changed = written.changed;
  // The trace's default is OFF as well, but it is turned off through its own
  // writer so a malformed flag is reported instead of overwritten.
  if (readTraceModeSafe(env).enabled === true) {
    const traceWrite = traceLib.writeTraceMode(false, env);
    if (!traceWrite || traceWrite.ok !== true) {
      return { ok: false, changed, entries: applied, error: (traceWrite && traceWrite.error) || 'the trace flag could not be written' };
    }
    if (traceWrite.changed === true) {
      applied.push({ key: TRACE_ROW.id, label: 'performance trace', applied: true });
      changed = true;
    }
  }
  return {
    ok: true,
    changed,
    entries: applied,
    error: null,
  };
}

module.exports = {
  ROWS,
  PERF_KEYS,
  STATE_LABELS,
  TRACE_ROW,
  applyRow,
  applyRowMessage,
  defaultsState,
  descriptions,
  descriptionsFromModule,
  panelModel,
  primeDescriptions,
  readRows,
  resetEntries,
  resetToDefaults,
  rowById,
  setDescriptions,
  setSupportScanner,
  wrap,
};
