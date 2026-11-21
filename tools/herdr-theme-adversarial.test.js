'use strict';
// Adversarial regression suite for the in-process Herdr theme writer
// (theme-sync-fix correction pass, T2 over S3/S4; risk 1 — it rewrites values of
// the user's own config in place).
//
// This file exists because string equality is not proof: every accepted plan is
// ALSO parsed by `python3 -I` + `tomllib` (the repository's release preflight
// already depends on that tool), and the parse must agree with the input on
// every table the writer does not own. The cases below are the ones an
// independent verifier used to break the first version:
//
//   P1  a CRLF file whose last line has no final newline must not gain a lone CR
//   P2  a quoted key is ONE literal segment: ["theme.custom"] is not our table
//   P3  the 1.8.0 markers are only dropped around an actual [theme] header
//   P4  documents that are not valid TOML are refused, with the line number
//   P5  valid TOML a real user can have is never a false refusal
//   P6  the `was` marker is found anywhere in the comment block above the key
//   P7  `custom: undefined` is "no custom tokens", not a TypeError
//   STALE TOKENS  leaving a projection restores what it owned (no leftovers)
//   W1..W7  the writer's temp file, backup, CAS window, BOM, size, mode and
//           forceReload contract
//
// The W3 case asserts only what rename-based writing can guarantee: an edit that
// lands BEFORE the final compare is detected and leaves no staging file. An edit
// that lands after that compare and before the rename is undetectable without
// locking the file, which this writer deliberately does not do; that limit is
// stated in the module, not pretended away here.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planThemeConfig, opaqueLines, spliceInvariant } = require('../lib/herdr-theme-config.js');
const { applyHerdrTheme } = require('../lib/herdr-theme-apply.js');

const ORACLE_READY =
  spawnSync('python3', ['-I', '-c', 'import tomllib'], { encoding: 'utf8', timeout: 20000 }).status === 0;
const ORACLE_SKIP = 'python3 -I with tomllib is unavailable; TOML validity assertions are skipped';

const stripBom = (text) => text.replace(/^\uFEFF/, '');

