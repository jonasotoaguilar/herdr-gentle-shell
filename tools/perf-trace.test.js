'use strict';
// Tests for lib/perf-trace.js: the writer half of the S16 Performance trace.
//
// Contract under test (observable behavior only — the bytes on disk, which
// files exist, the returned verdicts; never internal helper names):
// - a missing, malformed, unreadable or explicitly-disabled flag writes
//   nothing and creates no log;
// - an enabled trace appends one parseable JSON line per event and never lets
//   a field outside the per-kind allowlist reach the file;
// - every record carries the one run id of this process, which a caller cannot
//   override (S18), and the session snapshot also identifies the run: pid,
//   uptime and the host tui mode read from settings.json;
// - the frame observer adds process resource samples: a baseline on the first
//   traced frame, then at most one per interval, with real or absent numbers;
// - writeTraceMode is atomic and refuses to replace a malformed flag;
// - the log rotates to exactly one previous file and stays inside its cap;
// - an over-long line is truncated with a marker instead of being dropped;
// - every entry point returns instead of throwing when the state dir cannot be
//   written;
// - the state directory is the one lib/worktree-mode.js already resolves.

const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modeLib = require('../lib/worktree-mode.js');
const { PERF_KEYS } = require('../lib/pi-perf-settings.js');
const trace = require('../lib/perf-trace.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = 'perf-trace-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// A root with the state dir as its only child, so "never writes outside the
// state directory" is checkable by listing the parent.
function scratchEnv() {
  const root = scratch();
  const dir = path.join(root, 'state');
  return { root, dir, env: { GENTLE_STATUS_STATE_DIR: dir } };
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function readLines(file) {
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'), `${path.basename(file)} is newline terminated`);
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function assertIsoDate(value) {
  assert.equal(typeof value, 'string', 'at is a string');
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'at is an ISO timestamp');
  assert.equal(new Date(value).toISOString(), value, 'at round-trips through Date');
}

beforeEach(() => {
  trace.resetTraceCacheForTests();
});

describe('perf trace disabled state', { concurrency: false }, () => {
  test('a missing flag reads disabled and writes nothing', () => {
    const { root, dir, env } = scratchEnv();

    assert.deepEqual(trace.readTraceMode(env), {
      enabled: false,
      path: path.join(dir, trace.FLAG_NAME),
      reason: 'missing',
    });

    const result = trace.traceEvent('render', { view: 'warp', ms: 3, width: 80, height: 24, rows: 12 }, env);
    assert.deepEqual(result, { written: false, path: path.join(dir, trace.LOG_NAME), reason: 'missing' });

    assert.equal(fs.existsSync(path.join(dir, trace.LOG_NAME)), false, 'no log is created while disabled');
    assert.equal(fs.existsSync(dir), false, 'a disabled trace never creates the state dir');
    assert.deepEqual(fs.readdirSync(root), [], 'nothing is written outside the state directory');
  });

  test('an explicit disabled flag reads disabled and writes nothing', () => {
    const { dir, env } = scratchEnv();
    assert.deepEqual(trace.writeTraceMode(false, env), {
      ok: true,
      changed: true,
      path: path.join(dir, trace.FLAG_NAME),
      error: null,
    });

    assert.deepEqual(trace.readTraceMode(env), {
      enabled: false,
      path: path.join(dir, trace.FLAG_NAME),
      reason: 'disabled',
    });

    for (const kind of ['session', 'render', 'daemon']) {
      const result = trace.traceEvent(kind, { piVersion: '1.3.0', view: 'warp', ms: 1, panes: 1, tokens: 1 }, env);
      assert.equal(result.written, false, `${kind} is not written while disabled`);
      assert.equal(result.reason, 'disabled');
    }

    assert.equal(fs.existsSync(path.join(dir, trace.LOG_NAME)), false, 'the disabled trace writes no log');
    assert.deepEqual(fs.readdirSync(dir), [trace.FLAG_NAME], 'only the flag exists');
  });

  test('writeTraceMode reports changed only when the flag value changes', () => {
    const { dir, env } = scratchEnv();
    assert.equal(trace.writeTraceMode(true, env).changed, true);
    assert.deepEqual(trace.writeTraceMode(true, env), {
      ok: true,
      changed: false,
      path: path.join(dir, trace.FLAG_NAME),
      error: null,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, trace.FLAG_NAME), 'utf8')), {
      version: 1,
      enabled: true,
    });
    assert.equal(trace.writeTraceMode(false, env).changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, trace.FLAG_NAME), 'utf8')), {
      version: 1,
      enabled: false,
    });
  });
});

