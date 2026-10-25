'use strict';
// S21 (round 3, real host): no interactive path may block the host event
// loop. Creating a worktree from the warp/create panel froze Pi completely,
// and deleting one from the warp selector stalled the whole host, because
// both paths ran their children through the synchronous runner — a
// `spawnSync` child with a timeout up to 120 s — while nothing on the host
// could repaint or read a key.
//
// This file measures the property the user felt, instead of asserting that
// some function is `async`. A 10 ms interval timer runs while the
// interactive action is in flight. An awaited async child keeps the loop
// free, so the timer keeps firing and the longest gap between two ticks
// stays small. A blocking child freezes the loop for the child's whole
// lifetime, so the timer observes (at most) one tick after a whole sleep
// interval — which is exactly what a "blocked" fix looks like.
//
// The child is slowed through the PATH: a `git` shim that sleeps
// GENTLE_TEST_CHILD_DELAY_MS and then execs the real binary, so the SAME
// argv, stdout, status and error shape reach the caller — only the wait
// changes. Both runners (sync and async) resolve `git` through PATH, so the
// measurement is about the runner, never about the fixture.
//
// Loading pattern mirrors tools/worktree-create.test.js and
// tools/warp-selector.test.js: the TypeScript extension is plain JS under
// the hood, so the test copies it to a temporary .mjs with the two package
// import lines stubbed and import()s it with a fake `pi` object. Every
// fixture lives under os.tmpdir() and is removed afterwards.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

// How long the injected child sleeps. Long enough that a single blocking
// child is unmistakable (one such child outlasts MAX_GAP_MS on its own),
// short enough that the whole file stays a focused test.
const CHILD_DELAY_MS = Number(process.env.GENTLE_TEST_CHILD_DELAY_MS || 400);
// The probe interval and the two properties: enough ticks to prove the loop
// kept running, and a generous bound on the longest stall, so ordinary
// scheduling jitter never fails the test while one blocked child does.
const TICK_INTERVAL_MS = 10;
const MIN_TICKS = 8;
const MAX_GAP_MS = 250;

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

// The real git binary, resolved BEFORE the shim takes over PATH: the test's
// own fixtures must stay fast, so only the extension's children are slowed.
const REAL_GIT = String(spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout || '').trim();
assert.ok(REAL_GIT.length > 0, 'expected a real git binary in PATH');

const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const savedEnv = { ...process.env };
const savedPath = process.env.PATH;

const roots = [];
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  process.env.PATH = savedPath;
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync(REAL_GIT, args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ISOLATION },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-budget-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

// A `git` shim on PATH: sleep, then exec the real binary, so every caller
// sees the real output and status of the real command after a slow wait.
//
// `rev-parse` is the one argv kept fast. It reads constant-time repository
// metadata (two probes, single-digit milliseconds even on a huge repository)
// and the shared registry helper resolves its own storage path through it, so
// slowing it would measure that helper's cost instead of the reported defect.
// Every other child — `check-ref-format`, `worktree add|list|remove|prune`,
// `show-ref`, `ls-files`, history and diff walks, and every herdr call — is as
// slow as CHILD_DELAY_MS, which is the class of child that froze the host.
function makeSlowGitShim(scriptDir) {
  const bin = path.join(scriptDir, 'git');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "rev-parse" ]; then',
      `  exec ${JSON.stringify(REAL_GIT)} "$@"`,
      'fi',
      `sleep ${(CHILD_DELAY_MS / 1000).toFixed(3)}`,
      `exec ${JSON.stringify(REAL_GIT)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

// Stub `herdr`: sleeps (the same slow child), logs its argv, creates a real
// checkout for `worktree create`, answers `agent list` / `worktree list`
// with empty output (so the close path falls through to `git worktree
// remove`) and fails everything else — exactly the shape the extension
// degrades from.
function makeSlowHerdrStub(scriptDir) {
  const bin = path.join(scriptDir, 'herdr');
  const log = path.join(scriptDir, 'herdr-argv.log');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `sleep ${(CHILD_DELAY_MS / 1000).toFixed(3)}`,
      'if [ "$1" = "agent" ] && [ "$2" = "list" ]; then exit 0; fi',
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then exit 0; fi',
      'if [ "$1" = "worktree" ] && [ "$2" = "create" ]; then',
      '  shift 2',
      '  branch=""; base=""; wtpath=""; cwd=""',
      '  while [ $# -gt 0 ]; do',
      '    case "$1" in',
      '      --branch) branch="$2"; shift 2;;',
      '      --base) base="$2"; shift 2;;',
      '      --path) wtpath="$2"; shift 2;;',
      '      --cwd) cwd="$2"; shift 2;;',
      '      *) shift;;',
      '    esac',
      '  done',
      '  [ -n "$branch" ] && [ -n "$wtpath" ] && [ -n "$cwd" ] || { echo "missing args" >&2; exit 1; }',
      `  exec ${JSON.stringify(REAL_GIT)} -C "$cwd" worktree add -b "$branch" "$wtpath" "$base"`,
      'fi',
      'echo "herdr stub: unexpected argv $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, log };
}

