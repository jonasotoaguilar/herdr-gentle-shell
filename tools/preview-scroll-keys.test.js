'use strict';
// round-3 T3 S1 tests: lib/preview-scroll-keys.js — the ONE decision for the
// preview scroll bindings of the full-screen readers, and the ONE place that
// says which of those keys the terminal can actually deliver.
//
// The user asked for ctrl+shift+j/k and for a footer that names the usable
// keys instead of always printing ctrl+j/k. Contract under test, as observable
// output only:
//   - the primary full-page pair resolves through the host's own key
//     classifier (symbolic names) and through the two bounded extended
//     sequences, CSI-u modifier 6 and xterm modifyOtherKeys; only presses and
//     repeats act, releases never do;
//   - PageDown/PageUp always resolve, with or without host helpers;
//   - the printable Shift+J/K fallback is the SAME full-page action, so a
//     legacy terminal keeps a usable way to page the preview;
//   - ctrl+d/ctrl+u stay the distinct half-page shortcut;
//   - lowercase j/k never scrolls, and bare LF (which a legacy terminal sends
//     for both ctrl+j and Enter) and ctrl+k are not aliases;
//   - the legend names ctrl+shift+j/k only when the host confirms the extended
//     protocol, and Shift+J/K plus PgUp/PgDn otherwise — never a guessed
//     platform default.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const scrollKeys = require('../lib/preview-scroll-keys.js');

const { ACTIONS } = scrollKeys;

// What a host module would report for one payload. A table, not a decoder, so
// these tests describe the helper's contract instead of the installed
// terminal module's behaviour.
const TABLE = {
  '\x1b[6~': ['pageDown'],
  '\x1b[5~': ['pageUp'],
  '\x04': ['ctrl+d'],
  '\x15': ['ctrl+u'],
  '\x1b[106;6u': ['ctrl+shift+j', 'shift+ctrl+j'],
  '\x1b[107;6u': ['ctrl+shift+k', 'shift+ctrl+k'],
  '\x1b[27;6;106~': ['ctrl+shift+j', 'shift+ctrl+j'],
  '\x1b[27;6;107~': ['ctrl+shift+k', 'shift+ctrl+k'],
  '\x1b[106;5u': ['ctrl+j'],
  '\x1b[100;5u': ['ctrl+d'],
  '\x1b[117;5u': ['ctrl+u'],
  '\x1b[27;5;106~': ['ctrl+j'],
  J: ['shift+j'],
  K: ['shift+k'],
  j: ['j'],
  k: ['k'],
  '\n': ['enter'],
  '\x0b': ['ctrl+k'],
  '\r': ['enter'],
};

const namesOf = (data) => TABLE[data] || [];

// One letter names compare exactly: a host must never answer `j` for `J`.
function sameName(left, right) {
  const a = String(left);
  const b = String(right);
  return a.length === 1 || b.length === 1 ? a === b : a.toLowerCase() === b.toLowerCase();
}

function host(options = {}) {
  const { kitty = false, matcher = true, parser = true } = options;
  const helpers = {
    isKittyProtocolActive: () => kitty,
    isKeyRelease: (data) => /:3u$/.test(String(data)) || /;3~$/.test(String(data)),
  };
  if (matcher) helpers.matchesKey = (data, name) => namesOf(data).some((entry) => sameName(entry, name));
  if (parser) helpers.parseKey = (data) => namesOf(data)[0] ?? null;
  return helpers;
}

const textOf = (entries) => entries.map((entry) => String(entry.text)).join(' · ');
const primaryOf = (entries) => entries[0].text;

