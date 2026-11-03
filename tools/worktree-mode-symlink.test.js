'use strict';
// Regression tests (test-first) for C2: `writeMode` must never follow a
// symlink. The old implementation used `writeFileSync`, which follows the
// link, so a symlinked mode file overwrote its TARGET while the path stayed
// a symlink.
//
// Only observable behavior is asserted: the thrown refusal, the untouched
// canary bytes, the still-symlink path, the exact bytes of the normal path,
// and the customize command surfacing the refusal instead of claiming success.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const modeLib = require('../lib/worktree-mode.js');

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
  .replace(
    'import { Type } from "@earendil-works/pi-ai";',
    TYPE_STUB,
  )
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
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

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const mod = await import(pathToFileURL(copy).href);
  const factory = mod.default;
  factory(pi);
  return { tools, commands, handlers, mod };
}

// A state dir whose mode path is a symlink to a canary file. Writing the
// mode must refuse and leave the canary alone.
function makeSymlinkedModeState() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-state-')));
  const canary = path.join(dir, 'precious-mode-target.txt');
  fs.writeFileSync(canary, 'do not destroy me\n');
  fs.symlinkSync(canary, path.join(dir, 'gentle-worktree-mode.json'));
  return { dir, canary };
}

// ---------------------------------------------------------------------------
// The two "Plugin tools" toggles that are not the legacy worktree flag (ODD
// command, Issues command) live in their own file, beside the mode file, in the
// same state directory. Missing means enabled — both commands registered before
// the toggles existed — and malformed never enables either one. The worktree
// flag itself keeps `gentle-worktree-mode.json` byte for byte.
// ---------------------------------------------------------------------------
describe('plugin tools state (ODD and Issues toggles)', { concurrency: false }, () => {
  test('a missing file means both commands enabled', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-missing-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    assert.deepEqual(modeLib.readPluginTools(env), { state: 'missing', odd: true, issues: true });
    assert.equal(modeLib.pluginToolsPath(env), path.join(dir, 'gentle-plugin-tools.json'));
  });

  test('each toggle persists independently with the exact bytes', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-persist-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    modeLib.writePluginTools({ odd: false, issues: true }, env);
    assert.equal(fs.readFileSync(modeLib.pluginToolsPath(env), 'utf8'), '{"version":1,"odd":false,"issues":true}\n');
    assert.deepEqual(modeLib.readPluginTools(env), { state: 'ok', odd: false, issues: true });
    modeLib.writePluginTools({ odd: false, issues: false }, env);
    assert.equal(fs.readFileSync(modeLib.pluginToolsPath(env), 'utf8'), '{"version":1,"odd":false,"issues":false}\n');
    assert.deepEqual(modeLib.readPluginTools(env), { state: 'ok', odd: false, issues: false });
    // The legacy worktree flag is a different file and is never touched here.
    assert.equal(fs.existsSync(modeLib.modePath(env)), false, 'the worktree flag is not written');
  });

  test('every malformed shape fails closed on both toggles', () => {
    const cases = [
      '{not json',
      'null',
      '[]',
      '"odd"',
      '{"version":2,"odd":true,"issues":true}',
      '{"version":1,"odd":"yes","issues":true}',
      '{"version":1,"odd":true}',
    ];
    for (const body of cases) {
      const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-bad-')));
      fs.writeFileSync(path.join(dir, 'gentle-plugin-tools.json'), body);
      assert.deepEqual(
        modeLib.readPluginTools({ GENTLE_STATUS_STATE_DIR: dir }),
        { state: 'malformed', odd: false, issues: false },
        `malformed body ${body} never enables a command`,
      );
    }
  });

  test('writePluginTools refuses a symlinked or non-regular destination and touches nothing', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-symlink-')));
    const canary = path.join(dir, 'precious-tools-target.txt');
    fs.writeFileSync(canary, 'do not destroy me\n');
    fs.symlinkSync(canary, path.join(dir, 'gentle-plugin-tools.json'));
    assert.throws(
      () => modeLib.writePluginTools({ odd: false, issues: false }, { GENTLE_STATUS_STATE_DIR: dir }),
      /symlink/i,
    );
    assert.equal(fs.readFileSync(canary, 'utf8'), 'do not destroy me\n', 'the target is unchanged');

    const dir2 = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-dir-')));
    fs.mkdirSync(path.join(dir2, 'gentle-plugin-tools.json'));
    assert.throws(
      () => modeLib.writePluginTools({ odd: false, issues: false }, { GENTLE_STATUS_STATE_DIR: dir2 }),
      /refus/i,
    );
  });
});

