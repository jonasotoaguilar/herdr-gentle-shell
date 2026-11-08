'use strict';

// Release regression probes shipped with 1.0.0 (odd/tasks/release-1.0.0.md
// S1-S4); the file keeps its original name to avoid churn.
//
// S1 removed the one-shot installer, so no shipped instruction may teach a
// command form that no longer exists or promise a behaviour only install.sh
// implemented. S3's identity pins are version-agnostic on purpose: the two
// published versions must stay equal to each other and be strict semver, so no
// number has to be edited here at every release. S4 pins the repository
// identity.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PKG = JSON.parse(read('package.json'));
const SEMVER = /^\d+\.\d+\.\d+$/;

function manifestVersion() {
  const match = /^version = "([^"]+)"$/m.exec(read(path.join('herdr-plugin', 'herdr-plugin.toml')));
  assert.ok(match, 'herdr-plugin.toml must declare a quoted version');
  return match[1];
}

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

describe('released versions and tags (S3)', () => {
  it('the Pi package reports a strict semver version', () => {
    assert.match(PKG.version, SEMVER, `package.json version: ${PKG.version}`);
  });

  it('the Herdr plugin reports a strict semver version', () => {
    assert.match(manifestVersion(), SEMVER, `herdr-plugin.toml version: ${manifestVersion()}`);
  });

  it('both published identities ship the same version', () => {
    assert.equal(
      manifestVersion(),
      PKG.version,
      `package.json is ${PKG.version} but herdr-plugin.toml is ${manifestVersion()}`,
    );
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