describe('legend names the keys the terminal can actually deliver', () => {
  test('a confirmed extended protocol advertises the primary ctrl+shift pair', () => {
    const entries = scrollKeys.previewScrollKeys(host({ kitty: true }));
    assert.match(textOf(entries), /ctrl\+shift\+j\/k/, 'the primary pair is ctrl+shift+j/k');
    assert.ok(!/(^|[^+])\bctrl\+j\/k\b/.test(textOf(entries)), `no stale ctrl+j/k token: ${textOf(entries)}`);
    for (const entry of entries) {
      assert.equal(typeof entry.short, 'string', 'every tier has a compact form');
      assert.equal(typeof entry.priority, 'number', 'every tier carries its drop priority');
    }
  });

  test('an unconfirmed, missing or throwing capability getter falls back to the printable pair', () => {
    const getters = [
      ['inactive', host({ kitty: false })],
      ['missing namespace', {}],
      ['no helpers', null],
      ['throwing getter', { isKittyProtocolActive: () => { throw new Error('no tty'); } }],
      ['non-boolean answer', { isKittyProtocolActive: () => 'yes' }],
    ];
    for (const [label, helpers] of getters) {
      const entries = scrollKeys.previewScrollKeys(helpers);
      assert.match(primaryOf(entries), /shift\+j\/k/, `${label}: the printable fallback is named`);
      assert.ok(!textOf(entries).includes('ctrl+shift'), `${label}: no fabricated extended support`);
      assert.ok(!textOf(entries).includes('ctrl+j'), `${label}: the removed ctrl+j binding is gone`);
    }
  });

  test('the page keys are named in both tiers, so the always-available pair is visible', () => {
    for (const kitty of [true, false]) {
      const entries = scrollKeys.previewScrollKeys(host({ kitty }));
      const pages = entries.find((entry) => /PgUp|PgDn/.test(entry.text));
      assert.ok(pages, `kitty ${kitty}: the PageUp/PageDown entry exists`);
      assert.ok(entries.some((entry) => /ctrl\+d\/u/.test(entry.text)), `kitty ${kitty}: the half-page shortcut is named`);
    }
  });

  test('the primary pair outranks the secondary hints, so compaction never drops it first', () => {
    const entries = scrollKeys.previewScrollKeys(host({ kitty: true }));
    const primary = entries[0];
    for (const entry of entries.slice(1)) {
      assert.ok(primary.priority >= entry.priority, `primary ${primary.text} outranks ${entry.text}`);
    }
  });
});