describe('perf trace events', { concurrency: false }, () => {
  test('an enabled trace appends one parseable line per event with allowlisted fields only', () => {
    const { root, dir, env } = scratchEnv();
    assert.equal(trace.writeTraceMode(true, env).ok, true);

    const written = [
      trace.traceEvent(
        'session',
        {
          piVersion: '1.3.0',
          perf: {
            heightIndex: true,
            evictOffscreenLines: false,
            expandRecentToolOutput: true,
            incrementalSearchCorpus: false,
            renamedSetting: true,
          },
          support: {
            heightIndex: 'declared',
            evictOffscreenLines: 'absent',
            expandRecentToolOutput: 'unknown',
            incrementalSearchCorpus: 'declared',
            renamedSetting: 'absent',
          },
          prompt: 'secret user text',
          cwd: '/home/jona/private-repo',
        },
        env,
      ),
      trace.traceEvent(
        'render',
        { view: 'odd', ms: 12, width: 120, height: 40, rows: 30, title: 'secret document body', file: '/tmp/secret.md' },
        env,
      ),
      trace.traceEvent(
        'daemon',
        { ms: 5, panes: 3, tokens: 99, stdout: 'secret daemon output' },
        env,
      ),
      trace.traceEvent('render', { view: 'settings', ms: 7 }, env),
      trace.traceEvent('daemon', 'not an object', env),
    ];

    for (const result of written) {
      assert.equal(result.written, true, `event was written: ${result.reason}`);
      assert.equal(result.reason, 'written');
      assert.equal(result.path, path.join(dir, trace.LOG_NAME));
    }

    const file = path.join(dir, trace.LOG_NAME);
    const lines = readLines(file);
    assert.equal(lines.length, written.length, 'exactly one line per event');

    assert.deepEqual(lines.map((line) => line.kind), ['session', 'render', 'daemon', 'render', 'daemon']);
    for (const line of lines) assertIsoDate(line.at);

    const [session, render, daemon, unknownView, garbageFields] = lines;

    assert.deepEqual(Object.keys(session), ['at', 'kind', 'piVersion', 'perf', 'support', 'run']);
    assert.equal(session.piVersion, '1.3.0');
    assert.deepEqual(session.perf, {
      heightIndex: true,
      evictOffscreenLines: false,
      expandRecentToolOutput: true,
      incrementalSearchCorpus: false,
    });
    assert.deepEqual(session.support, {
      heightIndex: 'declared',
      evictOffscreenLines: 'absent',
      expandRecentToolOutput: 'unknown',
      incrementalSearchCorpus: 'declared',
    });

    assert.deepEqual(Object.keys(render), ['at', 'kind', 'view', 'ms', 'width', 'height', 'rows', 'run']);
    assert.deepEqual(
      { view: render.view, ms: render.ms, width: render.width, height: render.height, rows: render.rows },
      { view: 'odd', ms: 12, width: 120, height: 40, rows: 30 },
    );

    assert.deepEqual(Object.keys(daemon), ['at', 'kind', 'ms', 'panes', 'tokens', 'run']);
    assert.deepEqual({ ms: daemon.ms, panes: daemon.panes, tokens: daemon.tokens }, { ms: 5, panes: 3, tokens: 99 });

    assert.equal('view' in unknownView, false, 'a view outside warp/odd/issues/create is dropped');
    assert.equal(unknownView.ms, 7, 'the rest of the event still lands');

    assert.deepEqual(Object.keys(garbageFields), ['at', 'kind', 'run'], 'non-object fields degrade to the envelope');

    const raw = fs.readFileSync(file, 'utf8');
    for (const leaked of ['secret', '/home/jona/private-repo', '/tmp/secret.md', 'renamedSetting']) {
      assert.equal(raw.includes(leaked), false, `${leaked} never reaches the log`);
    }

    assert.deepEqual(fs.readdirSync(dir).sort(), [trace.FLAG_NAME, trace.LOG_NAME].sort(), 'only the flag and the log');
    assert.deepEqual(fs.readdirSync(root), ['state'], 'nothing is written outside the state directory');
  });

  test('an unknown kind writes nothing', () => {
    const { dir, env } = scratchEnv();
    trace.writeTraceMode(true, env);

    const result = trace.traceEvent('keypress', { ms: 1, sequence: 'secret' }, env);
    assert.equal(result.written, false);
    assert.equal(result.reason, 'unknown-kind');
    assert.equal(result.path, path.join(dir, trace.LOG_NAME));
    assert.equal(fs.existsSync(path.join(dir, trace.LOG_NAME)), false, 'no log is created for an unknown kind');
  });
});

describe('perf trace malformed flag', { concurrency: false }, () => {
  test('a malformed flag reads disabled and is never overwritten', () => {
    const { dir, env } = scratchEnv();
    fs.mkdirSync(dir, { recursive: true });
    const flag = path.join(dir, trace.FLAG_NAME);
    const garbage = '{"version":1,"enabled":';
    fs.writeFileSync(flag, garbage);

    assert.deepEqual(trace.readTraceMode(env), { enabled: false, path: flag, reason: 'malformed' });

    const event = trace.traceEvent('daemon', { ms: 1, panes: 1, tokens: 1 }, env);
    assert.deepEqual(event, { written: false, path: path.join(dir, trace.LOG_NAME), reason: 'malformed' });
    assert.equal(fs.existsSync(path.join(dir, trace.LOG_NAME)), false, 'a broken flag never starts writing');

    const write = trace.writeTraceMode(true, env);
    assert.equal(write.ok, false);
    assert.equal(write.changed, false);
    assert.equal(write.path, flag);
    assert.match(write.error, /refusing|invalid|malformed/i, 'the refusal explains itself');
    assert.equal(fs.readFileSync(flag, 'utf8'), garbage, 'the malformed bytes are untouched');
    assert.deepEqual(fs.readdirSync(dir), [trace.FLAG_NAME], 'no temp file survives the refusal');
  });

  test('every shape that is not a version 1 boolean flag reads disabled', () => {
    const { dir, env } = scratchEnv();
    fs.mkdirSync(dir, { recursive: true });
    const flag = path.join(dir, trace.FLAG_NAME);

    const rejected = [
      'null',
      '[]',
      '{"version":1}',
      '{"version":2,"enabled":true}',
      '{"version":1,"enabled":"yes"}',
      '{"version":1,"enabled":1}',
      'not json at all',
    ];
    for (const payload of rejected) {
      fs.writeFileSync(flag, payload);
      const mode = trace.readTraceMode(env);
      assert.equal(mode.enabled, false, `${payload} means disabled`);
      assert.equal(mode.reason, 'malformed', `${payload} is reported as malformed`);

      const write = trace.writeTraceMode(true, env);
      assert.equal(write.ok, false, `${payload} is refused`);
      assert.equal(fs.readFileSync(flag, 'utf8'), payload, `${payload} stays on disk`);
    }

    fs.writeFileSync(flag, '{"version":1,"enabled":true}\n');
    assert.equal(trace.readTraceMode(env).enabled, true, 'a valid flag still enables');
  });
});

