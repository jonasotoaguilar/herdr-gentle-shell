'use strict';
// Startup latency ("Pi takes longer to open"): the extension used to spend the
// user's first frame on three `spawnSync` git probes (repository discovery),
// two `spawnSync` herdr probes (the plugin verdict) and an AWAITED verdict that
// nothing before the first prompt depends on.
//
// This file measures the two properties that fix has to hold, instead of
// asserting that some function is `async`:
//
//   1. NO startup handler blocks the host event loop. A 10 ms interval timer
//      runs while `session_start` is fired. Awaited async children keep the
//      loop free, so the timer keeps firing and the longest gap between two
//      ticks stays small; a blocking child freezes the loop for that child's
//      whole lifetime, which is exactly what a "blocked" startup looks like.
//
//   2. The probes nothing depends on are off the AWAITED startup path, while
//      the registration the session DOES depend on still settles before
//      `session_start` resolves. The host awaits every handler in turn, so
//      both halves are observable from outside: the handler phase must finish
//      without the plugin verdict, and the registry row must be there the
//      moment it does.
//
// Delays are injected through PATH shims (a `git` that sleeps then execs the
// real binary, a `herdr` that sleeps then answers, a `gh` that fails fast), so
// the same argv, stdout and status reach the caller and only the wait changes:
// the measurement is about the runner and the dispatch, never the fixture.
//
// Loading pattern mirrors tools/worktree-blocking-budget.test.js: the
// TypeScript extension is plain JS under the hood, so the test copies it to a
// temporary .mjs with the two package import lines stubbed and import()s it
// with a fake `pi`. Every fixture lives under os.tmpdir() and is removed.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const PLUGIN_ID = 'herdr-gentle-shell';

// How long an injected child sleeps. Long enough that one blocking child is
// unmistakable, short enough that the file stays focused.
const CHILD_DELAY_MS = Number(process.env.GENTLE_TEST_CHILD_DELAY_MS || 300);
const TICK_INTERVAL_MS = 10;
const MIN_TICKS = 8;
const MAX_GAP_MS = 150;

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

const REAL_GIT = String(spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout || '').trim();
assert.ok(REAL_GIT.length > 0, 'expected a real git binary in PATH');

const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const savedEnv = { ...process.env };
const savedPath = process.env.PATH;
const savedLibDir = process.env.GENTLE_WORKTREE_LIB_DIR;

const roots = [];
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  process.env.PATH = savedPath;
  if (savedLibDir === undefined) delete process.env.GENTLE_WORKTREE_LIB_DIR;
  process.removeAllListeners('unhandledRejection');
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-startup-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  git(dir, ['branch', 'main', 'HEAD']);
  const real = fs.realpathSync(dir);
  track(path.join(path.dirname(real), `${path.basename(real)}-worktrees`));
  return real;
}

