'use strict';
// Managed [theme] projection writer (theme-sync T2 over S3/S5), exercised
// through the shipped CLI `herdr-plugin/bin/configure-theme.js`.
//
// Herdr keeps the last palette it was applied (S5), so this writer is the only
// place that touches the theme block on disk. Everything here runs against a
// temp sandbox: a fixture config.toml under HERDR_CONFIG_PATH and a fake
// `herdr` binary under HERDR_BIN_PATH that records every argv. Exit codes,
// exact stdout/stderr lines, the file bytes and the recorded Herdr calls are
// the only assertions, so nothing depends on a live Herdr install.
//
// Refusal tests always assert all three effects the refusal promises: exit 2,
// one stderr line naming the problem, and an unchanged file *and* reload log.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'configure-theme.js');
const SIDEBAR_CLI = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'configure.js');

const THEME_BEGIN = '# BEGIN herdr-gentle-theme (managed; do not edit)';
const THEME_END = '# END herdr-gentle-theme';

const THEMES = [
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
];

const TOKENS = [
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
];

// A user-owned table that both writers must leave alone.
const SEED = '[ui.sidebar.agents]\norder = ["pi"]\n';

const FAKE_HERDR = `#!/bin/sh
printf 'CALL %s\\n' "$*" >>"$CALL_LOG"
if [ -n "$HERDR_EXIT" ]; then exit "$HERDR_EXIT"; fi
exit 0
`;

let sandbox;
let configPath;
let callLog;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-theme-config-'));
  configPath = path.join(sandbox, 'config.toml');
  callLog = path.join(sandbox, 'calls.log');
  fs.writeFileSync(callLog, '');
  const bin = path.join(sandbox, 'herdr');
  fs.writeFileSync(bin, FAKE_HERDR, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function env(extra = {}) {
  return {
    ...process.env,
    HERDR_BIN_PATH: path.join(sandbox, 'herdr'),
    HERDR_CONFIG_PATH: configPath,
    CALL_LOG: callLog,
    ...extra,
  };
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [opts.cli ?? CLI, ...args], {
    input: opts.input ?? '',
    encoding: 'utf8',
    timeout: 20000,
    env: env(opts.env ?? {}),
  });
}

function herdrCalls() {
  return fs
    .readFileSync(callLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.slice('CALL '.length));
}

function payload(body) {
  return JSON.stringify(body);
}

// The block exactly as the writer must emit it: markers, `[theme]` with the
// name, and (only when custom is non-empty) `[theme.custom]` in canonical
// token order. No trailing newline; the file adds one.
function block(name, customLines = []) {
  const lines = [THEME_BEGIN, '[theme]', `name = "${name}"`];
  if (customLines.length > 0) lines.push('', '[theme.custom]', ...customLines);
  lines.push(THEME_END);
  return lines.join('\n');
}

function readConfig() {
  return fs.readFileSync(configPath, 'utf8');
}

function applySidebarBlock() {
  const r = run(['--apply'], { cli: SIDEBAR_CLI });
  assert.equal(r.status, 0, r.stderr);
  return readConfig();
}

