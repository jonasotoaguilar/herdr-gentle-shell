'use strict';
// Symlinked paths and separate-git-dir checkouts for `herdr_session_open`
// (odd/tasks/split-odd-worktree.md S8/T7 regression).
//
// Two defects this file pins, both about identity rather than names:
//   1. the requested path was compared LEXICALLY with the pane cwd Herdr
//      reports and with the worktree paths Herdr lists, so a symlinked path
//      was refused after its panel had already been created (a stray panel) and
//      a symlinked worktree never matched its existing workspace (duplicates);
//   2. `git init --separate-git-dir` leaves `.git` as a FILE, so the common dir
//      is not named `.git` and the primary checkout was misclassified as a
//      linked worktree.
//
// Identity is now git's own answer (`--git-dir` versus `--git-common-dir`) and
// every path comparison is canonical. These tests drive the public `execute`
// with real fixture repositories (and real symlinks) plus a stub `herdr`.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/herdr-session-open.ts');

const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText
  .replace('import { Type } from "@earendil-works/pi-ai";', TYPE_STUB)
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function tmp(prefix) {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function initRepo(dir, extraInitArgs = []) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', ...extraInitArgs]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function makeRepo(tag) {
  return initRepo(path.join(tmp(`hs-paths-${tag}-`), 'repo'));
}

function addWorktree(root, branch) {
  const slug = String(branch).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const target = track(path.join(path.dirname(root), `${path.basename(root)}-wt-${slug}`));
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  return fs.realpathSync(target);
}

function symlinkTo(target, name) {
  const link = path.join(tmp('hs-paths-link-'), name);
  fs.symlinkSync(target, link);
  return link;
}

function makeDir(name) {
  const dir = path.join(tmp('hs-paths-generic-'), name);
  fs.mkdirSync(dir);
  return fs.realpathSync(dir);
}

function writeJson(dir, name, doc) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return file;
}

function makeHerdrStub() {
  const dir = tmp('hs-paths-herdr-');
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$HERDR_SHIM_LOG"',
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then cat "$HERDR_STUB_WORKTREE_LIST"; exit 0; fi',
      'if [ "$1" = "worktree" ] && [ "$2" = "open" ]; then cat "$HERDR_STUB_WORKTREE_OPEN"; exit 0; fi',
      'if [ "$1" = "workspace" ] && [ "$2" = "create" ]; then cat "$HERDR_STUB_WORKSPACE_CREATE"; exit 0; fi',
      'if [ "$1" = "pane" ] && [ "$2" = "list" ]; then cat "$HERDR_STUB_PANE_LIST"; exit 0; fi',
      'if [ "$1" = "agent" ] && [ "$2" = "start" ]; then echo "{}"; exit 0; fi',
      'if [ "$1" = "agent" ] && [ "$2" = "get" ]; then cat "$HERDR_STUB_AGENT_GET_LAST"; exit 0; fi',
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, log: path.join(dir, 'herdr-argv.log') };
}

