'use strict';
// worktree-ui-redesign S10/S7c/S7d wiring tests: lib/issues-cache.js as the
// extension actually uses it — one complete OPEN snapshot at session start, a
// margin-only refresh when `/herdr-gentle:issues` opens, and per-worktree
// assignment verification that drops an issue only on PROOF and never purges
// what it cannot prove.
//
// Observable contract under test (the argv that reaches the injected `gh`
// runner, the registry bytes on disk, and the text the mounted detail renders):
// - session start lists the open set with ONE bounded fetch and never works
//   from a truncated or sampled page;
// - each `/herdr-gentle:issues` open asks only for the newest 20 UPDATED
//   issues, closed ones included, and requests nothing like the full set;
// - a closure reported by that margin is merged, so the worktree that still
//   carried the issue loses it — persisted in the registry — and the detail's
//   Issues tab no longer lists it;
// - an issue that gh answers 404 for is dropped on proof, while an
//   authentication/network failure preserves the stored assignment byte for
//   byte and is reported instead of silently kept or silently removed;
// - two repositories never share one cache: a number open in one repository is
//   not "proven open" for the other.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

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

const registryLib = require('../lib/worktree-registry.js');
const ghIssues = require('../lib/gh-issues.js');

const roots = [];
const savedEnv = { ...process.env };

after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  ghIssues.setGhRunner(null);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-icw-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function stdEnv() {
  return {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-icw-state-'))),
    GENTLE_WORKTREE_THREAD: undefined,
    HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-icw'),
  };
}

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-icw-ext-')));
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
    events: { emit: () => {} },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { commands, handlers, mod };
}

