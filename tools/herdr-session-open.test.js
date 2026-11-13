'use strict';
// `herdr_session_open` — open a Herdr panel running a Pi session at a PATH
// (odd/tasks/split-odd-worktree.md S8, T7).
//
// The tool replaced the worktree-only `worktree_session_open`: it accepts a
// path, opens a WORKTREE panel when the path is a linked Git worktree, and a
// NORMAL panel when the path is a repository's primary checkout or any other
// directory. This suite drives all three path classes plus the refusals
// through the public `execute`, against real fixture repositories and a stub
// `herdr` binary reached through HERDR_BIN_PATH — never a live Herdr.
//
// Loading pattern matches tools/gentle-herdr-state.test.js: the extension is
// plain JavaScript under a .ts name, so it is copied to a temporary .mjs with
// the two package imports stubbed.

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

// A PRIMARY checkout: the repository whose `.git` directory holds the common
// dir every linked worktree shares.
function makeRepo(tag) {
  const dir = tmp(`hs-path-${tag}-`);
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

// A LINKED worktree of that repository.
function addWorktree(root, branch) {
  const slug = String(branch).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const target = track(path.join(path.dirname(root), `${path.basename(root)}-wt-${slug}`));
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  return fs.realpathSync(target);
}

// A directory that is not a Git checkout at all.
function makeDir(name) {
  const dir = tmp('hs-path-generic-');
  const target = path.join(dir, name);
  fs.mkdirSync(target);
  return fs.realpathSync(target);
}

function writeJson(dir, name, doc) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return file;
}

// Stub `herdr`: logs every argv line, answers each leg from a fixture file,
// and counts `agent get` polls so a watcher's polling is observable.
function makeHerdrStub() {
  const dir = tmp('hs-path-herdr-');
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$HERDR_SHIM_LOG"',
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  if [ "${HERDR_SHIM_WORKTREE_LIST_EXIT:-0}" != "0" ]; then echo "shim worktree list failure" >&2; exit 1; fi',
      '  if [ -n "${HERDR_STUB_LIST_DIR:-}" ]; then',
      '    n=$(cat "$HERDR_STUB_LIST_COUNT" 2>/dev/null || echo 0)',
      '    n=$((n + 1)); echo "$n" > "$HERDR_STUB_LIST_COUNT"',
      '    f="$HERDR_STUB_LIST_DIR/$n.json"',
      '    if [ -f "$f" ]; then cat "$f"; exit 0; fi',
      '  fi',
      '  cat "$HERDR_STUB_WORKTREE_LIST"; exit 0',
      'fi',
      'if [ "$1" = "worktree" ] && [ "$2" = "open" ]; then',
      '  if [ "${HERDR_SHIM_OPEN_EXIT:-0}" != "0" ]; then',
      '    if [ -n "${HERDR_STUB_WORKTREE_OPEN_REMOVE:-}" ]; then git -C "$HERDR_STUB_WORKTREE_OPEN_REMOVE_REPO" worktree remove --force "$HERDR_STUB_WORKTREE_OPEN_REMOVE" >/dev/null 2>&1 || true; fi',
      '    if [ -n "${HERDR_STUB_WORKTREE_OPEN_RECREATE:-}" ]; then mkdir -p "$HERDR_STUB_WORKTREE_OPEN_RECREATE" >/dev/null 2>&1 || true; fi',
      '    if [ -n "${HERDR_STUB_WORKTREE_OPEN_ERROR:-}" ]; then cat "$HERDR_STUB_WORKTREE_OPEN_ERROR" >&2; else echo "shim worktree open failure" >&2; fi',
      '    exit 1',
      '  fi',
      '  cat "$HERDR_STUB_WORKTREE_OPEN"; exit 0',
      'fi',
      'if [ "$1" = "workspace" ] && [ "$2" = "create" ]; then',
      '  if [ "${HERDR_SHIM_WORKSPACE_CREATE_EXIT:-0}" != "0" ]; then echo "shim workspace create failure" >&2; exit 1; fi',
      '  cat "$HERDR_STUB_WORKSPACE_CREATE"; exit 0',
      'fi',
      'if [ "$1" = "pane" ] && [ "$2" = "list" ]; then',
      '  if [ "${HERDR_SHIM_PANE_LIST_EXIT:-0}" != "0" ]; then echo "shim pane list failure" >&2; exit 1; fi',
      '  cat "$HERDR_STUB_PANE_LIST"; exit 0',
      'fi',
      'if [ "$1" = "agent" ] && [ "$2" = "start" ]; then',
      '  if [ "${HERDR_SHIM_AGENT_START_EXIT:-0}" != "0" ]; then echo "shim agent start failure" >&2; exit 1; fi',
      '  echo "{}"; exit 0',
      'fi',
      'if [ "$1" = "agent" ] && [ "$2" = "get" ]; then',
      '  n=$(cat "$HERDR_STUB_AGENT_GET_COUNT" 2>/dev/null || echo 0)',
      '  n=$((n + 1)); echo "$n" > "$HERDR_STUB_AGENT_GET_COUNT"',
      '  f="$HERDR_STUB_AGENT_GET_DIR/$n.json"',
      '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
      '  cat "$HERDR_STUB_AGENT_GET_LAST"; exit 0',
      'fi',
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const log = path.join(dir, 'herdr-argv.log');
  return { bin, log };
}