describe('worktree writeMode symlink guard', { concurrency: false }, () => {
  test('writeMode refuses a symlinked mode path and touches nothing', () => {
    const { dir, canary } = makeSymlinkedModeState();
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    assert.throws(
      () => modeLib.writeMode(true, env),
      /symlink/i,
      'the refusal names the symlink',
    );
    assert.equal(
      fs.readFileSync(canary, 'utf8'),
      'do not destroy me\n',
      'the symlink target bytes are unchanged',
    );
    assert.equal(
      fs.lstatSync(modeLib.modePath(env)).isSymbolicLink(),
      true,
      'the path is still a symlink',
    );
  });

  test('writeMode refuses a non-regular mode path', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-dir-')));
    fs.mkdirSync(path.join(dir, 'gentle-worktree-mode.json'));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    assert.throws(
      () => modeLib.writeMode(false, env),
      /refus/i,
      'a non-regular destination is refused, never truncated',
    );
  });

  test('the normal path still writes exactly {"version":1,"enabled":true}', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-normal-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    modeLib.writeMode(true, env);
    assert.equal(
      fs.readFileSync(modeLib.modePath(env), 'utf8'),
      '{"version":1,"enabled":true}\n',
    );
    assert.equal(
      fs.lstatSync(modeLib.modePath(env)).isSymbolicLink(),
      false,
      'the normal path is a regular file, not a symlink',
    );
    modeLib.writeMode(false, env);
    assert.equal(
      fs.readFileSync(modeLib.modePath(env), 'utf8'),
      '{"version":1,"enabled":false}\n',
    );
  });

  test('customize surfaces the refusal and never claims success', async () => {
    const { dir, canary } = makeSymlinkedModeState();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: dir });
    try {
      const { commands, mod } = await loadExtension();
      // No TUI helpers: the command degrades to the plain select menu,
      // which runs the same worktree apply path as the panel.
      mod.setCustomizeTuiLoader(async () => { throw new Error('no TUI here'); });
      const def = commands.get('herdr-gentle:customize');
      assert.ok(def, 'expected the herdr-gentle:customize command');
      const notes = [];
      // The symlinked mode path reads as malformed, so the toggle shows Disabled.
      const answers = ['Plugin tools', 'Worktree tools · Disabled'];
      const ctx = {
        ui: {
          notify: (message, level) => { notes.push([message, level]); },
          select: async () => answers.shift(),
        },
        reload: async () => { notes.push(['reloaded', 'reload']); },
      };
      await def.handler('', ctx);
      assert.ok(notes.length > 0, 'expected at least one notification');
      assert.ok(
        notes.some(([message, level]) => level === 'error' && /symlink|refus|could not write/i.test(message)),
        `the refusal is surfaced as an error: ${JSON.stringify(notes)}`,
      );
      assert.ok(
        !notes.some(([message]) => /Worktree tools enabled/.test(message)),
        `success is never claimed: ${JSON.stringify(notes)}`,
      );
      assert.ok(
        !notes.some(([message]) => message === 'reloaded'),
        'a refused write never reloads',
      );
      assert.equal(
        fs.readFileSync(canary, 'utf8'),
        'do not destroy me\n',
        'the command touches nothing either',
      );
      assert.equal(
        fs.lstatSync(modeLib.modePath(process.env)).isSymbolicLink(),
        true,
        'the path is still a symlink',
      );
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin tools: split state across two directories, and two sessions flipping
// different toggles at the same time.
//
// Both bugs are observable behavior. (1) A stored `gentle-plugin-tools.json`
// with the toggles DISABLED was invisible as soon as the OTHER directory (the
// Herdr-injected one) held any other state file, and a missing toggle file
// means enabled — fail OPEN. (2) The ODD/Issues flip used to be a
// read-modify-write of the whole document with no cross-process serialization,
// so two sessions flipping at once each wrote back the other's stale value and
// one flip was LOST.
//
// The tests below pin the fix: every existing copy is read, two readable
// copies that disagree are ambiguous (fail closed, nothing overwritten), a flip
// waits for the family lock, merges into the CURRENT values, and writes every
// copy that exists. No test points TMPDIR or a cache dir into the repository.
// ---------------------------------------------------------------------------
const { spawn, spawnSync } = require('node:child_process');

const liveChildren = [];
after(() => {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

const STORED_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-agents');

// A stored dir plus a Herdr-injected dir under one sandbox XDG state home, so
// the stored default is computed exactly the way the resolver computes it.
function splitFixture(tag) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-tools-split-${tag}-`)));
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, STORED_SEGMENT);
  const injected = path.join(root, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  return { root, xdg, stored, injected, env: { XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected } };
}

function toolsBody(odd, issues) {
  return `{"version":1,"odd":${odd},"issues":${issues}}\n`;
}

function seedTools(dir, odd, issues) {
  fs.writeFileSync(path.join(dir, 'gentle-plugin-tools.json'), toolsBody(odd, issues));
}

function toolsBytesOf(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'gentle-plugin-tools.json'), 'utf8');
  } catch {
    return null;
  }
}

// Neither copy may be created, overwritten or left behind as litter.
function assertNoLitter(dir) {
  const names = fs.readdirSync(dir).filter((name) => /\.lock$|\.tmp\.|\.stale\./.test(name));
  assert.deepEqual(names, [], `no lock or temp file remains in ${dir}`);
}

const CHILD_UPDATE = `
const mode = require(process.env.PI_TEST_LIB);
mode
  .updatePluginTools(JSON.parse(process.env.PI_TEST_PATCH), {
    env: JSON.parse(process.env.PI_TEST_STATE_ENV),
    timeoutMs: Number(process.env.PI_TEST_TIMEOUT || 5000),
    pollMs: 10,
  })
  .then((result) => { process.stdout.write(JSON.stringify({ ok: true, paths: result.paths })); })
  .catch((err) => { process.stderr.write(String((err && err.message) || err)); process.exit(1); });
`;

// Runs the flip in ANOTHER process, with the fixture env passed explicitly, so
// the test exercises real cross-process behavior rather than shared module
// state.
function spawnUpdate(fixture, patch, timeoutMs) {
  const child = spawn(process.execPath, ['-e', CHILD_UPDATE], {
    env: {
      ...process.env,
      PI_TEST_LIB: path.resolve(__dirname, '../lib/worktree-mode.js'),
      PI_TEST_PATCH: JSON.stringify(patch),
      PI_TEST_STATE_ENV: JSON.stringify(fixture.env),
      PI_TEST_TIMEOUT: String(timeoutMs || 5000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr: () => stderr }));
  });
  return { child, done };
}

function seedLock(env, holder) {
  const file = modeLib.pluginToolsLockPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, startedAt: new Date().toISOString(), ...holder })}\n`);
  return file;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('plugin tools split state and concurrent flips', { concurrency: false }, () => {
  test('a stored disabled copy wins over an injected dir that only holds other state', async () => {
    const fixture = splitFixture('stored-wins');
    seedTools(fixture.stored, false, false);
    fs.writeFileSync(path.join(fixture.injected, 'gentle-status.pid'), '424242\n');
    assert.equal(modeLib.stateDir(fixture.env), fixture.injected, 'the legacy resolution is untouched');

    assert.deepEqual(
      modeLib.readPluginTools(fixture.env),
      { state: 'ok', odd: false, issues: false },
      'the disabled copy is read instead of falling back to the enabled default',
    );

    const result = await modeLib.updatePluginTools({ odd: true }, { env: fixture.env });
    assert.deepEqual(result.paths, [path.join(fixture.stored, 'gentle-plugin-tools.json')], 'only the existing copy is written');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(true, false), 'the flipped key changed and the other key is preserved');
    assert.equal(toolsBytesOf(fixture.injected), null, 'no second copy is created in the injected dir');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  test('two readable copies that disagree fail closed, name both files and are never overwritten', async () => {
    const fixture = splitFixture('disagree');
    seedTools(fixture.stored, false, true);
    seedTools(fixture.injected, true, true);

    const detail = modeLib.readPluginToolsDetail(fixture.env);
    assert.equal(detail.state, 'conflict');
    assert.deepEqual(detail.conflicts, ['odd'], 'only the disagreeing key is ambiguous');
    assert.equal(detail.odd, false, 'the ambiguous key fails closed');
    assert.equal(detail.issues, true, 'the agreed key keeps its value');
    assert.ok(detail.diagnostic.includes(path.join(fixture.stored, 'gentle-plugin-tools.json')), 'the diagnostic names the stored copy');
    assert.ok(detail.diagnostic.includes(path.join(fixture.injected, 'gentle-plugin-tools.json')), 'the diagnostic names the injected copy');
    assert.ok(/different values/i.test(detail.diagnostic), 'the diagnostic says what is wrong');
    assert.ok(/delete|identical/i.test(detail.diagnostic), 'the diagnostic says what to do about it');

    await assert.rejects(
      modeLib.updatePluginTools({ odd: false }, { env: fixture.env }),
      (err) => /different values/i.test(err.message) && /nothing was written/i.test(err.message),
    );
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true), 'the stored copy is byte-identical');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'the injected copy is byte-identical');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  test('two agreeing copies are both rewritten so they cannot diverge', async () => {
    const fixture = splitFixture('agree');
    seedTools(fixture.stored, true, true);
    seedTools(fixture.injected, true, true);
    assert.equal(modeLib.readPluginTools(fixture.env).state, 'ok');

    const result = await modeLib.updatePluginTools({ issues: false }, { env: fixture.env });
    assert.equal(result.paths.length, 2, 'both copies are written');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(true, false));
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, false));
    assert.deepEqual(modeLib.readPluginTools(fixture.env), { state: 'ok', odd: true, issues: false }, 'the pair still agrees');
  });

  test('a lock whose owner is gone is broken and the update still lands', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-stale-lock-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    assert.equal(dead.status, 0, 'the helper process exited');
    const lockFile = seedLock(env, { token: 'abandoned-token', pid: dead.pid, host: os.hostname() });

    const result = await modeLib.updatePluginTools({ odd: false }, { env, timeoutMs: 2000, pollMs: 10 });
    assert.deepEqual(result.paths, [path.join(dir, 'gentle-plugin-tools.json')]);
    assert.equal(fs.readFileSync(path.join(dir, 'gentle-plugin-tools.json'), 'utf8'), toolsBody(false, true));
    assert.equal(fs.existsSync(lockFile), false, 'the abandoned lock is gone');
    assertNoLitter(dir);
  });

  test('a live owner lock is never broken, however old it looks', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-live-lock-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    modeLib.writePluginTools({ odd: true, issues: true }, env);
    const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    liveChildren.push(alive);
    await wait(150);
    assert.equal(alive.exitCode, null, 'the owning process is still running');
    const lockFile = seedLock(env, { token: 'live-token', pid: alive.pid, host: os.hostname() });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);

    await assert.rejects(
      modeLib.updatePluginTools({ odd: false }, { env, timeoutMs: 150, pollMs: 10 }),
      (err) => err.message.includes(lockFile)
        && err.message.includes(String(alive.pid))
        && /Nothing was changed/i.test(err.message)
        && /delete that lock file/i.test(err.message),
    );
    assert.equal(fs.existsSync(lockFile), true, 'age alone never deletes a live lock');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'live-token', 'the live lock is byte-identical');
    assert.equal(fs.readFileSync(path.join(dir, 'gentle-plugin-tools.json'), 'utf8'), toolsBody(true, true), 'the state is unchanged');
  });

  test('an unreadable lock is never deleted: the update fails and names it', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-bad-lock-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    const lockFile = modeLib.pluginToolsLockPath(env);
    fs.writeFileSync(lockFile, 'not a lock\n');

    await assert.rejects(
      modeLib.updatePluginTools({ odd: false }, { env, timeoutMs: 150, pollMs: 10 }),
      (err) => err.message.includes(lockFile) && /unreadable/i.test(err.message),
    );
    assert.equal(fs.readFileSync(lockFile, 'utf8'), 'not a lock\n', 'a lock this process cannot judge is left alone');
    assert.equal(fs.existsSync(path.join(dir, 'gentle-plugin-tools.json')), false, 'nothing was written');
  });

  test('two processes flipping different toggles at the same time keep both flips', async () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tools-race-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    modeLib.writePluginTools({ odd: true, issues: true }, env);
    const stateFile = path.join(dir, 'gentle-plugin-tools.json');
    // Session A is mid-flip: its lock is held and it has not written yet.
    const lockFile = seedLock(env, { token: 'session-a', pid: process.pid, host: os.hostname() });

    // Session B flips Issues in ANOTHER process and must wait for the lock.
    const child = spawnUpdate({ env }, { issues: false });
    await wait(250);
    assert.equal(child.child.exitCode, null, 'the second session is still waiting for the lock');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), toolsBody(true, true), 'it wrote nothing while the lock was held');

    // Session A commits its own flip of ODD and releases the lock.
    fs.writeFileSync(stateFile, toolsBody(false, true));
    fs.unlinkSync(lockFile);

    const outcome = await child.done;
    assert.equal(outcome.code, 0, `the second session succeeded: ${outcome.stderr()}`);
    assert.equal(
      fs.readFileSync(stateFile, 'utf8'),
      toolsBody(false, false),
      'both flips survive: the second session merged into the state it found after the first finished',
    );
    assertNoLitter(dir);
  });
});
