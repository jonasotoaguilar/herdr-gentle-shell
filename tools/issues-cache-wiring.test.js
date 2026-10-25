'use strict';
// worktree-ui-redesign S10/S5/S7c/S7d wiring tests: lib/issues-cache.js as the
// extension actually uses it — one complete OPEN snapshot at session start for
// assignment proof, fresh server pages for the viewer, and per-worktree
// assignment verification that drops an issue only on PROOF and never purges
// what it cannot prove.
//
// Observable contract under test (the argv that reaches the injected `gh`
// runner, the registry bytes on disk, and the text the mounted surfaces
// render):
// - session start lists the open set with ONE bounded fetch and never works
//   from a truncated or sampled page;
// - each `/herdr-gentle:issues` mount reads ONE fresh search page per bucket,
//   bounded by the reader's row budget, and never re-primes the snapshot;
// - the assignment margin is a SEPARATE bounded `--state all` read that starts
//   only after the overlay mounted, is settled before the command returns, and
//   never becomes a second source for the list on screen;
// - a closure the shared refresh reports is merged, so the worktree that still
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
  if (typeof mod.setIssuesTuiLoader === 'function') await mod.setIssuesTuiLoader(async () => stubTui);
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

// The viewer renders through the injectable TUI seam; these helpers are the
// only TUI surface it uses (width, truncation and key matching).
const stubTui = {
  visibleWidth: (text) => [...String(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

// A mutable stand-in for one GitHub repository. `issues` maps number ->
// {state, updatedAt}; `buckets` maps each viewer query to the numbers it
// matches (null = every open issue, the simplest faithful case); `mode` and
// `snapshot` simulate the ways a read can fail or lie.
function fakeGitHub({ nameWithOwner = 'octo/repo', issues = new Map() } = {}) {
  const model = {
    nameWithOwner,
    issues,
    buckets: { mine: null, assigned: null, involved: null },
    mode: 'ok',
    snapshot: 'ok',
    searchOverdelivers: false,
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
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      // Two GraphQL shapes reach gh: the assignment snapshot connection and
      // the viewer's `search` page. They are told apart by their variables.
      if (graphqlVariable(argv, 'search') !== null) return json(graphqlSearchPage(model, argv));
      return json(graphqlOpenPage(model, argv));
    }
    if (argv[0] === 'repo' && argv[1] === 'view') return json({ nameWithOwner: model.nameWithOwner });
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const at = (flag) => argv[argv.indexOf(flag) + 1];
      const state = at('--state');
      const search = typeof at('--search') === 'string' ? at('--search') : '';
      const limit = Number(at('--limit'));
      const bucket = search.startsWith('involves:@me -author:@me') ? 'involved'
        : (search.startsWith('assignee:@me') ? 'assigned'
          : (search.startsWith('author:@me') ? 'mine' : null));
      const members = bucket === null ? null : model.buckets[bucket];
      const rows = sorted([...model.issues.entries()]
        .filter(([, record]) => state === 'all' || record.state === state)
        .filter(([number]) => members === null || members.has(number))
        .map(([number, record]) => fixture(number, record)));
      const served = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
      return json(served);
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

// A `-F name=value` GraphQL variable, the only way the client sends them.
function graphqlVariable(argv, name) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === '-F' && argv[index + 1].startsWith(`${name}=`)) return argv[index + 1].slice(name.length + 1);
  }
  return null;
}

function searchNode(number, record) {
  return {
    number,
    title: `issue title ${number}`,
    state: record.state.toUpperCase(),
    stateReason: '',
    author: { login: 'octo' },
    labels: { nodes: [] },
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: record.updatedAt,
    url: `https://example.test/issues/${number}`,
    comments: { totalCount: 0 },
    reactionGroups: [],
  };
}

// The exact page shape `getIssuePage` reads: a `search` connection with
// issueCount, pageInfo and edges carrying their own cursor. The search string
// selects the bucket exactly as GitHub would.
function graphqlSearchPage(model, argv) {
  const search = String(graphqlVariable(argv, 'search') || '');
  const first = Number(graphqlVariable(argv, 'first'));
  const cursor = graphqlVariable(argv, 'cursor');
  // S15: a search that names no membership scope is the `All` bucket — the
  // whole open repository — while the three scoped buckets name their own.
  const bucket = /-author:@me/.test(search) ? 'involved'
    : (/assignee:@me/.test(search) ? 'assigned' : (/author:@me/.test(search) ? 'mine' : null));
  const members = bucket === null ? null : model.buckets[bucket];
  const rows = [...model.issues.entries()]
    .filter(([, record]) => record.state === 'open')
    .filter(([number]) => members === null || members.has(number))
    .sort((left, right) => {
      const byTime = Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt);
      return byTime !== 0 ? byTime : right[0] - left[0];
    });
  const offset = cursor === null ? 0 : Number(String(cursor).replace('search-', '')) || 0;
  const page = rows.slice(offset, offset + (Number.isFinite(first) ? first : rows.length));
  const hasNextPage = offset + page.length < rows.length;
  let edges = page.map(([number, record]) => ({ cursor: `row-${number}`, node: searchNode(number, record) }));
  if (model.searchOverdelivers === true && edges.length > 0) {
    // A server page that answers with more rows than were asked for.
    edges = [...edges, ...edges.map((edge, index) => ({ cursor: `extra-${index}`, node: edge.node }))];
  }
  return {
    data: {
      search: {
        issueCount: rows.length,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `search-${offset + page.length}` : null },
        edges,
      },
    },
  };
}

