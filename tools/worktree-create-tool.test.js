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
  // S2: new worktrees are born from LOCAL main, so every fixture that creates
  // one needs that branch to exist (the create refuses without it).
  git(dir, ['branch', 'main', 'HEAD']);
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
  // S3/S4: the pending-change selection is part of the tool's declared
  // contract, and it is REQUIRED — a call that omits it never reaches the
  // create: the runtime validates `parameters` before execute, so a property
  // that the declaration does not mark optional is a field the caller must
  // send. `optional` is how the plain-node Type double records Optional(), so
  // its absence is the observable proof that the field is mandatory.
  test('declares `branch` and a required three-form `changes`', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const tools = await loadExtension();
      assert.ok(tools.has('worktree_create'), 'worktree_create is registered');
      assert.ok(!tools.has('worktree_upsert'), 'the old upsert name is not registered');
      const tool = tools.get('worktree_create');
      assert.equal(tool.label, 'Worktree Create');
      assert.match(tool.description, /creat/i);
      assert.doesNotMatch(tool.description, /create or update/i, 'the tool never claims an update path');
      assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['branch', 'changes'], 'the branch and the changes selection, nothing else');
      const changes = tool.parameters.properties.changes;
      assert.ok(changes, 'the changes selection is declared');
      assert.notEqual(changes.optional, true, 'changes is mandatory: an omitted field is refused before the create runs');
      assert.match(changes.description, /"all"/, 'the declaration names the copy-everything form');
      assert.match(changes.description, /"none"/, 'the declaration names the copy-nothing form');
      assert.match(changes.description, /file/i, 'the declaration names the explicit file list form');
      assert.deepEqual(tool.parameters.properties.branch, { type: 'string', description: tool.parameters.properties.branch.description }, 'the branch parameter is unchanged');
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
        'c1', { branch: 'feat/simple', changes: 'none' }, undefined, undefined, makeCtx({ repoRoot: root }),
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
        'c1', { branch: 'feat/cg-skip', changes: 'none' }, undefined, undefined, makeCtx({ repoRoot: root }),
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
        'c1', { branch: 'feat/cg-fail', changes: 'none' }, undefined, undefined, makeCtx({ repoRoot: root }),
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
      const first = await tools.get('worktree_create').execute('c1', { branch: 'feat/repeat', changes: 'none' }, undefined, undefined, ctx);
      assert.equal(first.isError, undefined);
      assert.equal(codegraphCalls().length, 1);
      const second = await tools.get('worktree_create').execute('c2', { branch: 'feat/repeat', changes: 'none' }, undefined, undefined, ctx);
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
        'c1', { branch: 'feat/no-card', changes: 'none' }, undefined, undefined, makeCtx({ repoRoot: root }),
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
        'c2', { branch: 'feat/no-card-fail', changes: 'none' }, undefined, undefined, makeCtx({ repoRoot: root, thread: 'thread-2' }),
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
        { branch: 'feat/assoc', issues: [999999], odd: 'odd/tasks/missing.md', changes: 'none' },
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
        'c1', { branch: 'feat/taken', changes: 'none' }, undefined, undefined, makeCtx({ repoRoot: root, thread: 'thread-1' }),
      );
      assert.equal(first.isError, undefined);
      const target = expectedTarget(root, 'feat-taken');
      const before = registryRows(root).find((entry) => entry.branch === 'feat/taken');
      const second = await tools.get('worktree_create').execute(
        'c2',
        { branch: 'feat/taken', issues: [1], odd: 'odd/tasks/x.md', changes: 'none' },
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

// ---------------------------------------------------------------------------
// S3/S4: the `changes` selection — "copy all", "copy nothing", or an explicit
// file list — and its safety. Nothing here reads internal state: the create
// result text, the checkouts git materialized on disk, the changed file
// contents and the registry rows are the whole evidence. Every refused
// selection is proven to have mutated NOTHING (no checkout, no registry row,
// no backend call).
// ---------------------------------------------------------------------------

// A fixture whose checkout carries pending work: one tracked file modified in
// the working tree and one untracked file.
function makeDirtyRepo(tag) {
  const root = makeRepo(tag);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'a']);
  // The committed file has to be part of the base the worktree is born from,
  // or the pending change would be un-appliable by construction.
  git(root, ['branch', '-f', 'main', 'HEAD']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'fresh\n');
  return root;
}

