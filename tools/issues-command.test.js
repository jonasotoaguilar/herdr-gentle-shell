'use strict';
// P3/P4 (issues-view S1,S9 + S3,S4,S10) tests: the `/herdr-gentle:issues`
// command in extensions/gentle-worktree-tools.ts.
//
// Contract under test (observable behavior only — registration, the
// notified text, the overlay options, the rendered marks, the registry
// bytes, the argv reaching the injected `gh` runner; never internal
// names):
// - GATED (S9): the command registers only after the session-start `gh`
//   check reports an authenticated user. A missing `gh` or an
//   unauthenticated user notifies ONCE per session (naming what is
//   missing and the command that fixes it) and never registers.
// - with the gate open, no argument opens the three-page view through
//   ctx.ui.custom with the odd viewer's full-screen overlay options,
//   fed by listIssues with the S2 searches (author:@me, assignee:@me,
//   involves:@me), getIssue for the detail, listLabels for the repo
//   labels, and an `o`-key opener as `gh issue view <n> --web` through a
//   fixed argv (never a shell, never xdg-open);
// - assignment reads the checkout's stored `issues[]` and saves through
//   the registry with the odd saver's guards (real branch + resolved
//   thread for a created row, refuse without writing, append on a
//   same-branch conflict);
// - label edit (including create-new), comment, close/reopen each reach
//   lib/gh-issues.js; a failure keeps local state unchanged, shows the
//   error, and never claims success; no write happens without its key.
//
// Loading pattern mirrors tools/odd-command.test.js: the TypeScript
// extension is plain JS under the hood, so the test copies it to a
// temporary .mjs with the package import lines stubbed and import()s it
// with a fake `pi` object. `gh` is injected through the real
// lib/gh-issues.js `setGhRunner` seam (same module instance the
// extension loads via GENTLE_WORKTREE_LIB_DIR), so no live `gh` runs.

const { test, describe, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const ghIssues = require('../lib/gh-issues.js');
const worktreeGit = require('../lib/worktree-git.js');

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

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function makeRepo({ tag = 'issues' } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

const savedEnv = { ...process.env };
// Mode is a user preference, never a test fixture. Each invocation starts in
// an isolated default-enabled state; mode-specific cases override only that.
beforeEach(() => {
  process.env.GENTLE_STATUS_STATE_DIR = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-default-mode-')));
});
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

afterEach(() => {
  ghIssues.setGhRunner(null);
});

const FIXTURES = path.join(__dirname, 'fixtures');
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const commands = new Map();
  const sessionStarts = [];
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, fn) => { if (event === 'session_start') sessionStarts.push(fn); return () => {}; },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  // The Herdr plugin check runs on session_start too: point it at a
  // missing binary so it stays silent and never pollutes notifications.
  process.env.HERDR_BIN_PATH = path.join(dir, 'no-such-herdr-binary');
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { commands, mod, sessionStarts };
}

async function fireSessionStart(sessionStarts, ctx) {
  for (const fn of sessionStarts) {
    const out = fn({}, ctx);
    if (out && typeof out.then === 'function') await out;
  }
}

function gateCtx(cwd, notes) {
  return { cwd, ui: { notify: (message, level) => notes.push([message, level]) } };
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

function makeHostTui(rows = 24) {
  const paints = [];
  return { paints, tui: { terminal: { rows }, requestRender: () => paints.push(true) } };
}

function makeCtx({ cwd, customImpl } = {}) {
  const notes = [];
  const customs = [];
  const selects = [];
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => notes.push([message, level]),
      select: async (title, options) => { selects.push([title, options]); return undefined; },
    },
  };
  if (customImpl !== undefined) {
    ctx.ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  return { ctx, notes, customs, selects };
}

