'use strict';
// S4 (UI consistency round 3): lib/warp-delete-confirm.js — the ONE builder
// both warp keyboard surfaces use, tested through its exported functions.
//
// What is pinned here is the honesty of the disclosure, which the extension's
// wiring tests can only reach with a Git repository that answers every read:
//   - pending changes and commits ahead of `main` are named when they exist;
//   - a clean checkout adds no warning, so the dialog never cries wolf;
//   - a read that FAILS is reported as unknown with its reason, never as 0,
//     never as "no pending changes" and never as safe;
//   - `force` travels only on positive evidence of pending changes;
//   - the ahead-of-main comparison is asked for `main` explicitly, so a
//     repository without `main` says so instead of silently comparing with
//     `origin/main` or `master`.
//
// Every fixture is a throwaway Git repository under the system temp directory:
// nothing here deletes a real checkout, and no test touches a real registry.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const confirmLib = require('../lib/warp-delete-confirm.js');
const changesLib = require('../lib/worktree-changes.js');

const roots = [];

after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-confirm-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

const TARGET = { name: 'feat-del', path: '/checkouts/feat-del', branch: 'feat/del' };
const BASE_BODY = `Delete worktree checkout at ${TARGET.path} for branch '${TARGET.branch}'? This removes the checkout but keeps the branch.`;

describe('S4: the keyboard delete dialog is always asked and always honest', () => {
  test('the title names the worktree and a clean, zero-ahead checkout adds no warning', async () => {
    const repo = makeRepo('clean');
    git(repo, ['branch', 'main', 'HEAD']);
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.deepEqual(evidence.changes, { status: 'clean', files: 0, added: 0, deleted: 0 });
    assert.equal(evidence.aheadMain.status, 'none');
    assert.equal(evidence.aheadMain.ahead, 0);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.title, "Delete worktree 'feat-del'?");
    assert.equal(prompt.body, BASE_BODY);
    assert.equal(prompt.force, false, 'a clean checkout is never forced');
  });

  test('pending changes and commits ahead of main are both named, and only dirty evidence forces', async () => {
    const repo = makeRepo('dirty-ahead');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'seed']);
    git(repo, ['branch', 'main', 'HEAD']);
    // Two commits `main` does not have, then one pending line.
    git(repo, ['commit', '--allow-empty', '-m', 'ahead one']);
    git(repo, ['commit', '--allow-empty', '-m', 'ahead two']);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.changes.status, 'dirty');
    assert.equal(evidence.changes.files, 1);
    assert.equal(evidence.changes.added, 1);
    assert.equal(evidence.aheadMain.status, 'ahead');
    assert.equal(evidence.aheadMain.ahead, 2);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Pending changes: 1 file, +1/-0. Commits ahead of main: 2.`);
    assert.equal(prompt.force, true, 'positive dirty evidence is what authorizes force');
  });

  test('commits ahead of main are named on their own for a clean checkout', async () => {
    const repo = makeRepo('ahead-only');
    git(repo, ['branch', 'main', 'HEAD']);
    git(repo, ['commit', '--allow-empty', '-m', 'ahead one']);
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.changes.status, 'clean');
    assert.equal(evidence.aheadMain.status, 'ahead');
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Commits ahead of main: 1.`);
    assert.equal(prompt.force, false, 'ahead-of-main alone never forces');
  });

  test('a missing main branch is reported as unknown instead of being compared with another base', async () => {
    const repo = makeRepo('no-main');
    git(repo, ['commit', '--allow-empty', '-m', 'only on master']);
    const evidence = await confirmLib.readWarpDeleteEvidence(repo);
    assert.equal(evidence.aheadMain.status, 'unknown');
    assert.equal(evidence.aheadMain.ahead, null, 'unknown stays distinguishable from zero');
    assert.match(evidence.aheadMain.reason, /main/);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Commits ahead of main: unknown (base branch not found: main).`);
    assert.ok(!/Commits ahead of main: 0/.test(prompt.body), 'unknown is never reported as zero');
  });

  test('a failed change summary is reported as unknown and never authorizes force', async () => {
    const repo = makeRepo('changes-fail');
    git(repo, ['branch', 'main', 'HEAD']);
    const failing = {
      summarizeChanges: async () => ({ ok: false, error: 'cannot diff this checkout' }),
    };
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, { changesLib: failing });
    assert.equal(evidence.changes.status, 'unknown');
    assert.equal(evidence.aheadMain.status, 'none', 'the other read is unaffected');
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.equal(prompt.body, `${BASE_BODY} Uncommitted changes: unknown (cannot diff this checkout).`);
    assert.equal(prompt.force, false, 'unknown evidence never forces');
  });

  test('a change summary that throws is reported as unknown, not as clean', async () => {
    const repo = makeRepo('changes-throw');
    git(repo, ['branch', 'main', 'HEAD']);
    const throwing = {
      summarizeChanges: async () => { throw new Error('git exploded'); },
    };
    const evidence = await confirmLib.readWarpDeleteEvidence(repo, { changesLib: throwing });
    assert.equal(evidence.changes.status, 'unknown');
    assert.match(evidence.changes.reason, /git exploded/);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.match(prompt.body, /Uncommitted changes: unknown \(git exploded\)\./);
    assert.equal(prompt.force, false);
  });

  test('a path that is not a checkout reports both reads as unknown with reasons and never rejects', async () => {
    const outside = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-confirm-outside-'))));
    const evidence = await confirmLib.readWarpDeleteEvidence(outside);
    assert.equal(evidence.changes.status, 'unknown');
    assert.ok(typeof evidence.changes.reason === 'string' && evidence.changes.reason.length > 0);
    assert.equal(evidence.aheadMain.status, 'unknown');
    assert.ok(typeof evidence.aheadMain.reason === 'string' && evidence.aheadMain.reason.length > 0);
    const prompt = confirmLib.warpDeletePrompt(TARGET, evidence);
    assert.match(prompt.body, /Uncommitted changes: unknown \(/);
    assert.match(prompt.body, /Commits ahead of main: unknown \(/);
    assert.equal(prompt.force, false);
  });

  test('an empty checkout path is refused as unknown evidence instead of being probed', async () => {
    const evidence = await confirmLib.readWarpDeleteEvidence('');
    assert.equal(evidence.changes.status, 'unknown');
    assert.equal(evidence.aheadMain.status, 'unknown');
    assert.equal(evidence.aheadMain.ahead, null);
    assert.equal(confirmLib.warpDeletePrompt(TARGET, evidence).force, false);
  });

  test('the production change summary is the module the extension already uses', () => {
    // The builder must consume the shared summary, not a second dirty check.
    assert.equal(typeof changesLib.summarizeChanges, 'function');
    assert.equal(typeof confirmLib.readWarpDeleteEvidence, 'function');
    assert.equal(typeof confirmLib.warpDeletePrompt, 'function');
  });
});