function parseToml(t, text) {
  if (!ORACLE_READY) {
    t.diagnostic(ORACLE_SKIP);
    return null;
  }
  const parsed = spawnSync(
    'python3',
    ['-I', '-c', 'import sys,json,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read(), parse_float=str), default=str))'],
    { input: stripBom(text), encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(parsed.status, 0, `tomllib rejected the document:\n${parsed.stderr}\n--- document ---\n${text}`);
  return JSON.parse(parsed.stdout);
}

// An accepted plan: the document must still parse, and every table the writer
// does not own must be byte-semantically identical to the input's.
function accepted(t, raw, projection) {
  const result = planThemeConfig(raw, projection);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, result.text !== raw);
  const after = parseToml(t, result.text);
  const before = parseToml(t, raw);
  if (after && before) {
    for (const [key, value] of Object.entries(before)) {
      if (key === 'theme') continue;
      assert.deepEqual(after[key], value, `the writer changed the unowned table \`${key}\``);
    }
  }
  return result;
}

function refused(t, raw, projection, pattern) {
  const result = planThemeConfig(raw, projection);
  assert.equal(result.ok, false, `expected a refusal for:\n${raw}`);
  assert.equal('text' in result, false);
  assert.match(result.error, pattern);
  return result;
}

function idempotent(t, raw, projection) {
  const first = accepted(t, raw, projection);
  assert.deepEqual(planThemeConfig(first.text, projection), { ok: true, text: first.text, changed: false });
  return first;
}

const ONE_DARK = { name: 'one-dark' };

/* --------------------------------------------------------------- P1 / P2 */

describe('P1: no stray carriage return at the end of a CRLF file', () => {
  test('appending a name after a CRLF [theme] without a final newline ends cleanly', (t) => {
    const raw = '# c\r\n[theme]';
    const result = accepted(t, raw, ONE_DARK);
    assert.equal(result.text, '# c\r\n[theme]\r\nname = "one-dark"');
    assert.equal(/\r(?!\n)/.test(result.text), false, 'the output contains a bare CR');
    assert.equal(result.text.includes('\n\n'), false);
    idempotent(t, raw, ONE_DARK);
  });

  test('the same shape with a projected token stays CRLF throughout', (t) => {
    const raw = '# c\r\n[theme]\r\nname = "nord"\r\n[theme.custom]';
    const result = accepted(t, raw, { name: 'one-dark', custom: { accent: '#112233' } });
    assert.equal(/\r(?<!\r\n?)/.test(result.text.replace(/\r\n/g, '\n')), false);
    assert.equal(/(^|[^\r])\n/.test(result.text), false, 'a bare LF appeared in a CRLF document');
    idempotent(t, raw, { name: 'one-dark', custom: { accent: '#112233' } });
  });
});

describe('P2: a quoted key is one literal segment', () => {
  test('["theme.custom"] is not our [theme.custom] and is never edited', (t) => {
    const raw = '["theme.custom"]\naccent = "#123456"\n[theme]\nname = "nord"\n';
    const result = accepted(t, raw, { name: 'one-dark', custom: { accent: '#112233' } });
    assert.ok(result.text.startsWith('["theme.custom"]\naccent = "#123456"\n'), 'the literal table was edited');
    assert.equal(result.text.includes('herdr-gentle-shell: begin'), true);
    const parsed = parseToml(t, result.text);
    if (parsed) {
      // TOML says the quoted header is a root key named "theme.custom": the
      // projection must not have touched it, and our table is a separate one.
      assert.deepEqual(parsed['theme.custom'], { accent: '#123456' });
      assert.deepEqual(parsed.theme, { name: 'one-dark', custom: { accent: '#112233' } });
    }
  });

  test('a literal ["theme.custom"] before [theme.custom] is not a duplicate header', (t) => {
    const raw = '["theme.custom"]\naccent = "#123456"\n[theme.custom]\naccent = "#654321"\n[theme]\nname = "nord"\n';
    const result = idempotent(t, raw, { name: 'nord', custom: { accent: '#112233' } });
    assert.ok(result.text.includes('["theme.custom"]\naccent = "#123456"\n'));
    assert.ok(result.text.includes('[theme.custom]\n# herdr-gentle-shell: was accent = "#654321"\naccent = "#112233"\n'));
  });

  test('"theme.accent" = 1 is a literal key, not a dotted theme key', (t) => {
    const raw = '"theme.accent" = 1\n[theme]\nname = "nord"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.ok(result.text.startsWith('"theme.accent" = 1\n'));
  });

  test('a quoted key with a \\uXXXX escape is the same key', (t) => {
    const raw = '[theme]\n"nam\\u0065" = "catppuccin"\n';
    const result = accepted(t, raw, ONE_DARK);
    // The marker stores the WHOLE original line, so the quoted spelling and its
    // escape come back verbatim.
    assert.equal(result.text, '[theme]\n# herdr-gentle-shell: was "nam\\u0065" = "catppuccin"\n"nam\\u0065" = "one-dark"\n');
  });
});

/* ------------------------------------------------------------------- P3 */

describe('P3: legacy markers are only dropped around a theme table', () => {
  test('a pair that wraps a [theme] table is migrated', (t) => {
    const raw = '# BEGIN herdr-gentle-theme (managed; do not edit)\n[theme]\nname = "nord"\n# END herdr-gentle-theme\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.equal(result.text.includes('herdr-gentle-theme'), false);
  });

  test('a pair that wraps unrelated keys is preserved byte for byte', (t) => {
    const raw = '# BEGIN herdr-gentle-theme (managed; do not edit)\n[ui]\nrows = 2\n# END herdr-gentle-theme\n[theme]\nname = "one-dark"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.equal(result.text, raw);
    assert.equal(result.changed, false);
  });
});

/* ------------------------------------------------------------------- P4 */

describe('opaque: non-theme lines are never judged and never changed', () => {
  // Invalid TOML outside the theme tables is the user's pre-existing breakage
  // (Herdr already refuses such a file). The contract is: refuse, or leave every
  // non-theme line byte for byte — never a third thing.
  const WEIRD = [
    'x=',
    'x = 1 extra',
    'x = [1 2]',
    'x = {a=1,a=2}',
    'x = "\\q"',
    '"\\uD800" = 1',
    'x = 1\nx.y = 2',
    'x = {}\n[ui.x]\ny = 1',
    'x = [1,,2]',
    'x = {a=1,}',
    'x = 2025-02-29',
    'x = 2024-02-29T12:00:00+24:00',
    'x = 12:00:00Z',
    'x = 01',
    '[ui]\u00a0',
    '[[ui]]',
    '[ui]\nsidebar.agents = true\n[ui.sidebar]',
    'this line is not a key value pair',
    "x = 'unterminated",
    'x = """never closed',
    '[ui]\nrows = [1,\n  2\n',
  ];

  for (const body of WEIRD) {
    test(`non-theme bytes survive ${JSON.stringify(body)}`, () => {
      const raw = `[terminal]\n${body}\n`;
      const result = planThemeConfig(raw, F);
      if (result.ok) {
        assert.equal(spliceInvariant(raw, result.text), true, `non-theme lines changed:\n${raw}\n---\n${result.text}`);
        assert.ok(result.text.startsWith(raw), 'the prefix was rewritten');
      }
    });
  }

  test('valid non-theme TOML is untouched too', (t) => {
    const bodies = [
      'a = 1_000', 'b = 0x1f', 'c = 0o755', 'd = 0b1010', 'e = 1.5e-3', 'f = -inf', 'g = nan', 'g2 = -17',
      'h = 1979-05-27T07:32:00Z', 'i = 1979-05-27 07:32:00.999-07:00', 'j = 07:32:00',
      'k = true', 'l = "a\\tb\\u00e9\\U0001F600"', "m = 'literal \\ text'", 'n = [\n  1, # one\n  2,\n]',
      'o = { a = 1, b = { c = 2 } }', 'p = """multi\nline"""', "q = '''literal\nmulti'''",
      '"a.b" = 1\na.b = 2', '[[x]]\n[x.y]\nv = 1\n[[x]]\n[x.y]\nv = 2', '# a\u2028b\u2029c\u0085d',
    ];
    for (const body of bodies) {
      const raw = `[ui]\n${body}\n[theme]\nname = "one-dark"\n`;
      const result = planThemeConfig(raw, E);
      assert.equal(result.ok, true, `${JSON.stringify(body)} -> ${result.error}`);
      assert.equal(result.text, raw, `${JSON.stringify(body)} was not preserved`);
      parseToml(t, result.text);
    }
  });

  test('the splice invariant helper catches a corrupted splice', () => {
    const before = '[terminal]\nnew_cwd = "follow"\n';
    assert.equal(spliceInvariant(before, before), true);
    assert.equal(spliceInvariant(before, '[terminal]\nnew_cwd = "other"\n'), false);
    assert.equal(spliceInvariant(before, '# inserted\n[terminal]\nnew_cwd = "follow"\n'), false);
    // An EOL change on a non-final opaque line is a splice too.
    assert.equal(spliceInvariant('[ui]\r\nx = 1\r\n', '[ui]\nx = 1\n'), false);
    // The single permitted change: one terminator for an unterminated last line.
    assert.equal(spliceInvariant('[ui]\nmouse = true', '[ui]\nmouse = true\n[theme]\nname = "one-dark"\n'), true);
    // Theme-table lines are outside the guarantee, so they may differ.
    assert.equal(spliceInvariant('[theme]\nname = "a"\n', '[theme]\nname = "b"\n'), true);
    // An unseen extra opaque line is not.
    assert.equal(spliceInvariant('[terminal]\nx = 1\n', '[terminal]\nx = 1\ny = 2\n'), false);
  });
});

/* ------------------------------------------------------------------- P5 */

describe('P5: valid TOML a real user can have is accepted', () => {
  test('a trailing comment on the last line without a final newline', (t) => {
    const cases = [
      ['[theme]\nauto_switch = false # fine', ONE_DARK, 'claim'],
      ['[theme]\nname="nord" # keep', ONE_DARK, 'claim'],
      ['[theme]\nname="nord"\n[theme.custom]\naccent="#123456" # keep', { name: 'nord', custom: { accent: '#112233' } }, 'claim'],
    ];
    for (const [raw, projection] of cases) {
      const result = accepted(t, raw, projection);
      assert.equal(result.text.endsWith('# keep') || result.text.endsWith('# fine'), true, JSON.stringify(result.text));
    }
  });

  test('a key named theme inside another table is not a top-level theme key', (t) => {
    const raw = '[ui]\ntheme="system"\n[theme]\nname = "nord"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.ok(result.text.includes('[ui]\ntheme="system"\n'));
  });

  test('an unquoted dotted key outside the theme tables is preserved', (t) => {
    const raw = '[other]\ntheme.custom.accent = "#123456"\n[theme]\nname = "nord"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.ok(result.text.includes('theme.custom.accent = "#123456"\n'));
  });

  test('a BOM is accepted, skipped while scanning and preserved in the output', (t) => {
    const raw = '\uFEFF[theme]\nname = "nord"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.equal(result.text, '\uFEFF[theme]\n# herdr-gentle-shell: was name = "nord"\nname = "one-dark"\n');
  });

  test('an escaped quote inside a basic-string value is scanned, not refused', (t) => {
    const raw = '[theme]\nname = "a\\"b"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.equal(result.text, '[theme]\n# herdr-gentle-shell: was name = "a\\"b"\nname = "one-dark"\n');
  });
});

/* ------------------------------------------------------------------- P6 */

describe('P6: the was-marker is found anywhere in the comment block above the key', () => {
  test('a user comment between the marker and the key does not add a second marker', (t) => {
    const raw = '[theme]\n# herdr-gentle-shell: was name = "catppuccin"\n# mine, keep above\nname = "nord"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.equal(result.text, '[theme]\n# herdr-gentle-shell: was name = "catppuccin"\n# mine, keep above\nname = "one-dark"\n');
    assert.equal(result.text.split('herdr-gentle-shell: was').length - 1, 1);
  });

  test('a marker that does not match the strict pattern is an ordinary comment', (t) => {
    const raw = '[theme]\n# herdr-gentle-shell: was name\nname = "nord"\n';
    const result = accepted(t, raw, ONE_DARK);
    assert.equal(
      result.text,
      '[theme]\n# herdr-gentle-shell: was name\n# herdr-gentle-shell: was name = "nord"\nname = "one-dark"\n',
    );
  });
});

/* ------------------------------------------------------------------- P7 */

describe('P7: undefined custom', () => {
  test('treats custom: undefined as no custom tokens', (t) => {
    const raw = '[theme]\nname = "nord"\n';
    const result = accepted(t, raw, { name: 'one-dark', custom: undefined });
    assert.equal(result.text, '[theme]\n# herdr-gentle-shell: was name = "nord"\nname = "one-dark"\n');
  });
});

/* ----------------------------------------------------------- stale tokens */

const SEXY = {
  name: 'catppuccin',
  custom: {
    panel_bg: '#06080f',
    active_row_bg: '#2E0F1F',
    selection_bg: '#2E0F1F',
    accent: '#112233',
    text: '#F6EFF3',
    red: '#FF718F',
    green: '#B4E7C7',
    subtext0: '#FF4F9A',
    overlay0: '#B99AA9',
    overlay1: '#B99AA9',
    mauve: '#B99AA9',
  },
};
const PLAIN = { name: 'tokyo-night', custom: { accent: '#112233' } };

describe('stale tokens: leaving a projection cleans up what it owned', () => {
  test('Gentleman-Sexy then a plain theme restores the user palette', (t) => {
    const raw = '[theme]\nname="terminal"\n[theme.custom]\npanel_bg="#123456"\n';
    const first = accepted(t, raw, SEXY);
    assert.ok(first.text.includes('# herdr-gentle-shell: was panel_bg="#123456"\npanel_bg="#06080f"\n'));
    assert.ok(first.text.includes('# herdr-gentle-shell: begin\n'));
    const second = accepted(t, first.text, PLAIN);
    // The token the user owned is restored byte for byte and its marker is gone.
    assert.ok(second.text.includes('[theme.custom]\npanel_bg="#123456"\n'), JSON.stringify(second.text));
    assert.equal(second.text.includes('was panel_bg'), false);
    // Everything our block used to add but the new projection does not want is gone.
    for (const gone of ['active_row_bg', 'selection_bg', 'text', 'red', 'green', 'subtext0', 'overlay0', 'overlay1', 'mauve']) {
      assert.equal(new RegExp(`^${gone} = `, 'm').test(second.text), false, `${gone} survived the projection change`);
    }
    assert.ok(second.text.includes('# herdr-gentle-shell: begin\naccent = "#112233"\n# herdr-gentle-shell: end\n'));
    assert.deepEqual(parseToml(t, second.text).theme.custom, { panel_bg: '#123456', accent: '#112233' });
    idempotent(t, second.text, PLAIN);
  });

  test('the block disappears entirely when the projection has no custom tokens', (t) => {
    const raw = '[theme]\nname = "terminal"\n';
    const first = accepted(t, raw, { name: 'one-dark', custom: { accent: '#112233' } });
    const second = accepted(t, first.text, ONE_DARK);
    // The header was created by this planner (`begin created`), so a cycle back
    // to the original document removes it: byte-identical reversibility.
    assert.equal(second.text, '[theme]\n# herdr-gentle-shell: was name = "terminal"\nname = "one-dark"\n');
    assert.equal(second.text.includes('begin'), false);
    assert.equal(second.text.includes('accent'), false);
    assert.deepEqual(parseToml(t, second.text).theme, { name: 'one-dark' });
  });

  test('a user token with no marker is never touched, even when the projection drops it', (t) => {
    const raw = '[theme]\nname = "nord"\n[theme.custom]\npanel_bg = "#123456"\nblue = "#333333"\n';
    const result = accepted(t, raw, { name: 'one-dark', custom: { accent: '#112233' } });
    assert.ok(result.text.includes('panel_bg = "#123456"\nblue = "#333333"\n'));
    assert.equal(result.text.includes('was panel_bg'), false);
  });

  test('an owned token keeps one marker across three projections', (t) => {
    const raw = '[theme.custom]\naccent = "#7aa2f7"\n[theme]\nname = "one-dark"\n';
    const a = accepted(t, raw, { name: 'one-dark', custom: { accent: '#111111' } });
    const b = accepted(t, a.text, { name: 'one-dark', custom: { accent: '#222222' } });
    const c = accepted(t, b.text, { name: 'one-dark' });
    assert.equal(
      c.text,
      '[theme.custom]\n# herdr-gentle-shell: was accent = "#7aa2f7"\naccent = "#7aa2f7"\n[theme]\nname = "one-dark"\n'
        .replace('# herdr-gentle-shell: was accent = "#7aa2f7"\n', ''),
    );
    assert.equal(c.text.includes('herdr-gentle-shell: was'), false);
    assert.deepEqual(parseToml(t, c.text).theme.custom, { accent: '#7aa2f7' });
  });

  test('a token in our block AND as a user key is a refused duplicate', (t) => {
    // Two `accent` keys in one table is not valid TOML: Herdr could never read
    // that file, so the planner refuses it instead of picking a winner. A user
    // who wants to own the token deletes our block line, which is what a real
    // edit of this file looks like.
    const raw = '[theme.custom]\n# herdr-gentle-shell: begin\naccent = "#112233"\n# herdr-gentle-shell: end\naccent = "#445566"\n'
      + '[theme]\nname = "one-dark"\n';
    refused(t, raw, { name: 'one-dark', custom: { accent: '#112233' } }, /^line 5: .*`accent` appears more than once/);
  });

  test('a user key beside our block makes the block drop its own copy', (t) => {
    const raw = '[theme.custom]\n# herdr-gentle-shell: begin\ntext = "#c0caf5"\n# herdr-gentle-shell: end\naccent = "#445566"\n'
      + '[theme]\nname = "one-dark"\n';
    const result = accepted(t, raw, { name: 'one-dark', custom: { accent: '#112233', text: '#c0caf5' } });
    // The block is left where it already is (its content is unchanged); only a
    // block that has to be REWRITTEN is placed at the end of the table.
    assert.equal(
      result.text,
      '[theme.custom]\n# herdr-gentle-shell: begin\ntext = "#c0caf5"\n# herdr-gentle-shell: end\n'
        + '# herdr-gentle-shell: was accent = "#445566"\naccent = "#112233"\n[theme]\nname = "one-dark"\n',
    );
    assert.deepEqual(parseToml(t, result.text).theme.custom, { accent: '#112233', text: '#c0caf5' });
    idempotent(t, result.text, { name: 'one-dark', custom: { accent: '#112233', text: '#c0caf5' } });
  });
});

/* --------------------------------------------------------------- W1..W7 */

const PROJECTION = { name: 'one-dark', custom: { accent: '#bb9af7' } };
const CONFIG = '[theme]\nname = "catppuccin"\n[theme.custom]\npanel_bg = "#1a1b26"\n';
const FAKE_HERDR = ['#!/bin/sh', 'printf \'%s\\n\' "$@" > "$HERDR_ARGV_LOG"', 'exit "${HERDR_FAKE_EXIT:-0}"', ''].join('\n');

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-theme-adversarial-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'herdr');
  fs.writeFileSync(bin, FAKE_HERDR, { mode: 0o755 });
  const configPath = path.join(root, 'config.toml');
  const config = options.config ?? CONFIG;
  fs.writeFileSync(configPath, config, { mode: options.mode ?? 0o640 });
  const logPath = path.join(root, 'herdr-argv.log');
  const env = {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_SOCKET_PATH: path.join(root, 'herdr.sock'),
    HERDR_BIN_PATH: bin,
    HERDR_CONFIG_PATH: configPath,
    HERDR_ARGV_LOG: logPath,
  };
  const staged = () => fs.readdirSync(root).filter((name) => name.endsWith('.tmp'));
  return {
    root,
    bin,
    configPath,
    env,
    bytes: () => fs.readFileSync(configPath, 'utf8'),
    rawBytes: () => fs.readFileSync(configPath),
    backupPath: `${configPath}.herdr-gentle-shell.bak`,
    argv: () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : null),
    staged,
  };
}

