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
// ours (even when a stray known file sits in the Herdr-injected dir), the
// injected dir only when neither holds one, and the never-writes promise of a
// pure path resolution.

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
// it.
function sandbox(tag) {
  const root = scratch(tag);
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents');
  const injected = path.join(root, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  return { root, xdg, stored, injected };
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

  test('the injected dir wins when only it holds a file of ours (preserved)', () => {
    const { xdg, injected } = sandbox('injected');
    fs.writeFileSync(path.join(injected, 'gentle-moshi.json'), '{"enabled":true}\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), injected);
  });

  test('a stored-only flag keeps the trace on the stored dir', () => {
    const { xdg, stored, injected } = sandbox('stored');
    fs.writeFileSync(path.join(stored, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), stored);
  });

  test('neither dir holding our files converges on the injected dir', () => {
    const { xdg, injected } = sandbox('fresh');
    assert.equal(dirOf({ XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected }), injected);
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
