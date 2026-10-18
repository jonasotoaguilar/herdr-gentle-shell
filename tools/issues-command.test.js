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

const { test, describe, after, afterEach } = require('node:test');
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
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => notes.push([message, level]),
    },
  };
  if (customImpl !== undefined) {
    ctx.ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  return { ctx, notes, customs };
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

describe('/herdr-gentle:issues gate (S9)', () => {
  test('registers the command when gh reports an authenticated user', async () => {
    const { commands, sessionStarts } = await loadExtension();
    assert.ok(!commands.has('herdr-gentle:issues'), 'nothing registered at load: the check runs at session start');
    const { runner } = makeIssuesRunner();
    ghIssues.setGhRunner(runner);
    const root = makeRepo({ tag: 'gate-ok' });
    const notes = [];
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    const def = commands.get('herdr-gentle:issues');
    assert.ok(def, 'the authenticated gate registers the command');
    assert.equal(typeof def.handler, 'function');
    assert.deepEqual(notes, [], 'an open gate notifies nothing');
  });

  test('a missing gh notifies once with the fix and never registers', async () => {
    const { commands, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(async (bin, argv) => ({
      status: null, stdout: '', stderr: '', error: `spawn ${bin} ENOENT: gh CLI is not available`,
    }));
    const root = makeRepo({ tag: 'gate-missing' });
    const notes = [];
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    assert.ok(!commands.has('herdr-gentle:issues'), 'no registration without gh');
    assert.equal(notes.length, 1, 'exactly one notification per session');
    assert.match(notes[0][0], /gh CLI is not available/, 'the note names what is missing');
    assert.match(notes[0][0], /gh auth login/, 'the note names the command that fixes it');
    assert.equal(notes[0][1], 'info');
  });

  test('an unauthenticated gh notifies once with the login fix and never registers', async () => {
    const { commands, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(async () => ({
      status: 1, stdout: '', stderr: 'Failed to log in: authentication required', error: null,
    }));
    const root = makeRepo({ tag: 'gate-auth' });
    const notes = [];
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    assert.ok(!commands.has('herdr-gentle:issues'), 'no registration while unauthenticated');
    assert.equal(notes.length, 1, 'exactly one notification per session');
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
    assert.deepEqual(searches, ['author:@me', 'assignee:@me', 'involves:@me']);
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues/, 'first page tab');
    assert.match(body, /Assigned/, 'second page tab');
    assert.match(body, /Involved/, 'third page tab');
    assert.match(body, /76/, 'the listed issue number');
    assert.match(body, /chore: update/, 'the listed issue title');
    assert.match(body, new RegExp(path.basename(root)), 'the title names the checkout');
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
    worktreeGit.runArgv = (bin, argv, opts) => {
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
    assert.match(body, /My issues \(500\)/, 'the tab names the bounded total');
    assert.match(body, /30\+ issues/, 'the bounded totals line carries the + marker');
  });
});