const run = (config, projection = PROJECTION, extra = {}) =>
  applyHerdrTheme({ projection, env: config.env, platform: 'linux', ...extra });

describe('W1: a failed staging never leaves a temp file beside the config', () => {
  test('a rename failure removes the staged temp file', async (t) => {
    const config = fixture(t);
    t.mock.method(fs, 'renameSync', () => {
      throw new Error('controlled rename failure');
    });
    const result = await run(config);
    assert.deepEqual(result, { status: 'partial', stage: 'config', error: 'controlled rename failure' });
    assert.equal(config.bytes(), CONFIG);
    assert.deepEqual(config.staged(), []);
    assert.deepEqual(fs.readdirSync(config.root).sort(), ['config.toml', 'config.toml.herdr-gentle-shell.bak', 'herdr']);
    assert.equal(config.argv(), null);
  });
});

describe('W2: the backup is published atomically and never half-written', () => {
  test('a mid-write ENOSPC leaves no backup at all', async (t) => {
    const config = fixture(t);
    const realWriteFileSync = fs.writeFileSync;
    let fdWrites = 0;
    t.mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (typeof target === 'number') {
        fdWrites += 1;
        if (fdWrites === 1) {
          const error = new Error('ENOSPC: no space left on device, write');
          error.code = 'ENOSPC';
          throw error;
        }
      }
      return realWriteFileSync(target, ...rest);
    });
    const result = await run(config);
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.match(result.error, /ENOSPC/);
    assert.equal(fs.existsSync(config.backupPath), false, 'a truncated backup was published');
    assert.deepEqual(config.staged(), []);
    assert.equal(config.bytes(), CONFIG);
    assert.equal(config.argv(), null);
  });

  test('an existing backup is never overwritten, and must be a regular file', async (t) => {
    const config = fixture(t);
    fs.writeFileSync(config.backupPath, 'the one true original\n');
    assert.deepEqual(await run(config), { status: 'requested' });
    assert.equal(fs.readFileSync(config.backupPath, 'utf8'), 'the one true original\n');

    const dirConfig = fixture(t);
    fs.mkdirSync(dirConfig.backupPath);
    const dirResult = await run(dirConfig);
    assert.equal(dirResult.status, 'partial');
    assert.equal(dirResult.stage, 'config');
    assert.match(dirResult.error, /backup/);
    assert.equal(dirConfig.bytes(), CONFIG, 'the config was replaced although the backup path is unusable');
    assert.equal(dirConfig.argv(), null);

    const linkConfig = fixture(t);
    const elsewhere = path.join(linkConfig.root, 'elsewhere.bak');
    fs.writeFileSync(elsewhere, 'other\n');
    fs.symlinkSync(elsewhere, linkConfig.backupPath);
    const linkResult = await run(linkConfig);
    assert.equal(linkResult.status, 'partial');
    assert.equal(linkResult.stage, 'config');
    assert.match(linkResult.error, /backup/);
    assert.equal(linkConfig.bytes(), CONFIG);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'other\n');
  });
});