function addRegisteredWorktree(root, branch, { issues = [], odd = null } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-icw-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const real = fs.realpathSync(target);
  const upserted = registryLib.upsertWorktree(root, { branch, path: real, thread: 'thread-1', issues, odd });
  assert.equal(upserted.ok, true, `registry upsert failed: ${upserted.error}`);
  return real;
}

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text), bold: (text) => String(text) };
const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// A mutable stand-in for one GitHub repository. `issues` maps number ->
// {state, updatedAt}; `mode` simulates the ways a read can fail.
function fakeGitHub({ nameWithOwner = 'octo/repo', issues = new Map() } = {}) {
  const model = {
    nameWithOwner,
    issues,
    mode: 'ok',
    calls: [],
    set(number, state, updatedAt = '2024-01-05T00:00:00Z') {
      model.issues.set(number, { state, updatedAt });
    },
  };
  const json = (value) => ({ status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: '' });
  const fixture = (number, record) => ({
    number,
    title: `issue title ${number}`,
    state: record.state,
    author: { login: 'octo' },
    labels: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: record.updatedAt,
  });
  const sorted = (records) => records.slice().sort((left, right) => {
    const byTime = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    return byTime !== 0 ? byTime : right.number - left.number;
  });

  model.runner = async (bin, argv, runOpts) => {
    const cwd = runOpts && typeof runOpts.cwd === 'string' ? runOpts.cwd : null;
    if (model.byCwd instanceof Map && cwd !== null) {
      const exact = model.byCwd.get(cwd);
      if (exact) return exact.runner(bin, argv, { cwd });
      for (const [prefix, other] of model.byCwd) {
        if (cwd === prefix || cwd.startsWith(prefix + path.sep)) return other.runner(bin, argv, { cwd });
      }
    }
    model.calls.push(argv.slice());
    if (model.mode === 'network') return { status: null, stdout: '', stderr: '', error: 'spawn gh ENOENT: gh CLI is not available' };
    if (model.mode === 'auth') {
      return { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' };
    }
    if (argv[0] === 'api' && argv[1] === 'user') return json({ login: 'octo' });
    if (argv[0] === 'repo' && argv[1] === 'view') return json({ nameWithOwner: model.nameWithOwner });
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const state = argv[argv.indexOf('--state') + 1];
      const limit = Number(argv[argv.indexOf('--limit') + 1]);
      const rows = sorted([...model.issues.entries()]
        .filter(([, record]) => state === 'all' || record.state === state)
        .map(([number, record]) => fixture(number, record)));
      return json(rows.slice(0, Number.isFinite(limit) ? limit : rows.length));
    }
    if (argv[0] === 'issue' && argv[1] === 'view') {
      if (model.mode === 'repo404') {
        // An inaccessible/private repository: gh answers a GENERIC 404 that
        // names no issue, so it proves nothing about this number.
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found (https://api.github.com/graphql)' };
      }
      const number = Number(argv[2]);
      const record = model.issues.get(number);
      if (!record) {
        return {
          status: 1,
          stdout: '',
          stderr: `GraphQL: Could not resolve to an Issue with the number of ${number}. (repository.issue)`,
        };
      }
      return json({ ...fixture(number, record), body: `body of issue ${number}`, comments: [] });
    }
    return json({});
  };
  return model;
}

function opensOf(calls, state) {
  return calls.filter((argv) => argv[0] === 'issue' && argv[1] === 'list' && argv[argv.indexOf('--state') + 1] === state);
}

// A command context whose one overlay is captured, rendered and returned with
// every notification, so an assertion reads the frame a reader would see.
function makeCtx(cwd) {
  const notes = [];
  const mounted = { component: null, text: '' };
  const ctx = {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: {
      notify: (message, level) => notes.push([message, level]),
      confirm: async () => true,
      custom: async (factory) => {
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        const component = factory(hostTui, plainTheme, {}, () => {});
        mounted.component = component;
        mounted.text = clean(component.render(110).join('\n'));
        return null;
      },
    },
  };
  return { ctx, notes, mounted, text: () => mounted.text };
}

function sessions(handlers, ctx) {
  return (handlers.get('session_start') || []).map((handler) => handler({}, ctx));
}

describe('S10: the complete open snapshot at session start', { concurrency: false }, () => {
  test('the snapshot is one bounded fetch, and the detail then lists the whole set', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('prime');
      const target = addRegisteredWorktree(root, 'feat/prime', { issues: [7] });
      const model = fakeGitHub();
      for (let number = 1; number <= 250; number += 1) model.set(number, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();

      const boot = makeCtx(root);
      await Promise.all(sessions(handlers, boot.ctx));

      const primes = opensOf(model.calls, 'open');
      assert.equal(primes.length, 1, `one full snapshot fetch, not one per page: ${JSON.stringify(model.calls)}`);
      const limits = primes.map((argv) => Number(argv[argv.indexOf('--limit') + 1]));
      assert.ok(limits[0] >= 250, `the single fetch is wide enough for the whole set: ${limits.join(',')}`);

      const opened = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', opened.ctx);
      assert.match(opened.text(), /Issues \(250\)/, 'the detail inherits the complete primed set');
    } finally {
      restoreEnv();
    }
  });
});

describe('S10: the margin-only refresh on /issues open', { concurrency: false }, () => {
  test('it asks for the newest 20 UPDATED issues, closed included, and nothing else', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('refresh');
      const model = fakeGitHub();
      for (let number = 1; number <= 120; number += 1) model.set(number, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();
      await Promise.all(sessions(handlers, makeCtx(root).ctx));

      const before = model.calls.length;
      const opened = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', opened.ctx);

      const after = model.calls.slice(before);
      const margins = opensOf(after, 'all');
      assert.equal(margins.length, 1, `exactly one margin refresh per open: ${JSON.stringify(after)}`);
      assert.equal(Number(margins[0][margins[0].indexOf('--limit') + 1]), 20, 'the newest 20 updated issues');
      assert.equal(margins[0][margins[0].indexOf('--search') + 1], 'sort:updated-desc', 'ordered by last update');
      // The viewer's own pages keep their S2 searches; the cache never adds a
      // second full open listing.
      const viewerPages = opensOf(after, 'open');
      assert.equal(viewerPages.length, 3, 'the three viewer pages, unchanged');
      for (const argv of viewerPages) {
        assert.match(argv[argv.indexOf('--search') + 1], /@me/, 'each viewer page keeps its own query');
      }
    } finally {
      restoreEnv();
    }
  });
});

