'use strict';
// S14/D4: perfTraceView as the extension actually wires it — a traced frame
// writes the component's own render duration in one line and a separate
// observer sample in another, and the observer reads only the PUBLIC root host
// surface (the full-redraw counter), never a private one.
//
// Contract under test (observable behavior only — the JSONL bytes on disk:
// which lines exist, their allowlisted fields, and whether a disabled trace
// writes anything at all):
// - one traced frame writes one `render` line and one `observer` line, and the
//   first traced frame also writes the `resource` baseline (S18);
// - the component duration stays on the render line, the observer line carries
//   the trailing append cost of the writes that already finished;
// - the host counter is a snapshot plus its support state, and the host
//   render duration is reported as absent rather than guessed from a counter;
// - a disabled trace writes no log and mounts the view unchanged;
// - no rendered text reaches the log.

const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText
  .replace('import { Type } from "@earendil-works/pi-ai";', TYPE_STUB)
  .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (def) => def;');
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function track(dir) {
  roots.push(dir);
  return dir;
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

function traceLib() {
  return require('../lib/perf-trace.js');
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function makeRepo() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-obs-')));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  const root = fs.realpathSync(dir);
  const doc = path.join(root, 'odd', 'tasks', 'traced.md');
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, '# Traced\n\nBODY-THAT-MUST-NEVER-BE-LOGGED\n');
  return root;
}

// The view is a stub so the observer contract, not the odd renderer, is what
// this file measures: a lib copy whose odd view renders one known row.
function stubbedLibDir() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-obs-lib-')));
  fs.cpSync(LIB_DIR, dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'odd-view.js'),
    'exports.createOddView = () => ({ render() { return ["STUB-ROW-NEVER-LOGGED"]; }, handleInput() {}, invalidate() {} });\n',
  );
  return dir;
}

function scratchEnv(libDir) {
  return {
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-obs-state-'))),
    PI_CODING_AGENT_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-obs-agent-'))),
    GENTLE_PI_AGENT_HOME: undefined,
    GENTLE_WORKTREE_LIB_DIR: libDir,
  };
}

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function logPath(env) {
  return path.join(env.GENTLE_STATUS_STATE_DIR, traceLib().LOG_NAME);
}

