'use strict';
// Regression tests: a TEST HARNESS must never resolve a live `herdr`.
//
// Why this file exists: `resolveHerdrBinary` used to answer with an injected
// HERDR_BIN_PATH before it looked at the harness marker, so a developer whose
// shell exports HERDR_BIN_PATH (their real herdr) handed every herdr-first
// create in a test run a LIVE binary — a leaked Herdr workspace, created for
// real, from a test. The guard now resolves the harness FIRST: under the
// harness (GENTLE_WORKTREE_LIB_DIR, set only by the test loaders that import
// the extension copy) a value that may be the live binary fails closed, and a
// live herdr is reachable only through the dedicated opt-in
// `GENTLE_WORKTREE_ALLOW_LIVE_HERDR=1` that the current test sets for itself.
//
// What is asserted, and only through the public surface: `resolveHerdrBinary`
// (the single authority for the binary) and one `worktree_create` call per
// side of the guard. Fixtures are real `git init` repositories and stub
// binaries under os.tmpdir(); the user's own checkouts, registry and Herdr
// session are never touched, and no test here closes or deletes a workspace.
//
// The guard's one heuristic is stated where it lives (lib/worktree-git.js):
// a path can be proven NOT to be the live binary without executing anything —
// an absolute path that does not exist, is not a regular executable file, or
// whose realpath is inside the OS temp directory, and that is also where every
// stub in this suite is built. Anything else is treated as a possible live
// herdr.
//
// END TO END (round 2): the extension's own `herdrBinary()` used to wrap the
// authority in a bare `catch {}` and then re-implement the old "HERDR_BIN_PATH
// first" logic, so an end-to-end herdr-first create could still be handed an
// inherited live path. The extension now propagates the authority's refusal and
// answers with it as a tool ERROR RESULT (never an uncaught throw), which the
// tests below assert end to end: no live-looking binary is executed, no Herdr
// workspace and no checkout appear, and the explicit opt-in still spawns the
// injected stub.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const gitLib = require('../lib/worktree-git.js');
const registryLib = require('../lib/worktree-registry.js');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const OPT_IN = 'GENTLE_WORKTREE_ALLOW_LIVE_HERDR';
// The harness marker: set by the test loaders, never by production.
const HARNESS = 'GENTLE_WORKTREE_LIB_DIR';
const INJECTION_MESSAGE = 'herdr binary is not injected: set HERDR_BIN_PATH in tests (refusing to run live herdr)';
// Pins the caller's global/system git config away, like every fixture in this
// suite: the host's own config must not decide what a fixture proves.
const GIT_ISOLATION = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C' };

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
function track(target) {
  roots.push(target);
  return target;
}
function scratchDir(tag) {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-herdr-guard-${tag}-`)));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ISOLATION } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const real = fs.realpathSync(scratchDir(tag));
  track(path.join(path.dirname(real), `${path.basename(real)}-worktrees`));
  git(real, ['init']);
  git(real, ['config', 'user.email', 'test@example.com']);
  git(real, ['config', 'user.name', 'Test']);
  git(real, ['commit', '--allow-empty', '-m', 'init']);
  return real;
}

// The OS temp directory is the scratch location every test here builds its
// stubs in; a live herdr is never installed there.
function scratchRoots() {
  const roots = [];
  for (const candidate of [os.tmpdir(), path.resolve(os.tmpdir())]) {
    let real = candidate;
    try { real = fs.realpathSync(candidate); } catch {}
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}
function insideScratch(target) {
  return scratchRoots().some((root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

// A real, executable file OUTSIDE the OS temp directory: the shape of an
// inherited live `herdr`. It is never executed by these tests — the guard
// refuses before any spawn.
function executableOutsideScratch() {
  const candidates = [process.execPath];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ['git', 'sh', 'node', 'cat']) candidates.push(path.join(dir, name));
  }
  for (const candidate of candidates) {
    let real;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    let stat;
    try { stat = fs.statSync(real); } catch { continue; }
    if (!stat.isFile()) continue;
    try { fs.accessSync(real, fs.constants.X_OK); } catch { continue; }
    if (insideScratch(real)) continue;
    return real;
  }
  return null;
}

// An injected stub of the shape every test in this suite builds: an executable
// file inside the OS temp directory. `log` records each argv line when a stub
// variant is actually spawned.
function makeStub(tag, { exitCode = 1 } = {}) {
  const dir = scratchDir(tag);
  return writeStub(dir, exitCode);
}

function writeStub(dir, exitCode) {
  const bin = path.join(dir, 'herdr');
  const log = path.join(dir, 'herdr-argv.log');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${log}"`,
      `exit ${exitCode}`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, log };
}

