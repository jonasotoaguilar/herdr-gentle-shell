'use strict';
// The in-process planner for Herdr's `[theme]` table (theme-sync-fix T2 over
// S3/S4; risk 1, because it rewrites values of the user's own config in place).
//
// What is pinned here, and why each assertion has the shape it has:
//
// - the golden fixture is the user's real config shape (evidence E1: an existing
//   `[theme]` table with `name`, `auto_switch = false` and a `[theme.custom]`
//   synced from DMS/Niri). Its EXACT output bytes are asserted, because "in
//   place" has to mean the user's own lines, order and comments survive;
// - every produced document is parsed with `python3 -I` + `tomllib`: a string
//   comparison cannot prove the file Herdr reads is still valid TOML, and the
//   repository's release preflight already depends on that oracle, so it is not
//   a new dependency;
// - a refusal asserts the three things it promises: `ok: false`, no `text`, and
//   an error that names the line — never a guess;
// - reversibility is asserted across two successive DIFFERENT projections, so
//   "the first original wins" is a fact rather than an intention.
//
// `auto_switch = false` gets its own test because that single line is what makes
// the reference implementation (gentle-herdr lib/herdr-visuals-config.ts:318)
// refuse the user's real config: our planner accepts it and never touches it.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { planThemeConfig } = require('../lib/herdr-theme-config.js');

// The TOML oracle. `-I` isolates the interpreter from site-packages and env so
// the check is the stdlib parser and nothing else.
const ORACLE_READY =
  spawnSync('python3', ['-I', '-c', 'import tomllib'], { encoding: 'utf8', timeout: 20000 }).status === 0;
const ORACLE_SKIP = 'python3 -I with tomllib is unavailable; TOML validity assertions are skipped';

