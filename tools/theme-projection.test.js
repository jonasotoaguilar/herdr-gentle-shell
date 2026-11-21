'use strict';
// The Pi -> Herdr palette projection (S3/S4): which Pi theme tokens may become
// Herdr theme tokens, in which order, and when the projection must stay empty.
//
// The projection is the only thing that decides what Herdr's palette is allowed
// to become, so every assertion here is about the exact emitted document: key
// order (Herdr's theme table is written in this order), omission of every
// colour that is not a concrete hex (a terminal-default foreground must never
// be spelled as a guess), and the shared-source rule for `subtext0`/`overlay0`
// (both come from Pi's `muted`, so they are emitted or omitted together).
//
// Two rules came from the reference implementation
// (/home/jona/dev/upstream/gentle-herdr lib/herdr-theme-projection.ts, MIT,
// Copyright (c) MarsSall) and are pinned here because they change what the user
// sees on screen:
//
//   - the role map is EIGHT tokens. Working/done status and notification colours
//     (yellow, blue, teal, peach) are left to Herdr's base theme; our extra
//     mappings recoloured them, which the reference never does;
//   - the three Gentle theme names carry the reference's `DOTS_FIXED` surface
//     colours, because the Gentle palette defines foregrounds only. A fixed
//     value wins over the mapped one for the same token (Sexy's `mauve` and
//     `subtext0`, Cute's `overlay0`).
//
// The fingerprint is asserted as an exact string because it is the change
// detector: same name plus one changed colour must produce a different value,
// and a different key order in the input must not.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const projection = require('../lib/theme-projection.js');

const PI_COLORS = {
  accent: '#7aa2f7',
  text: '#C0CAF5',
  error: '#f7768e',
  success: '#9ece6a',
  warning: '#e0af68',
  mdLink: '#7dcfff',
  syntaxType: '#2ac3de',
  muted: '#a9b1d6',
  thinkingText: '#565f89',
  borderAccent: '#bb9af7',
};

// The exact document a fully concrete Pi palette projects to, in Herdr's order.
// The palette above names every role our own 1.8.0 map used; only the reference's
// eight survive, so `yellow`, `blue` and `teal` are absent by design.
const FULL_CUSTOM = {
  accent: '#7aa2f7',
  text: '#c0caf5',
  red: '#f7768e',
  green: '#9ece6a',
  subtext0: '#a9b1d6',
  overlay0: '#a9b1d6',
  overlay1: '#565f89',
  mauve: '#bb9af7',
};

describe('projection constants', () => {
  test('the base theme, its siblings, the token order and the role map are fixed', () => {
    assert.equal(projection.HERDR_BASE_THEME, 'one-dark');
    assert.deepEqual(projection.HERDR_BASE_THEMES, [
      'catppuccin',
      'terminal',
      'tokyo-night',
      'dracula',
      'nord',
      'gruvbox',
      'one-dark',
      'solarized',
      'kanagawa',
      'rose-pine',
      'vesper',
    ]);
    assert.deepEqual(projection.HERDR_TOKEN_ORDER, [
      'sidebar_bg',
      'panel_bg',
      'active_row_bg',
      'selection_bg',
      'accent',
      'text',
      'red',
      'green',
      'subtext0',
      'overlay0',
      'overlay1',
      'mauve',
      'yellow',
      'peach',
      'blue',
      'teal',
      'surface0',
      'surface1',
      'surface_dim',
    ]);
    // Exactly the reference's eight sources. Adding one back is a visible
    // regression: it repaints a status or notification colour the base theme owns.
    assert.deepEqual(projection.HERDR_ROLE_SOURCES, {
      accent: 'accent',
      text: 'text',
      red: 'error',
      green: 'success',
      subtext0: 'muted',
      overlay0: 'muted',
      overlay1: 'thinkingText',
      mauve: 'borderAccent',
    });
  });

  test('the fixed Gentleman.Dots surfaces are the reference table, keyed by Pi theme name', () => {
    // Values are the reference's own, verbatim (they carry upper-case hex): the
    // table is a copy of Gentleman.Dots, and normalisation belongs to the
    // emitted document, not to the reference data.
    assert.deepEqual(projection.DOTS_FIXED, {
      'Gentleman-Cute': {
        panel_bg: '#000000',
        surface0: '#241822',
        surface1: '#342230',
        surface_dim: '#20161E',
        overlay0: '#B99AA9',
      },
      'Gentleman-Sexy': {
        panel_bg: '#000000',
        surface0: '#241822',
        surface1: '#342230',
        surface_dim: '#20161E',
        overlay0: '#B99AA9',
        subtext0: '#FF4F9A',
        mauve: '#B99AA9',
        active_row_bg: '#2E0F1F',
        selection_bg: '#2E0F1F',
      },
      Gentle: { panel_bg: '#06080f' },
    });
  });
});