// The exact connection shape `listAllOpenIssues` pages through:
// `repository.issues(states: OPEN, first:, after:)` with totalCount and
// pageInfo. `model.snapshot` simulates the ways a page can lie.
function graphqlOpenPage(model, argv) {
  const variable = (name) => graphqlVariable(argv, name);
  if (model.snapshot === 'errors') return { errors: [{ message: 'API rate limit exceeded' }] };
  const first = Number(variable('first'));
  const cursor = variable('cursor');
  const rows = [...model.issues.entries()]
    .filter(([, record]) => record.state === 'open')
    .map(([number, record]) => ({ number, record }))
    .sort((left, right) => {
      const byTime = Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt);
      return byTime !== 0 ? byTime : right.number - left.number;
    });
  const offset = cursor === null ? 0 : Number(String(cursor).replace('page-', ''));
  let nodes = rows.slice(offset, offset + (Number.isFinite(first) ? first : rows.length));
  let hasNextPage = offset + nodes.length < rows.length;
  let endCursor = hasNextPage ? `page-${offset + nodes.length}` : null;
  if (model.snapshot === 'stuck-cursor') { hasNextPage = true; endCursor = 'page-0'; }
  // A terminal page that drops a row while still reporting the real total.
  if (model.snapshot === 'short' && !hasNextPage) nodes = nodes.slice(0, nodes.length - 1);
  return {
    data: {
      repository: {
        issues: {
          totalCount: rows.length,
          pageInfo: { hasNextPage, endCursor },
          nodes: nodes.map(({ number, record }) => searchNode(number, record)),
        },
      },
    },
  };
}

function opensOf(calls, state) {
  return calls.filter((argv) => argv[0] === 'issue' && argv[1] === 'list' && argv[argv.indexOf('--state') + 1] === state);
}

// The assignment snapshot is the only connection paginated by `states: OPEN`.
function snapshotPages(calls) {
  return calls.filter((argv) => argv[0] === 'api' && argv[1] === 'graphql'
    && argv.some((entry) => entry.includes('issues(states: OPEN')));
}

function searchPages(calls) {
  return calls.filter((argv) => argv[0] === 'api' && argv[1] === 'graphql'
    && graphqlVariable(argv, 'search') !== null);
}

function searchLimits(calls) {
  return searchPages(calls).map((argv) => Number(graphqlVariable(argv, 'first')));
}

function searchQueries(calls) {
  return searchPages(calls).map((argv) => String(graphqlVariable(argv, 'search')));
}

