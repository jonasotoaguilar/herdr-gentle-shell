'use strict';
// Tests for lib/pi-perf-support.js: the per-key answer to "does the installed
// Pi build even declare this performance setting?".
//
// The UI must never claim an effect it cannot observe. This module therefore
// reports one of three states per key and treats every inconclusive scan as
// 'unknown' — never 'absent' — so a budget stop or an unreadable package can
// never be rendered as proof that the setting is missing.
//
// Contract under test, observable only:
// - PERF_KEYS is the same array the settings writer uses, not a copy;
// - a key found in exactly one shipped file is 'declared', and the evidence
//   names that file and its match count without leaking file contents;
// - a key found nowhere is 'absent', and node_modules plus binary-looking
//   files never supply a match;
// - a missing, unparsable or non-directory root, and any scan that stops on
//   its own file or byte budget, is 'unknown' for the affected keys;
// - one tree can answer 'declared' for two keys and 'absent' for the others;
// - results are cached per (root, version, directory mtime) and only
//   resetSupportCacheForTests() forces a re-read;
// - with no explicit piRoot the answer describes the Pi that is actually
//   running this code (the entry script's tree), then the highest release under
//   PI_MANAGED_INSTALL_ROOT, and only then plain require resolution — a verdict
//   about some other installed package is worse than 'unknown';
// - nothing throws: bad input degrades to ok:false with every key 'unknown'.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perf = require('../lib/pi-perf-settings.js');
const support = require('../lib/pi-perf-support.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  support.resetSupportCacheForTests();
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-perf-support-'));
  roots.push(dir);
  return dir;
}