function openComponent(factory, host) {
  let settled = 'pending';
  const component = factory(host.tui, {}, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  assert.equal(typeof component.invalidate, 'function');
  return { component, done: () => settled };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// Pattern-matching `gh` runner over the captured real-`gh` fixtures:
// answers by argv shape and records every call, so the action tests can
// pin the exact fixed argv each write reaches `gh` with.
function makeIssuesRunner({ failComment = false } = {}) {
  const calls = [];
  const ok = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
  const runner = async (bin, argv) => {
    calls.push({ bin, argv: argv.slice() });
    if (argv[0] === 'api') return ok(fixture('gh-api-user.json'));
    if (argv[0] === 'repo') return ok(fixture('gh-repo-view.json'));
    if (argv[0] === 'issue' && argv[1] === 'list') return ok(fixture('gh-issue-list.json'));
    if (argv[0] === 'issue' && argv[1] === 'view' && argv.includes('--json')) {
      return ok(fixture('gh-issue-view.json'));
    }
    if (argv[0] === 'label' && argv[1] === 'list') return ok(fixture('gh-label-list.json'));
    if (argv[0] === 'label' && argv[1] === 'create') return ok('{}');
    if (argv[0] === 'issue' && argv[1] === 'comment') {
      if (failComment) return { status: 1, stdout: '', stderr: 'rate limited', error: null };
      return ok('');
    }
    if (argv[0] === 'issue' && (argv[1] === 'edit' || argv[1] === 'close' || argv[1] === 'reopen')) {
      return ok('');
    }
    return ok('');
  };
  return { runner, calls };
}

function registryFile(root) {
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  const commonDir = path.isAbsolute(common) ? common : path.resolve(root, common);
  return path.join(commonDir, 'pi-worktrees.json');
}

function writeRegistry(root, worktrees) {
  const file = registryFile(root);
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, worktrees }, null, 2)}\n`);
  return file;
}

function readRaw(file) {
  return fs.readFileSync(file, 'utf8');
}

function branchOf(root) {
  return git(root, ['branch', '--show-current']).trim();
}

function withThread(value) {
  const prev = process.env.GENTLE_WORKTREE_THREAD;
  if (value === undefined) delete process.env.GENTLE_WORKTREE_THREAD;
  else process.env.GENTLE_WORKTREE_THREAD = value;
  return () => {
    if (prev === undefined) delete process.env.GENTLE_WORKTREE_THREAD;
    else process.env.GENTLE_WORKTREE_THREAD = prev;
  };
}

// Gate the extension through session_start fired with a scratch cwd (so
// the unrelated worktree discovery never touches the fixture repo),
// then run the command handler against the fixture checkout.
async function openIssues(root, { runner } = {}) {
  const { commands, mod, sessionStarts } = await loadExtension();
  ghIssues.setGhRunner(runner || makeIssuesRunner().runner);
  const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
  await fireSessionStart(sessionStarts, gateCtx(scratch, []));
  const def = commands.get('herdr-gentle:issues');
  assert.ok(def, 'expected the herdr-gentle:issues command to be registered once the gate is open');
  mod.setIssuesTuiLoader(async () => stubTui);
  const host = makeHostTui(24);
  let factory = null;
  const { ctx, notes, customs } = makeCtx({
    cwd: root,
    customImpl: async (captured) => { factory = captured; return null; },
  });
  await def.handler('', ctx);
  assert.ok(factory, 'the overlay opens');
  const { component } = openComponent(factory, host);
  await tick();
  return { component, notes, customs, commands };
}

describe('/herdr-gentle:issues gate (S3)', () => {
  test('registers the command eagerly so it is in the autocomplete snapshot from load', async () => {
    const { commands } = await loadExtension();
    const def = commands.get('herdr-gentle:issues');
    assert.ok(def, 'the command is registered at load, independent of the gh check');
    assert.equal(typeof def.handler, 'function');
  });

  test('an authenticated gate keeps the command registered and notifies nothing', async () => {
    const { commands, sessionStarts } = await loadExtension();
    const { runner } = makeIssuesRunner();
    ghIssues.setGhRunner(runner);
    const root = makeRepo({ tag: 'gate-ok' });
    const notes = [];
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    assert.ok(commands.has('herdr-gentle:issues'), 'the open gate keeps the command');
    assert.deepEqual(notes, [], 'an open gate notifies nothing');
  });

  test('a missing gh notifies the fix once at startup and again on invocation, opening nothing', async () => {
    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(async (bin, argv) => ({
      status: null, stdout: '', stderr: '', error: `spawn ${bin} ENOENT: gh CLI is not available`,
    }));
    const root = makeRepo({ tag: 'gate-missing' });
    const notes = [];
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    assert.ok(commands.has('herdr-gentle:issues'), 'the command stays discoverable');
    assert.equal(notes.length, 1, 'exactly one startup notification per session');
    assert.match(notes[0][0], /gh CLI is not available/, 'the note names what is missing');
    assert.match(notes[0][0], /gh auth login/, 'the note names the command that fixes it');

    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes: invokeNotes } = makeCtx({ cwd: root, customImpl: async () => null });
    await commands.get('herdr-gentle:issues').handler('', ctx);
    assert.equal(customs.length, 0, 'invocation without gh opens nothing');
    assert.equal(invokeNotes.length, 1, 'invocation reports the honest dependency error');
    assert.match(invokeNotes[0][0], /gh auth login/);
    assert.equal(invokeNotes[0][1], 'error');
  });

  test('an unauthenticated gh notifies the login fix on invocation and opens nothing', async () => {
    const { commands, mod } = await loadExtension();
    ghIssues.setGhRunner(async () => ({
      status: 1, stdout: '', stderr: 'Failed to log in: authentication required', error: null,
    }));
    const root = makeRepo({ tag: 'gate-auth' });
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await commands.get('herdr-gentle:issues').handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay while unauthenticated');
    assert.equal(notes.length, 1);
    assert.match(notes[0][0], /gh auth login/, 'the note names the login fix');
  });
});

describe('/herdr-gentle:issues overlay', () => {
  test('opens full screen with the odd-viewer overlay options, fed by the S2 searches', async () => {
    const root = makeRepo({ tag: 'issues-open' });
    const { runner, calls } = makeIssuesRunner();
    const { component, customs, notes } = await openIssues(root, { runner });
    assert.equal(customs.length, 1, 'the overlay opens once');
    assert.deepEqual(customs[0][1], {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '100%', maxHeight: '100%', margin: 0 },
    });
    assert.deepEqual(notes, [], 'opening writes no notification');
    const searches = calls
      .filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list')
      .map((call) => call.argv[call.argv.indexOf('--search') + 1]);
    // S10/S16: the source asks gh for last-update ordering, so each page's
    // query carries the sort; Involved excludes the viewer's own issues so
    // the two buckets are disjoint at the source, before any client filter.
    assert.deepEqual(searches, [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ]);
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues/, 'first page tab');
    assert.match(body, /Assigned/, 'second page tab');
    assert.match(body, /Involved/, 'third page tab');
    assert.match(body, /76/, 'the listed issue number');
    assert.match(body, /chore: update/, 'the listed issue title');
    assert.match(body, /◈ Issues · My issues/, 'the header names the focused bucket');
    assert.ok(!body.includes(path.basename(root)), 'S25: the header never repeats the checkout name');
  });

  test('an argument notifies and opens nothing', async () => {
    const root = makeRepo({ tag: 'issues-args' });
    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
    await fireSessionStart(sessionStarts, gateCtx(scratch, []));
    const def = commands.get('herdr-gentle:issues');
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await def.handler('extra', ctx);
    assert.equal(customs.length, 0, 'no overlay for an argument');
    assert.equal(notes.length, 1);
    assert.match(notes[0][0], /Unknown option/, 'the reader gets the usage line');
  });
});

describe('/herdr-gentle:issues outside a Git checkout (S11)', () => {
  test('notifies the one shared line at info and opens nothing', async () => {
    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(makeIssuesRunner().runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
    await fireSessionStart(sessionStarts, gateCtx(scratch, []));
    const def = commands.get('herdr-gentle:issues');
    assert.ok(def, 'the gate registers the command');
    mod.setIssuesTuiLoader(async () => stubTui);
    const outside = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-plain-'))));
    const { ctx, customs, selects, notes } = makeCtx({ cwd: outside, customImpl: async () => null });
    await def.handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay outside a checkout');
    assert.equal(selects.length, 0, 'no fallback selector outside a checkout');
    assert.deepEqual(
      notes,
      [[`not a git repository: ${outside}; run 'git init' first`, 'info']],
      'exactly the one shared line at info',
    );
  });
});

describe('/herdr-gentle:issues assignment', () => {
  test('reads the stored issues[] for the current checkout', async () => {
    const root = makeRepo({ tag: 'issues-read' });
    writeRegistry(root, [{
      branch: branchOf(root), path: root, thread: 'test-thread', issues: [76], odd: [],
    }]);
    const { component, notes } = await openIssues(root);
    const body = clean(component.render(110).join('\n'));
    const row = body.split('\n').find((line) => line.includes('76'));
    assert.ok(row, 'the stored issue is listed');
    assert.match(row, /✓/, 'the stored row carries ✓');
    assert.deepEqual(notes, [], 'reading writes nothing and notifies nothing');
  });

  test('ctrl+s creates the missing row with the real branch and thread', async () => {
    const restoreThread = withThread('issues-test-thread');
    try {
      const root = makeRepo({ tag: 'issues-create' });
      const file = registryFile(root);
      const expectedBranch = branchOf(root);
      assert.ok(!fs.existsSync(file), 'the fixture starts with no registry');
      const { component } = await openIssues(root);
      let body = clean(component.render(110).join('\n'));
      assert.ok(!body.includes('unsaved'), 'nothing pending before the toggle');
      assert.ok(!fs.existsSync(file), 'opening the view writes nothing');
      component.handleInput('space');
      assert.ok(!fs.existsSync(file), 'toggling alone writes nothing without ctrl+s');
      component.handleInput('ctrl+s');
      await tick();
      assert.ok(fs.existsSync(file), 'the save creates the registry');
      const stored = JSON.parse(readRaw(file));
      assert.equal(stored.worktrees.length, 1);
      assert.equal(stored.worktrees[0].path, root);
      assert.equal(stored.worktrees[0].branch, expectedBranch, 'the created row carries the real branch');
      assert.equal(stored.worktrees[0].thread, 'issues-test-thread', 'the created row carries the resolved thread');
      assert.deepEqual(stored.worktrees[0].issues, [76]);
      body = clean(component.render(110).join('\n'));
      assert.ok(!body.includes('unsaved'), 'a successful save clears the pending state');
    } finally { restoreThread(); }
  });

  test('without a resolvable thread the save refuses and writes nothing', async () => {
    const restoreThread = withThread(undefined);
    try {
      const root = makeRepo({ tag: 'issues-nothread' });
      const file = writeRegistry(root, []);
      const before = readRaw(file);
      const { component } = await openIssues(root);
      component.handleInput('space');
      component.handleInput('ctrl+s');
      await tick();
      const body = clean(component.render(110).join('\n'));
      assert.match(body, /save failed/, 'the refusal surfaces in the view');
      assert.match(body, /thread identity/, 'the error names the missing thread identity');
      assert.equal(readRaw(file), before, 'the registry file stays byte-identical');
    } finally { restoreThread(); }
  });

  test('without a determinable branch the save refuses and writes nothing', async () => {
    const restoreThread = withThread('issues-test-thread-b');
    try {
      const root = makeRepo({ tag: 'issues-nobranch' });
      git(root, ['checkout', '--detach', 'HEAD']);
      const file = writeRegistry(root, []);
      const before = readRaw(file);
      const { component } = await openIssues(root);
      component.handleInput('space');
      component.handleInput('ctrl+s');
      await tick();
      const body = clean(component.render(110).join('\n'));
      assert.match(body, /save failed/, 'the refusal surfaces in the view');
      assert.match(body, /branch/, 'the error names the missing branch');
      assert.equal(readRaw(file), before, 'the registry file stays byte-identical');
    } finally { restoreThread(); }
  });

  test('a same-branch row at a different live checkout is kept, not replaced', async () => {
    const restoreThread = withThread('issues-test-thread-e');
    try {
      const root = makeRepo({ tag: 'issues-collide' });
      const targetBranch = branchOf(root);
      const wtBase = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-collide-')));
      const linked = path.join(wtBase, 'linked');
      git(root, ['worktree', 'add', linked, '-b', 'collide-branch']);
      const linkedReal = fs.realpathSync(linked);
      const stamp = '2026-02-01T00:00:00.000Z';
      const keeper = {
        branch: targetBranch, path: linkedReal, thread: 'keeper-thread', issues: [9],
        odd: ['odd/tasks/keep.md'], createdAt: stamp, updatedAt: stamp,
      };
      const file = writeRegistry(root, [keeper]);
      const keeperBefore = JSON.parse(readRaw(file)).worktrees[0];
      const { component } = await openIssues(root);
      component.handleInput('space');
      component.handleInput('ctrl+s');
      await tick();
      const body = clean(component.render(110).join('\n'));
      assert.ok(!body.includes('save failed'), 'the save succeeds');
      const stored = JSON.parse(readRaw(file));
      assert.equal(stored.worktrees.length, 2, 'both rows still exist');
      const kept = stored.worktrees.find((row) => row.path === linkedReal);
      assert.deepEqual(kept, keeperBefore, 'the colliding row keeps its issues/odd/thread/createdAt');
      const created = stored.worktrees.find((row) => row.path === root);
      assert.ok(created, 'the new checkout is registered alongside it');
      assert.equal(created.branch, targetBranch);
      assert.equal(created.thread, 'issues-test-thread-e');
      assert.deepEqual(created.issues, [76]);
    } finally { restoreThread(); }
  });

  test('a refusing registry reports the error without writing', async () => {
    const root = makeRepo({ tag: 'issues-refuse' });
    const file = writeRegistry(root, []);
    fs.writeFileSync(file, '{not json');
    const before = readRaw(file);
    const { component } = await openIssues(root);
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /save failed/, 'the failed save shows its error');
    assert.match(body, /unsaved/, 'the pending mark survives the refusal');
    assert.equal(readRaw(file), before, 'the refusing registry is left untouched');
  });
});

describe('/herdr-gentle:issues actions (S3,S4,S10)', () => {
  test('label toggle, create-new, comment, browser and close/reopen reach gh with fixed argv', async () => {
    const root = makeRepo({ tag: 'issues-actions' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    const ghCalls = () => calls.filter((call) => call.bin === 'gh');

    component.handleInput('L');
    assert.equal(component.state.mode, 'labels');
    // S19: the label list loads lazily on the editor's first open, so wait
    // for it before naming a label to toggle.
    await tick();
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(component.state.mode, 'list', 'a successful label apply closes the editor');
    const edit = ghCalls().find((call) => call.argv[1] === 'edit');
    assert.ok(edit, 'the label toggle reaches gh issue edit');
    assert.deepEqual(edit.argv.slice(0, 3), ['issue', 'edit', '76']);
    assert.ok(edit.argv.includes('--add-label'), 'additions ride --add-label');
    assert.ok(edit.argv.includes('bug'), 'the toggled label is applied');
    assert.ok(!edit.argv.join(' ').includes('&&'), 'fixed argv: no shell string');

    component.handleInput('L');
    component.handleInput('n');
    for (const ch of 'triage') component.handleInput(ch);
    component.handleInput('enter');
    component.handleInput('ctrl+s');
    await tick();
    const create = ghCalls().find((call) => call.argv[1] === 'create');
    assert.ok(create, 'a new label reaches gh label create');
    assert.deepEqual(create.argv.slice(0, 3), ['label', 'create', 'triage']);

    component.handleInput('c');
    assert.equal(component.state.mode, 'comment');
    for (const ch of 'hi') component.handleInput(ch);
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(component.state.mode, 'list', 'a posted comment closes the input');
    const comment = ghCalls().find((call) => call.argv[1] === 'comment');
    assert.ok(comment, 'the comment reaches gh issue comment');
    assert.deepEqual(comment.argv, ['issue', 'comment', '76', '--body', 'hi']);

    const gitCalls = [];
    const originalRunArgv = worktreeGit.runArgv;
    worktreeGit.runArgv = (bin, argv, _opts) => {
      gitCalls.push({ bin, argv: argv.slice() });
      return { status: 0, stdout: '', stderr: '', error: null };
    };
    try {
      component.handleInput('o');
    } finally {
      worktreeGit.runArgv = originalRunArgv;
    }
    assert.equal(gitCalls.length, 1, 'the browser opener runs once');
    assert.deepEqual(gitCalls[0].argv, ['issue', 'view', '76', '--web']);
    assert.ok(!gitCalls[0].argv.join(' ').includes('xdg-open'), 'never an invented opener');

    component.handleInput('X');
    assert.equal(component.state.mode, 'confirm');
    component.handleInput('enter');
    await tick();
    const reopen = ghCalls().find((call) => call.argv[1] === 'reopen');
    assert.ok(reopen, 'reopen reaches gh issue reopen');
    assert.deepEqual(reopen.argv, ['issue', 'reopen', '76']);

    component.handleInput('x');
    component.handleInput('enter');
    await tick();
    const close = ghCalls().find((call) => call.argv[1] === 'close');
    assert.ok(close, 'close reaches gh issue close');
    assert.deepEqual(close.argv, ['issue', 'close', '76']);
  });

  test('a failing comment keeps the draft, shows the error and changes nothing', async () => {
    const root = makeRepo({ tag: 'issues-fail' });
    const { runner, calls } = makeIssuesRunner({ failComment: true });
    const { component } = await openIssues(root, { runner });
    component.handleInput('c');
    for (const ch of 'hey') component.handleInput(ch);
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(component.state.mode, 'comment', 'the failure keeps the input open');
    assert.equal(component.state.commentText, 'hey', 'the draft survives the failure');
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /rate limited/, 'the error surfaces honestly');
    const comment = calls.filter((call) => call.argv[1] === 'comment');
    assert.equal(comment.length, 1, 'one attempt, no retry, no success claim');
  });
});

describe('/herdr-gentle:issues honest totals end to end', () => {
  function manyListIssues(n) {
    const items = [];
    for (let i = 1; i <= n; i += 1) {
      items.push({
        number: i, title: `issue ${i} chore: update`, state: 'OPEN', stateReason: '',
        author: { login: 'someone' }, labels: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
        comments: [], reactionGroups: [],
        url: `https://example.test/issues/${i}`, body: '',
      });
    }
    return items;
  }

  // A `gh`-honest runner: like the real binary, `issue list` answers at
  // most --limit rows, so a client that asks for a page instead of the
  // bound is caught reporting the page count as the total.
  function makeBoundedRunner(n) {
    const calls = [];
    const ok = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
    const runner = async (bin, argv) => {
      calls.push({ bin, argv: argv.slice() });
      if (argv[0] === 'api') return ok(fixture('gh-api-user.json'));
      if (argv[0] === 'repo') return ok(fixture('gh-repo-view.json'));
      if (argv[0] === 'issue' && argv[1] === 'list') {
        const limitAt = argv.indexOf('--limit');
        const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : n;
        return ok(JSON.stringify(manyListIssues(n).slice(0, Number.isFinite(limit) ? limit : n)));
      }
      if (argv[0] === 'issue' && argv[1] === 'view' && argv.includes('--json')) {
        return ok(fixture('gh-issue-view.json'));
      }
      if (argv[0] === 'label' && argv[1] === 'list') return ok(fixture('gh-label-list.json'));
      return ok('');
    };
    return { runner, calls };
  }

  test('pages handed to the view carry the real total past one fetch page', async () => {
    const root = makeRepo({ tag: 'issues-totals' });
    const { runner } = makeBoundedRunner(45);
    const { component } = await openIssues(root, { runner });
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues \(45\)/, 'the tab names the real total, not the first fetch page');
    assert.match(body, /Assigned \(45\)/);
    assert.match(body, /Involved \(45\)/);
    assert.ok(!body.includes('+ issues'), 'an under-bound fetch never carries the + marker');
  });

  test('a bound-reached fetch carries the truncated flag into the view totals line', async () => {
    const root = makeRepo({ tag: 'issues-trunc' });
    const { runner } = makeBoundedRunner(500);
    const { component } = await openIssues(root, { runner });
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues \(500\+\)/, 'the tab names the bounded total');
    assert.match(body, /30\+ issues/, 'the bounded totals line carries the + marker');
  });
});