describe('apply: managed [theme] block (S3)', () => {
  test('writes the block with custom tokens in canonical order and one result line', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run(['--apply'], {
      input: payload({
        theme: { name: 'tokyo-night', custom: { accent: '#7AA2F7', sidebar_bg: '#1a1b26' } },
      }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `configure-theme: applied theme "tokyo-night" to ${configPath}\n`);
    // Payload order (accent first) is never trusted and upper-case hex is
    // normalised, so the same palette always lands on the same bytes.
    assert.equal(
      readConfig(),
      `${SEED}\n${block('tokyo-night', ['sidebar_bg = "#1a1b26"', 'accent = "#7aa2f7"'])}\n`,
    );
  });

  test('omits [theme.custom] when custom is absent or empty', () => {
    fs.writeFileSync(configPath, SEED);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'nord' } }) }).status, 0);
    assert.equal(readConfig(), `${SEED}\n${block('nord')}\n`);

    fs.writeFileSync(configPath, SEED);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'nord', custom: {} } }) }).status, 0);
    assert.equal(readConfig(), `${SEED}\n${block('nord')}\n`);
    assert.equal(readConfig().includes('[theme.custom]'), false);
  });

  test('accepts every supported theme name', () => {
    fs.writeFileSync(configPath, SEED);
    for (const name of THEMES) {
      const r = run(['--apply'], { input: payload({ theme: { name } }) });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.ok(readConfig().includes(`name = "${name}"`), name);
    }
  });

  test('emits every custom token in the fixed list order', () => {
    fs.writeFileSync(configPath, SEED);
    const custom = {};
    TOKENS.forEach((token, index) => {
      custom[token] = `#${String(index).padStart(6, '0')}`;
    });
    // Reverse insertion order must not leak into the file.
    const reversed = {};
    for (const token of [...TOKENS].reverse()) reversed[token] = custom[token];
    const r = run(['--apply'], { input: payload({ theme: { name: 'vesper', custom: reversed } }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readConfig(), `${SEED}\n${block('vesper', TOKENS.map((t) => `${t} = "${custom[t]}"`))}\n`);
  });

  test('creates the config file and its directory when absent', () => {
    const nested = path.join(sandbox, 'nested', 'herdr', 'config.toml');
    const r = run(['--apply'], {
      input: payload({ theme: { name: 'kanagawa' } }),
      env: { HERDR_CONFIG_PATH: nested },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(nested, 'utf8'), `${block('kanagawa')}\n`);
  });

  test('--apply is the default operation', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run([], { input: payload({ theme: { name: 'gruvbox' } }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `configure-theme: applied theme "gruvbox" to ${configPath}\n`);
    assert.equal(readConfig(), `${SEED}\n${block('gruvbox')}\n`);
  });

  test('is idempotent: a second identical apply writes nothing and does not reload', () => {
    fs.writeFileSync(configPath, SEED);
    const body = payload({ theme: { name: 'dracula', custom: { accent: '#bd93f9' } } });
    assert.equal(run(['--apply', '--reload'], { input: body }).status, 0);
    const once = readConfig();
    const callsAfterFirst = herdrCalls();
    assert.deepEqual(callsAfterFirst, ['server reload-config']);

    const second = run(['--apply', '--reload'], { input: body });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, `configure-theme: theme "dracula" already current in ${configPath}; unchanged\n`);
    assert.equal(readConfig(), once);
    assert.deepEqual(herdrCalls(), callsAfterFirst, 'no write means no reload');
  });

  test('repairs a stale managed block in place without growing the file', () => {
    fs.writeFileSync(configPath, SEED);
    const stale = `\n${block('nord', ['accent = "#111111"'])}\n`;
    fs.writeFileSync(configPath, SEED + stale);
    const r = run(['--apply'], {
      input: payload({ theme: { name: 'one-dark', custom: { accent: '#61afef' } } }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readConfig(), `${SEED}\n${block('one-dark', ['accent = "#61afef"'])}\n`);
  });
});

describe('reload (S5: the applied palette is the one Herdr keeps)', () => {
  test('runs `herdr server reload-config` from HERDR_BIN_PATH after a write', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run(['--apply', '--reload'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(herdrCalls(), ['server reload-config']);
    // Exactly one human result line: the reload note never doubles it.
    assert.equal(r.stdout, `configure-theme: applied theme "nord" to ${configPath}\n`);
  });

  test('does not touch Herdr without --reload', () => {
    fs.writeFileSync(configPath, SEED);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'nord' } }) }).status, 0);
    assert.deepEqual(herdrCalls(), []);
  });

  test('a failing reload keeps the written file and exits 1', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run(['--apply', '--reload'], {
      input: payload({ theme: { name: 'solarized' } }),
      env: { HERDR_EXIT: '3' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /reload failed \(exit 3\)/);
    assert.equal(readConfig(), `${SEED}\n${block('solarized')}\n`);
  });
});