function shimArgv(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function agentSequence(docs) {
  const dir = tmp('hs-path-agentseq-');
  docs.forEach((doc, index) => writeJson(dir, `${index + 1}.json`, doc));
  const last = path.join(dir, 'last.json');
  fs.writeFileSync(last, `${JSON.stringify(docs[docs.length - 1])}\n`);
  const count = path.join(dir, 'count');
  fs.writeFileSync(count, '0\n');
  return { dir, last, count };
}

function agentDoc(status, paneId) {
  return { result: { agent: { agent: 'pi', agent_status: status, pane_id: paneId } } };
}

function worktreeListDoc(entries) {
  return { result: { worktrees: entries } };
}

function paneListDoc(panes) {
  return { result: { panes } };
}

function openReplyDoc(workspaceId, paneId, cwd) {
  return { result: { workspace: { workspace_id: workspaceId }, root_pane: { pane_id: paneId, cwd } } };
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

// The world a test hands the extension: the stub binary, the fixtures each
// herdr leg answers from, and a fast watcher clock. `listSequence` overrides
// `worktree list` per invocation (1.json, 2.json, …).
function worldEnv({ herdr, worktreeList, worktreeOpen, worktreeOpenError, workspaceCreate, paneList, seq, listSequence, extra }) {
  const dir = tmp('hs-path-fixtures-');
  const listDir = listSequence ? tmp('hs-path-listseq-') : null;
  if (listDir) {
    listSequence.forEach((doc, index) => writeJson(listDir, `${index + 1}.json`, doc));
    fs.writeFileSync(path.join(listDir, 'count'), '0\n');
  }
  const write = (name, doc, fallback) => writeJson(dir, name, doc || fallback);
  return {
    GENTLE_HERDR_SESSION_LIB_DIR: LIB_DIR,
    GENTLE_WORKTREE_LIB_DIR: undefined,
    HERDR_BIN_PATH: herdr.bin,
    HERDR_SHIM_LOG: herdr.log,
    HERDR_STUB_LIST_DIR: listDir || undefined,
    HERDR_STUB_LIST_COUNT: listDir ? path.join(listDir, 'count') : undefined,
    HERDR_STUB_WORKTREE_LIST: write('worktree-list.json', worktreeList, worktreeListDoc([])),
    HERDR_STUB_WORKTREE_OPEN: write('worktree-open.json', worktreeOpen, {}),
    // The stderr a FAILING `herdr worktree open` prints (HERDR_SHIM_OPEN_EXIT),
    // so the exact herdr error document can be reproduced.
    HERDR_STUB_WORKTREE_OPEN_ERROR: worktreeOpenError === undefined
      ? undefined
      : writeJson(dir, 'worktree-open-error.json', worktreeOpenError),
    HERDR_STUB_WORKSPACE_CREATE: write('workspace-create.json', workspaceCreate, {}),
    HERDR_STUB_PANE_LIST: write('pane-list.json', paneList, paneListDoc([])),
    HERDR_STUB_AGENT_GET_DIR: seq.dir,
    HERDR_STUB_AGENT_GET_COUNT: seq.count,
    HERDR_STUB_AGENT_GET_LAST: seq.last,
    GENTLE_HERDR_SESSION_WATCH_INTERVAL_MS: '15',
    GENTLE_HERDR_SESSION_WATCH_GRACE_MS: '20',
    GENTLE_HERDR_SESSION_WATCH_MAX_MS: '900',
    ...(extra || {}),
  };
}

async function loadExtension({ sendMessage } = {}) {
  const dir = tmp('hs-path-ext-');
  const copy = path.join(dir, 'herdr-session-open.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const sent = [];
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    on: () => () => {},
    sendMessage: sendMessage || (async (message, options) => {
      sent.push([message, options]);
      return 'msg-1';
    }),
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, pi, mod, sent };
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

function openRows({ outcome = 'opened', target, panel, fallback, branch, session, workspace, pane, agent }) {
  const rows = [`outcome: ${outcome}`, `path: ${target}`, `panel: ${panel}`];
  if (fallback) rows.push(`fallback: normal panel after herdr reported ${fallback}`);
  if (branch) rows.push(`branch: ${branch}`);
  rows.push(`session: ${session}`);
  if (workspace) rows.push(`workspace: ${workspace}`);
  if (pane) rows.push(`pane: ${pane}`);
  if (agent) rows.push(`agent: ${agent}`);
  return rows;
}

// The default agent name for a non-worktree panel: the directory's own last
// component, sanitized into Herdr's documented shape.
function derivedName(target) {
  const base = path.basename(target).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const prefixed = /^[a-z]/.test(base) ? base : `p${base}`;
  return prefixed.slice(0, 32).replace(/-+$/g, '');
}

function openTool(tools) {
  const tool = tools.get('herdr_session_open');
  assert.ok(tool, 'expected herdr_session_open to be registered');
  return tool;
}

async function callOpen(tools, params, ctx) {
  return openTool(tools).execute('call-1', params, undefined, undefined, ctx);
}

async function waitUntil(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('herdr_session_open registration', () => {
  test('is the only tool the extension registers, with path/session/name/notify', async () => {
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      assert.deepEqual([...tools.keys()], ['herdr_session_open']);
      const params = openTool(tools).parameters;
      assert.deepEqual(Object.keys(params.properties).sort(), ['name', 'notify', 'path', 'session']);
      assert.equal(params.properties.path.type, 'string');
      assert.equal(params.properties.session.type, 'string');
      assert.equal(params.properties.name.type, 'string');
      assert.equal(params.properties.notify.type, 'boolean');
      assert.equal(params.properties.notify.optional, true);
      assert.equal(params.properties.path.optional, undefined, 'path is required');
      assert.equal(openTool(tools).label, 'Herdr Session Open');
      assert.match(openTool(tools).description, /worktree panel/);
      assert.match(openTool(tools).description, /panel/);
    } finally {
      restoreEnv();
    }
  });

  test('package.json still declares the opener beside the state sidecar', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    assert.deepEqual(pkg.pi.extensions.slice().sort(), [
      './extensions/gentle-herdr-state.ts',
      './extensions/herdr-session-open.ts',
    ]);
  });
});

describe('herdr_session_open panel classes', () => {
  test('a linked Git worktree opens as a worktree panel', async () => {
    const root = makeRepo('worktree');
    const target = addWorktree(root, 'feat/panel');
    const seq = agentSequence([agentDoc('idle', 'w9:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/panel' }]),
      worktreeOpen: openReplyDoc('w9', 'w9:p1', target),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      const sessionId = result.details.sessionId;
      assert.match(sessionId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(resultText(result).split('\n'), openRows({
        target,
        panel: 'worktree',
        branch: 'feat/panel',
        session: sessionId,
        workspace: 'w9',
        pane: 'w9:p1',
        agent: 'feat-panel',
      }));
      assert.deepEqual(Object.keys(result.details), [
        'path', 'kind', 'branch', 'paneId', 'workspaceId', 'sessionId', 'resumed', 'agentName', 'notify',
      ]);
      assert.equal(result.details.kind, 'worktree');
      assert.equal(result.details.path, target);
      assert.equal(result.details.resumed, false);
      assert.equal('fallback' in result.details, false, 'a worktree panel reports no fallback');
      const argv = shimArgv(herdr.log);
      assert.deepEqual(argv, [
        `worktree list --cwd ${target}`,
        // The target is passed as BOTH --path and --cwd: herdr resolves the
        // worktree's repository from --cwd, never from the process cwd.
        `worktree open --path ${target} --cwd ${target} --no-focus`,
        `agent start feat-panel --kind pi --pane w9:p1 --timeout 120000 -- --name feat-panel --session-id ${sessionId}`,
      ]);
      for (const line of argv) {
        assert.ok(!line.includes('--trust-repository'), `never --trust-repository: ${line}`);
        assert.ok(!line.includes('--session-dir'), `never --session-dir: ${line}`);
        assert.ok(!/(^| )--focus( |$)/.test(line), `never --focus: ${line}`);
      }
    } finally {
      restoreEnv();
    }
  });

  test('a worktree already open in Herdr reuses its workspace and opens no second panel', async () => {
    const root = makeRepo('reuse');
    const target = addWorktree(root, 'feat/reuse');
    const seq = agentSequence([agentDoc('idle', 'w2:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/reuse', open_workspace_id: 'w2' }]),
      paneList: paneListDoc([
        { pane_id: 'w2:p2', cwd: target },
        { pane_id: 'w2:p1', cwd: target },
      ]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.paneId, 'w2:p1', 'the root pane is the lowest index');
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('worktree open')).length, 0);
      assert.equal(argv.filter((line) => line.startsWith('workspace create')).length, 0);
      assert.equal(argv[1], 'pane list --workspace w2');
    } finally {
      restoreEnv();
    }
  });

  test('the primary checkout of a repository opens as a normal panel', async () => {
    const root = makeRepo('primary');
    addWorktree(root, 'feat/other');
    const seq = agentSequence([agentDoc('idle', 'w3:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w3', 'w3:p1', root) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: root, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.kind, 'primary');
      assert.equal('fallback' in result.details, false, 'a primary checkout reports no fallback');
      const branch = result.details.branch;
      assert.ok(typeof branch === 'string' && branch.length > 0, `reports the branch: ${branch}`);
      assert.deepEqual(resultText(result).split('\n'), openRows({
        target: root,
        panel: 'normal',
        branch,
        session: result.details.sessionId,
        workspace: 'w3',
        pane: 'w3:p1',
        agent: derivedName(root),
      }));
      assert.deepEqual(shimArgv(herdr.log), [
        `workspace create --cwd ${root} --no-focus`,
        `agent start ${derivedName(root)} --kind pi --pane w3:p1 --timeout 120000 -- --name ${derivedName(root)} --session-id ${result.details.sessionId}`,
      ]);
    } finally {
      restoreEnv();
    }
  });

  test('a generic directory opens as a normal panel', async () => {
    const dir = makeDir('scratch area');
    const seq = agentSequence([agentDoc('idle', 'w4:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w4', 'w4:p1', dir) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(path.dirname(dir)));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.kind, 'generic');
      assert.deepEqual(resultText(result).split('\n'), openRows({
        target: dir,
        panel: 'normal',
        session: result.details.sessionId,
        workspace: 'w4',
        pane: 'w4:p1',
        agent: 'scratch-area',
      }));
      assert.equal(result.details.branch, null);
      assert.deepEqual(shimArgv(herdr.log), [
        `workspace create --cwd ${dir} --no-focus`,
        `agent start scratch-area --kind pi --pane w4:p1 --timeout 120000 -- --name scratch-area --session-id ${result.details.sessionId}`,
      ]);
    } finally {
      restoreEnv();
    }
  });

  test('a relative path resolves against the session cwd', async () => {
    const dir = makeDir('relative target');
    const seq = agentSequence([agentDoc('idle', 'w5:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w5', 'w5:p1', dir) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: 'relative target', notify: false }, makeCtx(path.dirname(dir)));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.path, dir);
      assert.deepEqual(shimArgv(herdr.log), [
        `workspace create --cwd ${dir} --no-focus`,
        `agent start relative-target --kind pi --pane w5:p1 --timeout 120000 -- --name relative-target --session-id ${result.details.sessionId}`,
      ]);
    } finally {
      restoreEnv();
    }
  });

  test('a subdirectory of a checkout is a normal panel at that subdirectory', async () => {
    const root = makeRepo('subdir');
    const child = track(path.join(root, 'packages', 'app'));
    fs.mkdirSync(child, { recursive: true });
    const seq = agentSequence([agentDoc('idle', 'w6:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w6', 'w6:p1', child) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: child, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.kind, 'generic');
      assert.equal(result.details.path, child);
      assert.equal(shimArgv(herdr.log)[0], `workspace create --cwd ${child} --no-focus`);
    } finally {
      restoreEnv();
    }
  });

  test('a resume passes --session and never mints a session id', async () => {
    const dir = makeDir('resume target');
    const seq = agentSequence([agentDoc('idle', 'w7:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w7', 'w7:p1', dir) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, session: 'abc123', notify: false }, makeCtx(dir));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.sessionId, 'abc123');
      assert.equal(result.details.resumed, true);
      assert.deepEqual(resultText(result).split('\n'), openRows({
        outcome: 'resumed',
        target: dir,
        panel: 'normal',
        session: 'abc123',
        workspace: 'w7',
        pane: 'w7:p1',
        agent: 'resume-target',
      }));
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.includes('--session-id')).length, 0);
      assert.equal(argv[1], 'agent start resume-target --kind pi --pane w7:p1 --timeout 120000 -- --name resume-target --session abc123');
    } finally {
      restoreEnv();
    }
  });

  test('an explicit agent name is used as given', async () => {
    const dir = makeDir('named target');
    const seq = agentSequence([agentDoc('idle', 'w8:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w8', 'w8:p1', dir) }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, name: 'reviewer', notify: false }, makeCtx(dir));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.agentName, 'reviewer');
      assert.match(shimArgv(herdr.log)[1], /^agent start reviewer --kind pi /);
    } finally {
      restoreEnv();
    }
  });
});

