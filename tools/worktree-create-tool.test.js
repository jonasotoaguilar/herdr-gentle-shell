'use strict';
// S1: the agent tool is `worktree_create` and it only creates.
//
// The tool takes the branch and nothing else. Worktrees no longer receive
// issues or odd documents, so the schema exposes no association field, a
// call that still sends one creates the checkout and records nothing, and
// an existing live checkout for the branch is never updated through this
// path.
//
// Loading pattern mirrors tools/worktree-create.test.js: the TypeScript
// extension is plain JS under the hood, so the test copies it to a
// temporary .mjs path with exactly the two package import lines stubbed and
// import()s it with a fake `pi`. Every fixture lives under os.tmpdir().

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

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

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-create-tool-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  const real = fs.realpathSync(dir);
  // The tool builds its checkouts beside the fixture root
  // (`<root>-worktrees/<slug>`), so that sibling directory is tracked too:
  // otherwise every created worktree outlives the suite in the temp root.
  track(path.join(path.dirname(real), `${path.basename(real)}-worktrees`));
  return real;
}

// Stub `herdr` that logs argv and materializes the checkout with real git.
function makeHerdrStub() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-herdr-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$HERDR_SHIM_LOG"',
      'if [ "$1" = "worktree" ] && [ "$2" = "create" ]; then',
      '  shift 2',
      '  branch=""; base=""; wtpath=""; cwd=""',
      '  while [ $# -gt 0 ]; do',
      '    case "$1" in',
      '      --branch) branch="$2"; shift 2;;',
      '      --base) base="$2"; shift 2;;',
      '      --path) wtpath="$2"; shift 2;;',
      '      --cwd) cwd="$2"; shift 2;;',
      '      *) shift;;',
      '    esac',
      '  done',
      '  [ -n "$branch" ] && [ -n "$wtpath" ] && [ -n "$cwd" ] || { echo "missing args" >&2; exit 1; }',
      '  exec git -C "$cwd" worktree add -b "$branch" "$wtpath" "$base"',
      'fi',
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, log: path.join(dir, 'herdr-argv.log') };
}

