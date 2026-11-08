'use strict';

// Release 1.0.0 (odd/tasks/release-1.0.0.md S1-S4) regression probes.
//
// S1 removed the one-shot installer, so no shipped instruction may teach a
// command form that no longer exists or promise a behaviour only install.sh
// implemented. S3 pins the released versions, S4 the repository identity.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PKG = JSON.parse(read('package.json'));

describe('release 1.0.0: no retired installer instruction survives (S1)', () => {
  it('the README carries no removed installer command form', () => {
    const readme = read('README.md');
    for (const needle of ['curl -fsSL', 'releases/latest/download', '--pi-source', '--allow-downgrade']) {
      assert.equal(
        readme.includes(needle),
        false,
        `README still teaches the retired installer form: ${needle}`,
      );
    }
  });

  it('the README promises no managed-copy migration the repository no longer implements', () => {
    // install.sh was the only implementation of the legacy managed-copy
    // ownership check; with it gone, the removal path must not claim it.
    const readme = read('README.md');
    assert.equal(
      readme.includes('legacy managed Pi copy'),
      false,
      "README still promises the retired installer's legacy managed-copy handling",
    );
    assert.equal(
      readme.includes('is preserved with a warning'),
      false,
      'README still promises a managed-copy preservation warning nothing emits',
    );
  });
});

describe('release 1.0.0 versions and tags (S3)', () => {
  it('the Pi package reports 1.0.0', () => {
    assert.equal(PKG.version, '1.0.0');
  });

  it('the Herdr plugin reports 1.0.0', () => {
    assert.match(read(path.join('herdr-plugin', 'herdr-plugin.toml')), /^version = "1\.0\.0"$/m);
  });

  it('the documented release series are pi-vX.Y.Z and herdr-vX.Y.Z', () => {
    const preflight = read('scripts/release-preflight');
    assert.ok(preflight.includes('pi-vX.Y.Z'));
    assert.ok(preflight.includes('herdr-vX.Y.Z'));
  });
});

describe('release 1.0.0 repository identity (S4)', () => {
  it('no shipped file points at the retired repository', () => {
    for (const rel of [
      'package.json',
      'package-lock.json',
      'README.md',
      'DESIGN.md',
      'herdr-plugin/herdr-plugin.toml',
    ]) {
      assert.equal(
        read(rel).includes('github.com/jonasotoaguilar/herdr-gentle-agents'),
        false,
        `${rel} still points at the retired repository`,
      );
    }
  });
});