// ---------------------------------------------------------------------------
// S19/S18: mount before any network read, and toggle the state filter between
// exactly `open` (default) and `closed`, refetching through the one seam.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues first paint and state filter', () => {
  test('the overlay mounts before any list or label fetch and requests open pages', async () => {
    const root = makeRepo({ tag: 'issues-lazy' });
    const { runner, calls } = makeIssuesRunner();
    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
    await fireSessionStart(sessionStarts, gateCtx(scratch, []));
    const def = commands.get('herdr-gentle:issues');
    assert.ok(def, 'the command is registered');
    mod.setIssuesTuiLoader(async () => stubTui);
    const host = makeHostTui(24);
    let callsAtMount = null;
    const { ctx } = makeCtx({
      cwd: root,
      customImpl: async (factory) => {
        callsAtMount = calls.map((call) => call.argv.join(' '));
        openComponent(factory, host);
        await tick();
        return null;
      },
    });
    await def.handler('', ctx);
    assert.ok(callsAtMount !== null, 'the overlay mounted');
    assert.equal(callsAtMount.filter((line) => line.includes('issue list')).length, 0, 'no list fetch before mount');
    assert.equal(callsAtMount.filter((line) => line.includes('label list')).length, 0, 'no label fetch before mount');
    const lists = calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    assert.equal(lists.length, 3, 'three buckets fetched after mount');
    for (const call of lists) {
      const at = call.argv.indexOf('--state');
      assert.equal(call.argv[at + 1], 'open', `open state requested: ${call.argv.join(' ')}`);
    }
  });

  test('f toggles to closed and back, refetching each time with the shown state', async () => {
    const root = makeRepo({ tag: 'issues-closed' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    const states = () => calls
      .filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list')
      .map((call) => call.argv[call.argv.indexOf('--state') + 1]);
    assert.deepEqual(states(), ['open', 'open', 'open'], 'the default fetch is open');
    component.handleInput('f');
    await tick();
    assert.deepEqual(states().slice(3), ['closed', 'closed', 'closed'], 'f refetches closed');
    component.handleInput('f');
    await tick();
    assert.deepEqual(states().slice(6), ['open', 'open', 'open'], 'f refetches open again');
  });
});

