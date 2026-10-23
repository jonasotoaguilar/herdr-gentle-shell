'use strict';
// S18: the analysis half of the performance trace — lib/perf-analyze.js and the
// read-only report CLI that prints it.
//
// Contract under test (observable behavior only — the returned summaries, the
// verdict/reason strings, the CLI's stdout/stderr/exit code; never internal
// helper names):
// - `analyzeLog` groups the JSONL text by run, ignores blank, garbage,
//   truncated and run-less lines, and never throws on bad input;
// - each run summary carries the identity, the per-view render percentiles, the
//   append cost, the event-loop utilization, the process memory and the process
//   CPU that the log actually holds;
// - `compareRuns` names the comparability it checked (pi version, tui mode, a
//   minimum frame count) and only then reports deltas;
// - nothing in the comparison is a host renderer measurement;
// - the report CLI reads the real log plus the rotated log from the resolved
//   plugin state dir, writes nothing, and fails loudly when there is no log.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const analyze = require('../lib/perf-analyze.js');

const REPORT = path.resolve(__dirname, '../herdr-plugin/bin/gentle-perf-report.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'perf-analyze-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function record(fields) {
  return `${JSON.stringify(fields)}\n`;
}

function sessionLine(run, at, extra = {}) {
  return record({
    at,
    kind: 'session',
    run,
    piVersion: '1.4.0',
    pid: 4242,
    uptimeMs: 1200.5,
    tuiMode: 'fullscreen',
    ...extra,
  });
}

function renderLine(run, at, view, ms) {
  return record({ at, kind: 'render', run, view, ms, width: 100, height: 40, rows: 20 });
}

function observerLine(run, at, prevAppendMs, utilization) {
  return record({
    at,
    kind: 'observer',
    run,
    view: 'odd',
    frame: 1,
    measuredAppends: 2,
    prevAppendMs,
    hostFullRedrawsState: 'declared',
    hostRenderMsState: 'absent',
    hostFullRedraws: 9,
    processLoopState: 'declared',
    processLoopUtilization: utilization,
  });
}

function resourceLine(run, at, fields) {
  return record({ at, kind: 'resource', run, ...fields });
}

function at(second) {
  return new Date(Date.UTC(2025, 0, 1, 0, 0, second)).toISOString();
}

// One complete run: session, 40 odd renders and 40 issues renders, 40 observer
// samples and three resource samples. Values are chosen so the expected
// percentiles and means are checkable by hand.
function fullRun(run, secondBase) {
  const lines = [sessionLine(run, at(secondBase))];
  for (let i = 1; i <= 40; i += 1) {
    lines.push(renderLine(run, at(secondBase + i), 'odd', i));
    lines.push(renderLine(run, at(secondBase + i), 'issues', i / 4));
    lines.push(observerLine(run, at(secondBase + i), i / 10, 0.2 + i / 100));
  }
  lines.push(resourceLine(run, at(secondBase + 41), {
    frames: 40,
    rssMB: 200,
    heapUsedMB: 40,
    heapTotalMB: 50,
    externalMB: 2,
    cpuUserMs: 1000,
    cpuSystemMs: 200,
  }));
  lines.push(resourceLine(run, at(secondBase + 42), {
    frames: 40,
    rssMB: 210,
    heapUsedMB: 42,
    heapTotalMB: 52,
    externalMB: 2,
    cpuUserMs: 1500,
    cpuSystemMs: 300,
    windowMs: 1000,
    cpuPercent: 30,
  }));
  lines.push(resourceLine(run, at(secondBase + 43), {
    frames: 40,
    rssMB: 220,
    heapUsedMB: 44,
    heapTotalMB: 54,
    externalMB: 2,
    cpuUserMs: 1800,
    cpuSystemMs: 400,
    windowMs: 1000,
    cpuPercent: 25,
  }));
  return lines;
}

describe('analyzeLog run grouping', { concurrency: false }, () => {
  test('lines are grouped by run, and blank, garbage and truncated lines are ignored', () => {
    const a = 'run-a';
    const b = 'run-b';
    const text = [
      '',
      '   ',
      'not json at all',
      '[]',
      record({ at: at(1), kind: 'render', run: a, view: 'odd', ms: 1 }),
      record({ at: at(2), kind: 'render', run: b, view: 'odd', ms: 2 }),
      record({ at: at(3), kind: 'render', truncated: true, marker: '[truncated]', bytes: 9000 }),
      record({ at: at(4), kind: 'render', view: 'odd', ms: 3 }),
      record({ at: at(5), kind: 'render', run: a, view: 'odd', ms: 4 }),
      '',
    ].join('\n');

    const result = analyze.analyzeLog(text);
    assert.equal(result.runs.length, 2, 'two runs, in first-seen order');
    assert.deepEqual(result.runs.map((summary) => summary.run), [a, b]);
    assert.deepEqual(result.runs.map((summary) => summary.frames), [2, 1]);

    assert.equal(result.warnings.length, 3, 'every ignored shape is reported once');
    assert.ok(result.warnings.some((line) => /not JSON objects/.test(line)), 'garbage is named');
    assert.ok(result.warnings.some((line) => /carry no run id/.test(line)), 'a run-less record is named');
    assert.ok(result.warnings.some((line) => /truncated/.test(line)), 'a truncated stub is named');
  });

  test('bad input is reported, never thrown', () => {
    for (const input of [undefined, null, 42, {}, '', '\n\n', '{"a":1}\n[[[']) {
      assert.doesNotThrow(() => analyze.analyzeLog(input));
      const result = analyze.analyzeLog(input);
      assert.ok(Array.isArray(result.runs));
      assert.ok(Array.isArray(result.warnings));
    }
    assert.deepEqual(analyze.analyzeLog('').runs, [], 'an empty log has no runs and no invented data');
  });
});

describe('analyzeLog run summary', { concurrency: false }, () => {
  test('the summary carries identity, view percentiles, append, loop, memory and cpu', () => {
    const run = 'run-full';
    const result = analyze.analyzeLog(fullRun(run, 0).join(''));
    assert.equal(result.runs.length, 1);
    const summary = result.runs[0];

    assert.equal(summary.run, run);
    assert.equal(summary.startedAt, at(0), 'the first timestamp in the run');
    assert.equal(summary.endedAt, at(43), 'the last timestamp in the run');
    assert.equal(summary.durationMs, 43000);
    assert.equal(summary.piVersion, '1.4.0');
    assert.equal(summary.tuiMode, 'fullscreen');
    assert.equal(summary.frames, 80, 'one counted frame per render line');

    assert.deepEqual(summary.views.odd, { n: 40, p50: 20, p95: 38, max: 40, mean: 20.5 });
    assert.deepEqual(summary.views.issues, { n: 40, p50: 5, p95: 9.5, max: 10, mean: 5.125 });

    assert.equal(summary.append.samples, 40);
    assert.equal(summary.append.meanMs, 2.05);
    assert.equal(summary.append.p95Ms, 3.8);

    assert.equal(summary.loop.samples, 40);
    assert.equal(summary.loop.meanUtilization, 0.405, 'the mean of the measured utilizations');

    assert.equal(summary.memory.samples, 3);
    assert.equal(summary.memory.startRssMB, 200);
    assert.equal(summary.memory.endRssMB, 220);
    assert.equal(summary.memory.maxRssMB, 220);
    assert.equal(summary.memory.deltaRssMB, 20);
    assert.equal(summary.memory.meanHeapUsedMB, 42);

    assert.equal(summary.cpu.samples, 3);
    assert.equal(summary.cpu.userMs, 1800, 'the CPU this process had consumed by its last sample');
    assert.equal(summary.cpu.systemMs, 400);
    assert.equal(summary.cpu.totalMs, 2200);
    assert.equal(summary.cpu.perFrameMs, 27.5, 'total process CPU over the run per traced frame');
    assert.equal(summary.cpu.meanPercent, 27.5);
  });

  test('a run without resource or observer samples reports zero samples and no numbers', () => {
    const run = 'run-thin';
    const text = `${sessionLine(run, at(0))}${renderLine(run, at(1), 'warp', 3)}`;
    const [summary] = analyze.analyzeLog(text).runs;

    assert.equal(summary.frames, 1);
    assert.deepEqual(summary.views, { warp: { n: 1, p50: 3, p95: 3, max: 3, mean: 3 } });
    assert.deepEqual(summary.append, { samples: 0 });
    assert.deepEqual(summary.loop, { samples: 0 });
    assert.deepEqual(summary.memory, { samples: 0 });
    assert.deepEqual(summary.cpu, { samples: 0 });
  });

  test('unusable values are ignored instead of becoming numbers', () => {
    const run = 'run-dirty';
    const text = [
      renderLine(run, at(1), 'odd', 5),
      record({ at: at(2), kind: 'render', run, view: 'odd', ms: -4 }),
      record({ at: at(3), kind: 'render', run, view: 'odd', ms: 'fast' }),
      record({ at: at(4), kind: 'render', run, view: 'nonsense', ms: 7 }),
      observerLine(run, at(5), -1, 4),
      resourceLine(run, at(6), { frames: 1.5, rssMB: -3, cpuUserMs: 10, windowMs: 0, cpuPercent: 12 }),
    ].join('');
    const [summary] = analyze.analyzeLog(text).runs;

    assert.deepEqual(summary.views, { odd: { n: 1, p50: 5, p95: 5, max: 5, mean: 5 } }, 'a view outside the traced set and nonsense ms are dropped');
    assert.deepEqual(summary.append, { samples: 0 }, 'a negative append cost is not a sample');
    assert.deepEqual(summary.loop, { samples: 0 }, 'a ratio above 1 is not a utilization');
    assert.equal(summary.memory.samples, 0, 'a negative RSS reading is not memory');
    assert.equal('startRssMB' in summary.memory, false);
    assert.equal(summary.cpu.userMs, 10);
    assert.equal('totalMs' in summary.cpu, false, 'no total without both halves');
    assert.equal('meanPercent' in summary.cpu, false, 'a 0 ms window is not a CPU percentage');
  });

  test('runs are ordered chronologically even when the log interleaves them', () => {
    const text = [
      sessionLine('late', at(100)),
      renderLine('early', at(10), 'odd', 1),
      sessionLine('early', at(0)),
    ].join('');
    assert.deepEqual(analyze.analyzeLog(text).runs.map((summary) => summary.run), ['early', 'late']);
  });
});

describe('compareRuns comparability guards', { concurrency: false }, () => {
  function runs() {
    const off = analyze.analyzeLog(fullRun('run-off', 0).join('')).runs[0];
    const on = analyze.analyzeLog(fullRun('run-on', 200).join('')).runs[0];
    return { off, on };
  }

  test('comparable runs are conclusive and the deltas name what was compared', () => {
    const { off, on } = runs();
    const result = analyze.compareRuns(off, on);
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'conclusive');
    assert.deepEqual(result.reasons, [], 'every guard passed, so nothing blocked the comparison');

    assert.deepEqual(result.deltas.views.odd, { a: 20.5, b: 20.5, delta: 0 }, 'render ms per view');
    assert.deepEqual(result.deltas.meanAppendMs, { a: 2.05, b: 2.05, delta: 0 });
    assert.ok(Math.abs(result.deltas.meanLoopUtilization.delta) < 1e-9, 'loop utilization');
    assert.deepEqual(result.deltas.rssDeltaMB, { a: 20, b: 20, delta: 0 }, 'RSS delta per run');
    assert.deepEqual(result.deltas.rssEndMB, { a: 220, b: 220, delta: 0 }, 'RSS at the end');
    assert.deepEqual(result.deltas.cpuTotalMs, { a: 2200, b: 2200, delta: 0 }, 'process CPU total');
    assert.deepEqual(result.deltas.cpuPerFrameMs, { a: 27.5, b: 27.5, delta: 0 }, 'process CPU per frame');

    const named = Object.keys(result.deltas);
    for (const key of named) {
      assert.equal(/host|redraw|frameMs$/i.test(key) && key !== 'cpuPerFrameMs', false, `${key} is not a host renderer claim`);
    }
    assert.equal(JSON.stringify(result.deltas).includes('fullRedraws'), false, 'no host counter is relabelled as a delta');
  });

  test('a different Pi version blocks the comparison and says so', () => {
    const { off, on } = runs();
    const result = analyze.compareRuns(off, { ...on, piVersion: '1.5.0' });
    assert.equal(result.verdict, 'not-conclusive');
    assert.deepEqual(result.deltas, {}, 'no deltas are reported for incomparable runs');
    assert.equal(result.reasons.length, 1);
    assert.match(result.reasons[0], /^different-pi-version:/);
    assert.match(result.reasons[0], /1\.4\.0/);
    assert.match(result.reasons[0], /1\.5\.0/);
  });

  test('a different tui mode blocks the comparison', () => {
    const { off, on } = runs();
    const result = analyze.compareRuns(off, { ...on, tuiMode: 'regular' });
    assert.equal(result.verdict, 'not-conclusive');
    assert.match(result.reasons.find((reason) => reason.startsWith('different-tui-mode')), /fullscreen.*regular/);
  });

  test('a run below the minimum frame count blocks the comparison', () => {
    const { off, on } = runs();
    assert.equal(analyze.MIN_FRAMES, 30);
    const result = analyze.compareRuns({ ...off, frames: 29 }, on);
    assert.equal(result.verdict, 'not-conclusive');
    const reason = result.reasons.find((entry) => entry.startsWith('insufficient-frames'));
    assert.ok(reason, 'the frame guard names itself');
    assert.match(reason, /29 frames/);
    assert.match(reason, /minimum 30/);
  });

  test('every failed guard contributes its own reason', () => {
    const { off } = runs();
    const result = analyze.compareRuns(off, {
      ...off,
      piVersion: '9.9.9',
      tuiMode: 'regular',
      frames: 1,
    });
    assert.equal(result.verdict, 'not-conclusive');
    assert.equal(result.reasons.length, 3, 'pi version, tui mode and frames are each named');
    assert.deepEqual(
      result.reasons.map((reason) => reason.slice(0, reason.indexOf(':'))),
      ['different-pi-version', 'different-tui-mode', 'insufficient-frames'],
    );
  });

  test('a comparison without two run summaries is a refusal, not a crash', () => {
    for (const [a, b] of [[null, null], [undefined, {}], [42, 'x']]) {
      let result;
      assert.doesNotThrow(() => { result = analyze.compareRuns(a, b); });
      assert.equal(result.ok, false);
      assert.equal(result.verdict, 'not-conclusive');
      assert.deepEqual(result.deltas, {});
      assert.equal(result.reasons.length, 1);
    }
  });
});