describe('S7c/S7d: closure evidence reaches the worktree assignment', () => {
  test('a merged closure drops the issue, persists it, and leaves it off the list', { concurrency: false }, async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('closure');
      const target = addRegisteredWorktree(root, 'feat/closure', { issues: [7, 8] });
      const model = fakeGitHub();
      model.set(7, 'open', '2024-01-02T00:00:00Z');
      model.set(8, 'open', '2024-01-03T00:00:00Z');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();
      await Promise.all(sessions(handlers, makeCtx(root).ctx));

      // #8 closes with a NEWER timestamp, so the margin reports it as closed.
      model.set(8, 'closed', '2024-02-01T00:00:00Z');
      const issuesOpen = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', issuesOpen.ctx);

      const opened = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', opened.ctx);

      const row = registryLib.findByPath(root, target);
      assert.deepEqual(row.issues, [7], 'the closed issue is dropped from the stored assignment');
      assert.ok(opened.notes.some(([message]) => /dropped issue assignment\(s\) #8/.test(message)),
        `the removal is reported, never silent: ${JSON.stringify(opened.notes)}`);
      assert.match(opened.text(), /Issues \(1\)/, 'only the open issue is listed');
      assert.doesNotMatch(opened.text(), /#8\b/, 'a closed issue never appears as a choice');
    } finally {
      restoreEnv();
    }
  });
});

