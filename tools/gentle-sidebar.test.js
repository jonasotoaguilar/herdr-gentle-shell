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
});
