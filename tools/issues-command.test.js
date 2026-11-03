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
// A write resolves the checkout's scope FRESH before it runs (S5), so a write
// settles a few git probes later than a read. Poll the observable state instead
// of assuming one macrotask is enough.
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
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

// The `-F name=value` / `-f name=value` field a graphql call carried.
function graphqlField(argv, name, flag = '-F') {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag && argv[index + 1].startsWith(`${name}=`)) return argv[index + 1].slice(name.length + 1);
  }
  return null;
}

// One issue node, in the shape both GraphQL page queries ask for. Test rows are
// synthesized, so these are exactly the fields `normalizeIssue` reads.
function graphqlIssueNode(row) {
  return {
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
  };
}

// The cursor-paged SEARCH snapshot the fresh viewer reads through
// `getIssuePage` (S5/D1): every edge carries its own opaque cursor, so a
// caller resumes after the last row it actually showed.
function graphqlSearchPage(argv, rows) {
  const first = Number(graphqlField(argv, 'first'));
  const after = graphqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('row-', '')) + 1;
  const page = rows.slice(start, start + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      search: {
        issueCount: rows.length,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `row-${start + page.length - 1}` : null },
        edges: page.map((row, at) => ({ cursor: `row-${start + at}`, node: graphqlIssueNode(row) })),
      },
    },
  });
}

// The cursor-paged CONNECTION snapshot the unfiltered `All` bucket reads
// (T2/S2): `totalCount` is the server's exact count, `pageInfo` says whether
// the walk continues, and EVERY edge carries its own cursor, so the reader
// resumes after the last row it showed with no 1000-match search ceiling.
function graphqlConnectionPage(argv, rows) {
  const first = Number(graphqlField(argv, 'first'));
  const after = graphqlField(argv, 'cursor');
  const start = after === null ? 0 : Number(String(after).replace('conn-', '')) + 1;
  const page = rows.slice(start, start + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = start + page.length < rows.length;
  return JSON.stringify({
    data: {
      repository: {
        issues: {
          totalCount: rows.length,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? `conn-${start + page.length - 1}` : null },
          edges: page.map((row, at) => ({ cursor: `conn-${start + at}`, node: graphqlIssueNode(row) })),
        },
      },
    },
  });
}