describe('remove', () => {
  test('removes only the managed theme block and reloads', () => {
    fs.writeFileSync(configPath, SEED);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'nord' } }) }).status, 0);
    const r = run(['--remove', '--reload']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `configure-theme: removed managed theme block from ${configPath}\n`);
    assert.equal(readConfig().includes(THEME_BEGIN), false);
    assert.ok(readConfig().includes('[ui.sidebar.agents]'), 'the user table survives');
    assert.deepEqual(herdrCalls(), ['server reload-config']);
  });

  test('is inert when the block is absent', () => {
    fs.writeFileSync(configPath, SEED);
    const before = readConfig();
    const r = run(['--remove', '--reload']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'configure-theme: no managed theme block; nothing to do\n');
    assert.equal(readConfig(), before);
    assert.deepEqual(herdrCalls(), []);
  });

  test('is inert on a missing config file', () => {
    const r = run(['--remove']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'configure-theme: no managed theme block; nothing to do\n');
    assert.equal(fs.existsSync(configPath), false);
  });

  test('leaves an unmanaged [theme] table alone instead of adopting or deleting it', () => {
    const foreign = '[theme]\nname = "nord"\n';
    fs.writeFileSync(configPath, foreign);
    const r = run(['--remove']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readConfig(), foreign);
  });
});

describe('check (read-only)', () => {
  test('exit 0 when the block matches the piped payload', () => {
    fs.writeFileSync(configPath, SEED);
    const body = payload({ theme: { name: 'rose-pine', custom: { accent: '#ebbcba' } } });
    assert.equal(run(['--apply'], { input: body }).status, 0);
    const before = readConfig();
    const r = run(['--check'], { input: body });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'configure-theme: managed theme block present and current\n');
    assert.equal(r.stderr, '');
    assert.equal(readConfig(), before);
    assert.deepEqual(herdrCalls(), []);
  });

  test('exit 0 when the block is present and canonical without a payload', () => {
    fs.writeFileSync(configPath, SEED);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'terminal' } }) }).status, 0);
    const r = run(['--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'configure-theme: managed theme block present and current\n');
  });

  test('exit 0 when both the file and the block are absent', () => {
    const r = run(['--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'configure-theme: managed theme block absent\n');
    assert.equal(fs.existsSync(configPath), false);
  });

  test('exit 1 when the block is stale, and never writes', () => {
    fs.writeFileSync(configPath, SEED);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'rose-pine' } }) }).status, 0);
    const before = readConfig();
    const r = run(['--check'], { input: payload({ theme: { name: 'catppuccin' } }) });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'configure-theme: managed theme block is stale; run --apply to update it\n');
    assert.equal(readConfig(), before);
    assert.deepEqual(herdrCalls(), []);
  });

  test('exit 1 when the marked block body is not canonical', () => {
    fs.writeFileSync(configPath, `${SEED}\n${THEME_BEGIN}\n[theme]\nname = "not-a-theme"\n${THEME_END}\n`);
    const before = readConfig();
    const r = run(['--check']);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, 'configure-theme: managed theme block is stale; run --apply to update it\n');
    assert.equal(readConfig(), before);
  });

  test('exit 2 and no write when a foreign [theme] table exists', () => {
    const foreign = '[theme]\nname = "nord"\n';
    fs.writeFileSync(configPath, foreign);
    const r = run(['--check'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^configure-theme: refusing --check: a \[theme\] or \[theme\.custom\] table/);
    assert.equal(readConfig(), foreign);
  });
});

