'use strict';
// Tests for lib/perf-trace.js: the writer half of the S16 Performance trace.
//
// Contract under test (observable behavior only — the bytes on disk, which
// files exist, the returned verdicts; never internal helper names):
// - a missing, malformed, unreadable or explicitly-disabled flag writes
//   nothing and creates no log;
// - an enabled trace appends one parseable JSON line per event and never lets
//   a field outside the per-kind allowlist reach the file;
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

    assert.deepEqual(Object.keys(session), ['at', 'kind', 'piVersion', 'perf', 'support']);
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

    assert.deepEqual(Object.keys(render), ['at', 'kind', 'view', 'ms', 'width', 'height', 'rows']);
    assert.deepEqual(
      { view: render.view, ms: render.ms, width: render.width, height: render.height, rows: render.rows },
      { view: 'odd', ms: 12, width: 120, height: 40, rows: 30 },
    );

    assert.deepEqual(Object.keys(daemon), ['at', 'kind', 'ms', 'panes', 'tokens']);
    assert.deepEqual({ ms: daemon.ms, panes: daemon.panes, tokens: daemon.tokens }, { ms: 5, panes: 3, tokens: 99 });

    assert.equal('view' in unknownView, false, 'a view outside warp/odd/issues/create is dropped');
    assert.equal(unknownView.ms, 7, 'the rest of the event still lands');

    assert.deepEqual(Object.keys(garbageFields), ['at', 'kind'], 'non-object fields degrade to the envelope');

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

  test('the module exports the documented names', () => {
    assert.deepEqual([...PERF_KEYS], [
      'heightIndex',
      'evictOffscreenLines',
      'expandRecentToolOutput',
      'incrementalSearchCorpus',
    ]);
    assert.equal(trace.FLAG_NAME, 'gentle-perf-trace.json');
    assert.equal(trace.LOG_NAME, 'perf-trace.jsonl');
    assert.deepEqual([...trace.RENDER_VIEWS], ['warp', 'odd', 'issues', 'create']);
    assert.deepEqual([...trace.SUPPORT_STATES], ['declared', 'absent', 'unknown']);
  });
});
