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

// Captures the options the extension mounts the real view with, while leaving
// everything the extension calls (`lib/gh-issues.js`) real and injectable.
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

// The cursor-paged GraphQL snapshot the session cache primes through, built
// from the rows the list seam answers with.
function graphqlSnapshotOf(argv, rows) {
  const field = (name) => {
    for (let index = 0; index < argv.length - 1; index += 1) {
      if (argv[index] === '-F' && argv[index + 1].startsWith(`${name}=`)) return argv[index + 1].slice(name.length + 1);
    }
    return null;
  };
  const first = Number(field('first'));
  const cursor = field('cursor');
  const offset = cursor === null ? 0 : Number(cursor.replace('page-', ''));
  const page = rows.slice(offset, offset + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = offset + page.length < rows.length;
  return JSON.stringify({
    data: {
      repository: {
        issues: {
          totalCount: rows.length,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? `page-${offset + page.length}` : null },
          nodes: page.map((row) => ({
            number: row.number,
            title: row.title,
            state: String(row.state || 'OPEN').toUpperCase(),
            stateReason: '',
            author: { login: (row.author && row.author.login) || 'someone' },
            labels: { nodes: [] },
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            url: row.url,
            comments: { totalCount: 0 },
            reactionGroups: [],
          })),
        },
      },
    },
  });
}

// The cursor-paged SEARCH snapshot the fresh viewer reads through
// `getIssuePage` (S5/D1): every edge carries its own opaque cursor, so a
// caller resumes after the last row it actually showed.
function graphqlSearchPage(argv, rows) {
  const field = (name) => {
    for (let index = 0; index < argv.length - 1; index += 1) {
      if (argv[index] === '-F' && argv[index + 1].startsWith(`${name}=`)) return argv[index + 1].slice(name.length + 1);
    }
    return null;
  };
  const first = Number(field('first'));
  const after = field('cursor');
  const start = after === null ? 0 : Number(String(after).replace('row-', '')) + 1;
  const page = rows.slice(start, start + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = start + page.length < rows.length;
  const node = (row) => ({
    number: row.number,
    title: row.title,
    state: String(row.state || 'OPEN').toUpperCase(),
    stateReason: '',
    url: row.url,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: { login: (row.author && row.author.login) || 'someone' },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    reactionGroups: [],
  });
  return JSON.stringify({
    data: {
      search: {
        issueCount: rows.length,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `row-${start + page.length - 1}` : null },
        edges: page.map((row, at) => ({ cursor: `row-${start + at}`, node: node(row) })),
      },
    },
  });
}

// The exact source query each fresh GraphQL search page asked for, with the
// client's own `repo:… is:issue is:open` prefix removed so the bucket text is
// asserted verbatim.
function searchQueries(calls) {
  return calls
    .filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')
    .map((call) => {
      for (let index = 0; index < call.argv.length - 1; index += 1) {
        if (call.argv[index] === '-F' && call.argv[index + 1].startsWith('search=')) {
          return call.argv[index + 1].slice('search='.length);
        }
      }
      return null;
    })
    .filter((value) => value !== null)
    .map((value) => value.replace(/^repo:\S+ is:issue is:open /, ''));
}