describe('refusals: one stderr line, exit 2, no write, no reload', () => {
  const refusals = [
    {
      name: 'a missing payload',
      input: '',
      detail:
        'no theme payload on stdin; expected JSON ' +
        '{"theme":{"name":"<herdr-theme>","custom":{"<token>":"#rrggbb"}}}',
      seed: () => SEED,
    },
    {
      name: 'invalid JSON',
      input: '{"theme":',
      detail: 'refusing malformed payload: stdin is not valid JSON',
      seed: () => SEED,
    },
    {
      name: 'an array body',
      input: '[1,2]',
      detail: 'refusing malformed payload: expected a JSON object, got array',
      seed: () => SEED,
    },
    {
      name: 'a string body',
      input: '"nord"',
      detail: 'refusing malformed payload: expected a JSON object, got string',
      seed: () => SEED,
    },
    {
      name: 'a null body',
      input: 'null',
      detail: 'refusing malformed payload: expected a JSON object, got null',
      seed: () => SEED,
    },
    {
      name: 'a missing theme object',
      input: '{}',
      detail: 'refusing malformed payload: missing theme object',
      seed: () => SEED,
    },
    {
      name: 'a non-object theme',
      input: payload({ theme: 'nord' }),
      detail: 'refusing malformed payload: theme must be an object',
      seed: () => SEED,
    },
    {
      name: 'a non-string name',
      input: payload({ theme: { custom: {} } }),
      detail: 'refusing malformed payload: theme.name must be a string',
      seed: () => SEED,
    },
    {
      name: 'an unknown theme name',
      input: payload({ theme: { name: 'solarizedx' } }),
      detail: `refusing malformed payload: unknown theme "solarizedx"; expected one of ${THEMES.join(', ')}`,
      seed: () => SEED,
    },
    {
      name: 'a non-object custom',
      input: payload({ theme: { name: 'nord', custom: [] } }),
      detail: 'refusing malformed payload: theme.custom must be an object',
      seed: () => SEED,
    },
    {
      name: 'an unknown custom token',
      input: payload({ theme: { name: 'nord', custom: { background: '#000000' } } }),
      detail: 'refusing malformed payload: unknown custom token "background"',
      seed: () => SEED,
    },
    {
      name: 'a short hex value',
      input: payload({ theme: { name: 'nord', custom: { accent: '#12345' } } }),
      detail: 'refusing malformed payload: theme.custom.accent must be #rrggbb, got "#12345"',
      seed: () => SEED,
    },
    {
      name: 'a named color value',
      input: payload({ theme: { name: 'nord', custom: { text: 'white' } } }),
      detail: 'refusing malformed payload: theme.custom.text must be #rrggbb, got "white"',
      seed: () => SEED,
    },
    {
      name: 'a non-hex value',
      input: payload({ theme: { name: 'nord', custom: { panel_bg: '#gggggg' } } }),
      detail: 'refusing malformed payload: theme.custom.panel_bg must be #rrggbb, got "#gggggg"',
      seed: () => SEED,
    },
    {
      name: 'an extra top-level key',
      input: payload({ theme: { name: 'nord' }, custom: {} }),
      detail: 'refusing malformed payload: extra top-level key "custom"',
      seed: () => SEED,
    },
    {
      name: 'an unknown theme key',
      input: payload({ theme: { name: 'nord', palette: {} } }),
      detail: 'refusing malformed payload: unknown theme key "palette"',
      seed: () => SEED,
    },
  ];

  for (const refusal of refusals) {
    test(refusal.name, () => {
      fs.writeFileSync(configPath, refusal.seed());
      const before = readConfig();
      const r = run(['--apply', '--reload'], { input: refusal.input });
      assert.equal(r.status, 2);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, `configure-theme: ${refusal.detail}\n`);
      assert.equal(readConfig(), before, 'a refused apply never writes');
      assert.deepEqual(herdrCalls(), [], 'a refused apply never reloads');
    });
  }

  // TOML lets the SAME table path be spelled with a bare or a quoted key, and
  // Herdr reads `[theme]`, `["theme"]` and `['theme']` as one table. Every
  // spelling therefore has to be refused: a quoted table that slipped through
  // would get a second, managed `[theme]` appended below it, which is exactly
  // the silently broken config this refusal exists to prevent. One table drives
  // the bare and the quoted fixtures together, so the two can never drift apart.
  const FOREIGN_SPELLINGS = [
    ['[theme]', '[theme]\nname = "nord"\n'],
    ['["theme"]', '["theme"]\nname = "nord"\n'],
    ["['theme']", "['theme']\nname = \"nord\"\n"],
    ['[theme.custom]', '[theme.custom]\naccent = "#bd93f9"\n'],
    ['["theme.custom"]', '["theme.custom"]\naccent = "#bd93f9"\n'],
    ["['theme.custom']", "['theme.custom']\naccent = \"#bd93f9\"\n"],
  ];

  for (const [label, foreign] of FOREIGN_SPELLINGS) {
    test(`a user-owned ${label} table outside the markers`, () => {
      fs.writeFileSync(configPath, foreign);
      const r = run(['--apply', '--reload'], { input: payload({ theme: { name: 'nord' } }) });
      assert.equal(r.status, 2, `${label} must be refused, not adopted`);
      assert.equal(r.stdout, '');
      assert.equal(
        r.stderr,
        'configure-theme: refusing --apply: a [theme] or [theme.custom] table already exists outside the ' +
          'managed markers. This tool only manages its marked block; move or delete that table, then re-run.\n',
      );
      assert.equal(readConfig(), foreign, `${label}: a refusal never writes`);
      assert.deepEqual(herdrCalls(), [], `${label}: a refusal never reloads`);
    });
  }

  // The other half of the same rule: `theme = "..."` is a KEY, not a table. It
  // is legitimate inside the user's own table and must keep going through.
  test('a bare theme KEY in another table is not a foreign theme table', () => {
    const seeded = '[ui]\ntheme = "nord"\n';
    fs.writeFileSync(configPath, seeded);
    const r = run(['--apply'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readConfig(), `${seeded}\n${block('nord')}\n`);
  });

  test('an unterminated begin marker', () => {
    const seeded = `${SEED}\n${THEME_BEGIN}\n[theme]\nname = "nord"\n`;
    fs.writeFileSync(configPath, seeded);
    const r = run(['--apply', '--reload'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 2);
    assert.equal(
      r.stderr,
      'configure-theme: refusing --apply: managed theme markers are malformed (unterminated); fix them manually.\n',
    );
    assert.equal(readConfig(), seeded);
    assert.deepEqual(herdrCalls(), []);
  });

  test('an end marker without a begin marker', () => {
    const seeded = `${SEED}\n${THEME_END}\n`;
    fs.writeFileSync(configPath, seeded);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'nord' } }) }).status, 2);
    assert.equal(readConfig(), seeded);
  });

  test('a second managed block', () => {
    const seeded = `${SEED}\n${block('nord')}\n\n${block('nord')}\n`;
    fs.writeFileSync(configPath, seeded);
    const r = run(['--apply'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /malformed \(unterminated\)/);
    assert.equal(readConfig(), seeded);
  });

  test('an unknown flag', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run(['--bogus'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^configure-theme: unknown flag --bogus\n/);
    assert.match(r.stderr, /usage: node bin\/configure-theme\.js/);
    assert.equal(readConfig(), SEED, 'a rejected argv never writes');
  });

  test('two conflicting operations', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run(['--apply', '--remove'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /choose exactly one of --apply, --remove, --check/);
    assert.equal(readConfig(), SEED);
  });
});