describe('W3: an edit during staging is still detected', () => {
  // The window between the FINAL compare and the rename cannot be closed without
  // holding a lock on the config, which this writer deliberately does not do: it
  // keeps the compare immediately before the rename instead. What this case
  // guarantees is the part that IS detectable — an edit that lands while the new
  // bytes are staged (before that final compare) loses nothing, because the
  // rename never happens.
  test('an edit during staging aborts the replace and leaves no staging file', async (t) => {
    const config = fixture(t);
    const external = `${CONFIG}# external edit\n`;
    const realFsync = fs.fsyncSync;
    let calls = 0;
    t.mock.method(fs, 'fsyncSync', (fd) => {
      realFsync(fd);
      calls += 1;
      if (calls === 1) fs.writeFileSync(config.configPath, external);
    });
    const result = await run(config);
    assert.deepEqual(result, { status: 'partial', stage: 'config', error: 'Herdr config changed before replacement' });
    assert.equal(config.bytes(), external);
    assert.deepEqual(config.staged(), []);
    assert.equal(config.argv(), null);
  });
});

describe('W4: the BOM survives a changed write', () => {
  test('decode keeps the BOM, and the backup and new file agree on it', async (t) => {
    const config = fixture(t, { config: `\uFEFF${CONFIG}` });
    const original = config.rawBytes();
    assert.deepEqual([...original.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.deepEqual(await run(config), { status: 'requested' });
    const written = config.rawBytes();
    assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM was dropped from the written file');
    assert.deepEqual(fs.readFileSync(config.backupPath), original);
    assert.equal(
      config.bytes(),
      '\uFEFF[theme]\n# herdr-gentle-shell: was name = "catppuccin"\nname = "one-dark"\n[theme.custom]\n'
        + 'panel_bg = "#1a1b26"\n# herdr-gentle-shell: begin\naccent = "#bb9af7"\n# herdr-gentle-shell: end\n',
    );
  });
});

describe('W5: a planned document past the read limit is refused before writing', () => {
  test('a config of exactly 262144 bytes that the plan grows is refused', async (t) => {
    const head = '[theme]\nname = "catppuccin"\n# ';
    const pad = 262144 - head.length - 1;
    const config = fixture(t, { config: `${head}${'x'.repeat(pad)}\n` });
    assert.equal(config.rawBytes().length, 262144);
    const result = await run(config);
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.match(result.error, /262144/);
    assert.equal(config.rawBytes().length, 262144, 'the config was rewritten');
    assert.equal(fs.existsSync(config.backupPath), false);
    assert.equal(config.argv(), null);
  });
});

describe('W6: the full permission bits are preserved', () => {
  test('a setgid config keeps its 0o2640 mode', async (t) => {
    const config = fixture(t, { mode: 0o2640 });
    fs.chmodSync(config.configPath, 0o2640);
    assert.equal(fs.statSync(config.configPath).mode & 0o7777, 0o2640);
    assert.deepEqual(await run(config), { status: 'requested' });
    assert.equal(fs.statSync(config.configPath).mode & 0o7777, 0o2640);
  });
});

describe('W7: forceReload', () => {
  test('an unchanged plan still reloads and reports requested', async (t) => {
    const config = fixture(t);
    assert.deepEqual(await run(config), { status: 'requested' });
    const written = config.bytes();
    const inode = fs.statSync(config.configPath).ino;
    fs.rmSync(config.env.HERDR_ARGV_LOG);
    assert.deepEqual(await run(config, PROJECTION, { forceReload: true }), { status: 'requested' });
    assert.equal(config.bytes(), written);
    assert.equal(fs.statSync(config.configPath).ino, inode);
    assert.equal(config.argv(), 'server\nreload-config\n');
  });

  test('a forced reload that fails is partial/reload with the config untouched', async (t) => {
    const config = fixture(t);
    assert.deepEqual(await run(config), { status: 'requested' });
    const written = config.bytes();
    fs.rmSync(config.env.HERDR_ARGV_LOG);
    const failing = { ...config.env, HERDR_FAKE_EXIT: '9' };
    const result = await applyHerdrTheme({ projection: PROJECTION, env: failing, platform: 'linux', forceReload: true });
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'reload');
    assert.equal(config.bytes(), written);
  });

  test('without forceReload an unchanged plan still writes and reloads nothing', async (t) => {
    const config = fixture(t);
    assert.deepEqual(await run(config), { status: 'requested' });
    fs.rmSync(config.env.HERDR_ARGV_LOG);
    assert.deepEqual(await run(config), { status: 'unchanged' });
    assert.equal(config.argv(), null);
  });
});

// The reload options are asserted exactly where the writer is ported from: a
// patched execFile sees the same argv and bounds the real one uses.
describe('W-extra: the reload invocation is bounded and shell-free', () => {
  test('execFile receives exactly these arguments', async (t) => {
    const config = fixture(t);
    const calls = [];
    t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null);
    });
    assert.deepEqual(await run(config), { status: 'requested' });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['server', 'reload-config']);
    assert.deepEqual(calls[0].options, { env: config.env, timeout: 5000, maxBuffer: 4096 });
    assert.equal('shell' in calls[0].options, false);
  });
});