describe('isConcreteHex', () => {
  test('only a six-digit hex string is concrete', () => {
    assert.equal(projection.isConcreteHex('#7aa2f7'), true);
    assert.equal(projection.isConcreteHex('#7AA2F7'), true);
    assert.equal(projection.isConcreteHex('#fff'), false);
    assert.equal(projection.isConcreteHex('#7aa2f77'), false);
    assert.equal(projection.isConcreteHex('7aa2f7'), false);
    assert.equal(projection.isConcreteHex('red'), false);
    assert.equal(projection.isConcreteHex(''), false);
    assert.equal(projection.isConcreteHex(undefined), false);
    assert.equal(projection.isConcreteHex(null), false);
    assert.equal(projection.isConcreteHex(42), false);
  });
});

describe('projectPalette', () => {
  test('a fully concrete palette projects every sourced token in Herdr order', () => {
    const result = projection.projectPalette({ name: 'tokyo-night', colors: PI_COLORS });
    assert.deepEqual(result, { theme: { name: 'one-dark', custom: FULL_CUSTOM } });
    assert.deepEqual(
      Object.keys(result.theme.custom),
      ['accent', 'text', 'red', 'green', 'subtext0', 'overlay0', 'overlay1', 'mauve'],
      'the emitted order is Herdr token order, never input or role-map order',
    );
  });

  test('working/done status and notification colours stay with the base theme', () => {
    // The palette DOES carry all three (as it did for real, hence the bug): they
    // must still never reach Herdr's custom table.
    const { custom } = projection.projectPalette({ name: 'tokyo-night', colors: PI_COLORS }).theme;
    for (const token of ['yellow', 'blue', 'teal', 'peach']) {
      assert.equal(token in custom, false, `${token} belongs to Herdr's base theme, never to the projection`);
    }
  });

  test('surfaces the palette does not own stay with the base theme', () => {
    const { custom } = projection.projectPalette({ colors: PI_COLORS }).theme;
    for (const token of ['sidebar_bg', 'surface0', 'surface1', 'surface_dim']) {
      assert.equal(token in custom, false, `${token} is never projected from an arbitrary Pi theme`);
    }
  });

  test('a terminal default or a non-hex value omits its token', () => {
    const result = projection.projectPalette({
      name: 'terminal',
      colors: { ...PI_COLORS, accent: '', error: 'default', syntaxType: '#fff' },
    });
    assert.deepEqual(result.theme.custom, {
      text: '#c0caf5',
      green: '#9ece6a',
      subtext0: '#a9b1d6',
      overlay0: '#a9b1d6',
      overlay1: '#565f89',
      mauve: '#bb9af7',
    });
  });

  test('a missing key is a terminal default, not an error', () => {
    const result = projection.projectPalette({ colors: { accent: '#7aa2f7' } });
    assert.deepEqual(result, { theme: { name: 'one-dark', custom: { accent: '#7aa2f7' } } });
  });

  test('subtext0 and overlay0 are emitted or omitted together', () => {
    const withMuted = projection.projectPalette({ colors: { muted: '#A9B1D6' } }).theme.custom;
    assert.deepEqual(withMuted, { subtext0: '#a9b1d6', overlay0: '#a9b1d6' });
    const withoutMuted = projection.projectPalette({ colors: { muted: '' } }).theme.custom;
    assert.equal(withoutMuted, undefined, 'and the custom block disappears with them');
  });

  test('hex is normalised to lowercase', () => {
    const { custom } = projection.projectPalette({ colors: { text: '#ABCDEF', muted: '#012345' } }).theme;
    assert.deepEqual(custom, { text: '#abcdef', subtext0: '#012345', overlay0: '#012345' });
  });

  test('an empty projection emits no custom block at all', () => {
    const result = projection.projectPalette({ name: 'nord', colors: {} });
    assert.deepEqual(result, { theme: { name: 'one-dark' } });
    assert.equal('custom' in result.theme, false, 'an empty custom object would still override the base theme');
  });

  test('a non-object input or a missing colors record is a TypeError', () => {
    for (const bad of [null, undefined, 'nord', 42, []]) {
      assert.throws(() => projection.projectPalette(bad), TypeError);
    }
    assert.throws(() => projection.projectPalette({}), /colors/);
    assert.throws(() => projection.projectPalette({ colors: null }), /colors/);
    assert.throws(() => projection.projectPalette({ colors: ['#7aa2f7'] }), /colors/);
  });

  test('the input palette is not mutated', () => {
    const colors = { ...PI_COLORS };
    const snapshot = { ...colors };
    projection.projectPalette({ name: 'nord', colors });
    assert.deepEqual(colors, snapshot);
  });
});