// A stub whose path the guard can only treat as a POSSIBLE live herdr: it is a
// real executable outside the guard's scratch roots. It is built in the
// process's original temp directory and then hidden from the guard's heuristic
// by pointing TMPDIR at a fresh directory, so `isProvablyNotLiveHerdr` (which
// reads os.tmpdir() when it decides) cannot prove it safe. Because it is a stub
// that logs its argv, its log file is the evidence that it was ever spawned.
function makeLiveLookingStub(tag) {
  const stub = makeStub(tag);
  const scratchRoot = scratchDir(`${tag}-scratchroot`);
  return { ...stub, scratchRoot };
}

function declaredBy(message) {
  return (err) => {
    assert.ok(err instanceof Error, `expected an Error, got ${err}`);
    assert.match(err.message, /refusing to run live herdr/, `unexpected message: ${err.message}`);
    assert.ok(err.message.includes('HERDR_BIN_PATH'), `message must name HERDR_BIN_PATH: ${err.message}`);
    assert.ok(err.message.includes(OPT_IN), `message must name the opt-in flag ${OPT_IN}: ${err.message}`);
    assert.ok(message === undefined || err.message.includes(message), `message must name ${message}: ${err.message}`);
    return true;
  };
}

// --- extension loading (the pattern every herdr-first test in this suite
// uses: the TypeScript extension is plain JS, so a copy with the two package
// import lines stubbed is import()ed with a recording `pi` object) -----------
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
assert.ok(stubbed !== srcText, 'expected the two package import lines to be stubbed');

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
after(restoreEnv);

async function loadExtension(dir) {
  const target = dir || scratchDir('ext');
  const copy = path.join(target, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); }, registerCommand: () => {}, on: () => () => {} };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