// The viewer mounts first and paints after its cached pages settle, so its
// frame is rendered again once the load has landed.
async function viewerFrame(opened) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return clean(opened.mounted.component.render(110).join('\n'));
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
        let settled;
        const ready = new Promise((resolve) => { settled = resolve; });
        const hostTui = {
          terminal: { rows: 24 },
          requestRender: () => {
            const data = mounted.component?.state?.dataState;
            if (data && data.assigned !== 'loading' && data.issues !== 'loading') settled();
          },
        };
        const component = factory(hostTui, plainTheme, {}, () => {});
        mounted.component = component;
        mounted.text = clean(component.render(110).join('\n'));
        // Detail mounts stored data first. These legacy cache assertions need
        // the public settled state, including named failures, not that frame.
        // The Issues pager has no dataState and keeps its loading-frame tests.
        if (component.state?.dataState) {
          hostTui.requestRender();
          await ready;
          mounted.text = clean(component.render(110).join('\n'));
        }
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
  test('250 open issues take three cursor pages, and the detail lists the whole set', async () => {
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

      const pages = snapshotPages(model.calls);
      assert.equal(pages.length, 3, `250 rows are three 100-row cursor pages: ${pages.length}`);
      // Startup pays for the assignment snapshot alone: the viewer's buckets
      // arrive one fresh search page at a time (S5/D1), so no bucket listing
      // and no `gh issue list` read happens here.
      assert.equal(opensOf(model.calls, 'open').length, 0, 'no bucket listing at startup');
      assert.equal(searchPages(model.calls).length, 0, 'no viewer page before the viewer mounts');
      for (const argv of pages) {
        assert.ok(argv.includes('first=100'), 'the page size is the server maximum');
        assert.ok(!argv.includes('--search'), 'server pagination, never the search API');
      }
      assert.ok(!pages[0].some((entry) => entry.startsWith('cursor=')), 'the first page starts the connection');
      assert.ok(pages[1].some((entry) => entry.startsWith('cursor=')), 'the next page carries the cursor');

      const opened = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', opened.ctx);
      assert.match(opened.text(), /Issues \(250\)/, 'the detail inherits the complete primed set');
    } finally {
      restoreEnv();
    }
  });

  test('concurrent and repeated session_start share the one prime', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('once');
      addRegisteredWorktree(root, 'feat/once', { issues: [7] });
      const model = fakeGitHub();
      for (let number = 1; number <= 250; number += 1) model.set(number, 'open');
      ghIssues.setGhRunner(model.runner);
      const { handlers } = await loadExtension();

      await Promise.all([...sessions(handlers, makeCtx(root).ctx), ...sessions(handlers, makeCtx(root).ctx)]);
      assert.equal(snapshotPages(model.calls).length, 3, 'concurrent starts share the prime in flight');

      await Promise.all(sessions(handlers, makeCtx(root).ctx));
      assert.equal(snapshotPages(model.calls).length, 3, 'a repeated start reuses the primed cache');
    } finally {
      restoreEnv();
    }
  });
});

