'use strict';
// extensions/herdr-theme-sync.ts — Herdr's palette follows the active Gentle
// Shell / Pi theme (odd/tasks/theme-sync.md T3b over S3/S4/S5/S7).
//
// Everything below is observed through the extension's own surface: the two
// hooks it registers (`session_start`, `session_shutdown`), the interval it
// starts, the `ctx.ui` calls it makes, and the process it actually spawns. The
// CLI stand-in is a real executable on disk, so "no spawn" and "one spawn with
// exactly this payload" are facts about the process table, not about a mock.
//
// What is pinned:
//   - S7: sync off with no theme reads the switch and does NOTHING — no spawn,
//     no write, no removal (the default install leaves Herdr's palette alone);
//   - S3: sync on applies the theme Pi is showing now, and a theme recoloured in
//     place (same name) applies again without restarting the session, while an
//     unchanged palette is not re-applied on every tick;
//   - S4: sync off applies the assigned theme by name, never the active one, and
//     an uninstalled name notifies once and applies nothing;
//   - S5: nothing in this file removes a managed block, so the palette Herdr has
//     when Pi closes is the last one applied;
//   - a refused CLI warns once per distinct failure and is not retried on the
//     next unchanged tick; an unresolvable plugin root warns once per session;
//   - an unreadable switch file is a refusal: nothing is spawned and the document
//     is left byte-identical;
//   - a token that is Pi's terminal default ("") or that cannot be converted is
//     omitted while the rest of the palette still applies;
//   - the tick is a 500 ms interval, unref'd, cleared on `session_shutdown`.
//
// The extension is TypeScript with exactly one package import, so the tests load
// a renamed copy with only that import line stubbed (the pattern
// tools/gentle-customize-command.test.js uses for the state sidecar). Every
// filesystem and process seam is an isolated temp directory: no live Herdr
// config, plugin root or state dir is ever touched.

const { describe, test, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'extensions', 'herdr-theme-sync.ts');
const srcText = fs.readFileSync(SRC, 'utf8');