describe('perf trace log bounds', { concurrency: false }, () => {
  test('the log rotates to exactly one previous file and stays inside its cap', () => {
    const { dir, env } = scratchEnv();
    assert.equal(trace.writeTraceMode(true, env).ok, true);

    const log = path.join(dir, trace.LOG_NAME);
    const rotated = path.join(dir, trace.ROTATED_NAME);
    const cap = trace.MAX_LOG_BYTES;
    assert.ok(Number.isFinite(cap) && cap > 0, 'the cap is a positive byte count');

    let rotations = 0;
    let lastRotatedMtime = null;
    let sent = 0;
    while (rotations < 2 && sent < 20000) {
      const result = trace.traceEvent('daemon', { ms: sent, panes: 2, tokens: 3 }, env);
      assert.equal(result.written, true, `event ${sent} was written`);
      sent += 1;

      const logStat = statOrNull(log);
      assert.ok(logStat.size <= cap, `the log stays within the cap after ${sent} events`);

      const rotatedStat = statOrNull(rotated);
      if (rotatedStat && rotatedStat.mtimeMs !== lastRotatedMtime) {
        rotations += 1;
        lastRotatedMtime = rotatedStat.mtimeMs;
        assert.ok(rotatedStat.size <= cap, 'the previous file is within the cap');
      }
    }

    assert.equal(rotations, 2, 'the log rotated twice');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort(),
      [trace.ROTATED_NAME, trace.LOG_NAME].sort(),
      'exactly one previous file is kept',
    );

    const current = readLines(log);
    const previous = readLines(rotated);
    assert.ok(previous.length > 0, 'the previous file holds complete lines');
    assert.ok(current.length > 0, 'the current file holds complete lines');
    assert.equal(previous[0].kind, 'daemon', 'the previous file is a whole prefix, never a partial line');
    assert.equal(current[current.length - 1].ms, sent - 1, 'writing continues after a rotation');
    assert.ok(previous[0].ms > 0, 'the first generation was dropped, not appended');
  });

  test('an over-long line is truncated with a marker instead of being dropped', () => {
    const { dir, env } = scratchEnv();
    trace.writeTraceMode(true, env);

    const oversize = 'v'.repeat(8000);
    const result = trace.traceEvent('session', { piVersion: oversize, perf: { heightIndex: true } }, env);
    assert.equal(result.written, true, 'the event is still recorded');

    const file = path.join(dir, trace.LOG_NAME);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(raw) <= trace.MAX_LINE_BYTES, 'the line fits the per-line cap');
    assert.equal(raw.includes(oversize), false, 'the oversized value is not written');

    const lines = raw.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 1, 'exactly one line is written');
    const line = JSON.parse(lines[0]);
    assert.equal(line.truncated, true, 'the line says it lost content');
    assert.equal(line.marker, trace.TRUNCATION_MARKER);
    assert.match(line.marker, /truncat/i);
    assert.equal(line.kind, 'session', 'the envelope survives');
    assertIsoDate(line.at);
    assert.ok(line.bytes > trace.MAX_LINE_BYTES, 'the marker names the original size');
  });
});

describe('perf trace unwritable state dir', { concurrency: false }, () => {
  test('a state dir that is a regular file never throws', () => {
    const root = scratch();
    const notADir = path.join(root, 'not-a-dir');
    fs.writeFileSync(notADir, 'keep me');
    const env = { GENTLE_STATUS_STATE_DIR: notADir };

    let mode;
    assert.doesNotThrow(() => {
      mode = trace.readTraceMode(env);
    });
    assert.equal(mode.enabled, false);
    assert.equal(mode.reason, 'unreadable');
    assert.equal(mode.path, path.join(notADir, trace.FLAG_NAME));

    let event;
    assert.doesNotThrow(() => {
      event = trace.traceEvent('render', { view: 'warp', ms: 1, width: 1, height: 1, rows: 1 }, env);
    });
    assert.equal(event.written, false);
    assert.equal(event.reason, 'unreadable');
    assert.equal(event.path, path.join(notADir, trace.LOG_NAME));

    let write;
    assert.doesNotThrow(() => {
      write = trace.writeTraceMode(true, env);
    });
    assert.equal(write.ok, false);
    assert.equal(write.changed, false);
    assert.equal(typeof write.error, 'string');
    assert.equal(fs.readFileSync(notADir, 'utf8'), 'keep me', 'nothing replaced the file in the state dir position');
    assert.deepEqual(fs.readdirSync(root), ['not-a-dir']);
  });

  test('a read-only state dir never throws', () => {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
      // Root ignores the permission bits, so this case cannot be staged here;
      // the file-as-state-dir case above covers the same refusal path.
      return;
    }

    const { root, dir, env } = scratchEnv();
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    try {
      let mode;
      assert.doesNotThrow(() => {
        mode = trace.readTraceMode(env);
      });
      assert.equal(mode.enabled, false, 'no flag reads as missing, which is disabled');

      let write;
      assert.doesNotThrow(() => {
        write = trace.writeTraceMode(true, env);
      });
      assert.equal(write.ok, false);
      assert.equal(write.changed, false);
      assert.match(write.error, /cannot write|EACCES|EPERM/i);

      let event;
      assert.doesNotThrow(() => {
        event = trace.traceEvent('daemon', { ms: 1, panes: 1, tokens: 1 }, env);
      });
      assert.equal(event.written, false);
      assert.deepEqual(fs.readdirSync(dir), [], 'a refused write leaves no temp file behind');
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.deepEqual(fs.readdirSync(root), ['state']);
  });

  test('a missing env is a refusal, not a crash', () => {
    let mode;
    assert.doesNotThrow(() => {
      mode = trace.readTraceMode(null);
    });
    assert.equal(mode.enabled, false);
    assert.equal(mode.reason, 'unresolved');

    let event;
    assert.doesNotThrow(() => {
      event = trace.traceEvent('daemon', { ms: 1 }, null);
    });
    assert.equal(event.written, false);
    assert.equal(event.reason, 'unresolved');

    let write;
    assert.doesNotThrow(() => {
      write = trace.writeTraceMode(true, null);
    });
    assert.equal(write.ok, false);
    assert.equal(write.changed, false);

    let resolvedPath;
    assert.doesNotThrow(() => {
      resolvedPath = trace.tracePath(null);
    });
    assert.equal(resolvedPath, '');
  });
});

describe('perf trace state dir resolution', { concurrency: false }, () => {
  test('the flag and log live in the dir lib/worktree-mode.js already resolves', () => {
    const { dir, env } = scratchEnv();
    assert.equal(modeLib.stateDir(env), dir);
    assert.deepEqual(fs.existsSync(dir), false, 'resolving a path writes nothing');
    assert.equal(trace.tracePath(env), path.join(modeLib.stateDir(env), trace.LOG_NAME));
    assert.equal(trace.readTraceMode(env).path, path.join(modeLib.stateDir(env), trace.FLAG_NAME));
  });

  test('the XDG state fallback is the shared one, not a second resolver', () => {
    const xdg = scratch('perf-trace-xdg-');
    const env = { XDG_STATE_HOME: xdg };
    assert.equal(trace.tracePath(env), path.join(modeLib.stateDir(env), trace.LOG_NAME));
    assert.equal(
      trace.tracePath(env),
      path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents', trace.LOG_NAME),
    );
    assert.equal(trace.readTraceMode(env).path, path.join(modeLib.stateDir(env), trace.FLAG_NAME));
    assert.deepEqual(fs.readdirSync(xdg), [], 'resolving never creates the state dir');
  });

  // The flag only earns its own state dir when that dir is recognised as
  // ours; otherwise an injected dir wins and a trace switched on here reads
  // as missing there.
  test('a stored dir holding only the trace flag is recognised as ours', () => {
    const xdg = scratch('perf-trace-only-flag-');
    const stored = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents');
    fs.mkdirSync(stored, { recursive: true });
    fs.writeFileSync(path.join(stored, trace.FLAG_NAME), JSON.stringify({ version: 1, enabled: true }));
    const injected = scratch('perf-trace-injected-');
    const env = { XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected };
    assert.equal(modeLib.stateDir(env), stored);
    assert.equal(trace.readTraceMode(env).enabled, true, 'the flag in the stored dir is the one that counts');
  });

  test('the module exports the documented names', () => {
    assert.deepEqual([...PERF_KEYS], [
      'heightIndex',
      'evictOffscreenLines',
      'expandRecentToolOutput',
      'incrementalSearchCorpus',
    ]);
    assert.equal(trace.FLAG_NAME, 'gentle-perf-trace.json');
    assert.equal(trace.LOG_NAME, 'perf-trace.jsonl');
    assert.deepEqual([...trace.RENDER_VIEWS], ['warp', 'odd', 'issues', 'create', 'detail']);
    assert.deepEqual([...trace.SUPPORT_STATES], ['declared', 'absent', 'unknown']);
  });
});