describe('--json machine-readable result', () => {
  test('prints exactly one JSON line for an apply', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run(['--apply', '--reload', '--json'], { input: payload({ theme: { name: 'nord' } }) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(result, {
      op: 'apply',
      status: 'applied',
      file: configPath,
      theme: 'nord',
      changed: true,
      reloaded: true,
    });
  });

  test('reports an unchanged apply without reloading', () => {
    fs.writeFileSync(configPath, SEED);
    const body = payload({ theme: { name: 'nord' } });
    assert.equal(run(['--apply'], { input: body }).status, 0);
    const r = run(['--apply', '--reload', '--json'], { input: body });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      op: 'apply',
      status: 'current',
      file: configPath,
      theme: 'nord',
      changed: false,
      reloaded: false,
    });
    assert.deepEqual(herdrCalls(), []);
  });

  test('reports a refusal as JSON on stdout plus one stderr line', () => {
    fs.writeFileSync(configPath, SEED);
    const r = run(['--apply', '--json'], { input: payload({ theme: { name: 'nope' } }) });
    assert.equal(r.status, 2);
    const result = JSON.parse(r.stdout);
    assert.equal(result.op, 'apply');
    assert.equal(result.status, 'refused');
    assert.equal(result.changed, false);
    assert.match(result.error, /^refusing malformed payload: unknown theme "nope"/);
    assert.equal(r.stderr, `configure-theme: ${result.error}\n`);
    assert.equal(readConfig(), SEED);
  });
});

