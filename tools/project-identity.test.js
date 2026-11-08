'use strict';

// Project identity rename (customize-command S15/T9, release 1.0.0 T2).
//
// Bounded rename only: the published npm name is `herdr-gentle-shell`, the
// Herdr plugin id is `herdr-gentle-shell` / display name `Herdr Gentle Shell`,
// and every install command and repository URL names the verified origin
// `jonasotoaguilar/herdr-gentle-shell` (release 1.0.0 S4), because releases are
// created there. The `herdr-gentle:*` command verbs keep their names with no
// new aliases, and persistent state paths, managed markers and the internal
// provider slot keep their existing `herdr-gentle-agents` segments for
// compatibility.
//
// This suite asserts only current on-disk public metadata and contracts
// (package.json, package-lock.json, the plugin manifest, README). The
// behavioral compatibility pins — provider slot, managed markers, command
// registration — live in the existing suites that exercise them
// (tools/customize-panel.test.js, tools/customize-providers.test.js,
// tools/gentle-sidebar-toggle.test.js, tools/gentle-diagnostics.test.js,
// tools/customize-warp.test.js), not here.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const NEW_NPM_NAME = 'herdr-gentle-shell';
const NEW_PLUGIN_ID = 'herdr-gentle-shell';
// The verified origin (release 1.0.0 S4): releases are created here, so every
// install command and repository URL must resolve to it.
const REPO = 'github.com/jonasotoaguilar/herdr-gentle-shell';
// The retired repository name. Only historical/non-URL prose may keep it.
const RETIRED_REPO = 'github.com/jonasotoaguilar/herdr-gentle-agents';

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('project identity rename (S15/T9)', () => {
  it('package root carries the new npm name without a scope', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.name, NEW_NPM_NAME);
  });

  it('the lock carries the new name in both root slots, consistent with the package root', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(lock.name, NEW_NPM_NAME);
    assert.equal(lock.packages?.['']?.name, NEW_NPM_NAME);
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.packages?.['']?.name, pkg.name);
  });

  it('peer dependencies are unchanged by the rename', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.deepEqual(pkg.peerDependencies, {
      '@earendil-works/pi-coding-agent': '*',
      '@earendil-works/pi-tui': '*',
    });
  });

  it('the Herdr plugin manifest carries the new id and display name', () => {
    const manifest = read('herdr-plugin/herdr-plugin.toml');
    assert.match(manifest, /^id = "herdr-gentle-shell"$/m);
    assert.match(manifest, /^name = "Herdr Gentle Shell"$/m);
  });

  it('the manifest keeps its own independent semver version', () => {
    const manifest = read('herdr-plugin/herdr-plugin.toml');
    const match = /^version = "([^"]+)"$/m.exec(manifest);
    assert.ok(match, 'herdr-plugin.toml must declare a quoted version');
    assert.match(match[1], /^\d+\.\d+\.\d+$/);
  });

  it('published URLs name the verified origin repository', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const url of [pkg.homepage, pkg.bugs?.url, pkg.repository?.url]) {
      assert.ok(
        String(url).includes(REPO),
        `published URL must name ${REPO}, got: ${url}`,
      );
    }
  });

  it('no published file still points at the retired repository', () => {
    for (const rel of ['package.json', 'package-lock.json', 'herdr-plugin/herdr-plugin.toml', 'README.md']) {
      assert.ok(
        !read(rel).includes(RETIRED_REPO),
        `${rel} must not keep the retired repository URL`,
      );
    }
  });

  it('the README installs the Herdr plugin first, naming the verified repository', () => {
    const readme = read('README.md');
    assert.ok(
      readme.includes('herdr plugin install jonasotoaguilar/herdr-gentle-shell/herdr-plugin'),
      'the README must install the Herdr plugin from the verified repository',
    );
    assert.ok(
      readme.indexOf('herdr plugin install jonasotoaguilar/herdr-gentle-shell/herdr-plugin')
        < readme.indexOf('pi install npm:herdr-gentle-shell'),
      'the Herdr plugin install must come before the Pi package install',
    );
  });

  it('the README shows the Pi package install through both launchers', () => {
    const readme = read('README.md');
    const sentence = 'Inside a Gentle Shell session, the same package is installed through the shell\'s launcher:';
    assert.ok(readme.includes(sentence), 'the README must carry the Gentle Shell launcher sentence');
    assert.ok(
      readme.includes('```sh\npi install npm:herdr-gentle-shell\n```'),
      'the README must show the plain Pi install block',
    );
    assert.ok(
      readme.indexOf(sentence) < readme.indexOf('```sh\ngentle-shell install npm:herdr-gentle-shell\n```'),
      'the Gentle Shell block must follow its sentence',
    );
  });

  it('the README carries the new visible identity', () => {
    const readme = read('README.md');
    assert.ok(readme.startsWith('# Herdr Gentle Shell\n'), 'README title must carry the new project name');
    assert.ok(readme.includes('![Herdr Gentle Shell banner]'), 'README banner alt must carry the new project name');
    assert.ok(readme.includes(`published to npm as \`${NEW_NPM_NAME}\``));
    assert.ok(readme.includes('npm:herdr-gentle-shell'), 'README npm install spec must carry the new name');
    assert.ok(readme.includes(`--plugin ${NEW_PLUGIN_ID}`), 'README plugin commands must carry the new plugin id');
    assert.ok(readme.includes(`herdr plugin update ${NEW_PLUGIN_ID}`));
    assert.ok(
      readme.includes('The repository root is the Pi package (`herdr-gentle-shell`)'),
    );
  });

  it('the README documents the surviving command surface with no new prefix', () => {
    // The customize/odd/issues/warp verbs were removed with their features;
    // bin/gentle-sidebar.js is the one command left, and the rename
    // introduced no `herdr-gentle-shell:` prefix.
    const readme = read('README.md');
    assert.ok(readme.includes('bin/gentle-sidebar.js'));
    assert.ok(!readme.includes('herdr-gentle-shell:'));
  });

  it('the README keeps the on-disk managed marker text unchanged', () => {
    // State compatibility at the doc level: the managed block and backup
    // name keep their existing segments. Behavior is pinned by
    // tools/gentle-sidebar-toggle.test.js and tools/gentle-diagnostics.test.js.
    const readme = read('README.md');
    assert.ok(readme.includes('# BEGIN herdr-gentle-agents (managed; do not edit)'));
    assert.ok(readme.includes('# END herdr-gentle-agents'));
    assert.ok(readme.includes('<config>.herdr-gentle-agents.bak'));
  });
});