// S14/D4: one traced frame writes the component's own render duration and a
// SEPARATE observer sample. The append cost a sample carries is the cost of
// writes that already finished (the previous sample's), so no line contains a
// fabricated duration for the write that produces it. The host contributes a
// public counter with its support state, and the event loop a bounded
// process-level interval — never a relabelled component or host duration.
describe('perf trace frame observer', { concurrency: false }, () => {
  const quietHost = { terminal: { rows: 24 } };

  function framesEnv() {
    const { dir, env } = scratchEnv();
    assert.equal(trace.writeTraceMode(true, env).ok, true);
    return { dir, env };
  }

  function logLines(dir) {
    const file = path.join(dir, trace.LOG_NAME);
    return fs.existsSync(file) ? readLines(file) : [];
  }

  function samples(dir) {
    return logLines(dir).filter((line) => line.kind === 'observer');
  }

  test('a frame writes the component duration and a separate observer sample', () => {
    const { dir, env } = framesEnv();
    const observer = trace.createFrameObserver({ view: 'odd', env, host: quietHost, terminalRows: () => 24 });
    observer.frame({ ms: 4, width: 80, rows: 12 });

    const lines = logLines(dir);
    assert.deepEqual(lines.map((line) => line.kind), ['render', 'observer', 'resource'], 'the first frame also writes the resource baseline');
    const [render, sample] = lines;
    assert.deepEqual(Object.keys(render), ['at', 'kind', 'view', 'ms', 'width', 'height', 'rows', 'run'], 'the render line keeps its documented shape');
    assert.deepEqual(
      { view: render.view, ms: render.ms, width: render.width, height: render.height, rows: render.rows },
      { view: 'odd', ms: 4, width: 80, height: 24, rows: 12 },
      'the render line carries the component duration only',
    );
    assert.equal(sample.view, 'odd');
    assert.equal(sample.frame, 1);
    assert.equal(sample.measuredAppends, 0, 'no write had been measured before the first sample');
    assert.equal('prevAppendMs' in sample, false, 'a sample never invents a cost it did not measure');
    assert.equal(sample.hostFullRedrawsState, 'absent', 'a host without the counter says so');
    assert.equal(sample.hostRenderMsState, 'absent', 'the public host exposes no render-duration observer');
  });

  test('the append cost a sample carries is the previous sample\'s, never the current write', () => {
    // The injected clock makes the trailing semantics exact: the second sample
    // must report the FIRST frame's three writes (render 5 + observer 3 +
    // resource 200 ms) and never the 100 + 200 ms the second frame itself spent.
    const { dir, env } = framesEnv();
    const stamps = [0, 5, 5, 8, 8, 8, 208, 208, 308, 308, 508, 508];
    let tick = 0;
    const nowMs = () => stamps[Math.min(tick++, stamps.length - 1)];
    const observer = trace.createFrameObserver({ view: 'odd', env, host: quietHost, nowMs });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    observer.frame({ ms: 1, width: 80, rows: 1 });

    const [first, second] = samples(dir);
    assert.equal(first.measuredAppends, 0);
    assert.equal(second.measuredAppends, 3, 'all three writes of the previous frame were measured');
    assert.equal(second.prevAppendMs, 208, 'the previous frame cost 5 + 3 + 200 ms; the current 100 + 200 is not reported');
  });

  test('the host full-redraw counter is a snapshot with its state, never a duration', () => {
    const { dir, env } = framesEnv();
    let redraws = 12;
    const host = { terminal: { rows: 24 }, get fullRedraws() { return redraws; } };
    const observer = trace.createFrameObserver({ view: 'odd', env, host, terminalRows: () => 24 });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    redraws = 15;
    observer.frame({ ms: 1, width: 80, rows: 1 });

    const [first, second] = samples(dir);
    assert.equal(first.hostFullRedrawsState, 'declared');
    assert.equal(first.hostFullRedraws, 12);
    assert.equal('hostFullRedrawsDelta' in first, false, 'no delta without a previous snapshot');
    assert.equal(second.hostFullRedraws, 15);
    assert.equal(second.hostFullRedrawsDelta, 3);
    assert.equal(second.hostRenderMsState, 'absent', 'a counter is not a duration');
    for (const key of Object.keys(second)) {
      assert.equal(/^host.*Ms$/.test(key), false, `${key} is not an invented host duration`);
    }
  });

  test('a missing, throwing or uninterpretable host counter is reported, never guessed', () => {
    const { dir, env } = framesEnv();
    const hosts = [
      { terminal: { rows: 24 }, get fullRedraws() { throw new Error('boom'); } },
      { terminal: { rows: 24 }, fullRedraws: 'many' },
      { terminal: { rows: 24 } },
      undefined,
    ];
    for (const host of hosts) {
      const observer = trace.createFrameObserver({ view: 'odd', env, host, terminalRows: () => 24 });
      observer.frame({ ms: 1, width: 80, rows: 1 });
    }

    const [throwing, texty, absent, missing] = samples(dir);
    assert.equal(throwing.hostFullRedrawsState, 'unknown', 'a throwing getter is unreadable, not absent');
    assert.equal(throwing.hostRenderMsState, 'unknown', 'the host could not be inspected');
    assert.equal('hostFullRedraws' in throwing, false);
    assert.equal(texty.hostFullRedrawsState, 'unknown', 'a non-numeric counter is not a count');
    assert.equal('hostFullRedraws' in texty, false);
    assert.equal(absent.hostFullRedrawsState, 'absent');
    assert.equal(missing.hostFullRedrawsState, 'unknown', 'a host that was never inspected is unknown');
  });

  test('the event-loop metric is a bounded process-level interval, never a component duration', () => {
    const { dir, env } = framesEnv();
    const readings = [
      { active: 10, idle: 90 },
      { active: 30, idle: 190 },
      { active: 5, idle: 3 },
    ];
    let read = 0;
    const sampleLoop = () => readings[Math.min(read++, readings.length - 1)];
    const observer = trace.createFrameObserver({ view: 'odd', env, host: quietHost, sampleLoop });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    observer.frame({ ms: 1, width: 80, rows: 1 });

    const [first, second, backwards] = samples(dir);
    assert.equal('processLoopUtilization' in first, false, 'the first reading is only a baseline');
    assert.equal('processLoopState' in first, false);
    assert.equal(second.processLoopState, 'declared');
    assert.equal(second.processLoopActiveMs, 20);
    assert.equal(second.processLoopIdleMs, 100);
    assert.equal(second.processLoopWindowMs, 120);
    assert.equal(second.processLoopUtilization, 0.1667, 'a bounded 0..1 ratio of the interval');
    for (const key of Object.keys(second)) {
      if (/^(active|idle|utilization|window)/i.test(key)) {
        assert.match(key, /^processLoop/, `${key} names its scope`);
      }
    }
    assert.equal('processLoopUtilization' in backwards, false, 'a reading that goes backwards is dropped');
    assert.equal('processLoopWindowMs' in backwards, false);
    assert.equal(backwards.processLoopState, 'unknown');
  });

  test('zero-window bootstrap samples remain unknown and later advancing samples work', () => {
    // Node may return zero samples before the event loop has bootstrapped.
    // No elapsed window proves neither zero load nor missing API support.
    const { dir, env } = framesEnv();
    let reads = 0;
    const observer = trace.createFrameObserver({
      view: 'odd',
      env,
      host: quietHost,
      sampleLoop: () => (++reads <= 2 ? { active: 0, idle: 0 } : { active: 8, idle: 2 }),
    });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    observer.frame({ ms: 1, width: 80, rows: 1 });

    const second = samples(dir)[1];
    assert.equal(second.processLoopState, 'unknown', 'a zero window is not proof of unsupported ELU');
    for (const key of ['processLoopUtilization', 'processLoopActiveMs', 'processLoopIdleMs', 'processLoopWindowMs']) {
      assert.equal(key in second, false, `${key} is not invented from 0/0`);
    }
    observer.frame({ ms: 1, width: 80, rows: 1 });
    const third = samples(dir)[2];
    assert.equal(third.processLoopState, 'declared');
    assert.equal(third.processLoopUtilization, 0.8);
  });

  test('an unusable loop sampler or state environment never breaks the frame', () => {
    const { dir, env } = framesEnv();
    const observer = trace.createFrameObserver({
      view: 'odd',
      env,
      host: quietHost,
      sampleLoop: () => { throw new Error('no perf_hooks'); },
    });
    assert.doesNotThrow(() => observer.frame({ ms: 2, width: 80, rows: 3 }));
    const [, sample] = logLines(dir);
    assert.equal('processLoopUtilization' in sample, false, 'an unsampleable loop records nothing');
    assert.equal(sample.frame, 1, 'the rest of the sample still lands');

    const nowhere = trace.createFrameObserver({ view: 'odd', env: null, host: quietHost });
    assert.doesNotThrow(() => nowhere.frame({ ms: 2, width: 80, rows: 3 }));
  });

  test('nothing is written, and nothing is logged, while tracing is off', () => {
    const { dir, env } = scratchEnv();
    const observer = trace.createFrameObserver({ view: 'odd', env, host: quietHost });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    assert.equal(fs.existsSync(path.join(dir, trace.LOG_NAME)), false, 'the disabled trace writes no log');
    assert.equal(fs.existsSync(dir), false, 'and creates no state directory');
  });

  test('an observer event reduces unlisted and out-of-range fields to nothing', () => {
    const { dir, env } = framesEnv();
    const result = trace.traceEvent('observer', {
      view: 'settings',
      frame: -1,
      measuredAppends: 7,
      prevAppendMs: -5,
      hostFullRedrawsState: 'maybe',
      hostRenderMsState: 'declared',
      hostFullRedraws: 1e12,
      hostFullRedrawsDelta: -3,
      processLoopUtilization: 4,
      processLoopWindowMs: 1e12,
      processLoopState: 'maybe',
      prompt: 'secret user text',
      cwd: '/home/jona/private-repo',
    }, env);
    assert.equal(result.written, true);

    const [line] = readLines(path.join(dir, trace.LOG_NAME));
    assert.equal(line.measuredAppends, 7, 'an in-range count lands');
    assert.equal(line.hostRenderMsState, 'declared', 'a support state is one of the three values');
    assert.equal('frame' in line, false, 'a negative sample index is dropped');
    assert.equal('prevAppendMs' in line, false, 'a negative cost is dropped');
    assert.equal('hostFullRedraws' in line, false, 'an over-cap counter is dropped');
    assert.equal('hostFullRedrawsDelta' in line, false);
    assert.equal('hostFullRedrawsState' in line, false, 'an unlisted state is not evidence');
    assert.equal('processLoopUtilization' in line, false, 'a ratio above 1 is dropped');
    assert.equal('processLoopWindowMs' in line, false);
    assert.equal('processLoopState' in line, false, 'an unlisted loop state is not evidence');
    assert.equal('view' in line, false, 'settings is not a traced view');

    const raw = fs.readFileSync(path.join(dir, trace.LOG_NAME), 'utf8');
    for (const leaked of ['secret', '/home/jona/private-repo']) assert.equal(raw.includes(leaked), false);
  });
});