describe('herdr_session_open worktrees of another repository', () => {
  test('a worktree of another repo opens as a worktree panel, with --cwd naming its own repo', async () => {
    // The focused workspace belongs to `focused`; the target is a linked
    // worktree of a DIFFERENT repository, which is the S1 failure.
    const focused = makeRepo('cross-focused');
    addWorktree(focused, 'feat/focused-only');
    const other = makeRepo('cross-other');
    const target = addWorktree(other, 'feat/cross');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/cross' }]),
      worktreeOpen: openReplyDoc('w1', 'w1:p1', target),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(focused));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.kind, 'worktree');
      assert.equal('fallback' in result.details, false);
      assert.deepEqual(resultText(result).split('\n'), openRows({
        target,
        panel: 'worktree',
        branch: 'feat/cross',
        session: result.details.sessionId,
        workspace: 'w1',
        pane: 'w1:p1',
        agent: 'feat-cross',
      }));
      const openArgv = shimArgv(herdr.log).find((line) => line.startsWith('worktree open'));
      assert.equal(openArgv, `worktree open --path ${target} --cwd ${target} --no-focus`);
      assert.ok(openArgv.includes(`--cwd ${target}`), `the target is what resolves the repo: ${openArgv}`);
      assert.ok(!openArgv.includes('--trust-repository') && !/(^| )--focus( |$)/.test(openArgv));
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('workspace create')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('worktree_not_found for a real linked worktree falls back to a normal panel and says which', async () => {
    const focused = makeRepo('cross-fallback-focused');
    const other = makeRepo('cross-fallback-other');
    const target = addWorktree(other, 'feat/fallback');
    const seq = agentSequence([agentDoc('idle', 'w2:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/fallback' }]),
      worktreeOpenError: { error: { code: 'worktree_not_found', message: 'worktree path not found' } },
      workspaceCreate: openReplyDoc('w2', 'w2:p1', target),
      extra: { HERDR_SHIM_OPEN_EXIT: '1' },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(focused));
      assert.equal(result.isError, undefined, resultText(result));
      // The panel that was really opened is a NORMAL one, and both the rows and
      // the details say so instead of claiming a worktree panel.
      assert.equal(result.details.kind, 'normal');
      assert.equal(result.details.fallback, 'worktree_not_found');
      assert.deepEqual(Object.keys(result.details), [
        'path', 'kind', 'branch', 'fallback', 'paneId', 'workspaceId', 'sessionId', 'resumed', 'agentName', 'notify',
      ]);
      assert.deepEqual(resultText(result).split('\n'), openRows({
        target,
        panel: 'normal',
        fallback: 'worktree_not_found',
        branch: 'feat/fallback',
        session: result.details.sessionId,
        workspace: 'w2',
        pane: 'w2:p1',
        agent: 'feat-fallback',
      }));
      assert.deepEqual(shimArgv(herdr.log), [
        `worktree list --cwd ${target}`,
        `worktree open --path ${target} --cwd ${target} --no-focus`,
        `worktree list --cwd ${target}`,
        `workspace create --cwd ${target} --no-focus`,
        `agent start feat-fallback --kind pi --pane w2:p1 --timeout 120000 -- --name feat-fallback --session-id ${result.details.sessionId}`,
      ]);
    } finally {
      restoreEnv();
    }
  });

  test('an unrelated worktree open failure still aborts and opens nothing', async () => {
    const focused = makeRepo('cross-other-error-focused');
    const other = makeRepo('cross-other-error');
    const target = addWorktree(other, 'feat/other-error');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/other-error' }]),
      worktreeOpenError: { error: { code: 'invalid_argument', message: 'unexpected flag' } },
      workspaceCreate: openReplyDoc('w2', 'w2:p1', target),
      extra: { HERDR_SHIM_OPEN_EXIT: '1' },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(focused));
      assert.equal(result.isError, true);
      assert.match(
        resultText(result),
        /'herdr worktree open' exited 1 \(\{"error":\{"code":"invalid_argument".*\}\) for /,
      );
      assert.ok(resultText(result).includes(target), resultText(result));
      assert.match(resultText(result), /no session was opened$/);
      assert.deepEqual(Object.keys(result.details), ['path', 'kind', 'branch']);
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('workspace create')).length, 0, 'no fallback panel');
      assert.equal(argv.filter((line) => line.startsWith('agent start')).length, 0, 'nothing started');
    } finally {
      restoreEnv();
    }
  });

  test('worktree_not_found for a path git no longer proves is a linked worktree still aborts', async () => {
    // The fallback is scoped to a path git STILL proves is a linked worktree
    // (S3). Here the failed open removes the worktree, so by the time the
    // fallback is considered git no longer proves that kind for this path: the
    // exact same `worktree_not_found` code must abort, never open a panel.
    const focused = makeRepo('cross-stale-focused');
    const other = makeRepo('cross-stale-other');
    const target = addWorktree(other, 'feat/stale');
    const errorDoc = { error: { code: 'worktree_not_found', message: 'worktree path not found' } };
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/stale' }]),
      worktreeOpenError: errorDoc,
      workspaceCreate: openReplyDoc('w2', 'w2:p1', target),
      extra: {
        HERDR_SHIM_OPEN_EXIT: '1',
        HERDR_STUB_WORKTREE_OPEN_REMOVE_REPO: other,
        HERDR_STUB_WORKTREE_OPEN_REMOVE: target,
      },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(focused));
      assert.equal(fs.existsSync(target), false, 'fixture: the worktree is gone before the fallback check');
      assert.equal(result.isError, true);
      assert.equal(
        resultText(result),
        `herdr session open failed: 'herdr worktree open' exited 1 (${JSON.stringify(errorDoc)}) for ${target}; no session was opened`,
      );
      assert.deepEqual(Object.keys(result.details), ['path', 'kind', 'branch']);
      assert.equal(result.details.kind, 'worktree');
      assert.equal('fallback' in result.details, false, 'a non-worktree path never reports a fallback');
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('workspace create')).length, 0, 'no fallback panel');
      assert.equal(argv.filter((line) => line.startsWith('agent start')).length, 0, 'nothing started');
    } finally {
      restoreEnv();
    }
  });

  test('worktree_not_found for a recreated directory inside a linked worktree still aborts', async () => {
    // The fallback is scoped to the path being the CHECKOUT ROOT of a linked
    // worktree (S3), not merely inside one. Nested linked worktrees make that
    // distinction real: the target is worktree B inside worktree A, both
    // linked. The failed open removes B and recreates the bare directory, so
    // git resolves B's containing repository to A — still a linked worktree,
    // but no longer B's checkout. The same `worktree_not_found` code must
    // abort, never open a panel.
    const focused = makeRepo('cross-recreated-focused');
    const other = makeRepo('cross-recreated-other');
    const outer = addWorktree(other, 'feat/recreated-outer');
    const target = track(path.join(outer, 'inner'));
    git(outer, ['worktree', 'add', '-b', 'feat/recreated-inner', target, 'HEAD']);
    const inner = fs.realpathSync(target);
    const errorDoc = { error: { code: 'worktree_not_found', message: 'worktree path not found' } };
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: inner, branch: 'feat/recreated-inner' }]),
      worktreeOpenError: errorDoc,
      workspaceCreate: openReplyDoc('w2', 'w2:p1', inner),
      extra: {
        HERDR_SHIM_OPEN_EXIT: '1',
        HERDR_STUB_WORKTREE_OPEN_REMOVE_REPO: other,
        HERDR_STUB_WORKTREE_OPEN_REMOVE: inner,
        HERDR_STUB_WORKTREE_OPEN_RECREATE: inner,
      },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: inner, notify: false }, makeCtx(focused));
      // Fixture: the directory exists again but is no longer a checkout — git
      // resolves it to the ENCLOSING linked worktree, which is the trap.
      assert.equal(fs.existsSync(inner), true, 'fixture: the directory was recreated');
      assert.equal(git(inner, ['rev-parse', '--show-toplevel']), outer, 'fixture: the target is inside another worktree');
      assert.equal(result.isError, true);
      assert.equal(
        resultText(result),
        `herdr session open failed: 'herdr worktree open' exited 1 (${JSON.stringify(errorDoc)}) for ${inner}; no session was opened`,
      );
      assert.deepEqual(Object.keys(result.details), ['path', 'kind', 'branch']);
      assert.equal(result.details.kind, 'worktree');
      assert.equal('fallback' in result.details, false, 'a non-worktree path never reports a fallback');
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('workspace create')).length, 0, 'no fallback panel');
      assert.equal(argv.filter((line) => line.startsWith('agent start')).length, 0, 'nothing started');
    } finally {
      restoreEnv();
    }
  });
});