describe('S7d: proof, not assumption', { concurrency: false }, () => {
  test('a 404 drops the assignment while a network failure preserves it byte for byte', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('proof');
      const target = addRegisteredWorktree(root, 'feat/proof', { issues: [7, 999] });
      const model = fakeGitHub();
      model.set(7, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();
      await Promise.all(sessions(handlers, makeCtx(root).ctx));

      // 999 is not in the repository at all: gh answers 404 for it.
      const deleted = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', deleted.ctx);
      assert.deepEqual(registryLib.findByPath(root, target).issues, [7], 'the deleted issue is dropped on proof');
      assert.ok(deleted.notes.some(([message]) => /dropped issue assignment\(s\) #999/.test(message)),
        `the 404 removal is reported: ${JSON.stringify(deleted.notes)}`);

      // Now an unverifiable number (an auth failure) must never be removed.
      const row = registryLib.findByPath(root, target);
      assert.equal(registryLib.updateWorktree(root, row.path, { issues: [7, 4242] }).ok, true);
      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile);
      model.mode = 'auth';
      const unverified = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', unverified.ctx);
      assert.deepEqual(fs.readFileSync(registryFile), before, 'a failed verification writes nothing');
      assert.ok(unverified.notes.some(([message]) => /could not verify issue assignment\(s\) #4242/.test(message)),
        `the failure is reported: ${JSON.stringify(unverified.notes)}`);
      assert.deepEqual(registryLib.findByPath(root, target).issues, [7, 4242], 'nothing was purged');

      // Saving from the detail may never remove a number the surface could not
      // list: it was never on screen for the reader to untick.
      const saving = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', saving.ctx);
      saving.mounted.component.handleInput('ctrl+s');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(registryLib.findByPath(root, target).issues, [7, 4242],
        'an unverifiable assignment survives a save');
    } finally {
      restoreEnv();
    }
  });

  test('one repository never answers for another', async () => {
    setEnv(stdEnv());
    try {
      const rootA = makeRepo('iso-a');
      const targetA = addRegisteredWorktree(rootA, 'feat/iso-a', { issues: [7] });
      const modelA = fakeGitHub({ nameWithOwner: 'octo/a' });
      modelA.set(7, 'open');
      ghIssues.setGhRunner(modelA.runner);
      let loaded = await loadExtension();      await Promise.all(sessions(loaded.handlers, makeCtx(rootA).ctx));

      const rootB = makeRepo('iso-b');
      const targetB = addRegisteredWorktree(rootB, 'feat/iso-b', { issues: [7] });
      const modelB = fakeGitHub({ nameWithOwner: 'octo/b' });
      modelB.set(11, 'open');
      // ONE extension instance answers both repositories, so a cache keyed by
      // anything other than the repository's canonical identity would leak A's
      // proof into B.
      modelA.byCwd = new Map([[rootA, modelA], [targetA, modelA], [rootB, modelB], [targetB, modelB]]);

      const openedB = makeCtx(targetB);
      await loaded.commands.get('herdr-gentle:worktree').handler('', openedB.ctx);
      assert.deepEqual(registryLib.findByPath(rootB, targetB).issues, [], 'B never inherits A\'s proof');
      assert.ok(openedB.notes.some(([message]) => /dropped issue assignment\(s\) #7/.test(message)),
        `B verifies against B: ${JSON.stringify(openedB.notes)}`);
      assert.deepEqual(registryLib.findByPath(rootA, targetA).issues, [7], 'A is untouched');
    } finally {
      restoreEnv();
    }
  });
});

describe('S10: one bounded snapshot per session, never a sampled page as proof', { concurrency: false }, () => {
  test('a capped snapshot stays unverifiable and no absence ever tombstones a stored issue', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('capped');
      const target = addRegisteredWorktree(root, 'feat/capped', { issues: [1] });
      const model = fakeGitHub();
      // 600 open issues, ordered newest-number-first: the bounded snapshot can
      // only ever carry #101..#600, so #1 is absent from every fetched list
      // while still being open in the repository.
      for (let number = 1; number <= 600; number += 1) model.set(number, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();

      await Promise.all(sessions(handlers, makeCtx(root).ctx));
      const snapshots = opensOf(model.calls, 'open');
      assert.ok(snapshots.length >= 1, 'the prime does ask for the open set');
      for (const argv of snapshots) {
        const limit = Number(argv[argv.indexOf('--limit') + 1]);
        assert.ok(limit <= 500, `the snapshot stays inside its bound: ${limit}`);
      }

      // A repeated session_start reuses the session's cache state instead of
      // resetting it, and the still-unprovable snapshot never tombstones.
      await Promise.all(sessions(handlers, makeCtx(root).ctx));
      assert.deepEqual(registryLib.findByPath(root, target).issues, [1], 'no fetch-only absence removes a stored issue');

      // The detail then verifies exactly the number it could not prove open.
      const opened = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', opened.ctx);
      assert.deepEqual(registryLib.findByPath(root, target).issues, [1], '#1 survives a truncated list');
      assert.ok(!opened.notes.some(([message]) => /dropped issue assignment/.test(message)),
        `nothing was dropped: ${JSON.stringify(opened.notes)}`);
    } finally {
      restoreEnv();
    }
  });
});

describe('S7d: a repository-level 404 proves nothing', { concurrency: false }, () => {
  test('the stored assignment keeps its bytes and is reported unverifiable', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('repo404');
      const target = addRegisteredWorktree(root, 'feat/repo404', { issues: [999] });
      const model = fakeGitHub();
      model.set(7, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();
      await Promise.all(sessions(handlers, makeCtx(root).ctx));

      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile);
      // Private or inaccessible repository: every issue view answers the
      // generic `HTTP 404: Not Found`, which names no issue.
      model.mode = 'repo404';
      const opened = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', opened.ctx);

      assert.deepEqual(fs.readFileSync(registryFile), before, 'a generic 404 writes nothing');
      assert.deepEqual(registryLib.findByPath(root, target).issues, [999], 'the assignment is preserved');
      assert.ok(opened.notes.some(([message]) => /could not verify issue assignment\(s\) #999/.test(message)),
        `the failure is reported: ${JSON.stringify(opened.notes)}`);
      assert.ok(!opened.notes.some(([message]) => /dropped issue assignment/.test(message)),
        'a 404 for the repository never drops the issue');
    } finally {
      restoreEnv();
    }
  });
});
