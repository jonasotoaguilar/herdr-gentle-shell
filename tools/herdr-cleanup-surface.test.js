'use strict';
// Surviving surface of the Herdr package after the plugin-tools / worktree /
// warp / ODD / issues removal (odd/tasks/split-odd-worktree.md S1, S3).
//
// What must survive: the Herdr/Pi integration (the producer sidecar, its
// token contract, the Herdr runtime plugin under herdr-plugin/), the Moshi
// notification channel, and the `/herdr-gentle:customize` command restored
// with its two local switches (sidebar agent rows, Moshi notifications). What
// must be gone: the worktree tools extension, its libraries, its commands and
// its documentation, plus the removed `Plugin tools` provider slot those
// switches used to hang off. These assertions read the shipped artifacts the
// installer and Pi consume, so a leftover file, a dangling manifest entry, or
// a document that still teaches a removed command fails here instead of after
// an install.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// The package ships two Pi extensions: the Herdr state producer and the
// retained worktree session opener (S6).
const DECLARED_EXTENSIONS = [
  './extensions/gentle-herdr-state.ts',
  './extensions/herdr-session-open.ts',
];
const EXTENSION = path.join(ROOT, 'extensions', 'gentle-herdr-state.ts');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function docsMatching(pattern) {
  const dir = path.join(ROOT, 'docs');
  return fs.readdirSync(dir).filter((name) => pattern.test(name)).sort();
}

const REMOVED_LIB_FAMILIES = [
  'checkout-facts.js',
  'gh-issues.js',
  'issue-preview.js',
  'issues-cache.js',
  'issues-view.js',
  'live-session-changes.js',
  'odd-docs.js',
  'odd-markdown.js',
  'odd-view.js',
  'session-worktree-register.js',
  'warp-create-panel.js',
  'warp-create-picker.js',
  'warp-delete-confirm.js',
  'warp-selector-view.js',
  'worktree-card.js',
  'worktree-changes.js',
  'worktree-close-herdr.js',
  'worktree-git.js',
  'worktree-hooks.js',
  'worktree-mode.js',
  'worktree-model-result.js',
  'worktree-registry.js',
  'worktree-symlinks.js',
  'worktree-warp-sessions.js',
];

describe('package manifest', () => {
  test('declares the Herdr state sidecar and the session opener as Pi extensions', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.deepEqual(pkg.pi.extensions, DECLARED_EXTENSIONS);
  });

  test('ships no extension beyond those two', () => {
    const entries = fs.readdirSync(path.join(ROOT, 'extensions'))
      .filter((name) => name !== '.gitkeep')
      .sort();
    assert.deepEqual(entries, ['gentle-herdr-state.ts', 'herdr-session-open.ts']);
  });
});

describe('removed libraries', () => {
  for (const lib of REMOVED_LIB_FAMILIES) {
    test(`lib/${lib} is gone`, () => {
      assert.equal(exists(path.join('lib', lib)), false, `lib/${lib} still ships`);
    });
  }
});

describe('state sidecar', () => {
  const source = fs.readFileSync(EXTENSION, 'utf8');

  test('still publishes the Herdr token contract', () => {
    for (const token of [
      'gentle_work_v1',
      'gentle_roles_v1',
      'gentle_orchestrating_v1',
      'gentle_changes_v2',
      'gentle_ask_v1',
      'gentle_review_v1',
      'herdr:blocked',
    ]) {
      assert.ok(source.includes(token), `token ${token} left the producer`);
    }
  });

  test('still carries the Moshi notification channel', () => {
    assert.ok(source.includes('moshiSendEnvelope'), 'Moshi sender left the producer');
    assert.ok(source.includes('session.update'), 'Moshi session carrier left the producer');
    assert.ok(source.includes('approval_required'), 'Moshi ask notification left the producer');
    assert.ok(source.includes('task_complete'), 'Moshi finish notification left the producer');
    assert.ok(source.includes('gentle-moshi.json'), 'Moshi flag file contract left the producer');
  });

  test('keeps the two-switch command but not the removed provider slot', () => {
    // The command itself is back (sidebar agent rows + Moshi only). The
    // cross-extension provider slot and its registrar are not: they carried the
    // worktree/ODD/issues switches this package no longer contains.
    assert.equal(source.includes('herdr-gentle.customize.v1'), false);
    assert.equal(source.includes('registerCustomizeProviders'), false);
    const registered = source.indexOf('pi.registerCommand("herdr-gentle:customize"');
    const gate = source.indexOf('if (!enabled()) return;');
    assert.ok(registered > 0, '/herdr-gentle:customize left the producer');
    assert.ok(gate > 0, 'the enabled() pane gate left the producer');
    assert.ok(registered < gate, 'the command must register before the enabled() pane gate');
  });

  test('registers exactly one Pi command and no standalone Moshi command', () => {
    // One command carries both switches; a separate `/herdr-gentle:moshi` was
    // never requested and must not come back (odd/tasks/customize-notifications.md S1).
    const registrations = [...source.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(registrations, ['herdr-gentle:customize'], 'the package registers one command');
    assert.equal(source.includes('herdr-gentle:moshi'), false, 'the standalone Moshi command stays gone');
  });

  test('no longer carries worktree, ODD or issues surfaces', () => {
    for (const needle of ['worktree_warp', 'worktree_create', 'herdr-gentle:odd', 'herdr-gentle:issues']) {
      assert.equal(source.includes(needle), false, `${needle} left in the producer`);
    }
  });
});

describe('documentation', () => {
  test('teaches no removed command or tool', () => {
    const files = ['README.md', ...fs.readdirSync(path.join(ROOT, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => path.join('docs', name))];
    const banned = [
      '/herdr-gentle:odd',
      '/herdr-gentle:issues',
      '/herdr-gentle:moshi',
      '/herdr-gentle:warp',
      '/herdr-gentle:worktree',
      'worktree_create',
      'worktree_warp',
      'worktree_close',
      'worktree_list',
      'worktree_session_open',
      'odd-list',
    ];
    for (const file of files) {
      const text = read(file);
      for (const needle of banned) {
        assert.equal(text.includes(needle), false, `${file} still teaches ${needle}`);
      }
    }
  });

  test('keeps no removed feature handbook', () => {
    assert.deepEqual(docsMatching(/^(?:worktree|warp|odd|issues)-/), []);
  });

  test('still documents the surviving Herdr and Moshi behavior', () => {
    const readme = read('README.md');
    assert.match(readme, /Moshi/);
    assert.match(readme, /Herdr/);
  });
});

describe('Herdr runtime plugin', () => {
  test('keeps the sidebar daemon and its actions', () => {
    const toml = read(path.join('herdr-plugin', 'herdr-plugin.toml'));
    assert.match(toml, /id = "herdr-gentle-shell"/);
    assert.match(toml, /bin\/gentle-status\.js/);
    assert.match(toml, /id = "configure"/);
    assert.match(toml, /id = "unconfigure"/);
  });
});