// A fake installed pi package: package.json plus the shipped files the scan
// walks. Values may be a string or a Buffer.
function fixture(files, pkg = { name: '@earendil-works/pi-coding-agent', version: '1.2.3', main: './dist/index.js' }) {
  const root = scratch();
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const PACKAGE_NAME = '@earendil-works/pi-coding-agent';

// A fake install tree: <install>/releases/<version>/node_modules/<package>/, the
// layout the managed pi wrapper uses. A version passed without files ships no
// package.json, so it is present but does not ship the package.
function installTree(versions, files = { 'dist/bundle/cli.js': 'const heightIndex = true;\n' }) {
  const installRoot = scratch();
  const roots = {};
  for (const version of versions) {
    const pkgRoot = path.join(installRoot, 'releases', version, 'node_modules', ...PACKAGE_NAME.split('/'));
    fs.mkdirSync(pkgRoot, { recursive: true });
    const content = files[version] === undefined ? files : files[version];
    if (content === null) {
      roots[version] = pkgRoot;
      continue;
    }
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version }, null, 2)}\n`);
    for (const [rel, body] of Object.entries(content)) {
      const abs = path.join(pkgRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    roots[version] = pkgRoot;
  }
  return { installRoot, roots };
}

// The root plain require resolution gives this test process, i.e. the installed
// package this repository (or its dev dependency) provides.
function requireResolvedRoot() {
  let bases = [];
  try {
    bases = require.resolve.paths(PACKAGE_NAME) || [];
  } catch {
    return null;
  }
  for (const base of bases) {
    const candidate = path.join(base, ...PACKAGE_NAME.split('/'));
    try {
      if (fs.statSync(path.join(candidate, 'package.json')).isFile()) return fs.realpathSync(candidate);
    } catch {
      // keep looking
    }
  }
  return null;
}

function states(result) {
  return Object.fromEntries(Object.entries(result.keys).map(([key, value]) => [key, value.state]));
}

function keyState(result, key) {
  assert.ok(result.keys[key], `expected a verdict for ${key}`);
  return result.keys[key].state;
}

describe('pi perf support scanner', { concurrency: false }, () => {
  test('shares PERF_KEYS with the settings writer instead of copying it', () => {
    assert.equal(support.PERF_KEYS, perf.PERF_KEYS, 'PERF_KEYS must be the very same array');
    assert.deepEqual([...support.PERF_KEYS], [
      'heightIndex',
      'evictOffscreenLines',
      'expandRecentToolOutput',
      'incrementalSearchCorpus',
    ]);
  });

  test('a key present in one shipped file is declared with file and match count only', () => {
    const root = fixture({
      'dist/index.js': 'const heightIndex = 1;\nfunction useHeightIndex() { return heightIndex; }\n',
      'dist/bundle/cli.js': '// no performance keys here\n',
    });
    const result = support.scanSupport({ piRoot: root, keys: ['heightIndex'] });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.piVersion, '1.2.3');
    assert.equal(result.root, fs.realpathSync(root));
    assert.equal(keyState(result, 'heightIndex'), 'declared');
    const evidence = result.keys.heightIndex.evidence;
    assert.match(evidence, /dist[\\/]index\.js/, 'evidence names the file that matched');
    assert.match(evidence, /2 matches/, 'evidence reports the match count');
    assert.doesNotMatch(evidence, /function useHeightIndex/, 'evidence never carries file contents');
  });

  test('a key found nowhere is absent and node_modules or binary files never supply a match', () => {
    const root = fixture({
      'dist/index.js': 'export const unrelated = true;\n',
      'CHANGELOG.md': '# changes\n',
      'node_modules/dep/index.js': 'const heightIndex = 1;\n',
      'dist/asset.bin': Buffer.concat([Buffer.from([0, 0, 1, 2]), Buffer.from('heightIndex')]),
    });
    const result = support.scanSupport({ piRoot: root, keys: ['heightIndex'] });
    assert.equal(result.ok, true, result.error);
    assert.equal(keyState(result, 'heightIndex'), 'absent');
    assert.match(result.keys.heightIndex.evidence, /no match/);
  });

  test('a missing, unparsable or non-directory root is unknown, never absent', () => {
    const missing = path.join(scratch(), 'not-installed');
    const broken = fixture({ 'dist/index.js': 'x\n' });
    fs.writeFileSync(path.join(broken, 'package.json'), '{ this is not json ');
    const notADir = path.join(scratch(), 'package.json');
    fs.writeFileSync(notADir, '{}');

    for (const piRoot of [missing, broken, notADir]) {
      const result = support.scanSupport({ piRoot });
      assert.equal(result.ok, false, `expected a failure verdict for ${piRoot}`);
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
      assert.deepEqual(states(result), {
        heightIndex: 'unknown',
        evictOffscreenLines: 'unknown',
        expandRecentToolOutput: 'unknown',
        incrementalSearchCorpus: 'unknown',
      });
      for (const key of support.PERF_KEYS) {
        assert.match(result.keys[key].evidence, /scan failed/, 'the evidence explains the failure');
      }
    }
  });

  test('a scan that stops on its file budget is unknown, never absent', () => {
    const root = fixture({
      'dist/a.js': 'export const a = 1;\n',
      'dist/b.js': 'export const b = 2;\n',
      'dist/c.js': 'export const c = 3;\n',
    });
    const result = support.scanSupport({ piRoot: root, keys: ['heightIndex'], maxFiles: 2 });
    assert.equal(result.ok, true, result.error);
    assert.equal(keyState(result, 'heightIndex'), 'unknown');
    assert.match(result.keys.heightIndex.evidence, /file budget/);
  });

  test('a scan that stops on its byte budget is unknown, never absent', () => {
    const root = fixture({ 'dist/large.js': `${'const padding = 0;\n'.repeat(200)}` });
    const result = support.scanSupport({ piRoot: root, keys: ['heightIndex'], maxBytes: 512 });
    assert.equal(result.ok, true, result.error);
    assert.equal(keyState(result, 'heightIndex'), 'unknown');
    assert.match(result.keys.heightIndex.evidence, /byte budget/);
  });

  test('a key already found stays declared even when the budget stops the scan later', () => {
    const root = fixture({
      'dist/a.js': 'const heightIndex = 1;\n',
      'dist/b.js': 'export const b = 2;\n',
      'dist/c.js': 'export const c = 3;\n',
    });
    const declared = support.scanSupport({ piRoot: root, keys: ['heightIndex'], maxFiles: 2 });
    assert.equal(keyState(declared, 'heightIndex'), 'declared');
    const absentKey = support.scanSupport({
      piRoot: root,
      keys: ['incrementalSearchCorpus'],
      maxFiles: 2,
    });
    assert.equal(keyState(absentKey, 'incrementalSearchCorpus'), 'unknown');
  });

  test('one tree answers declared for two keys and absent for the other two', () => {
    const root = fixture({
      'dist/index.js': 'const heightIndex = true;\n',
      'dist/bundle/chunks/chunk-1.js': 'const incrementalSearchCorpus = true;\n',
      'dist/util.js': 'export const util = 1;\n',
    });
    const result = support.scanSupport({ piRoot: root });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(states(result), {
      heightIndex: 'declared',
      evictOffscreenLines: 'absent',
      expandRecentToolOutput: 'absent',
      incrementalSearchCorpus: 'declared',
    });
  });

  test('results are cached per root and only resetSupportCacheForTests() re-reads', () => {
    const first = fixture({ 'dist/index.js': 'const heightIndex = true;\n' });
    const before = support.scanSupport({ piRoot: first, keys: ['heightIndex'] });
    assert.equal(keyState(before, 'heightIndex'), 'declared');

    // Same tree, key removed in place: the directory mtime does not change,
    // so the cached verdict must survive and the reset must expose the change.
    fs.writeFileSync(path.join(first, 'dist', 'index.js'), 'export const other = 1;\n');
    const cached = support.scanSupport({ piRoot: first, keys: ['heightIndex'] });
    assert.equal(keyState(cached, 'heightIndex'), 'declared', 'a cached scan is reused');

    support.resetSupportCacheForTests();
    const rescanned = support.scanSupport({ piRoot: first, keys: ['heightIndex'] });
    assert.equal(keyState(rescanned, 'heightIndex'), 'absent', 'the reset forces a fresh read');

    // A different tree is never answered from another root's cache.
    const second = fixture({ 'dist/index.js': 'export const other = 1;\n' });
    assert.equal(keyState(support.scanSupport({ piRoot: second, keys: ['heightIndex'] }), 'heightIndex'), 'absent');
    assert.equal(keyState(support.scanSupport({ piRoot: first, keys: ['heightIndex'] }), 'heightIndex'), 'absent');
  });

  test('a version change invalidates the cached scan', () => {
    const root = fixture({ 'dist/index.js': 'export const other = 1;\n' });
    assert.equal(keyState(support.scanSupport({ piRoot: root, keys: ['heightIndex'] }), 'heightIndex'), 'absent');
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'const heightIndex = true;\n');
    fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '9.9.9' })}\n`);
    const result = support.scanSupport({ piRoot: root, keys: ['heightIndex'] });
    assert.equal(result.piVersion, '9.9.9');
    assert.equal(keyState(result, 'heightIndex'), 'declared');
  });

  test('bad input degrades to ok:false with every key unknown and never throws', () => {
    const root = fixture({ 'dist/index.js': 'const heightIndex = true;\n' });

    // Never scan the real install from a test: only a non-object argument is
    // exercised as bad input, and every such call must fail closed.
    for (const arg of [42, 'root', true, []]) {
      const result = support.scanSupport(arg);
      assert.equal(result.ok, false, `expected a failure verdict for ${String(arg)}`);
      assert.equal(typeof result.error, 'string');
      assert.deepEqual(states(result), {
        heightIndex: 'unknown',
        evictOffscreenLines: 'unknown',
        expandRecentToolOutput: 'unknown',
        incrementalSearchCorpus: 'unknown',
      });
    }

    const unknownKey = support.scanSupport({ piRoot: root, keys: ['notAPerfKey'] });
    assert.equal(unknownKey.ok, false);
    assert.match(unknownKey.error, /notAPerfKey/);
    assert.deepEqual(states(unknownKey), {
      heightIndex: 'unknown',
      evictOffscreenLines: 'unknown',
      expandRecentToolOutput: 'unknown',
      incrementalSearchCorpus: 'unknown',
    });
  });

  test('the running entry script resolves that install tree, never another installed package', () => {
    const tree = installTree(['9.8.7']);
    const pkgRoot = tree.roots['9.8.7'];
    const argv1 = path.join(pkgRoot, 'dist', 'bundle', 'cli.js');

    const result = support.scanSupport({ argv1, env: {}, keys: ['heightIndex'] });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.root, fs.realpathSync(pkgRoot), 'the root is the tree the entry script runs from');
    assert.equal(result.piVersion, '9.8.7', "the version is that tree's version");
    assert.equal(keyState(result, 'heightIndex'), 'declared');

    const other = requireResolvedRoot();
    if (other) {
      assert.notEqual(result.root, other, 'never the package plain require resolution would find');
    }

    // A directory entry point is accepted as well as a file.
    const fromDirectory = support.scanSupport({ argv1: path.join(pkgRoot, 'dist'), env: {}, keys: ['heightIndex'] });
    assert.equal(fromDirectory.root, fs.realpathSync(pkgRoot), 'a directory argv1 walks up the same way');
    assert.equal(fromDirectory.piVersion, '9.8.7');
  });

  test('a managed install picks the highest release by numeric version order', () => {
    // 2.0.0 is present but ships no package, so it must not be chosen.
    const tree = installTree(['0.9.0', '2.0.0', '1.10.0'], {
      '0.9.0': { 'dist/bundle/cli.js': 'export const old = 1;\n' },
      '2.0.0': null,
      '1.10.0': { 'dist/bundle/cli.js': 'const heightIndex = true;\n' },
    });
    const argv1 = path.join(scratch(), 'entry-that-is-not-in-any-install.js');

    const result = support.scanSupport({
      argv1,
      env: { PI_MANAGED_INSTALL_ROOT: tree.installRoot },
      keys: ['heightIndex'],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.piVersion, '1.10.0', '1.10.0 ranks above 0.9.0');
    assert.equal(result.root, fs.realpathSync(tree.roots['1.10.0']));
    assert.deepEqual(
      ['1.10.0', '0.9.0'].sort(),
      ['0.9.0', '1.10.0'],
      'a lexicographic sort would have picked 0.9.0, so this result is a real discriminator',
    );
  });

  test('with no entry script hit and no managed root, resolution falls back and never claims absent', () => {
    const argv1 = path.join(scratch(), 'entry-that-is-not-in-any-install.js');
    let result;
    assert.doesNotThrow(() => {
      result = support.scanSupport({ argv1, env: {}, keys: ['heightIndex'], maxFiles: 1 });
    });

    if (result.ok) {
      assert.equal(typeof result.root, 'string');
      assert.ok(fs.statSync(path.join(result.root, 'package.json')).isFile(), 'a reported root really ships the package');
      assert.equal(typeof result.piVersion, 'string');
      assert.ok(result.piVersion.length > 0);
    } else {
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0, 'the failure names a reason');
      assert.deepEqual(states(result), {
        heightIndex: 'unknown',
        evictOffscreenLines: 'unknown',
        expandRecentToolOutput: 'unknown',
        incrementalSearchCorpus: 'unknown',
      });
      for (const key of support.PERF_KEYS) {
        assert.match(result.keys[key].evidence, /scan failed/);
      }
    }
  });
});