// Every argv the herdr stub observed (empty when it never ran).
function herdrArgv(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

describe('S3/S4: worktree_create changes selection', { concurrency: false }, () => {
  // S4: the field is MANDATORY at runtime too, not only in the declaration. A
  // call that omits it (or sends null) is refused before anything runs, so no
  // branch, checkout, registry row or backend call can exist — the create
  // cannot quietly decide "copy nothing" on the caller's behalf.
  test('an omitted changes selection is refused before any mutation', async () => {
    const root = makeDirtyRepo('changes-omitted');
    const herdr = makeHerdrStub();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const tool = tools.get('worktree_create');
      const params = [{ branch: 'feat/omitted' }, { branch: 'feat/omitted', changes: null }];
      for (const sent of params) {
        const result = await tool.execute('c1', sent, undefined, undefined, makeCtx({ repoRoot: root }));
        assert.equal(result.isError, true, `expected a refusal for ${JSON.stringify(sent)}`);
        const text = resultText(result);
        assert.match(text, /changes/, `the refusal names the missing field: ${text}`);
        assert.match(text, /"all"/, 'the refusal names the copy-everything form');
        assert.match(text, /"none"/, 'the refusal names the copy-nothing form');
        assert.match(text, /nothing was created/, 'the refusal states that nothing was written');
      }
      assert.equal(fs.existsSync(expectedTarget(root, 'feat-omitted')), false, 'no checkout was created');
      assert.deepEqual(registryRows(root), [], 'no registry row was written');
      assert.deepEqual(herdrArgv(herdr.log), [], 'no backend ran before the field was checked');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its work');
    } finally {
      restoreEnv();
    }
  });

  // The declared field accepts exactly three things: the word "all", the word
  // "none", or a list of file paths. An EMPTY (or whitespace-only) string is
  // none of them, so it is refused like any other unusable value — the create
  // never reads "no text" as "copy nothing" on the caller's behalf. The warp's
  // optional `changes` keeps its own, documented rule (omitted/""/[] = no
  // copy), which is pinned in tools/customize-warp.test.js.
  test('an empty or whitespace-only selection is refused before any mutation', async () => {
    const root = makeDirtyRepo('changes-empty-string');
    const herdr = makeHerdrStub();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const tool = tools.get('worktree_create');
      for (const changes of ['', '   ', '\t', '\n']) {
        const result = await tool.execute(
          'c1', { branch: 'feat/empty-selection', changes }, undefined, undefined, makeCtx({ repoRoot: root }),
        );
        assert.equal(result.isError, true, `expected a refusal for ${JSON.stringify(changes)}`);
        const text = resultText(result);
        assert.match(text, /invalid changes selection/, `the refusal names the field: ${text}`);
        assert.match(text, /"all"/, 'the refusal names the copy-everything form');
        assert.match(text, /"none"/, 'the refusal names the copy-nothing form');
        assert.match(text, /file paths/, 'the refusal names the file-list form');
        assert.match(text, /nothing was created/, 'the refusal states that nothing was written');
      }
      assert.equal(fs.existsSync(expectedTarget(root, 'feat-empty-selection')), false, 'no checkout was created');
      assert.deepEqual(registryRows(root), [], 'no registry row was written');
      assert.deepEqual(herdrArgv(herdr.log), [], 'no backend ran before the selection was validated');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its work');
    } finally {
      restoreEnv();
    }
  });

  test('an invalid changes selection is refused before any mutation', async () => {
    const root = makeDirtyRepo('changes-invalid');
    const herdr = makeHerdrStub();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const tool = tools.get('worktree_create');
      // Every value that is neither "all", "none" nor a file list. An empty
      // string and an empty list ARE a legal spelling of "copy nothing", so
      // they are pinned by the "none" case below instead.
      const invalid = ['some', 'ALL', 42, true, { all: true }, [''], [7], ['a.txt', '']];
      for (const changes of invalid) {
        const result = await tool.execute(
          'c1', { branch: 'feat/bad-selection', changes }, undefined, undefined, makeCtx({ repoRoot: root }),
        );
        assert.equal(result.isError, true, `expected a refusal for ${JSON.stringify(changes)}`);
        assert.match(
          resultText(result),
          /invalid changes selection/,
          `the refusal names the field and the accepted forms: ${resultText(result)}`,
        );
        assert.match(resultText(result), /"all"/, 'the refusal names the copy-everything form');
        assert.match(resultText(result), /"none"/, 'the refusal names the copy-nothing form');
      }
      assert.equal(fs.existsSync(expectedTarget(root, 'feat-bad-selection')), false, 'no checkout was created');
      assert.deepEqual(registryRows(root), [], 'no registry row was written');
      assert.deepEqual(herdrArgv(herdr.log), [], 'no backend ran before the selection was validated');
    } finally {
      restoreEnv();
    }
  });

  test('a listed file that is not pending is refused before any mutation', async () => {
    const root = makeDirtyRepo('changes-unknown');
    const herdr = makeHerdrStub();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1',
        { branch: 'feat/unknown-file', changes: ['a.txt', 'nope.txt'] },
        undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, true, 'a file the checkout does not have pending is refused');
      assert.match(resultText(result), /unknown changed file/, `the refusal names the file: ${resultText(result)}`);
      assert.match(resultText(result), /nope\.txt/);
      assert.equal(fs.existsSync(expectedTarget(root, 'feat-unknown-file')), false, 'no checkout was created');
      assert.deepEqual(registryRows(root), [], 'no registry row was written');
      assert.deepEqual(herdrArgv(herdr.log), [], 'no backend ran before the selection was validated');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its changes');
    } finally {
      restoreEnv();
    }
  });

  test('"all" carries every pending change into the new checkout and keeps the source', async () => {
    const root = makeDirtyRepo('changes-all');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const target = expectedTarget(root, 'feat-copy-all');
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/copy-all', changes: 'all' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'created: feat-copy-all \u00B7 feat/copy-all',
        `path: ${target}`,
        'registered: new',
        'codegraph: initialized',
        'copied: 2 files, +2/-0',
      ], 'the copy is reported as one row after the create rows');
      // The pending work reached the new checkout...
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the tracked change travelled');
      assert.equal(fs.readFileSync(path.join(target, 'b.txt'), 'utf8'), 'fresh\n', 'the untracked file travelled');
      // ...and the source keeps it, index included.
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source is retained');
      assert.equal(git(root, ['status', '--porcelain']).includes('a.txt'), true, 'the source index is untouched');
      assert.deepEqual(result.details.copied, {
        files: 2, added: 2, deleted: 0, paths: ['a.txt', 'b.txt'],
      }, 'the details name exactly what was copied');
    } finally {
      restoreEnv();
    }
  });

  test('an explicit file list copies only the listed change', async () => {
    const root = makeDirtyRepo('changes-paths');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const target = expectedTarget(root, 'feat-copy-one');
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/copy-one', changes: ['a.txt'] }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the listed change travelled');
      assert.equal(fs.existsSync(path.join(target, 'b.txt')), false, 'the unlisted file stayed away');
      assert.deepEqual(result.details.copied, {
        files: 1, added: 1, deleted: 0, paths: ['a.txt'],
      });
      assert.equal(resultText(result).split('\n').at(-1), 'copied: 1 file, +1/-0');
    } finally {
      restoreEnv();
    }
  });

  // A destination born from LOCAL MAIN routinely lacks a file the session
  // branch added: the pending edit still has to travel, because the human or
  // agent asked for it, while nothing the source branch merely COMMITTED does.
  test('a file the session branch added is created in the checkout born from local main', async () => {
    const root = makeRepo('changes-copy-new-file');
    git(root, ['branch', '-f', 'main']); // local main stays at the empty first commit
    git(root, ['checkout', '-b', 'feat/session']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
    git(root, ['add', 'f.txt']);
    git(root, ['commit', '-m', 'only on the session branch']);
    fs.writeFileSync(path.join(root, 'f.txt'), 'one\ntwo\n');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const target = expectedTarget(root, 'feat-copy-new-file');
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/copy-new-file', changes: 'all' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.match(resultText(result), /created: feat-copy-new-file \u00B7 feat\/copy-new-file/);
      assert.equal(resultText(result).split('\n').at(-1), 'copied: 1 file, +1/-0');
      assert.deepEqual(result.details.copied, {
        files: 1, added: 1, deleted: 0, paths: ['f.txt'],
      });
      assert.equal(
        fs.readFileSync(path.join(target, 'f.txt'), 'utf8'),
        'one\ntwo\n',
        'the pending version of the file main never had reaches the new checkout',
      );
      assert.equal(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its work');
    } finally {
      restoreEnv();
    }
  });

  // S2/S3: a copy that cannot be applied is REPORTED, never hidden. Here the
  // two sides reworked the SAME lines, so there is no automatic answer: the
  // worktree is already there, and an honest result names it AND the copy
  // failure instead of claiming a copy that did not happen.
  test('a copy the destination cannot resolve is reported, and the worktree it made is named', async () => {
    const root = makeRepo('changes-copy-conflict');
    fs.writeFileSync(path.join(root, 'x.txt'), 'A\n');
    git(root, ['add', 'x.txt']);
    git(root, ['commit', '-m', 'x.txt A']);
    git(root, ['branch', '-f', 'main', 'HEAD']);
    git(root, ['checkout', '-b', 'feat/session']);
    fs.writeFileSync(path.join(root, 'x.txt'), 'B\n');
    git(root, ['commit', '-am', 'session: x.txt B']);
    fs.writeFileSync(path.join(root, 'x.txt'), 'C\n');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      const target = expectedTarget(root, 'feat-copy-conflict');
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/copy-conflict', changes: 'all' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, true, 'the copy failure is an error result');
      const text = resultText(result);
      assert.match(text, /created: feat-copy-conflict \u00B7 feat\/copy-conflict/, `the result still names the worktree it made: ${text}`);
      assert.match(text, /were NOT copied/, `the failure says the copy did not happen: ${text}`);
      assert.equal(typeof result.details.copyError, 'string', 'the reason travels in the details');
      assert.match(result.details.copyError, /conflicts/, `the reason names the conflict: ${result.details.copyError}`);
      assert.match(result.details.copyError, /resolve the conflict first/, 'the reason says how to get unstuck');
      assert.match(result.details.copyError, /warp again without copying/, 'the reason offers the do-not-copy retry');
      assert.equal(result.details.path, target);
      assert.equal(result.details.copied, undefined, 'no copy is claimed');
      assert.equal(fs.existsSync(target), true, 'the created checkout is kept, never silently removed');
      assert.ok(registryRows(root).some((row) => row.branch === 'feat/copy-conflict'), 'the created checkout stays registered');
      assert.equal(fs.readFileSync(path.join(target, 'x.txt'), 'utf8'), 'A\n', 'main\'s own line survives in the new checkout');
      assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), 'C\n', 'the source keeps its work');
    } finally {
      restoreEnv();
    }
  });

  test('"none" creates the checkout from the commit with nothing copied', async () => {
    const root = makeDirtyRepo('changes-none');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const tools = await loadExtension();
      for (const changes of ['none', []]) {
        const branch = `feat/copy-none-${String(changes).length}`;
        const result = await tools.get('worktree_create').execute(
          'c1', { branch, changes }, undefined, undefined, makeCtx({ repoRoot: root }),
        );
        assert.equal(result.isError, undefined, `expected success for ${JSON.stringify(changes)}: ${resultText(result)}`);
        const target = expectedTarget(root, branch.replace('/', '-'));
        assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\n', 'the checkout is born from the commit');
        assert.equal(fs.existsSync(path.join(target, 'b.txt')), false, 'nothing was copied');
        assert.equal('copied' in result.details, false, 'no copy is reported');
        assert.ok(
          !resultText(result).split('\n').some((line) => line.startsWith('copied: ')),
          `no copy row appears: ${resultText(result)}`,
        );
      }
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its changes');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// Interactive create: the checkout path is what the warp needs, so the SLOW
// half of the creation hooks (dependency install, `codegraph init`) must not
// stand between the human's confirmation and the selector coming back. The
// deferred route is OPT-IN (`backgroundHooks`) and only the warp panel asks
// for it: the agent tool keeps the inline contract, because its result is the
// agent's only report and the hooks must have settled before it is returned.
// Nothing is orphaned and nothing is swallowed — every background task is
// tracked, settles into exactly one report, and a failure reaches the human.
// ---------------------------------------------------------------------------
describe('interactive create: setup runs in the background', { concurrency: false }, () => {
  async function loadModule() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-bg-ext-')));
    const copy = path.join(dir, 'gentle-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbed);
    return import(pathToFileURL(copy).href);
  }

  // A `codegraph` that sleeps, then drops a marker: the marker's presence is
  // the observable proof of WHEN the deferred setup actually ran.
  function makeSlowCodegraph({ exitCode = 0 } = {}) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-create-tool-bg-bin-')));
    const marker = path.join(dir, 'done');
    fs.writeFileSync(
      path.join(dir, 'codegraph'),
      ['#!/bin/sh', 'sleep 0.3', `printf done > "${marker}"`, `exit ${exitCode}`, ''].join('\n'),
      { mode: 0o755 },
    );
    return { dir, marker };
  }

  test('backgroundHooks returns once the path exists and the setup settles into one report', async () => {
    const root = makeRepo('bg-hooks');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    const slow = makeSlowCodegraph();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      PATH: `${slow.dir}${path.delimiter}${process.env.PATH || ''}`,
    });
    try {
      const mod = await loadModule();
      const notes = [];
      const ctx = makeCtx({ repoRoot: root });
      ctx.ui.notify = (message, level) => { notes.push([message, level]); };
      const result = await mod.executeWorktreeCreate(
        { branch: 'feat/bg-hooks', changes: 'none' },
        ctx,
        { gitOnly: true, principalLayout: true, backgroundHooks: true },
      );
      const target = expectedTarget(root, 'feat-bg-hooks');
      assert.equal(result.isError, undefined, `the create succeeded: ${resultText(result)}`);
      assert.equal(fs.existsSync(target), true, 'the path the warp needs already exists');
      assert.ok(registryRows(root).some((row) => row.branch === 'feat/bg-hooks'), 'the checkout is registered');
      assert.equal(fs.existsSync(slow.marker), false, 'the create returned before the slow setup finished');
      assert.deepEqual(notes, [], 'nothing is reported while the setup is still running');
      const steps = (result.details.hooks && result.details.hooks.steps) || [];
      const install = steps.find((step) => step.name === 'install');
      assert.ok(install && install.status === 'pending', `install is reported pending (${JSON.stringify(steps)})`);
      const codegraphStep = steps.find((step) => step.name === 'codegraph-init');
      assert.ok(codegraphStep && codegraphStep.status === 'pending', 'codegraph is reported pending');
      assert.equal(result.details.setupPending, true, 'the result states that the setup is still running');
      assert.equal(result.details.codegraph.status, 'pending', 'the CodeGraph fact is pending, never a claimed init');
      assert.ok(
        resultText(result).split('\n').includes('codegraph: pending (setup runs in the background)'),
        `the visible row says the setup is still running: ${resultText(result)}`,
      );
      await mod.awaitPendingCreationSetups();
      assert.equal(fs.existsSync(slow.marker), true, 'the deferred setup still ran, in the background');
      const reports = notes.filter(([message]) => /setup/i.test(String(message)));
      assert.equal(reports.length, 1, `exactly one setup report, got ${JSON.stringify(notes)}`);
      assert.match(String(reports[0][0]), /setup finished for feat\/bg-hooks/, 'the report names the checkout');
      assert.match(String(reports[0][0]), /codegraph initialized/, 'and what actually ran');
      assert.equal(reports[0][1], 'info', 'a clean setup is informational');
    } finally {
      restoreEnv();
    }
  });

  // The no-op case: a checkout with no lockfile and no `codegraph` on PATH runs
  // NO setup step at all. Reporting "setup finished" there claims a setup that
  // never happened, so a run where nothing completed stays silent — while a
  // failure keeps its error report (the test below), which is the half that
  // must never be suppressed.
  test('a background setup where no step ran reports no success toast', async () => {
    const root = makeRepo('bg-hooks-noop');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      PATH: pathWithoutCodegraph(),
    });
    try {
      const mod = await loadModule();
      const notes = [];
      const ctx = makeCtx({ repoRoot: root });
      ctx.ui.notify = (message, level) => { notes.push([message, level]); };
      const result = await mod.executeWorktreeCreate(
        { branch: 'feat/bg-hooks-noop', changes: 'none' },
        ctx,
        { gitOnly: true, principalLayout: true, backgroundHooks: true },
      );
      assert.equal(result.isError, undefined, `the create itself still succeeds: ${resultText(result)}`);
      assert.ok(registryRows(root).some((row) => row.branch === 'feat/bg-hooks-noop'), 'the checkout is registered');
      assert.deepEqual(notes, [], 'nothing is reported while the setup is still running');
      await mod.awaitPendingCreationSetups();
      assert.deepEqual(notes, [], `a setup that ran no step reports nothing at all: ${JSON.stringify(notes)}`);
      const steps = (result.details.hooks && result.details.hooks.steps) || [];
      const deferred = steps.filter((step) => step.name === 'install' || step.name === 'codegraph-init');
      assert.equal(deferred.length, 2, `both deferred steps are named: ${JSON.stringify(steps)}`);
      assert.ok(deferred.every((step) => step.status === 'pending'), `and reported as pending, never as done: ${JSON.stringify(deferred)}`);
    } finally {
      restoreEnv();
    }
  });

  test('a failing background setup is reported as an error and never swallowed', async () => {
    const root = makeRepo('bg-hooks-fail');
    const herdr = makeHerdrStub();
    resetCodegraphCalls();
    const slow = makeSlowCodegraph({ exitCode: 1 });
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      PATH: `${slow.dir}${path.delimiter}${process.env.PATH || ''}`,
    });
    try {
      const mod = await loadModule();
      const notes = [];
      const ctx = makeCtx({ repoRoot: root });
      ctx.ui.notify = (message, level) => { notes.push([message, level]); };
      const result = await mod.executeWorktreeCreate(
        { branch: 'feat/bg-hooks-fail', changes: 'none' },
        ctx,
        { gitOnly: true, principalLayout: true, backgroundHooks: true },
      );
      assert.equal(result.isError, undefined, 'the checkout is created whatever the setup does');
      await mod.awaitPendingCreationSetups();
      const errors = notes.filter(([, level]) => level === 'error');
      assert.equal(errors.length, 1, `exactly one failure report, got ${JSON.stringify(notes)}`);
      assert.match(String(errors[0][0]), /setup for feat\/bg-hooks-fail finished with problems/, 'the report names the checkout');
      assert.match(String(errors[0][0]), /codegraph-init: codegraph init failed/, 'and the step that failed');
      assert.match(String(errors[0][0]), /is usable/, 'and states that the checkout is still usable');
    } finally {
      restoreEnv();
    }
  });
});
