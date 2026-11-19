'use strict';
// The persisted theme switch (`gentle-theme.json`) is the panel's only truth, so
// these assertions are the contract T3/T2 build on: the file must land in the
// SAME plugin state dir the Moshi flag uses (one file, both sides of the feature
// agree), a fresh install must stay inert and write NOTHING (S7), and a file this
// module cannot read must be a refusal with inert defaults — never a guess, and
// never an edit of the refused document.
//
// The write assertions observe the document that actually lands on disk: exact
// keys, a self-stamped ISO timestamp, no temporary sibling left behind, and the
// mode of an existing target preserved. Refusals are asserted by the unchanged
// file plus the thrown TypeError, because a half-written or guessed document is
// exactly the failure mode this module exists to prevent.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/theme-store.js');
const sidebar = require('../lib/gentle-sidebar.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `theme-store-${tag}-`));
  roots.push(dir);
  return dir;
}

const STORED_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-agents');
const ACTIVE_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-shell');

// A stored (pre-rename) dir plus the active-id dir under one sandbox state home,
// so the stored default is computed the way every consumer computes it.
function sandbox(tag) {
  const root = scratch(tag);
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, STORED_SEGMENT);
  const activeId = path.join(xdg, ACTIVE_SEGMENT);
  fs.mkdirSync(stored, { recursive: true });
  return { root, xdg, stored, activeId };
}

describe('theme state dir', () => {
  test('a fresh install resolves the stored canonical dir and writes no file', () => {
    const { xdg, stored } = sandbox('fresh');
    assert.equal(store.themeStateDir({ XDG_STATE_HOME: xdg }), stored);
    assert.equal(store.themeStatePath({ XDG_STATE_HOME: xdg }), path.join(stored, 'gentle-theme.json'));
    assert.equal(fs.existsSync(path.join(stored, 'gentle-theme.json')), false, 'S7: resolution never writes');
    assert.deepEqual(fs.readdirSync(stored), []);
  });

  test('the explicit GENTLE_STATUS_STATE_DIR override is used as-is', () => {
    const explicit = scratch('explicit');
    assert.equal(store.themeStatePath({ GENTLE_STATUS_STATE_DIR: explicit }), path.join(explicit, 'gentle-theme.json'));
    // An explicit-but-empty override keeps the stored default, like every
    // consumer of the family does.
    const { xdg, stored } = sandbox('empty-override');
    assert.equal(store.themeStateDir({ GENTLE_STATUS_STATE_DIR: '', XDG_STATE_HOME: xdg }), stored);
    assert.equal(store.themeStateDir({ GENTLE_STATUS_STATE_DIR: 42, XDG_STATE_HOME: xdg }), stored);
  });

  test('the stored dir wins whenever it holds a file of ours, and the active-id dir is the second candidate', () => {
    const storedOnly = sandbox('stored-known');
    fs.writeFileSync(path.join(storedOnly.stored, 'gentle-status.pid'), '1\n');
    assert.equal(store.themeStateDir({ XDG_STATE_HOME: storedOnly.xdg }), storedOnly.stored);

    const activeOnly = sandbox('active-only');
    fs.mkdirSync(activeOnly.activeId, { recursive: true });
    fs.writeFileSync(path.join(activeOnly.activeId, 'gentle-moshi.json'), '{"enabled":true}\n');
    assert.equal(store.themeStateDir({ XDG_STATE_HOME: activeOnly.xdg }), activeOnly.activeId);
  });

  test('the resolved dir is the one the Moshi / sidebar flags already live in', () => {
    const fixtures = [
      sandbox('parity-fresh'),
      (() => {
        const fx = sandbox('parity-stored');
        fs.writeFileSync(path.join(fx.stored, 'gentle-moshi.json'), '{"enabled":true}\n');
        return fx;
      })(),
      (() => {
        const fx = sandbox('parity-active');
        fs.mkdirSync(fx.activeId, { recursive: true });
        fs.writeFileSync(path.join(fx.activeId, 'gentle-status.pid'), '1\n');
        return fx;
      })(),
    ];
    for (const fx of fixtures) {
      const env = { XDG_STATE_HOME: fx.xdg, HERDR_PLUGIN_STATE_DIR: path.join(fx.root, 'injected-shell') };
      assert.equal(
        store.themeStateDir(env),
        path.dirname(sidebar.modePath(env)),
        'two sibling modules may never disagree on which file is the panel truth',
      );
    }
  });
});

