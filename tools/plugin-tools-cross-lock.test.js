'use strict';
// Regression tests (test-first) for cross-environment serialization of the
// plugin tools toggles (`ODD command` / `Issues command`).
//
// The toggle document can live in TWO state directories: the stored
// `herdr-gentle-agents` dir and the one Herdr injects
// (`HERDR_PLUGIN_STATE_DIR`). A Herdr session resolves both and writes every
// copy that exists; a PLAIN Pi session has no `HERDR_PLUGIN_STATE_DIR` at all,
// so it resolves — and writes — only the stored copy. That is the reported
// failure: the plain session locked the stored dir while the Herdr session
// locked the INJECTED dir, so neither saw the other's lock, both took their
// snapshot from the same shared copy and one flip was lost (and, when the
// Herdr session also rewrote its own copy, the pair was left DISAGREEING).
//
// The fix is that serialization covers every target path, not the one dir an
// environment happens to resolve: one lock file per candidate copy, taken in
// one deterministic order (so two sessions that share any path contend on it,
// and no two sessions can wait on each other), released in reverse. The tests
// below pin the observable consequences: a session waits for a lock the OTHER
// environment resolved, both flips survive, nothing deadlocks, a stale lock is
// recovered per path, a partial multi-copy write names what it already wrote,
// and an unreadable duplicate that gets repaired is named rather than silently
// overwritten. No test points TMPDIR or a cache dir into the repository.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const modeLib = require('../lib/worktree-mode.js');

const roots = [];
const liveChildren = [];
after(() => {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const dir of roots) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      // Not every tracked dir is a permission fixture.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

const STORED_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-agents');
const TOOLS_NAME = 'gentle-plugin-tools.json';

// A stored (pre-rename) dir plus a Herdr-injected dir under one sandbox XDG
// state home, so the stored default is computed exactly the way the resolver
// computes it. `plainEnv` omits HERDR_PLUGIN_STATE_DIR — the environment of a
// Pi session started outside Herdr, which is the whole point.
function sandbox(tag) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `pt-cross-${tag}-`)));
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, STORED_SEGMENT);
  const injected = path.join(root, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  // Any of our files proves the injected dir is ours, which is what makes a
  // Herdr session resolve it (and therefore write there).
  fs.writeFileSync(path.join(injected, 'gentle-status.pid'), '424242\n');
  return {
    root,
    xdg,
    stored,
    injected,
    plainEnv: { XDG_STATE_HOME: xdg },
    herdrEnv: { XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected },
  };
}

function toolsBody(odd, issues) {
  return `{"version":1,"odd":${odd},"issues":${issues}}\n`;
}

function seedTools(dir, odd, issues) {
  fs.writeFileSync(path.join(dir, TOOLS_NAME), toolsBody(odd, issues));
}

function toolsBytesOf(dir) {
  try {
    return fs.readFileSync(path.join(dir, TOOLS_NAME), 'utf8');
  } catch {
    return null;
  }
}

// Neither candidate may be left with a lock, a temp file or a break probe.
function assertNoLitter(dir) {
  const names = fs.readdirSync(dir).filter((name) => /\.lock$|\.tmp\.|\.stale\./.test(name));
  assert.deepEqual(names, [], `no lock or temp file remains in ${dir}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Runs the flip in ANOTHER process with the fixture env passed explicitly, so
// the test exercises real cross-process locking rather than shared module
// state.
function spawnUpdate(env, patch, timeoutMs) {
  const child = spawn(process.execPath, ['-e', CHILD_UPDATE], {
    env: {
      ...process.env,
      PI_TEST_LIB: path.resolve(__dirname, '../lib/worktree-mode.js'),
      PI_TEST_PATCH: JSON.stringify(patch),
      PI_TEST_STATE_ENV: JSON.stringify(env),
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

function seedLock(file, holder) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, startedAt: new Date().toISOString(), ...holder })}\n`);
  return file;
}