function shimArgv(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

const savedEnv = { ...process.env };

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

function worldEnv({ herdr, worktreeList, worktreeOpen, workspaceCreate, paneList }) {
  const dir = tmp('hs-paths-fixtures-');
  return {
    GENTLE_HERDR_SESSION_LIB_DIR: LIB_DIR,
    GENTLE_WORKTREE_LIB_DIR: undefined,
    HERDR_BIN_PATH: herdr.bin,
    HERDR_SHIM_LOG: herdr.log,
    HERDR_STUB_WORKTREE_LIST: writeJson(dir, 'worktree-list.json', worktreeList || { result: { worktrees: [] } }),
    HERDR_STUB_WORKTREE_OPEN: writeJson(dir, 'worktree-open.json', worktreeOpen || {}),
    HERDR_STUB_WORKSPACE_CREATE: writeJson(dir, 'workspace-create.json', workspaceCreate || {}),
    HERDR_STUB_PANE_LIST: writeJson(dir, 'pane-list.json', paneList || { result: { panes: [] } }),
    HERDR_STUB_AGENT_GET_LAST: writeJson(dir, 'agent.json', { result: { agent: { agent: 'pi', agent_status: 'idle' } } }),
    GENTLE_HERDR_SESSION_WATCH_INTERVAL_MS: '3600000',
  };
}

async function loadExtension() {
  const dir = tmp('hs-paths-ext-');
  const copy = path.join(dir, 'herdr-session-open.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    on: () => () => {},
    sendMessage: async () => 'msg-1',
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, mod };
}

function makeCtx(cwd) {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: { confirm: async () => true, notify: () => {} },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

async function callOpen(tools, params, ctx) {
  const tool = tools.get('herdr_session_open');
  assert.ok(tool, 'expected herdr_session_open to be registered');
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

function openReplyDoc(workspaceId, paneId, cwd) {
  return { result: { workspace: { workspace_id: workspaceId }, root_pane: { pane_id: paneId, cwd } } };
}

// The argv a worktree panel is opened with: the target travels as BOTH
// `--path` and `--cwd`, because herdr resolves the owning repository from
// `--cwd`, not from the process cwd (odd/tasks/session-open-cross-repo.md S1).
// Both name the REAL checkout, even when the caller spelled it through a
// symlink: resolution still lands on the same directory it always did.
function worktreeOpenArgv(realTarget) {
  return `worktree open --path ${realTarget} --cwd ${realTarget} --no-focus`;
}

describe('herdr_session_open symlinked paths', () => {
  test('a symlinked directory opens ONE normal panel at the requested spelling', async () => {
    const real = makeDir('real target');
    const link = symlinkTo(real, 'linked-target');
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, workspaceCreate: openReplyDoc('w1', 'w1:p1', real) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: link, notify: false }, makeCtx(path.dirname(link)));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(result.details.kind, 'generic');
      assert.equal(result.details.path, real, 'details carry the canonical identity');
      const argv = shimArgv(herdr.log);
      assert.deepEqual(argv, [
        `workspace create --cwd ${link} --no-focus`,
        `agent start linked-target --kind pi --pane w1:p1 --timeout 120000 -- --name linked-target --session-id ${result.details.sessionId}`,
      ], 'the requested spelling is what the panel opens at');
      assert.ok(resultText(result).includes(`path: ${real}`));
    } finally {
      restoreEnv();
    }
  });

  test('a symlinked worktree reuses the workspace Herdr lists under the real path', async () => {
    const root = makeRepo('link-reuse');
    const target = addWorktree(root, 'feat/link-reuse');
    const link = symlinkTo(target, 'linked-worktree');
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      worktreeList: { result: { worktrees: [{ path: target, branch: 'feat/link-reuse', open_workspace_id: 'w2' }] } },
      paneList: { result: { panes: [{ pane_id: 'w2:p1', cwd: target }] } },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: link, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(result.details.kind, 'worktree');
      assert.equal(result.details.path, target);
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('worktree open')).length, 0, 'no duplicate panel');
      assert.equal(argv.filter((line) => line.startsWith('workspace create')).length, 0);
      assert.equal(argv[0], `worktree list --cwd ${target}`);
      assert.equal(argv[1], 'pane list --workspace w2');
      assert.equal(argv[2], `agent start feat-link-reuse --kind pi --pane w2:p1 --timeout 120000 -- --name feat-link-reuse --session-id ${result.details.sessionId}`);
    } finally {
      restoreEnv();
    }
  });

  test('a symlinked worktree with no open workspace opens the panel at the real checkout', async () => {
    const root = makeRepo('link-open');
    const target = addWorktree(root, 'feat/link-open');
    const link = symlinkTo(target, 'linked-open');
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      worktreeList: { result: { worktrees: [{ path: target, branch: 'feat/link-open' }] } },
      worktreeOpen: openReplyDoc('w3', 'w3:p1', target),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: link, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(result.details.workspaceId, 'w3');
      const argv = shimArgv(herdr.log);
      assert.equal(argv[0], `worktree list --cwd ${target}`);
      assert.equal(argv[1], worktreeOpenArgv(target), 'the panel opens at the real checkout, resolved by --cwd');
      for (const line of argv) {
        assert.ok(!line.includes(link), `the symlink spelling never reaches herdr: ${line}`);
      }
    } finally {
      restoreEnv();
    }
  });

  test('a symlinked primary checkout opens a normal panel', async () => {
    const root = makeRepo('link-primary');
    const link = symlinkTo(root, 'linked-primary');
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, workspaceCreate: openReplyDoc('w4', 'w4:p1', root) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: link, notify: false }, makeCtx(path.dirname(link)));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(result.details.kind, 'primary');
      assert.equal(result.details.path, root);
      assert.equal(shimArgv(herdr.log)[0], `workspace create --cwd ${link} --no-focus`);
    } finally {
      restoreEnv();
    }
  });
});