// ---------------------------------------------------------------------------
// S29: `/herdr-gentle:issues` stays registered while the worktree mode is off
// or malformed; only the worktree association is disabled. The extension
// re-reads the mode inside the save callback, so a panel opened while enabled
// still refuses once the mode is switched off.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues assignment mode gate (S29)', () => {
  const modeLib = require('../lib/worktree-mode.js');
  const S29_REFUSAL = 'worktree tools are disabled; enable them in /herdr-gentle:customize to assign issues or odd documents';

  function modeDir() {
    return track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-mode-')));
  }

  async function withModeDir(run, { malformed = false } = {}) {
    const dir = modeDir();
    const saved = { ...process.env };
    process.env.GENTLE_STATUS_STATE_DIR = dir;
    try {
      if (malformed) fs.writeFileSync(modeLib.modePath(process.env), 'not json\n');
      return await run();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    }
  }

  function captureIssuesView() {
    const lib = require('../lib/issues-view.js');
    const original = lib.createIssuesView;
    const holder = { options: null };
    lib.createIssuesView = (options) => {
      holder.options = options;
      return { render: () => [], handleInput: () => {}, invalidate: () => {} };
    };
    return { holder, restore: () => { lib.createIssuesView = original; } };
  }

  test('mode off: the command exists, assignmentEnabled is false and the save callback refuses with zero writes', async () => {
    await withModeDir(async () => {
      modeLib.writeMode(false, process.env);
      const capture = captureIssuesView();
      try {
        const root = makeRepo({ tag: 'issues-s29-off' });
        const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: [] }]);
        const before = readRaw(file);
        const { runner } = makeIssuesRunner();
        const { commands } = await openIssues(root, { runner });
        assert.ok(commands.has('herdr-gentle:issues'), 'the command stays registered while the mode is off');
        assert.ok(capture.holder.options, 'the view was constructed');
        assert.equal(capture.holder.options.assignmentEnabled, false, 'the disabled mode travels to the view');
        const result = await capture.holder.options.saveAssignment([76]);
        assert.deepEqual(result, { ok: false, error: S29_REFUSAL }, 'the refusal is honest and exact');
        assert.equal(readRaw(file), before, 'a refused save leaves the registry bytes unchanged');
      } finally {
        capture.restore();
      }
    });
  });

  test('malformed mode: the command exists, assignmentEnabled is false and the callback refuses', async () => {
    await withModeDir(async () => {
      const capture = captureIssuesView();
      try {
        const root = makeRepo({ tag: 'issues-s29-malformed' });
        const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: [] }]);
        const before = readRaw(file);
        const { runner } = makeIssuesRunner();
        const { commands } = await openIssues(root, { runner });
        assert.ok(commands.has('herdr-gentle:issues'), 'the command stays registered with a malformed mode');
        assert.equal(capture.holder.options.assignmentEnabled, false, 'a malformed mode never enables assignment');
        const result = await capture.holder.options.saveAssignment([76]);
        assert.deepEqual(result, { ok: false, error: S29_REFUSAL });
        assert.equal(readRaw(file), before, 'a malformed mode never writes');
      } finally {
        capture.restore();
      }
    }, { malformed: true });
  });

  test('mode switched off after opening: the callback re-reads and refuses', async () => {
    await withModeDir(async () => {
      modeLib.writeMode(true, process.env);
      const capture = captureIssuesView();
      try {
        const root = makeRepo({ tag: 'issues-s29-switched' });
        const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: [] }]);
        const before = readRaw(file);
        const { runner } = makeIssuesRunner();
        await openIssues(root, { runner });
        assert.equal(capture.holder.options.assignmentEnabled, true, 'the enabled mode opened normally');
        modeLib.writeMode(false, process.env);
        const result = await capture.holder.options.saveAssignment([76]);
        assert.deepEqual(result, { ok: false, error: S29_REFUSAL }, 'the callback re-reads the mode, not the snapshot');
        assert.equal(readRaw(file), before, 'the registry is untouched');
      } finally {
        capture.restore();
      }
    });
  });

  test('enabled mode: assignmentEnabled stays true (regression)', async () => {
    await withModeDir(async () => {
      const capture = captureIssuesView();
      try {
        const root = makeRepo({ tag: 'issues-s29-on' });
        writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: [] }]);
        const { runner } = makeIssuesRunner();
        await openIssues(root, { runner });
        assert.equal(capture.holder.options.assignmentEnabled, true, 'the enabled mode passes true');
      } finally {
        capture.restore();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// S19/S16: the verifier's page-read probes — the three bucket fetches must
// overlap in wall-clock time, and no read may ask `gh` for `--state all`
// while Involved excludes the authored bucket at the source.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues page fetch parallelism and state honesty', () => {
  test('the three page fetches run in parallel, never serialized', async () => {
    const DELAY_MS = 120;
    const root = makeRepo({ tag: 'issues-parallel' });
    const base = makeIssuesRunner();
    let firstListAt = null;
    let listsDone = 0;
    let resolveAll;
    const allListsDone = new Promise((resolve) => { resolveAll = resolve; });
    const runner = async (bin, argv) => {
      if (argv[0] === 'issue' && argv[1] === 'list') {
        if (firstListAt === null) firstListAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        listsDone += 1;
        if (listsDone === 3) resolveAll(Date.now());
      }
      return base.runner(bin, argv);
    };

    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
    await fireSessionStart(sessionStarts, gateCtx(scratch, []));
    const def = commands.get('herdr-gentle:issues');
    assert.ok(def, 'the command is registered');
    mod.setIssuesTuiLoader(async () => stubTui);
    let factory = null;
    const { ctx } = makeCtx({ cwd: root, customImpl: async (captured) => { factory = captured; return null; } });
    await def.handler('', ctx);
    openComponent(factory, makeHostTui(24));

    const finishedAt = await allListsDone;
    assert.equal(listsDone, 3, 'all three buckets were fetched');
    const elapsed = finishedAt - firstListAt;
    assert.ok(
      elapsed < 260,
      `three ${DELAY_MS}ms pages finished in ${elapsed}ms; serialized they would need ~${DELAY_MS * 3}ms`,
    );
  });

  test('no page fetch ever asks for --state all, and Involved excludes the authored bucket', async () => {
    const root = makeRepo({ tag: 'issues-state-honest' });
    const { runner, calls } = makeIssuesRunner();
    await openIssues(root, { runner });
    const lists = calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    assert.equal(lists.length, 3, 'three buckets fetched');
    for (const call of lists) {
      const at = call.argv.indexOf('--state');
      assert.ok(at >= 0, `every list call names its state: ${call.argv.join(' ')}`);
      assert.notEqual(call.argv[at + 1], 'all', `--state all is never emitted: ${call.argv.join(' ')}`);
      assert.ok(['open', 'closed'].includes(call.argv[at + 1]), `the state is a real filter: ${call.argv.join(' ')}`);
    }
    const involved = lists
      .map((call) => call.argv[call.argv.indexOf('--search') + 1])
      .filter((query) => query.startsWith('involves:'));
    assert.deepEqual(involved, ['involves:@me -author:@me sort:updated-desc'], 'Involved excludes authored issues at the source');
  });
});