describe('plugin tools cross-environment locking', { concurrency: false }, () => {
  test('the fixture reproduces the reported shape: one shared copy, two lock dirs', () => {
    const fixture = sandbox('shape');
    assert.equal(modeLib.stateDir(fixture.plainEnv), fixture.stored, 'a plain session resolves only the stored dir');
    assert.equal(modeLib.stateDir(fixture.herdrEnv), fixture.injected, 'a Herdr session resolves the injected dir');
    assert.equal(
      modeLib.pluginToolsPath(fixture.plainEnv),
      path.join(fixture.stored, TOOLS_NAME),
      'the shared canonical copy is the stored one',
    );
    assert.deepEqual(
      modeLib.pluginToolsFiles(fixture.plainEnv),
      [path.join(fixture.stored, TOOLS_NAME)],
      'a plain session knows only the canonical copy',
    );
    assert.deepEqual(
      modeLib.pluginToolsFiles(fixture.herdrEnv),
      [path.join(fixture.stored, TOOLS_NAME), path.join(fixture.injected, TOOLS_NAME)],
      'a Herdr session reads the canonical copy first and its injected legacy copy second',
    );
  });

  // B1: whichever session flips first must write the copy EVERY session can
  // find. Resolving the injected dir made the toggle invisible to a plain
  // session, whose missing-file read means "enabled" — a silent re-enable.
  test('a first flip lands in the shared canonical copy a plain session reads', async () => {
    const fixture = sandbox('first-flip');
    const result = await modeLib.updatePluginTools({ odd: false }, { env: fixture.herdrEnv, pollMs: 10 });
    assert.deepEqual(result.paths, [path.join(fixture.stored, TOOLS_NAME)], 'the flip lands in the shared stored copy');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true));
    assert.equal(toolsBytesOf(fixture.injected), null, 'no injected-only copy is created');
    assert.deepEqual(
      modeLib.readPluginTools(fixture.plainEnv),
      { state: 'ok', odd: false, issues: true },
      'a plain session reads the choice instead of re-enabling the command',
    );
  });

  // The same rule from the plain side, which is the deterministic case: a
  // plain session can never discover an injected dir, so its write MUST be the
  // shared canonical one.
  test('a plain session writes the shared canonical copy the Herdr session reads', async () => {
    const fixture = sandbox('plain-first');
    const result = await modeLib.updatePluginTools({ issues: false }, { env: fixture.plainEnv, pollMs: 10 });
    assert.deepEqual(result.paths, [path.join(fixture.stored, TOOLS_NAME)]);
    assert.deepEqual(
      modeLib.readPluginTools(fixture.herdrEnv),
      { state: 'ok', odd: true, issues: false },
      'the Herdr session sees the plain session\'s flip',
    );
  });

  // Migration: a copy an older writer left in the injected dir is read, adopted
  // into the canonical file by the next flip, and never deleted — no value lost,
  // and the canonical file exists afterwards so a plain session cannot re-enable.
  test('a pre-existing injected-only copy is migrated into the canonical one, keeping its values', async () => {
    const fixture = sandbox('migrate');
    seedTools(fixture.injected, false, true);
    const result = await modeLib.updatePluginTools({ issues: false }, { env: fixture.herdrEnv, pollMs: 10 });
    assert.deepEqual(
      result.paths,
      [path.join(fixture.stored, TOOLS_NAME), path.join(fixture.injected, TOOLS_NAME)],
      'the canonical copy is created and the existing copy is kept in step',
    );
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, false), 'the legacy ODD value is adopted, not lost');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, false));
    assert.deepEqual(modeLib.readPluginTools(fixture.plainEnv), { state: 'ok', odd: false, issues: false });
    assert.deepEqual(modeLib.readPluginTools(fixture.herdrEnv), { state: 'ok', odd: false, issues: false });
  });

  // B2: a plain flip leaves the injected copy (which it cannot see) holding the
  // previous value. That must not make an UNRELATED flip impossible, and the
  // value the plain session could not see must be preserved, never overwritten.
  test('a plain flip does not block a Herdr flip of another key, and nothing is overwritten', async () => {
    const fixture = sandbox('b2-unrelated');
    seedTools(fixture.stored, true, true);
    seedTools(fixture.injected, true, true);

    const plain = await modeLib.updatePluginTools({ odd: false }, { env: fixture.plainEnv, pollMs: 10 });
    assert.deepEqual(plain.paths, [path.join(fixture.stored, TOOLS_NAME)], 'the plain session writes only what it can see');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'the injected copy still holds the previous value');

    const herdr = await modeLib.updatePluginTools({ issues: false }, { env: fixture.herdrEnv, pollMs: 10 });
    assert.deepEqual(
      herdr.paths,
      [path.join(fixture.stored, TOOLS_NAME), path.join(fixture.injected, TOOLS_NAME)],
      'the Herdr session applies its own key to both copies',
    );
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, false), 'the requested key is applied');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, false), 'the disputed key keeps its own value, nothing is lost');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // The disputed key itself stays a human decision: the flip is refused, both
  // files are named, and neither copy is touched.
  test('flipping the key the two copies disagree about refuses and names both files', async () => {
    const fixture = sandbox('b2-disputed');
    seedTools(fixture.stored, true, true);
    seedTools(fixture.injected, true, true);
    await modeLib.updatePluginTools({ odd: false }, { env: fixture.plainEnv, pollMs: 10 });

    await assert.rejects(
      modeLib.updatePluginTools({ odd: true }, { env: fixture.herdrEnv, pollMs: 10 }),
      (err) => /different values/i.test(err.message)
        && err.message.includes(path.join(fixture.stored, TOOLS_NAME))
        && err.message.includes(path.join(fixture.injected, TOOLS_NAME))
        && /nothing was written/i.test(err.message),
    );
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true), 'the disputed stored value is kept');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'the disputed injected value is kept');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // THE BUG: the plain session's lock lived in the stored dir and the Herdr
  // session's in the injected dir, so a Herdr flip walked straight through a
  // plain flip that had already read the shared copy.
  test('a Herdr session waits for the lock a plain session resolved, and both flips survive', async () => {
    const fixture = sandbox('barrier');
    seedTools(fixture.stored, true, true);
    const plainLock = seedLock(modeLib.pluginToolsLockPath(fixture.plainEnv), {
      token: 'plain-session',
      pid: process.pid,
      host: os.hostname(),
    });
    assert.equal(fs.realpathSync(path.dirname(plainLock)), fs.realpathSync(fixture.stored), 'the plain session locks the shared stored copy');

    // Session A (plain) is mid-flip: its lock is held and it has not written yet.
    const child = spawnUpdate(fixture.herdrEnv, { issues: false });
    await wait(400);
    assert.equal(child.child.exitCode, null, 'the Herdr session waits for the shared path lock');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(true, true), 'it wrote nothing while the plain session was mid-flip');
    assert.equal(toolsBytesOf(fixture.injected), null, 'it created no copy before reading the merged state');

    // Session A commits its own flip of ODD, then releases its lock.
    seedTools(fixture.stored, false, true);
    fs.unlinkSync(plainLock);

    const outcome = await child.done;
    assert.equal(outcome.code, 0, `the Herdr session succeeded: ${outcome.stderr()}`);
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, false), 'both flips survive on the shared copy');
    assert.equal(
      toolsBytesOf(fixture.injected),
      null,
      'it still writes only the copy that existed, never a second one',
    );
    assert.deepEqual(
      modeLib.readPluginTools(fixture.herdrEnv),
      { state: 'ok', odd: false, issues: false },
      'the pair reads back without a conflict',
    );
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // Two sessions with the SAME environment take the same ordered set, so both
  // flips land and neither can wait on the other forever.
  test('two sessions in the same environment keep both flips without deadlocking', async () => {
    const fixture = sandbox('same-env');
    seedTools(fixture.stored, true, true);
    seedTools(fixture.injected, true, true);

    const odd = spawnUpdate(fixture.herdrEnv, { odd: false });
    const issues = spawnUpdate(fixture.herdrEnv, { issues: false });
    const [first, second] = await Promise.all([odd.done, issues.done]);
    assert.equal(first.code, 0, `the ODD flip succeeded: ${first.stderr()}`);
    assert.equal(second.code, 0, `the Issues flip succeeded: ${second.stderr()}`);
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, false), 'both flips survive on the stored copy');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, false), 'both flips survive on the injected copy');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // Repeats the concurrent shape over several rounds: a deadlock shows up as a
  // session that never finishes, which fails here as a failed flip.
  test('repeated concurrent rounds never leave a flip waiting forever', async () => {
    const fixture = sandbox('rounds');
    seedTools(fixture.stored, true, true);
    seedTools(fixture.injected, true, true);
    for (let round = 0; round < 3; round += 1) {
      const wanted = round % 2 === 0;
      const odd = spawnUpdate(fixture.herdrEnv, { odd: wanted });
      const issues = spawnUpdate(fixture.herdrEnv, { issues: wanted });
      const [first, second] = await Promise.all([odd.done, issues.done]);
      assert.equal(first.code, 0, `round ${round}: ODD flip failed: ${first.stderr()}`);
      assert.equal(second.code, 0, `round ${round}: Issues flip failed: ${second.stderr()}`);
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(wanted, wanted), `round ${round}: both copies agree on the stored dir`);
      assert.equal(toolsBytesOf(fixture.injected), toolsBody(wanted, wanted), `round ${round}: both copies agree on the injected dir`);
    }
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // Boundary: a plain session can only SEE the shared copy, so its flip leaves
  // the pair disagreeing on the key it changed. The next Herdr session must
  // report that honestly — and must still be able to flip the OTHER key.
  test('a disagreement is reported for reads but never loses either value', async () => {
    const fixture = sandbox('diverged');
    seedTools(fixture.stored, true, true);
    seedTools(fixture.injected, true, true);

    const plain = await modeLib.updatePluginTools({ odd: false }, { env: fixture.plainEnv, pollMs: 10 });
    assert.deepEqual(plain.paths, [path.join(fixture.stored, TOOLS_NAME)], 'the plain session writes the one copy it can see');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'the copy it cannot see is untouched');

    const detail = modeLib.readPluginToolsDetail(fixture.herdrEnv);
    assert.equal(detail.state, 'conflict', 'the disagreement stays visible, never silently resolved');
    assert.deepEqual(detail.conflicts, ['odd'], 'only the disagreeing key is ambiguous');
    assert.equal(detail.issues, true, 'the agreed key keeps its value');
    assert.ok(detail.diagnostic.includes(path.join(fixture.stored, TOOLS_NAME)), 'the diagnostic names the canonical copy');
    assert.ok(detail.diagnostic.includes(path.join(fixture.injected, TOOLS_NAME)), 'the diagnostic names the legacy copy');
  });

  // A copy that does not parse reads as BOTH toggles disabled (fail closed). A
  // flip of one key must not invent "enabled" for the other one: the untouched
  // key keeps exactly the value the read reported, so turning ODD on cannot
  // silently re-enable Issues.
  test('flipping one key never invents a value for the other key of an unreadable copy', async () => {
    const fixture = sandbox('malformed-untouched');
    const storedFile = path.join(fixture.stored, TOOLS_NAME);
    fs.writeFileSync(storedFile, '{"version":1,"odd":true}\n');
    assert.deepEqual(
      modeLib.readPluginTools(fixture.plainEnv),
      { state: 'malformed', odd: false, issues: false },
      'the unparseable copy reads as both toggles disabled',
    );

    const result = await modeLib.updatePluginTools({ odd: true }, { env: fixture.plainEnv, pollMs: 10 });
    assert.equal(result.odd, true, 'the requested key is applied');
    assert.equal(result.issues, false, 'the untouched key keeps the fail-closed value the read reported');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(true, false), 'Issues is not silently re-enabled');
    assert.deepEqual(result.repaired, [storedFile], 'the repaired copy is named');
    assert.deepEqual(modeLib.readPluginTools(fixture.plainEnv), { state: 'ok', odd: true, issues: false });
  });

  // The same rule from the other direction, and for a copy that appears beside
  // a readable one: only the flipped keys may change.
  test('flipping a key of an unreadable copy beside a readable one preserves the readable values', async () => {
    const fixture = sandbox('malformed-beside');
    seedTools(fixture.stored, true, false);
    fs.writeFileSync(path.join(fixture.injected, TOOLS_NAME), 'not json\n');

    const result = await modeLib.updatePluginTools({ odd: false }, { env: fixture.herdrEnv, pollMs: 10 });
    assert.equal(result.issues, false, 'the readable copy\'s Issues value is preserved');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, false));
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, false), 'the repaired copy adopts the merged values');
    assert.deepEqual(result.repaired, [path.join(fixture.injected, TOOLS_NAME)]);
  });

  // The exact limitation of the canonical-source rule, pinned so it stays
  // truthful: a plain session cannot discover an arbitrary injected dir, so a
  // copy an older writer left there is invisible to its read (missing means
  // enabled) and its first write therefore cannot adopt that copy's values.
  // What it must never do is destroy them: the legacy file stays byte-identical.
  test('a plain session\'s first write never destroys a legacy copy it cannot see', async () => {
    const fixture = sandbox('legacy-only-plain');
    const storedFile = path.join(fixture.stored, TOOLS_NAME);
    const injectedFile = path.join(fixture.injected, TOOLS_NAME);
    seedTools(fixture.injected, false, false);

    assert.deepEqual(
      modeLib.readPluginTools(fixture.plainEnv),
      { state: 'missing', odd: true, issues: true },
      'a plain session sees the documented missing-file default, not the legacy copy',
    );
    const result = await modeLib.updatePluginTools({ odd: false }, { env: fixture.plainEnv, pollMs: 10 });
    assert.deepEqual(result.paths, [storedFile], 'it writes the shared canonical copy');
    assert.deepEqual(result.repaired, [], 'nothing was repaired: it could not see the legacy copy');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, false), 'the legacy copy is left exactly as it was');

    // From then on every session that can see both reports the mismatch and
    // fails closed on that key — the stale value is never silently dropped.
    const detail = modeLib.readPluginToolsDetail(fixture.herdrEnv);
    assert.equal(detail.state, 'conflict');
    assert.deepEqual(detail.conflicts, ['issues'], 'only the key the plain session could not see is disputed');
    assert.ok(detail.diagnostic.includes(storedFile), 'the diagnostic names the canonical copy');
    assert.ok(detail.diagnostic.includes(injectedFile), 'the diagnostic names the legacy copy');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // A lock whose owner is provably gone is still broken, per path, and every
  // other lock the flip takes is released again.
  test('a dead-owner lock on one candidate path is broken and no lock is left behind', async () => {
    const fixture = sandbox('stale-cross');
    seedTools(fixture.stored, true, true);
    const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    assert.equal(dead.status, 0, 'the helper process exited');
    const storedLock = seedLock(modeLib.pluginToolsLockPath(fixture.plainEnv), {
      token: 'abandoned-token',
      pid: dead.pid,
      host: os.hostname(),
    });

    const result = await modeLib.updatePluginTools({ odd: false }, { env: fixture.herdrEnv, timeoutMs: 3000, pollMs: 10 });
    assert.deepEqual(result.paths, [path.join(fixture.stored, TOOLS_NAME)], 'only the existing copy is written');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true));
    assert.equal(fs.existsSync(storedLock), false, 'the abandoned lock is gone');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // A failure part-way through a multi-copy write must say what it already
  // wrote: the copies are no longer identical and the caller has to know.
  // The failure is injected at the replace step of the SECOND copy, which is
  // the only window in which a multi-copy write can be half applied.
  test('a partial multi-copy write names every copy it already wrote', async () => {
    const fixture = sandbox('partial');
    seedTools(fixture.stored, true, true);
    seedTools(fixture.injected, true, true);
    const injectedFile = path.join(fixture.injected, TOOLS_NAME);
    const storedFile = path.join(fixture.stored, TOOLS_NAME);
    const realRename = fs.renameSync;
    // The canonical copy is written first, so failing the legacy copy is the
    // second write — the only window in which a multi-copy write is half applied.
    fs.renameSync = (from, to, ...rest) => {
      if (to === injectedFile) {
        const err = new Error('EIO: simulated write failure');
        err.code = 'EIO';
        throw err;
      }
      return realRename(from, to, ...rest);
    };
    try {
      await assert.rejects(
        modeLib.updatePluginTools({ odd: false }, { env: fixture.herdrEnv, pollMs: 10 }),
        (err) => err.message.includes(injectedFile)
          && err.message.includes(storedFile)
          && /already written/i.test(err.message)
          && !/nothing was written/i.test(err.message)
          && err.written.length === 1,
      );
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true), 'the copy it wrote holds the new value');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'the copy it could not write is untouched');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // The same fault on a flip that owns one copy only must not pretend it wrote
  // something, and it still leaves no lock behind.
  test('a failed single-copy write reports nothing written and releases its locks', async () => {
    const fixture = sandbox('partial-single');
    seedTools(fixture.stored, true, true);
    const storedFile = path.join(fixture.stored, TOOLS_NAME);
    const realRename = fs.renameSync;
    fs.renameSync = (from, to, ...rest) => {
      if (to === storedFile) {
        const err = new Error('EIO: simulated write failure');
        err.code = 'EIO';
        throw err;
      }
      return realRename(from, to, ...rest);
    };
    try {
      await assert.rejects(
        modeLib.updatePluginTools({ odd: false }, { env: fixture.herdrEnv, pollMs: 10 }),
        (err) => /nothing was written/i.test(err.message) && !/already written/i.test(err.message),
      );
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(true, true), 'the only copy is unchanged');
    assert.equal(toolsBytesOf(fixture.injected), null, 'no second copy was created');
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });

  // Repairing an unreadable duplicate discards whatever the user had in it, so
  // a flip reports the copy it repaired instead of overwriting it silently.
  test('a flip that repairs an unreadable duplicate names the copy it overwrote', async () => {
    const fixture = sandbox('repair');
    seedTools(fixture.stored, true, true);
    const injectedFile = path.join(fixture.injected, TOOLS_NAME);
    fs.writeFileSync(injectedFile, '{"version":1,"odd":true}\n');
    assert.equal(modeLib.readPluginToolsDetail(fixture.herdrEnv).state, 'ok', 'the readable copy decides');

    const result = await modeLib.updatePluginTools({ odd: false }, { env: fixture.herdrEnv, pollMs: 10 });
    assert.deepEqual(result.repaired, [injectedFile], 'the repaired copy is reported by path');
    assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, true), 'the repaired copy now agrees');
    assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true));
    assertNoLitter(fixture.stored);
    assertNoLitter(fixture.injected);
  });
});
