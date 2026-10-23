#!/usr/bin/env node
'use strict';

// gentle-perf-report: read-only analysis of the Gentle performance trace.
//
// Reads perf-trace.1.jsonl and perf-trace.jsonl from the plugin state dir that
// lib/perf-trace.js resolves, groups the records by run (one Pi process),
// prints a summary per run and, with two or more runs, compares the last two:
// whether they are comparable at all, why not when they are not, and what
// differs when they are. The rotated file is read first so a comparison can
// span the session that rotated out.
//
// Never writes, never touches the network and never reads or changes any live
// setting: the tui mode and the switch snapshot come from the log itself.
//
// Exit codes: 0 the trace was read; 1 no trace log or unreadable library;
// 2 invalid CLI args (rejected before any read).

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-agents: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const fs = require('node:fs');
const path = require('node:path');

const HELP = `Usage: gentle-perf-report [--json] [--help]

Read-only report of the Gentle performance trace: one summary per run (one Pi
process) and, with two or more runs, a guarded comparison of the last two.

The comparison reports only what the trace records: this package's own view
renderings, the trace's append cost, event-loop utilization, and the Pi PROCESS
cost (RSS, heap, CPU). Pi's own renderer is not instrumented, so no number here
is a full-TUI frame time.

  --json   print the analyzer output (runs, warnings, comparison) as JSON
  --help   this text

Exit codes: 0 the trace was read; 1 no trace log; 2 invalid arguments.
`;

// A trace file is capped at 256 KiB by the writer, so this is only a guard
// against a foreign file in the same place, never a normal limit.
const MAX_READ_BYTES = 1024 * 1024;

function message(err) {
  return err && err.message ? err.message : String(err);
}

// The writer half owns the state-dir resolution, the file names and the
// analyzer is its reader half; both ship next to this package's lib/.
function libraryPath(name) {
  return path.join(path.resolve(__dirname, '../../lib'), name);
}

function loadLibraries() {
  try {
    return {
      ok: true,
      trace: require(libraryPath('perf-trace.js')),
      analyze: require(libraryPath('perf-analyze.js')),
    };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

function readLogFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, missing: true, text: '', warning: null };
    return { ok: false, missing: false, error: message(err) };
  }
  if (!stat.isFile()) return { ok: false, missing: false, error: 'not a regular file' };
  try {
    if (stat.size <= MAX_READ_BYTES) return { ok: true, missing: false, text: fs.readFileSync(file, 'utf8'), warning: null };
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_READ_BYTES);
      fs.readSync(fd, buffer, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
      const tail = buffer.toString('utf8');
      const firstBreak = tail.indexOf('\n');
      return {
        ok: true,
        missing: false,
        text: firstBreak === -1 ? '' : tail.slice(firstBreak + 1),
        warning: `${file} is larger than ${MAX_READ_BYTES} bytes; only its last ${MAX_READ_BYTES} bytes were analyzed`,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, missing: false, error: message(err) };
  }
}

function number(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return String(Number(value.toFixed(digits)));
}

function signed(value, digits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const text = number(Math.abs(value), digits);
  if (Number(text) === 0) return '0';
  return `${value > 0 ? '+' : '-'}${text}`;
}

function switches(perf) {
  if (!perf || typeof perf !== 'object') return 'not recorded';
  const keys = Object.keys(perf).sort();
  if (keys.length === 0) return 'not recorded';
  return keys.map((key) => `${key}=${perf[key] ? 'on' : 'off'}`).join(' ');
}

function evidence(support) {
  if (!support || typeof support !== 'object') return null;
  const keys = Object.keys(support).sort();
  if (keys.length === 0) return null;
  return keys.map((key) => `${key}=${support[key]}`).join(' ');
}

function runLines(run, index) {
  const lines = [];
  const identity = [`Pi ${run.piVersion || 'unknown'}`, `tui ${run.tuiMode || 'unrecorded'}`];
  lines.push(`run ${index + 1}  ${run.run}`);
  lines.push(`  window     ${run.startedAt || 'unknown'} -> ${run.endedAt || 'unknown'} (${number((run.durationMs || 0) / 1000, 1)} s)`);
  lines.push(`  identity   ${identity.join(' · ')}`);
  lines.push(`  switches   ${switches(run.perf)}`);
  const support = evidence(run.support);
  if (support) lines.push(`  evidence   ${support} (declared/absent/unknown per key; evidence, not a verdict)`);
  lines.push(`  frames     ${number(run.frames, 0)} traced package frames`);

  const views = Object.keys(run.views || {}).sort();
  if (views.length === 0) {
    lines.push('  views      none recorded');
  } else {
    views.forEach((view, position) => {
      const value = run.views[view];
      const text = `n=${number(value.n, 0)} p50=${number(value.p50, 3)} p95=${number(value.p95, 3)} max=${number(value.max, 3)} mean=${number(value.mean, 3)} ms`;
      lines.push(`  ${position === 0 ? 'views     ' : '          '}  ${view.padEnd(8)} ${text}`);
    });
  }

  const append = run.append || { samples: 0 };
  lines.push(
    append.samples > 0
      ? `  append     ${number(append.samples, 0)} sample(s) mean=${number(append.meanMs, 3)} ms p95=${number(append.p95Ms, 3)} ms (this trace's own write cost)`
      : '  append     no sample recorded',
  );

  const loop = run.loop || { samples: 0 };
  lines.push(
    loop.samples > 0
      ? `  loop       ${number(loop.samples, 0)} sample(s) mean utilization=${number(loop.meanUtilization, 4)}`
      : '  loop       no sample recorded',
  );

  const memory = run.memory || { samples: 0 };
  lines.push(
    memory.samples > 0
      ? `  memory     ${number(memory.samples, 0)} sample(s) rss start=${number(memory.startRssMB, 1)} MB end=${number(memory.endRssMB, 1)} MB max=${number(memory.maxRssMB, 1)} MB delta=${signed(memory.deltaRssMB, 1)} MB mean heap=${number(memory.meanHeapUsedMB, 1)} MB`
      : '  memory     no sample recorded',
  );

  const cpu = run.cpu || { samples: 0 };
  lines.push(
    cpu.samples > 0
      ? `  cpu        ${number(cpu.samples, 0)} sample(s) user=${number(cpu.userMs, 1)} ms system=${number(cpu.systemMs, 1)} ms total=${number(cpu.totalMs, 1)} ms per frame=${number(cpu.perFrameMs, 3)} ms mean=${number(cpu.meanPercent, 1)} %`
      : '  cpu        no sample recorded',
  );
  return lines;
}

