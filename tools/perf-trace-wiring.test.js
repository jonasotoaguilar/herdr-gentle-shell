'use strict';
// S16/S16a wiring tests: the Performance trace as the extension actually uses
// it — the session snapshot hook and the render timing around this package's
// own view factories.
//
// Contract under test (observable behavior only — the JSONL bytes on disk, the
// values the real views render, and whether a failure propagates; never
// internal helper names):
// - session start writes ONE snapshot carrying the four switches and the
//   installed-Pi evidence, and writes nothing at all while tracing is off;
// - a traced view writes one `render` line per frame with a numeric duration
//   and size, for warp, odd, issues and create;
// - a disabled trace writes no render line;
// - a view that throws still throws, and its frame is not recorded;
// - no rendered text, path or credential ever reaches the log.

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

// A real checkout with one odd document: the commands resolve the checkout
// through the real git plumbing, so the fixture must be a real repository.
function makeRepo() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-wire-')));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  const root = fs.realpathSync(dir);
  const doc = path.join(root, 'odd', 'tasks', 'trace-me.md');
  fs.mkdirSync(path.dirname(doc), { recursive: true });
  fs.writeFileSync(doc, '# Trace me\n\nBODY-THAT-MUST-NEVER-BE-LOGGED\n');
  return root;
}

function scratchEnv() {
  return {
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-wire-state-'))),
    PI_CODING_AGENT_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-wire-agent-'))),
    GENTLE_PI_AGENT_HOME: undefined,
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
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
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

// Host TUI: the views read the terminal height and request repaints.
function makeHostTui(rows = 24) {
  const paints = [];
  return { paints, tui: { terminal: { rows }, requestRender: () => paints.push(true) } };
}

async function loadExtension({ oddHelpers = stubTui } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-wire-ext-')));
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
  mod.setOddTuiLoader(async () => oddHelpers);
  mod.setIssuesTuiLoader(async () => stubTui);
  return { commands, handlers, mod };
}

// Mount a view through the REAL host factory signature and hand back the
// component. `afterMount(component, call)` may drive keys; returning `null`
// cancels the overlay, anything else resolves it with whatever the component
// passed to `done` (null while still pending).
function mountingCtx({ cwd, host = makeHostTui(), afterMount } = {}) {
  const notes = [];
  const opened = [];
  let calls = 0;
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => { notes.push([message, level]); },
      custom: async (factory) => {
        calls += 1;
        const settled = { value: null, pending: true };
        const component = factory(host.tui, {}, {}, (result) => {
          settled.value = result;
          settled.pending = false;
        });
        opened.push(component);
        if (typeof afterMount === 'function') {
          const verdict = afterMount(component, calls);
          if (verdict === null) return null;
        }
        return settled.pending ? null : settled.value;
      },
    },
  };
  return { ctx, notes, opened, calls: () => calls };
}

function command(commands, name) {
  const def = commands.get(name);
  assert.ok(def, `expected ${name} to be registered`);
  return def;
}

beforeEach(() => {
  // Every load resolves the lib through this seam, and no test may touch the
  // user's real state dir.
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
});

describe('perf trace session hook', { concurrency: false }, () => {
  test('session start writes one snapshot while tracing is on, and nothing while it is off', async () => {
    const env = scratchEnv();
    setEnv(env);
    const { handlers } = await loadExtension();
    const sessionHandlers = handlers.get('session_start') || [];
    assert.ok(sessionHandlers.length > 0, 'the extension registers a session_start hook');
    // The trace hook is the one this task adds, registered last: the other
    // session_start handlers do live discovery (Herdr CLI, gh) that a trace
    // test must not trigger.
    const traceHook = sessionHandlers[sessionHandlers.length - 1];

    await traceHook({}, { cwd: process.cwd() });
    assert.deepEqual(readLog(env), [], 'a disabled trace writes no snapshot');
    assert.deepEqual(fs.readdirSync(env.GENTLE_STATUS_STATE_DIR), [], 'and writes nothing into the state dir');

    assert.equal(traceLib().writeTraceMode(true, env).ok, true);
    await traceHook({}, { cwd: process.cwd() });

    const lines = readLog(env);
    assert.equal(lines.length, 1, 'exactly one snapshot per session start');
    const [line] = lines;
    assert.deepEqual(Object.keys(line).slice(0, 2), ['at', 'kind']);
    assert.equal(line.kind, 'session');
    for (const key of Object.keys(line)) {
      assert.ok(['at', 'kind', 'piVersion', 'perf', 'support'].includes(key), `${key} is allowlisted`);
    }
    assert.deepEqual(line.perf, {
      heightIndex: false,
      evictOffscreenLines: false,
      expandRecentToolOutput: false,
      incrementalSearchCorpus: false,
    }, 'a fresh settings file is the all-OFF run');
    if (line.piVersion !== undefined) assert.equal(typeof line.piVersion, 'string');
    if (line.support !== undefined) {
      for (const [key, state] of Object.entries(line.support)) {
        assert.ok(['heightIndex', 'evictOffscreenLines', 'expandRecentToolOutput', 'incrementalSearchCorpus'].includes(key));
        assert.ok(['declared', 'absent', 'unknown'].includes(state), `${state} is one of the three evidence states`);
      }
    }
  });
});

