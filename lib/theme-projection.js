#!/usr/bin/env node
'use strict';

// The Pi -> Herdr palette projection: the pure half of theme sync (S3/S4).
//
// Herdr keeps its theme in a fixed vocabulary of tokens, and this module is the
// only place that translates Pi's theme tokens into it. It is pure on purpose:
// the extension converts Pi's colour values to hex strings before calling in, so
// this file needs no host import, no filesystem and no network — the caller owns
// every side effect and the projection can be asserted byte for byte.
//
// Only the tokens a sidebar actually paints are projected. Herdr's surface
// tokens (sidebar_bg, panel_bg, active_row_bg, selection_bg, surface*) keep
// their base-theme values because Pi has no equivalent surface concept: a Pi
// theme names foregrounds and accents, not panel backgrounds, so inventing one
// here would put colours on screen that the user never chose. The one exception
// is the fixed Gentleman.Dots table below, which is not invented here: it is the
// palette the user's own Herdr profiles already use.
//
// Looked up by Pi theme NAME, exactly like the reference table: the Gentle themes
// are the only ones whose surface colours we know.
//
// Ported from gentle-herdr lib/herdr-theme-projection.ts
// (https://github.com/MarsSall/gentle-herdr, MIT License, Copyright (c) MarsSall).
const DOTS_CUTE = Object.freeze({
  panel_bg: '#000000',
  surface0: '#241822',
  surface1: '#342230',
  surface_dim: '#20161E',
  overlay0: '#B99AA9',
});
// Sexy shares Cute's surfaces and only differs in the accent: Herdr draws
// unfocused session names with subtext0 and branches with overlay0 (mauve when
// focused), so Sexy gets fuchsia names, grayish pink branches and a wine row.
const DOTS_SEXY = Object.freeze({
  ...DOTS_CUTE,
  subtext0: '#FF4F9A',
  mauve: '#B99AA9',
  active_row_bg: '#2E0F1F',
  selection_bg: '#2E0F1F',
});
const DOTS_FIXED = Object.freeze({
  'Gentleman-Cute': DOTS_CUTE,
  'Gentleman-Sexy': DOTS_SEXY,
  Gentle: Object.freeze({ panel_bg: '#06080f' }),
});

const HERDR_BASE_THEME = 'one-dark';

// The Herdr themes a stored selection may name, exactly the set Herdr ships.
const HERDR_BASE_THEMES = Object.freeze([
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

// Herdr's own token order. A projected `[theme.custom]` table is written in this
// order so the managed block stays diff-stable, which is why a token may appear
// here without a Pi source: `peach` and the surface tokens are part of the
// vocabulary, not part of this projection.
const HERDR_TOKEN_ORDER = Object.freeze([
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

// The only Pi theme tokens this projection reads, and exactly the reference's
// eight: working/done status and notification colours (yellow, teal, blue,
// peach) stay with Herdr's native base theme, because mapping them here
// recoloured statuses the user never asked to repaint. `subtext0` and `overlay0`
// share Pi's `muted`: a single Pi role paints two Herdr surfaces, and the
// emitted pair follows the source, so they are never half-applied.
const HERDR_ROLE_SOURCES = Object.freeze({
  accent: 'accent',
  text: 'text',
  red: 'error',
  green: 'success',
  subtext0: 'muted',
  overlay0: 'muted',
  overlay1: 'thinkingText',
  mauve: 'borderAccent',
});

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

const THEME_OFF_LABEL = 'Off';

function isConcreteHex(value) {
  return typeof value === 'string' && HEX_PATTERN.test(value);
}

// A stored theme value is either an assigned name or nothing at all. Trimming is
// the only normalisation; a blank, non-string or otherwise odd value is `null`
// (unassigned) rather than a guess at what the user meant.
function normalizeThemeName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// The panel label for a stored value: an unusable value reads as the inert
// choice instead of surfacing the raw garbage in the UI.
function themeChoiceLabel(name) {
  return normalizeThemeName(name) ?? THEME_OFF_LABEL;
}

function requireColors(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('projectPalette expects an object with a `colors` record');
  }
  const { colors } = input;
  if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) {
    throw new TypeError('projectPalette expects `colors` to be a record of Pi theme tokens to hex strings');
  }
  return colors;
}

// The Herdr custom table for a Pi palette, in Herdr token order. A token whose
// source is not a concrete hex is omitted rather than defaulted: an empty string
// means "terminal default" in Pi, which has no hex spelling, and a guessed one
// would repaint the sidebar in a colour nobody picked. A DOTS_FIXED value for the
// same token wins over the mapped one: those surfaces are known from the user's
// Herdr profiles, while the mapped colour is an approximation of them.
function customTokens(name, colors) {
  const themeName = normalizeThemeName(name);
  const fixed = Object.hasOwn(DOTS_FIXED, themeName ?? '') ? DOTS_FIXED[themeName] : {};
  const custom = {};
  for (const token of HERDR_TOKEN_ORDER) {
    if (Object.hasOwn(fixed, token)) {
      custom[token] = fixed[token].toLowerCase();
      continue;
    }
    const source = HERDR_ROLE_SOURCES[token];
    if (source === undefined) continue;
    const hex = colors[source];
    if (!isConcreteHex(hex)) continue;
    custom[token] = hex.toLowerCase();
  }
  return custom;
}

function projectPalette(input) {
  const colors = requireColors(input);
  const custom = customTokens(input.name, colors);
  const theme = { name: HERDR_BASE_THEME };
  // An empty custom table is omitted, not written empty: Herdr would still treat
  // the block as an override, and S7 wants an untouched palette to stay one.
  if (Object.keys(custom).length > 0) theme.custom = custom;
  return { theme };
}

// A stable identity for "this palette", used to notice an in-place theme change
// (same name, different colours) without diffing documents. Roles are sorted so
// the fingerprint never depends on the order the caller built its record in.
function paletteFingerprint(input) {
  const colors = requireColors(input);
  const name = normalizeThemeName(input.name);
  const pairs = Object.entries(customTokens(name, colors)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([name, pairs]);
}

module.exports = {
  HERDR_BASE_THEME,
  HERDR_BASE_THEMES,
  HERDR_TOKEN_ORDER,
  HERDR_ROLE_SOURCES,
  DOTS_FIXED,
  THEME_OFF_LABEL,
  isConcreteHex,
  projectPalette,
  paletteFingerprint,
  themeChoiceLabel,
  normalizeThemeName,
};
