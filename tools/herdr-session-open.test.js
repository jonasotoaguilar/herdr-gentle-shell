'use strict';
// `worktree_session_open` — the one worktree tool this package keeps
// (odd/tasks/split-odd-worktree.md S6, T5).
//
// The extension is plain JavaScript under a .ts name (// @ts-nocheck), the
// same loading pattern tools/gentle-herdr-state.test.js uses: copy the source
// to a temporary .mjs with the two package imports stubbed, import it, and
// drive the tool through its public `execute`. Every test builds its own
// fixture repository under os.tmpdir() (real `git init` plus
// `git worktree add`), a stub `herdr` reached through HERDR_BIN_PATH, and
// asserts only observable behavior: result text, details, the argv the stub
// observed, and the files left untouched. No test reaches a live Herdr.
//
// The registry fixture is written where the public contract puts it: a
// `pi-worktrees.json` beside the repository's git common dir.

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

function makeRepo(tag) {
  const dir = tmp(`hs-open-${tag}-`);
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function writeRegistry(root, rows) {
  fs.writeFileSync(
    path.join(root, '.git', 'pi-worktrees.json'),
    `${JSON.stringify({ version: 1, worktrees: rows }, null, 2)}\n`,
  );
}

function slugify(branch) {
  const slug = String(branch).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'worktree' : slug;
}

function addRegistered(root, branch) {
  const target = track(path.join(path.dirname(root), `${path.basename(root)}-wt-${slugify(branch)}`));
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  writeRegistry(root, [{ branch, path: target }]);
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
  const dir = tmp('hs-open-herdr-');
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
      '  if [ "${HERDR_SHIM_OPEN_EXIT:-0}" != "0" ]; then echo "shim worktree open failure" >&2; exit 1; fi',
      '  cat "$HERDR_STUB_WORKTREE_OPEN"; exit 0',
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
  const dir = tmp('hs-open-agentseq-');
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

function workspaceListDoc(target, branch, { workspaceId } = {}) {
  const entry = { path: target, branch };
  if (workspaceId !== undefined) entry.open_workspace_id = workspaceId;
  return { result: { worktrees: [entry] } };
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
// `worktree list` per invocation (1.json, 2.json, …) and falls back to
// `worktreeList` once the sequence runs out.
function worldEnv({ herdr, worktreeList, worktreeOpen, paneList, seq, listSequence, extra }) {
  const dir = tmp('hs-open-fixtures-');
  const listDir = listSequence ? tmp('hs-open-listseq-') : null;
  if (listDir) {
    listSequence.forEach((doc, index) => writeJson(listDir, `${index + 1}.json`, doc));
    fs.writeFileSync(path.join(listDir, 'count'), '0\n');
  }
  return {
    GENTLE_HERDR_SESSION_LIB_DIR: LIB_DIR,
    GENTLE_WORKTREE_LIB_DIR: undefined,
    HERDR_BIN_PATH: herdr.bin,
    HERDR_SHIM_LOG: herdr.log,
    HERDR_STUB_LIST_DIR: listDir || undefined,
    HERDR_STUB_LIST_COUNT: listDir ? path.join(listDir, 'count') : undefined,
    HERDR_STUB_WORKTREE_LIST: worktreeList ? writeJson(dir, 'worktree-list.json', worktreeList)
      : writeJson(dir, 'worktree-list.json', { result: { worktrees: [] } }),
    HERDR_STUB_WORKTREE_OPEN: worktreeOpen ? writeJson(dir, 'worktree-open.json', worktreeOpen)
      : writeJson(dir, 'worktree-open.json', {}),
    HERDR_STUB_PANE_LIST: paneList ? writeJson(dir, 'pane-list.json', paneList)
      : writeJson(dir, 'pane-list.json', { result: { panes: [] } }),
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
  const dir = tmp('hs-open-ext-');
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

function makeCtx(repoRoot) {
  return {
    cwd: repoRoot,
    hasUI: false,
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: { confirm: async () => true, notify: () => {} },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

function openRows({ outcome = 'opened', worktree, branch, path: target, session, workspace, pane, agent }) {
  const rows = [`outcome: ${outcome}`, `worktree: ${worktree}`, `branch: ${branch}`, `path: ${target}`, `session: ${session}`];
  if (workspace) rows.push(`workspace: ${workspace}`);
  if (pane) rows.push(`pane: ${pane}`);
  if (agent) rows.push(`agent: ${agent}`);
  return rows;
}

function openTool(tools) {
  const tool = tools.get('worktree_session_open');
  assert.ok(tool, 'expected worktree_session_open to be registered');
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

describe('worktree_session_open registration', () => {
  test('is the only tool the extension registers, with the four documented params', async () => {
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      assert.deepEqual([...tools.keys()], ['worktree_session_open']);
      const params = openTool(tools).parameters;
      assert.deepEqual(Object.keys(params.properties).sort(), ['name', 'notify', 'session', 'worktree']);
      assert.equal(params.properties.worktree.type, 'string');
      assert.equal(params.properties.session.type, 'string');
      assert.equal(params.properties.name.type, 'string');
      assert.equal(params.properties.notify.type, 'boolean');
      assert.equal(params.properties.notify.optional, true);
      assert.equal(openTool(tools).label, 'Worktree Session Open');
    } finally {
      restoreEnv();
    }
  });

  test('package.json declares the opener beside the state sidecar', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    assert.deepEqual(pkg.pi.extensions.slice().sort(), [
      './extensions/gentle-herdr-state.ts',
      './extensions/herdr-session-open.ts',
    ]);
    for (const rel of pkg.pi.extensions) {
      assert.ok(fs.existsSync(path.resolve(__dirname, '..', rel)), `missing extension ${rel}`);
    }
  });
});

describe('worktree_session_open scope guard', () => {
  test('a directory outside a git repository is refused', async () => {
    const dir = tmp('hs-open-nogit-');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-anything' }, makeCtx(dir));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /not a git repository/);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('an unknown name fails closed naming the known ones, invoking nothing', async () => {
    const root = makeRepo('unknown');
    addRegistered(root, 'feat/known');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-nope' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /no registered worktree for "feat-nope"/);
      assert.ok(resultText(result).includes('feat-known'), resultText(result));
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('a live checkout no registry row owns is refused and changes nothing', async () => {
    const root = makeRepo('unregistered');
    const target = track(path.join(path.dirname(root), `${path.basename(root)}-ghost`));
    git(root, ['worktree', 'add', '-b', 'feat/ghost', target, 'HEAD']);
    writeRegistry(root, []);
    const beforeLive = git(root, ['worktree', 'list', '--porcelain']);
    const beforeRegistry = fs.readFileSync(path.join(root, '.git', 'pi-worktrees.json'), 'utf8');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-ghost' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.equal(
        resultText(result),
        `no registered worktree for "feat-ghost": 'feat/ghost' at ${fs.realpathSync(target)} is unregistered, and worktree_session_open only opens a registered worktree`,
      );
      assert.deepEqual(shimArgv(herdr.log), []);
      assert.equal(git(root, ['worktree', 'list', '--porcelain']), beforeLive);
      assert.equal(fs.readFileSync(path.join(root, '.git', 'pi-worktrees.json'), 'utf8'), beforeRegistry);
    } finally {
      restoreEnv();
    }
  });

  test('the principal checkout is refused: a session there delegates nothing', async () => {
    const root = makeRepo('principal');
    addRegistered(root, 'feat/other');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'principal' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /principal checkout/);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('a registered row whose checkout is gone is refused as not live', async () => {
    const root = makeRepo('stale');
    const target = addRegistered(root, 'feat/stale');
    fs.rmSync(target, { recursive: true, force: true });
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-stale' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /no live worktree for "feat-stale"/);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('an explicit or relative path is refused before any backend runs', async () => {
    const root = makeRepo('relpath');
    addRegistered(root, 'feat/real');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      for (const value of ['../outside', './local', '/tmp/hs-open-foreign']) {
        const result = await callOpen(tools, { worktree: value }, makeCtx(root));
        assert.equal(result.isError, true, `expected refusal: ${value}`);
        assert.equal(
          resultText(result),
          `worktree session open refuses ${JSON.stringify(value)}: pass the worktree NAME 'worktree list' prints, not a path`,
        );
      }
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('two rows that slug to one name are ambiguous, and the refusal names both forms that resolve', async () => {
    const root = makeRepo('ambiguous');
    const first = addRegistered(root, 'feat/dup');
    const second = track(path.join(path.dirname(root), `${path.basename(root)}-wt-dup-second`));
    git(root, ['worktree', 'add', '-b', 'feat-dup', second, 'HEAD']);
    fs.writeFileSync(
      path.join(root, '.git', 'pi-worktrees.json'),
      `${JSON.stringify({
        version: 1,
        worktrees: [{ branch: 'feat/dup', path: first }, { branch: 'feat-dup', path: second }],
      })}\n`,
    );
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-dup' }, makeCtx(root));
      assert.equal(result.isError, true);
      // Both spellings resolve, so the advice must name both of them.
      assert.equal(
        resultText(result),
        `worktree name "feat-dup" is ambiguous: 'feat/dup' at ${first}, 'feat-dup' at ${fs.realpathSync(second)}; pass the path or branch instead`,
      );
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('a malformed registry is a refusal, never an empty registry', async () => {
    const root = makeRepo('bad-registry');
    const target = track(path.join(path.dirname(root), `${path.basename(root)}-wt-broken`));
    git(root, ['worktree', 'add', '-b', 'feat/broken', target, 'HEAD']);
    fs.writeFileSync(path.join(root, '.git', 'pi-worktrees.json'), '{ not json');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-broken' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /cannot read worktree registry: malformed registry/);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('the absolute path of a registered worktree resolves to its row', async () => {
    const root = makeRepo('abspath');
    const target = addRegistered(root, 'feat/real');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/real', { workspaceId: 'ws-abs' }),
      paneList: paneListDoc([{ pane_id: 'ws-abs:p1', cwd: target }]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: target, notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.worktree, 'feat-real');
      assert.equal(result.details.path, target);
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open opening a session', () => {
  test('a new session opens the workspace and starts Pi with the allowlisted argv', async () => {
    const root = makeRepo('create');
    const target = addRegistered(root, 'feat/fresh');
    const seq = agentSequence([agentDoc('idle', 'ws-new:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/fresh'),
      worktreeOpen: openReplyDoc('ws-new', 'ws-new:p1', target),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-fresh', notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      const sessionId = result.details.sessionId;
      assert.match(sessionId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(resultText(result).split('\n'), openRows({
        worktree: 'feat-fresh',
        branch: 'feat/fresh',
        path: target,
        session: sessionId,
        workspace: 'ws-new',
        pane: 'ws-new:p1',
        agent: 'feat-fresh',
      }));
      assert.deepEqual(Object.keys(result.details).sort(), [
        'agentName', 'branch', 'notify', 'paneId', 'path', 'resumed', 'sessionId', 'workspaceId', 'worktree',
      ]);
      assert.equal(result.details.resumed, false);
      assert.equal(result.details.notify, false);
      const argv = shimArgv(herdr.log);
      assert.equal(argv[0], `worktree list --cwd ${root}`);
      assert.equal(argv[1], `worktree open --branch feat/fresh --cwd ${root} --no-focus`);
      assert.equal(argv[2], `agent start feat-fresh --kind pi --pane ws-new:p1 --timeout 120000 -- --name feat-fresh --session-id ${sessionId}`);
      for (const line of argv) {
        assert.ok(!line.includes('--session-dir'), `never --session-dir: ${line}`);
        assert.ok(!line.includes('--trust-repository'), `never --trust-repository: ${line}`);
        assert.ok(!/(^| )--focus( |$)/.test(line), `never --focus: ${line}`);
      }
    } finally {
      restoreEnv();
    }
  });

  test('a resume passes --session and never mints a session id', async () => {
    const root = makeRepo('resume');
    const target = addRegistered(root, 'feat/resume');
    const seq = agentSequence([agentDoc('idle', 'ws-re:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/resume', { workspaceId: 'ws-re' }),
      paneList: paneListDoc([{ pane_id: 'ws-re:p1', cwd: target }]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-resume', session: 'abc123', notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.sessionId, 'abc123');
      assert.equal(result.details.resumed, true);
      assert.deepEqual(resultText(result).split('\n'), openRows({
        outcome: 'resumed',
        worktree: 'feat-resume',
        branch: 'feat/resume',
        path: target,
        session: 'abc123',
        workspace: 'ws-re',
        pane: 'ws-re:p1',
        agent: 'feat-resume',
      }));
      const argv = shimArgv(herdr.log);
      const starts = argv.filter((line) => line.startsWith('agent start'));
      assert.deepEqual(starts, [
        'agent start feat-resume --kind pi --pane ws-re:p1 --timeout 120000 -- --name feat-resume --session abc123',
      ]);
      assert.equal(argv.filter((line) => line.includes('--session-id')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('an already-open workspace reuses its root pane and never opens another workspace', async () => {
    const root = makeRepo('reuse');
    const target = addRegistered(root, 'feat/reuse');
    const seq = agentSequence([agentDoc('idle', 'ws-reuse:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/reuse', { workspaceId: 'ws-reuse' }),
      paneList: paneListDoc([
        { pane_id: 'ws-reuse:p2', cwd: target },
        { pane_id: 'ws-reuse:p1', cwd: target },
      ]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-reuse', notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.paneId, 'ws-reuse:p1', 'the root pane is the lowest index');
      const argv = shimArgv(herdr.log);
      assert.equal(argv.filter((line) => line.startsWith('worktree open')).length, 0);
      assert.equal(argv[1], 'pane list --workspace ws-reuse');
    } finally {
      restoreEnv();
    }
  });

  test('two workspaces claiming one worktree fail closed and start nothing', async () => {
    const root = makeRepo('conflict');
    const target = addRegistered(root, 'feat/conflict');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: {
        result: {
          worktrees: [
            { path: target, branch: 'feat/conflict', open_workspace_id: 'ws-a' },
            { path: target, branch: 'feat/conflict', open_workspace_id: 'ws-b' },
          ],
        },
      },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-conflict', notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /names 2 different workspaces/);
      assert.deepEqual(shimArgv(herdr.log), [`worktree list --cwd ${root}`]);
    } finally {
      restoreEnv();
    }
  });

  test('a root pane whose shell left the worktree is refused, starting nothing', async () => {
    const root = makeRepo('pane-cwd');
    const target = addRegistered(root, 'feat/pane-cwd');
    const seq = agentSequence([agentDoc('idle', 'ws-away:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/pane-cwd', { workspaceId: 'ws-away' }),
      paneList: paneListDoc([{ pane_id: 'ws-away:p1', cwd: path.dirname(target) }]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-pane-cwd', notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /outside the worktree/);
      // The details key order is part of the published shape a caller reads.
      assert.deepEqual(Object.keys(result.details), ['worktree', 'branch', 'path', 'paneId', 'workspaceId']);
      assert.equal(result.details.paneId, 'ws-away:p1');
      assert.equal(result.details.workspaceId, 'ws-away');
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a workspace recovered after a failed open keeps the same refusal shape', async () => {
    const root = makeRepo('relist-cwd');
    const target = addRegistered(root, 'feat/relist-cwd');
    const seq = agentSequence([agentDoc('idle', 'ws-relist:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      // 1: no workspace yet (so the opener opens one), 2: `worktree open`
      // failed but the workspace appeared anyway.
      listSequence: [
        workspaceListDoc(target, 'feat/relist-cwd'),
        workspaceListDoc(target, 'feat/relist-cwd', { workspaceId: 'ws-relist' }),
      ],
      paneList: paneListDoc([{ pane_id: 'ws-relist:p1', cwd: path.dirname(target) }]),
      extra: { HERDR_SHIM_OPEN_EXIT: '1' },
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-relist-cwd', notify: false }, makeCtx(root));
      assert.equal(result.isError, true, resultText(result));
      // Same refusal text and details shape as the reuse path: the workspace
      // appeared after the failed open, so this is the reuse branch now.
      assert.equal(
        resultText(result),
        `worktree session open failed: the root pane 'ws-relist:p1' of workspace 'ws-relist' has cwd ${path.dirname(target)}, outside the worktree ${target}; a session started there would not be in the worktree. Close that pane or open the worktree in a fresh workspace`,
      );
      assert.deepEqual(Object.keys(result.details), ['worktree', 'branch', 'path', 'paneId', 'workspaceId']);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a pane of another workspace is never used, even when herdr lists it first', async () => {
    const root = makeRepo('foreign-pane');
    const target = addRegistered(root, 'feat/foreign-pane');
    const seq = agentSequence([agentDoc('idle', 'ws-ours:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/foreign-pane', { workspaceId: 'ws-ours' }),
      paneList: paneListDoc([
        { pane_id: 'ws-theirs:p1', cwd: target },
        { pane_id: 'ws-ours:p1', workspace_id: 'ws-ours', cwd: target },
      ]),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-foreign-pane', notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.paneId, 'ws-ours:p1');
      assert.ok(!shimArgv(herdr.log).some((line) => line.includes('ws-theirs')));
    } finally {
      restoreEnv();
    }
  });

  test('an agent name herdr would read as an option is refused, starting nothing', async () => {
    const root = makeRepo('bad-name');
    const target = addRegistered(root, 'feat/bad-name');
    const seq = agentSequence([agentDoc('idle', 'ws-bad:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/bad-name', { workspaceId: 'ws-bad' }),
      paneList: paneListDoc([{ pane_id: 'ws-bad:p1', cwd: target }]),
    }));
    try {
      const { tools } = await loadExtension();
      for (const name of ['--help', '', 'bad name']) {
        const result = await callOpen(tools, { worktree: 'feat-bad-name', name, notify: false }, makeCtx(root));
        assert.equal(result.isError, true, `expected refusal for ${JSON.stringify(name)}`);
        assert.match(resultText(result), /invalid agent name/);
      }
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('an open reply naming a pane of another workspace is refused', async () => {
    const root = makeRepo('open-foreign-pane');
    const target = addRegistered(root, 'feat/open-foreign');
    const seq = agentSequence([agentDoc('idle', 'ws-theirs:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/open-foreign'),
      worktreeOpen: openReplyDoc('ws-open', 'ws-theirs:p1', target),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-open-foreign', notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /pane 'ws-theirs:p1', which does not belong to it/);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('an open reply whose pane cwd is outside the worktree is refused', async () => {
    const root = makeRepo('open-foreign-cwd');
    const target = addRegistered(root, 'feat/open-foreign-cwd');
    const seq = agentSequence([agentDoc('idle', 'ws-out:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/open-foreign-cwd'),
      worktreeOpen: openReplyDoc('ws-out', 'ws-out:p1', path.dirname(target)),
    }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-open-foreign-cwd', notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /has cwd .*outside the worktree/);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a failing herdr call is reported with the call name and exit status', async () => {
    const root = makeRepo('list-fail');
    addRegistered(root, 'feat/fail');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, extra: { HERDR_SHIM_WORKTREE_LIST_EXIT: '1' } }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-fail', notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /'herdr worktree list' exited 1 \(shim worktree list failure\)/);
      assert.match(resultText(result), /no session was opened/);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent start')).length, 0);
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open finish subscription', () => {
  test('idle after working delivers exactly one finished follow-up', async () => {
    const root = makeRepo('watch');
    const target = addRegistered(root, 'feat/watch');
    const seq = agentSequence([agentDoc('working', 'ws-watch:p1'), agentDoc('idle', 'ws-watch:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/watch', { workspaceId: 'ws-watch' }),
      paneList: paneListDoc([{ pane_id: 'ws-watch:p1', cwd: target }]),
    }));
    let mod;
    try {
      const loaded = await loadExtension();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callOpen(tools, { worktree: 'feat-watch' }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      assert.equal(result.details.notify, true);
      await waitUntil(() => sent.length >= 1, 3000, 'the finished notification');
      assert.equal(sent.length, 1);
      const [message, options] = sent[0];
      assert.equal(message.customType, 'herdr-agent-sessions.finished');
      assert.equal(message.display, true);
      assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
      assert.match(message.content, /finished/);
      assert.ok(message.content.includes('feat-watch'));
      assert.ok(message.content.includes('ws-watch:p1'));
      assert.ok(message.content.includes(result.details.sessionId));
      assert.equal(message.details.outcome, 'finished');
      assert.equal(message.details.worktree, 'feat-watch');
      const polls = shimArgv(herdr.log).filter((line) => line.startsWith('agent get'));
      assert.ok(polls.length >= 2, `polls past working to idle: ${polls.length}`);
      for (const line of polls) assert.equal(line, 'agent get ws-watch:p1');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('notify:false starts no watcher at all', async () => {
    const root = makeRepo('nowatch');
    const target = addRegistered(root, 'feat/nowatch');
    const seq = agentSequence([agentDoc('idle', 'ws-now:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/nowatch', { workspaceId: 'ws-now' }),
      paneList: paneListDoc([{ pane_id: 'ws-now:p1', cwd: target }]),
    }));
    try {
      const { tools, sent } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-nowatch', notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, resultText(result));
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(sent, []);
      assert.equal(shimArgv(herdr.log).filter((line) => line.startsWith('agent get')).length, 0);
    } finally {
      restoreEnv();
    }
  });

  test('a vanished pane is reported as vanished, never as a finish', async () => {
    const root = makeRepo('vanish');
    const target = addRegistered(root, 'feat/vanish');
    const seq = agentSequence([{ error: { code: 'agent_not_found', message: 'agent target ws-van:p1 not found' } }]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({
      herdr,
      seq,
      worktreeList: workspaceListDoc(target, 'feat/vanish', { workspaceId: 'ws-van' }),
      paneList: paneListDoc([{ pane_id: 'ws-van:p1', cwd: target }]),
    }));
    let mod;
    try {
      const loaded = await loadExtension();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callOpen(tools, { worktree: 'feat-vanish' }, makeCtx(root));
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

describe('worktree_session_open safety seams', () => {
  test('the harness refuses a possible live herdr instead of running it', async () => {
    const root = makeRepo('live-refusal');
    addRegistered(root, 'feat/live');
    const seq = agentSequence([agentDoc('idle', 'ws:p1')]);
    const herdr = makeHerdrStub();
    setEnv(worldEnv({ herdr, seq, extra: { HERDR_BIN_PATH: '/usr/bin/false' } }));
    try {
      const { tools } = await loadExtension();
      const result = await callOpen(tools, { worktree: 'feat-live', notify: false }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /refusing to run live herdr/);
      assert.equal(result.details.herdrRefused, true);
      assert.deepEqual(shimArgv(herdr.log), []);
    } finally {
      restoreEnv();
    }
  });

  test('the argv builder is a closed allowlist', () => {
    const lib = require('../lib/herdr-session-open.js');
    assert.deepEqual(lib.herdrArgv('agent-get', { target: 'ws:p1' }), ['agent', 'get', 'ws:p1']);
    assert.deepEqual(lib.herdrArgv('open', { branch: 'b', cwd: '/r', noFocus: true }), [
      'worktree', 'open', '--branch', 'b', '--cwd', '/r', '--no-focus',
    ]);
    assert.throws(() => lib.herdrArgv('remove', { workspace: 'ws' }), /unknown herdr operation/);
    assert.throws(() => lib.herdrArgv('open', { trustRepository: true }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('agent-start', { name: 'a', kind: 'pi', pane: 'p', timeout: '1', agentArgs: ['--x'], focus: true }), /flag not allowed/);
    assert.throws(() => lib.herdrArgv('agent-start', { name: '', kind: 'pi', pane: 'p', timeout: '1', agentArgs: [] }), /invalid value/);
    assert.throws(() => lib.herdrArgv('agent-start', { name: 'a', kind: 'pi', pane: 'p', timeout: '1', agentArgs: ['--session-dir', '/tmp'] , pre: true }), /flag not allowed/);
  });
});