// S16: the flag is written by the panel (Pi) and read by the daemon (another
// process). A verdict cached without re-checking the file would freeze the
// first read and leave tracing inert until a restart, so every entry point
// re-validates the flag against the bytes on disk.
describe('perf trace cross-process flag changes', { concurrency: false }, () => {
  test('a flag another process wrote is noticed without a restart', () => {
    const { dir, env } = scratchEnv();
    const flag = path.join(dir, trace.FLAG_NAME);
    assert.equal(trace.writeTraceMode(true, env).ok, true);

    assert.equal(trace.traceEvent('daemon', { ms: 1, panes: 1, tokens: 1 }, env).written, true);

    // The panel switching tracing OFF: the bytes change, this process's writer
    // never runs, so only a re-validation of the file can notice.
    fs.writeFileSync(flag, '{"version":1,"enabled":false}\n');
    const off = trace.traceEvent('daemon', { ms: 2, panes: 1, tokens: 1 }, env);
    assert.equal(off.written, false, 'the next event is not written');
    assert.equal(off.reason, 'disabled');

    // And back ON: the daemon must not stay stuck on its first verdict.
    fs.writeFileSync(flag, '{"version":1,"enabled":true}\n');
    assert.equal(trace.traceEvent('daemon', { ms: 3, panes: 1, tokens: 1 }, env).written, true);

    assert.deepEqual(readLines(path.join(dir, trace.LOG_NAME)).map((line) => line.ms), [1, 3]);
  });

  test('readTraceMode reports a flag another process just wrote', () => {
    const { dir, env } = scratchEnv();
    const flag = path.join(dir, trace.FLAG_NAME);
    assert.equal(trace.readTraceMode(env).enabled, false);

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(flag, '{"version":1,"enabled":true}\n');
    assert.equal(trace.readTraceMode(env).enabled, true, 'an enable written elsewhere is seen');

    fs.writeFileSync(flag, '{"version":1,"enabled":false}\n');
    assert.equal(trace.readTraceMode(env).enabled, false, 'a disable written elsewhere is seen');

    fs.rmSync(flag);
    assert.deepEqual(trace.readTraceMode(env), {
      enabled: false,
      path: flag,
      reason: 'missing',
    }, 'a removed flag reads as missing again');
  });
});