// The fake mirrors the real contract closely enough to stay meaningful: it
// converts the `Color` record Pi's `Theme.colors` resolves to and rejects
// anything else, so a value it cannot convert is a value the extension must
// survive rather than crash on.
const COLOR_HEX_STUB = [
  'const colorToHex = (color) => {',
  '  if (!color || color.kind !== "rgb") throw new Error("colorToHex stub: not an rgb Color");',
  '  const channel = (value) => Math.round(value).toString(16).padStart(2, "0");',
  '  return "#" + channel(color.r) + channel(color.g) + channel(color.b);',
  '};',
].join('\n');
const stubbed = srcText.replace(/^import \{ colorToHex \} from "@earendil-works\/pi-tui";$/m, COLOR_HEX_STUB);
assert.notEqual(stubbed, srcText, 'expected the @earendil-works/pi-tui import line to be stubbed');
assert.equal(
  /from "@earendil-works\//.test(stubbed),
  false,
  'the pi-tui colour conversion must be the only host package import in this file',
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-theme-sync-'));
const COPY = path.join(ROOT, 'herdr-theme-sync.mjs');
fs.writeFileSync(COPY, stubbed);

// The copied module lives outside the repo, so the lib/ helpers are loaded
// through the documented override (same arrangement as GENTLE_CUSTOMIZE_LIB_DIR).
process.env.GENTLE_THEME_SYNC_LIB_DIR = path.join(REPO_ROOT, 'lib');
// The palette must follow outside a Herdr pane: this extension has no detection
// gate, so none of these may be present for the assertions to mean anything.
delete process.env.HERDR_ENV;
delete process.env.HERDR_PANE_ID;
delete process.env.HERDR_SOCKET_PATH;

const factoryPromise = import(pathToFileURL(COPY).href);

const ENV_KEYS = [
  'GENTLE_STATUS_STATE_DIR',
  'GENTLE_HERDR_PLUGIN_ROOT',
  'GENTLE_THEME_SYNC_LIB_DIR',
  'HERDR_BIN_PATH',
  'HERDR_CONFIG_PATH',
  'HERDR_PLUGIN_STATE_DIR',
  'XDG_STATE_HOME',
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'HERDR_SOCKET_PATH',
];
const BASE_ENV = ENV_KEYS.map((key) => [key, process.env[key]]);

function restoreEnv() {
  for (const [key, value] of BASE_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/* --------------------------------------------------------------- fixtures */

// Stand-in for herdr-plugin/bin/configure-theme.js. It records exactly what the
// extension spawned (argv + stdin + whether it looked like a Herdr pane) and
// replays the exit code and stderr the test asked for through control.json.
const FAKE_CLI = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
const control = JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8'));
fs.appendFileSync(
  path.join(here, 'spawns.jsonl'),
  JSON.stringify({
    argv: process.argv.slice(2),
    stdin: fs.readFileSync(0, 'utf8'),
    herdrEnv: process.env.HERDR_ENV ?? null,
    paneId: process.env.HERDR_PANE_ID ?? null,
  }) + '\\n',
);
if (control.exit !== 0) {
  if (control.stderr) process.stderr.write(control.stderr);
  process.exit(control.exit);
}
process.stdout.write(JSON.stringify({ op: 'apply', status: 'applied' }) + '\\n');
`;

function scratch(...segments) {
  const dir = path.join(ROOT, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A fake plugin root. Under GENTLE_HERDR_PLUGIN_ROOT the extension never asks
// `herdr plugin list`, so bin/configure-theme.js is the whole fixture.
function plugin(tag, control = { exit: 0, stderr: '' }) {
  const root = scratch(tag, 'plugin');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'configure-theme.js'), FAKE_CLI, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin', 'control.json'), JSON.stringify(control));
  return root;
}

function setControl(root, control) {
  fs.writeFileSync(path.join(root, 'bin', 'control.json'), JSON.stringify(control));
}

function spawns(root) {
  const log = path.join(root, 'bin', 'spawns.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// A herdr that knows no plugin: resolution must refuse instead of guessing. The
// stub also records that it was asked, so "it tried the documented route" is
// observable.
function herdrWithNoPlugin(tag) {
  const dir = scratch(tag);
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, 'herdr-calls.log'), process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(JSON.stringify({ plugins: [] }));
`,
    { mode: 0o755 },
  );
  process.env.HERDR_BIN_PATH = bin;
  return dir;
}

function herdrCalls(dir) {
  const log = path.join(dir, 'herdr-calls.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

// The persisted switch, in its own temp dir through the documented state-dir
// override, so no test can read or write the real plugin state.
function themeState(tag, doc) {
  const dir = scratch(tag, 'state');
  const file = path.join(dir, 'gentle-theme.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  process.env.GENTLE_STATUS_STATE_DIR = dir;
  return { dir, file };
}

/* ---------------------------------------------------------------- palette */

const rgb = (r, g, b) => ({ kind: 'rgb', r, g, b });

// The Pi side of the projection: exactly the roles HERDR_ROLE_SOURCES maps,
// with distinct colours so a mis-mapped token cannot hide.
const PALETTE = {
  accent: rgb(122, 162, 247),
  text: rgb(192, 202, 245),
  error: rgb(247, 118, 142),
  success: rgb(158, 206, 106),
  warning: rgb(224, 175, 104),
  mdLink: rgb(125, 207, 255),
  syntaxType: rgb(115, 218, 202),
  muted: rgb(169, 177, 214),
  thinkingText: rgb(86, 95, 137),
  borderAccent: rgb(187, 154, 247),
};

// The projection of PALETTE, in Herdr token order (muted paints subtext0 and
// overlay0 together; the surface tokens are never projected).
const EXPECTED_CUSTOM = {
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
  teal: '#73daca',
};

function piTheme(name, colors) {
  return { name, colors };
}

function context({ theme, themes = {} } = {}) {
  const notices = [];
  const ctx = {
    mode: 'tui',
    ui: {
      theme,
      getTheme: (name) => (Object.prototype.hasOwnProperty.call(themes, name) ? themes[name] : undefined),
      notify: (message, level) => notices.push([message, level ?? 'info']),
    },
  };
  return { ctx, notices };
}

/* ----------------------------------------------------------------- timers */

// The follower must unref its interval and clear it on shutdown, and a tick must
// be drivable directly instead of waiting half a second. Patching the globals is
// the seam that needs no production-only test hook: the extension resolves
// `setInterval` at call time, so the patch covers its own `session_start`.
let timeline = null;

function installTimers() {
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const intervals = [];
  globalThis.setInterval = (fn, ms) => {
    const handle = {
      fn,
      ms,
      unrefd: false,
      cleared: false,
      unref() {
        this.unrefd = true;
        return this;
      },
    };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    if (handle) handle.cleared = true;
  };
  timeline = {
    intervals,
    restore() {
      globalThis.setInterval = real.setInterval;
      globalThis.clearInterval = real.clearInterval;
      timeline = null;
    },
  };
  return timeline;
}

beforeEach(() => {
  installTimers();
});

afterEach(() => {
  if (timeline) timeline.restore();
  restoreEnv();
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- session */

async function startSession(ctx) {
  const handlers = new Map();
  const commands = [];
  const pi = {
    on: (kind, handler) => handlers.set(kind, [...(handlers.get(kind) ?? []), handler]),
    registerCommand: (name) => commands.push(name),
  };
  const factory = (await factoryPromise).default;
  assert.equal(typeof factory, 'function', 'the extension default-exports its factory');
  factory(pi);
  const starts = handlers.get('session_start') ?? [];
  assert.equal(starts.length, 1, 'the extension registers exactly one session_start handler');
  await starts[0]({ type: 'session_start' }, ctx);
  const shutdowns = handlers.get('session_shutdown') ?? [];
  assert.equal(shutdowns.length, 1, 'the extension registers exactly one session_shutdown handler');
  const handle = timeline.intervals.at(-1);
  assert.ok(handle, 'session_start starts a tick timer');
  return {
    handle,
    commands,
    tick: () => handle.fn(),
    shutdown: () => shutdowns[0]({ type: 'session_shutdown' }),
  };
}

/* ------------------------------------------------------------------ tests */

describe('package manifest', () => {
  test('declares the theme sync as a third Pi extension, after the existing pair', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.pi.extensions, [
      './extensions/gentle-herdr-state.ts',
      './extensions/herdr-session-open.ts',
      './extensions/herdr-theme-sync.ts',
    ]);
    assert.equal(pkg.files.includes('extensions'), true, 'the new extension ships with the package');
  });
});

describe('the switch is off (S7, S5)', () => {
  test('sync off with no theme assigned spawns nothing and writes nothing', async () => {
    const root = plugin('off');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    const { file } = themeState('off', { sync: false, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    running.tick();
    running.tick();

    assert.deepEqual(spawns(root), [], 'the default install never touches Herdr (S7)');
    assert.deepEqual(notices, [], 'and it says nothing either');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sync, false, 'the switch itself is untouched');
  });

  test('an unreadable switch is a refusal: nothing spawned, document untouched', async () => {
    const root = plugin('unreadable');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    const dir = scratch('unreadable', 'state');
    const file = path.join(dir, 'gentle-theme.json');
    fs.writeFileSync(file, '{"sync": tru');
    process.env.GENTLE_STATUS_STATE_DIR = dir;
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    running.tick();

    assert.deepEqual(spawns(root), [], 'a document this module cannot read is never acted on');
    assert.deepEqual(notices, []);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"sync": tru', 'and never edited');
  });
});

describe('the switch is on (S3)', () => {
  test('applies the active theme once, with the projected payload, then stays quiet', async () => {
    const root = plugin('on');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    themeState('on', { sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    const log = spawns(root);
    assert.equal(log.length, 1, 'session_start applies immediately, without waiting for a tick');
    assert.deepEqual(log[0].argv, ['--apply', '--json', '--reload']);
    assert.deepEqual(JSON.parse(log[0].stdin), { theme: { name: 'one-dark', custom: EXPECTED_CUSTOM } });
    assert.equal(log[0].herdrEnv, null, 'no pane gate: the palette follows outside a Herdr pane too');
    assert.deepEqual(notices, []);

    running.tick();
    running.tick();
    assert.equal(spawns(root).length, 1, 'an unchanged palette is never re-applied per tick');
  });

  test('a theme recoloured in place applies again under the same name', async () => {
    const root = plugin('recolour');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    themeState('recolour', { sync: true, theme: null });
    const { ctx } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    assert.equal(spawns(root).length, 1);

    ctx.ui.theme = piTheme('tokyo-night', { ...PALETTE, accent: rgb(1, 2, 3) });
    running.tick();

    const log = spawns(root);
    assert.equal(log.length, 2, 'the fingerprint changed, so the palette is applied again');
    const custom = JSON.parse(log[1].stdin).theme.custom;
    assert.equal(custom.accent, '#010203');
    assert.equal(custom.text, '#c0caf5', 'every other token rides along with the change');
  });

  test('a terminal default and an unconvertible token are omitted, the rest still applies', async () => {
    const root = plugin('boundary');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    themeState('boundary', { sync: true, theme: null });
    const { ctx } = context({
      theme: piTheme('boundary', { ...PALETTE, warning: '', error: { kind: 'broken' } }),
    });

    await startSession(ctx);

    const custom = JSON.parse(spawns(root)[0].stdin).theme.custom;
    assert.equal('yellow' in custom, false, 'a terminal default has no hex spelling');
    assert.equal('red' in custom, false, 'a conversion that throws costs only its own token');
    assert.equal(custom.accent, '#7aa2f7', 'the rest of the palette is still projected');
    assert.equal(custom.teal, '#73daca');
  });
});

describe('sync off with an assigned theme (S4)', () => {
  test('applies the assigned theme, never the one Pi is showing', async () => {
    const root = plugin('assigned');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    themeState('assigned', { sync: false, theme: 'nord' });
    const { ctx, notices } = context({
      theme: piTheme('tokyo-night', PALETTE),
      themes: { nord: piTheme('nord', { accent: rgb(136, 192, 208) }) },
    });

    await startSession(ctx);

    const log = spawns(root);
    assert.equal(log.length, 1);
    assert.deepEqual(JSON.parse(log[0].stdin), {
      theme: { name: 'one-dark', custom: { accent: '#88c0d0' } },
    });
    assert.deepEqual(notices, []);
  });

  test('an uninstalled theme notifies once and applies nothing', async () => {
    const root = plugin('missing');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    themeState('missing', { sync: false, theme: 'ghost' });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    running.tick();
    running.tick();

    assert.deepEqual(spawns(root), [], 'a name this install does not have applies nothing');
    assert.equal(notices.length, 1, 'a tick must never nag');
    assert.equal(notices[0][1], 'warning');
    assert.match(notices[0][0], /"ghost" is not installed/);
  });
});

describe('failures (once per distinct failure, never retried blind)', () => {
  test('a refused apply warns once and is not retried on the next unchanged tick', async () => {
    const root = plugin('refused', {
      exit: 2,
      stderr: 'configure-theme: foreign [theme] table in config.toml\n',
    });
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    themeState('refused', { sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    assert.equal(spawns(root).length, 1, 'the refusal did not crash the handler');
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'warning');
    assert.match(notices[0][0], /exited 2: configure-theme: foreign \[theme\] table in config\.toml/);

    running.tick();
    running.tick();
    assert.equal(spawns(root).length, 1, 'a failure is never retried automatically');
    assert.equal(notices.length, 1, 'and never reported twice');

    // The next observed change re-arms the follower: a failure does not wedge it.
    ctx.ui.theme = piTheme('tokyo-night', { ...PALETTE, accent: rgb(4, 5, 6) });
    setControl(root, { exit: 0, stderr: '' });
    running.tick();
    assert.equal(spawns(root).length, 2);
    assert.equal(notices.length, 1);
  });

  test('an unresolvable plugin root notifies once per session and applies nothing', async () => {
    const herdrDir = herdrWithNoPlugin('no-plugin');
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    themeState('no-plugin', { sync: true, theme: null });

    const running = await startSession(ctx);
    assert.ok(herdrCalls(herdrDir).length > 0, 'resolution goes through `herdr plugin list --json`');
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'warning');
    assert.match(notices[0][0], /could not resolve the installed plugin root/);

    // A real change is worth another attempt, but the user hears it only once.
    ctx.ui.theme = piTheme('tokyo-night', { ...PALETTE, accent: rgb(7, 8, 9) });
    running.tick();
    assert.equal(notices.length, 1, 'unresolvable stays silent for the rest of the session');
  });
});

describe('session lifecycle', () => {
  test('one 500 ms unref`d interval, cleared on session_shutdown', async () => {
    const root = plugin('timer');
    process.env.GENTLE_HERDR_PLUGIN_ROOT = root;
    themeState('timer', { sync: true, theme: null });
    const { ctx } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    assert.equal(timeline.intervals.length, 1, 'one timer per session');
    assert.equal(running.handle.ms, 500);
    assert.equal(running.handle.unrefd, true, 'a follower must not keep Pi alive');
    assert.equal(running.handle.cleared, false);

    running.shutdown();
    assert.equal(running.handle.cleared, true, 'shutdown clears the interval');
    assert.deepEqual(running.commands, [], 'the follower registers no command of its own');
  });
});

// S7 and S5 again, but with the SHIPPED writer instead of a stand-in: the
// extension pipes into the repository's own herdr-plugin/bin/configure-theme.js
// and the assertions are about a real config.toml on disk and a real spawned
// `herdr`. A stand-in proves the extension's own contract; only this arrangement
// proves the package left a user's Herdr config alone.
describe('the default install against the real plugin CLI (S7, S5)', () => {
  const THEME_BEGIN = '# BEGIN herdr-gentle-theme (managed; do not edit)';
  const THEME_END = '# END herdr-gentle-theme';
  // User content the writer must never move, adopt or delete.
  const USER_CONFIG = '[ui.sidebar.agents]\norder = ["pi"]\n';

  function realWriterFixture(tag) {
    const dir = scratch(tag);
    const stateDir = path.join(dir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, USER_CONFIG);
    const callLog = path.join(dir, 'herdr-calls.log');
    const bin = path.join(dir, 'fake-bin', 'herdr');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    // A recording stub: it writes down every argv and always succeeds.
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(path.join(__dirname, '..', 'herdr-calls.log'), process.argv.slice(2).join(' ') + '\\n');
`,
      { mode: 0o755 },
    );
    // The REAL plugin checkout, so the child process the extension spawns is the
    // shipped CLI rather than a fixture that could agree with it by accident.
    process.env.GENTLE_HERDR_PLUGIN_ROOT = path.join(REPO_ROOT, 'herdr-plugin');
    process.env.GENTLE_STATUS_STATE_DIR = stateDir;
    process.env.HERDR_CONFIG_PATH = configPath;
    process.env.HERDR_BIN_PATH = bin;
    return { dir, stateDir, configPath, callLog };
  }

  test('writes nothing without a switch, then applies once and keeps it after shutdown', async () => {
    const fixture = realWriterFixture('real-writer');
    const { ctx } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const stateFile = path.join(fixture.stateDir, 'gentle-theme.json');
    const configStat = fs.statSync(fixture.configPath);
    const envBefore = ENV_KEYS.map((key) => [key, process.env[key]]);
    const stateBefore = fs.readdirSync(fixture.stateDir);

    const running = await startSession(ctx);
    running.tick();
    running.tick();

    // S7: no gentle-theme.json at all is the default install, so the shipped CLI
    // is never asked and the user's config keeps its bytes, its identity and its
    // timestamp. `herdr-calls.log` is never even created, which is the proof that
    // nothing was spawned.
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), USER_CONFIG, 'the config is byte-identical');
    const afterStat = fs.statSync(fixture.configPath);
    assert.equal(afterStat.ino, configStat.ino, 'the same file, never rewritten');
    assert.equal(afterStat.mtimeMs, configStat.mtimeMs, 'not even touched');
    assert.equal(afterStat.size, configStat.size);
    assert.equal(fs.existsSync(stateFile), false, 'the switch file is never created');
    assert.deepEqual(fs.readdirSync(fixture.stateDir), stateBefore, 'the state dir listing is unchanged');
    assert.deepEqual(herdrCalls(fixture.dir), [], 'no herdr process ran at all');
    assert.deepEqual(
      ENV_KEYS.map((key) => [key, process.env[key]]),
      envBefore,
      'the follower sets and restores no environment variable of its own',
    );

    // The positive control: sync on makes the real writer run, so the inert
    // assertions above cannot pass merely because the writer is unreachable.
    fs.writeFileSync(stateFile, JSON.stringify({ sync: true, theme: null }));
    running.tick();

    const block = [
      THEME_BEGIN,
      '[theme]',
      'name = "one-dark"',
      '',
      '[theme.custom]',
      ...Object.entries(EXPECTED_CUSTOM).map(([token, value]) => `${token} = "${value}"`),
      THEME_END,
    ].join('\n');
    const applied = `${USER_CONFIG}\n${block}\n`;
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), applied, 'the projected palette reached the file');
    assert.deepEqual(herdrCalls(fixture.dir), ['server reload-config'], 'exactly one reload for one apply');

    // S5: closing Pi leaves the last palette in place and reloads nothing.
    running.shutdown();
    assert.equal(running.handle.cleared, true, 'shutdown clears the interval');
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), applied, 'the applied bytes survive shutdown');
    assert.deepEqual(herdrCalls(fixture.dir), ['server reload-config'], 'no second reload, no removal');
  });
});
