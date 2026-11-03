'use strict';
// T9 (worktree-issues-reliability S13, S16) tests: lib/tui-paint.js.
//
// Contract under test, as observable output only: the ONE role table decides
// which theme role paints each kind of token, and it keeps the native
// Customize reference's three levels apart —
//
//   a TITLE (a frame title, a section heading, the active tab) takes the
//   theme's SECONDARY colour, a BUTTON/shortcut KEY takes the PRIMARY accent,
//   ordinary text is the theme's normal `text` role, and the SELECTED row is
//   told apart from that normal text by its own background band;
//
// every role is a theme ROLE NAME (never a colour, never an escape sequence a
// view wrote itself), and a theme that is absent, partial, throwing or answers
// a non-string degrades to plain text instead of breaking a render.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const palette = require('../lib/tui-paint.js');

// The role names pi's theme schema resolves (`ThemeColor` / `ThemeBg` in
// @earendil-works/pi-coding-agent). A table entry outside this set would be a
// colour invented here instead of one the injected theme owns.
const THEME_COLOR_ROLES = new Set([
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error', 'warning',
  'muted', 'dim', 'text', 'thinkingText', 'scrollbarTrack', 'scrollbarThumb',
  'searchMatchText', 'userMessageText', 'customMessageText', 'customMessageLabel',
  'toolTitle', 'toolOutput', 'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode',
  'mdCodeBlock', 'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr',
  'mdListBullet', 'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext',
  'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable',
  'syntaxString', 'syntaxNumber', 'syntaxType', 'syntaxOperator',
  'syntaxPunctuation', 'thinkingOff', 'thinkingMinimal', 'thinkingLow',
  'thinkingMedium', 'thinkingHigh', 'thinkingXhigh', 'thinkingMax', 'bashMode',
]);

// A theme that RECORDS which role painted each string and answers a distinct
// SGR code per role, so a rendered line can be read for the ROLE behind a
// token instead of trusting an eyeballed colour.
const ROLE_SGR = { accent: 96, customMessageLabel: 33, mdHeading: 35, muted: 90, dim: 2, border: 34, error: 91, text: 39 };