describe('primary full-page pair (extended protocol)', () => {
  test('the host classifier resolves the symbolic ctrl+shift names', () => {
    const helpers = host({ kitty: true });
    assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[106;6u'), ACTIONS.PAGE_DOWN);
    assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[107;6u'), ACTIONS.PAGE_UP);
  });

  test('CSI-u modifier 6 resolves through the bounded fallback when no host matcher exists', () => {
    for (const helpers of [null, {}]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[106;6u'), ACTIONS.PAGE_DOWN);
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[107;6u'), ACTIONS.PAGE_UP);
    }
  });

  test('a key repeat acts and a release never does', () => {
    const helpers = host({ kitty: true });
    assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[106;6:2u'), ACTIONS.PAGE_DOWN, 'repeat acts');
    assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[106;6:3u'), null, 'release is ignored');
    assert.equal(scrollKeys.resolveScrollAction(null, '\x1b[106;6:3u'), null, 'release is ignored with no helpers');
  });

  test('xterm modifyOtherKeys modifier 6 resolves, and its release suffix is ignored', () => {
    const helpers = host({ kitty: true });
    assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[27;6;106~'), ACTIONS.PAGE_DOWN);
    assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[27;6;107~'), ACTIONS.PAGE_UP);
    assert.equal(scrollKeys.resolveScrollAction(null, '\x1b[27;6;106~'), ACTIONS.PAGE_DOWN, 'raw fallback too');
    assert.equal(scrollKeys.resolveScrollAction(null, '\x1b[27;6;106;3~'), null, 'release is ignored');
  });
});

describe('printable Shift+J/K fallback', () => {
  test('uppercase J/K are the same full-page actions the extended pair resolves to', () => {
    const extended = host({ kitty: true });
    for (const helpers of [extended, host({ kitty: false }), {}, null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'J'), ACTIONS.PAGE_DOWN);
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'K'), ACTIONS.PAGE_UP);
      assert.notEqual(scrollKeys.resolveScrollAction(helpers, 'J'), ACTIONS.HALF_DOWN, 'the fallback is a full page');
    }
  });

  test('the host may report the printable byte as shift+j/shift+k instead of the letter', () => {
    const helpers = host({ kitty: false });
    assert.equal(scrollKeys.resolveScrollAction(helpers, 'J'), ACTIONS.PAGE_DOWN);
    assert.equal(scrollKeys.resolveScrollAction(helpers, 'K'), ACTIONS.PAGE_UP);
  });

  test('lowercase j/k never scrolls: they stay the list selection keys', () => {
    for (const helpers of [host({ kitty: true }), {}, null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'j'), null);
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'k'), null);
    }
  });
});

describe('PageUp/PageDown always resolve', () => {
  test('the legacy bytes work with helpers, with a partial host and with none', () => {
    for (const helpers of [host({ kitty: true }), host({ matcher: false }), {}, null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[6~'), ACTIONS.PAGE_DOWN);
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[5~'), ACTIONS.PAGE_UP);
    }
  });

  test('the extended page sequences resolve too', () => {
    for (const helpers of [host({ kitty: true }), null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[57422u'), ACTIONS.PAGE_DOWN);
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[57421u'), ACTIONS.PAGE_UP);
    }
  });
});

describe('ctrl+d/ctrl+u stay the distinct half-page shortcut', () => {
  test('both halves resolve from the host and from the raw bytes', () => {
    for (const helpers of [host({ kitty: true }), {}, null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x04'), ACTIONS.HALF_DOWN);
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x15'), ACTIONS.HALF_UP);
    }
  });

  test('the extended ctrl+d/ctrl+u sequences resolve as half pages, never as the primary pair', () => {
    for (const helpers of [host({ kitty: true }), null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[100;5u'), ACTIONS.HALF_DOWN);
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[117;5u'), ACTIONS.HALF_UP);
    }
  });
});

describe('no misleading old ctrl+j/ctrl+k aliases', () => {
  test('bare LF and CR never scroll: Enter keeps its own meaning', () => {
    for (const helpers of [host({ kitty: true }), host({ kitty: false }), {}, null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\n'), null);
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\r'), null);
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'enter'), null);
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'return'), null);
    }
  });

  test('the control bytes and names of the removed binding never scroll', () => {
    for (const helpers of [host({ kitty: true }), {}, null]) {
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x0b'), null, 'legacy ctrl+k byte');
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'ctrl+j'), null, 'the removed key name');
      assert.equal(scrollKeys.resolveScrollAction(helpers, 'ctrl+k'), null, 'the removed key name');
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[106;5u'), null, 'Kitty ctrl+j');
      assert.equal(scrollKeys.resolveScrollAction(helpers, '\x1b[27;5;106~'), null, 'xterm ctrl+j');
    }
  });
});

describe('robustness', () => {
  test('a hostile host never throws and still answers from the bounded fallback', () => {
    const hostile = {
      isKittyProtocolActive: () => { throw new Error('boom'); },
      matchesKey: () => { throw new Error('boom'); },
      parseKey: () => { throw new Error('boom'); },
      isKeyRelease: () => { throw new Error('boom'); },
    };
    assert.equal(scrollKeys.previewScrollKeys(hostile)[0].text, 'shift+j/k scroll', 'capability read is conservative');
    assert.equal(scrollKeys.resolveScrollAction(hostile, 'J'), ACTIONS.PAGE_DOWN);
    assert.equal(scrollKeys.resolveScrollAction(hostile, '\x1b[6~'), ACTIONS.PAGE_DOWN);
    assert.equal(scrollKeys.resolveScrollAction(hostile, 'j'), null);
  });

  test('a missing or non-string payload resolves to no action', () => {
    for (const data of [undefined, null, '', 0, {}, []]) {
      assert.equal(scrollKeys.resolveScrollAction(host({ kitty: true }), data), null, `payload ${JSON.stringify(data)}`);
    }
  });
});