// Pattern-matching `gh` runner over the captured real-`gh` fixtures:
// answers by argv shape and records every call, so the action tests can
// pin the exact fixed argv each write reaches `gh` with.
//
// The repository role is part of the answer, never assumed by the viewer: a
// triage-level or unknown role removes the label/assignee editors (S16).
// `WRITE` is the default because the label test creates a label, which needs
// `canCreateLabels` and therefore write access.
function makeIssuesRunner({ failComment = false, role = 'WRITE' } = {}) {
  const calls = [];
  const ok = (stdout) => ({ status: 0, stdout, stderr: '', error: null });
  const rows = JSON.parse(fixture('gh-issue-list.json'));
  const graphqlQuery = (argv) => {
    const index = argv.indexOf('-f');
    const value = index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1] : '';
    return value.startsWith('query=') ? value.slice('query='.length) : '';
  };
  const runner = async (bin, argv, opts) => {
    calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined });
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      const query = graphqlQuery(argv);
      if (query.includes('assignableUsers')) {
        return ok(JSON.stringify({ data: { repository: { assignableUsers: {
          nodes: [{ login: 'jonasotoaguilar', name: 'Jonathan Soto' }, { login: 'octocat', name: 'Octo Cat' }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } }));
      }
      if (query.includes('projectItems')) {
        return ok(JSON.stringify({ data: { repository: { issue: {
          projectItems: { nodes: [], pageInfo: { hasNextPage: false } },
        } } } }));
      }
      if (query.includes('viewerPermission')) {
        return ok(JSON.stringify({ data: { repository: {
          viewerPermission: role,
          issue: {
            assignees: { nodes: [{ login: 'jonasotoaguilar' }], pageInfo: { hasNextPage: false } },
            closedByPullRequestsReferences: { totalCount: 2 },
          },
        } } }));
      }
      if (query.includes('type: ISSUE')) return ok(graphqlSearchPage(argv, rows));
      return ok(graphqlSnapshotOf(argv, rows));
    }
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
  const { component, done } = openComponent(factory, host);
  await tick();
  return { component, notes, customs, commands, done };
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
    ghIssues.setGhRunner(async (bin, _argv) => ({
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

  test('the gate note never claims the command is unregistered', async () => {
    const { commands, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(async (bin) => ({
      status: null, stdout: '', stderr: '', error: `spawn ${bin} ENOENT: gh CLI is not available`,
    }));
    const root = makeRepo({ tag: 'gate-wording' });
    const notes = [];
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    assert.equal(notes.length, 1);
    assert.ok(
      !/unregistered/.test(notes[0][0]),
      'the command is registered eagerly, so the note must never say otherwise',
    );
    assert.match(notes[0][0], /cannot open/, 'the note names the real consequence');
    assert.ok(commands.has('herdr-gentle:issues'), 'the command is discoverable while the gate is closed');
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
    // S5/S10: the fresh viewer never consults the accumulated session buckets,
    // so `gh issue list --search` is not called at all while it opens; the
    // rows come from cursor pages through the real client's search seam.
    const listSearches = calls
      .filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list')
      .map((call) => call.argv[call.argv.indexOf('--search') + 1]);
    assert.deepEqual(listSearches, [], 'the viewer reads fresh pages, never the cached buckets');
    // S5/D1: the source asks gh for last-update ordering with the EXACT bucket
    // query; Involved excludes the viewer's own issues so the two buckets are
    // disjoint at the source, before any client filter.
    assert.deepEqual(searchQueries(calls), ['author:@me sort:updated-desc'],
      'the mount reads the active bucket fresh with its own exact query');
    const body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues/, 'first page tab');
    assert.match(body, /Assigned/, 'second page tab');
    assert.match(body, /Involved/, 'third page tab');
    assert.match(body, /76/, 'the listed issue number');
    assert.match(body, /chore: update/, 'the listed issue title');
    assert.match(body, /◈ Issues/, 'the header names the surface');
    assert.ok(!/◈ Issues · /.test(body), 'S13: the header never repeats the active tab');
    assert.match(body, /▸ My issues \(\d+\)/, 'the tab row names and marks the active bucket');
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

// S10b: the issues viewer no longer associates a checkout with issues. These
// drive the public command end to end: no association mark or hint renders and
// the removed list keys (`space`, `ctrl+s`) never write, even though the
// command still supplies the old `assigned`/`saveAssignment` options. The
// label editor and comment input keep their own `ctrl+s`, covered by the
// actions describe below.
describe('/herdr-gentle:issues read-only association (S10b)', () => {
  // S8: the registry stores ONE odd path or `null`, never a list.
  function storedRow(root, issues) {
    return { branch: branchOf(root), path: root, thread: 'test-thread', issues, odd: null };
  }

  test('renders no association mark, hint or unsaved claim even with a stored issues[]', async () => {
    const root = makeRepo({ tag: 'issues-readonly' });
    writeRegistry(root, [storedRow(root, [76])]);
    const { component, notes } = await openIssues(root);
    const body = clean(component.render(110).join('\n'));
    const row = body.split('\n').find((line) => line.includes('76'));
    assert.ok(row, 'the stored issue is still listed');
    assert.ok(!/[✓✎]/.test(row), 'no association mark on the row');
    assert.ok(!body.includes('space assign'), 'no Space hint');
    assert.ok(!body.includes('ctrl+s save'), 'no save hint');
    assert.ok(!body.includes('unsaved'), 'no unsaved claim');
    assert.ok(!/\d+ assigned/.test(body), 'no assigned count');
    // The legend is ONE row (S2): at this width, with both edit capabilities
    // confirmed by the detail the fresh mount now reads immediately, it
    // compacts to its short tokens, so `close` rides the final `esc close`.
    assert.match(body, /x\/X/, 'the footer legend stays');
    assert.ok(!body.includes('f open/closed'), 'S10a: the removed state toggle never reaches the legend');
    assert.deepEqual(notes, [], 'reading writes nothing and notifies nothing');
  });

  test('the stored issues[] changes no cell: the frame matches an empty list', async () => {
    const withIssues = makeRepo({ tag: 'issues-readonly-with' });
    writeRegistry(withIssues, [storedRow(withIssues, [76])]);
    const withoutIssues = makeRepo({ tag: 'issues-readonly-without' });
    writeRegistry(withoutIssues, [storedRow(withoutIssues, [])]);
    const first = await openIssues(withIssues);
    const second = await openIssues(withoutIssues);
    assert.equal(
      clean(first.component.render(110).join('\n')),
      clean(second.component.render(110).join('\n')),
      'the stored association renders nothing in either direction',
    );
  });

  test('space and list ctrl+s leave the registry bytes unchanged', async () => {
    const root = makeRepo({ tag: 'issues-readonly-write' });
    const file = writeRegistry(root, [storedRow(root, [76])]);
    const before = readRaw(file);
    const { component } = await openIssues(root);
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(readRaw(file), before, 'the removed keys write nothing to the registry');
  });

  test('with no registry at all, space and ctrl+s create nothing', async () => {
    const root = makeRepo({ tag: 'issues-readonly-nofile' });
    const file = registryFile(root);
    assert.ok(!fs.existsSync(file), 'the fixture starts with no registry');
    const { component } = await openIssues(root);
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(fs.existsSync(file), false, 'no registry row is created by the removed keys');
  });

  test('the viewer still reads, filters and closes with a stored issues[]', async () => {
    const root = makeRepo({ tag: 'issues-readonly-read' });
    writeRegistry(root, [storedRow(root, [76])]);
    const { component, notes } = await openIssues(root);
    assert.match(clean(component.render(110).join('\n')), /76/, 'the issue still lists');
    const beforeF = clean(component.render(110).join('\n'));
    component.handleInput('f');
    await tick();
    assert.equal(component.state.showClosed, undefined, 'S10a: the state toggle does not exist');
    assert.equal(clean(component.render(110).join('\n')), beforeF, 'f repaints nothing');
    component.handleInput('T');
    for (const ch of 'chore') component.handleInput(ch);
    component.handleInput('enter');
    assert.equal(component.state.query, 'chore', 'search still filters');
    component.handleInput('escape');
    assert.deepEqual(notes, [], 'reading and closing notify nothing');
  });
});

describe('/herdr-gentle:issues actions (S3,S4,S10)', () => {
  test('label toggle, create-new, comment, browser and close reach gh with fixed argv', async () => {
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

    component.handleInput('x');
    assert.equal(component.state.mode, 'confirm');
    assert.match(clean(component.render(110).join('\n')), /Confirm close #76/, 'the confirm names the close');
    component.handleInput('enter');
    await tick();
    assert.equal(component.state.mode, 'list');
    assert.ok(!clean(component.render(110).join('\n')).includes('#76'), 'the closed issue leaves the open list at once');
    const close = ghCalls().find((call) => call.argv[1] === 'close');
    assert.ok(close, 'close reaches gh issue close');
    assert.deepEqual(close.argv, ['issue', 'close', '76']);
    assert.equal(ghCalls().some((call) => call.argv[1] === 'reopen'), false, 'the view has no reopen path');

    // The reload brings the fixture's open row back, so X exercises the same
    // close through its own key.
    component.handleInput('r');
    await tick();
    assert.match(clean(component.render(110).join('\n')), /#76/, 'the reload lists the open issue again');
    component.handleInput('X');
    assert.equal(component.state.mode, 'confirm', 'X asks the same close confirmation');
    component.handleInput('enter');
    await tick();
    const closes = ghCalls().filter((call) => call.argv[1] === 'close');
    assert.equal(closes.length, 2, 'X closes too');
    assert.deepEqual(closes[1].argv, ['issue', 'close', '76']);
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
    const graphqlQueryOf = (argv) => {
      const index = argv.indexOf('-f');
      const value = index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1] : '';
      return value.startsWith('query=') ? value.slice('query='.length) : '';
    };
    const runner = async (bin, argv) => {
      calls.push({ bin, argv: argv.slice() });
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        // S5: the viewer's page is the cursor SEARCH seam; the snapshot query
        // still answers the startup prime the assignment data needs.
        if (graphqlQueryOf(argv).includes('type: ISSUE')) return ok(graphqlSearchPage(argv, manyListIssues(n)));
        return ok(graphqlSnapshotOf(argv, manyListIssues(n)));
      }
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

  test('the active bucket names the real total, not the rows one page fetched', async () => {
    const root = makeRepo({ tag: 'issues-totals' });
    const { runner } = makeBoundedRunner(45);
    const { component } = await openIssues(root, { runner });
    let body = clean(component.render(110).join('\n'));
    assert.match(body, /My issues \(45/, 'the tab names the server total, not the first page length');
    // S5: a bucket's total arrives with its own fresh page, so the other tabs
    // name theirs once they are read instead of carrying a primed list.
    component.handleInput('tab');
    await tick();
    body = clean(component.render(110).join('\n'));
    assert.match(body, /Assigned \(45/, 'a bucket read fresh still reports the real total');
    assert.ok(!body.includes('+ issues'), 'the total is never repeated below the list');
  });

  test('a cursor page keeps the server total honest across the whole bucket', async () => {
    const root = makeRepo({ tag: 'issues-trunc' });
    const { runner } = makeBoundedRunner(500);
    const { component } = await openIssues(root, { runner });
    const body = clean(component.render(110).join('\n'));
    // The page carries `issueCount` for the whole bucket, so the tab names 500
    // even though the request itself asked only for a row budget. `+` here
    // means "more pages exist", which is exactly what `hasNextPage` reports.
    assert.match(body, /My issues \(500\+?\)/, 'the tab names the server total for the bucket');
    assert.ok(!/\d+\+ issues/.test(body), 'S13: the bound is never repeated below the list');
  });
});

// ---------------------------------------------------------------------------
// S19/S10a: mount before any network read. Every read asks for `open` — the
// view lists open issues only, so no other state is ever requested.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues first paint and open-only reads', () => {
  test('the overlay mounts before any list or label fetch and reads its first page fresh', async () => {
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
    // S5: the rows come from one fresh cursor page through the client's search
    // seam — the accumulated list API is not part of this path at all.
    const lists = calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    assert.deepEqual(lists, [], 'the fresh viewer never reads the session list cache');
    assert.deepEqual(searchQueries(calls), ['author:@me sort:updated-desc'], 'one fresh page for the bucket on screen');
  });

  test('the removed state key is inert and a reload re-reads the current page', async () => {
    const root = makeRepo({ tag: 'issues-closed' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    const reads = () => searchQueries(calls);
    const primed = reads();
    assert.deepEqual(primed, ['author:@me sort:updated-desc'], 'the mount read the active bucket once');
    const before = clean(component.render(110).join('\n'));
    component.handleInput('f');
    await tick();
    assert.deepEqual(reads(), primed, 'f fetches nothing: no other state is asked for');
    assert.equal(clean(component.render(110).join('\n')), before, 'f repaints nothing');
    component.handleInput('r');
    await tick();
    assert.deepEqual(reads().slice(primed.length), ['author:@me sort:updated-desc'],
      'a reload re-reads the current page fresh');
    assert.equal(calls.some((call) => call.argv.includes('--state')), false,
      'the list API is never asked for any state');
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

  test('mode off: the command exists, assignmentEnabled is false and the save callback refuses with zero writes', async () => {
    await withModeDir(async () => {
      modeLib.writeMode(false, process.env);
      const capture = captureIssuesView();
      try {
        const root = makeRepo({ tag: 'issues-s29-off' });
        const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: null }]);
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
        const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: null }]);
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
        const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: null }]);
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
        writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: null }]);
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
// S8/S16 mounted wiring: the extension must hand the real view real seams
// bound to THIS checkout. The view module is captured instead of mounted, so
// what is asserted is the mounted contract itself: assignable users and the
// issue detail reach the real exported `gh-issues.js` helpers with the
// checkout's cwd (the detail asking for authoritative metadata), and an
// assignee save reaches `editAssignees` with fixed argv while a refused save
// writes nothing.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues mounted wiring (S8,S16)', () => {
  test('assignees, detail metadata and assignee edits reach the real client for this checkout', async () => {
    const root = makeRepo({ tag: 'issues-wiring' });
    const { runner, calls } = makeIssuesRunner();
    const capture = captureIssuesView();
    const seen = { users: [], issue: [], edit: [] };
    const real = {
      users: ghIssues.listAssignableUsers,
      issue: ghIssues.getIssue,
      edit: ghIssues.editAssignees,
    };
    ghIssues.listAssignableUsers = (opts) => { seen.users.push(opts); return real.users(opts); };
    ghIssues.getIssue = (number, opts) => { seen.issue.push({ number, opts }); return real.issue(number, opts); };
    ghIssues.editAssignees = (number, changes, opts) => {
      seen.edit.push({ number, changes, opts });
      return real.edit(number, changes, opts);
    };
    try {
      await openIssues(root, { runner });
      const options = capture.holder.options;
      assert.ok(options, 'the view received its options');
      assert.equal(typeof options.loadAssignees, 'function', 'the view can load assignable users');
      assert.equal(typeof options.actions.editAssignees, 'function', 'the assignee editor has a save action');

      const users = await options.loadAssignees();
      assert.equal(users.ok, true, 'assignable users load');
      assert.deepEqual(users.users.map((user) => user.login), ['jonasotoaguilar', 'octocat']);
      assert.equal(seen.users.length, 1, 'the real listAssignableUsers answered');
      assert.equal(seen.users[0].cwd, root, 'assignable users are scoped to this checkout');
      assert.ok(calls.some((call) => call.argv[0] === 'api' && call.cwd === root),
        'the assignable-user read ran in the checkout');

      const detail = await options.loadIssue(76);
      assert.equal(detail.ok, true);
      assert.equal(seen.issue[0].number, 76);
      assert.equal(seen.issue[0].opts.cwd, root, 'the detail is read in this checkout');
      assert.equal(seen.issue[0].opts.includeMetadata, true, 'the view asks for authoritative metadata');
      assert.deepEqual(detail.issue.permissions, { canEditLabels: true, canEditAssignees: true, canCreateLabels: true },
        'the repository role reaches the view as confirmed capabilities');
      assert.deepEqual(detail.issue.assignees, ['jonasotoaguilar'], 'current assignees reach the preview');

      const saved = await options.actions.editAssignees(76, { add: ['octocat'], remove: [] });
      assert.equal(saved.ok, true, 'a permitted save reports success');
      assert.equal(seen.edit[0].opts.cwd, root);
      const write = calls.find((call) => call.argv[0] === 'issue' && call.argv[1] === 'edit'
        && call.argv.includes('--add-assignee'));
      assert.deepEqual(write.argv, ['issue', 'edit', '76', '--add-assignee', 'octocat'], 'fixed argv, no shell');
      assert.equal(write.cwd, root, 'the write runs in this checkout');

      const readOnly = makeIssuesRunner({ role: 'READ' });
      ghIssues.setGhRunner(readOnly.runner);
      const refused = await options.actions.editAssignees(76, { add: ['octocat'], remove: [] });
      assert.equal(refused.ok, false, 'a read-only role is refused');
      assert.match(refused.error, /permission/i);
      assert.equal(readOnly.calls.filter((call) => call.argv[1] === 'edit').length, 0,
        'a refused save never writes');
    } finally {
      ghIssues.listAssignableUsers = real.users;
      ghIssues.getIssue = real.issue;
      ghIssues.editAssignees = real.edit;
      capture.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// S19/S16: the verifier's page-read probes — the three bucket fetches must
// overlap in wall-clock time, and no read may ask `gh` for `--state all`
// while Involved excludes the authored bucket at the source.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues page fetch parallelism and state honesty', () => {
  test('the mount reads only the bucket it shows, and every bucket reads its own exact query', async () => {
    const root = makeRepo({ tag: 'issues-parallel' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    assert.deepEqual(searchQueries(calls), ['author:@me sort:updated-desc'],
      'one fresh page for the bucket on screen, no eager prefetch of the others');
    component.handleInput('tab');
    await tick();
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
    ], 'selecting a bucket reads its own page fresh');
    component.handleInput('tab');
    await tick();
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'Involved excludes authored issues at the source');
  });

  test('no page read ever uses the list API or widens to all states', async () => {
    const root = makeRepo({ tag: 'issues-state-honest' });
    const { runner, calls } = makeIssuesRunner();
    await openIssues(root, { runner });
    const lists = calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    // S5: with cursor pages there is no session list to prime or merge, so the
    // list API is not part of this path at all.
    assert.deepEqual(lists, [], 'fresh pages never consult the accumulated list cache');
    const graphql = calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql');
    assert.ok(graphql.length > 0, 'the viewer read its page through the client');
    for (const call of graphql) {
      assert.ok(!call.argv.includes('state=all'), `no read widens to all states: ${call.argv.join(' ')}`);
    }
  });
});


describe('S2 feedback: command registration survives a reused module', () => {
  test('each runtime load registers issues even when its module state survives', async () => {
    const { commands, mod } = await loadExtension();
    assert.ok(commands.has('herdr-gentle:issues'));
    const reloaded = new Map();
    const api = {
      registerTool: () => {},
      registerCommand: (name, definition) => reloaded.set(name, definition),
      on: () => () => {},
    };
    mod.default(api);
    assert.ok(reloaded.has('herdr-gentle:issues'), 'reload must not inherit an already-registered flag from the old runtime');
    reloaded.clear();
    mod.default(api);
    assert.ok(reloaded.has('herdr-gentle:issues'), 'a rebuilt registry on the same API must also regain the command');
  });
});

// ---------------------------------------------------------------------------
// S5/D1 mounted seam: the overlay mounts BEFORE any page read, and the loader
// is the real GitHub client called with the exact bucket query, the caller's
// cursor, the viewport row budget and THIS checkout's cwd. Nothing is served
// from a session list, so a repeated request is a repeated read.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues mounted page seam (S5,D1)', () => {
  // Mounts the real view through the command, recording the order of the
  // overlay opening, the view creation and every page read, and keeping the
  // mounted options so a caller can drive the seam directly.
  async function mountCapturing(root, rows = 24) {
    const base = makeIssuesRunner();
    const lib = require('../lib/issues-view.js');
    const realCreate = lib.createIssuesView;
    const realPage = ghIssues.getIssuePage;
    const order = [];
    const pages = [];
    const holder = { options: null };
    ghIssues.getIssuePage = (params, opts) => {
      order.push('page');
      pages.push({ params, opts });
      return realPage(params, opts);
    };
    lib.createIssuesView = (options) => {
      holder.options = options;
      order.push('view');
      return realCreate(options);
    };
    const restore = () => {
      lib.createIssuesView = realCreate;
      ghIssues.getIssuePage = realPage;
    };
    let mounted = null;
    try {
      const { commands, mod, sessionStarts } = await loadExtension();
      ghIssues.setGhRunner(base.runner);
      const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
      await fireSessionStart(sessionStarts, gateCtx(scratch, []));
      mod.setIssuesTuiLoader(async () => stubTui);
      const { ctx } = makeCtx({ cwd: root });
      ctx.ui.custom = async (factory) => {
        order.push('custom');
        mounted = openComponent(factory, makeHostTui(rows));
        return null;
      };
      await commands.get('herdr-gentle:issues').handler('', ctx);
      await tick();
    } catch (err) {
      restore();
      throw err;
    }
    return { order, pages, holder, base, mounted, restore };
  }

  test('the overlay mounts before any page read, with bucket metadata only', async () => {
    const root = makeRepo({ tag: 'issues-order' });
    const run = await mountCapturing(root);
    try {
      assert.equal(run.order[0], 'custom', 'the overlay opens before anything is read');
      assert.deepEqual(run.order.slice(0, 3), ['custom', 'view', 'page'],
        'the view mounts first, and its own mount is what asks for the first page');
      assert.ok(run.mounted, 'the real view mounted');
      const options = run.holder.options;
      assert.deepEqual(options.pages.map((page) => [page.id, page.label, page.issues]), [
        ['mine', 'My issues', null],
        ['assigned', 'Assigned', null],
        ['involved', 'Involved', null],
        ['all', 'All', null],
      ], 'bucket metadata only: no accumulated rows are handed to the view');
      assert.equal(options.loadPages, undefined, 'the cached loader is not passed beside the fresh seam');
      assert.equal(typeof options.loadIssuePage, 'function', 'the fresh page seam is mounted');
      const first = run.pages[0];
      assert.deepEqual(first.params, { query: 'author:@me sort:updated-desc', after: null, first: first.params.first },
        'the mount reads the exact `mine` source query from the first cursor');
      assert.ok(Number.isInteger(first.params.first) && first.params.first >= 1, 'the limit is a row budget');
      assert.equal(first.opts.cwd, root, 'the page read runs in this checkout');
    } finally {
      run.restore();
    }
  });

  test('the loader passes the exact bucket query, cursor, dynamic limit and cwd, and every request is fresh', async () => {
    const root = makeRepo({ tag: 'issues-seam' });
    const narrow = await mountCapturing(root, 24);
    let narrowLimit = null;
    try {
      narrowLimit = narrow.pages[0].params.first;
      const asked = await narrow.holder.options.loadIssuePage({ bucketId: 'assigned', cursor: 'row-3', limit: 7 });
      assert.equal(asked.ok, true, 'the real client answered the page');
      const call = narrow.pages[narrow.pages.length - 1];
      assert.deepEqual(call.params, { query: 'assignee:@me sort:updated-desc', after: 'row-3', first: 7 },
        'the bucket query, the caller cursor and the caller limit pass straight through');
      assert.deepEqual(call.opts, { cwd: root }, 'the page read is scoped to this checkout');

      const before = narrow.pages.length;
      await narrow.holder.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5 });
      await narrow.holder.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5 });
      assert.deepEqual(narrow.pages.slice(before).map((entry) => entry.params), [
        { query: 'involves:@me -author:@me sort:updated-desc', after: null, first: 5 },
        { query: 'involves:@me -author:@me sort:updated-desc', after: null, first: 5 },
      ], 'identical requests read again instead of answering from a cache');

      const subprocesses = narrow.base.calls.length;
      assert.deepEqual(narrow.holder.options.loadIssuePage({ bucketId: 'bogus', cursor: null, limit: 5 }),
        { ok: false, error: 'unknown issues bucket "bogus"' }, 'an unknown bucket fails explicitly');
      assert.equal(narrow.base.calls.length, subprocesses, 'an unknown bucket never runs gh');
      assert.equal(narrow.pages.length, before + 2, 'an unknown bucket never asks for a page');
    } finally {
      narrow.restore();
    }

    const wide = await mountCapturing(root, 60);
    try {
      const wideLimit = wide.pages[0].params.first;
      assert.ok(wideLimit > narrowLimit,
        `the limit follows the viewport row budget: ${narrowLimit} at 24 rows, ${wideLimit} at 60`);
    } finally {
      wide.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// S15/S9 (round 3): the interactive reader has FOUR buckets — the fourth is
// `All`, the whole open repository, and it is deliberately not part of the
// session cache/fallback bucket table. Its search box is a SERVER search, so a
// query rides the page seam instead of filtering the loaded page.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues All bucket and server search query (S15,S9)', () => {
  // The options the command mounts the view with, over the real injected gh.
  async function capturedOptions(root) {
    const base = makeIssuesRunner();
    const capture = captureIssuesView();
    try {
      const { commands, mod, sessionStarts } = await loadExtension();
      ghIssues.setGhRunner(base.runner);
      const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
      await fireSessionStart(sessionStarts, gateCtx(scratch, []));
      mod.setIssuesTuiLoader(async () => stubTui);
      const { ctx } = makeCtx({ cwd: root });
      // The host calls the factory; the captured options live on it.
      ctx.ui.custom = async (factory) => {
        factory(makeHostTui(24).tui, {}, {}, () => {});
        return null;
      };
      await commands.get('herdr-gentle:issues').handler('', ctx);
      assert.ok(capture.holder.options, 'the command mounts the view');
      return { options: capture.holder.options, calls: base.calls, restore: capture.restore };
    } catch (err) {
      capture.restore();
      throw err;
    }
  }

  test('the mounted view carries the fourth All bucket after the three disjoint ones', async () => {
    const root = makeRepo({ tag: 'issues-buckets' });
    const run = await capturedOptions(root);
    try {
      assert.deepEqual(run.options.pages.map((page) => page.id), ['mine', 'assigned', 'involved', 'all'],
        'All is the last interactive bucket');
      assert.equal(run.options.pages[3].label, 'All');
    } finally {
      run.restore();
    }
  });

  test('the All bucket reads every open issue of the repository through the search seam', async () => {
    const root = makeRepo({ tag: 'issues-all' });
    const run = await capturedOptions(root);
    try {
      const before = run.calls.length;
      const asked = await run.options.loadIssuePage({ bucketId: 'all', cursor: null, limit: 5 });
      assert.equal(asked.ok, true, 'the real client answered the All page');
      assert.deepEqual(searchQueries(run.calls.slice(before)), ['sort:updated-desc'],
        'the All search is the whole open repository: the client adds repo/is:issue/is:open, and no bucket query narrows it');
      const rows = JSON.parse(fixture('gh-issue-list.json')).length;
      assert.equal(asked.total, rows, 'the whole open set is the bucket total, never a deduplicated slice');
      assert.equal(asked.issues.length, Math.min(5, rows), 'the caller limit bounds the page');
    } finally {
      run.restore();
    }
  });

  test('a reader query is appended to the scoped bucket search, and an absent one leaves it byte for byte', async () => {
    const root = makeRepo({ tag: 'issues-query' });
    const run = await capturedOptions(root);
    try {
      const before = run.calls.length;
      const asked = await run.options.loadIssuePage({
        bucketId: 'mine', cursor: 'row-2', limit: 7, query: '  label:bug is:open  ',
      });
      assert.equal(asked.ok, true, 'the real client answered the searched page');
      assert.deepEqual(searchQueries(run.calls.slice(before)), ['author:@me sort:updated-desc label:bug is:open'],
        'the bucket scope stays, the typed operators ride along, and nothing is trimmed twice');

      const bare = await run.options.loadIssuePage({ bucketId: 'assigned', cursor: null, limit: 5 });
      assert.equal(bare.ok, true);
      // No `query` field at all: the legacy caller keeps the bare bucket search.
      assert.deepEqual(searchQueries(run.calls.slice(-1)), ['assignee:@me sort:updated-desc'],
        'no query means no extra search text');

      const blank = await run.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 5, query: '   ' });
      assert.equal(blank.ok, true);
      assert.deepEqual(searchQueries(run.calls.slice(-1)), ['involves:@me -author:@me sort:updated-desc'],
        'a blank query is absent, never a trailing space');
    } finally {
      run.restore();
    }
  });

  test('a search that exceeds the GitHub cap is reported, never presented as the whole dataset', async () => {
    const root = makeRepo({ tag: 'issues-cap' });
    const run = await capturedOptions(root);
    const original = ghIssues.getIssuePage;
    const capped = {
      ok: false,
      error: 'GitHub issue search exceeds 1000 matches; narrow the filter',
      truncated: true,
    };
    ghIssues.getIssuePage = () => capped;
    try {
      const asked = await run.options.loadIssuePage({ bucketId: 'all', cursor: null, limit: 10, query: 'is:open' });
      assert.deepEqual(asked, capped, 'the client error passes through unchanged: no rows, no invented total');
    } finally {
      ghIssues.getIssuePage = original;
      run.restore();
    }
  });

  test('the fourth tab is reachable and lists the whole open set, with no snapshot re-prime', async () => {
    const root = makeRepo({ tag: 'issues-all-render' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    const rows = JSON.parse(fixture('gh-issue-list.json')).length;
    const frame = () => clean(component.render(110).join('\n'));
    assert.match(frame(), /▸ My issues/);
    component.handleInput('tab');
    component.handleInput('tab');
    component.handleInput('tab');
    await tick();
    assert.equal(component.state.page, 3, 'All is the fourth tab');
    assert.deepEqual(searchQueries(calls).slice(-1), ['sort:updated-desc'], 'All read the whole open set');
    assert.match(frame(), new RegExp(`All \\(${rows}\\)`), 'the All tab names the whole open count');
    const snapshots = calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql'
      && call.argv.some((entry) => entry.includes('issues(states: OPEN')));
    assert.deepEqual(snapshots, [], 'the interactive reader never re-primes the session snapshot');
  });
});