describe('herdr_session_open separate-git-dir checkouts', () => {
  function makeSeparateRepo(tag) {
    const base = tmp(`hs-paths-sep-${tag}-`);
    const meta = path.join(base, 'meta.git');
    const root = initRepo(path.join(base, 'repo'), [`--separate-git-dir=${meta}`]);
    assert.ok(fs.statSync(path.join(root, '.git')).isFile(), 'fixture: .git must be a file');
    return root;
  }

  test('a primary checkout with a separate git dir is a normal panel', async () => {
    const root = makeSeparateRepo('primary');
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, workspaceCreate: openReplyDoc('w5', 'w5:p1', root) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: root, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(result.details.kind, 'primary', 'a separate git dir is still the primary checkout');
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('worktree')).length, 0, 'never a worktree panel');
      assert.equal(argv[0], `workspace create --cwd ${root} --no-focus`);
    } finally {
      restoreEnv();
    }
  });

  test('a linked worktree of a separate-git-dir repository is still a worktree panel', async () => {
    const root = makeSeparateRepo('worktree');
    const target = addWorktree(root, 'feat/sep-wt');
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      worktreeList: { result: { worktrees: [{ path: target, branch: 'feat/sep-wt' }] } },
      worktreeOpen: openReplyDoc('w6', 'w6:p1', target),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(result.details.kind, 'worktree');
      assert.equal(shimArgv(herdr.log)[1], worktreeOpenArgv(target));
    } finally {
      restoreEnv();
    }
  });
});

describe('herdr_session_open identity is proven before any panel', () => {
  test('git that cannot name its own directories is refused, opening nothing', async () => {
    // The seam is the lib's own public classification contract: a git that
    // answers `--show-toplevel` but not `--git-dir` cannot prove the panel
    // kind, so no panel kind is guessed.
    const lib = require('../lib/herdr-session-open.js');
    const root = makeRepo('unproven');
    const realRunner = (bin, args, cwd) => require('../lib/herdr-session-open.js')
      .runArgvAsync(bin, args, { cwd });
    const runAsync = async (bin, args, cwd) => {
      if (args.includes('--git-dir')) return { status: 128, stdout: '', stderr: 'fatal: cannot read', error: null };
      return realRunner(bin, args, cwd);
    };
    const panel = await lib.classifyPanel(root, { runAsync });
    assert.equal(panel.kind, 'unproven', `expected an unproven classification, got ${panel.kind}`);
    assert.equal(panel.path, root);
  });

  test('a pane reported outside the path is refused without a second panel', async () => {
    const real = makeDir('stray target');
    const link = symlinkTo(real, 'stray-link');
    const outside = path.dirname(real);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, workspaceCreate: openReplyDoc('w7', 'w7:p1', outside) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: link, notify: false }, makeCtx(path.dirname(link)));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /outside/);
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('workspace create')).length, 1, 'one panel attempt, never a retry');
      assert.equal(argv.filter((line) => line.startsWith('agent start')).length, 0, 'no session outside the path');
    } finally {
      restoreEnv();
    }
  });
});