/* ================================================================ pass 2 ===
 * Reproducers from the second independent verifier attack (225 valid TOML
 * inputs x 4-step projection sequences, 265 mutations, a 36-case writer
 * matrix). E is "no custom tokens", F is two custom tokens; every accepted
 * output is re-parsed with tomllib and every unowned table is compared with
 * the input's parse.
 * ========================================================================= */

const planned2 = accepted;
const E = { name: 'one-dark', custom: {} };
const F = { name: 'one-dark', custom: { accent: '#123456', text: '#654321' } };

describe('M1: the was-marker payload is strict and its record is safe', () => {
  test('a payload with trailing junk is an ordinary comment, not ownership', (t) => {
    const raw = '[theme.custom]\n# herdr-gentle-shell: was accent = "x" junk ""\naccent = "#112233"\n';
    const result = accepted(t, raw, E);
    // The user's accent is NOT "restored" to the junk payload.
    assert.ok(result.text.includes('accent = "#112233"\n'), JSON.stringify(result.text));
    assert.ok(result.text.includes('was accent = "x" junk ""'));
  });

  test('a payload that is a valid line with a comment round-trips that comment', (t) => {
    // The marker stores the WHOLE original line, so a trailing comment is part
    // of the original and must come back.
    const raw = '[theme.custom]\n# herdr-gentle-shell: was accent = "#7aa2f7" # was mine\naccent = "#112233"\n';
    const result = accepted(t, raw, E);
    assert.equal(result.text, '[theme.custom]\naccent = "#7aa2f7" # was mine\n[theme]\nname = "one-dark"\n');
  });

  test('a legal Unicode separator-like character is recordable and round-trips', (t) => {
    // Only C0 controls other than tab, and DEL, break "one line". U+2028, U+2029
    // and U+0085 are ordinary characters in TOML text, so a line carrying one is
    // recorded verbatim and given back byte for byte.
    for (const [raw, projection, restore] of [
      ['[theme]\nname = "one-dark"\n[theme.custom]\naccent = "a\u2028b"\n', F, E],
      ['[theme.custom]\naccent = "a\u2029b"\n[theme]\nname = "one-dark"\n', F, E],
      ['[theme.custom]\naccent = "a\u0085b"\n[theme]\nname = "one-dark"\n', F, E],
    ]) {
      const painted = accepted(t, raw, projection);
      assert.notEqual(painted.text, raw, 'the value should have been replaced');
      assert.equal(accepted(t, painted.text, restore).text, raw, `no byte-exact round trip for ${JSON.stringify(raw)}`);
    }
    // A theme name may carry one too; it is recorded verbatim on the marker line.
    assert.match(
      accepted(t, '[theme]\nname = "a\u2028b"\n', E).text,
      /^\[theme\]\n# herdr-gentle-shell: was name = "a\u2028b"\nname = "one-dark"\n$/,
    );
  });

  test('a targeted multi-line value is refused with its line number', (t) => {
    refused(t, '[theme.custom]\naccent = """#000000"""\n', F, /^line 2: cannot record the original value of `accent` safely/);
  });

  test('a targeted multi-line value is refused even when its text matches', (t) => {
    // Design point 3: a key the projection touches must be a strict
    // `key = value` line; a multi-line value cannot be spliced or recorded.
    const raw = '[theme.custom]\naccent = """#123456"""\n[theme]\nname = "one-dark"\n';
    refused(t, raw, { name: 'one-dark', custom: { accent: '#123456' } }, /^line 2: cannot record the original value of `accent` safely/);
  });
});

describe('M2: duplicate markers for one key are refused', () => {
  test('two markers above the same key is a refusal, not alternating restores', (t) => {
    const raw = '[theme.custom]\n# herdr-gentle-shell: was accent = "a"\n# herdr-gentle-shell: was accent = "b"\naccent = "#c"\n';
    refused(t, raw, E, /^line 3: duplicate herdr-gentle-shell marker for `accent`; no changes proposed\.$/);
  });

  test('the same duplicate on the theme name is refused', (t) => {
    const raw = '[theme]\n# herdr-gentle-shell: was name = "a"\n# herdr-gentle-shell: was name = "b"\nname = "c"\n';
    refused(t, raw, E, /^line 3: duplicate herdr-gentle-shell marker for `name`/);
  });

  test('every accepted marker plan is idempotent', (t) => {
    const raw = '[theme.custom]\n# herdr-gentle-shell: was accent = "a"\naccent = "#123456"\n[theme]\nname = "one-dark"\n';
    idempotent(t, raw, F);
  });
});

describe('M3: legacy markers pair with the nearest preceding BEGIN', () => {
  const BEGIN = '# BEGIN herdr-gentle-theme (managed; do not edit)';
  const END = '# END herdr-gentle-theme';

  test('an outer BEGIN around unrelated keys is preserved when the inner pair is dropped', (t) => {
    const raw = `[ui]\n${BEGIN}\nx = 1\n${BEGIN}\n[theme]\nname = "one-dark"\n${END}\n`;
    const result = accepted(t, raw, E);
    assert.equal(result.text, `[ui]\n${BEGIN}\nx = 1\n[theme]\nname = "one-dark"\n`);
  });

  test('a pair that wraps no theme table keeps both of its lines', (t) => {
    const raw = `${BEGIN}\n[ui]\nx = 1\n${END}\n[theme]\nname = "one-dark"\n`;
    const result = accepted(t, raw, E);
    assert.equal(result.text, raw);
  });

  test('each of two pairs is decided on its own contents', (t) => {
    const raw = `${BEGIN}\n[ui]\nx = 1\n${END}\n${BEGIN}\n[theme.custom]\ntext = "#654321"\n${END}\n[theme]\nname = "one-dark"\n`;
    const result = accepted(t, raw, E);
    // The [ui] pair encloses no theme table and stays; the custom pair is dropped.
    assert.equal(result.text, `${BEGIN}\n[ui]\nx = 1\n${END}\n[theme.custom]\ntext = "#654321"\n[theme]\nname = "one-dark"\n`);
  });
});