async function callCreate(tools, params, repoRoot) {
  const tool = tools.get('worktree_create');
  assert.ok(tool, 'expected worktree_create to be registered');
  const ctx = {
    cwd: repoRoot,
    hasUI: false,
    mode: 'tui',
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: { confirm: async () => true, notify: () => {} },
  };
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

const createdCheckouts = (repoRoot) => git(repoRoot, ['worktree', 'list', '--porcelain'])
  .split('\n')
  .filter((line) => line.startsWith('worktree '));

// The registry bytes as they are on disk right now (null when there is no
// registry file yet): a refusal must leave them exactly as it found them.
const registryBytes = (repoRoot) => {
  const file = registryLib.registryPath(repoRoot);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

describe('worktree-git: a test harness never resolves a live herdr', { concurrency: false }, () => {
  test('an inherited HERDR_BIN_PATH pointing at a live-capable binary fails closed', () => {
    const live = executableOutsideScratch();
    assert.ok(live, 'this test needs a real executable outside the OS temp directory');

    // The value comes from the process environment, exactly as an exported
    // HERDR_BIN_PATH does in a developer's shell.
    assert.throws(
      () => gitLib.resolveHerdrBinary({ ...process.env, [HARNESS]: LIB_DIR, HERDR_BIN_PATH: live }),
      declaredBy(live),
    );
    // ...and the same value passed explicitly is refused just the same: under
    // the harness, live-ness is a property of the path, not of who wrote it.
    assert.throws(
      () => gitLib.resolveHerdrBinary({ [HARNESS]: '/x/lib', HERDR_BIN_PATH: live }),
      declaredBy(live),
    );
  });

  test('a bare command name or a relative path is unprovable and fails closed', () => {
    // `herdr` (bare) resolves on PATH and `./herdr` resolves against the cwd:
    // neither can be shown to be a stub, so neither may reach a live session.
    for (const unprovable of ['herdr', './herdr', 'bin/herdr']) {
      assert.throws(
        () => gitLib.resolveHerdrBinary({ [HARNESS]: '/x/lib', HERDR_BIN_PATH: unprovable }),
        declaredBy(),
        `expected ${unprovable} to fail closed`,
      );
    }
  });

  test('an injected scratch stub inside the OS temp directory is still honored', () => {
    const stub = makeStub('scratch-stub');
    assert.equal(gitLib.resolveHerdrBinary({ [HARNESS]: '/x/lib', HERDR_BIN_PATH: stub.bin }), stub.bin);
  });

  test('a nonexistent injected binary is still honored: nothing can be spawned', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-guard');
    assert.equal(fs.existsSync(missing), false, 'the fixture path must not exist');
    assert.equal(gitLib.resolveHerdrBinary({ [HARNESS]: '/x/lib', HERDR_BIN_PATH: missing }), missing);
  });

  test('a harness with no binary keeps the exact fail-closed injection message', () => {
    for (const env of [{ [HARNESS]: '/x/lib' }, { [HARNESS]: '/x/lib', HERDR_BIN_PATH: '' }]) {
      assert.throws(() => gitLib.resolveHerdrBinary(env), (err) => {
        assert.equal(err.message, INJECTION_MESSAGE);
        return true;
      });
    }
  });

  test('production (no harness marker) is unchanged: an injected binary is honored', () => {
    const live = executableOutsideScratch();
    assert.ok(live, 'this test needs a real executable outside the OS temp directory');
    assert.equal(gitLib.resolveHerdrBinary({ HERDR_BIN_PATH: live }), live);
    assert.equal(gitLib.resolveHerdrBinary({ HERDR_BIN_PATH: 'herdr' }), 'herdr');
    assert.equal(gitLib.resolveHerdrBinary({}), 'herdr');
    assert.equal(gitLib.resolveHerdrBinary({ HERDR_BIN_PATH: '' }), 'herdr');
    assert.equal(gitLib.resolveHerdrBinary(undefined), 'herdr');
  });

  test('the dedicated opt-in flag is the one way a harness reaches a live herdr', () => {
    const live = executableOutsideScratch();
    assert.ok(live, 'this test needs a real executable outside the OS temp directory');
    assert.equal(gitLib.resolveHerdrBinary({ [HARNESS]: '/x/lib', [OPT_IN]: '1', HERDR_BIN_PATH: live }), live);
    assert.equal(gitLib.resolveHerdrBinary({ [HARNESS]: '/x/lib', [OPT_IN]: '1' }), 'herdr');
    // The opt-in is exact: a near-miss value is not consent to a live session.
    for (const notOptedIn of ['true', '0', 'yes', '', ' 1']) {
      assert.throws(
        () => gitLib.resolveHerdrBinary({ [HARNESS]: '/x/lib', [OPT_IN]: notOptedIn, HERDR_BIN_PATH: live }),
        declaredBy(live),
        `expected ${JSON.stringify(notOptedIn)} not to opt in`,
      );
    }
  });

  // End to end through the tool, with an inherited live-capable path: the
  // extension's herdrBinary() must propagate the authority's refusal and answer
  // with an error RESULT (isError), never an uncaught throw.
  test('a harness create refuses before spawning herdr and leaves no checkout behind', async () => {
    const live = executableOutsideScratch();
    assert.ok(live, 'this test needs a real executable outside the OS temp directory');
    const root = makeRepo('refuse');
    const registryBefore = registryBytes(root);
    setEnv({
      [HARNESS]: LIB_DIR,
      HERDR_BIN_PATH: live,
      [OPT_IN]: undefined,
      GENTLE_WORKTREE_THREAD: undefined,
      GENTLE_STATUS_STATE_DIR: scratchDir('mode'),
    });
    try {
      const tools = await loadExtension();
      const result = await callCreate(tools, { branch: 'feat/live-guard' }, root);
      assert.equal(result.isError, true, 'the refusal must surface as an error result, not a throw');
      const text = result.content.map((part) => part.text || '').join('\n');
      assert.match(text, /refusing to run live herdr/);
      assert.ok(text.includes('HERDR_BIN_PATH'), `the refusal must name HERDR_BIN_PATH: ${text}`);
      assert.ok(text.includes(OPT_IN), `the refusal must name the opt-in flag ${OPT_IN}: ${text}`);
      // No checkout was created and the principal is the only worktree.
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-live-guard');
      assert.equal(fs.existsSync(target), false, 'no checkout may be created when herdr resolution refuses');
      assert.deepEqual(createdCheckouts(root), [`worktree ${root}`]);
      assert.equal(registryBytes(root), registryBefore, 'a refusal must leave the registry bytes unchanged');
    } finally {
      restoreEnv();
    }
  });

  // The regression the bug report names: an INHERITED live path (the developer's
  // exported HERDR_BIN_PATH) must not be executed at all — not for the create,
  // not for the associate-by-open path, not after a git fallback. The stub's log
  // file is empty exactly when nothing spawned it.
  test('an inherited live path is never spawned: no herdr argv is recorded', async () => {
    const live = makeLiveLookingStub('inherited-live');
    const root = makeRepo('inherited-live');
    const registryBefore = registryBytes(root);
    setEnv({
      TMPDIR: live.scratchRoot,
      [HARNESS]: LIB_DIR,
      HERDR_BIN_PATH: live.bin,
      [OPT_IN]: undefined,
      GENTLE_WORKTREE_THREAD: undefined,
      GENTLE_STATUS_STATE_DIR: scratchDir('mode'),
    });
    try {
      const tools = await loadExtension();
      const result = await callCreate(tools, { branch: 'feat/inherited-live' }, root);
      assert.equal(result.isError, true, 'the refusal must surface as an error result, not a throw');
      const text = result.content.map((part) => part.text || '').join('\n');
      assert.match(text, /refusing to run live herdr/);
      assert.equal(fs.existsSync(live.log), false, `herdr must never be executed from a test harness: ${fs.existsSync(live.log) ? fs.readFileSync(live.log, 'utf8') : ''}`);
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-inherited-live');
      assert.equal(fs.existsSync(target), false, 'no checkout may be created when herdr resolution refuses');
      assert.deepEqual(createdCheckouts(root), [`worktree ${root}`]);
      assert.equal(registryBytes(root), registryBefore, 'a refusal must leave the registry bytes unchanged');
    } finally {
      restoreEnv();
    }
  });

  test('the opt-in is what lets the same live-looking path run, so the guard is the only difference', async () => {
    const live = makeLiveLookingStub('opted-in-live');
    const root = makeRepo('opted-in-live');
    setEnv({
      TMPDIR: live.scratchRoot,
      [HARNESS]: LIB_DIR,
      HERDR_BIN_PATH: live.bin,
      [OPT_IN]: '1',
      GENTLE_WORKTREE_THREAD: undefined,
      GENTLE_STATUS_STATE_DIR: scratchDir('mode'),
    });
    try {
      const tools = await loadExtension();
      const result = await callCreate(tools, { branch: 'feat/opted-in-live' }, root);
      assert.equal(result.isError, undefined, 'the create must succeed through the stub plus git fallback');
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-opted-in-live');
      assert.ok(createdCheckouts(root).includes(`worktree ${target}`), 'the checkout exists');
      const log = fs.readFileSync(live.log, 'utf8').split('\n').filter((line) => line.length > 0);
      assert.ok(log.some((line) => line.startsWith('worktree create')), `expected a herdr worktree create call, got ${JSON.stringify(log)}`);
    } finally {
      restoreEnv();
    }
  });

  // PRESERVE: a real session (NO harness marker) keeps the documented
  // contract — an injected HERDR_BIN_PATH still wins, so the guard is the only
  // difference the harness introduces. `../lib` next to the extension copy
  // stands in for the package's own lib dir, so this load needs no harness
  // marker at all.
  test('without the harness an injected HERDR_BIN_PATH still wins end to end', async () => {
    const stub = makeLiveLookingStub('production');
    const sandbox = scratchDir('production-ext');
    fs.symlinkSync(LIB_DIR, path.join(sandbox, 'lib'), 'dir');
    const extDir = path.join(sandbox, 'ext');
    fs.mkdirSync(extDir);
    const root = makeRepo('production');
    setEnv({
      TMPDIR: stub.scratchRoot,
      [HARNESS]: undefined,
      HERDR_BIN_PATH: stub.bin,
      [OPT_IN]: undefined,
      GENTLE_WORKTREE_THREAD: undefined,
      GENTLE_STATUS_STATE_DIR: scratchDir('mode'),
    });
    try {
      const tools = await loadExtension(extDir);
      const result = await callCreate(tools, { branch: 'feat/production' }, root);
      assert.equal(result.isError, undefined, 'a real session must never be refused by the harness guard');
      const log = fs.readFileSync(stub.log, 'utf8').split('\n').filter((line) => line.length > 0);
      assert.ok(log.some((line) => line.startsWith('worktree create')), `the injected binary must be what runs, got ${JSON.stringify(log)}`);
    } finally {
      restoreEnv();
    }
  });

  test('with the opt-in the injected stub is what runs, so the guard is the only difference', async () => {
    const stub = makeStub('opted-in');
    const root = makeRepo('opted-in');
    setEnv({
      [HARNESS]: LIB_DIR,
      HERDR_BIN_PATH: stub.bin,
      [OPT_IN]: '1',
      GENTLE_WORKTREE_THREAD: undefined,
      GENTLE_STATUS_STATE_DIR: scratchDir('mode'),
    });
    try {
      const tools = await loadExtension();
      const result = await callCreate(tools, { branch: 'feat/opted-in' }, root);
      assert.equal(result.isError, undefined, 'the create must succeed through the stub plus git fallback');
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-opted-in');
      assert.ok(createdCheckouts(root).includes(`worktree ${target}`), 'the checkout exists');
      // The stub ran: it is the injected binary, not a live one, and the opt-in
      // is the only reason the harness resolved it.
      const log = fs.readFileSync(stub.log, 'utf8').split('\n').filter((line) => line.length > 0);
      assert.ok(log.some((line) => line.startsWith('worktree create')), `expected a herdr worktree create call, got ${JSON.stringify(log)}`);
    } finally {
      restoreEnv();
    }
  });
});