// A fresh scratch directory OUTSIDE the checkout holding the shims.
function makeShimDir(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-budget-${tag}-shim-`)));
  makeSlowGitShim(dir);
  return dir;
}

function startTickProbe() {
  const gaps = [];
  let last = process.hrtime.bigint();
  let ticks = 0;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    gaps.push(Number(now - last) / 1e6);
    last = now;
    ticks += 1;
  }, TICK_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      // EVERY gap counts, including the first one: it spans the probe start to
      // the first tick, so a path that freezes the loop immediately shows that
      // freeze here instead of hiding it behind a discarded sample.
      const longest = gaps.length === 0 ? 0 : Math.max(...gaps);
      return {
        ticks,
        maxGapMs: Math.round(longest),
        samples: gaps.length,
      };
    },
  };
}

function assertLoopStayedFree(stats, label) {
  const detail = `${stats.ticks} ticks over ${stats.samples} gaps, longest ${stats.maxGapMs} ms, `
    + `child delay ${CHILD_DELAY_MS} ms`;
  assert.ok(
    stats.ticks >= MIN_TICKS,
    `${label} blocked the host event loop (${detail}): at least ${MIN_TICKS} probe ticks must fire while it runs`,
  );
  assert.ok(
    stats.maxGapMs <= MAX_GAP_MS,
    `${label} blocked the host event loop for ${stats.maxGapMs} ms (${detail}): no wait may exceed ${MAX_GAP_MS} ms`,
  );
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-budget-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    registerMessageRenderer: () => {},
    on: () => () => {},
    events: { emit: () => {} },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, commands, mod };
}

function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-budget-mode-'))) };
}

// Point the extension's children at the slow shims (PATH + the documented
// binary overrides), and isolate the mode/session state per test.
function setSlowChildEnv(extra) {
  const shimDir = extra.shimDir || makeShimDir('env');
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  Object.assign(process.env, {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    ...scratchModeEnv(),
    ...(extra.vars || {}),
  });
}

const registryLib = require('../lib/worktree-registry.js');

function makeCtx({ repoRoot, thread = 'thread-1' }) {
  const notes = [];
  const ctx = {
    cwd: repoRoot,
    hasUI: false,
    mode: 'tui',
    sessionManager: { getSessionId: () => thread },
    ui: {
      notify: (message, level) => { notes.push([message, level]); },
      confirm: async () => true,
    },
  };
  return { ctx, notes };
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

// ---------------------------------------------------------------------------
// Create: the `worktree_upsert` tool path (the panel path shares this core).
// ---------------------------------------------------------------------------

describe('interactive worktree create keeps the host event loop free (S21)', { concurrency: false }, () => {
  test('a slow child never freezes the loop, and the created result is unchanged', async () => {
    const root = makeRepo('create');
    const shimDir = makeShimDir('create');
    const herdr = makeSlowHerdrStub(shimDir);
    setSlowChildEnv({ shimDir, vars: { HERDR_BIN_PATH: herdr.bin } });
    try {
      const { tools } = await loadExtension();
      const tool = tools.get('worktree_upsert');
      assert.ok(tool, 'expected worktree_upsert to be registered');
      const { ctx } = makeCtx({ repoRoot: root });
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-budget');

      const probe = startTickProbe();
      const result = await tool.execute('call-1', { branch: 'feat/budget' }, undefined, undefined, ctx);
      const stats = probe.stop();

      // The conversion must not change behaviour: same success, same text,
      // same checkout, same registry row as the blocking implementation.
      assert.equal(result.isError, undefined, `create failed: ${resultText(result)}`);
      assert.equal(resultText(result).split('\n')[0], 'outcome: created');
      assert.equal(result.details.path, target);
      assert.equal(git(target, ['rev-parse', '--show-toplevel']), target);
      const row = registryLib.findByBranch(root, 'feat/budget');
      assert.equal(row.path, target, 'the registry row names the created checkout');
      assert.equal(row.thread, 'thread-1');
      assert.ok(fs.readFileSync(herdr.log, 'utf8').includes('worktree create'), 'the create still ran through herdr');

      // The property the user felt.
      assertLoopStayedFree(stats, 'worktree_upsert create');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

// ---------------------------------------------------------------------------
// Delete: the warp selector's Ctrl+D, through the REAL shared close.
// ---------------------------------------------------------------------------

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text), bold: (text) => String(text) };

function addRegisteredWorktree(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-wired-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const real = fs.realpathSync(target);
  const upserted = registryLib.upsertWorktree(root, { branch, path: real, thread: 'thread-1', issues: [], odd: null });
  assert.equal(upserted.ok, true, `registry upsert failed: ${upserted.error}`);
  return real;
}

// SessionManager double, as in tools/warp-selector.test.js: the selector's
// rows and the warp resolution read the class off the instance.
function makeFakeSM(calls) {
  class FakeTarget {
    constructor(cwd, dir, file, carried) {
      this.cwd = cwd;
      this.dir = dir;
      this.file = file;
      this.carried = Array.isArray(carried) ? carried : [];
      this.leaf = null;
    }
    getSessionFile() { return this.file; }
    getEntries() { return this.carried; }
    getLeafId() { return this.leaf === undefined ? null : this.leaf; }
    branch(id) { this.leaf = id; }
    resetLeaf() { this.leaf = null; }
    appendCustomEntry(type, data) {
      const id = `warp-entry-${this.carried.length + 1}`;
      this.carried.push({ id, parentId: this.leaf, type: 'custom', customType: type, data });
      this.leaf = id;
      return id;
    }
    appendSessionInfo(name) {
      const id = `session-info-${this.carried.length + 1}`;
      this.carried.push({ id, parentId: this.leaf, type: 'session_info', name });
      this.leaf = id;
      return id;
    }
    _appendEntry(entry) { this.carried.push(entry); }
  }
  return class FakeSM {
    static forkFrom(sourcePath, targetCwd, sessionDir) {
      calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
      const file = path.join(targetCwd, 'forked-session.jsonl');
      fs.writeFileSync(file, '{"type":"session"}\n');
      return new FakeTarget(targetCwd, sessionDir, file, []);
    }
    static create(cwd, sessionDir) {
      calls.push(['create', cwd, sessionDir]);
      return { getSessionFile: () => path.join(cwd, 'created-session.jsonl'), getHeader: () => ({ type: 'session', cwd }) };
    }
    static open(file, sessionDir, cwdOverride) {
      calls.push(['open', file, sessionDir, cwdOverride]);
      return new FakeTarget(cwdOverride, sessionDir, file);
    }
  };
}

function sessionFileIn() {
  const file = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-budget-sess-'))), 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session"}\n');
  return file;
}

function makeWiredCtx({ cwd, FakeSM, sessionFile, sessionDir, calls, mount, confirmImpl }) {
  const notes = [];
  const customs = [];
  const confirms = [];
  const sm = new FakeSM();
  Object.assign(sm, {
    getSessionFile: () => sessionFile,
    getLeafId: () => 'leaf-1',
    getEntries: () => [],
    getSessionDir: () => sessionDir,
  });
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => { notes.push([message, level]); },
      setStatus: () => {},
      select: async () => null,
      confirm: async (title, body) => {
        confirms.push([title, body]);
        return typeof confirmImpl === 'function' ? confirmImpl(title, body) : confirmImpl;
      },
    },
    sessionManager: sm,
    waitForIdle: async () => {},
    switchSession: async () => ({ cancelled: false }),
  };
  if (mount) {
    ctx.ui.custom = async (factory, options) => {
      customs.push(options);
      return mount(factory, options);
    };
  }
  return { ctx, notes, customs, confirms };
}

// `v` opens the extended list, down moves to the worktree row, Ctrl+D asks
// for the deletion; later mounts (the selector reopening) press Esc.
function selectorDriver(keys) {
  const views = [];
  let mounts = 0;
  const mount = async (factory) => {
    mounts += 1;
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('warp selector did not settle')), 600000);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      let view;
      try {
        view = factory(hostTui, plainTheme, {}, done);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      views.push(view);
      try {
        if (mounts === 1) for (const key of keys) view.handleInput(key);
        else view.handleInput('\x1b');
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  };
  return { mount, views, mounts: () => mounts };
}

describe('the warp selector delete keeps the host event loop free (S21)', { concurrency: false }, () => {
  test('Ctrl+D + Yes runs the real close without blocking, and removes exactly that checkout', async () => {
    const root = makeRepo('delete');
    git(root, ['branch', 'main', 'HEAD']);
    const target = addRegisteredWorktree(root, 'feat/del');
    const shimDir = makeShimDir('delete');
    const herdr = makeSlowHerdrStub(shimDir);
    setSlowChildEnv({ shimDir, vars: { HERDR_BIN_PATH: herdr.bin } });
    try {
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['v', '\x1b[B', '\x04']);
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: driver.mount, confirmImpl: () => true,
      });
      const { commands } = await loadExtension();
      const def = commands.get('herdr-gentle:warp');
      assert.ok(def, 'expected the warp command to be registered');

      const probe = startTickProbe();
      await def.handler('', built.ctx);
      const stats = probe.stop();

      // Behaviour first: the confirmation asked once, the real close ran,
      // and only the approved checkout is gone.
      assert.equal(built.confirms.length, 1, 'the delete asked exactly once');
      assert.match(built.confirms[0][0], /^Delete worktree 'feat-del'\?$/);
      assert.equal(fs.existsSync(target), false, 'the approved checkout was removed');
      assert.equal(registryLib.findByPath(root, target), null, 'the registry row was dropped');
      assert.ok(fs.existsSync(root), 'the principal checkout is untouched');
      assert.equal(driver.mounts(), 2, 'the selector reopened after the delete');

      // The property the user felt.
      assertLoopStayedFree(stats, 'warp selector Ctrl+D delete');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