describe('config path resolution (S3: the same file the sidebar writer uses)', () => {
  test('falls back to $XDG_CONFIG_HOME/herdr/config.toml', () => {
    const xdg = path.join(sandbox, 'xdg');
    const r = run(['--apply'], {
      input: payload({ theme: { name: 'nord' } }),
      env: { HERDR_CONFIG_PATH: '', XDG_CONFIG_HOME: xdg },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(xdg, 'herdr', 'config.toml'), 'utf8'), `${block('nord')}\n`);
    assert.equal(r.stdout, `configure-theme: applied theme "nord" to ${path.join(xdg, 'herdr', 'config.toml')}\n`);
  });
});

describe('coexistence with the sidebar block (PRESERVE)', () => {
  test('applies the theme block without moving a single sidebar byte', () => {
    fs.writeFileSync(configPath, SEED);
    const withSidebar = applySidebarBlock();
    const r = run(['--apply', '--reload'], {
      input: payload({ theme: { name: 'nord', custom: { accent: '#81a1c1' } } }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readConfig(), `${withSidebar}\n${block('nord', ['accent = "#81a1c1"'])}\n`);
    assert.equal(readConfig().slice(0, withSidebar.length), withSidebar);
    // The sidebar CLI still sees its own block as current, byte for byte.
    const check = run(['--check'], { cli: SIDEBAR_CLI });
    assert.equal(check.status, 0, check.stderr);
    const sidebarApply = run(['--apply'], { cli: SIDEBAR_CLI });
    assert.equal(sidebarApply.status, 0, sidebarApply.stderr);
    assert.equal(sidebarApply.stdout, 'configure: managed pi-only override already current; nothing to do\n');
  });

  test('the sidebar uninstall removes only the sidebar block', () => {
    fs.writeFileSync(configPath, SEED);
    applySidebarBlock();
    const body = payload({ theme: { name: 'nord' } });
    assert.equal(run(['--apply'], { input: body }).status, 0);
    const r = run(['--uninstall'], { cli: SIDEBAR_CLI });
    assert.equal(r.status, 0, r.stderr);
    // The sidebar CLI's cut is line-based and leaves its own pre-block
    // separator blank line behind (unchanged behaviour); the theme block
    // must survive it byte for byte.
    assert.equal(readConfig(), `${SEED}\n\n${block('nord')}\n`);
    const check = run(['--check'], { input: body });
    assert.equal(check.status, 0, 'the theme block still checks current');
  });

  test('a sidebar re-apply leaves the theme block intact', () => {
    fs.writeFileSync(configPath, SEED);
    assert.equal(run(['--apply'], { input: payload({ theme: { name: 'nord' } }) }).status, 0);
    const themeBytes = `${SEED}\n${block('nord')}\n`;
    const sidebarApply = run(['--apply'], { cli: SIDEBAR_CLI });
    assert.equal(sidebarApply.status, 0, sidebarApply.stderr);
    assert.equal(readConfig().slice(0, themeBytes.length), themeBytes);
  });
});
