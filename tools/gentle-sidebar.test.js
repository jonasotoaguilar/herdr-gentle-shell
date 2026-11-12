'use strict';
// lib/gentle-sidebar.js shares the plugin state dir with the daemon, the
// diagnostics readers and the extension. Its known-file family must include
// every file the family proves, including the shared ODD/Issues toggle file:
// a stored dir holding only that file must win over an empty injected dir, or
// the sidebar's own writes create a second state dir where the disabled
// toggle reads as missing (missing means enabled).

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sidebar = require('../lib/gentle-sidebar.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function sandbox(tag) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `gentle-sidebar-${tag}-`)));
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents');
  const injected = path.join(root, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  return { root, xdg, stored, injected, env: { XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected } };
}

describe('sidebar state-dir resolution', () => {
  test('a stored dir holding only the plugin-tools toggle wins', () => {
    const fixture = sandbox('plugin-tools');
    fs.writeFileSync(path.join(fixture.stored, 'gentle-plugin-tools.json'), '{"version":1,"odd":false,"issues":false}\n');
    assert.equal(sidebar.stateDir(fixture.env), fixture.stored);
    assert.equal(sidebar.modePath(fixture.env), path.join(fixture.stored, 'gentle-sidebar-mode.json'));
    assert.equal(sidebar.markerPath(fixture.env), path.join(fixture.stored, 'pi-extension-exclusion-owned'));
  });

  test('the sidebar write lands in the stored dir and creates nothing injected', () => {
    const fixture = sandbox('write');
    fs.writeFileSync(path.join(fixture.stored, 'gentle-plugin-tools.json'), '{"version":1,"odd":false,"issues":false}\n');
    sidebar.writeMode(true, fixture.env);
    assert.equal(
      fs.readFileSync(path.join(fixture.stored, 'gentle-sidebar-mode.json'), 'utf8'),
      '{"version":1,"enabled":true}\n',
    );
    assert.deepEqual(fs.readdirSync(fixture.injected), [], 'the injected dir stays empty');
  });

  test('a fresh install converges on the stored canonical dir, and on the active-id dir when only it holds a flag', () => {
    const fixture = sandbox('fresh');
    assert.equal(sidebar.stateDir(fixture.env), fixture.stored, 'the stored canonical dir is the final fallback');
    assert.equal(sidebar.stateDir({ XDG_STATE_HOME: fixture.xdg }), fixture.stored, 'the injected variable changes nothing');
    const activeId = path.join(fixture.xdg, 'herdr', 'plugins', 'herdr-gentle-shell');
    fs.mkdirSync(activeId, { recursive: true });
    fs.writeFileSync(path.join(activeId, 'gentle-plugin-tools.json'), '{"version":1,"odd":false,"issues":false}\n');
    assert.equal(sidebar.stateDir({ XDG_STATE_HOME: fixture.xdg }), activeId, 'a legacy active-id flag is found without the variable');
  });

  test('an empty injected dir never orphans a stored pre-rename flag (preserved)', () => {
    const fixture = sandbox('legacy');
    fs.writeFileSync(path.join(fixture.stored, 'installer-state'), 'installed\n');
    assert.equal(sidebar.stateDir(fixture.env), fixture.stored);
  });

  // S1c (T12): an owned basename is not enough — the injected path must BE the
  // directory this package derives for that name under the resolved state home.
  // An owned name under another root is exactly the case that splits the daemon
  // (which receives the variable) from every producer (which does not).
  test('an owned-basename injected dir under a different root is ignored', () => {
    const fixture = sandbox('owned-foreign');
    for (const owned of ['herdr-gentle-shell', 'herdr-gentle-agents']) {
      const injected = path.join(fixture.root, 'other-herdr', owned);
      fs.mkdirSync(injected, { recursive: true });
      fs.writeFileSync(path.join(injected, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
      const env = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: injected };
      assert.equal(sidebar.stateDir(env), fixture.stored, `${owned} under a foreign root is ignored`);
      assert.equal(sidebar.stateDir(env), sidebar.stateDir({ XDG_STATE_HOME: fixture.xdg }));
      sidebar.writeMode(true, env);
      assert.equal(
        fs.readFileSync(path.join(fixture.stored, 'gentle-sidebar-mode.json'), 'utf8'),
        '{"version":1,"enabled":true}\n',
        'the write lands in the stored dir',
      );
      assert.equal(
        fs.readFileSync(path.join(injected, 'gentle-sidebar-mode.json'), 'utf8'),
        '{"version":1,"enabled":false}\n',
        'the foreign-root flag is never touched',
      );
      fs.rmSync(path.join(fixture.root, 'other-herdr'), { recursive: true, force: true });
    }
  });

  // A spelling of the derived dir that only differs by a symlink or by being
  // relative still names that dir, so it is honoured as given.
  test('an owned-basename injected dir under the same root is honoured (symlinked and relative spellings)', () => {
    const fixture = sandbox('owned-same-root');
    const activeId = path.join(fixture.xdg, 'herdr', 'plugins', 'herdr-gentle-shell');
    fs.mkdirSync(activeId, { recursive: true });
    fs.writeFileSync(path.join(activeId, 'gentle-plugin-tools.json'), '{"version":1,"odd":false,"issues":false}\n');
    const link = path.join(fixture.root, 'plugins-link');
    fs.symlinkSync(path.join(fixture.xdg, 'herdr', 'plugins'), link, 'dir');
    const symlinked = path.join(link, 'herdr-gentle-shell');
    assert.equal(
      sidebar.stateDir({ XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: symlinked }),
      symlinked,
      'the symlinked spelling is used as given',
    );
    const previous = process.cwd();
    try {
      process.chdir(fixture.root);
      const relative = path.join('xdg', 'herdr', 'plugins', 'herdr-gentle-shell');
      assert.equal(
        sidebar.stateDir({ XDG_STATE_HOME: 'xdg', HERDR_PLUGIN_STATE_DIR: relative }),
        relative,
        'the relative spelling is used as given',
      );
    } finally {
      process.chdir(previous);
    }
  });

  test('the explicit override wins over an owned injected dir (preserved)', () => {
    const fixture = sandbox('explicit');
    const activeId = path.join(fixture.xdg, 'herdr', 'plugins', 'herdr-gentle-shell');
    const explicit = track(fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-sidebar-explicit-')));
    assert.equal(
      sidebar.stateDir({ XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: activeId, GENTLE_STATUS_STATE_DIR: explicit }),
      explicit,
      'an explicit override still wins unconditionally',
    );
    assert.equal(
      sidebar.stateDir({ XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: activeId, GENTLE_STATUS_STATE_DIR: '' }),
      fixture.stored,
      'an explicit-but-empty override still keeps the stored default',
    );
  });
});
