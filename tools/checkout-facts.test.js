'use strict';
// warp-popup W1 tests (S2, S4, S9): lib/checkout-facts.js and the new
// ahead/behind helper in lib/worktree-git.js.
//
// Every fixture is a REAL git repository (principal + linked worktrees)
// created under os.tmpdir(), driven with fixed-argv `git` calls. Nothing
// touches the repository under test, the user's checkouts, or a live
// Herdr/gh/Pi surface. Assertions go through the public API only.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gitLib = require('../lib/worktree-git.js');
const factsLib = require('../lib/checkout-facts.js');

// An `fs` seam for the facts module's only fs read (the createdAt birth-time
// fallback), so the fallback is asserted against a known timestamp instead of
// whatever the host filesystem reports.
function birthFs(ms) {
  return { statSync: () => ({ birthtimeMs: ms }) };
}

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

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function slug(text) {
  return String(text).replace(/[^a-z0-9]+/gi, '-');
}

// Principal checkout with one commit on `defaultBranch`.
function makeRepo(tag, defaultBranch = 'main') {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `checkout-facts-${slug(tag)}-`)));
  git(dir, ['init', '-b', defaultBranch]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return fs.realpathSync(dir);
}

// Linked worktree on a new branch cut from the principal's HEAD.
function addWorktree(root, branch) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `checkout-facts-wt-${slug(branch)}-`)));
  git(root, ['worktree', 'add', '-b', branch, dir]);
  return fs.realpathSync(dir);
}

function commit(cwd, message, files) {
  for (const [rel, body] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(cwd, rel), body);
  }
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', message]);
}

function writeRow(root, row) {
  fs.writeFileSync(
    path.join(root, '.git', 'pi-worktrees.json'),
    `${JSON.stringify({ version: 1, worktrees: row === null ? [] : [row] }, null, 2)}\n`,
  );
}

function makeFacts(root, extra = {}) {
  return factsLib.createCheckoutFacts({
    repoRoot: root,
    ttlMs: 60000,
    now: () => 1000,
    ...extra,
  });
}

function countingRunner() {
  const calls = [];
  return {
    calls,
    runAsync(bin, args, cwd) {
      calls.push(`${bin} ${args.join(' ')}`);
      return gitLib.runArgvAsync(bin, args, { cwd, timeoutMs: 30000 });
    },
  };
}

const fullRow = (wtPath, branch) => ({
  branch,
  path: wtPath,
  thread: 'warp-popup',
  issues: ['#12', '#31'],
  odd: ['odd/tasks/warp-popup.md'],
  createdAt: '2024-01-02T03:04:05.000Z',
  updatedAt: '2024-01-03T00:00:00.000Z',
});

describe('worktree-git lastCommitTime', { concurrency: false }, () => {
  test('reads the last commit timestamp of a checkout', async () => {
    const root = makeRepo('last-commit');
    const wt = addWorktree(root, 'feat/last-commit');
    commit(wt, 'only', { 'a.txt': 'a\n' });
    const expected = Number(git(wt, ['log', '-1', '--format=%ct'])) * 1000;
    const result = await gitLib.lastCommitTime(wt);
    assert.equal(result.ok, true);
    assert.equal(result.timestampMs, expected);
  });

  test('never throws on a directory that is not a checkout', async () => {
    const notRepo = track(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-facts-lastcommit-')));
    const result = await gitLib.lastCommitTime(notRepo);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.timestampMs, undefined);
  });
});