function expectedTarget(root, slug) {
  return path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

const savedEnv = { ...process.env };

// Deterministic creation-hook binary (S6): the create result reports the
// CodeGraph status visibly, so no test may depend on whether the developer
// happens to have `codegraph` on PATH. The stub logs every call and exits
// with $CODEGRAPH_EXIT (0 unless a test says otherwise).
const HOOK_BIN = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-hookbin-')));
const CODEGRAPH_LOG = path.join(HOOK_BIN, 'codegraph.log');
fs.writeFileSync(
  path.join(HOOK_BIN, 'codegraph'),
  [
    '#!/bin/sh',
    'printf \'%s %s\\n\' "$1" "$PWD" >> "$CODEGRAPH_LOG"',
    'exit "${CODEGRAPH_EXIT:-0}"',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

function codegraphCalls() {
  try {
    return fs.readFileSync(CODEGRAPH_LOG, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function resetCodegraphCalls() {
  fs.writeFileSync(CODEGRAPH_LOG, '');
}

// The developer's own PATH may hold a real `codegraph`: the skipped case must
// not depend on it, so every dir that carries one is dropped.
function pathWithoutCodegraph() {
  return process.env.PATH.split(path.delimiter)
    .filter((dir) => dir.length > 0 && !fs.existsSync(path.join(dir, 'codegraph')))
    .join(path.delimiter);
}

// A lib dir with every helper EXCEPT the card renderer (A6): the create must
// keep its CodeGraph status line even when rendering cannot load.
function libDirWithoutCard() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-nocard-')));
  for (const entry of fs.readdirSync(LIB_DIR)) {
    if (entry === 'worktree-card.js' || !entry.endsWith('.js')) continue;
    fs.symlinkSync(path.join(LIB_DIR, entry), path.join(dir, entry));
  }
  assert.equal(fs.existsSync(path.join(dir, 'worktree-card.js')), false, 'the card renderer is genuinely absent');
  return dir;
}

function setEnv(vars) {
  const env = { PATH: `${HOOK_BIN}${path.delimiter}${process.env.PATH || ''}`, CODEGRAPH_LOG, ...vars };
  if (!('GENTLE_STATUS_STATE_DIR' in env)) {
    env.GENTLE_STATUS_STATE_DIR = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-mode-')));
  }
  for (const [key, value] of Object.entries(env)) {
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

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

function makeCtx({ repoRoot, thread = 'thread-1' }) {
  return {
    cwd: repoRoot,
    hasUI: false,
    mode: 'tui',
    sessionManager: { getSessionId: () => thread },
    ui: { confirm: async () => true, notify: () => {} },
  };
}

function registryRows(root) {
  const registry = require(path.join(LIB_DIR, 'worktree-registry.js'));
  const read = registry.readRegistry(root);
  return read.ok ? read.worktrees : [];
}

describe('worktree_create tool contract (S1)', { concurrency: false }, () => {
  test('registers worktree_create with only the branch parameter', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const tools = await loadExtension();
      assert.ok(tools.has('worktree_create'), 'worktree_create is registered');
      assert.ok(!tools.has('worktree_upsert'), 'the old upsert name is not registered');
      const tool = tools.get('worktree_create');
      assert.equal(tool.label, 'Worktree Create');
      assert.match(tool.description, /creat/i);
      assert.doesNotMatch(tool.description, /create or update/i, 'the tool never claims an update path');
      assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['branch']);
    } finally {
      restoreEnv();
    }
  });

  test('creates the checkout for the branch and records no associations', async () => {
    const root = makeRepo('plain');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/simple' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined);
      assert.equal(
        resultText(result),
        `created: feat-simple \u00B7 feat/simple\npath: ${expectedTarget(root, 'feat-simple')}\nregistered: new\ncodegraph: initialized`,
        'the create text names the checkout, its path, the registry write and the codegraph status, never an association',
      );
      assert.equal('issues' in result.details, false, 'details carry no issues');
      assert.equal('odd' in result.details, false, 'details carry no odd');
      assert.equal('created' in result.details, false, 'the outcome field is retired: create is the only operation');
      assert.equal(result.details.registered, 'new', 'the registry write is reported as the row it wrote');
      assert.deepEqual(result.details.codegraph, { status: 'done', detail: '' }, 'the visible status reports the hook step');
      assert.equal(codegraphCalls().length, 1, 'codegraph init ran exactly once, during creation');
      const row = registryRows(root).find((entry) => entry.branch === 'feat/simple');
      assert.ok(row, 'the checkout is registered');
      assert.deepEqual(row.issues, [], 'no issue is recorded');
      assert.equal(row.odd, null, 'no odd document is recorded');
    } finally {
      restoreEnv();
    }
  });

  test('the visible status reports a skipped codegraph init instead of claiming one', async () => {
    const root = makeRepo('cg-skip');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      // The hook looks `codegraph` up on PATH: a PATH without it reads as absent.
      PATH: pathWithoutCodegraph(),
    });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/cg-skip' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, 'a skipped hook never fails the create');
      assert.deepEqual(resultText(result).split('\n'), [
        'created: feat-cg-skip \u00B7 feat/cg-skip',
        `path: ${expectedTarget(root, 'feat-cg-skip')}`,
        'registered: new',
        'codegraph: not initialized (codegraph not on PATH)',
      ]);
      assert.deepEqual(result.details.codegraph, { status: 'skipped', detail: 'codegraph not on PATH' });
    } finally {
      restoreEnv();
    }
  });

  test('a failed codegraph init stays visible without failing the create', async () => {
    const root = makeRepo('cg-fail');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      CODEGRAPH_EXIT: '1',
    });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/cg-fail' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, 'a failed hook never turns the create into an error');
      assert.deepEqual(resultText(result).split('\n').slice(0, 4), [
        'created: feat-cg-fail \u00B7 feat/cg-fail',
        `path: ${expectedTarget(root, 'feat-cg-fail')}`,
        'registered: new',
        'codegraph: not initialized (init failed)',
      ]);
      assert.ok(
        resultText(result).split('\n').slice(4).every((line) => line.startsWith('warning: ')),
        `only summarized warnings follow the create rows: ${resultText(result)}`,
      );
      assert.deepEqual(result.details.codegraph, { status: 'failed', detail: 'init failed' });
      assert.ok(
        result.details.warnings.some((line) => /codegraph-init: codegraph init failed/.test(line)),
        `the failure reason stays in the warnings: ${JSON.stringify(result.details.warnings)}`,
      );
    } finally {
      restoreEnv();
    }
  });

  test('a repeat call reports the existing checkout without running codegraph again', async () => {
    const root = makeRepo('repeat-status');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const ctx = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const first = await tools.get('worktree_create').execute('c1', { branch: 'feat/repeat' }, undefined, undefined, ctx);
      assert.equal(first.isError, undefined);
      assert.equal(codegraphCalls().length, 1);
      const second = await tools.get('worktree_create').execute('c2', { branch: 'feat/repeat' }, undefined, undefined, ctx);
      assert.equal(second.isError, undefined);
      assert.deepEqual(resultText(second).split('\n'), [
        'created: feat-repeat \u00B7 feat/repeat \u00B7 already exists',
        `path: ${expectedTarget(root, 'feat-repeat')}`,
        'registered: unchanged',
        'codegraph: not initialized',
      ], 'the repeat call says the checkout already existed, writes no row and reports the index the checkout really has');
      assert.equal(second.details.registered, 'unchanged', 'the registry was not written again');
      assert.deepEqual(second.details.codegraph, { status: 'absent', detail: '' }, 'the index state is a real reading');
      assert.equal(second.details.alreadyExists, true, 'the visible fact is stated, not inferred from an outcome enum');
      assert.equal('created' in second.details, false, 'the redundant created/updated outcome field stays retired');
      assert.equal(codegraphCalls().length, 1, 'codegraph init is never re-run for the existing checkout');
      assert.equal('alreadyExists' in first.details, false, 'a real creation carries no such marker');
      assert.equal(first.details.registered, 'new', 'the first call wrote the row');
    } finally {
      restoreEnv();
    }
  });

  test('the codegraph status survives a missing card renderer (A6)', async () => {
    // The status is part of the tool output contract, not of rendering: when
    // lib/worktree-card.js cannot load, the create still reports what the
    // hook did instead of silently dropping the line.
    const root = makeRepo('no-card');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: libDirWithoutCard(),
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/no-card' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'created: feat-no-card \u00B7 feat/no-card',
        `path: ${expectedTarget(root, 'feat-no-card')}`,
        'registered: new',
        'codegraph: initialized',
      ], 'the status line is never lost with the renderer');
      assert.deepEqual(result.details.codegraph, { status: 'done', detail: '' });
      // The same fallback formats a non-default status with the identical
      // wording the card lib uses, so a missing renderer cannot change what
      // the agent reads.
      process.env.CODEGRAPH_EXIT = '1';
      const failed = await tools.get('worktree_create').execute(
        'c2', { branch: 'feat/no-card-fail' }, undefined, undefined, makeCtx({ repoRoot: root, thread: 'thread-2' }),
      );
      assert.equal(failed.isError, undefined, 'a failed hook never fails the create');
      assert.deepEqual(failed.details.codegraph, { status: 'failed', detail: 'init failed' });
      assert.equal(
        resultText(failed).split('\n')[3],
        'codegraph: not initialized (init failed)',
        'the fallback keeps the card wording for a failed init',
      );
      assert.equal(resultText(failed).split('\n')[0], 'created: feat-no-card-fail \u00B7 feat/no-card-fail');
    } finally {
      restoreEnv();
    }
  });

  test('a sent association field is ignored: nothing is verified and nothing is stored', async () => {
    const root = makeRepo('assoc');
    const herdr = makeHerdrStub();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      // A gh stub that always fails proves no issue verification runs.
      GH_BIN_PATH: path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-gh-'))), 'gh-missing'),
    });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1',
        { branch: 'feat/assoc', issues: [999999], odd: 'odd/tasks/missing.md' },
        undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, 'the create is not refused by an association');
      assert.equal('issues' in result.details, false);
      assert.equal('odd' in result.details, false);
      const row = registryRows(root).find((entry) => entry.branch === 'feat/assoc');
      assert.ok(row, 'the checkout is registered');
      assert.deepEqual(row.issues, []);
      assert.equal(row.odd, null);
    } finally {
      restoreEnv();
    }
  });

  test('an already checked-out branch is refused, never updated through the create', async () => {
    const root = makeRepo('refuse');
    const herdr = makeHerdrStub();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const first = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/taken' }, undefined, undefined, makeCtx({ repoRoot: root, thread: 'thread-1' }),
      );
      assert.equal(first.isError, undefined);
      const target = expectedTarget(root, 'feat-taken');
      const before = registryRows(root).find((entry) => entry.branch === 'feat/taken');
      const second = await tools.get('worktree_create').execute(
        'c2',
        { branch: 'feat/taken', issues: [1], odd: 'odd/tasks/x.md' },
        undefined, undefined, makeCtx({ repoRoot: root, thread: 'thread-2' }),
      );
      assert.equal(second.isError, true, 'the second owner is refused');
      assert.match(resultText(second), /already checked out/);
      const after = registryRows(root).find((entry) => entry.branch === 'feat/taken');
      assert.deepEqual(after, before, 'the registered row is untouched: no update path exists');
      assert.equal(after.path, target);
    } finally {
      restoreEnv();
    }
  });
});