function recordingTheme() {
  const calls = [];
  const code = (role) => ROLE_SGR[role] ?? 95;
  return {
    calls,
    fg(role, text) {
      const value = String(text);
      calls.push({ role, text: value });
      return `\x1b[${code(role)}m${value}\x1b[0m`;
    },
    bold(text) {
      const value = String(text);
      calls.push({ role: 'bold', text: value });
      return `\x1b[1m${value}\x1b[22m`;
    },
    bg(role, text) {
      const value = String(text);
      calls.push({ role: `bg:${role}`, text: value });
      return `\x1b[48;5;60m${value}\x1b[0m`;
    },
  };
}

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// Origin of the title role (T9, S13): the Pi Agents view the reader pointed at
// declares its own role table in the installed `gentle-pi` package —
// `lib/agents-view.ts:42`:
//   const ROLE = { FRAME: "border", TITLE: "customMessageLabel",
//                  SELECTED: "accent", NAME: "text", NAME_IDLE: "muted",
//                  META: "dim", KEY: "accent", KEY_TEXT: "dim", EMPTY: "dim" }
// — and paints its frame title with `theme.fg(ROLE.TITLE, …)` at line 437. The
// Jobs view uses the same table (`lib/jobs-view.ts:23`). So the Agents title
// colour is `customMessageLabel` (a tinted secondary, not the primary accent and
// not a grey) and its BUTTONS are `accent`, which is exactly what these views do.
describe('the role table (S13, S16)', () => {
  test('a title takes the Agents view title role and a button the primary accent', () => {
    assert.equal(palette.ROLES.title, 'customMessageLabel',
      'titles use the role the Pi Agents view paints its own title with');
    assert.equal(palette.ROLES.key, 'accent',
      'a button/shortcut key asks for the primary accent');
    assert.notEqual(palette.ROLES.title, palette.ROLES.key,
      'the two levels are different roles, so a title never reads as a button');

    const theme = recordingTheme();
    const paintedTitle = palette.title(theme, 'Odd');
    assert.match(paintedTitle, /\x1b\[1m\x1b\[33mOdd\x1b\[0m\x1b\[22m/,
      'the title is painted with the dim role and emphasized through the theme');
    assert.ok(theme.calls.some((call) => call.role === 'customMessageLabel' && call.text === 'Odd'),
      'the customMessageLabel role is requested from the injected theme');

    theme.calls.length = 0;
    const paintedKey = palette.key(theme, 'esc');
    assert.match(paintedKey, /\x1b\[1m\x1b\[96mesc\x1b\[0m\x1b\[22m/,
      'the key stays primary accent + bold');
    assert.ok(!theme.calls.some((call) => call.role === 'customMessageLabel'),
      'a key never borrows the title role');
  });

  test('ordinary text and the selected row are painted differently', () => {
    assert.equal(palette.ROLES.value, 'text',
      'a live value is the theme normal text role, not the accent');
    const theme = recordingTheme();
    const paintedValue = palette.value(theme, 'alpha');
    assert.match(paintedValue, /\x1b\[39malpha\x1b\[0m/, 'the value takes the text role');
    assert.ok(!theme.calls.some((call) => call.role === 'accent'),
      'a value is never painted with the button role');
    assert.equal(palette.highlight(theme, 'alpha', false), 'alpha',
      'an unfocused row keeps its own paint');
    const selected = palette.highlight(theme, 'alpha', true);
    assert.match(selected, /\x1b\[48;5;60malpha\x1b\[0m/,
      'the selected row is told apart by the theme selected background');
    assert.ok(theme.calls.some((call) => call.role === 'bg:selectedBg'),
      'the selected band asks the theme for selectedBg');
  });

  test('the supporting roles keep one meaning each', () => {
    assert.equal(palette.ROLES.description, 'muted', 'a description is secondary text');
    assert.equal(palette.ROLES.count, 'muted', 'a count is secondary text');
    assert.equal(palette.ROLES.label, 'dim', 'a static label is dim');
    assert.equal(palette.ROLES.border, 'border', 'a rule/divider is the border role');
    assert.equal(palette.ROLES.error, 'error', 'a failure is the error role');
    // The Agents view separates its title from metadata by ROLE, not by weight
    // alone (`TITLE: "customMessageLabel"` versus `META: "dim"`, `KEY_TEXT:
    // "dim"`), so our label keeps plain `dim` while a title takes its own role:
    const theme = recordingTheme();
    assert.match(palette.title(theme, 'Agents'), /\x1b\[1m/, 'a title is bold');
    assert.equal(palette.label(theme, 'Agents'), '\x1b[2mAgents\x1b[0m',
      'a label is the same role without the weight');
  });

  test('every role in the table is a theme role name, never a colour written here', () => {
    for (const [kind, role] of Object.entries(palette.ROLES)) {
      assert.equal(typeof role, 'string', `${kind} names a role`);
      assert.ok(THEME_COLOR_ROLES.has(role), `${kind} → ${role} is a pi theme role name`);
    }
    const source = fs.readFileSync(path.resolve(__dirname, '../lib/tui-paint.js'), 'utf8');
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(source), 'the palette hardcodes no hex colour');
    assert.ok(!/rgb\(|oklch\(|okhsl\(/i.test(source), 'the palette hardcodes no colour function');
    assert.ok(!/\\x1b\[/.test(source), 'the palette emits no escape sequence of its own');
  });
});

describe('a hostile theme never breaks a render', () => {
  function hostileThemes() {
    return [
      null,
      {},
      { fg: () => 42, bold: () => 42, bg: () => 42 },
      {
        fg() { throw new Error('no colour support'); },
        bold() { throw new Error('no bold support'); },
        bg() { throw new Error('no background support'); },
      },
    ];
  }

  test('every entry point degrades to the plain text', () => {
    for (const theme of hostileThemes()) {
      const label = JSON.stringify(theme);
      assert.equal(palette.paint(theme, 'accent', 'x'), 'x', `paint: ${label}`);
      assert.equal(palette.title(theme, 'title'), 'title', `title: ${label}`);
      assert.equal(palette.key(theme, 'esc'), 'esc', `key: ${label}`);
      assert.equal(palette.value(theme, 'v'), 'v', `value: ${label}`);
      assert.equal(palette.description(theme, 'd'), 'd', `description: ${label}`);
      assert.equal(palette.count(theme, '1'), '1', `count: ${label}`);
      assert.equal(palette.label(theme, 'l'), 'l', `label: ${label}`);
      assert.equal(palette.emphasize(theme, 'e'), 'e', `emphasize: ${label}`);
      assert.equal(palette.highlight(theme, 'row', true), 'row', `highlight: ${label}`);
      assert.equal(palette.paint(theme, 'accent', null), '', `paint(null text): ${label}`);
    }
  });
});

describe('painting never changes what fits', () => {
  const measure = (text) => [...strip(text)].length;

  test('a painted legend keeps the plain text measured width and one row', () => {
    const theme = recordingTheme();
    const entries = [
      { key: '↑↓', text: '↑↓ select', short: '↑↓', priority: 60 },
      { key: 'esc', text: 'esc close', short: 'esc close', priority: 100 },
    ];
    const plain = palette.legendRow(null, entries, 40, measure);
    const painted = palette.legendRow(theme, entries, 40, measure);
    assert.equal(measure(painted), measure(plain),
      'the painted row measures exactly like the plain one');
    assert.equal(strip(painted), plain, 'painting only adds escapes');
    assert.ok(measure(painted) <= 40, 'the row still fits the width it was given');
    assert.ok(!painted.includes('\n'), 'the legend stays on ONE row');
  });
});