describe('the fixed Gentleman.Dots surfaces', () => {
  test('Gentleman-Cute adds its surfaces in Herdr order and its fixed overlay0 wins', () => {
    const { custom } = projection.projectPalette({ name: 'Gentleman-Cute', colors: PI_COLORS }).theme;
    assert.deepEqual(Object.keys(custom), [
      'panel_bg',
      'active_row_bg',
      'selection_bg',
      'accent',
      'text',
      'red',
      'green',
      'subtext0',
      'overlay0',
      'overlay1',
      'mauve',
      'surface0',
      'surface1',
      'surface_dim',
    ].filter((token) => token in custom));
    assert.deepEqual(custom, {
      panel_bg: '#000000',
      accent: '#7aa2f7',
      text: '#c0caf5',
      red: '#f7768e',
      green: '#9ece6a',
      subtext0: '#a9b1d6',
      overlay0: '#b99aa9',
      overlay1: '#565f89',
      mauve: '#bb9af7',
      surface0: '#241822',
      surface1: '#342230',
      surface_dim: '#20161e',
    });
    assert.equal(custom.overlay0, '#b99aa9', 'a fixed value wins over the mapped muted colour');
  });

  test('Gentleman-Sexy overrides subtext0, mauve and its two row surfaces', () => {
    const { custom } = projection.projectPalette({ name: 'Gentleman-Sexy', colors: PI_COLORS }).theme;
    assert.equal(custom.subtext0, '#ff4f9a', 'Sexy draws unfocused session names in fuchsia');
    assert.equal(custom.mauve, '#b99aa9', 'and branches in grayish pink');
    assert.equal(custom.overlay0, '#b99aa9', 'Cute\'s overlay0 is inherited by Sexy');
    assert.equal(custom.active_row_bg, '#2e0f1f');
    assert.equal(custom.selection_bg, '#2e0f1f');
    assert.equal(custom.panel_bg, '#000000');
  });

  test('Gentle adds only its panel background', () => {
    assert.deepEqual(projection.projectPalette({ name: 'Gentle', colors: PI_COLORS }).theme.custom, {
      panel_bg: '#06080f',
      accent: '#7aa2f7',
      text: '#c0caf5',
      red: '#f7768e',
      green: '#9ece6a',
      subtext0: '#a9b1d6',
      overlay0: '#a9b1d6',
      overlay1: '#565f89',
      mauve: '#bb9af7',
    });
  });

  test('the lookup is by theme name alone: other names get no fixed values', () => {
    for (const name of ['tokyo-night', 'gentleman-cute', 'Gentleman', '', null, undefined]) {
      const { custom } = projection.projectPalette({ name, colors: PI_COLORS }).theme;
      assert.equal('panel_bg' in custom, false, `${String(name)} is not a Gentle theme name`);
    }
  });

  test('a fixed surface is emitted even when the palette supplies no mapped colour', () => {
    assert.deepEqual(projection.projectPalette({ name: 'Gentleman-Cute', colors: {} }).theme.custom, {
      panel_bg: '#000000',
      overlay0: '#b99aa9',
      surface0: '#241822',
      surface1: '#342230',
      surface_dim: '#20161e',
    });
  });
});