describe('gentle-perf-report', { concurrency: false }, () => {
  function stateDir({ rotated = null, current = null } = {}) {
    const dir = scratch('perf-report-state-');
    if (rotated !== null) fs.writeFileSync(path.join(dir, 'perf-trace.1.jsonl'), rotated);
    if (current !== null) fs.writeFileSync(path.join(dir, 'perf-trace.jsonl'), current);
    return dir;
  }

  function runReport(dir, args = []) {
    return spawnSync(process.execPath, [REPORT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GENTLE_STATUS_STATE_DIR: dir, HERDR_PLUGIN_STATE_DIR: undefined },
    });
  }

  test('two runs across the rotated and current log are printed with a verdict', () => {
    const dir = stateDir({
      rotated: fullRun('run-off', 0).join(''),
      current: fullRun('run-on', 200).join(''),
    });

    const result = runReport(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /run-off/, 'the older run from the rotated log');
    assert.match(result.stdout, /run-on/, 'the newer run from the current log');
    assert.match(result.stdout, /verdict: conclusive/);
    assert.match(result.stdout, /odd/, 'the per-view render comparison');
    assert.match(result.stdout, /package/, 'the report states its scope');
    assert.match(result.stdout, /renderer/, 'the report never claims the host renderer');

    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ['perf-trace.1.jsonl', 'perf-trace.jsonl'],
      'the report writes nothing into the state dir',
    );
  });

  test('--json prints the analyzer output, including the comparison', () => {
    const dir = stateDir({
      rotated: fullRun('run-off', 0).join(''),
      current: fullRun('run-on', 200).join(''),
    });

    const result = runReport(dir, ['--json']);
    assert.equal(result.status, 0, result.stderr);
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.runs.length, 2);
    assert.deepEqual(doc.runs.map((run) => run.run), ['run-off', 'run-on']);
    assert.deepEqual(doc.warnings, []);
    assert.equal(doc.comparison.verdict, 'conclusive');
    assert.deepEqual(doc.runs[0].views.odd, { n: 40, p50: 20, p95: 38, max: 40, mean: 20.5 });
  });

  test('one run prints its summary and no comparison', () => {
    const dir = stateDir({ current: fullRun('run-solo', 0).join('') });
    const result = runReport(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /run-solo/);
    assert.equal(/verdict:/.test(result.stdout), false, 'one run is not compared with itself');
  });

  test('no log is a clear failure, not an empty success', () => {
    const dir = stateDir();
    const result = runReport(dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no perf trace log/i);
    assert.match(result.stderr, /perf-trace\.jsonl/, 'the message names the file it looked for');
    assert.deepEqual(fs.readdirSync(dir), [], 'a failed read writes nothing');
  });

  test('invalid arguments are rejected before any read', () => {
    const dir = stateDir({ current: fullRun('run-solo', 0).join('') });
    const result = runReport(dir, ['--verbose']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage/i);

    const help = runReport(dir, ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: gentle-perf-report/);
  });

  test('a log with no complete records still reads successfully', () => {
    const dir = stateDir({ current: 'garbage\n{"at":"x"}\n' });
    const result = runReport(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no complete runs/i);
  });
});