describe('M4: byte preservation at EOF', () => {
  test('a restored line returns the file to its original bytes (no final newline)', (t) => {
    for (const eol of ['\n', '\r\n']) {
      const raw = `[theme]${eol}name = "one-dark"${eol}[theme.custom]${eol}text="reset"`;
      const forward = accepted(t, raw, F);
      // The block's end line records that placing it added the missing ending.
      assert.ok(/\n# herdr-gentle-shell: end[^\n]*$/.test(forward.text), JSON.stringify(forward.text));
      const back = accepted(t, forward.text, E);
      // F then E is a full round trip: the marker and the block are gone and the
      // missing final newline is back.
      assert.equal(back.text, raw, `round trip failed for ${JSON.stringify(eol)}`);
    }
  });

  test('the verifier reproducer keeps the value bytes and gains exactly one newline', (t) => {
    // Here F also has to create the `[theme]` table after the token, so the
    // restored line necessarily carries the ending that the append needs. What
    // must not happen is extra bytes: no blank separator line.
    const raw = '[theme.custom]\r\ntext="reset"';
    const forward = accepted(t, raw, F);
    const back = accepted(t, forward.text, E);
    assert.equal(back.text, '[theme.custom]\r\ntext="reset"\r\n[theme]\r\nname = "one-dark"');
  });

  test('an EOF append adds one newline and never a blank separator', (t) => {
    assert.equal(accepted(t, '[ui]\nx = 1', E).text, '[ui]\nx = 1\n[theme]\nname = "one-dark"');
    // A file that already ends with a blank line keeps it as the separation.
    assert.equal(accepted(t, '[ui]\nx = 1\n\n', E).text, '[ui]\nx = 1\n\n[theme]\nname = "one-dark"\n');
    assert.equal(accepted(t, '[ui]\nx = 1\r\n', E).text, '[ui]\nx = 1\r\n[theme]\r\nname = "one-dark"\r\n');
  });
});

describe('R1-R5: valid TOML a real user can have is accepted', () => {
  test('R1: "a.b" and a.b are different keys', (t) => {
    const raw = '[ui]\n"a.b" = 1\na.b = 2\n[theme]\nname = "one-dark"\n';
    assert.equal(accepted(t, raw, E).text, raw);
  });

  test('R2: a child header repeated under successive [[x]] entries is valid', (t) => {
    const raw = '[[x]]\n[x.y]\nv = 1\n[[x]]\n[x.y]\nv = 2\n[theme]\nname = "one-dark"\n';
    assert.equal(accepted(t, raw, E).text, raw);
  });

  test('R3: U+2028, U+2029 and U+0085 inside a comment are valid', (t) => {
    const raw = '# before\u2028after\u2029and\u0085end\n[theme]\nname = "one-dark"\n';
    assert.equal(accepted(t, raw, E).text, raw);
  });

  test('R4: an untargeted multi-line value in [theme.custom] is preserved', (t) => {
    const raw = '[theme.custom]\nyellow="""reset"""\n[theme]\nname = "one-dark"\n';
    assert.equal(accepted(t, raw, E).text, raw);
  });

  test('R5: quoted dotted keys, dotted keys in [theme] and look-alike comments in [ui]', (t) => {
    const raw = '[theme]\nname = "one-dark"\n"a.b" = 1\na.b = 2\n'
      + '[ui]\n# herdr-gentle-shell: begin\n# herdr-gentle-shell: end\nk = 1\n';
    assert.equal(accepted(t, raw, E).text, raw);
  });
});

describe('W-A: every staging failure removes the temp path it created', () => {
  function assertNoLeak(config, result) {
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.equal(config.bytes(), CONFIG, 'the config was replaced');
    assert.deepEqual(config.staged(), [], 'a staging file survived');
    assert.equal(config.argv(), null);
  }

  test('a failing second write snakes the staged file away', async (t) => {
    const config = fixture(t);
    const real = fs.writeFileSync;
    let fdWrites = 0;
    t.mock.method(fs, 'writeFileSync', (target, ...rest) => {
      if (typeof target === 'number') {
        fdWrites += 1;
        if (fdWrites === 2) throw new Error('controlled second write failure');
      }
      return real(target, ...rest);
    });
    assertNoLeak(config, await run(config));
  });

  test('a failing second fsync snakes the staged file away', async (t) => {
    const config = fixture(t);
    const real = fs.fsyncSync;
    let calls = 0;
    t.mock.method(fs, 'fsyncSync', (fd) => {
      calls += 1;
      if (calls === 2) throw new Error('controlled second fsync failure');
      return real(fd);
    });
    assertNoLeak(config, await run(config));
  });

  test('a failing fchmod snakes the staged file away', async (t) => {
    const config = fixture(t);
    t.mock.method(fs, 'fchmodSync', () => {
      throw new Error('controlled fchmod failure');
    });
    assertNoLeak(config, await run(config));
  });
});

describe('W-B: the backup path is verified, including in the race', () => {
  test('a directory created just before linkSync is refused and the config stays', async (t) => {
    const config = fixture(t);
    const real = fs.linkSync;
    t.mock.method(fs, 'linkSync', (from, to) => {
      fs.mkdirSync(to);
      return real(from, to);
    });
    const result = await run(config);
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.match(result.error, /backup/);
    assert.equal(config.bytes(), CONFIG);
    assert.deepEqual(config.staged(), []);
    assert.equal(config.argv(), null);
  });

  test('a symlink created just before linkSync is refused and the config stays', async (t) => {
    const config = fixture(t);
    const elsewhere = path.join(config.root, 'elsewhere.bak');
    fs.writeFileSync(elsewhere, 'other\n');
    const real = fs.linkSync;
    t.mock.method(fs, 'linkSync', (from, to) => {
      fs.symlinkSync(elsewhere, to);
      return real(from, to);
    });
    const result = await run(config);
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.match(result.error, /backup/);
    assert.equal(config.bytes(), CONFIG);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'other\n');
  });
});

// Extra hardening for the surfaces this pass touched: a marker written by hand,
// and valid TOML shapes the new value grammar must not falsely refuse.
describe('extra: marker payloads that are not ours', () => {
  test('a literal-string payload restores its own bytes', (t) => {
    const raw = "[theme.custom]\n# herdr-gentle-shell: was accent = '#7aa2f7'\naccent = \"#112233\"\n[theme]\nname = \"one-dark\"\n";
    const result = planned2(t, raw, E);
    assert.ok(result.text.includes("accent = '#7aa2f7'\n"), JSON.stringify(result.text));
  });

  test('a payload that is two values restores nothing', (t) => {
    const raw = '[theme.custom]\n# herdr-gentle-shell: was accent = "a" "b"\naccent = "#112233"\n[theme]\nname = "one-dark"\n';
    const result = planned2(t, raw, E);
    assert.ok(result.text.includes('accent = "#112233"\n'));
  });
});

describe('extra: valid TOML the grammar must keep accepting', () => {
  const SHAPES = [
    '[a.b]\nv = 1\n[a]\nw = 2', // super-table after a sub-table
    'k = [ { a = 1 }, { b = 2 } ]', // array of inline tables
    'k = """line \\\n   continued"""', // line-ending backslash in a multi-line string
    'k = 1_0.5', // underscores in a float
    'k = 1979-05-27 07:32:00', // date and time separated by a space
    'k = [\n  "a", # note\n  "b",\n]', // trailing comma and a comment in an array
    'k = "\u00e9 \U0001F600 \\" \\\\ "', // escapes in a value
  ];
  for (const shape of SHAPES) {
    test(`accepts ${JSON.stringify(shape)}`, (t) => {
      const raw = `${shape}\n[theme]\nname = "one-dark"\n`;
      const result = planned2(t, raw, E);
      if (result.text !== raw) parseToml(t, result.text);
      assert.ok(result.text.startsWith(shape.split('\n')[0]), result.text);
    });
  }
});

/* ============================================================== property ===
 * A deterministic, seeded property test (no third-party dependencies): 300
 * generated valid documents x a 4-step projection sequence, plus 300 mutations
 * of them. Valid inputs must plan, be idempotent, leave every non-theme byte
 * alone, stay valid TOML, and come back byte-identical when the projection drops
 * its custom tokens again. A mutation may be refused or accepted, but when it is
 * accepted the non-theme lines are still byte-identical (an invalid input is not
 * required to produce valid TOML — it already was not).
 * ======================================================================== */

