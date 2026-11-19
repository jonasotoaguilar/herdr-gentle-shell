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
const FULL_CUSTOM = {
  accent: '#7aa2f7',
  text: '#c0caf5',
  red: '#f7768e',
  green: '#9ece6a',
  subtext0: '#a9b1d6',
  overlay0: '#a9b1d6',
  overlay1: '#565f89',
  mauve: '#bb9af7',
  yellow: '#e0af68',
  blue: '#7dcfff',
  teal: '#2ac3de',
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
    assert.deepEqual(projection.HERDR_ROLE_SOURCES, {
      accent: 'accent',
      text: 'text',
      red: 'error',
      green: 'success',
      yellow: 'warning',
      blue: 'mdLink',
      teal: 'syntaxType',
      subtext0: 'muted',
      overlay0: 'muted',
      overlay1: 'thinkingText',
      mauve: 'borderAccent',
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
      ['accent', 'text', 'red', 'green', 'subtext0', 'overlay0', 'overlay1', 'mauve', 'yellow', 'blue', 'teal'],
      'the emitted order is Herdr token order, never input or role-map order',
    );
  });

  test('surfaces the palette does not own stay with the base theme', () => {
    const { custom } = projection.projectPalette({ colors: PI_COLORS }).theme;
    for (const token of ['sidebar_bg', 'panel_bg', 'active_row_bg', 'selection_bg', 'surface0', 'surface1', 'surface_dim', 'peach']) {
      assert.equal(token in custom, false, `${token} is never projected`);
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
      yellow: '#e0af68',
      blue: '#7dcfff',
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

describe('paletteFingerprint', () => {
  const first = { name: 'nord', colors: { accent: '#111111', mdLink: '#222222' } };

  test('the fingerprint is the stable name plus role/hex pairs sorted by role', () => {
    assert.equal(projection.paletteFingerprint(first), JSON.stringify(['nord', [['accent', '#111111'], ['blue', '#222222']]]));
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