// The S16 session snapshot: what a run is, written before its events. Only
// while tracing is on — the support scan reads the whole installed package, so
// a disabled trace must never pay for it.
describe('perf trace session snapshot', { concurrency: false }, () => {
  function snapshotEnv() {
    const root = scratch('perf-trace-session-');
    const stateDir = path.join(root, 'state');
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    return { root, stateDir, agentDir, env: { GENTLE_STATUS_STATE_DIR: stateDir, PI_CODING_AGENT_DIR: agentDir } };
  }

  test('a disabled trace writes no snapshot and never runs the scan', () => {
    const { root, stateDir, env } = snapshotEnv();
    let scans = 0;
    const result = trace.traceSession(env, { scan: () => { scans += 1; return { keys: {} }; } });
    assert.deepEqual(result, {
      written: false,
      path: path.join(stateDir, trace.LOG_NAME),
      reason: 'missing',
    });
    assert.equal(scans, 0, 'the installed package is never scanned while tracing is off');
    assert.equal(fs.existsSync(stateDir), false, 'no state dir, no log');
    assert.deepEqual(fs.readdirSync(root), ['agent'], 'nothing is written');
  });

  test('an enabled snapshot records the four switches, the Pi version and per-key evidence', () => {
    const { agentDir, env } = snapshotEnv();
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{"heightIndex":true,"incrementalSearchCorpus":true}\n');
    trace.writeTraceMode(true, env);

    const result = trace.traceSession(env, {
      scan: () => ({
        ok: true,
        piVersion: '1.3.0',
        keys: {
          heightIndex: { state: 'declared', evidence: 'dist/x.js (2 matches)' },
          evictOffscreenLines: { state: 'absent', evidence: 'no match in 700 scanned files' },
          expandRecentToolOutput: { state: 'unknown', evidence: 'scan failed: byte budget' },
          incrementalSearchCorpus: { state: 'declared', evidence: 'dist/x.js (1 match)' },
        },
      }),
    });
    assert.equal(result.written, true, result.reason);

    const [line] = readLines(result.path);
    assert.deepEqual(Object.keys(line), ['at', 'kind', 'piVersion', 'perf', 'support', 'pid', 'uptimeMs', 'run']);
    assert.equal(line.kind, 'session');
    assert.equal(line.piVersion, '1.3.0');
    assert.deepEqual(line.perf, {
      heightIndex: true,
      evictOffscreenLines: false,
      expandRecentToolOutput: false,
      incrementalSearchCorpus: true,
    }, 'an unset setting is the OFF default, so both runs stay comparable');
    assert.deepEqual(line.support, {
      heightIndex: 'declared',
      evictOffscreenLines: 'absent',
      expandRecentToolOutput: 'unknown',
      incrementalSearchCorpus: 'declared',
    }, 'evidence is the three states only, never a speed claim');

    const raw = fs.readFileSync(result.path, 'utf8');
    for (const leaked of ['dist/x.js', 'no match in', 'scan failed', 'byte budget']) {
      assert.equal(raw.includes(leaked), false, `${leaked} is evidence detail, not log content`);
    }
  });

  test('a scan that cannot run still records the switches and marks the evidence unknown', () => {
    const { env } = snapshotEnv();
    trace.writeTraceMode(true, env);
    const result = trace.traceSession(env, {
      scan: () => ({
        ok: false,
        error: 'cannot resolve the installed package',
        keys: Object.fromEntries(PERF_KEYS.map((key) => [key, { state: 'unknown', evidence: 'scan failed' }])),
      }),
    });
    assert.equal(result.written, true);
    const [line] = readLines(result.path);
    assert.equal(line.kind, 'session');
    assert.equal(line.piVersion, undefined, 'a failed scan claims no version');
    assert.deepEqual(line.perf, {
      heightIndex: false,
      evictOffscreenLines: false,
      expandRecentToolOutput: false,
      incrementalSearchCorpus: false,
    });
    assert.deepEqual(Object.values(line.support), ['unknown', 'unknown', 'unknown', 'unknown']);
  });

  test('a scanner that throws leaves the snapshot without evidence instead of failing', () => {
    const { env } = snapshotEnv();
    trace.writeTraceMode(true, env);
    const result = trace.traceSession(env, { scan: () => { throw new Error('boom'); } });
    assert.equal(result.written, true);
    const [line] = readLines(result.path);
    assert.equal(line.kind, 'session');
    assert.equal('support' in line, false, 'no invented evidence');
    assert.equal('piVersion' in line, false);
  });
});