// A live checkout the registry has never seen: exactly what startup discovery
// must still register.
function addUnregisteredWorktree(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const target = path.join(path.dirname(root), `${path.basename(root)}-live-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  return fs.realpathSync(target);
}

// `git` shim: sleep, then exec the real binary, so every caller sees the real
// output and status of the real command after a slow wait. This is the class of
// child startup discovery runs three of.
function makeSlowGitShim(scriptDir) {
  const bin = path.join(scriptDir, 'git');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `sleep ${(CHILD_DELAY_MS / 1000).toFixed(3)}`,
      `exec ${JSON.stringify(REAL_GIT)} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

// `herdr` shim: logs its argv, sleeps, then answers the plugin list with a
// version this package does not ship — so the verdict path ends in the one
// alert (never a silent no-op that could pass the timing assertion trivially).
function makeSlowHerdrShim(scriptDir, { version = '9.9.9', delayMs = CHILD_DELAY_MS } = {}) {
  const bin = path.join(scriptDir, 'herdr');
  const log = path.join(scriptDir, 'herdr-argv.log');
  const doc = JSON.stringify({ result: { plugins: [{ plugin_id: PLUGIN_ID, version, enabled: true }] } });
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `sleep ${(delayMs / 1000).toFixed(3)}`,
      `printf '%s' ${JSON.stringify(doc)}`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, log };
}

// `gh` shim: fails fast and deterministically, so the issues gate never depends
// on the machine's own gh state (and never adds its own latency to a
// measurement).
function makeFastFailingGhShim(scriptDir) {
  const bin = path.join(scriptDir, 'gh');
  fs.writeFileSync(bin, ['#!/bin/sh', 'echo "gh stub: not authenticated" >&2', 'exit 1', ''].join('\n'), { mode: 0o755 });
  return bin;
}

function makeShimDir(tag, opts = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-startup-${tag}-shim-`)));
  const slow = opts.slowGit !== false;
  if (slow) makeSlowGitShim(dir);
  makeFastFailingGhShim(dir);
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
      const longest = gaps.length === 0 ? 0 : Math.max(...gaps);
      return { ticks, maxGapMs: Math.round(longest), samples: gaps.length };
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-startup-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const handlers = new Map();
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    events: { emit: () => {} },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { handlers, mod };
}

// Point the extension's children at the shims and isolate its state per test.
function prepareEnv({ shimDir, herdrBin }) {
  pluginCheckLib.resetHerdrPluginCheckForTests();
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  process.env.GENTLE_STATUS_STATE_DIR = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-startup-state-')));
  process.env.HERDR_BIN_PATH = herdrBin;
}

function makeCtx(repoRoot) {
  const notes = [];
  const ctx = {
    cwd: repoRoot,
    mode: 'tui',
    sessionManager: { getSessionId: () => 'startup-thread', getEntries: () => [] },
    ui: { notify: (message, level) => { notes.push([message, level]); } },
  };
  return { ctx, notes };
}

// Every registered startup handler, awaited in the order the host awaits them
// (one at a time). This is exactly what the host does at session start.
async function fireSessionStart(handlers, ctx) {
  for (const handler of handlers.get('session_start') || []) {
    await handler({ reason: 'startup' }, ctx);
  }
}

function pluginAlerts(notes) {
  return notes.filter(([message]) => String(message).includes(PLUGIN_ID));
}

const registryLib = require('../lib/worktree-registry.js');
// The plugin verdict is delivered once per session (its own module-level flag),
// so every case starts with that flag clear — the same seam the plugin-check
// suite uses. Without it the second case would measure the first one's verdict.
const pluginCheckLib = require('../lib/herdr-plugin-check.js');

describe('startup keeps the host event loop free (S-startup)', { concurrency: false }, () => {
  test('a slow git and a slow herdr never freeze the loop, and the verdict still lands', async () => {
    const root = makeRepo('loop-free');
    const live = addUnregisteredWorktree(root, 'feat/startup-live');
    const shimDir = makeShimDir('loop-free');
    const herdr = makeSlowHerdrShim(shimDir);
    prepareEnv({ shimDir, herdrBin: herdr.bin });
    try {
      const { handlers, mod } = await loadExtension();
      const { ctx, notes } = makeCtx(root);

      const probe = startTickProbe();
      await fireSessionStart(handlers, ctx);
      await mod.awaitPendingStartupTasks();
      const stats = probe.stop();

      // The property the user felt: no startup child blocks a repaint.
      assertLoopStayedFree(stats, 'session_start');

      // Nothing is skipped: the alert still lands exactly once, naming the
      // update command, and the live checkout is still registered.
      const alerts = pluginAlerts(notes);
      assert.equal(alerts.length, 1, `exactly one plugin alert: ${JSON.stringify(notes)}`);
      assert.ok(alerts[0][0].includes('herdr plugin update'), `names the fix: ${alerts[0][0]}`);
      const row = registryLib.findByBranch(root, 'feat/startup-live');
      assert.ok(row, 'startup discovery still registers the live checkout');
      assert.equal(row.path, live, 'the registered path is the checkout');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // The awaited half: the plugin verdict is a notification, nothing the session
  // does next depends on it, so the handlers must resolve without waiting for
  // its child — while the registration the session DOES depend on is already
  // written when they do.
  test('the plugin verdict is off the awaited startup path', async () => {
    const root = makeRepo('off-path');
    const live = addUnregisteredWorktree(root, 'feat/startup-off-path');
    const shimDir = makeShimDir('off-path', { slowGit: false });
    // A verdict child far slower than the whole rest of the startup.
    const herdr = makeSlowHerdrShim(shimDir, { delayMs: CHILD_DELAY_MS * 2 });
    prepareEnv({ shimDir, herdrBin: herdr.bin });
    try {
      const { handlers, mod } = await loadExtension();
      const { ctx, notes } = makeCtx(root);

      const startedAt = Date.now();
      await fireSessionStart(handlers, ctx);
      const handlerPhaseMs = Date.now() - startedAt;

      assert.ok(
        handlerPhaseMs < CHILD_DELAY_MS,
        `session_start waited ${handlerPhaseMs} ms for a ${CHILD_DELAY_MS * 2} ms verdict child; `
        + 'nothing before the first prompt depends on it',
      );
      assert.equal(pluginAlerts(notes).length, 0, 'the verdict had not landed yet — it is off the awaited path');
      // ...while the registration the session needs is already there.
      const row = registryLib.findByBranch(root, 'feat/startup-off-path');
      assert.ok(row, 'registration settles before session_start resolves');
      assert.equal(row.path, live);

      // Eventually, not never: the deferred verdict still reaches the human.
      await mod.awaitPendingStartupTasks();
      assert.equal(pluginAlerts(notes).length, 1, 'the deferred verdict lands once it answers');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // Shutdown safety: work that outlives its session must not notify a dead UI
  // and must not leave an unhandled rejection behind it.
  test('a session that ends first drops the deferred verdict instead of notifying', async () => {
    const root = makeRepo('shutdown');
    const shimDir = makeShimDir('shutdown', { slowGit: false });
    const herdr = makeSlowHerdrShim(shimDir, { delayMs: CHILD_DELAY_MS * 2 });
    prepareEnv({ shimDir, herdrBin: herdr.bin });
    try {
      const { handlers, mod } = await loadExtension();
      const { ctx, notes } = makeCtx(root);

      await fireSessionStart(handlers, ctx);
      for (const handler of handlers.get('session_shutdown') || []) handler({ reason: 'quit' }, ctx);
      await mod.awaitPendingStartupTasks();

      assert.deepEqual(pluginAlerts(notes), [], 'a verdict that outlived its session notifies nobody');
      // The child really ran (so the assertion above is about the epoch guard,
      // never about a probe that never happened).
      assert.ok(fs.readFileSync(herdr.log, 'utf8').includes('plugin list'), 'the probe still ran');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  // Prior behaviour, preserved: the registration is deterministic (it settles
  // before `session_start` resolves) and a repeated startup rewrites nothing.
  test('startup registration stays deterministic and byte-idempotent', async () => {
    const root = makeRepo('idempotent');
    addUnregisteredWorktree(root, 'feat/startup-idempotent');
    const shimDir = makeShimDir('idempotent');
    const herdr = makeSlowHerdrShim(shimDir);
    prepareEnv({ shimDir, herdrBin: herdr.bin });
    try {
      const { handlers, mod } = await loadExtension();
      const { ctx } = makeCtx(root);
      await fireSessionStart(handlers, ctx);
      const file = registryLib.registryPath(root);
      const bytes = fs.readFileSync(file, 'utf8');
      assert.ok(
        bytes.includes('feat/startup-idempotent'),
        'the registry row is written before session_start resolves',
      );
      await fireSessionStart(handlers, ctx);
      await mod.awaitPendingStartupTasks();
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'a repeated startup is byte-idempotent');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test('no startup path leaves an unhandled rejection', () => {
    assert.deepEqual(
      unhandled.map((reason) => String((reason && reason.message) || reason)),
      [],
      'every startup task settles into silence instead of an unhandled rejection',
    );
  });
});