function tomlOf(t, text) {
  if (!ORACLE_READY) {
    t.diagnostic(ORACLE_SKIP);
    return null;
  }
  const parsed = spawnSync(
    'python3',
    ['-I', '-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read(), parse_float=str), default=str))'],
    { input: text, encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(parsed.status, 0, `tomllib rejected the planned document:\n${parsed.stderr}\n--- document ---\n${text}`);
  return JSON.parse(parsed.stdout);
}

// An accepted plan always: returns text, sets `changed` to the byte comparison,
// leaves the input string alone, and produces a document that still parses.
function planned(t, raw, projection) {
  const copy = raw;
  const result = planThemeConfig(copy, projection);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(typeof result.text, 'string');
  assert.equal(result.changed, result.text !== raw);
  assert.equal(copy, raw, 'the planner mutated its input text');
  tomlOf(t, result.text);
  return result;
}

// A plan is idempotent: the same projection over its own output is a no-op with
// `changed: false` and byte-identical text.
function idempotent(t, raw, projection) {
  const first = planned(t, raw, projection);
  assert.deepEqual(planThemeConfig(first.text, projection), { ok: true, text: first.text, changed: false });
  return first;
}

const NAME_ONLY = { name: 'one-dark' };

// The projection from the task: name plus eight custom tokens, five of which the
// user's config does not carry yet.
const GOLDEN_PROJECTION = {
  name: 'one-dark',
  custom: {
    accent: '#bb9af7',
    text: '#c0caf5',
    red: '#ff0000',
    green: '#00ff00',
    subtext0: '#565f89',
    overlay0: '#565f89',
    overlay1: '#a9b1d6',
    mauve: '#7dcfff',
  },
};

// The user's real config shape (evidence E1) — no managed block, its own
// `[theme]`, `auto_switch = false`, a custom table with tokens the projection
// does not carry (`panel_bg`, `blue`, `yellow`) and an unrelated `[terminal]`.
const GOLDEN_INPUT = [
  'onboarding = false',
  '',
  '[theme]',
  'name = "catppuccin"',
  '',
  'auto_switch = false',
  '[theme.custom]',
  '# TokyoNight Night and Moon — synced from DMS/Niri (source: ~/.config/DankMaterialShell/themes/tokyoNightNightMoon/theme.json)',
  'panel_bg = "#1a1b26"',
  'accent = "#7aa2f7"',
  'green = "#9ece6a"',
  'blue = "#7aa2f7"',
  'red = "#f7768e"',
  'yellow = "#e0af68"',
  '',
  '[terminal]',
  'new_cwd = "follow"',
  '',
].join('\n');

const GOLDEN_OUTPUT = [
  'onboarding = false',
  '',
  '[theme]',
  '# herdr-gentle-shell: was name = "catppuccin"',
  'name = "one-dark"',
  '',
  'auto_switch = false',
  '[theme.custom]',
  '# TokyoNight Night and Moon — synced from DMS/Niri (source: ~/.config/DankMaterialShell/themes/tokyoNightNightMoon/theme.json)',
  'panel_bg = "#1a1b26"',
  '# herdr-gentle-shell: was accent = "#7aa2f7"',
  'accent = "#bb9af7"',
  '# herdr-gentle-shell: was green = "#9ece6a"',
  'green = "#00ff00"',
  'blue = "#7aa2f7"',
  '# herdr-gentle-shell: was red = "#f7768e"',
  'red = "#ff0000"',
  'yellow = "#e0af68"',
  '# herdr-gentle-shell: begin',
  'text = "#c0caf5"',
  'subtext0 = "#565f89"',
  'overlay0 = "#565f89"',
  'overlay1 = "#a9b1d6"',
  'mauve = "#7dcfff"',
  '# herdr-gentle-shell: end',
  '',
  '[terminal]',
  'new_cwd = "follow"',
  '',
].join('\n');

describe('golden fixture: the user\'s real config shape', () => {
  test('rewrites only the projected values, in place, and appends absent tokens in token order', (t) => {
    const result = idempotent(t, GOLDEN_INPUT, GOLDEN_PROJECTION);
    assert.equal(result.text, GOLDEN_OUTPUT);
    assert.equal(result.changed, true);
    const parsed = tomlOf(t, result.text);
    if (!parsed) return;
    assert.deepEqual(parsed.theme, {
      name: 'one-dark',
      auto_switch: false,
      custom: {
        panel_bg: '#1a1b26',
        accent: '#bb9af7',
        green: '#00ff00',
        blue: '#7aa2f7',
        red: '#ff0000',
        yellow: '#e0af68',
        text: '#c0caf5',
        subtext0: '#565f89',
        overlay0: '#565f89',
        overlay1: '#a9b1d6',
        mauve: '#7dcfff',
      },
    });
    assert.equal(parsed.onboarding, false);
    assert.deepEqual(parsed.terminal, { new_cwd: 'follow' });
  });

  test('tokens the projection does not carry are never touched', (t) => {
    const result = planned(t, GOLDEN_INPUT, GOLDEN_PROJECTION);
    for (const line of ['panel_bg = "#1a1b26"', 'blue = "#7aa2f7"', 'yellow = "#e0af68"']) {
      assert.ok(result.text.includes(line), `lost a token the projection does not carry: ${line}`);
    }
  });

  test('auto_switch = false is accepted and left byte-exact (the reference refuses it)', (t) => {
    const raw = '[theme]\nname = "catppuccin"\nauto_switch = false\n[theme.custom]\naccent = "#111111"\n';
    const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#222222' } });
    assert.ok(result.text.includes('\nauto_switch = false\n'));
    assert.ok(result.text.includes('# herdr-gentle-shell: was accent = "#111111"\naccent = "#222222"\n'));
    const parsed = tomlOf(t, result.text);
    if (!parsed) return;
    assert.deepEqual(parsed.theme, { name: 'nord', auto_switch: false, custom: { accent: '#222222' } });
  });
});

describe('ownership: only the projected values move', () => {
  test('the theme name is set in place and keeps indentation, spacing and trailing comment', (t) => {
    const raw = '[theme]\n  name  =  "catppuccin"   # mine\n';
    const result = idempotent(t, raw, NAME_ONLY);
    // The marker records the whole original line (minus indentation): spacing
    // and the trailing comment are part of what a restore must give back.
    assert.equal(result.text, '[theme]\n  # herdr-gentle-shell: was name  =  "catppuccin"   # mine\n  name  =  "one-dark"   # mine\n');
  });

  test('a value that already equals the projection changes nothing and adds no comment', (t) => {
    const raw = '[theme]\nname = "one-dark"\n[theme.custom]\naccent = "#bb9af7" # already\n';
    const result = planned(t, raw, { name: 'one-dark', custom: { accent: '#bb9af7' } });
    assert.deepEqual(result, { ok: true, text: raw, changed: false });
  });

  test('a name-only projection leaves an existing [theme.custom] table untouched', () => {
    const raw = '[theme]\nname = "one-dark"\n[theme.custom]\naccent = "#7aa2f7"\npanel_bg = "#000000"\n';
    assert.deepEqual(planThemeConfig(raw, NAME_ONLY), { ok: true, text: raw, changed: false });
  });

  test('every absent token is appended after the last key line in Herdr token order', (t) => {
    const raw = '[theme]\nname = "one-dark"\n[theme.custom]\nblue = "#0000ff"\nyellow = "#ffff00"\n';
    const result = idempotent(t, raw, { name: 'one-dark', custom: { mauve: '#bb9af7', accent: '#7aa2f7', red: '#ff0000' } });
    assert.equal(
      result.text,
      '[theme]\nname = "one-dark"\n[theme.custom]\nblue = "#0000ff"\nyellow = "#ffff00"\n'
        + '# herdr-gentle-shell: begin\naccent = "#7aa2f7"\nred = "#ff0000"\nmauve = "#bb9af7"\n# herdr-gentle-shell: end\n',
    );
  });
});

describe('reversibility: one `was` comment per key, first original wins', () => {
  test('two successive different projections keep exactly one comment with the first original', (t) => {
    const raw = '[theme]\nname = "catppuccin"\n[theme.custom]\naccent = "#7aa2f7"\n';
    const first = planned(t, raw, { name: 'one-dark', custom: { accent: '#111111' } });
    assert.equal(
      first.text,
      '[theme]\n# herdr-gentle-shell: was name = "catppuccin"\nname = "one-dark"\n'
        + '[theme.custom]\n# herdr-gentle-shell: was accent = "#7aa2f7"\naccent = "#111111"\n',
    );
    const second = idempotent(t, first.text, { name: 'nord', custom: { accent: '#222222' } });
    assert.equal(
      second.text,
      '[theme]\n# herdr-gentle-shell: was name = "catppuccin"\nname = "nord"\n'
        + '[theme.custom]\n# herdr-gentle-shell: was accent = "#7aa2f7"\naccent = "#222222"\n',
    );
    const commentLines = second.text.split('\n').filter((line) => line.includes('herdr-gentle-shell: was'));
    assert.deepEqual(commentLines, [
      '# herdr-gentle-shell: was name = "catppuccin"',
      '# herdr-gentle-shell: was accent = "#7aa2f7"',
    ]);
  });

  test('a comment for another key does not count as this key\'s comment', (t) => {
    const raw = '[theme]\nname = "one-dark"\n[theme.custom]\n# herdr-gentle-shell: was text = "#000000"\naccent = "#7aa2f7"\n';
    const result = planned(t, raw, { name: 'one-dark', custom: { accent: '#111111' } });
    assert.equal(
      result.text,
      '[theme]\nname = "one-dark"\n[theme.custom]\n# herdr-gentle-shell: was text = "#000000"\n'
        + '# herdr-gentle-shell: was accent = "#7aa2f7"\naccent = "#111111"\n',
    );
  });
});

describe('missing tables are created at the end of the file', () => {
  test('both tables are appended, theme before theme.custom', (t) => {
    const raw = 'onboarding = false\n';
    const result = idempotent(t, raw, { name: 'one-dark', custom: { accent: '#7aa2f7' } });
    assert.equal(
      result.text,
      'onboarding = false\n[theme]\nname = "one-dark"\n[theme.custom]\n'
        + '# herdr-gentle-shell: begin created\naccent = "#7aa2f7"\n# herdr-gentle-shell: end\n',
    );
  });

  test('an absent [theme] is appended when only the custom table exists', (t) => {
    const raw = '[theme.custom]\naccent = "#7aa2f7"\n';
    const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#7aa2f7' } });
    assert.equal(result.text, '[theme.custom]\naccent = "#7aa2f7"\n[theme]\nname = "nord"\n');
  });

  test('an empty [theme] gets its name right after the header', (t) => {
    const raw = '[theme]\nauto_switch = false\n\n[terminal]\nnew_cwd = "follow"\n';
    const result = idempotent(t, raw, NAME_ONLY);
    assert.equal(
      result.text,
      '[theme]\nname = "one-dark"\nauto_switch = false\n\n[terminal]\nnew_cwd = "follow"\n',
    );
  });

  test('an empty [theme.custom] gets its tokens right after the header', (t) => {
    const raw = '[theme]\nname = "one-dark"\n[theme.custom]\n\n[terminal]\nnew_cwd = "follow"\n';
    const result = idempotent(t, raw, { name: 'one-dark', custom: { accent: '#7aa2f7', text: '#c0caf5' } });
    assert.equal(
      result.text,
      '[theme]\nname = "one-dark"\n[theme.custom]\n# herdr-gentle-shell: begin\naccent = "#7aa2f7"\n'
        + 'text = "#c0caf5"\n# herdr-gentle-shell: end\n\n[terminal]\nnew_cwd = "follow"\n',
    );
  });

  test('an empty document becomes the smallest valid projection', (t) => {
    const result = idempotent(t, '', { name: 'one-dark', custom: { accent: '#7aa2f7' } });
    assert.equal(
      result.text,
      '[theme]\nname = "one-dark"\n[theme.custom]\n# herdr-gentle-shell: begin created\n'
        + 'accent = "#7aa2f7"\n# herdr-gentle-shell: end\n',
    );
  });
});

describe('line endings, final newline and layout are preserved', () => {
  test('CRLF documents gain CRLF insertions only', (t) => {
    const raw = GOLDEN_INPUT.replaceAll('\n', '\r\n');
    const result = idempotent(t, raw, GOLDEN_PROJECTION);
    assert.equal(result.text, GOLDEN_OUTPUT.replaceAll('\n', '\r\n'));
  });

  test('mixed line endings: every insertion uses the ending of the line next to it', (t) => {
    const raw = '[theme]\nname = "catppuccin"\r\n[theme.custom]\r\naccent = "#7aa2f7"\n';
    const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#111111', text: '#c0caf5' } });
    assert.equal(
      result.text,
      '[theme]\n# herdr-gentle-shell: was name = "catppuccin"\r\nname = "nord"\r\n'
        + '[theme.custom]\r\n# herdr-gentle-shell: was accent = "#7aa2f7"\naccent = "#111111"\n'
        + '# herdr-gentle-shell: begin\ntext = "#c0caf5"\n# herdr-gentle-shell: end\n',
    );
  });

  test('a missing final newline stays missing', (t) => {
    const raw = '[theme]\nname = "catppuccin"';
    const result = idempotent(t, raw, NAME_ONLY);
    assert.equal(result.text, '[theme]\n# herdr-gentle-shell: was name = "catppuccin"\nname = "one-dark"');
  });

  test('appending at the end of an unterminated document keeps it unterminated', (t) => {
    const raw = '[theme]\nname = "one-dark"\n[theme.custom]\naccent = "#111111"';
    const result = idempotent(t, raw, { name: 'one-dark', custom: { accent: '#bb9af7', text: '#c0caf5' } });
    assert.equal(
      result.text,
      '[theme]\nname = "one-dark"\n[theme.custom]\n# herdr-gentle-shell: was accent = "#111111"\naccent = "#bb9af7"\n'
        // The end line records that placing the block added the file's missing
        // final line ending, so a later clear can take it back again.
        + '# herdr-gentle-shell: begin\ntext = "#c0caf5"\n# herdr-gentle-shell: end after a missing line ending',
    );
  });

  test('indented headers with trailing comments count as the same tables', (t) => {
    const raw = ' \t[theme] # base\nname = "catppuccin"\n\t[theme.custom] # colors\naccent = "#111111"\n';
    const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#222222' } });
    assert.equal(
      result.text,
      ' \t[theme] # base\n# herdr-gentle-shell: was name = "catppuccin"\nname = "nord"\n'
        + '\t[theme.custom] # colors\n# herdr-gentle-shell: was accent = "#111111"\naccent = "#222222"\n',
    );
  });

  // Recognising a quoted spelling is what fixes the 1.8.0 bug from 61b35ca: the
  // writer must edit the table the user wrote instead of appending a duplicate.
  // A quoted segment is ONE literal segment, so `["theme"]` is `[theme]` while
  // `["theme.custom"]` is a DIFFERENT root key named "theme.custom" and must not
  // be touched (splitting the dot there edited an unrelated table).
  for (const [spelling, raw] of [
    ['["theme"]', '["theme"]\nname = "catppuccin"\n[theme.custom]\naccent = "#111111"\n'],
    ["['theme']", "['theme']\nname = \"catppuccin\"\n[theme.custom]\naccent = \"#111111\"\n"],
  ]) {
    test(`quoted table spelling ${spelling} is the same table`, (t) => {
      const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#222222' } });
      assert.equal(result.text.split('\n').filter((line) => line.includes('herdr-gentle-shell: was')).length, 2);
      assert.equal(result.text.includes(spelling), true, 'the quoted header was rewritten');
      const parsed = tomlOf(t, result.text);
      if (parsed) assert.deepEqual(parsed.theme, { name: 'nord', custom: { accent: '#222222' } });
    });
  }

  test('["theme.custom"] is a literal key, not our table', (t) => {
    const raw = '[theme]\nname = "catppuccin"\n["theme.custom"]\naccent = "#111111"\n';
    const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#222222' } });
    assert.ok(result.text.includes('["theme.custom"]\naccent = "#111111"\n'), 'the literal table was edited');
    const parsed = tomlOf(t, result.text);
    if (!parsed) return;
    assert.deepEqual(parsed['theme.custom'], { accent: '#111111' });
    assert.deepEqual(parsed.theme.custom, { accent: '#222222' });
  });
});

describe('the 1.8.0 managed block migrates to ordinary config', () => {
  test('exactly the two marker lines are dropped and the body is edited in place', (t) => {
    const raw = [
      'onboarding = false',
      '',
      '# BEGIN herdr-gentle-theme (managed; do not edit)',
      '[theme]',
      'name = "catppuccin"',
      '[theme.custom]',
      'accent = "#7aa2f7"',
      '# END herdr-gentle-theme',
      '',
      '[terminal]',
      'new_cwd = "follow"',
      '',
    ].join('\n');
    const result = idempotent(t, raw, { name: 'one-dark', custom: { accent: '#bb9af7' } });
    assert.equal(
      result.text,
      [
        'onboarding = false',
        '',
        '[theme]',
        '# herdr-gentle-shell: was name = "catppuccin"',
        'name = "one-dark"',
        '[theme.custom]',
        '# herdr-gentle-shell: was accent = "#7aa2f7"',
        'accent = "#bb9af7"',
        '',
        '[terminal]',
        'new_cwd = "follow"',
        '',
      ].join('\n'),
    );
    assert.equal(result.text.includes('herdr-gentle-theme'), false);
    const parsed = tomlOf(t, result.text);
    if (!parsed) return;
    assert.deepEqual(parsed.theme, { name: 'one-dark', custom: { accent: '#bb9af7' } });
  });
});

describe('fail closed, naming the line: never a guess', () => {
  const CASES = [
    ['theme = "embedded"\n', /^line 1: .*top-level `theme` key/],
    ['theme = []\n', /^line 1: .*top-level `theme` key/],
    ['[theme]\ncustom = { accent = "#ff0000" }\n', /^line 2: .*`custom` in `\[theme\]`/],
    ['[theme]\nauto_switch = true\n', /^line 2: .*`auto_switch` is only supported as `auto_switch = false`/],
    ['[theme]\nauto_switch = "false"\n', /^line 2: .*`auto_switch`/],
    ['[theme]\ndark_name = "nord"\n', /^line 2: .*`dark_name`/],
    ['[theme]\nlight_name = "nord"\n', /^line 2: .*`light_name`/],
    ['theme.custom.accent = "#ff0000"\n', /^line 1: .*dotted `theme` key/],
    ['[theme]\nname = "a"\nname = "b"\n', /^line 3: .*`name` appears more than once/],
    ['[theme.custom]\naccent = "#111111"\naccent = "#222222"\n', /^line 3: .*`accent` appears more than once/],
    ['[theme]\nname = "catppuccin"\n[theme]\nname = "nord"\n', /^line 3: .*`\[theme\]` appears more than once/],
    [
      '[theme.custom]\naccent = "#111111"\n[theme.custom]\naccent = "#222222"\n',
      /^line 3: .*`\[theme.custom\]` appears more than once/,
    ],
    ['[[theme]]\nname = "nord"\n', /^line 1: .*`\[\[theme\]\]` array-of-tables/],
    ['[[theme.custom]]\naccent = "#111111"\n', /^line 1: .*`\[\[theme.custom\]\]` array-of-tables/],
    ['[theme.light]\nname = "nord"\n', /^line 1: .*`\[theme.light\]` is not a table this writer owns/],
    ['[theme.custom.light]\naccent = "#111111"\n', /^line 1: .*`\[theme.custom.light\]` is not a table this writer owns/],
    ['[theme]\nname = 42\n', /^line 2: .*`name` value is not a plain single-line string/],
    ['[theme.custom]\naccent = ["#111111"]\n', /^line 2: .*`accent` value is not a plain single-line string/],
    ['[theme.custom]\naccent = "#111"\raccent2 = "#222"\n', /^line 2: .*carriage return/],
    ['other = [1, 2\n[theme]\nname = "nord"\n', /^line 1: .*array/],
    ['[theme]\nname = "nord"\n[theme.custom]\naccent = "#111111" # fine\nother = { a = 1\n', /^line 5: .*unterminated array or inline table/],
    ['other = """never closed\n[theme]\nname = "nord"\n', /^line 1: .*unterminated string/],
    ['[theme\nname = "nord"\n', /^line 1: .*unterminated table header/],
  ];

  for (const [raw, pattern] of CASES) {
    test(`refuses ${JSON.stringify(raw)}`, () => {
      const result = planThemeConfig(raw, GOLDEN_PROJECTION);
      assert.equal(result.ok, false, `expected a refusal for:\n${raw}`);
      assert.equal('text' in result, false);
      assert.match(result.error, pattern);
    });
  }

  test('refuses a raw control character', () => {
    const result = planThemeConfig('x = 1\u0000\n[theme]\nname = "nord"\n', GOLDEN_PROJECTION);
    assert.equal(result.ok, false);
    assert.match(result.error, /^line 1: .*control character/);
  });

  test('refusals leave the document bytes out of the result entirely', () => {
    for (const raw of ['theme = "x"\n', '[theme]\nauto_switch = true\n', 'other = [1\n[theme]\nname = "x"\n']) {
      const result = planThemeConfig(raw, GOLDEN_PROJECTION);
      assert.equal(result.ok, false);
      assert.doesNotMatch(JSON.stringify(result), /one-dark/);
    }
  });
});

describe('just enough TOML to not be fooled', () => {
  test('multi-line strings and arrays elsewhere are understood, not rewritten', (t) => {
    const raw = [
      'note = """line one',
      'line two # not a comment"""',
      '',
      '[other]',
      'list = [',
      '  1,',
      '  2,',
      ']',
      '',
      '[theme]',
      'name = "catppuccin"',
      '',
    ].join('\n');
    const result = idempotent(t, raw, NAME_ONLY);
    assert.ok(result.text.startsWith('note = """line one\nline two # not a comment"""\n\n[other]\nlist = [\n  1,\n  2,\n]\n\n[theme]\n'));
  });

  test('a comment containing a bracket or an equals does not confuse the scan', (t) => {
    const raw = '# [theme] name = "nope" [ unexplained\n[theme]\nname = "catppuccin"\n# accent = "#111111"\n';
    const result = idempotent(t, raw, NAME_ONLY);
    assert.equal(result.text, '# [theme] name = "nope" [ unexplained\n[theme]\n'
      + '# herdr-gentle-shell: was name = "catppuccin"\nname = "one-dark"\n# accent = "#111111"\n');
  });

  test('an escaped value is decoded, a multi-line value is refused', (t) => {
    const escaped = planned(t, '[theme.custom]\naccent = "\\u0023ff0000"\n', { name: 'one-dark', custom: { accent: '#bb9af7' } });
    assert.equal(
      escaped.text,
      '[theme.custom]\n# herdr-gentle-shell: was accent = "\\u0023ff0000"\naccent = "#bb9af7"\n[theme]\nname = "one-dark"\n',
    );
    const multi = planThemeConfig('[theme.custom]\naccent = [\n  "#111111",\n]\n', { name: 'one-dark', custom: { accent: '#bb9af7' } });
    assert.equal(multi.ok, false);
    assert.match(multi.error, /^line 2: /);
  });

  test('a dotted theme key under another table is somebody else\'s setting', (t) => {
    const raw = '[other]\ntheme.custom.accent = "#ff0000"\n[theme]\nname = "nord"\n';
    const result = planned(t, raw, NAME_ONLY);
    assert.ok(result.text.includes('[other]\ntheme.custom.accent = "#ff0000"\n'));
    assert.equal(result.text.split('\n').filter((line) => line.includes('herdr-gentle-shell: was')).length, 1);
  });

  test('literal single-quoted values are understood', (t) => {
    const raw = "[theme]\nname = 'catppuccin'\n";
    const result = idempotent(t, raw, NAME_ONLY);
    assert.equal(result.text, '[theme]\n# herdr-gentle-shell: was name = \'catppuccin\'\nname = "one-dark"\n');
    const parsed = tomlOf(t, result.text);
    if (!parsed) return;
    assert.equal(parsed.theme.name, 'one-dark');
  });

  test('quoted keys are the same keys', (t) => {
    const raw = '[theme]\n"name" = "catppuccin"\n[theme.custom]\n\'accent\' = "#111111"\n';
    const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#222222' } });
    assert.equal(
      result.text,
      '[theme]\n# herdr-gentle-shell: was "name" = "catppuccin"\n"name" = "nord"\n'
        + '[theme.custom]\n# herdr-gentle-shell: was \'accent\' = "#111111"\n\'accent\' = "#222222"\n',
    );
    const parsed = tomlOf(t, result.text);
    if (!parsed) return;
    assert.deepEqual(parsed.theme, { name: 'nord', custom: { accent: '#222222' } });
  });

  test('bare carriage returns are refused, CRLF is not', () => {
    assert.match(planThemeConfig('[theme]\rname = "x"\n', NAME_ONLY).error, /^line 1: .*carriage return/);
    assert.equal(planThemeConfig('[theme]\r\nname = "x"\r\n', NAME_ONLY).ok, true);
  });
});

describe('projection validation', () => {
  const INVALID = [
    [null, /expected an object/],
    [{}, /theme name/],
    [{ name: 'gentle' }, /not a Herdr native theme/],
    [{ name: 'one-dark', extra: true }, /unknown key/],
    [{ name: 'one-dark', custom: { surprise: '#123456' } }, /not a Herdr theme token/],
    [{ name: 'one-dark', custom: { accent: '#fff' } }, /not #rrggbb/],
    [{ name: 'one-dark', custom: { accent: 'red' } }, /not #rrggbb/],
    [{ name: 'one-dark', custom: [] }, /custom/],
  ];

  for (const [projection, pattern] of INVALID) {
    test(`rejects ${JSON.stringify(projection)}`, () => {
      const result = planThemeConfig('[theme]\nname = "catppuccin"\n', projection);
      assert.equal(result.ok, false);
      assert.match(result.error, pattern);
      assert.equal('text' in result, false);
    });
  }

  test('accepts every documented Herdr native theme', (t) => {
    const { HERDR_BASE_THEMES } = require('../lib/theme-projection.js');
    assert.equal(HERDR_BASE_THEMES.length, 11);
    for (const name of HERDR_BASE_THEMES) {
      const result = idempotent(t, '[theme]\nname = "catppuccin"\n', { name });
      const parsed = tomlOf(t, result.text);
      if (parsed) assert.equal(parsed.theme.name, name);
    }
  });
});