describe('herdr_session_open path refusals', () => {
  test('a missing path is refused', async () => {
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, {}, makeCtx(os.tmpdir()));
      assert.equal(result.isError, true);
      assert.equal(
        resultText(result),
        'herdr_session_open requires a path: pass an existing directory (a Git worktree, a repository checkout, or any directory)',
      );
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('a path that does not exist is refused', async () => {
    const dir = tmp('hs-path-missing-');
    const ghost = path.join(dir, 'nope');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: ghost }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.equal(resultText(result), `herdr_session_open requires an existing directory: ${ghost}`);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('a path that is a file is refused', async () => {
    const dir = tmp('hs-path-file-');
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'x\n');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: file }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.equal(resultText(result), `herdr_session_open requires an existing directory: ${file}`);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('an agent name Herdr would reject is refused, starting nothing', async () => {
    const dir = makeDir('bad name target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w1', 'w1:p1', dir) }));
    try {
      const { tools } = await loadExtension();
      for (const name of ['-help', 'Bad Name', 'UPPER', '', 'a'.repeat(33)]) {
        const result = await callOpen(tools, { path: dir, name, notify: false }, makeCtx(dir));
        assert.equal(result.isError, true, `expected refusal for ${JSON.stringify(name)}`);
        assert.match(resultText(result), /invalid agent name/);
      }
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });
});