function readLog(env) {
  const file = logPath(env);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

const stubTui = {
  visibleWidth: (text) => [...String(text)].length,
  truncateToWidth: (text, width) => String(text).slice(0, Math.max(0, width)),
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

// The PUBLIC root host surface the runtime declares: a terminal size, a
// repaint request and the full-redraw counter. Nothing private is touched.
function makeHostTui(rows = 24) {
  return { terminal: { rows }, fullRedraws: 4, requestRender: () => {} };
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-obs-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => { commands.set(name, def); },
    registerMessageRenderer: () => {},
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  mod.setCustomizeTuiLoader(async () => stubTui);
  mod.setOddTuiLoader(async () => stubTui);
  mod.setIssuesTuiLoader(async () => stubTui);
  return { commands, mod };
}

// Mount a view through the real host factory signature and hand back the
// component the view factory returned.
function mountingCtx({ cwd, host }) {
  const opened = [];
  const ctx = {
    cwd,
    ui: {
      notify: () => {},
      custom: async (factory) => {
        opened.push(factory(host, {}, {}, () => {}));
        return null;
      },
    },
  };
  return { ctx, opened };
}

beforeEach(() => {
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
});

describe('perfTraceView observer samples', { concurrency: false }, () => {
  test('a traced frame writes the component duration and a separate observer sample', async () => {
    const libDir = stubbedLibDir();
    const env = scratchEnv(libDir);
    setEnv(env);
    const repo = makeRepo();
    const { commands } = await loadExtension();
    assert.equal(traceLib().writeTraceMode(true, env).ok, true);

    const host = makeHostTui();
    const { ctx, opened } = mountingCtx({ cwd: repo, host });
    await commands.get('herdr-gentle:odd').handler('', ctx);
    assert.equal(opened.length, 1, 'the odd view mounted');

    opened[0].render(80);
    host.fullRedraws = 7;
    opened[0].render(80);

    const lines = readLog(env);
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['render', 'observer', 'resource', 'render', 'observer'],
      'each frame writes its render and observer lines; the first also writes the resource baseline',
    );

    const renders = lines.filter((line) => line.kind === 'render');
    for (const line of renders) {
      assert.equal(line.view, 'odd');
      assert.equal(typeof line.ms, 'number');
      assert.ok(line.ms >= 0, 'a duration, never a negative number');
      assert.equal(line.width, 80);
      assert.equal(line.height, 24, 'the terminal height');
      assert.equal(line.rows, 1);
      for (const key of Object.keys(line)) {
        assert.ok(['at', 'kind', 'view', 'ms', 'width', 'height', 'rows', 'run'].includes(key), `${key} is allowlisted`);
      }
    }

    const [first, second] = lines.filter((line) => line.kind === 'observer');
    assert.equal(first.frame, 1);
    assert.equal(first.hostFullRedrawsState, 'declared', 'the public counter is read from the root host');
    assert.equal(first.hostFullRedraws, 4);
    assert.equal(first.hostRenderMsState, 'absent', 'a counter is not a render duration');
    assert.equal('prevAppendMs' in first, false, 'nothing was measured before the first sample');

    assert.equal(second.frame, 2);
    assert.equal(second.measuredAppends, 3, 'the render, observer and resource writes of the previous frame were measured');
    assert.equal(typeof second.prevAppendMs, 'number');
    assert.ok(second.prevAppendMs >= 0, 'a trailing cost, never a negative number');
    assert.equal(second.hostFullRedraws, 7);
    assert.equal(second.hostFullRedrawsDelta, 3);
    // The process-level event-loop metric is reported with its own state: this
    // Node build reports idle/active as 0 forever, so 'absent' is the honest
    // verdict here and a numeric interval would be evidence that it works.
    assert.ok(['declared', 'absent', 'unknown'].includes(second.processLoopState), 'the loop metric carries a support state');
    if (second.processLoopState === 'declared') {
      assert.ok(second.processLoopWindowMs > 0, 'a declared interval is real');
      assert.ok(second.processLoopUtilization >= 0 && second.processLoopUtilization <= 1);
    } else {
      assert.equal('processLoopUtilization' in second, false, 'no numbers without a measured interval');
    }
    assert.equal('processLoopUtilization' in first, false, 'the first reading is only a baseline');
    assert.equal(second.hostRenderMsState, 'absent', 'the host publishes a counter, not a duration');

    const raw = fs.readFileSync(logPath(env), 'utf8');
    for (const leaked of ['STUB-ROW-NEVER-LOGGED', 'BODY-THAT-MUST-NEVER-BE-LOGGED', repo]) {
      assert.equal(raw.includes(leaked), false, `${leaked} never reaches the log`);
    }
  });

  test('a disabled trace writes no log and still mounts the view', async () => {
    const libDir = stubbedLibDir();
    const env = scratchEnv(libDir);
    setEnv(env);
    const repo = makeRepo();
    const { commands } = await loadExtension();

    const { ctx, opened } = mountingCtx({ cwd: repo, host: makeHostTui() });
    await commands.get('herdr-gentle:odd').handler('', ctx);
    assert.equal(opened.length, 1, 'the view still mounts');
    assert.deepEqual(opened[0].render(80), ['STUB-ROW-NEVER-LOGGED'], 'the frame is unchanged');

    assert.deepEqual(readLog(env), [], 'nothing is recorded while tracing is off');
    assert.deepEqual(fs.readdirSync(env.GENTLE_STATUS_STATE_DIR), [], 'and nothing is created in the state dir');
  });
});
