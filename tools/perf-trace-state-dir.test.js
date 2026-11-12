'use strict';
// The perf trace's plugin state directory: one resolution, byte-compatible with
// what the removed worktree module used to provide and identical in effect to
// the sidebar switch and the Herdr daemon.
//
// The trace log must land where the rest of this package already keeps its
// flags, or an upgrade silently moves (and abandons) the existing log. These
// assertions are the compatibility contract for that resolution, observed only
// through `tracePath(env)`: the explicit override, the stored-default quirk for
// an empty or non-string override, the stored dir whenever it holds a file of
// ours (even when a stray known file sits in the Herdr-injected dir), the active
// plugin id dir when ONLY it holds one, the stored canonical dir as the final
// fallback in every context, and the never-writes promise of a pure path
// resolution.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trace = require('../lib/perf-trace.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perf-dir-${tag}-`));
  roots.push(dir);
  return dir;
}

// A stored (pre-rename) dir plus a Herdr-injected dir under one sandbox XDG
// state home, so the stored default is computed the way every consumer computes
// it. `activeId` is the path Herdr injects and where a pre-fix install may still
// keep live flags; it matches what the stored default derives from the same
// state home.
function sandbox(tag) {
  const root = scratch(tag);
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents');
  const activeId = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-shell');
  const injected = path.join(root, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  return { root, xdg, stored, activeId, injected };
}

function dirOf(env) {
  return path.dirname(trace.tracePath(env));
}

describe('perf trace state dir compatibility', { concurrency: false }, () => {
  test('an explicit GENTLE_STATUS_STATE_DIR is used as-is', () => {
    const explicit = scratch('explicit');
    assert.equal(dirOf({ GENTLE_STATUS_STATE_DIR: explicit }), explicit);
  });

  test('an empty or non-string override keeps the stored default', () => {
    const { xdg, stored } = sandbox('empty');
    assert.equal(dirOf({ GENTLE_STATUS_STATE_DIR: '', XDG_STATE_HOME: xdg }), stored);
    assert.equal(dirOf({ GENTLE_STATUS_STATE_DIR: 42, XDG_STATE_HOME: xdg }), stored);
  });

  test('the XDG default keeps the stored herdr-gentle-agents segment', () => {
    const { xdg } = sandbox('xdg');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg }), path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents'));
  });

  test('a stray injected file never outranks the stored family', () => {
    const { xdg, stored, injected } = sandbox('trapped');
    fs.writeFileSync(path.join(injected, 'gentle-interruptions.json'), '{"version":1,"panes":{}}\n');
    fs.writeFileSync(path.join(stored, 'gentle-status.pid'), '1\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), stored);
  });

  // The same precedence must hold when the injected variable names exactly the
  // derived active-id dir: a stray file there still loses to the stored family.
  test('a stray known file in the derived active-id dir never outranks the stored family', () => {
    const { xdg, stored, activeId } = sandbox('derived-trapped');
    fs.mkdirSync(activeId, { recursive: true });
    fs.writeFileSync(path.join(activeId, 'gentle-interruptions.json'), '{"version":1,"panes":{}}\n');
    fs.writeFileSync(path.join(stored, 'gentle-status.pid'), '1\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: activeId }), stored);
  });

  // S1c (T12): an owned basename is not enough. The injected path must BE the
  // directory this package derives for that name under the resolved state home,
  // or an owned name under another root selects there while a context without
  // the variable derives its own — the split L12 recorded.
  test('an owned-basename injected dir under a different root is ignored (cross-context)', () => {
    const { root, xdg, stored } = sandbox('owned-foreign');
    for (const owned of ['herdr-gentle-shell', 'herdr-gentle-agents']) {
      const injected = path.join(root, 'other-herdr', owned);
      fs.mkdirSync(injected, { recursive: true });
      fs.writeFileSync(path.join(injected, 'gentle-moshi.json'), '{"enabled":true}\n');
      const withVariable = dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected });
      assert.equal(withVariable, stored, `${owned} under a foreign root is ignored`);
      assert.equal(withVariable, dirOf({ XDG_STATE_HOME: xdg }), `the injected variable changes nothing for ${owned}`);
      fs.rmSync(path.join(root, 'other-herdr'), { recursive: true, force: true });
    }
  });

  // The same rule may not over-tighten: a symlinked or relative spelling of the
  // derived dir is still that dir, so it is honoured as given.
  test('an owned-basename injected dir under the same root is honoured (symlinked and relative spellings)', () => {
    const { root, xdg, activeId } = sandbox('owned-same-root');
    fs.mkdirSync(activeId, { recursive: true });
    fs.writeFileSync(path.join(activeId, 'gentle-moshi.json'), '{"enabled":true}\n');
    const link = path.join(root, 'plugins-link');
    fs.symlinkSync(path.join(xdg, 'herdr', 'plugins'), link, 'dir');
    const symlinked = path.join(link, 'herdr-gentle-shell');
    assert.equal(
      dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: symlinked }),
      symlinked,
      'the symlinked spelling is used as given',
    );
    const previous = process.cwd();
    try {
      process.chdir(root);
      const relative = path.join('xdg', 'herdr', 'plugins', 'herdr-gentle-shell');
      assert.equal(
        dirOf({ XDG_STATE_HOME: 'xdg', HERDR_PLUGIN_STATE_DIR: relative }),
        relative,
        'the relative spelling is used as given',
      );
    } finally {
      process.chdir(previous);
    }
  });

  test('an injected dir named for the stored segment under a different root is ignored', () => {
    const { root, xdg, stored } = sandbox('segment-foreign');
    const injected = path.join(root, 'other-herdr', 'herdr-gentle-agents');
    fs.mkdirSync(injected, { recursive: true });
    fs.writeFileSync(path.join(injected, 'gentle-status.pid'), '1\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), stored);
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), dirOf({ XDG_STATE_HOME: xdg }));
  });

  test('an injected dir named for the stored segment under the same root resolves that dir (owner name)', () => {
    const { xdg, stored } = sandbox('segment-same-root');
    fs.writeFileSync(path.join(stored, 'gentle-status.pid'), '1\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: stored }), stored);
    const link = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents-link');
    fs.symlinkSync(stored, link, 'dir');
    // The link's basename is not an owned name, so it is ignored; the derived
    // segment dir is the same directory and still resolves there.
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: link }), stored);
  });

  // S1c: an injected path is honoured only when its basename is the active
  // plugin id or the stored canonical segment. A third plugin id holding our
  // files must not select the directory: the daemon receives the variable and
  // the producer never does, so honouring it splits the state.
  test('an unrelated populated injected dir is ignored', () => {
    const { xdg, stored, injected } = sandbox('unowned');
    fs.writeFileSync(path.join(injected, 'gentle-status.pid'), '1\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), stored);
  });

  test('the active-id dir wins when only it holds a file of ours (legacy install)', () => {
    const { xdg, activeId } = sandbox('active-id');
    fs.mkdirSync(activeId, { recursive: true });
    fs.writeFileSync(path.join(activeId, 'gentle-moshi.json'), '{"enabled":true}\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg }), activeId, 'found without the injected variable');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: activeId }), activeId, 'found with it');
  });

  test('a stored-only flag keeps the trace on the stored dir', () => {
    const { xdg, stored, injected } = sandbox('stored');
    fs.writeFileSync(path.join(stored, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), stored);
  });

  // S1b: neither dir holding a file of ours must resolve the SAME dir in both
  // contexts, and that dir is the stored canonical one — the injected dir is not
  // the final fallback (the producer never receives it, so it named a different
  // directory and split a fresh install).
  test('neither dir holding our files converges on the stored canonical dir (cross-context)', () => {
    const { xdg, stored, activeId } = sandbox('fresh');
    const injectedNow = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-shell');
    assert.equal(injectedNow, activeId);
    const withoutVariable = dirOf({ XDG_STATE_HOME: xdg });
    const withVariable = dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: activeId });
    assert.equal(withoutVariable, stored, 'a fresh install uses the stored canonical dir');
    assert.equal(withVariable, withoutVariable, 'the injected variable changes nothing on a fresh install');
  });

  test('an injected dir equal to the stored dir resolves once', () => {
    const { xdg, stored } = sandbox('equal');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: stored }), stored);
  });

  test('resolving a path writes nothing', () => {
    const { root } = sandbox('readonly');
    dirOf({ XDG_STATE_HOME: path.join(root, 'xdg') });
    assert.deepEqual(fs.readdirSync(path.join(root, 'xdg')), ['herdr'], 'only the dirs the sandbox made');
  });
});