// S18: a trace is only useful for conclusions if two sessions can be told
// apart. Every record therefore carries the one run id of this process, and the
// session snapshot also identifies the run itself: the pid, the process uptime
// and which TUI the host was running. The tui mode is READ from settings.json
// and never written: the trace has no business editing host configuration.
describe('perf trace run identity', { concurrency: false }, () => {
  const settings = require('../lib/pi-perf-settings.js');

  function identityEnv(settingsText) {
    const root = scratch('perf-trace-identity-');
    const stateDir = path.join(root, 'state');
    const agentDir = path.join(root, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    if (settingsText !== null) fs.writeFileSync(path.join(agentDir, 'settings.json'), settingsText);
    return {
      root,
      stateDir,
      agentDir,
      file: path.join(agentDir, 'settings.json'),
      env: { GENTLE_STATUS_STATE_DIR: stateDir, PI_CODING_AGENT_DIR: agentDir },
    };
  }

  test('every record carries the run id, and a caller cannot override it', () => {
    const { stateDir, env } = identityEnv('{"tuiMode":"regular"}\n');
    assert.equal(trace.writeTraceMode(true, env).ok, true);
    assert.equal(trace.traceSession(env, { scan: () => ({ keys: {} }) }).written, true);
    trace.traceEvent('render', { view: 'odd', ms: 1, width: 80, height: 24, rows: 1, run: 'caller-chosen' }, env);
    trace.traceEvent('observer', { view: 'odd', frame: 1, run: 'caller-chosen' }, env);
    trace.traceEvent('resource', { frames: 1, rssMB: 10, run: 'caller-chosen' }, env);
    trace.traceEvent('daemon', { ms: 1, panes: 1, tokens: 1 }, env);

    const lines = readLines(path.join(stateDir, trace.LOG_NAME));
    assert.deepEqual(lines.map((line) => line.kind), ['session', 'render', 'observer', 'resource', 'daemon']);
    assert.equal(typeof trace.RUN_ID, 'string');
    assert.ok(trace.RUN_ID.length > 0, 'the module exposes the run id it stamps');
    for (const line of lines) {
      assert.equal(line.run, trace.RUN_ID, `${line.kind} carries this process's run id`);
      assert.equal(Object.keys(line).at(-1), 'run', 'the run id is added last and cannot be overridden');
    }
  });

  test('the session snapshot identifies the run: pid, uptime and the host tui mode', () => {
    const { file, env } = identityEnv('{"tuiMode":"regular","heightIndex":true}\n');
    assert.equal(trace.writeTraceMode(true, env).ok, true);
    assert.equal(trace.traceSession(env, { scan: () => ({ keys: {} }) }).written, true);

    const [line] = readLines(trace.tracePath(env));
    assert.equal(line.pid, process.pid);
    assert.equal(typeof line.uptimeMs, 'number');
    assert.ok(line.uptimeMs >= 0 && line.uptimeMs <= 1e10, 'a bounded uptime');
    assert.equal(line.tuiMode, 'regular', 'the host mode comes from settings.json');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"tuiMode":"regular","heightIndex":true}\n', 'settings.json is read, never written');
  });

  test('an unusable tui mode is left out instead of guessed', () => {
    const cases = [null, '{"tuiMode":"split"}\n', '{"tuiMode":true}\n', 'not json at all\n', '{"heightIndex":true}\n'];
    for (const settingsText of cases) {
      const { env } = identityEnv(settingsText);
      assert.equal(trace.writeTraceMode(true, env).ok, true);
      assert.equal(trace.traceSession(env, { scan: () => ({ keys: {} }) }).written, true);
      const [line] = readLines(trace.tracePath(env));
      assert.equal('tuiMode' in line, false, `${settingsText} yields no tui mode`);
      assert.equal(line.pid, process.pid, 'the rest of the identity still lands');
      assert.equal(typeof line.uptimeMs, 'number');
      assert.equal(line.run, trace.RUN_ID);
    }
  });

  test('readHostValues reports the host tui mode and creates nothing', () => {
    const { file, env } = identityEnv(null);
    assert.deepEqual(settings.readHostValues(env), { ok: true, path: file, values: {} });
    assert.equal(fs.existsSync(file), false, 'reading a missing settings file never creates it');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), []);

    fs.writeFileSync(file, '{"tuiMode":"fullscreen","heightIndex":true}\n');
    assert.deepEqual(settings.readHostValues(env), { ok: true, path: file, values: { tuiMode: 'fullscreen' } });
    assert.equal(fs.readFileSync(file, 'utf8'), '{"tuiMode":"fullscreen","heightIndex":true}\n');

    fs.writeFileSync(file, '{"tuiMode":"split"}\n');
    assert.deepEqual(settings.readHostValues(env), { ok: true, path: file, values: {} }, 'an unknown mode is not a value');

    fs.writeFileSync(file, '{"tuiMode":\n');
    const broken = settings.readHostValues(env);
    assert.equal(broken.ok, false, 'a file that cannot be parsed is reported as unreadable');
    assert.equal(broken.path, file);
    assert.deepEqual(broken.values, {});
    assert.equal(fs.readFileSync(file, 'utf8'), '{"tuiMode":\n', 'the broken file is untouched');
  });
});