describe('perf trace render instrumentation', { concurrency: false }, () => {
  test('the odd view records one line per frame and never the rendered text', async () => {
    const env = scratchEnv();
    setEnv(env);
    const repo = makeRepo();
    const { commands } = await loadExtension();
    traceLib().writeTraceMode(true, env);

    const { ctx, opened } = mountingCtx({ cwd: repo, afterMount: (component) => component.render(80) });
    await command(commands, 'herdr-gentle:odd').handler('', ctx);
    assert.equal(opened.length, 1, 'the odd view mounted');
    const lines = opened[0].render(80);
    assert.ok(Array.isArray(lines) && lines.length > 0, 'the view still renders');

    const renderLines = readLog(env).filter((line) => line.kind === 'render');
    assert.equal(renderLines.length, 2, 'one line per rendered frame');
    for (const line of renderLines) {
      assert.deepEqual(Object.keys(line).slice(0, 2), ['at', 'kind']);
      assert.equal(line.view, 'odd');
      assert.equal(typeof line.ms, 'number');
      assert.ok(line.ms >= 0, 'a duration, never a negative number');
      assert.equal(line.width, 80);
      assert.equal(line.height, 24, 'the terminal height');
      assert.equal(line.rows, lines.length, 'the rendered row count');
      for (const key of Object.keys(line)) {
        assert.ok(['at', 'kind', 'view', 'ms', 'width', 'height', 'rows'].includes(key), `${key} is allowlisted`);
      }
    }

    const raw = fs.readFileSync(logPath(env), 'utf8');
    for (const leaked of ['BODY-THAT-MUST-NEVER-BE-LOGGED', 'Trace me', repo]) {
      assert.equal(raw.includes(leaked), false, `${leaked} never reaches the log`);
    }
  });

  test('a disabled trace writes no render line for the same view', async () => {
    const env = scratchEnv();
    setEnv(env);
    const repo = makeRepo();
    const { commands } = await loadExtension();

    const { ctx, opened } = mountingCtx({ cwd: repo, afterMount: (component) => component.render(80) });
    await command(commands, 'herdr-gentle:odd').handler('', ctx);
    opened[0].render(80);

    assert.deepEqual(readLog(env), [], 'nothing is recorded while tracing is off');
  });

  test('the issues viewer is traced as its own view', async () => {
    const env = scratchEnv();
    setEnv(env);
    const repo = makeRepo();
    const { commands } = await loadExtension();
    traceLib().writeTraceMode(true, env);

    const { ctx, opened } = mountingCtx({ cwd: repo, afterMount: (component) => component.render(100) });
    await command(commands, 'herdr-gentle:issues').handler('', ctx);
    assert.equal(opened.length, 1, 'the issues view mounted without a gh call');
    opened[0].render(100);

    const views = readLog(env).filter((line) => line.kind === 'render').map((line) => line.view);
    assert.deepEqual(views, ['issues', 'issues']);
  });

  test('the warp panel and its create panel are traced as warp and create', async () => {
    const env = scratchEnv();
    setEnv(env);
    const repo = makeRepo();
    const { commands } = await loadExtension();
    traceLib().writeTraceMode(true, env);

    // First mount: the warp panel, where `c` opens the create panel; second
    // mount: the create panel itself, cancelled with null.
    const { ctx, opened } = mountingCtx({
      cwd: repo,
      afterMount: (component, call) => {
        component.render(100);
        if (call === 1) {
          // `c` finishes the warp panel with {create:true}, which mounts the
          // create panel as the second overlay.
          component.handleInput('c');
          return undefined;
        }
        return null;
      },
    });
    await command(commands, 'herdr-gentle:warp').handler('', ctx);
    assert.ok(opened.length >= 2, `the warp panel and the create panel both mounted (got ${opened.length})`);

    const views = readLog(env).filter((line) => line.kind === 'render').map((line) => line.view);
    assert.ok(views.includes('warp'), 'the warp panel is traced');
    assert.ok(views.includes('create'), 'the create panel is traced');
  });

  test('a view that throws still throws, and its frame is not recorded', async () => {
    const env = scratchEnv();
    // A lib copy whose odd view throws from render, the way a real renderer
    // failure would; every other module stays the real one.
    const libCopy = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-perf-lib-')));
    fs.cpSync(LIB_DIR, libCopy, { recursive: true });
    fs.writeFileSync(
      path.join(libCopy, 'odd-view.js'),
      "exports.createOddView = () => ({ render() { throw new Error('render exploded'); }, handleInput() {}, invalidate() {} });\n",
    );
    setEnv({ ...env, GENTLE_WORKTREE_LIB_DIR: libCopy });
    const repo = makeRepo();
    const { commands } = await loadExtension();
    traceLib().writeTraceMode(true, env);

    const { ctx, opened } = mountingCtx({ cwd: repo });
    await command(commands, 'herdr-gentle:odd').handler('', ctx);
    assert.equal(opened.length, 1, 'the throwing view mounted');

    assert.throws(() => opened[0].render(80), /render exploded/, 'the render exception is unchanged');

    assert.deepEqual(readLog(env), [], 'a failed frame records nothing at all');
    assert.equal(fs.existsSync(logPath(env)), false, 'no log file is created by a failed frame');
  });
});
