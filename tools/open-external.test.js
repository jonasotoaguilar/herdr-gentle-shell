'use strict';
// Key-consistency K3 tests: lib/open-external.js — the `o` opener the odd
// viewer calls to open the focused document through `$VISUAL`/`$EDITOR`.
//
// Contract (observable only): fixed argv with no shell, an injectable
// spawn, and an honest result — never throws, never resolves silently.
// A missing editor (neither variable set) reports the miss without
// spawning; a throwing spawn or an `error` event reports the failure;
// success resolves `{ ok: true }` with the exact argv it ran.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { openExternal, resolveEditor } = require('../lib/open-external.js');

const savedEnv = { ...process.env };
function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

function spawnStub({ calls, behavior = 'spawn' } = {}) {
  return (bin, argv, opts) => {
    calls.push([bin, argv, opts]);
    if (behavior === 'throw') throw new Error('spawn ENOENT');
    const child = new EventEmitter();
    child.unref = () => {};
    if (behavior === 'error') {
      setImmediate(() => child.emit('error', new Error('spawn ed ENOENT')));
    } else if (behavior === 'spawn') {
      setImmediate(() => child.emit('spawn'));
    }
    return child;
  };
}

describe('resolveEditor', () => {
  test('prefers $VISUAL over $EDITOR and trims whitespace', () => {
    assert.equal(resolveEditor({ env: { VISUAL: '  code  ', EDITOR: 'vim' } }), 'code');
    assert.equal(resolveEditor({ env: { EDITOR: 'vim' } }), 'vim');
    assert.equal(resolveEditor({ env: { VISUAL: '  ', EDITOR: '' } }), null);
    assert.equal(resolveEditor({ env: {} }), null);
  });

  test('an explicit editor override wins over the environment', () => {
    assert.equal(resolveEditor({ env: { VISUAL: 'code' }, editor: 'hx' }), 'hx');
  });
});

describe('openExternal', () => {
  test('with no editor configured it reports the miss and never spawns', async () => {
    setEnv({ VISUAL: undefined, EDITOR: undefined });
    try {
      const calls = [];
      const result = await openExternal('/checkout/odd/tasks/alpha.md', {
        spawnImpl: spawnStub({ calls }),
      });
      assert.equal(result.ok, false, 'the miss is reported, never silent');
      assert.match(result.error, /\$VISUAL/, 'the error names the variable to set');
      assert.match(result.error, /\$EDITOR/);
      assert.deepEqual(calls, [], 'nothing spawns when no editor is configured');
    } finally {
      restoreEnv();
    }
  });

  test('an empty target reports the miss without spawning', async () => {
    const calls = [];
    const result = await openExternal('', { editor: 'ed', spawnImpl: spawnStub({ calls }) });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, [], 'nothing spawns for an empty target');
  });

  test('success runs a fixed argv with no shell', async () => {
    const calls = [];
    const result = await openExternal('/checkout/odd/tasks/alpha.md', {
      env: { VISUAL: 'code' },
      spawnImpl: spawnStub({ calls }),
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const [bin, argv, opts] = calls[0];
    assert.equal(bin, 'code');
    assert.deepEqual(argv, ['/checkout/odd/tasks/alpha.md'], 'the target is a plain argv element, never a shell string');
    assert.ok(!opts.shell, 'no shell is ever used');
  });

  test('an editor with arguments keeps them in front of the target', async () => {
    const calls = [];
    const result = await openExternal('/checkout/doc.md', {
      env: { EDITOR: 'code --wait' },
      spawnImpl: spawnStub({ calls }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0][1], ['--wait', '/checkout/doc.md']);
  });

  test('a throwing spawn reports the failure instead of throwing', async () => {
    const calls = [];
    let threw = false;
    let result = null;
    try {
      result = await openExternal('/checkout/doc.md', {
        env: { VISUAL: 'ed' },
        spawnImpl: spawnStub({ calls, behavior: 'throw' }),
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'the opener never throws');
    assert.equal(result.ok, false);
    assert.match(result.error, /ed/, 'the error names the editor that failed');
    assert.equal(calls.length, 1, 'the spawn was attempted exactly once');
  });

  test('a spawn error event reports the failure', async () => {
    const calls = [];
    const result = await openExternal('/checkout/doc.md', {
      env: { VISUAL: 'ed' },
      spawnImpl: spawnStub({ calls, behavior: 'error' }),
    });
    assert.equal(result.ok, false, 'the failure is reported, never silent');
    assert.match(result.error, /ed/);
  });
});