// S18: collecting render timings alone cannot answer "what did enabling the
// switches cost this Pi process". The observer therefore samples the process
// itself: memory and CPU, bounded and rounded, once immediately so even a short
// run has a baseline, then at most once per interval. A sampler that fails
// writes no numbers rather than a zero someone would average later.
describe('perf trace resource samples', { concurrency: false }, () => {
  const quietHost = { terminal: { rows: 24 } };

  function framesEnv() {
    const { dir, env } = scratchEnv();
    assert.equal(trace.writeTraceMode(true, env).ok, true);
    return { dir, env };
  }

  function logLines(dir) {
    const file = path.join(dir, trace.LOG_NAME);
    return fs.existsSync(file) ? readLines(file) : [];
  }

  function resources(dir) {
    return logLines(dir).filter((line) => line.kind === 'resource');
  }

  test('the first traced frame writes a baseline, then samples follow the interval', () => {
    const { dir, env } = framesEnv();
    let now = 1000;
    let cpuReads = 0;
    const observer = trace.createFrameObserver({
      view: 'odd',
      env,
      host: quietHost,
      terminalRows: () => 24,
      nowMs: () => now,
      resourceIntervalMs: 1000,
      sampleMemory: () => ({ rss: 209715200, heapUsed: 41943040, heapTotal: 52428800, external: 1048576 }),
      sampleCpu: () => {
        cpuReads += 1;
        return cpuReads === 1 ? { user: 1200000, system: 200000 } : { user: 1300000, system: 200000 };
      },
    });

    observer.frame({ ms: 1, width: 80, rows: 1 });
    const baseline = resources(dir);
    assert.equal(baseline.length, 1, 'the baseline is written with the first frame, not later');
    assert.equal(baseline[0].run, trace.RUN_ID);
    assert.equal(baseline[0].frames, 1, 'frames since the previous sample, so the frame that wrote it');
    assert.equal(baseline[0].rssMB, 200);
    assert.equal(baseline[0].heapUsedMB, 40);
    assert.equal(baseline[0].heapTotalMB, 50);
    assert.equal(baseline[0].externalMB, 1);
    assert.equal(baseline[0].cpuUserMs, 1200, 'CPU milliseconds this process had used');
    assert.equal(baseline[0].cpuSystemMs, 200);
    assert.equal('windowMs' in baseline[0], false, 'the baseline covers no window');
    assert.equal('cpuPercent' in baseline[0], false, 'and therefore has no percentage');
    for (const key of Object.keys(baseline[0])) {
      assert.ok(['at', 'kind', 'frames', 'rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB', 'cpuUserMs', 'cpuSystemMs', 'windowMs', 'cpuPercent', 'run'].includes(key), `${key} is allowlisted`);
    }

    now += 500;
    observer.frame({ ms: 1, width: 80, rows: 1 });
    assert.equal(resources(dir).length, 1, 'a frame inside the interval writes no sample');

    now += 1000;
    observer.frame({ ms: 1, width: 80, rows: 1 });
    const [, sample] = resources(dir);
    assert.equal(sample.frames, 2, 'two frames since the baseline');
    assert.equal(sample.windowMs, 1500, 'the wall time the sample covers');
    assert.equal(sample.cpuPercent, 6.7, '100 * (100 ms of CPU / 1500 ms)');
    assert.equal(sample.cpuUserMs, 1300, 'the cumulative CPU reading of this sample');
    assert.equal(sample.rssMB, 200);
  });

  test('a sampler that fails writes no numbers instead of invented ones', () => {
    const { dir, env } = framesEnv();
    const throwing = trace.createFrameObserver({
      view: 'odd',
      env,
      host: quietHost,
      nowMs: () => 1000,
      sampleMemory: () => { throw new Error('memoryUsage exploded'); },
      sampleCpu: () => 'not a cpu reading',
    });
    assert.doesNotThrow(() => throwing.frame({ ms: 1, width: 80, rows: 1 }));

    const [onlyFrames] = resources(dir);
    assert.equal(onlyFrames.frames, 1, 'the frame count is still real');
    for (const key of ['rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB', 'cpuUserMs', 'cpuSystemMs', 'windowMs', 'cpuPercent']) {
      assert.equal(key in onlyFrames, false, `${key} is absent when its sampler failed`);
    }

    const nonsense = trace.createFrameObserver({
      view: 'issues',
      env,
      host: quietHost,
      nowMs: () => 5000,
      sampleMemory: () => ({ rss: -1, heapUsed: Number.NaN, heapTotal: 1e18, external: 'lots' }),
      sampleCpu: () => ({ user: -5, system: 1e18 }),
    });
    nonsense.frame({ ms: 1, width: 80, rows: 1 });
    const [outOfRange] = resources(dir).slice(1);
    for (const key of ['rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB', 'cpuUserMs', 'cpuSystemMs']) {
      assert.equal(key in outOfRange, false, `${key} is dropped when it is not a real reading`);
    }
  });

  test('a disabled trace samples nothing at all', () => {
    const { dir, env } = scratchEnv();
    let calls = 0;
    const observer = trace.createFrameObserver({
      view: 'odd',
      env,
      host: quietHost,
      nowMs: () => 1000,
      sampleMemory: () => { calls += 1; return { rss: 1000 }; },
      sampleCpu: () => { calls += 1; return { user: 1, system: 1 }; },
    });
    observer.frame({ ms: 1, width: 80, rows: 1 });
    observer.frame({ ms: 1, width: 80, rows: 1 });

    assert.equal(calls, 0, 'nothing is sampled for a frame the log will not describe');
    assert.equal(fs.existsSync(path.join(dir, trace.LOG_NAME)), false);
    assert.equal(fs.existsSync(dir), false);
  });

  test('a write that fails in the same frame ends the resource sampling too', () => {
    // The panel (another process) switching tracing off between the render line
    // and the observer line is a real race; the frame must then stop sampling
    // instead of writing a resource line for a frame it could not describe.
    const { dir, env } = framesEnv();
    const flag = path.join(dir, trace.FLAG_NAME);
    let clockReads = 0;
    let calls = 0;
    const observer = trace.createFrameObserver({
      view: 'odd',
      env,
      host: quietHost,
      nowMs: () => {
        clockReads += 1;
        if (clockReads === 3) fs.writeFileSync(flag, '{"version":1,"enabled":false}\n');
        return 1000 + clockReads;
      },
      sampleMemory: () => { calls += 1; return { rss: 1000 }; },
      sampleCpu: () => { calls += 1; return { user: 1, system: 1 }; },
    });

    observer.frame({ ms: 1, width: 80, rows: 1 });
    assert.deepEqual(logLines(dir).map((line) => line.kind), ['render'], 'only the line that already succeeded is written');
    assert.equal(calls, 0, 'no sampler runs after a failed append');
  });

  test('an unbalanced resource event is reduced to its allowlisted fields', () => {
    const { dir, env } = framesEnv();
    const result = trace.traceEvent('resource', {
      frames: 4.5,
      rssMB: 1e6,
      heapUsedMB: 12,
      heapTotalMB: -1,
      externalMB: 3,
      cpuUserMs: 1e12,
      cpuSystemMs: 7,
      windowMs: 900,
      cpuPercent: 1e7,
      prompt: 'secret user text',
      cwd: '/home/jona/private-repo',
    }, env);
    assert.equal(result.written, true);

    const [line] = readLines(path.join(dir, trace.LOG_NAME));
    assert.equal(line.heapUsedMB, 12);
    assert.equal(line.externalMB, 3);
    assert.equal(line.cpuSystemMs, 7);
    assert.equal(line.windowMs, 900);
    assert.equal('frames' in line, false, 'a fractional frame count is not a count');
    assert.equal('rssMB' in line, false, 'an over-cap RSS is dropped');
    assert.equal('heapTotalMB' in line, false, 'a negative memory reading is dropped');
    assert.equal('cpuUserMs' in line, false, 'an over-cap CPU reading is dropped');
    assert.equal('cpuPercent' in line, false, 'an over-cap percentage is dropped');
    for (const key of Object.keys(line)) {
      assert.ok(['at', 'kind', 'frames', 'rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB', 'cpuUserMs', 'cpuSystemMs', 'windowMs', 'cpuPercent', 'run'].includes(key), `${key} is allowlisted`);
    }
    const raw = fs.readFileSync(path.join(dir, trace.LOG_NAME), 'utf8');
    for (const leaked of ['secret', '/home/jona/private-repo']) assert.equal(raw.includes(leaked), false);
  });
});