describe('S5/S10: the fresh bounded page read on /issues open', { concurrency: false }, () => {
  test('it reads one row-budget page per bucket and never re-primes', async () => {
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
      const frame = await viewerFrame(opened);

      const after = model.calls.slice(before);
      // The viewer mounts on the first bucket and reads ONE page, bounded by
      // the reader's own row budget: the 24-row host leaves 18 list rows (the
      // frame's 6 chrome rows plus nothing else — the page marker moved to the
      // search row, S14), so the request is 18 — never a fixed count and never
      // the whole set.
      // Every tab is read ONCE at open (round 3): a tab nobody visited used to
      // sit at a false `(0)`, and each switch then refetched its own page.
      assert.equal(searchPages(after).length, 4, `one fresh page per tab: ${JSON.stringify(after)}`);
      assert.deepEqual(searchLimits(after), [18, 18, 18, 18], 'each bounded by the row budget');
      assert.deepEqual(searchQueries(after), [
        'repo:octo/repo is:issue is:open author:@me sort:updated-desc',
        'repo:octo/repo is:issue is:open assignee:@me sort:updated-desc',
        'repo:octo/repo is:issue is:open involves:@me -author:@me sort:updated-desc',
        'repo:octo/repo is:issue is:open sort:updated-desc',
      ], 'each page carries its own bucket\'s S2 search, never the snapshot connection');
      for (const argv of searchPages(after)) {
        assert.ok(!argv.some((entry) => entry.startsWith('cursor=')), 'the first page starts the connection');
        assert.ok(!argv.some((entry) => entry.startsWith('owner=')), 'the search seam replaces the snapshot connection');
      }
      assert.equal(snapshotPages(after).length, 0, 'the snapshot is never re-primed');
      // S5/S10: the assignment margin is a SEPARATE evidence read behind the
      // fresh page, never a second source for the rows on screen.
      const margins = opensOf(after, 'all');
      assert.equal(margins.length, 1, `one separate assignment margin read: ${JSON.stringify(after)}`);
      assert.match(frame, /My issues \(120\+\)/, 'the tab names the server total, more to come');
    } finally {
      restoreEnv();
    }
  });

  test('the assignment margin is a separate bounded read that starts after the mount', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('margin-separate');
      const model = fakeGitHub();
      for (let number = 1; number <= 120; number += 1) model.set(number, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();
      await Promise.all(sessions(handlers, makeCtx(root).ctx));

      const before = model.calls.length;
      const opened = makeCtx(root);
      let callsAtMount = null;
      // Capture the reads that exist at the exact mount boundary: the overlay
      // must be on screen before the assignment evidence read starts.
      opened.ctx.ui.custom = async (factory) => {
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        const component = factory(hostTui, plainTheme, {}, () => {});
        callsAtMount = model.calls.slice(before).map((argv) => argv.slice());
        opened.mounted.component = component;
        opened.mounted.text = clean(component.render(110).join('\n'));
        return null;
      };
      await commands.get('herdr-gentle:issues').handler('', opened.ctx);

      assert.deepEqual(
        (callsAtMount || []).filter((argv) => argv[0] === 'issue' && argv[1] === 'list'),
        [],
        'no assignment margin listing before the overlay mounted',
      );
      const after = model.calls.slice(before);
      const margins = opensOf(after, 'all');
      assert.equal(margins.length, 1, `exactly one margin read: ${JSON.stringify(after)}`);
      assert.deepEqual(margins[0].slice(0, 4), ['issue', 'list', '--state', 'all'],
        'the margin lists every state, not the viewer\'s open bucket');
      assert.equal(margins[0][margins[0].indexOf('--limit') + 1], '20',
        'the margin is the shared cache\'s bounded newest-20 window');
      // The rows the reader sees still come from the fresh server page only.
      assert.deepEqual(searchQueries(after), [
        'repo:octo/repo is:issue is:open author:@me sort:updated-desc',
        'repo:octo/repo is:issue is:open assignee:@me sort:updated-desc',
        'repo:octo/repo is:issue is:open involves:@me -author:@me sort:updated-desc',
        'repo:octo/repo is:issue is:open sort:updated-desc',
      ], 'the margin never replaces or adds to the viewer\'s page source');
      assert.equal(searchPages(after).length, 4, 'exactly one fresh page per tab');
      assert.equal(snapshotPages(after).length, 0, 'the snapshot is never re-primed');
      // The first frame is the truthful loading state: mounting never waits for
      // a network read, and the margin in particular starts after it.
      assert.match(opened.mounted.text, /loading issues…/, 'the mount frame is still loading, not a cache');
      assert.match(await viewerFrame(opened), /My issues \(120\+\)/, 'the frame renders the server total');
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

describe('S10: every open issue, no snapshot cap', { concurrency: false }, () => {
  test('more than 600 open issues prime completely and keep a low-numbered assignment', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('big');
      const target = addRegisteredWorktree(root, 'feat/big', { issues: [1] });
      const model = fakeGitHub();
      // #1 is the OLDEST of 620 open issues, so only the cursor walk reaches it.
      for (let number = 1; number <= 620; number += 1) model.set(number, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();

      await Promise.all(sessions(handlers, makeCtx(root).ctx));
      assert.equal(snapshotPages(model.calls).length, 7, '620 rows are seven 100-row cursor pages');

      const opened = makeCtx(target);
      await commands.get('herdr-gentle:worktree').handler('', opened.ctx);
      assert.match(opened.text(), /Issues \(620\)/, 'the whole open set is primed, never capped at 500');
      assert.deepEqual(registryLib.findByPath(root, target).issues, [1], 'the low-numbered assignment stays');
      assert.ok(!opened.notes.some(([message]) => /dropped issue assignment/.test(message)),
        `nothing was dropped: ${JSON.stringify(opened.notes)}`);
    } finally {
      restoreEnv();
    }
  });

  for (const snapshot of ['short', 'stuck-cursor', 'errors']) {
    test(`a snapshot page that cannot prove completeness (${snapshot}) fails and never tombstones`, async () => {
      setEnv(stdEnv());
      try {
        const root = makeRepo(`page-${snapshot}`);
        const target = addRegisteredWorktree(root, `feat/page-${snapshot}`, { issues: [1] });
        const model = fakeGitHub();
        for (let number = 1; number <= 600; number += 1) model.set(number, 'open');
        // `short`: the terminal page drops a row while reporting the real
        // total. `stuck-cursor`: the connection never advances. `errors`: the
        // page carries GraphQL errors. Each is missing evidence, never a
        // complete snapshot.
        model.snapshot = snapshot;
        ghIssues.setGhRunner(model.runner);
        const { commands, handlers } = await loadExtension();

        const registryFile = registryLib.registryPath(root);
        // The first start registers the repository's principal checkout (S28);
        // after that the failing snapshot is the only thing happening.
        await Promise.all(sessions(handlers, makeCtx(root).ctx));
        const before = fs.readFileSync(registryFile);
        await Promise.all(sessions(handlers, makeCtx(root).ctx));
        assert.deepEqual(fs.readFileSync(registryFile), before, 'a failed snapshot writes nothing');
        assert.deepEqual(registryLib.findByPath(root, target).issues, [1], 'no fetch-only absence removes a stored issue');

        const opened = makeCtx(target);
        await commands.get('herdr-gentle:worktree').handler('', opened.ctx);
        assert.ok(opened.notes.some(([message]) => /cannot list open issues/.test(message)),
          `the incomplete snapshot is reported, never passed off as complete: ${JSON.stringify(opened.notes)}`);
        assert.deepEqual(registryLib.findByPath(root, target).issues, [1], '#1 is verified on its own and kept');
        assert.ok(!opened.notes.some(([message]) => /dropped issue assignment/.test(message)),
          `nothing was dropped: ${JSON.stringify(opened.notes)}`);
      } finally {
        restoreEnv();
      }
    });
  }
});

describe('S5: the viewer reads each page fresh from its bucket', { concurrency: false }, () => {
  // The viewer's three buckets, seeded from fixtures: `mine` holds #1..#3,
  // `assigned` #7..#9, `involved` #11, so a bucket that answered for another
  // query would be visible in the counts.
  function seededModel() {
    const model = fakeGitHub();
    model.buckets.mine = new Set([1, 2, 3]);
    model.buckets.assigned = new Set([7, 8, 9]);
    model.buckets.involved = new Set([11]);
    for (const number of [1, 2, 3]) model.set(number, 'open', `2024-01-0${number}T00:00:00Z`);
    for (const number of [7, 8, 9]) model.set(number, 'open', `2024-02-0${number - 6}T00:00:00Z`);
    model.set(11, 'open', '2024-03-01T00:00:00Z');
    return model;
  }

  test('each open reads one bounded page and never re-primes', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('viewer');
      const model = fakeGitHub();
      for (let number = 1; number <= 45; number += 1) model.set(number, 'open');
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();

      await Promise.all(sessions(handlers, makeCtx(root).ctx));
      assert.equal(snapshotPages(model.calls).length, 1, '45 open issues are one snapshot page');
      assert.equal(searchPages(model.calls).length, 0, 'startup reads no bucket page');

      const before = model.calls.length;
      const opened = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', opened.ctx);
      const firstFrame = await viewerFrame(opened);
      const after = model.calls.slice(before);

      assert.equal(snapshotPages(after).length, 0, 'the snapshot is never re-primed');
      assert.equal(searchPages(after).length, 4, 'each tab is read fresh once at open');
      assert.deepEqual(searchLimits(after), [18, 18, 18, 18], 'the request is the row budget, never a fixed count');
      assert.match(firstFrame, /My issues \(45\+\)/, 'the tab names the server total');

      // A second open reads the same first page again: fresh rows every time,
      // still no snapshot.
      const beforeSecond = model.calls.length;
      const second = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', second.ctx);
      const secondFrame = await viewerFrame(second);
      const again = model.calls.slice(beforeSecond);
      assert.equal(snapshotPages(again).length, 0, 'never a second snapshot');
      assert.equal(searchPages(again).length, 4, 'a reopen is a fresh page per tab, not a cache hit');
      assert.match(secondFrame, /My issues \(45\+\)/);
    } finally {
      restoreEnv();
    }
  });

  test('the fourth All tab lists the whole open set through the search seam, never a cached bundle', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('viewer-all');
      const model = fakeGitHub();
      // Each of the three S2 buckets holds ONE issue; #4 and #5 belong to none
      // of them. All is the whole open repository, so it must list all five —
      // it is not the union of the other tabs.
      model.buckets.mine = new Set([1]);
      model.buckets.assigned = new Set([2]);
      model.buckets.involved = new Set([3]);
      for (const number of [1, 2, 3, 4, 5]) model.set(number, 'open', `2024-05-0${number}T00:00:00Z`);
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();
      await Promise.all(sessions(handlers, makeCtx(root).ctx));

      const before = model.calls.length;
      const opened = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', opened.ctx);
      assert.match(await viewerFrame(opened), /My issues \(1\)/, 'the scoped bucket still lists only its own issue');
      for (let at = 0; at < 3; at += 1) opened.mounted.component.handleInput('tab');
      const frame = await viewerFrame(opened);
      const after = model.calls.slice(before);

      assert.match(frame, /All \(5\)/, 'All counts every open issue, not the other tabs\' rows');
      assert.match(frame, /issue title 4/, 'an issue outside every scoped bucket lists here');
      assert.match(frame, /issue title 5/, 'and so does the last one');
      assert.deepEqual(searchQueries(after).slice(-1), ['repo:octo/repo is:issue is:open sort:updated-desc'],
        'the All page is the plain open-repository search');
      assert.equal(snapshotPages(after).length, 0, 'the All tab never re-primes the assignment snapshot');
      assert.deepEqual(opensOf(after, 'open'), [], 'the All tab never reads the legacy list cache');
    } finally {
      restoreEnv();
    }
  });

  test('a closed or no-longer-matching issue leaves its bucket, and nothing else does', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('membership');
      const model = seededModel();
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();
      await Promise.all(sessions(handlers, makeCtx(root).ctx));

      const first = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', first.ctx);
      assert.match(await viewerFrame(first), /My issues \(3\)/, 'the first bucket lists its three issues');
      // Each bucket is read when it is shown: tab moves to Assigned.
      first.mounted.component.handleInput('tab');
      assert.match(await viewerFrame(first), /Assigned \(3\)/, 'the bucket lists its three issues');

      // #8 closes and #9 stops matching the query.
      model.set(8, 'closed', '2024-04-01T00:00:00Z');
      model.set(9, 'open', '2024-04-02T00:00:00Z');
      model.buckets.assigned.delete(9);

      const second = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', second.ctx);
      assert.match(await viewerFrame(second), /My issues \(3\)/, 'the untouched bucket keeps every row');
      second.mounted.component.handleInput('tab');
      const body = await viewerFrame(second);
      assert.match(body, /Assigned \(1\)/, 'only #7 still matches the query');
      second.mounted.component.handleInput('tab');
      assert.match(await viewerFrame(second), /Involved \(1\)/, 'and so does the smallest one');
    } finally {
      restoreEnv();
    }
  });

  test('one repository\'s pages never answer for another', async () => {
    setEnv(stdEnv());
    try {
      const rootA = makeRepo('viewer-a');
      const modelA = fakeGitHub({ nameWithOwner: 'octo/a' });
      modelA.buckets.mine = new Set([1, 2]);
      modelA.set(1, 'open');
      modelA.set(2, 'open');
      const rootB = makeRepo('viewer-b');
      const modelB = fakeGitHub({ nameWithOwner: 'octo/b' });
      modelB.buckets.mine = new Set([5, 6, 7]);
      for (const number of [5, 6, 7]) modelB.set(number, 'open');
      const router = fakeGitHub({ nameWithOwner: 'octo/router' });
      router.byCwd = new Map([[rootA, modelA], [rootB, modelB]]);
      ghIssues.setGhRunner(router.runner);
      const { commands, handlers } = await loadExtension();

      await Promise.all(sessions(handlers, makeCtx(rootA).ctx));
      await Promise.all(sessions(handlers, makeCtx(rootB).ctx));

      const openedB = makeCtx(rootB);
      await commands.get('herdr-gentle:issues').handler('', openedB.ctx);
      const bodyB = await viewerFrame(openedB);
      assert.match(bodyB, /My issues \(3\)/, 'B answers from B');
      assert.match(bodyB, /issue title 5/, 'B lists its own issue');

      const openedA = makeCtx(rootA);
      await commands.get('herdr-gentle:issues').handler('', openedA.ctx);
      assert.match(await viewerFrame(openedA), /My issues \(2\)/, 'A is untouched by B');
    } finally {
      restoreEnv();
    }
  });

  test('a server page that overdelivers is a failed read, never a rendered page', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('overfull');
      const model = fakeGitHub();
      for (let number = 1; number <= 45; number += 1) model.set(number, 'open');
      // gh answers with more edges than were requested: the page cannot be
      // trusted, so none of it is primed or painted.
      model.searchOverdelivers = true;
      ghIssues.setGhRunner(model.runner);
      const { commands, handlers } = await loadExtension();

      await Promise.all(sessions(handlers, makeCtx(root).ctx));
      const opened = makeCtx(root);
      await commands.get('herdr-gentle:issues').handler('', opened.ctx);
      assert.match(await viewerFrame(opened), /failed to load issues: .*exceeded the requested issue page size/,
        'the overdelivered page is reported, never rendered as a page');
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