describe('property: generated documents and mutations', () => {
  // A tiny LCG: deterministic, so a failure is reproducible from the seed.
  function prng(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  // Distinct opaque chunks: sampling without replacement keeps the document from
  // defining the same table twice, which would not be valid TOML.
  const OPAQUE = [
    'onboarding = false',
    '# a comment',
    '[terminal]\nnew_cwd = "follow"\ncwd = "inherit"',
    '[ui]\nmouse = true\nscroll = 2',
    '[ui.sidebar.agents]\nrows = ["a", "b"]\ninline = { a = 1 }',
    'note = """multi\nline"""',
    'list = [\n  1,\n  2,\n]',
    'date = 2024-02-29T12:00:00Z',
    'big = 1_000.5',
    '[ui.keys]\nquit = "ctrl+c"',
  ];
  const THEME_BODIES = ['name = "catppuccin"', 'name = "one-dark"\nauto_switch = false', 'name = "nord"  # mine'];
  const CUSTOM_BODIES = [
    'panel_bg = "#1a1b26"\naccent = "#7aa2f7"',
    'blue = "#0000ff"\naccent = \'red\'',
    'accent = "#7aa2f7"  # mine\ntext = "reset"',
    'accent = "#7aa2f7"\n\n# a note\n\nblue = "#0000ff"',
  ];
  const NAMES = ['one-dark', 'nord', 'catppuccin', 'tokyo-night', 'dracula', 'terminal'];

  function makeDocument(next) {
    const chunks = [];
    const opaqueCount = 1 + Math.floor(next() * 2);
    const pool = OPAQUE.slice();
    for (let index = 0; index < opaqueCount && pool.length > 0; index += 1) {
      chunks.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
    }
    if (next() < 0.75) chunks.push(`[theme]\n${THEME_BODIES[Math.floor(next() * THEME_BODIES.length)]}`);
    if (next() < 0.75) chunks.push(`[theme.custom]\n${CUSTOM_BODIES[Math.floor(next() * CUSTOM_BODIES.length)]}`);
    return `${chunks.join('\n')}\n`;
  }

  function makeSequence(next) {
    const sequence = [];
    for (let step = 0; step < 3; step += 1) {
      const custom = {};
      const tokens = ['accent', 'text', 'red', 'panel_bg', 'blue'];
      const count = Math.floor(next() * 3);
      for (let index = 0; index < count; index += 1) {
        custom[tokens[Math.floor(next() * tokens.length)]] = `#${Math.floor(next() * 0xffffff).toString(16).padStart(6, '0')}`;
      }
      sequence.push({ name: NAMES[Math.floor(next() * NAMES.length)], custom });
    }
    // The last step drops every custom token: reversibility.
    sequence.push({ name: NAMES[Math.floor(next() * NAMES.length)], custom: {} });
    return sequence;
  }

  // The user's own lines inside [theme.custom]: everything that is not a header,
  // our marker, our block, or a blank line. This is what a full cycle must give
  // back byte for byte.
  function customRegionLines(text) {
    const out = [];
    let inCustom = false;
    let inBlock = false;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inCustom = trimmed.replace(/\s+#.*$/, '') === '[theme.custom]';
        continue;
      }
      if (!inCustom) continue;
      if (trimmed === '# herdr-gentle-shell: begin' || trimmed === '# herdr-gentle-shell: begin created') {
        inBlock = true;
        continue;
      }
      if (trimmed === '# herdr-gentle-shell: end' || trimmed === '# herdr-gentle-shell: end after a missing line ending') {
        inBlock = false;
        continue;
      }
      if (inBlock || trimmed.startsWith('# herdr-gentle-shell: was ')) continue;
      if (trimmed === '') continue;
      out.push(line);
    }
    return out;
  }

  // One python invocation for every output: spawning 1200 interpreters would
  // dominate the runtime and add nothing.
  function unparseable(texts) {
    const script = [
      'import json, sys, tomllib',
      'bad = []',
      'for index, text in enumerate(json.load(sys.stdin)):',
      '    try:',
      '        tomllib.loads(text.removeprefix("\\ufeff"))',
      '    except Exception as error:',
      '        bad.append([index, str(error)])',
      'print(json.dumps(bad))',
    ].join('\n');
    const run = spawnSync('python3', ['-I', '-c', script], { input: JSON.stringify(texts), encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }

  test('300 valid documents x 4 projection steps: plan, idempotence, splice, TOML, reversibility', (t) => {
    const next = prng(0x5eed1);
    const documents = [];
    const outputs = [];
    for (let run = 0; run < 300; run += 1) {
      const document = makeDocument(next);
      documents.push(document);
      const sequence = makeSequence(next);
      let text = document;
      for (const projection of sequence) {
        const result = planThemeConfig(text, projection);
        assert.equal(result.ok, true, `${JSON.stringify(projection)} on ${JSON.stringify(text)} -> ${result.error}`);
        assert.equal(spliceInvariant(text, result.text), true, `splice broke for ${JSON.stringify(text)}`);
        const again = planThemeConfig(result.text, projection);
        assert.equal(again.ok, true);
        assert.equal(again.changed, false, `not idempotent: ${JSON.stringify(result.text)}`);
        outputs.push(result.text);
        text = result.text;
      }
      assert.deepEqual(customRegionLines(text), customRegionLines(document), `not reversible: ${JSON.stringify(document)}`);
    }
    if (!ORACLE_READY) {
      t.diagnostic(ORACLE_SKIP);
      return;
    }
    const bad = unparseable([...documents, ...outputs]);
    assert.deepEqual(bad, [], `tomllib rejected generated documents: ${JSON.stringify(bad.slice(0, 3))}`);
  });

  test('300 mutations: refused, or every non-theme line byte-identical', () => {
    const next = prng(0x5eed2);
    const MUTATIONS = [
      (text) => text.replace('accent = "#7aa2f7"', 'accent = aba'),
      (text) => text.replace('accent = "#7aa2f7"', 'accent = "#7aa2f7" junk'),
      (text) => text.replace('name = "nord"', 'name = "nord" # ok'),
      (text) => text.replace('rows = ["a", "b"]', 'rows = ["a", "b"'),
      (text) => text.replace('\n', '\r'),
      (text) => text.replace('}', ']'),
      (text) => text.replace('= true', '= 2025-02-29'),
      (text) => `${text}x=`,
      (text) => text.replace('blue = "#0000ff"', 'blue = "#0000ff"\nblue = "#111111"'),
      (text) => text.replace('note = """multi\nline"""', 'note = """multi\nline""""'),
      (text) => text.replace('[theme]\n', '[theme]\n[y]\n'),
      (text) => text.replace('# a comment', '# a comment\u2028tail'),
    ];
    for (let run = 0; run < 300; run += 1) {
      const document = makeDocument(next);
      const mutation = MUTATIONS[run % MUTATIONS.length];
      const mutated = mutation(document);
      const projection = { name: NAMES[Math.floor(next() * NAMES.length)], custom: { accent: '#123456' } };
      const result = planThemeConfig(mutated, projection);
      if (!result.ok) {
        assert.match(result.error, /^line \d+: |^internal splice/);
        continue;
      }
      assert.equal(spliceInvariant(mutated, result.text), true, `a mutation was spliced: ${JSON.stringify(mutated)}`);
    }
  });
});

describe('created header vs a user line inside the table', () => {
  test('a user comment inside the created table keeps its header', (t) => {
    const raw = '[theme]\nname = "one-dark"\n';
    const withToken = accepted(t, raw, { name: 'one-dark', custom: { accent: '#112233' } });
    // The user adds a note of their own inside the table we created.
    const edited = withToken.text.replace('# herdr-gentle-shell: end\n', '# herdr-gentle-shell: end\n# my own note\n');
    const back = accepted(t, edited, E);
    assert.equal(back.text, '[theme]\nname = "one-dark"\n[theme.custom]\n# my own note\n', JSON.stringify(back.text));
    assert.equal(back.text.includes('my own note'), true, 'a human line was deleted');
    idempotent(t, back.text, E);
  });

  test('a header the user wrote is never removed, even when the block empties', (t) => {
    const raw = '[theme]\nname = "one-dark"\n[theme.custom]\n';
    const withToken = accepted(t, raw, { name: 'one-dark', custom: { accent: '#112233' } });
    assert.ok(withToken.text.includes('# herdr-gentle-shell: begin\n'), 'an existing table must not be marked created');
    const back = accepted(t, withToken.text, E);
    assert.equal(back.text, raw);
  });
});

describe('property: created-table and name cycles return the original bytes', () => {
  function prng(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }
  const THEME_BODIES = ['name = "catppuccin"', 'name = "one-dark"\nauto_switch = false', 'name = "nord"  # mine'];
  const CUSTOM_BODIES = [
    'panel_bg = "#1a1b26"\naccent = "#7aa2f7"',
    "blue = '#0000ff'\naccent = 'red'",
    'accent = "#7aa2f7"  # mine\ntext = "reset"',
    'accent = "#7aa2f7"\n\n# a note\n\nblue = "#0000ff"',
  ];
  const OPAQUE = ['onboarding = false', '[terminal]\nnew_cwd = "follow"', '# a comment', '[ui]\nmouse = true'];
  function makeDocument(next) {
    const chunks = [OPAQUE[Math.floor(next() * OPAQUE.length)]];
    chunks.push(`[theme]\n${THEME_BODIES[Math.floor(next() * THEME_BODIES.length)]}`);
    if (next() < 0.5) chunks.push(`[theme.custom]\n${CUSTOM_BODIES[Math.floor(next() * CUSTOM_BODIES.length)]}`);
    return `${chunks.join('\n')}\n`;
  }
  function themeNameOf(text) {
    const match = /\[theme\]\n(?:[^[]*?)name = "([^"]*)"/.exec(text);
    return match ? match[1] : null;
  }

  test('300 documents: paint then clear, and a name cycle away and back, are byte-identical', () => {
    const next = prng(0x5eed4);
    let checked = 0;
    for (let run = 0; run < 300; run += 1) {
      const document = makeDocument(next);
      const name = themeNameOf(document);
      assert.ok(name !== null, `the generator must produce a theme name: ${JSON.stringify(document)}`);
      // Paint the same name and some tokens, then drop every custom token.
      const painted = planThemeConfig(document, { name, custom: { teal: '#123456', accent: '#654321' } });
      assert.equal(painted.ok, true, painted.error);
      const back = planThemeConfig(painted.text, { name, custom: {} });
      assert.equal(back.ok, true, back.error);
      assert.equal(back.text, document, `paint/clear is not byte-identical for ${JSON.stringify(document)}`);
      // Change the name, then come back: the original spelling returns.
      const other = name === 'dracula' ? 'nord' : 'dracula';
      const away = planThemeConfig(document, { name: other, custom: { accent: '#123456' } });
      assert.equal(away.ok, true, away.error);
      const home = planThemeConfig(away.text, { name, custom: {} });
      assert.equal(home.ok, true, home.error);
      assert.equal(home.text, document, `the name cycle is not byte-identical for ${JSON.stringify(document)}`);
      checked += 1;
    }
    assert.equal(checked, 300);
  });

  test('200 literal-string values are compared raw and round-trip byte for byte', () => {
    const next = prng(0x5eed5);
    const suffixes = ['', '  # mine', '\t# tab comment', ' \t '];
    for (let run = 0; run < 200; run += 1) {
      const hex = `${Math.floor(next() * 0xffffff).toString(16).padStart(6, '0')}`;
      // A literal string whose RAW characters look like an escaped basic string:
      // decoding it would produce `#<hex>` and wrongly count as equal.
      const literal = `'\\u0023${hex}'`;
      const suffix = next() < 0.5 ? '' : suffixes[Math.floor(next() * suffixes.length)];
      const wanted = `#${hex}`;
      const document = `[theme]\nname = "one-dark"\n[theme.custom]\naccent = ${literal}${suffix}\n`;
      const painted = planThemeConfig(document, { name: 'one-dark', custom: { accent: wanted } });
      assert.equal(painted.ok, true, painted.error);
      // Not decoded, so it cannot equal the projection: it is replaced in place
      // and the whole original line is recorded.
      assert.ok(painted.text.includes(`accent = "${wanted}"${suffix}\n`), JSON.stringify(painted.text));
      assert.ok(painted.text.includes(`# herdr-gentle-shell: was accent = ${literal}${suffix}\n`), JSON.stringify(painted.text));
      // ...and the cycle gives those bytes back exactly.
      const back = planThemeConfig(painted.text, { name: 'one-dark', custom: {} });
      assert.equal(back.ok, true, back.error);
      assert.equal(back.text, document, `literal round trip failed for ${JSON.stringify(document)}`);
      // A literal without escapes equals the projection by raw text: no change.
      const same = `[theme]\nname = "one-dark"\n[theme.custom]\naccent = '${wanted}'${suffix}\n`;
      const unchanged = planThemeConfig(same, { name: 'one-dark', custom: { accent: wanted } });
      assert.equal(unchanged.ok, true, unchanged.error);
      assert.equal(unchanged.text, same, 'an equal literal must not be rewritten');
    }
  });
});

describe('property: a marker-looking comment above begin is never activated', () => {
  function prng(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }
  const TOKENS = ['red', 'accent', 'text', 'panel_bg', 'blue', 'green'];
  const MARKER = '# herdr-gentle-shell: was ';
  const BEGIN = '# herdr-gentle-shell: begin';
  const END = '# herdr-gentle-shell: end';

  test('300 documents: plan, then plan again — ok:true unchanged, or refused, never changed twice', () => {
    const next = prng(0x5eed6);
    let refusals = 0;
    for (let run = 0; run < 300; run += 1) {
      const token = TOKENS[Math.floor(next() * TOKENS.length)];
      const other = TOKENS[(TOKENS.indexOf(token) + 1 + Math.floor(next() * (TOKENS.length - 1))) % TOKENS.length];
      const eol = next() < 0.3 ? '\r\n' : '\n';
      // The comment sits ABOVE the block, so it is not a marker today. Whether it
      // would become one depends on the first key below the block: a token key
      // makes removal/moving the block ambiguous; a non-token key never does,
      // because markers are only ever consulted for theme tokens. A plain comment
      // is never ambiguous at all.
      const markerShaped = run % 2 === 0;
      const below = run % 4 < 2 ? token : `zz${token}`;
      const comment = markerShaped
        ? `${MARKER}${token} = "#111111" # example`
        : '# an ordinary comment that only mentions red = "#111111"';
      const document = [
        '[theme]', 'name = "one-dark"', '[theme.custom]',
        comment, BEGIN, `${other} = "#222222"`, END, `${below} = "#333333"`, '',
      ].join(eol);
      const projection = next() < 0.5
        ? { name: 'one-dark', custom: {} }
        : { name: 'one-dark', custom: { [token]: '#444444' } };
      const first = planThemeConfig(document, projection);
      if (!first.ok) {
        // An ambiguity refusal is the expected outcome for a marker-shaped
        // comment above a block that is about to be removed or moved.
        assert.match(first.error, /^line \d+: ambiguous herdr-gentle-shell marker above the managed block; no changes proposed\.$/);
        assert.equal(markerShaped && TOKENS.includes(below), true, `unexpected refusal for ${JSON.stringify(document)}`);
        refusals += 1;
        continue;
      }
      // Accepted: the ordinary comment is still the user's and the plan is stable.
      const second = planThemeConfig(first.text, projection);
      assert.equal(second.ok, true, second.error);
      assert.equal(second.changed, false, `a second plan changed ${JSON.stringify(first.text)}`);
      if (markerShaped) assert.ok(first.text.includes(comment), 'the ordinary comment was consumed');
    }
    assert.ok(refusals > 0, 'the ambiguous shapes must actually be exercised');
  });
});