describe('readThemeState', () => {
  test('a missing file is inert defaults, and reading creates nothing', () => {
    const { xdg, stored } = sandbox('read-missing');
    const state = store.readThemeState({ XDG_STATE_HOME: xdg });
    assert.deepEqual(state, { ok: true, sync: false, theme: null, updatedAt: null });
    assert.deepEqual(fs.readdirSync(stored), [], 'S7: a fresh install keeps Herdr untouched');
  });

  test('a valid document reads back as written', () => {
    const { xdg } = sandbox('read-valid');
    const env = { XDG_STATE_HOME: xdg };
    fs.writeFileSync(
      store.themeStatePath(env),
      `${JSON.stringify({ sync: true, theme: ' nord ', updatedAt: '2024-05-06T07:08:09.000Z' }, null, 2)}\n`,
    );
    assert.deepEqual(store.readThemeState(env), {
      ok: true,
      sync: true,
      theme: 'nord',
      updatedAt: '2024-05-06T07:08:09.000Z',
    });
  });

  test('an unparsable document is a refusal with inert defaults', () => {
    const { xdg } = sandbox('read-bad-json');
    const env = { XDG_STATE_HOME: xdg };
    const file = store.themeStatePath(env);
    fs.writeFileSync(file, '{ "sync": true, ');
    const state = store.readThemeState(env);
    assert.equal(state.ok, false);
    assert.equal(state.sync, false);
    assert.equal(state.theme, null);
    assert.equal(state.updatedAt, null);
    assert.match(state.error, /gentle-theme\.json/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "sync": true, ', 'a refused read never rewrites the file');
  });

  test('a top-level value that is not an object is a refusal', () => {
    const { xdg } = sandbox('read-array');
    const env = { XDG_STATE_HOME: xdg };
    fs.writeFileSync(store.themeStatePath(env), '[true, "nord"]\n');
    assert.equal(store.readThemeState(env).ok, false);
    fs.writeFileSync(store.themeStatePath(env), '"nord"\n');
    assert.equal(store.readThemeState(env).ok, false);
  });

  test('only literally boolean sync and a usable theme name survive', () => {
    const { xdg } = sandbox('read-typing');
    const env = { XDG_STATE_HOME: xdg };
    const cases = [
      [{ sync: 'true', theme: 'nord' }, false, 'nord'],
      [{ sync: 1, theme: 'nord' }, false, 'nord'],
      [{ sync: true, theme: '   ' }, true, null],
      [{ sync: true, theme: 42 }, true, null],
      [{ sync: true, theme: null }, true, null],
      [{}, false, null],
    ];
    for (const [doc, sync, theme] of cases) {
      fs.writeFileSync(store.themeStatePath(env), `${JSON.stringify(doc)}\n`);
      const state = store.readThemeState(env);
      assert.equal(state.ok, true, `a readable object is not a refusal: ${JSON.stringify(doc)}`);
      assert.equal(state.sync, sync, `sync for ${JSON.stringify(doc)}`);
      assert.equal(state.theme, theme, `theme for ${JSON.stringify(doc)}`);
    }
  });
});

describe('writeThemeState', () => {
  test('the written document is a valid, atomic, self-stamped JSON file', () => {
    const { xdg, stored } = sandbox('write');
    const env = { XDG_STATE_HOME: xdg };
    const before = Date.now();
    const result = store.writeThemeState(env, { sync: true, theme: '  nord ' });
    const file = path.join(stored, 'gentle-theme.json');
    assert.deepEqual(result, { path: file });
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.endsWith('\n'), true, 'the on-disk document ends with a newline');
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc), ['sync', 'theme', 'updatedAt']);
    assert.equal(doc.sync, true);
    assert.equal(doc.theme, 'nord');
    assert.equal(typeof doc.updatedAt, 'string');
    const stamped = Date.parse(doc.updatedAt);
    assert.equal(Number.isNaN(stamped), false, 'updatedAt is a parseable ISO timestamp');
    assert.equal(new Date(stamped).toISOString(), doc.updatedAt);
    assert.equal(stamped >= before - 1000 && stamped <= Date.now() + 1000, true);
    assert.deepEqual(fs.readdirSync(stored), ['gentle-theme.json'], 'the temp file is renamed away');
    assert.deepEqual(store.readThemeState(env), { ok: true, sync: true, theme: 'nord', updatedAt: doc.updatedAt });
  });

  test('an unassigned theme writes null and stamps its own updatedAt', () => {
    const { xdg } = sandbox('write-null');
    const env = { XDG_STATE_HOME: xdg };
    store.writeThemeState(env, { sync: false, theme: null, updatedAt: 'not-a-date' });
    const doc = JSON.parse(fs.readFileSync(store.themeStatePath(env), 'utf8'));
    assert.equal(doc.theme, null);
    assert.equal(doc.sync, false);
    assert.notEqual(doc.updatedAt, 'not-a-date', 'the caller never supplies the timestamp');
    assert.equal(Number.isNaN(Date.parse(doc.updatedAt)), false);
  });

  test('a second write preserves the mode of the existing file', () => {
    const { xdg } = sandbox('write-mode');
    const env = { XDG_STATE_HOME: xdg };
    store.writeThemeState(env, { sync: true, theme: 'nord' });
    fs.chmodSync(store.themeStatePath(env), 0o640);
    store.writeThemeState(env, { sync: true, theme: 'dracula' });
    assert.equal(fs.statSync(store.themeStatePath(env)).mode & 0o777, 0o640);
    assert.equal(store.readThemeState(env).theme, 'dracula');
  });

  test('invalid input throws a TypeError and leaves the document untouched', () => {
    const { xdg } = sandbox('write-refuse');
    const env = { XDG_STATE_HOME: xdg };
    store.writeThemeState(env, { sync: true, theme: 'nord' });
    const file = store.themeStatePath(env);
    const before = fs.readFileSync(file, 'utf8');
    for (const bad of [undefined, null, 'sync', { sync: 'yes', theme: 'nord' }, { sync: 1 }, { theme: 'nord' }]) {
      assert.throws(() => store.writeThemeState(env, bad), TypeError, `refuses ${JSON.stringify(bad)}`);
    }
    assert.throws(() => store.writeThemeState(env, { sync: true, theme: 42 }), TypeError);
    assert.throws(() => store.writeThemeState(env, { sync: true, theme: ['nord'] }), TypeError);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['gentle-theme.json'], 'a refusal writes no temp file');
  });

  test('nothing else in the state dir is touched', () => {
    const { xdg, stored } = sandbox('write-siblings');
    const env = { XDG_STATE_HOME: xdg };
    const sibling = path.join(stored, 'gentle-moshi.json');
    fs.writeFileSync(sibling, '{"enabled":true}\n');
    store.writeThemeState(env, { sync: true, theme: 'nord' });
    assert.equal(fs.readFileSync(sibling, 'utf8'), '{"enabled":true}\n');
    assert.deepEqual(fs.readdirSync(stored).sort(), ['gentle-moshi.json', 'gentle-theme.json']);
  });
});