describe('herdr_session_open panel verification', () => {
  test('a root pane whose shell left the path is refused and starts nothing', async () => {
    const dir = makeDir('cwd target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      workspaceCreate: openReplyDoc('w1', 'w1:p1', path.dirname(dir)),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /outside/);
      assert.deepEqual(Object.keys(result.details), ['path', 'kind', 'branch', 'paneId', 'workspaceId']);
      assert.equal(result.details.paneId, 'w1:p1');
      assert.equal(result.details.workspaceId, 'w1');
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('an open reply naming a pane of another workspace is refused', async () => {
    const dir = makeDir('foreign pane target');
    const seq = agentSequence([agentDoc('idle', 'w2:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      workspaceCreate: openReplyDoc('w1', 'w2:p1', dir),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /does not belong to it/);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a root pane reporting another workspace is refused', async () => {
    const dir = makeDir('pane workspace target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      workspaceCreate: {
        result: {
          workspace: { workspace_id: 'w1' },
          root_pane: { pane_id: 'w1:p1', cwd: dir, workspace_id: 'w9' },
        },
      },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /root pane reports workspace 'w9'/);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('an open reply that names no workspace or pane is refused', async () => {
    const dir = makeDir('empty reply target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: { result: {} } }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /succeeded but its output named no workspace\/pane/);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a pane of another workspace is never chosen in the reuse path', async () => {
    const root = makeRepo('foreign-pane');
    const target = addWorktree(root, 'feat/foreign-pane');
    const seq = agentSequence([agentDoc('idle', 'w7:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/foreign-pane', open_workspace_id: 'w7' }]),
      paneList: paneListDoc([
        { pane_id: 'w8:p1', cwd: target },
        { pane_id: 'w7:p1', workspace_id: 'w7', cwd: target },
      ]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.paneId, 'w7:p1');
      assert.ok(!shimArgv(herdr.log).some((line) => line.includes('w8')));
    } finally {
      restoreEnv();
    }
  });

  test('two workspaces claiming one worktree fail closed and start nothing', async () => {
    const root = makeRepo('conflict');
    const target = addWorktree(root, 'feat/conflict');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([
        { path: target, branch: 'feat/conflict', open_workspace_id: 'w1' },
        { path: target, branch: 'feat/conflict', open_workspace_id: 'w2' },
      ]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /names 2 different workspaces/);
      assert.deepEqual(shimArgv(herdr.log), [`worktree list --cwd ${target}`]);
    } finally {
      restoreEnv();
    }
  });
});

describe('herdr_session_open herdr failures', () => {
  test('a failing worktree list names the call and its exit', async () => {
    const root = makeRepo('list-fail');
    const target = addWorktree(root, 'feat/list-fail');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, extra: { HERDR_SHIM_WORKTREE_LIST_EXIT: '1' } }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /'herdr worktree list' exited 1 \(shim worktree list failure\)/);
      assert.match(resultText(result), /no session was opened/);
    } finally {
      restoreEnv();
    }
  });

  test('a failing worktree open names the call and the path', async () => {
    const root = makeRepo('open-fail');
    const target = addWorktree(root, 'feat/open-fail');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: worktreeListDoc([{ path: target, branch: 'feat/open-fail' }]),
      extra: { HERDR_SHIM_OPEN_EXIT: '1' },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /'herdr worktree open' exited 1 \(shim worktree open failure\)/);
      assert.ok(resultText(result).includes(target));
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a failing workspace create names the call and its exit', async () => {
    const dir = makeDir('create-fail target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, extra: { HERDR_SHIM_WORKSPACE_CREATE_EXIT: '1' } }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /'herdr workspace create' exited 1 \(shim workspace create failure\)/);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a failing agent start names the call, the agent and the pane', async () => {
    const dir = makeDir('start-fail target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      workspaceCreate: openReplyDoc('w1', 'w1:p1', dir),
      extra: { HERDR_SHIM_AGENT_START_EXIT: '1' },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /'herdr agent start' exited 1 \(shim agent start failure\) for agent 'start-fail-target' in pane 'w1:p1'/);
    } finally {
      restoreEnv();
    }
  });
});

describe('herdr_session_open finish subscription', () => {
  test('idle after working delivers exactly one finished follow-up', async () => {
    const dir = makeDir('watch target');
    const seq = agentSequence([agentDoc('working', 'w1:p1'), agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w1', 'w1:p1', dir) }));
    let mod;
    try {
      const loaded = await loadExtension();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callOpen(tools, { path: dir }, makeCtx(dir));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.notify, true);
      await waitUntil(() => sent.length >= 1, 3000, 'the finished notification');
      assert.equal(sent.length, 1);
      const [message, options] = sent[0];
      assert.equal(message.customType, 'herdr-agent-sessions.finished');
      assert.equal(message.display, true);
      assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
      assert.match(message.content, /finished/);
      assert.ok(message.content.includes(dir));
      assert.ok(message.content.includes('w1:p1'));
      assert.equal(message.details.outcome, 'finished');
      assert.equal(message.details.path, dir);
      const polls = shimArgv(herdr.log).filter((line) => line.startsWith('agent get'));
      for (const line of polls) assert.equal(line, 'agent get w1:p1');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('notify:false starts no watcher at all', async () => {
    const dir = makeDir('no watch target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w1', 'w1:p1', dir) }));
    try {
      const { tools, sent } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, undefined, resultText(result));
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(sent, []);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent get')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a vanished pane is reported as vanished, never as a finish', async () => {
    const dir = makeDir('vanish target');
    const seq = agentSequence([{ error: { code: 'agent_not_found', message: 'agent target w1:p1 not found' } }]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, workspaceCreate: openReplyDoc('w1', 'w1:p1', dir) }));
    let mod;
    try {
      const loaded = await loadExtension();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callOpen(tools, { path: dir }, makeCtx(dir));
      assert.equal(result.isError, undefined, resultText(result));
      await waitUntil(() => sent.length >= 1, 3000, 'the vanished notification');
      assert.equal(sent[0][0].details.outcome, 'vanished');
      assert.ok(!/^worktree session finished:/.test(sent[0][0].content), sent[0][0].content);
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });
});

describe('herdr_session_open safety seams', () => {
  test('the harness refuses a possible live herdr instead of running it', async () => {
    const dir = makeDir('live refusal target');
    const seq = agentSequence([agentDoc('idle', 'w1:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      workspaceCreate: openReplyDoc('w1', 'w1:p1', dir),
      extra: { HERDR_BIN_PATH: '/usr/bin/false' },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { path: dir, notify: false }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /refusing to run live herdr/);
      assert.equal(result.details.herdrRefused, true);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('the argv builder is a closed allowlist: no trust bypass, no focus, no worktree branch', () => {
    const lib = require('../lib/herdr-session-open.js');
    assert.deepEqual(lib.herdrArgv('agent-get', { target: 'w1:p1' }), ['agent', 'get', 'w1:p1']);
    assert.deepEqual(lib.herdrArgv('open', { path: '/p', noFocus: true }), [
      'worktree', 'open', '--path', '/p', '--no-focus',
    ]);
    // `cwd` is what makes herdr resolve the worktree's OWN repository, so the
    // open operation accepts it beside path.
    assert.deepEqual(lib.herdrArgv('open', { path: '/p', cwd: '/p', noFocus: true }), [
      'worktree', 'open', '--path', '/p', '--cwd', '/p', '--no-focus',
    ]);
    assert.throws(() => lib.herdrArgv('open', { path: '/p', cwd: '/p', focus: true }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('open', { path: '/p', cwd: '/p', trustRepository: true }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('open', { path: '/p', cwd: '/p', label: 'x' }), /flag not allowed/);
    assert.deepEqual(lib.herdrArgv('workspace-create', { cwd: '/p', noFocus: true }), [
      'workspace', 'create', '--cwd', '/p', '--no-focus',
    ]);
    assert.throws(() => lib.herdrArgv('open', { trustRepository: true }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('open', { branch: 'b' }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('workspace-create', { cwd: '/p', focus: true }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('workspace-create', { cwd: '/p', label: 'x' }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('remove', { workspace: 'w1' }), /unknown herdr operation/);
    assert.throws(() => lib.herdrArgv('agent-start', { name: '', kind: 'pi', pane: 'p', timeout: '1', agentArgs: [] }), /invalid value/);
  });

  test('the agent name deriver produces names Herdr accepts', () => {
    const lib = require('../lib/herdr-session-open.js');
    const cases = [
      ['/tmp/My Project', 'my-project'],
      ['/tmp/3rd thing', 'p3rd-thing'],
      ['/srv/app_v2', 'app-v2'],
      ['/', 'pi'],
      ['/tmp/hs-path-generic-abc123', 'hs-path-generic-abc123'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(lib.agentNameForPath(input), expected, `derived from ${input}`);
    }
    assert.equal(lib.agentNameForPath('/tmp/x'.padEnd(40, 'y')).length <= 32, true);
    for (const value of ['my-project', 'p3rd-thing', 'a'.repeat(32)]) {
      assert.equal(lib.validAgentName(value), true, value);
    }
    for (const value of ['', '-x', 'UPPER', 'a'.repeat(33), 'bad name', 'x.y']) {
      assert.equal(lib.validAgentName(value), false, value);
    }
  });
});