// Every call that read the repository issue CONNECTION — the `All` bucket's
// source. A search call is not one of them: only the connection query carries a
// `states: [...]` literal and per-edge cursors, which is what makes the 1000
// match ceiling inapplicable.
function connectionReads(calls) {
  return calls
    .filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')
    .map((call) => ({
      query: graphqlField(call.argv, 'query', '-f') || '',
      first: graphqlField(call.argv, 'first'),
      cursor: graphqlField(call.argv, 'cursor'),
      argv: call.argv,
    }))
    .filter((read) => read.query.includes('issues(states: [') && read.query.includes('edges { cursor node'));
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
//
// `connectionRows` is what the unfiltered `All` bucket's issue CONNECTION
// answers with (T2/S2); it defaults to the same fixture rows, so a test only
// passes it to model a repository large enough to cross the search cap.
function makeIssuesRunner({ failComment = false, role = 'WRITE', connectionRows = null } = {}) {
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
      // T2/S2: the unfiltered `All` bucket asks the repository's issue
      // CONNECTION (edges with per-edge cursors), never the capped search.
      if (query.includes('edges { cursor node')) return ok(graphqlConnectionPage(argv, connectionRows || rows));
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

// The options the command mounts the real view with, over the real injected
// `gh`, while every client call the extension makes stays real and injectable.
// `calls` is the injected runner's own call log; `connectionRows` (T2/S2) is
// what the unfiltered `All` bucket's issue connection answers with.
async function capturedIssuesOptions(root, options = {}) {
  const injected = options.runner
    ? { runner: options.runner, calls: options.calls || [] }
    : makeIssuesRunner(options);
  const capture = captureIssuesView();
  try {
    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(injected.runner);
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
    await tick();
    assert.ok(capture.holder.options, 'the command mounts the view');
    return { options: capture.holder.options, calls: injected.calls, restore: capture.restore };
  } catch (err) {
    capture.restore();
    throw err;
  }
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
    // disjoint at the source, before any client filter. T2/S2: `All` is the
    // fourth tab's repository CONNECTION, which takes no search text at all.
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ],
      'the mount reads every scoped tab once with its own exact query');
    assert.equal(connectionReads(calls).length, 1, 'the All tab is read once through the issue connection');
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
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'a successful label apply closes the editor');
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
    assert.ok(await waitFor(() => ghCalls().some((call) => call.argv[1] === 'create')), 'a new label reaches gh label create');
    const create = ghCalls().find((call) => call.argv[1] === 'create');
    assert.ok(create, 'a new label reaches gh label create');
    assert.deepEqual(create.argv.slice(0, 3), ['label', 'create', 'triage']);
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'creating a label applies and closes the editor');

    component.handleInput('c');
    assert.equal(component.state.mode, 'comment');
    for (const ch of 'hi') component.handleInput(ch);
    component.handleInput('ctrl+s');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'a posted comment closes the input');
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
    // B1: the opener binds the identity the rows came from (here gh's own
    // answer for a checkout with no fork remote), never a fresh resolution.
    assert.deepEqual(gitCalls[0].argv,
      ['issue', 'view', '76', '--web', '-R', 'github.com/jonasotoaguilar/herdr-gentle-shell']);
    assert.ok(!gitCalls[0].argv.join(' ').includes('xdg-open'), 'never an invented opener');

    component.handleInput('x');
    assert.equal(component.state.mode, 'confirm');
    assert.match(clean(component.render(110).join('\n')), /Confirm close #76/, 'the confirm names the close');
    component.handleInput('enter');
    assert.ok(await waitFor(() => component.state.mode === 'list'), 'the close settles');
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
    assert.ok(await waitFor(() => ghCalls().filter((call) => call.argv[1] === 'close').length === 2), 'X closes too');
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
    assert.ok(await waitFor(() => calls.some((call) => call.argv[1] === 'comment')), 'the comment reached gh');
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
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'one fresh page per scoped tab at open');
    assert.equal(connectionReads(calls).length, 1, 'the All tab opened through the repository connection');
  });

  test('the removed state key is inert and a reload re-reads the current page', async () => {
    const root = makeRepo({ tag: 'issues-closed' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    const reads = () => searchQueries(calls);
    const primed = reads();
    assert.deepEqual(primed, [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'the mount read every scoped bucket once');
    const connectionsAtMount = connectionReads(calls).length;
    assert.equal(connectionsAtMount, 1, 'and the All bucket once, through the connection');
    const before = clean(component.render(110).join('\n'));
    component.handleInput('f');
    await tick();
    assert.deepEqual(reads(), primed, 'f fetches nothing: no other state is asked for');
    assert.equal(clean(component.render(110).join('\n')), before, 'f repaints nothing');
    component.handleInput('r');
    await tick();
    assert.deepEqual(reads().slice(primed.length), ['author:@me sort:updated-desc'],
      'a reload re-reads the current page fresh');
    assert.equal(connectionReads(calls).length, connectionsAtMount,
      'the reload left the All connection page alone');
    assert.equal(calls.some((call) => call.argv.includes('--state')), false,
      'the list API is never asked for any state');
  });
});

// ---------------------------------------------------------------------------
// S1: the issues reader associates nothing with the checkout. The command hands
// the view NO `assigned`, NO `saveAssignment` and NO `assignmentEnabled` — the
// association was removed from the product, not merely gated — so opening the
// reader performs zero registry writes in every worktree-mode state.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues never reads or writes an association (S1)', () => {
  const modeLib = require('../lib/worktree-mode.js');

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

  function assertNoAssociationOptions(options) {
    for (const key of ['assigned', 'assignedOdd', 'saveAssignment', 'assignmentEnabled']) {
      assert.equal(key in options, false, `the view is handed no ${key}: ${JSON.stringify(Object.keys(options))}`);
    }
  }

  async function openWithStoredIssues(tag) {
    const root = makeRepo({ tag });
    const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: null }]);
    const before = readRaw(file);
    const { runner } = makeIssuesRunner();
    const capture = captureIssuesView();
    try {
      const { commands } = await openIssues(root, { runner });
      assert.ok(commands.has('herdr-gentle:issues'), 'the command stays registered');
      assert.ok(capture.holder.options, 'the view was constructed');
      assertNoAssociationOptions(capture.holder.options);
    } finally {
      capture.restore();
    }
    assert.equal(readRaw(file), before, 'reading writes nothing to the registry');
  }

  test('mode off: no association option and no registry write', async () => {
    await withModeDir(async () => {
      modeLib.writeMode(false, process.env);
      await openWithStoredIssues('issues-s1-off');
    });
  });

  test('malformed mode: no association option and no registry write', async () => {
    await withModeDir(async () => {
      await openWithStoredIssues('issues-s1-malformed');
    }, { malformed: true });
  });

  test('mode enabled and then switched off: still no association option and no write', async () => {
    await withModeDir(async () => {
      modeLib.writeMode(true, process.env);
      const root = makeRepo({ tag: 'issues-s1-on' });
      const file = writeRegistry(root, [{ branch: branchOf(root), path: root, thread: 't', issues: [76], odd: null }]);
      const before = readRaw(file);
      const { runner } = makeIssuesRunner();
      const capture = captureIssuesView();
      try {
        await openIssues(root, { runner });
        assertNoAssociationOptions(capture.holder.options);
        modeLib.writeMode(false, process.env);
        assertNoAssociationOptions(capture.holder.options);
      } finally {
        capture.restore();
      }
      assert.equal(readRaw(file), before, 'neither state writes the registry');
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
  test('the mount reads every tab once, each with its own exact query, and a switch reads nothing', async () => {
    const root = makeRepo({ tag: 'issues-parallel' });
    const { runner, calls } = makeIssuesRunner();
    const { component } = await openIssues(root, { runner });
    await tick();
    // Round 3: the mount reads ALL FOUR tabs once — a tab that was never
    // visited showed `(0)` for issues the repository does have. T2/S2: the
    // fourth tab is the repository connection, never a search.
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'every scoped tab is read once at open, each with its own exact query');
    assert.equal(connectionReads(calls).length, 1, 'and the All tab through the issue connection');
    component.handleInput('tab');
    await tick();
    component.handleInput('tab');
    await tick();
    component.handleInput('tab');
    await tick();
    assert.deepEqual(searchQueries(calls), [
      'author:@me sort:updated-desc',
      'assignee:@me sort:updated-desc',
      'involves:@me -author:@me sort:updated-desc',
    ], 'switching tabs reads nothing again');
    assert.equal(connectionReads(calls).length, 1, 'switching to All reads nothing again either');
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
      assert.deepEqual(call.opts, { cwd: root, scope: 'github.com/jonasotoaguilar/herdr-gentle-shell' },
        'the page read is scoped to this checkout and bound to the host-qualified pinned identity');

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
  test('the mounted view carries the fourth All bucket after the three disjoint ones', async () => {
    const root = makeRepo({ tag: 'issues-buckets' });
    const run = await capturedIssuesOptions(root);
    try {
      assert.deepEqual(run.options.pages.map((page) => page.id), ['mine', 'assigned', 'involved', 'all'],
        'All is the last interactive bucket');
      assert.equal(run.options.pages[3].label, 'All');
    } finally {
      run.restore();
    }
  });

  test('the All bucket reads every open issue through the repository connection, not the capped search', async () => {
    const root = makeRepo({ tag: 'issues-all' });
    const run = await capturedIssuesOptions(root);
    try {
      const before = run.calls.length;
      const asked = await run.options.loadIssuePage({ bucketId: 'all', cursor: null, limit: 5 });
      assert.equal(asked.ok, true, 'the real client answered the All page');
      const reads = connectionReads(run.calls.slice(before));
      assert.equal(reads.length, 1, 'one connection read answered the All bucket');
      assert.deepEqual(searchQueries(run.calls.slice(before)), [], 'the All bucket never used the search API');
      assert.equal(reads[0].cursor, null, 'a head read starts the connection at its first row');
      assert.equal(reads[0].first, '5', 'the caller limit bounds the connection page');
      assert.match(reads[0].query, /issues\(states: \[OPEN\], first: \$first, after: \$cursor/,
        'only open issues are requested, and the connection cursor is explicit');
      assert.match(reads[0].query, /orderBy: \{field: UPDATED_AT, direction: DESC\}/,
        'the ordering belongs to the query, so no search text has to carry it');
      assert.match(reads[0].query, /totalCount/, 'the exact total comes from the connection');
      assert.ok(!reads[0].query.includes('search('), 'never the 1000-match search API');
      assert.ok(!reads[0].argv.some((entry) => entry.startsWith('search=')),
        'no search text reaches the connection');
      assert.ok(!reads[0].argv.some((entry) => entry.includes('sort:updated-desc')),
        'the builtin ordering is never forwarded as search text');
      const rows = JSON.parse(fixture('gh-issue-list.json')).length;
      assert.equal(asked.total, rows, 'the whole open set is the bucket total, never a deduplicated slice');
      for (const issue of asked.issues) assert.equal(typeof issue.cursor, 'string', 'every row keeps its own cursor');
      assert.equal(asked.issues.length, Math.min(5, rows), 'the caller limit bounds the page');
    } finally {
      run.restore();
    }
  });

  test('a reader query is appended to the scoped bucket search, and an absent one leaves it byte for byte', async () => {
    const root = makeRepo({ tag: 'issues-query' });
    const run = await capturedIssuesOptions(root);
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
    const run = await capturedIssuesOptions(root);
    const original = ghIssues.getIssuePage;
    const realConnection = ghIssues.getIssueConnectionPage;
    const capped = {
      ok: false,
      error: 'GitHub issue search exceeds 1000 matches; narrow the filter',
      truncated: true,
    };
    let connectionCalls = 0;
    ghIssues.getIssueConnectionPage = (...args) => {
      connectionCalls += 1;
      return realConnection(...args);
    };
    ghIssues.getIssuePage = () => capped;
    try {
      const connectionCallsBefore = connectionCalls;
      const asked = await run.options.loadIssuePage({ bucketId: 'all', cursor: null, limit: 10, query: 'is:open' });
      assert.deepEqual(asked, capped, 'the client error passes through unchanged: no rows, no invented total');
      assert.equal(connectionCalls, connectionCallsBefore,
        'a typed All query stays on the search API: the connection takes no search text');
      const involved = await run.options.loadIssuePage({ bucketId: 'involved', cursor: null, limit: 10 });
      assert.deepEqual(involved, capped, 'Involved is a capped search too, and says so');
    } finally {
      ghIssues.getIssuePage = original;
      ghIssues.getIssueConnectionPage = realConnection;
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
    const reads = connectionReads(calls);
    assert.equal(reads.length, 1, 'All read the whole open set once, through the connection');
    assert.equal(reads[0].cursor, null, 'from the head of the connection');
    assert.match(frame(), new RegExp(`All \\(${rows}\\)`), 'the All tab names the whole open count');
    const snapshots = calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql'
      && call.argv.some((entry) => entry.includes('issues(states: OPEN')));
    assert.deepEqual(snapshots, [], 'the interactive reader never re-primes the session snapshot');
  });
});

// ---------------------------------------------------------------------------
// T2 (S2): the unfiltered `All` bucket reads the repository's own issue
// CONNECTION — cursor-paged to its end with an exact `totalCount` — while a
// TYPED search and the three scoped buckets stay on the search API, whose
// 1000-match cap is reported instead of being shown as a complete list. The
// connection is a fresh read, never the session's cached open snapshot.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues All connection paging (T2,S2)', () => {
  function syntheticIssues(count, from = 1) {
    return Array.from({ length: count }, (_, at) => {
      const number = from + at;
      return {
        number,
        title: `synthetic issue ${number}`,
        state: 'OPEN',
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
        url: `https://github.com/o/r/issues/${number}`,
      };
    });
  }

  test('more than 1000 open issues page to the end through the All bucket', async () => {
    const root = makeRepo({ tag: 'issues-all-1200' });
    const total = 1200;
    const run = await capturedIssuesOptions(root, { connectionRows: syntheticIssues(total) });
    try {
      const before = run.calls.length;
      const seen = [];
      let cursor = null;
      let pages = 0;
      for (;;) {
        const page = await run.options.loadIssuePage({ bucketId: 'all', cursor, limit: 100 });
        assert.equal(page.ok, true, `page ${pages + 1} loaded: ${page.error || ''}`);
        assert.equal(page.total, total, 'every page reports the exact server total');
        assert.ok(page.issues.length > 0, 'a page never comes back empty mid-walk');
        // Continue after the LAST row this page actually showed.
        cursor = page.issues[page.issues.length - 1].cursor;
        seen.push(...page.issues.map((issue) => issue.number));
        pages += 1;
        if (page.hasNextPage !== true) break;
        assert.ok(pages <= 12, 'the walk ends: 1200 rows at 100 per page is 12 pages');
      }
      assert.equal(pages, 12, 'exactly the pages the 1200 rows need');
      assert.deepEqual(seen, syntheticIssues(total).map((row) => row.number),
        'every open issue arrives once, in order, crossing the 1000-match search boundary');
      const reads = connectionReads(run.calls.slice(before));
      assert.equal(reads.length, 12, 'every page was a connection read');
      assert.equal(reads[0].cursor, null, 'the walk started at the head');
      assert.equal(reads[1].cursor, 'conn-99', 'each continuation resumes after the last row shown');
      assert.deepEqual(searchQueries(run.calls.slice(before)), [], 'no page read the capped search');
    } finally {
      run.restore();
    }
  });

  test('a typed All query stays on the search API with the bucket ordering', async () => {
    const root = makeRepo({ tag: 'issues-all-typed' });
    const run = await capturedIssuesOptions(root);
    const realConnection = ghIssues.getIssueConnectionPage;
    let connectionCalls = 0;
    ghIssues.getIssueConnectionPage = (...args) => {
      connectionCalls += 1;
      return realConnection(...args);
    };
    try {
      const mounted = connectionCalls;
      const before = run.calls.length;
      const typed = await run.options.loadIssuePage({ bucketId: 'all', cursor: 'row-2', limit: 4, query: '  label:bug  ' });
      assert.equal(typed.ok, true, 'the typed All search answered');
      assert.deepEqual(searchQueries(run.calls.slice(before)), ['sort:updated-desc label:bug'],
        'a typed query keeps the bucket ordering and rides the search API');
      assert.equal(connectionCalls, mounted, 'a typed query never reaches the connection, which takes no search text');
    } finally {
      ghIssues.getIssueConnectionPage = realConnection;
      run.restore();
    }
  });

  test('the All connection is a fresh read, separate from the cached open snapshot', async () => {
    const root = makeRepo({ tag: 'issues-all-fresh' });
    const total = 1200;
    const { runner, calls } = makeIssuesRunner({ connectionRows: syntheticIssues(total) });
    // The gate runs in the REAL checkout so the session's open-issue snapshot
    // is primed beside the viewer, which is the pair this test keeps apart.
    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(runner);
    await fireSessionStart(sessionStarts, gateCtx(root, []));
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx } = makeCtx({ cwd: root });
    let factory = null;
    ctx.ui.custom = async (captured) => { factory = captured; return null; };
    await commands.get('herdr-gentle:issues').handler('', ctx);
    assert.ok(factory, 'the overlay opens');
    const { component } = openComponent(factory, makeHostTui(24));
    await tick();
    const frame = () => clean(component.render(110).join('\n'));
    // The session snapshot holds the ONE fixture open issue; the All tab shows
    // the connection's exact count, so no cached bucket answered that tab. A
    // page from a longer walk is a lower bound (`N+`), never a claimed total.
    assert.ok(frame().includes(`All (${total}+)`), 'the All count is the connection count, as a lower bound of the page read');
    const snapshotReads = calls.filter((call) => {
      const query = graphqlField(call.argv, 'query', '-f') || '';
      return query.includes('issues(states: OPEN') && !query.includes('edges');
    });
    assert.ok(snapshotReads.length >= 1, 'the session snapshot is primed separately for assignment evidence');
    const cacheLists = calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'list');
    for (const call of cacheLists) {
      assert.equal(call.argv[call.argv.indexOf('--state') + 1], 'all',
        `the snapshot's own margin is the only list read: ${call.argv.join(' ')}`);
      assert.ok(!/@me/.test(call.argv.join(' ')),
        `no cached bucket answers a viewer page: ${call.argv.join(' ')}`);
    }
    const mounted = connectionReads(calls).length;
    assert.ok(mounted >= 1, 'the mount read the All bucket through the connection');
    component.handleInput('tab');
    await tick();
    component.handleInput('tab');
    await tick();
    component.handleInput('tab');
    await tick();
    assert.equal(component.state.page, 3, 'the All tab is active');
    assert.equal(connectionReads(calls).length, mounted, 'switching to All reuses the page it already read');
    component.handleInput('r');
    await tick();
    assert.equal(connectionReads(calls).length, mounted + 1, '`r` refreshes All through the connection, not a cache');
    assert.ok(frame().includes(`All (${total}+)`), 'the refreshed count is still the connection count');
  });

  test('a client without the connection reader fails loudly instead of falling back to the capped search', async () => {
    const root = makeRepo({ tag: 'issues-all-no-reader' });
    const run = await capturedIssuesOptions(root);
    const realConnection = ghIssues.getIssueConnectionPage;
    const realPage = ghIssues.getIssuePage;
    let searchCalls = 0;
    ghIssues.getIssueConnectionPage = undefined;
    ghIssues.getIssuePage = (...args) => {
      searchCalls += 1;
      return realPage(...args);
    };
    try {
      const asked = await run.options.loadIssuePage({ bucketId: 'all', cursor: null, limit: 5 });
      assert.equal(asked.ok, false, 'the All read fails instead of silently capping the list');
      assert.match(asked.error, /no unfiltered issue connection reader/);
      assert.equal(searchCalls, 0, 'a capped search never stands in for the complete connection');
    } finally {
      ghIssues.getIssueConnectionPage = realConnection;
      ghIssues.getIssuePage = realPage;
      run.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// S5: a fork checkout configures `origin` (the fork) and `upstream` (the
// original). `gh repo view` answers the BASE — the original — for exactly that
// layout (verified against gh 2.102.1), which is why all four tabs used to list
// the original's issues. Every read and the browser opener now scope to the
// checkout's OWN repository, while a checkout with one remote is unchanged.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues fork scope (S5)', () => {
  const forkRoots = [];
  after(() => {
    for (const dir of forkRoots) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A real checkout whose remotes model the fork; the default branch is the
  // current one, exactly like a cloned fork.
  function makeForkRepo({ tag = 'issues-fork', remotes = [['origin', 'myfork/project'], ['upstream', 'original/project']] } = {}) {
    const root = makeRepo({ tag });
    forkRoots.push(root);
    // A bare `owner/name` becomes a GitHub URL; a full URL or a local path is
    // used verbatim, so a case can model a non-GitHub remote.
    for (const [name, repo] of remotes) {
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || repo.includes(':') || repo.startsWith('/')
        ? repo
        : `git@github.com:${repo}.git`;
      git(root, ['remote', 'add', name, url]);
    }
    return root;
  }

  // gh's own answers: `repo view` resolves the BASE repository for a fork
  // layout, every repo-scoped command follows GH_REPO. The call log records
  // which repository each call actually targeted.
  function forkRunner({ repoView = 'original/project' } = {}) {
    const base = makeIssuesRunner();
    const runner = async (bin, argv, opts) => {
      const env = (opts && opts.env) || {};
      const repo = typeof env.GH_REPO === 'string' && env.GH_REPO !== '' ? env.GH_REPO : repoView;
      base.calls.push({ bin, argv: argv.slice(), cwd: opts ? opts.cwd : undefined, repo });
      if (argv[0] === 'repo' && argv[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: repoView }), stderr: '', error: null };
      }
      // The shared fixture runner appends its own record; drop it so the log
      // this test reads holds exactly one row per call.
      const before = base.calls.length;
      const out = await base.runner(bin, argv, opts);
      base.calls.length = before;
      return out;
    };
    return { runner, calls: base.calls };
  }

  // The `repo:` scope every search read asked for, verbatim.
  function searchScopes(calls) {
    return calls
      .flatMap((call) => call.argv)
      .filter((value) => value.startsWith('search=repo:'))
      .map((value) => value.slice('search=repo:'.length).split(' ')[0]);
  }

  function graphqlValue(call, name) {
    for (let at = 0; at < call.argv.length - 1; at += 1) {
      if (call.argv[at] === '-F' && call.argv[at + 1].startsWith(`${name}=`)) {
        return call.argv[at + 1].slice(name.length + 1);
      }
    }
    return null;
  }

  test('every tab, the detail, labels and assignees read the checkout fork, not the base gh resolves', async () => {
    const root = makeForkRepo();
    const gh = forkRunner();
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      const before = gh.calls.length;
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, true, `the ${bucketId} tab answered`);
      }
      const reads = gh.calls.slice(before);
      assert.deepEqual(
        searchScopes(reads.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')),
        ['myfork/project', 'myfork/project', 'myfork/project'],
        'each scoped tab searches the fork, never the upstream',
      );
      for (const read of connectionReads(reads)) {
        assert.equal(graphqlValue(read, 'owner'), 'myfork', 'the All tab walks the fork issue connection');
        assert.equal(graphqlValue(read, 'name'), 'project');
      }
      assert.ok(!reads.some((call) => call.argv.some((value) => value.includes('original/project'))),
        'no tab read carries the upstream repository');

      const scopedBefore = gh.calls.length;
      assert.equal((await run.options.loadIssue(76)).ok, true, 'the detail opened through the real client');
      assert.equal((await run.options.loadLabels()).ok, true);
      assert.equal((await run.options.loadAssignees()).ok, true);
      const scoped = gh.calls.slice(scopedBefore);
      assert.ok(scoped.length >= 3, 'the detail, label and assignee reads ran');
      for (const call of scoped) {
        assert.equal(call.repo, 'github.com/myfork/project',
          `the read is scoped to the fork, host included (${call.argv.join(' ')})`);
      }
    } finally {
      run.restore();
    }
  });

  test('the browser opener opens the fork issue, not the upstream issue with the same number', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-open' });
    const gh = forkRunner();
    const log = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gh-bin-'))), 'argv.log');
    const stub = path.join(path.dirname(log), 'gh-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, 0o755);
    const savedBin = process.env.GH_BIN_PATH;
    process.env.GH_BIN_PATH = stub;
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      const opened = run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener ran through the fixed-argv runner');
      const argv = fs.readFileSync(log, 'utf8').trim();
      assert.equal(argv, 'issue view 76 --web -R github.com/myfork/project',
        'the browser opens the checkout fork issue on the fork server, scoped explicitly');
    } finally {
      run.restore();
      if (savedBin === undefined) delete process.env.GH_BIN_PATH;
      else process.env.GH_BIN_PATH = savedBin;
    }
  });

  test('a single-remote checkout binds the opener to the repository gh resolves', async () => {
    const root = makeForkRepo({ tag: 'issues-nofork', remotes: [['origin', 'myfork/project']] });
    const gh = forkRunner({ repoView: 'myfork/project' });
    const log = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gh-bin-'))), 'argv.log');
    const stub = path.join(path.dirname(log), 'gh-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, 0o755);
    const savedBin = process.env.GH_BIN_PATH;
    process.env.GH_BIN_PATH = stub;
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      assert.equal(run.options.actions.openBrowser(76).ok, true);
      assert.equal(fs.readFileSync(log, 'utf8').trim(), 'issue view 76 --web -R github.com/myfork/project',
        'the opener binds the one repository gh resolved for this checkout, host included');
    } finally {
      run.restore();
      if (savedBin === undefined) delete process.env.GH_BIN_PATH;
      else process.env.GH_BIN_PATH = savedBin;
    }
  });

  // The checkout's own remote cannot be proven to be a GitHub repository:
  // every tab read, the detail/label reads and the browser opener must refuse
  // WITHOUT running gh, so no read or write can land on another repository.
  test('a non-GitHub checkout remote fails every read and the opener without running gh', async () => {
    const root = makeForkRepo({
      tag: 'issues-fork-local',
      remotes: [['origin', 'file:///srv/mirror/project.git'], ['upstream', 'original/project']],
    });
    const gh = forkRunner();
    const log = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gh-bin-'))), 'argv.log');
    const stub = path.join(path.dirname(log), 'gh-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, 0o755);
    const savedBin = process.env.GH_BIN_PATH;
    process.env.GH_BIN_PATH = stub;
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, false, `the ${bucketId} tab is refused`);
        assert.match(asked.error, /checkout remote "origin" is a local path, not a GitHub repository/);
      }
      const labels = await run.options.loadLabels();
      assert.equal(labels.ok, false, 'the label editor read is refused');
      assert.match(labels.error, /is a local path, not a GitHub repository/);
      const opened = run.options.actions.openBrowser(76);
      assert.equal(opened.ok, false, 'the opener refuses instead of opening another repository');
      assert.match(opened.error, /is a local path, not a GitHub repository/);
      assert.equal(fs.existsSync(log), false, 'the browser opener never ran gh');
      assert.ok(gh.calls.every((call) => call.cwd !== root),
        'no gh command ran in this checkout at all');
    } finally {
      run.restore();
      if (savedBin === undefined) delete process.env.GH_BIN_PATH;
      else process.env.GH_BIN_PATH = savedBin;
    }
  });

  // B1: once the list is loaded from a repository, the SAME issue numbers
  // belong to that repository. If the checkout's remote moves, an action must
  // refuse (the displayed issue cannot be sent to another repo), and reads keep
  // the loaded identity — no silent re-target.
  test('after the remote moves, every action refuses and reads keep the displayed repository', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-drift' });
    const gh = forkRunner();
    const log = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gh-bin-'))), 'argv.log');
    const stub = path.join(path.dirname(log), 'gh-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, 0o755);
    const savedBin = process.env.GH_BIN_PATH;
    process.env.GH_BIN_PATH = stub;
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      // Before the move the action binds the displayed repository.
      const bound = await run.options.actions.postComment(76, 'bound');
      assert.equal(bound.ok, true, 'a write before the move succeeds');
      const boundCall = gh.calls.filter((call) => call.argv[0] === 'issue' && call.argv[1] === 'comment').pop();
      assert.equal(boundCall.repo, 'github.com/myfork/project', 'and it binds the displayed repository');

      // The list was loaded from myfork/project; the checkout now points at a
      // different fork where the same number is a different issue.
      git(root, ['remote', 'set-url', 'origin', 'git@github.com:otherfork/project.git']);
      const before = gh.calls.length;

      const comment = await run.options.actions.postComment(76, 'hello');
      assert.equal(comment.ok, false, 'the comment is refused');
      assert.match(comment.error, /changed since this issue list loaded/);
      const labels = await run.options.actions.editLabels(76, ['bug'], [], []);
      assert.equal(labels.ok, false, 'the label edit is refused');
      const state = await run.options.actions.setState(76, 'closed');
      assert.equal(state.ok, false, 'the close is refused');
      const assign = await run.options.actions.editAssignees(76, { add: ['bob'], remove: [] });
      assert.equal(assign.ok, false, 'the assignee edit is refused');
      const opened = run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener still opens the repository the rows came from');
      assert.equal(fs.readFileSync(log, 'utf8').trim(), 'issue view 76 --web -R github.com/myfork/project',
        'the browser opens the displayed repository, never the one the checkout resolves to now');

      const mutations = gh.calls.slice(before).filter((call) => call.argv[0] === 'issue'
        && ['edit', 'comment', 'close', 'reopen'].includes(call.argv[1]));
      assert.deepEqual(mutations, [], 'no mutating gh command ran after the drift');
      assert.ok(!gh.calls.slice(before).some((call) => call.argv[0] === 'label' && call.argv[1] === 'create'),
        'no label was created on the new fork');

      // Reads stay bound to the repository whose rows are on screen.
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, true, `the ${bucketId} tab still reads the loaded repository`);
      }
      const readOpen = await run.options.actions.reload({ state: 'open' });
      assert.equal(readOpen.ok, true, 'the open reload still reads the loaded repository');
      const readClosed = await run.options.actions.reload({ state: 'closed' });
      assert.equal(readClosed.ok, true, 'the closed reload still reads the loaded repository');

      const reads = gh.calls.slice(before);
      assert.ok(reads.some((call) => call.argv.some((value) => value.includes('repo:myfork/project'))),
        'the reads carry the displayed repository');
      assert.ok(reads.every((call) => call.repo === 'github.com/myfork/project'
        || call.repo === 'github.com/original/project'),
      'no read follows the moved remote');
      assert.ok(!reads.some((call) => call.repo === 'github.com/otherfork/project'),
        'nothing reached the new fork');
    } finally {
      run.restore();
      if (savedBin === undefined) delete process.env.GH_BIN_PATH;
      else process.env.GH_BIN_PATH = savedBin;
    }
  });

  // B2: a config read that exits nonzero because the configuration is corrupt
  // or unreadable is NOT "no repository". The command refuses to open, and a
  // checkout whose config breaks while the reader is open refuses every action.
  test('a corrupt checkout configuration refuses to open the viewer', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-corrupt-open' });
    fs.appendFileSync(path.join(root, '.git', 'config'), '\n[broken\n');
    const gh = forkRunner();
    const { commands, mod, sessionStarts } = await loadExtension();
    ghIssues.setGhRunner(gh.runner);
    const scratch = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gate-')));
    await fireSessionStart(sessionStarts, gateCtx(scratch, []));
    const def = commands.get('herdr-gentle:issues');
    assert.ok(def, 'the command stays registered');
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await def.handler('', ctx);
    assert.equal(customs.length, 0, 'the viewer never opens on an unreadable configuration');
    assert.ok(notes.length > 0, 'the refusal is reported');
    assert.match(notes[0][0], /not a git repository/, 'the checkout cannot be resolved, so nothing runs');
    assert.ok(gh.calls.every((call) => call.cwd !== root), 'no gh command ran in this checkout');
  });

  test('a configuration that breaks while the reader is open refuses every action', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-corrupt-action' });
    const gh = forkRunner();
    const log = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gh-bin-'))), 'argv.log');
    const stub = path.join(path.dirname(log), 'gh-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, 0o755);
    const savedBin = process.env.GH_BIN_PATH;
    process.env.GH_BIN_PATH = stub;
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      const expected = /cannot read this checkout's git configuration/;
      // The list is loaded from myfork/project; then the config becomes corrupt.
      fs.appendFileSync(path.join(root, '.git', 'config'), '\n[broken\n');
      const before = gh.calls.length;

      const comment = await run.options.actions.postComment(76, 'hello');
      assert.equal(comment.ok, false, 'the comment is refused');
      assert.match(comment.error, expected);
      const labels = await run.options.actions.editLabels(76, ['bug'], [], []);
      assert.equal(labels.ok, false, 'the label edit is refused');
      assert.match(labels.error, expected);
      const state = await run.options.actions.setState(76, 'closed');
      assert.equal(state.ok, false, 'the close is refused');
      const assign = await run.options.actions.editAssignees(76, { add: ['bob'], remove: [] });
      assert.equal(assign.ok, false, 'the assignee edit is refused');
      // The opener needs no config read: it opens the identity the rows were
      // read from, so a broken config cannot make it guess a repository.
      const opened = run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener still opens the displayed repository');
      assert.equal(fs.readFileSync(log, 'utf8').trim(), 'issue view 76 --web -R github.com/myfork/project',
        'the opener binds the displayed repository');

      const mutations = gh.calls.slice(before).filter((call) => call.argv[0] === 'issue'
        && ['edit', 'comment', 'close', 'reopen'].includes(call.argv[1]));
      assert.deepEqual(mutations, [], 'no mutating gh command ran');
      assert.ok(!gh.calls.slice(before).some((call) => call.argv[0] === 'label' && call.argv[1] === 'create'),
        'no label was created');

      // Reads stay on the pinned identity: the loaded list does not change.
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, true, 'the already-loaded identity is still readable');
      const reads = gh.calls.slice(before);
      assert.ok(reads.some((call) => call.argv.some((value) => value.includes('repo:myfork/project'))),
        'the read keeps the displayed repository');
      assert.ok(!reads.some((call) => call.repo === 'otherfork/project'));
    } finally {
      run.restore();
      if (savedBin === undefined) delete process.env.GH_BIN_PATH;
      else process.env.GH_BIN_PATH = savedBin;
    }
  });

  // B1: the identity carries its HOST. A fork on github.com moved to an
  // enterprise server under the SAME owner/name is a different repository, so
  // the pin must refuse rather than send the displayed issue number there.
  test('a host move to an enterprise server with the same owner/name fails closed', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-host-drift' });
    const gh = forkRunner({ repoView: 'original/project' });
    const stubDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gh-bin-')));
    const log = path.join(stubDir, 'argv.log');
    const stub = path.join(stubDir, 'gh-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, 0o755);
    const savedBin = process.env.GH_BIN_PATH;
    const savedHost = process.env.GH_HOST;
    process.env.GH_BIN_PATH = stub;
    delete process.env.GH_HOST;
    let run = null;
    try {
      run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
      // The same owner/name now lives on an enterprise server, and GH_HOST
      // selects that server.
      git(root, ['remote', 'set-url', 'origin', 'git@acme.ghe.com:myfork/project.git']);
      process.env.GH_HOST = 'acme.ghe.com';
      const before = gh.calls.length;

      for (const action of [
        () => run.options.actions.postComment(76, 'hello'),
        () => run.options.actions.editLabels(76, ['bug'], [], []),
        () => run.options.actions.setState(76, 'closed'),
        () => run.options.actions.editAssignees(76, { add: ['bob'], remove: [] }),
      ]) {
        const refused = await action();
        assert.equal(refused.ok, false, 'the action is refused');
        assert.match(refused.error, /changed since this issue list loaded/);
        assert.match(refused.error, /acme\.ghe\.com\/myfork\/project/,
          'the drift names the enterprise identity');
      }
      assert.deepEqual(gh.calls.slice(before).filter((call) => call.argv[0] === 'issue'
        && ['edit', 'comment', 'close', 'reopen'].includes(call.argv[1])), [],
      'no mutating gh command ran on the enterprise server');

      // A bound read is refused too: GH_HOST no longer selects the pinned
      // server, so the pin fails closed instead of being redirected.
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, false, 'the read fails closed on the env drift');
      assert.match(page.error, /GH_HOST selects acme\.ghe\.com/);

      // The opener still opens the issue the rows came from, on its own host.
      const opened = run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true, 'the opener binds the displayed host');
      assert.equal(fs.readFileSync(log, 'utf8').trim(), 'issue view 76 --web -R github.com/myfork/project',
        'the browser opens the github.com issue, never the enterprise one');
      assert.ok(!gh.calls.slice(before).some((call) => call.repo === 'acme.ghe.com/myfork/project'),
        'nothing was sent to the enterprise server');
    } finally {
      if (run) run.restore();
      if (savedBin === undefined) delete process.env.GH_BIN_PATH;
      else process.env.GH_BIN_PATH = savedBin;
      if (savedHost === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = savedHost;
    }
  });

  // B1: an ambient GH_REPO must never override the pinned identity, and a
  // change to it is drift, not a reason to follow it.
  test('an ambient GH_REPO cannot override the pinned identity', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-env-repo' });
    const gh = forkRunner();
    const stubDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-issues-gh-bin-')));
    const log = path.join(stubDir, 'argv.log');
    const stub = path.join(stubDir, 'gh-stub');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
    fs.chmodSync(stub, 0o755);
    const savedBin = process.env.GH_BIN_PATH;
    const savedRepo = process.env.GH_REPO;
    process.env.GH_BIN_PATH = stub;
    delete process.env.GH_REPO;
    let run = null;
    try {
      run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
      // A stray GH_REPO appears mid-session, naming another repository.
      process.env.GH_REPO = 'ambient/other';
      const refused = await run.options.actions.postComment(76, 'hello');
      assert.equal(refused.ok, false, 'the write is refused on the drift');
      assert.match(refused.error, /changed since this issue list loaded/);

      // Reads still carry the pinned identity, never the ambient variable.
      const before = gh.calls.length;
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, true);
      assert.ok(gh.calls.slice(before).every((call) => call.repo === 'github.com/myfork/project'),
        'the read carries the pin, not the ambient GH_REPO');

      const opened = run.options.actions.openBrowser(76);
      assert.equal(opened.ok, true);
      assert.equal(fs.readFileSync(log, 'utf8').trim(), 'issue view 76 --web -R github.com/myfork/project');
    } finally {
      if (run) run.restore();
      if (savedBin === undefined) delete process.env.GH_BIN_PATH;
      else process.env.GH_BIN_PATH = savedBin;
      if (savedRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = savedRepo;
    }
  });

  // B2: the fork clone that names its remotes `upstream` + `myfork` and tracks
  // upstream (no `origin`). The base must never become the scope.
  test('a fork with myfork and upstream, tracking upstream, reads myfork', async () => {
    const root = makeForkRepo({
      tag: 'issues-fork-no-origin',
      remotes: [['upstream', 'original/project'], ['myfork', 'myfork/project']],
    });
    const branch = git(root, ['branch', '--show-current']).trim();
    git(root, ['config', `branch.${branch}.remote`, 'upstream']);
    git(root, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
    const gh = forkRunner({ repoView: 'original/project' });
    const run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
    try {
      const before = gh.calls.length;
      for (const bucketId of ['mine', 'assigned', 'involved', 'all']) {
        const asked = await run.options.loadIssuePage({ bucketId, cursor: null, limit: 5 });
        assert.equal(asked.ok, true, `the ${bucketId} tab answered`);
      }
      const reads = gh.calls.slice(before);
      assert.deepEqual(
        searchScopes(reads.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql')),
        ['myfork/project', 'myfork/project', 'myfork/project'],
        'the tracked upstream is never the scope',
      );
      assert.ok(reads.every((call) => call.repo === 'github.com/myfork/project'),
        'every read carries the fork, host included');
    } finally {
      run.restore();
    }
  });

  // B1: an explicit GH_REPO in the environment is the user's own scope, and it
  // is pinned HOST-QUALIFIED so a later host change cannot redirect it.
  test('an explicit GH_REPO is pinned with its host', async () => {
    const root = makeForkRepo({ tag: 'issues-fork-env-pin' });
    const gh = forkRunner();
    const savedRepo = process.env.GH_REPO;
    process.env.GH_REPO = 'ambient/repo';
    let run = null;
    try {
      run = await capturedIssuesOptions(root, { runner: gh.runner, calls: gh.calls });
      const before = gh.calls.length;
      const page = await run.options.loadIssuePage({ bucketId: 'mine', cursor: null, limit: 5 });
      assert.equal(page.ok, true);
      assert.ok(gh.calls.slice(before).every((call) => call.repo === 'github.com/ambient/repo'),
        'the pinned GH_REPO is host-qualified and used');
    } finally {
      if (run) run.restore();
      if (savedRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = savedRepo;
    }
  });
});

// ---------------------------------------------------------------------------
// The Issues command is one of the three "Plugin tools" toggles. It gates the
// command and the session-start gh probe; a runtime that could not be reloaded
// still refuses the invocation instead of opening the reader.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:issues Plugin tools toggle', { concurrency: false }, () => {
  function pluginTools(state) {
    fs.writeFileSync(
      path.join(process.env.GENTLE_STATUS_STATE_DIR, 'gentle-plugin-tools.json'),
      `${JSON.stringify({ version: 1, ...state })}\n`,
    );
  }

  test('a disabled command registers nothing and never probes gh at startup', async () => {
    pluginTools({ odd: true, issues: false });
    const calls = [];
    ghIssues.setGhRunner(async (bin, argv) => { calls.push([bin, argv]); return { status: 0, stdout: '[]', stderr: '', error: null }; });
    const { commands, sessionStarts } = await loadExtension();
    assert.ok(!commands.has('herdr-gentle:issues'), 'the disabled command is not registered');
    assert.ok(commands.has('herdr-gentle:customize'), 'the panel stays registered so it can be flipped back');
    const root = makeRepo({ tag: 'issues-toggle-off' });
    const notes = [];
    await fireSessionStart(sessionStarts, gateCtx(root, notes));
    assert.deepEqual(notes, [], 'a disabled command never alerts about gh');
    assert.deepEqual(calls, [], 'a disabled command never spawns gh');
    pluginTools({ odd: true, issues: true });
  });

  test('a disabled command invoked through a stale runtime refuses and opens nothing', async () => {
    pluginTools({ odd: true, issues: true });
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:issues');
    assert.ok(def, 'registered at load while enabled');
    const calls = [];
    ghIssues.setGhRunner(async (bin, argv) => { calls.push([bin, argv]); return { status: 0, stdout: '[]', stderr: '', error: null }; });
    pluginTools({ odd: true, issues: false });
    const root = makeRepo({ tag: 'issues-toggle-stale' });
    mod.setIssuesTuiLoader(async () => stubTui);
    const { ctx, customs, selects, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await def.handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay');
    assert.deepEqual(selects, [], 'no fallback menu either');
    assert.deepEqual(calls, [], 'the gh probe is never reached');
    assert.deepEqual(notes, [[
      'issues command is disabled; open /herdr-gentle:customize and apply the Plugin tools Issues command toggle to enable it',
      'error',
    ]]);
    pluginTools({ odd: true, issues: true });
  });
});