function comparisonLines(comparison, runA, runB, indexA, indexB) {
  const lines = [];
  lines.push(`comparison (run ${indexA + 1} ${runA.run} -> run ${indexB + 1} ${runB.run}): verdict: ${comparison.verdict}`);
  for (const reason of comparison.reasons) lines.push(`  reason: ${reason}`);
  if (comparison.verdict !== 'conclusive') {
    lines.push('  no deltas are reported for runs that are not comparable.');
    return lines;
  }
  const deltas = comparison.deltas;
  const views = deltas.views || {};
  const names = Object.keys(views);
  if (names.length > 0) {
    lines.push('  render ms per view (this package\'s own views, never the host renderer):');
    for (const name of names) {
      const value = views[name];
      lines.push(`    ${name.padEnd(8)} ${number(value.a, 3)} -> ${number(value.b, 3)} (${signed(value.delta, 3)})`);
    }
  }
  const rows = [
    ['mean append ms', deltas.meanAppendMs, 3],
    ['loop utilization', deltas.meanLoopUtilization, 4],
    ['rss delta MB', deltas.rssDeltaMB, 1],
    ['rss end MB', deltas.rssEndMB, 1],
    ['cpu total ms', deltas.cpuTotalMs, 1],
    ['cpu per frame ms', deltas.cpuPerFrameMs, 3],
  ];
  for (const [label, value, digits] of rows) {
    if (!value) continue;
    lines.push(`  ${label.padEnd(17)} ${number(value.a, digits)} -> ${number(value.b, digits)} (${signed(value.delta, digits)})`);
  }
  return lines;
}

function renderReport({ files, runs, warnings, comparison }) {
  const lines = ['Gentle performance trace', `  log      ${files[1]}`, `  rotated  ${files[0]}`, ''];
  if (runs.length === 0) {
    lines.push('no complete runs in the trace (garbage lines, truncated stubs and records without a run id are ignored).');
  } else {
    lines.push(`${runs.length} run(s)`, '');
    runs.forEach((run, index) => {
      lines.push(...runLines(run, index), '');
    });
    if (comparison) {
      lines.push(...comparisonLines(comparison, runs[runs.length - 2], runs[runs.length - 1], runs.length - 2, runs.length - 1), '');
    }
  }
  if (warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of warnings) lines.push(`  - ${warning}`);
    lines.push('');
  }
  lines.push(
    'Scope: these numbers are this package\'s own view renderings plus the Pi process',
    'cost (RSS, heap, CPU). Pi\'s own renderer, terminal writes and input handling are',
    'not measured, so no line here says that the TUI got faster or slower.',
  );
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write('usage: gentle-perf-report [--json] [--help]\n');
    return 2;
  }

  const libs = loadLibraries();
  if (!libs.ok) {
    process.stderr.write(`gentle-perf-report: cannot load the perf trace libraries: ${libs.error}\n`);
    return 1;
  }

  const log = libs.trace.tracePath(process.env);
  if (!log) {
    process.stderr.write('gentle-perf-report: the plugin state directory could not be resolved\n');
    return 1;
  }
  const dir = path.dirname(log);
  const files = [path.join(dir, libs.trace.ROTATED_NAME), path.join(dir, libs.trace.LOG_NAME)];

  const warnings = [];
  const parts = [];
  let found = 0;
  for (const file of files) {
    const read = readLogFile(file);
    if (!read.ok) {
      process.stderr.write(`gentle-perf-report: cannot read ${file}: ${read.error}\n`);
      return 1;
    }
    if (read.missing) continue;
    found += 1;
    if (read.warning) warnings.push(read.warning);
    parts.push(read.text);
  }
  if (found === 0) {
    process.stderr.write(
      `no perf trace log found: looked for ${files.join(' and ')}. Turn on /herdr-gentle:customize -> Performance -> Performance trace and run a session first.\n`,
    );
    return 1;
  }

  const analysis = libs.analyze.analyzeLog(parts.join(''));
  const allWarnings = [...warnings, ...analysis.warnings];
  const comparison = analysis.runs.length >= 2
    ? libs.analyze.compareRuns(analysis.runs[analysis.runs.length - 2], analysis.runs[analysis.runs.length - 1])
    : null;

  if (json) {
    process.stdout.write(`${JSON.stringify({ runs: analysis.runs, warnings: allWarnings, comparison }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderReport({ files, runs: analysis.runs, warnings: allWarnings, comparison }));
  return 0;
}

if (require.main === module) process.exit(main());
else module.exports = { main };