describe('paletteFingerprint', () => {
  const first = { name: 'nord', colors: { accent: '#111111', mdLink: '#222222' } };

  test('the fingerprint is the stable name plus role/hex pairs sorted by role', () => {
    assert.equal(projection.paletteFingerprint(first), JSON.stringify(['nord', [['accent', '#111111']]]));
  });

  test('the same palette in another key order is the same fingerprint', () => {
    const reordered = { name: 'nord', colors: { mdLink: '#222222', accent: '#111111' } };
    assert.equal(projection.paletteFingerprint(reordered), projection.paletteFingerprint(first));
  });

  test('a theme changed in place changes the fingerprint', () => {
    const recoloured = { name: 'nord', colors: { accent: '#333333', mdLink: '#222222' } };
    assert.notEqual(projection.paletteFingerprint(recoloured), projection.paletteFingerprint(first));
    const renamed = { name: 'dracula', colors: { accent: '#111111', mdLink: '#222222' } };
    assert.notEqual(projection.paletteFingerprint(renamed), projection.paletteFingerprint(first));
  });

  test('switching between the Gentle themes changes the fingerprint for the same colours', () => {
    const cute = projection.paletteFingerprint({ name: 'Gentleman-Cute', colors: PI_COLORS });
    const sexy = projection.paletteFingerprint({ name: 'Gentleman-Sexy', colors: PI_COLORS });
    const gentle = projection.paletteFingerprint({ name: 'Gentle', colors: PI_COLORS });
    assert.notEqual(cute, sexy, 'the fixed surfaces are part of the palette, not decoration');
    assert.notEqual(cute, gentle);
    assert.notEqual(sexy, gentle);
  });
});

describe('stored theme labels and names', () => {
  test('an unassigned or unusable stored value reads as Off', () => {
    assert.equal(projection.THEME_OFF_LABEL, 'Off');
    for (const value of [null, undefined, '', '   ', 42, {}]) {
      assert.equal(projection.themeChoiceLabel(value), 'Off');
    }
  });

  test('an assigned theme reads as its trimmed name', () => {
    assert.equal(projection.themeChoiceLabel('nord'), 'nord');
    assert.equal(projection.themeChoiceLabel('  kanagawa  '), 'kanagawa');
  });

  test('normalizeThemeName never guesses', () => {
    assert.equal(projection.normalizeThemeName('nord'), 'nord');
    assert.equal(projection.normalizeThemeName('  rose-pine  '), 'rose-pine');
    assert.equal(projection.normalizeThemeName(''), null);
    assert.equal(projection.normalizeThemeName('   '), null);
    assert.equal(projection.normalizeThemeName(null), null);
    assert.equal(projection.normalizeThemeName(undefined), null);
    assert.equal(projection.normalizeThemeName(42), null);
    assert.equal(projection.normalizeThemeName(['nord']), null);
    assert.equal(projection.normalizeThemeName({ name: 'nord' }), null);
  });
});