describe('worktree-git aheadBehind', { concurrency: false }, () => {
  test('counts commits ahead of main and names the base it used', async () => {
    const root = makeRepo('ahead-helper');
    const wt = addWorktree(root, 'feat/ahead');
    commit(wt, 'one', { 'a.txt': 'a\n' });
    commit(wt, 'two', { 'b.txt': 'b\n' });
    const result = await gitLib.aheadBehind(wt);
    assert.deepEqual(result, {
      ok: true, ahead: 2, behind: 0, base: 'main', baseSource: 'conventional',
    });
  });

  test('never throws on a directory that is not a checkout', async () => {
    const notRepo = track(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-facts-notrepo-')));
    const result = await gitLib.aheadBehind(notRepo);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.equal(result.ahead, undefined);
    assert.equal(result.behind, undefined);
  });

  test('an injected base that does not exist is an error, never a silent guess', async () => {
    const root = makeRepo('bogus-base');
    const wt = addWorktree(root, 'feat/bogus');
    const result = await gitLib.aheadBehind(wt, { base: 'no-such-base' });
    assert.equal(result.ok, false);
    assert.match(result.error, /no-such-base/);
  });

  test('resolves the principal branch when the default branch is not main', async () => {
    const root = makeRepo('non-main', 'work');
    const wt = addWorktree(root, 'feat/non-main');
    commit(root, 'principal moved', { 'p.txt': 'p\n' });
    const result = await gitLib.aheadBehind(wt);
    assert.deepEqual(result, {
      ok: true, ahead: 0, behind: 1, base: 'work', baseSource: 'principal',
    });
  });
});

// PRESERVE: `listWorktrees` now shares its parser with the ahead/behind
// path, so its existing contract is pinned here — same shape, principal and
// linked worktrees both listed, a detached checkout marked, and a non-repo
// still throwing.
describe('worktree-git listWorktrees (unchanged behaviour)', { concurrency: false }, () => {
  test('lists the principal and linked checkouts with branch and detached flags', () => {
    const root = makeRepo('listing');
    const wt = addWorktree(root, 'feat/listing');
    const entries = gitLib.listWorktrees(root);
    assert.deepEqual(entries.map((entry) => ({ path: path.resolve(entry.path), branch: entry.branch })), [
      { path: root, branch: 'main' },
      { path: wt, branch: 'feat/listing' },
    ]);
    for (const entry of entries) {
      assert.equal(entry.detached, false);
      assert.equal(entry.bare, false);
      assert.equal(typeof entry.head, 'string');
    }
  });

  test('a directory that is not a repository still throws', () => {
    const notRepo = track(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-facts-notrepo-list-')));
    assert.throws(() => gitLib.listWorktrees(notRepo), /git worktree list failed/);
  });
});

describe('checkout-facts', { concurrency: false }, () => {
  test('a fresh worktree reports its branch, base, zero changes and zero ahead/behind', async () => {
    const root = makeRepo('fresh');
    const wt = addWorktree(root, 'feat/fresh');
    writeRow(root, fullRow(wt, 'feat/fresh'));
    const got = await makeFacts(root).facts(wt);
    assert.equal(got.checkout, wt);
    assert.deepEqual(got.branch, { available: true, value: 'feat/fresh', reason: null, detached: false });
    assert.equal(got.changes.available, true);
    assert.equal(got.changes.value.files, 0);
    assert.equal(got.changes.value.added, 0);
    assert.equal(got.changes.value.deleted, 0);
    assert.equal(got.changes.value.text, '0 files, +0/-0');
    assert.equal(got.aheadBehind.available, true);
    assert.deepEqual(got.aheadBehind.value, {
      ahead: 0, behind: 0, base: 'main', baseSource: 'conventional',
    });
    assert.deepEqual(got.issues, { available: true, value: ['#12', '#31'], reason: null });
    assert.deepEqual(got.odd, { available: true, value: ['odd/tasks/warp-popup.md'], reason: null });
    assert.deepEqual(got.createdAt, { available: true, value: '2024-01-02T03:04:05.000Z', reason: null, source: 'registry' });
    const commitMs = Number(git(wt, ['log', '-1', '--format=%ct'])) * 1000;
    assert.deepEqual(got.lastActivity, {
      available: true, value: new Date(commitMs).toISOString(), reason: null, source: 'commit',
    });
  });

  test('uncommitted changes are counted, untracked files included', async () => {
    const root = makeRepo('dirty');
    const wt = addWorktree(root, 'feat/dirty');
    writeRow(root, fullRow(wt, 'feat/dirty'));
    fs.writeFileSync(path.join(wt, 'base.txt'), 'base\nmore\n');
    fs.writeFileSync(path.join(wt, 'untracked.txt'), 'u1\nu2\nu3\n');
    const got = await makeFacts(root).facts(wt);
    assert.equal(got.changes.available, true);
    assert.equal(got.changes.value.files, 2);
    assert.equal(got.changes.value.added, 4, JSON.stringify(got.changes.value));
    assert.equal(got.changes.value.deleted, 0);
    assert.equal(got.changes.value.text, '2 files, +4/-0');
    // A dirty checkout is still zero commits ahead: the two facts are independent.
    assert.equal(got.aheadBehind.value.ahead, 0);
  });

  test('a checkout ahead of the base reports ahead, never behind', async () => {
    const root = makeRepo('ahead');
    const wt = addWorktree(root, 'feat/ahead');
    writeRow(root, fullRow(wt, 'feat/ahead'));
    commit(wt, 'one', { 'a.txt': 'a\n' });
    commit(wt, 'two', { 'b.txt': 'b\n' });
    commit(wt, 'three', { 'c.txt': 'c\n' });
    const got = await makeFacts(root).facts(wt);
    assert.deepEqual(got.aheadBehind.value, {
      ahead: 3, behind: 0, base: 'main', baseSource: 'conventional',
    });
    assert.equal(got.changes.value.files, 0);
  });

  test('a checkout behind the base reports behind, never ahead', async () => {
    const root = makeRepo('behind');
    const wt = addWorktree(root, 'feat/behind');
    writeRow(root, fullRow(wt, 'feat/behind'));
    commit(root, 'principal one', { 'p1.txt': 'p1\n' });
    commit(root, 'principal two', { 'p2.txt': 'p2\n' });
    const got = await makeFacts(root).facts(wt);
    assert.deepEqual(got.aheadBehind.value, {
      ahead: 0, behind: 2, base: 'main', baseSource: 'conventional',
    });
  });

  test('a diverged checkout reports both numbers non-zero', async () => {
    const root = makeRepo('diverged');
    const wt = addWorktree(root, 'feat/diverged');
    writeRow(root, fullRow(wt, 'feat/diverged'));
    commit(wt, 'mine', { 'mine.txt': 'm\n' });
    commit(root, 'theirs one', { 't1.txt': 't1\n' });
    commit(root, 'theirs two', { 't2.txt': 't2\n' });
    const got = await makeFacts(root).facts(wt);
    assert.deepEqual(got.aheadBehind.value, {
      ahead: 1, behind: 2, base: 'main', baseSource: 'conventional',
    });
  });

  test('a failing git read is unavailable, never zero', async () => {
    const root = makeRepo('unreadable');
    const broken = track(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-facts-broken-')));
    fs.writeFileSync(path.join(broken, 'file.txt'), 'x\n');
    // A registry row exists for this path, so the failure must be scoped:
    // the registry facts stay available while the git facts go unavailable.
    writeRow(root, fullRow(broken, 'feat/broken'));
    const got = await makeFacts(root).facts(broken);
    for (const field of ['branch', 'changes', 'aheadBehind', 'lastActivity']) {
      assert.equal(got[field].available, false, `${field} must be unavailable`);
      assert.equal(got[field].value, null, `${field} must not carry a value`);
      assert.equal(typeof got[field].reason, 'string');
      assert.ok(got[field].reason.length > 0);
    }
    assert.deepEqual(got.issues, { available: true, value: ['#12', '#31'], reason: null });
  });

  test('a checkout with no registry row reports issues/odd unavailable and createdAt from the birth time', async () => {
    const root = makeRepo('no-row');
    const wt = addWorktree(root, 'feat/no-row');
    const birth = 1_700_000_000_000;
    const got = await makeFacts(root, { fs: birthFs(birth) }).facts(wt);
    for (const field of ['issues', 'odd']) {
      assert.equal(got[field].available, false, `${field} must be unavailable`);
      assert.equal(got[field].value, null, `${field} must not carry a value`);
      assert.match(got[field].reason, /registry/i);
    }
    assert.deepEqual(got.createdAt, {
      available: true, value: new Date(birth).toISOString(), reason: null, source: 'birthtime',
    });
    // The git facts do not depend on the registry.
    assert.deepEqual(got.branch, { available: true, value: 'feat/no-row', reason: null, detached: false });
    assert.equal(got.changes.available, true);
    assert.equal(got.aheadBehind.available, true);
  });

  test('a malformed registry makes only the registry facts unavailable', async () => {
    const root = makeRepo('bad-row');
    const wt = addWorktree(root, 'feat/bad-row');
    fs.writeFileSync(path.join(root, '.git', 'pi-worktrees.json'), '{not json');
    const got = await makeFacts(root).facts(wt);
    for (const field of ['issues', 'odd']) {
      assert.equal(got[field].available, false);
      assert.match(got[field].reason, /registry/i);
    }
    // A malformed registry has no row, so the birth-time fallback answers.
    assert.equal(got.createdAt.available, true);
    assert.equal(got.createdAt.source, 'birthtime');
    assert.equal(got.branch.available, true);
    assert.equal(got.aheadBehind.available, true);
  });

  test('lastActivity comes from the newest uncommitted file when the commit cannot be read', async () => {
    const root = makeRepo('activity-dirty');
    const wt = addWorktree(root, 'feat/activity-dirty');
    writeRow(root, fullRow(wt, 'feat/activity-dirty'));
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'd\n');
    const dirtyMs = Math.trunc(fs.statSync(path.join(wt, 'dirty.txt')).mtimeMs);
    const facts = makeFacts(root, { lastCommit: async () => ({ ok: false, error: 'no commits yet' }) });
    const got = await facts.facts(wt);
    assert.equal(got.changes.value.files, 1);
    assert.deepEqual(got.lastActivity, {
      available: true, value: new Date(dirtyMs).toISOString(), reason: null, source: 'dirty',
    });
  });

  test('lastActivity is the greater of the commit and the newest uncommitted file', async () => {
    const root = makeRepo('activity-max');
    const wt = addWorktree(root, 'feat/activity-max');
    writeRow(root, fullRow(wt, 'feat/activity-max'));
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'd\n');
    const dirtyMs = Math.trunc(fs.statSync(path.join(wt, 'dirty.txt')).mtimeMs);
    const older = dirtyMs - 3_600_000;
    const newer = dirtyMs + 3_600_000;
    const dirtyWins = await makeFacts(root, {
      lastCommit: async () => ({ ok: true, timestampMs: older }),
    }).facts(wt);
    assert.equal(dirtyWins.lastActivity.source, 'dirty');
    assert.equal(Date.parse(dirtyWins.lastActivity.value), dirtyMs);
    const commitWins = await makeFacts(root, {
      lastCommit: async () => ({ ok: true, timestampMs: newer }),
    }).facts(wt);
    assert.equal(commitWins.lastActivity.source, 'commit');
    assert.equal(Date.parse(commitWins.lastActivity.value), newer);
  });

  test('lastActivity is unavailable with a reason when neither the commit nor the changes can be read', async () => {
    const root = makeRepo('activity-none');
    const broken = track(fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-facts-activity-none-')));
    fs.writeFileSync(path.join(broken, 'file.txt'), 'x\n');
    writeRow(root, fullRow(broken, 'feat/broken-activity'));
    const got = await makeFacts(root).facts(broken);
    assert.equal(got.lastActivity.available, false);
    assert.equal(got.lastActivity.value, null);
    assert.equal(typeof got.lastActivity.reason, 'string');
    assert.ok(got.lastActivity.reason.length > 0);
  });

  test('createdAt comes from the registry row when there is one', async () => {
    const root = makeRepo('created-registry');
    const wt = addWorktree(root, 'feat/created-registry');
    writeRow(root, fullRow(wt, 'feat/created-registry'));
    const got = await makeFacts(root).facts(wt);
    assert.deepEqual(got.createdAt, {
      available: true, value: '2024-01-02T03:04:05.000Z', reason: null, source: 'registry',
    });
  });

  test('createdAt falls back to the directory birth time when there is no registry row', async () => {
    const root = makeRepo('created-birth');
    const wt = addWorktree(root, 'feat/created-birth');
    const birth = 1_700_000_000_000;
    const got = await makeFacts(root, { fs: birthFs(birth) }).facts(wt);
    assert.deepEqual(got.createdAt, {
      available: true, value: new Date(birth).toISOString(), reason: null, source: 'birthtime',
    });
  });

  test('createdAt stays unavailable when neither a registry row nor a birth time can be read', async () => {
    const root = makeRepo('created-none');
    const got = await makeFacts(root, { fs: birthFs(0) }).facts(path.join(root, 'does-not-exist'));
    assert.equal(got.createdAt.available, false);
    assert.equal(got.createdAt.value, null);
    assert.equal(got.createdAt.source, null);
    assert.match(got.createdAt.reason, /registry/i);
  });

  test('lastActivity shares the dirty summary instead of reading the changes twice', async () => {
    const root = makeRepo('activity-shared');
    const wt = addWorktree(root, 'feat/activity-shared');
    writeRow(root, fullRow(wt, 'feat/activity-shared'));
    const runner = countingRunner();
    const facts = factsLib.createCheckoutFacts({
      repoRoot: root, runAsync: runner.runAsync, ttlMs: 5000, now: () => 1000,
    });
    await facts.facts(wt);
    const count = (needle) => runner.calls.filter((call) => call.includes(needle)).length;
    assert.equal(count('git diff'), 1, runner.calls.join('\n'));
    assert.equal(count('git status'), 1, runner.calls.join('\n'));
    assert.equal(count('git log'), 1, runner.calls.join('\n'));
  });

  test('a second facts() call inside the TTL spawns no git at all', async () => {
    const root = makeRepo('cache');
    const wt = addWorktree(root, 'feat/cache');
    writeRow(root, fullRow(wt, 'feat/cache'));
    const runner = countingRunner();
    let clock = 1000;
    const facts = factsLib.createCheckoutFacts({
      repoRoot: root,
      runAsync: runner.runAsync,
      ttlMs: 5000,
      now: () => clock,
    });
    const first = await facts.facts(wt);
    assert.equal(first.cached, false);
    assert.ok(runner.calls.length > 0, 'the first read must spawn git');
    const firstCount = runner.calls.length;
    assert.ok(runner.calls.some((call) => call.includes('git diff')), runner.calls.join('\n'));
    assert.ok(runner.calls.some((call) => call.includes('rev-list')), runner.calls.join('\n'));
    clock += 4999;
    const second = await facts.facts(wt);
    assert.equal(runner.calls.length, firstCount, `cached read spawned git: ${runner.calls.join('\n')}`);
    assert.equal(second.cached, true);
    assert.deepEqual({ ...second, cached: false }, { ...first, cached: false });
    // Past the TTL the read runs again.
    clock += 2;
    await facts.facts(wt);
    assert.ok(runner.calls.length > firstCount, 'an expired entry must re-read');
  });

  test('peek() answers from the cache without spawning, and does not invent facts', async () => {
    const root = makeRepo('peek');
    const wt = addWorktree(root, 'feat/peek');
    writeRow(root, fullRow(wt, 'feat/peek'));
    const runner = countingRunner();
    const facts = factsLib.createCheckoutFacts({
      repoRoot: root, runAsync: runner.runAsync, ttlMs: 5000, now: () => 1000,
    });
    assert.equal(facts.peek(wt), null);
    await facts.facts(wt);
    const before = runner.calls.length;
    const shown = facts.peek(wt);
    assert.equal(runner.calls.length, before);
    assert.equal(shown.cached, true);
    assert.equal(shown.stale, false);
    assert.equal(shown.branch.value, 'feat/peek');
  });

  test('two concurrent calls share one read', async () => {
    const root = makeRepo('inflight');
    const wt = addWorktree(root, 'feat/inflight');
    writeRow(root, fullRow(wt, 'feat/inflight'));
    const runner = countingRunner();
    const facts = factsLib.createCheckoutFacts({
      repoRoot: root, runAsync: runner.runAsync, ttlMs: 5000, now: () => 1000,
    });
    const [a, b] = await Promise.all([facts.facts(wt), facts.facts(wt)]);
    const diffCalls = runner.calls.filter((call) => call.includes('git diff')).length;
    assert.equal(diffCalls, 1, runner.calls.join('\n'));
    assert.equal(a.changes.value.files, b.changes.value.files);
  });
});
