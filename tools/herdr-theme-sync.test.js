'use strict';
// extensions/herdr-theme-sync.ts — Herdr's palette follows the active Gentle
// Shell / Pi theme (odd/tasks/theme-sync-fix.md T3 over S3/S4/S7).
//
// Why the fixture is shaped this way: the shipped 1.8.0 follower piped a
// projection into `configure-theme.js` of the INSTALLED Herdr plugin, so a
// Pi-only update could not work (evidence E2) and its CLI refused the user's real
// config (E1). The rewritten follower applies in process, through the package's
// own `lib/herdr-theme-apply.js` + `lib/herdr-theme-config.js` — the REAL ones,
// not stand-ins. So every assertion here is about a real `config.toml` on disk
// and a real `herdr` process, in a temp directory under the documented
// `GENTLE_STATUS_STATE_DIR` / `HERDR_CONFIG_PATH` / `HERDR_BIN_PATH` overrides:
//
//   - S7: no switch store, or an explicit off document, leaves Herdr asleep —
//     the config keeps its bytes, inode and mtime, and no `herdr` runs at all;
//   - S3: sync on writes the active theme's projection in place, keeps the values
//     it does not own, requests exactly one reload, and says so once; a palette
//     recoloured in place applies again, silently; an unchanged tick does nothing;
//   - S4: a pinned theme applies THAT theme's palette, and an uninstalled name
//     notifies once per session and writes nothing;
//   - a planner refusal is reported once with its exact text, the bytes are
//     untouched and it is not retried on the next unchanged tick;
//   - not inside Herdr / an SSH session / an unsupported binary is reported once
//     per session through the availability reason `applyHerdrTheme` decides, with
//     no write — the follower has no pane gate of its own;
//   - a subagent child registers nothing at all: its Pi must never write the
//     user's config;
//   - turning the sync off keeps the last applied palette (S7).
//
// The extension is TypeScript with exactly one package import, so the tests load
// a renamed copy with only that import line stubbed (the pattern
// tools/gentle-customize-command.test.js uses for the state sidecar). The stub is
// asserted to have applied, because a silently unstubbed copy would fail on the
// import instead of exercising the follower.

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

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-theme-sync-')));
const COPY = path.join(ROOT, 'herdr-theme-sync.mjs');
fs.writeFileSync(COPY, stubbed);

// The copied module lives outside the repo, so the lib/ helpers are loaded
// through the documented override (same arrangement as GENTLE_CUSTOMIZE_LIB_DIR).
process.env.GENTLE_THEME_SYNC_LIB_DIR = path.join(REPO_ROOT, 'lib');

const factoryPromise = import(pathToFileURL(COPY).href);

const ENV_KEYS = [
  'GENTLE_STATUS_STATE_DIR',
  'GENTLE_THEME_SYNC_LIB_DIR',
  'GENTLE_PI_AGENTS_CHILD',
  'HERDR_BIN_PATH',
  'HERDR_CONFIG_PATH',
  'HERDR_PLUGIN_STATE_DIR',
  'XDG_STATE_HOME',
  'XDG_CONFIG_HOME',
  'HERDR_ENV',
  'HERDR_PANE_ID',
  'HERDR_SOCKET_PATH',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'SSH_TTY',
];
const BASE_ENV = ENV_KEYS.map((key) => [key, process.env[key]]);

function restoreEnv() {
  for (const [key, value] of BASE_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// An SSH session is one of the reasons `applyHerdrTheme` refuses; it must not
// depend on how the developer happened to connect to this machine.
for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete process.env[key];

/* --------------------------------------------------------------- fixtures */

function scratch(...segments) {
  const dir = path.join(ROOT, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The user's real config shape (evidence E1): an existing `[theme]` table with a
// name, `auto_switch = false` and a `[theme.custom]` synced from DMS/Niri. The
// values the projection does not own (`panel_bg`, `blue`, `auto_switch`) must
// survive every apply untouched.
function userConfig({ autoSwitch = 'false' } = {}) {
  return [
    '[theme]',
    'name = "catppuccin"',
    '',
    `auto_switch = ${autoSwitch}`,
    '[theme.custom]',
    'panel_bg = "#1a1b26"',
    'accent = "#7aa2f7"',
    'blue = "#7aa2f7"',
    '',
  ].join('\n');
}

// A recording `herdr`: it appends one line per invocation to `herdr-argv.log`, so
// "no reload" and "exactly one reload with this argv" are facts about a process
// table, not about a mock. `exit` lets one test fail the reload stage.
function herdrBinary(logPath, exitCode = 0) {
  return ['#!/bin/sh', `printf '%s\\n' "$*" >> '${logPath}'`, `exit ${exitCode}`, ''].join('\n');
}

function fixture(tag, options = {}) {
  const dir = scratch(tag);
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, options.config ?? userConfig(), { mode: 0o640 });
  const argvLog = path.join(dir, 'herdr-argv.log');
  const bin = path.join(dir, 'bin', 'herdr');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, herdrBinary(argvLog, options.herdrExit ?? 0), { mode: 0o755 });
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  process.env.HERDR_ENV = '1';
  process.env.HERDR_PANE_ID = 'pane-1';
  // Absolute, and it need not exist: the guard is about resolvability, not liveness.
  process.env.HERDR_SOCKET_PATH = path.join(dir, 'herdr.sock');
  process.env.HERDR_BIN_PATH = bin;
  process.env.HERDR_CONFIG_PATH = configPath;
  process.env.GENTLE_STATUS_STATE_DIR = stateDir;
  delete process.env.GENTLE_PI_AGENTS_CHILD;

  const stateFile = path.join(stateDir, 'gentle-theme.json');
  return {
    dir,
    configPath,
    stateDir,
    stateFile,
    bin,
    bytes: () => fs.readFileSync(configPath, 'utf8'),
    stat: () => fs.statSync(configPath),
    calls: () =>
      fs.existsSync(argvLog)
        ? fs.readFileSync(argvLog, 'utf8').split('\n').filter((line) => line.trim() !== '')
        : [],
    writeState: (doc) => fs.writeFileSync(stateFile, JSON.stringify(doc)),
    setHerdrExit: (code) => fs.writeFileSync(bin, herdrBinary(argvLog, code), { mode: 0o755 }),
  };
}

/* ---------------------------------------------------------------- palette */

const rgb = (r, g, b) => ({ kind: 'rgb', r, g, b });

// A Pi palette naming every role our own 1.8.0 map used. The extra roles
// (`warning`, `mdLink`, `syntaxType`) are concrete on purpose: the projection must
// still not emit `yellow`, `blue` or `teal` (that mapping is what recoloured
// Herdr's status and notification colours).
const PALETTE = {
  accent: rgb(125, 207, 255),
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

/* ------------------------------------------------------------- stub writer */

// The follower's own decisions — when to attempt an apply, and when to demand a
// reload — are what the last two describes assert, so the writer's answer is data
// instead of filesystem. The stub is a real module in a temp `lib/` directory that
// GENTLE_THEME_SYNC_LIB_DIR points at, so the extension loads it exactly the way
// it loads the real writer; `__pending` lets one test hold the initial apply open
// (the shutdown race). `control.defer` keeps every answer deferred.
const STUB_WRITER = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
const pending = [];
function applyHerdrTheme(options) {
  fs.appendFileSync(path.join(here, 'applies.jsonl'), JSON.stringify(options) + '\\n');
  const control = JSON.parse(fs.readFileSync(path.join(here, 'control.json'), 'utf8'));
  const queue = control.results ?? [];
  const result = queue.shift() ?? { status: 'requested' };
  fs.writeFileSync(path.join(here, 'control.json'), JSON.stringify({ ...control, results: queue }));
  if (!control.defer) return Promise.resolve(result);
  return new Promise((resolve) => pending.push(() => resolve(result)));
}
module.exports = { applyHerdrTheme, __pending: pending };
`;

function stubLib(tag, { results = [], defer = false } = {}) {
  const dir = scratch(tag, 'lib');
  // The real store and projection: only the writer is stubbed, so every assertion
  // here is still about the shipped palette and switch semantics.
  for (const name of ['theme-store.js', 'theme-projection.js']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'lib', name), path.join(dir, name));
  }
  const control = path.join(dir, 'control.json');
  const log = path.join(dir, 'applies.jsonl');
  fs.writeFileSync(control, JSON.stringify({ results, defer }));
  fs.writeFileSync(path.join(dir, 'herdr-theme-apply.js'), STUB_WRITER);
  process.env.GENTLE_THEME_SYNC_LIB_DIR = dir;
  return {
    dir,
    applies: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
        : [],
    // The very module instance the extension required: `__pending` is the queue of
    // deferred answers, so a test can end the initial apply at a chosen moment.
    stub: () => require(path.join(dir, 'herdr-theme-apply.js')),
  };
}

/* ---------------------------------------------------------------- session */

// Registration is separate from starting, because one test has to shut the
// session down WHILE the initial evaluation is still in flight.
async function registerSession(ctx) {
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
  const shutdowns = handlers.get('session_shutdown') ?? [];
  assert.equal(shutdowns.length, 1, 'the extension registers exactly one session_shutdown handler');
  return {
    commands,
    start: () => starts[0]({ type: 'session_start' }, ctx),
    shutdown: () => shutdowns[0]({ type: 'session_shutdown' }),
  };
}

async function startSession(ctx) {
  const session = await registerSession(ctx);
  // The handler is awaited: the apply is asynchronous (the reload is a child
  // process), and the first evaluation happens before the first tick.
  await session.start();
  const handle = timeline.intervals.at(-1);
  assert.ok(handle, 'session_start starts a tick timer');
  return {
    handle,
    commands: session.commands,
    tick: () => handle.fn(),
    shutdown: session.shutdown,
  };
}

// The exact config the user's file becomes under sync, asserted byte for byte.
// The planner's contracted shape, in one document: a value the user ALREADY had is
// replaced in place and remembered by one `# herdr-gentle-shell: was <key> = ...`
// line (name, accent); a value the user did NOT have is written inside ONE marked
// block at the end of `[theme.custom]` (text, red, green, subtext0, overlay0,
// overlay1, mauve); everything else — `panel_bg`, `blue`, `auto_switch`, blank
// lines and ordering — is untouched.
const APPLIED_CONFIG = [
  '[theme]',
  '# herdr-gentle-shell: was name = "catppuccin"',
  'name = "one-dark"',
  '',
  'auto_switch = false',
  '[theme.custom]',
  'panel_bg = "#1a1b26"',
  '# herdr-gentle-shell: was accent = "#7aa2f7"',
  'accent = "#7dcfff"',
  'blue = "#7aa2f7"',
  '# herdr-gentle-shell: begin',
  'text = "#c0caf5"',
  'red = "#f7768e"',
  'green = "#9ece6a"',
  'subtext0 = "#a9b1d6"',
  'overlay0 = "#a9b1d6"',
  'overlay1 = "#565f89"',
  'mauve = "#bb9af7"',
  '# herdr-gentle-shell: end',
  '',
].join('\n');

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

  test('the follower carries no plugin-side writer: no plugin root, no spawn, no CLI', () => {
    // Evidence E2 in one assertion: an artifact of the separately installed Herdr
    // plugin cannot be part of a Pi-only update, so no such reference may return.
    // Comments are excluded: the file documents the removed route on purpose.
    const code = srcText
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    for (const forbidden of [
      'herdr plugin list',
      'configure-theme',
      'GENTLE_HERDR_PLUGIN_ROOT',
      'spawnSync',
      'child_process',
    ]) {
      assert.equal(code.includes(forbidden), false, `extensions/herdr-theme-sync.ts must not reference ${forbidden}`);
    }
    // The one process-environment switch this file may still read is its own guard.
    assert.equal(code.includes('GENTLE_PI_AGENTS_CHILD'), true);
  });
});

describe('the switch is off (S7)', () => {
  test('no store file at all leaves Herdr untouched', async () => {
    const fx = fixture('off');
    const before = fx.stat();
    const listing = fs.readdirSync(fx.stateDir);
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    await running.tick();
    await running.tick();

    assert.equal(fx.bytes(), userConfig(), 'the user config is byte-identical');
    const afterStat = fx.stat();
    assert.equal(afterStat.ino, before.ino, 'the same file, never rewritten');
    assert.equal(afterStat.mtimeMs, before.mtimeMs, 'not even touched');
    assert.deepEqual(fx.calls(), [], 'no herdr process ran at all');
    assert.deepEqual(fs.readdirSync(fx.stateDir), listing, 'the switch store is never created');
    assert.deepEqual(notices, [], 'the default install says nothing');
  });

  test('an explicit off document is equally inert', async () => {
    const fx = fixture('off-explicit');
    fx.writeState({ sync: false, theme: null });
    const before = fx.stat();
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    await running.tick();

    assert.equal(fx.bytes(), userConfig(), 'sync off with nothing assigned is not a request to write');
    assert.equal(fx.stat().ino, before.ino);
    assert.equal(fx.stat().mtimeMs, before.mtimeMs);
    assert.deepEqual(fx.calls(), []);
    assert.deepEqual(notices, []);
  });

  test('an unreadable switch is a refusal: nothing written, document untouched', async () => {
    const fx = fixture('unreadable');
    fs.writeFileSync(fx.stateFile, '{"sync": tru');
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    await running.tick();

    assert.equal(fx.bytes(), userConfig(), 'a document this package cannot read is never acted on');
    assert.deepEqual(fx.calls(), []);
    assert.deepEqual(notices, []);
    assert.equal(fs.readFileSync(fx.stateFile, 'utf8'), '{"sync": tru', 'and never edited');
  });
});

describe('the switch is on (S3)', () => {
  test('writes the projected palette in place, reloads once and says so', async () => {
    const fx = fixture('on');
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    await startSession(ctx);

    assert.equal(fx.bytes(), APPLIED_CONFIG, 'the active theme reached the user config, in place');    assert.equal(fx.bytes().includes('auto_switch = false'), true, 'a setting this writer does not own survives');
    assert.equal(fx.bytes().includes('blue = "#7aa2f7"'), true, 'an unmapped custom token survives');
    assert.deepEqual(fx.calls(), ['server reload-config'], 'exactly one reload for one apply');
    assert.deepEqual(notices, [['Herdr theme applied: tokyo-night; reload requested', 'info']]);
  });

  test('a second tick with nothing changed writes and reloads nothing', async () => {
    const fx = fixture('quiet-tick');
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);
    const applied = fx.stat();

    await running.tick();
    await running.tick();

    assert.equal(fx.stat().ino, applied.ino, 'the file was not rewritten');
    assert.equal(fx.stat().mtimeMs, applied.mtimeMs);
    assert.deepEqual(fx.calls(), ['server reload-config'], 'an unchanged palette never reloads Herdr');
    assert.equal(notices.length, 1, 'and never notifies again');
  });

  test('a palette recoloured in place under the same name writes again, silently', async () => {
    const fx = fixture('recolour');
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);
    assert.equal(notices.length, 1, 'the first apply was the user\'s switch, so it was announced');

    // Same theme NAME, different colours: exactly how Pi recolours in place.
    ctx.ui.theme = piTheme('tokyo-night', { ...PALETTE, accent: rgb(1, 2, 3) });
    await running.tick();

    assert.equal(fx.bytes().includes('accent = "#010203"'), true, 'the new palette was applied');
    assert.equal(fx.bytes().includes('text = "#c0caf5"'), true, 'every other token rides along');
    assert.deepEqual(fx.calls(), ['server reload-config', 'server reload-config'], 'one reload per real change');
    assert.equal(notices.length, 1, 'a palette-only change is not a user action, so it is silent');
  });

  test('a terminal default and an unconvertible token are omitted, the rest still applies', async () => {
    // A minimal config, so an omitted token cannot hide behind a line the user's
    // own file already had.
    const fx = fixture('boundary', { config: '[theme]\nname = "catppuccin"\n' });
    fx.writeState({ sync: true, theme: null });
    const { ctx } = context({
      theme: piTheme('boundary', { ...PALETTE, accent: '', error: { kind: 'broken' } }),
    });

    await startSession(ctx);

    const applied = fx.bytes();
    assert.equal(applied.includes('accent ='), false, 'a terminal default has no hex spelling');
    assert.equal(applied.includes('red ='), false, 'a conversion that throws costs only its own token');
    assert.equal(applied.includes('text = "#c0caf5"'), true, 'the rest of the palette is still projected');
  });

  test('turning the sync off keeps the last applied palette (S7)', async () => {
    const fx = fixture('off-after-on');
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);
    const appliedStat = fx.stat();
    assert.equal(fx.bytes(), APPLIED_CONFIG);

    fx.writeState({ sync: false, theme: null });
    await running.tick();
    await running.tick();

    assert.equal(fx.bytes(), APPLIED_CONFIG, 'nothing here ever removes a managed block');
    assert.equal(fx.stat().ino, appliedStat.ino);
    assert.equal(fx.stat().mtimeMs, appliedStat.mtimeMs);
    assert.deepEqual(fx.calls(), ['server reload-config'], 'no reload, no revert');
    assert.equal(notices.length, 1, 'and no notice about a palette that stayed put');
  });
});

describe('sync off with an assigned theme (S4)', () => {
  test('applies the assigned theme, never the one Pi is showing', async () => {
    const fx = fixture('assigned');
    fx.writeState({ sync: false, theme: 'nord' });
    const { ctx, notices } = context({
      theme: piTheme('tokyo-night', PALETTE),
      themes: { nord: piTheme('nord', { accent: rgb(136, 192, 208) }) },
    });

    await startSession(ctx);

    assert.equal(
      fx.bytes(),
      [
        '[theme]',
        '# herdr-gentle-shell: was name = "catppuccin"',
        'name = "one-dark"',
        '',
        'auto_switch = false',
        '[theme.custom]',
        'panel_bg = "#1a1b26"',
        '# herdr-gentle-shell: was accent = "#7aa2f7"',
        'accent = "#88c0d0"',
        'blue = "#7aa2f7"',
        '',
      ].join('\n'),
      'only the assigned theme\'s own tokens are projected',
    );
    assert.equal(fx.bytes().includes('#c0caf5'), false, 'the active theme\'s palette is not used');
    assert.deepEqual(fx.calls(), ['server reload-config']);
    assert.deepEqual(notices, [['Herdr theme applied: nord; reload requested', 'info']]);
  });

  test('an uninstalled theme notifies once and writes nothing', async () => {
    const fx = fixture('missing');
    fx.writeState({ sync: false, theme: 'ghost' });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    await running.tick();
    await running.tick();

    assert.equal(fx.bytes(), userConfig(), 'a name this install does not have applies nothing');
    assert.deepEqual(fx.calls(), []);
    assert.equal(notices.length, 1, 'a tick must never nag');
    // The WHOLE notice, destination included: `/herdr-gentle:customize` is
    // registered unconditionally (odd/tasks/herdr-customize-page.md S4), so it is
    // the only surface this test's setup can name — and the bytes are 865d360's.
    assert.deepEqual(notices, [[
      "The Pi theme \"ghost\" is not installed, so Herdr's palette was left unchanged; pick an installed theme in /herdr-gentle:customize.",
      'warning',
    ]]);
    assert.equal(notices[0][0].includes('customize menu'), false, 'no message names a menu that may be absent');
  });
});

describe('failures are visible, once per distinct text (S3)', () => {
  test('a planner refusal reports its exact text, leaves the bytes and is not retried', async () => {
    const fx = fixture('refused', { config: userConfig({ autoSwitch: 'true' }) });
    fx.writeState({ sync: true, theme: null });
    const before = fx.stat();
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    await running.tick();
    await running.tick();

    assert.deepEqual(notices, [
      [
        'Herdr theme not applied: line 4: `auto_switch` is only supported as `auto_switch = false`; no changes proposed.',
        'warning',
      ],
    ]);
    assert.equal(fx.bytes(), userConfig({ autoSwitch: 'true' }), 'a refusal never writes');
    assert.equal(fx.stat().ino, before.ino);
    assert.equal(fx.stat().mtimeMs, before.mtimeMs);
    assert.deepEqual(fx.calls(), [], 'and never reloads');

    // A refusal is not a wedge: the next STORED change is still observed. The user
    // fixed the file and picked a theme in the panel.
    fs.writeFileSync(fx.configPath, userConfig());
    fx.writeState({ sync: false, theme: 'nord' });
    ctx.ui.getTheme = (name) => (name === 'nord' ? piTheme('nord', { accent: rgb(136, 192, 208) }) : undefined);
    await running.tick();

    assert.equal(fx.bytes().includes('accent = "#88c0d0"'), true, 'the stored change applied');
    assert.deepEqual(fx.calls(), ['server reload-config']);
    assert.deepEqual(notices.at(-1), ['Herdr theme applied: nord; reload requested', 'info']);
  });

  test('a reload failure says the config was written, and a later success clears it', async () => {
    const fx = fixture('reload-fails', { herdrExit: 1 });
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    assert.equal(fx.bytes(), APPLIED_CONFIG, 'the write is committed before the reload');
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'warning');
    // A restart loses the owed-reload flag, so the notice names the command that
    // repairs it by hand.
    assert.equal(
      notices[0][0].endsWith(" Run 'herdr server reload-config' to apply it."),
      true,
      `the reload notice must name the manual repair: ${notices[0][0]}`,
    );
    assert.match(notices[0][0], /^Herdr theme written; Herdr reload failed: /);

    await running.tick();
    assert.equal(notices.length, 1, 'an unchanged tick never repeats the warning');

    fx.setHerdrExit(0);
    ctx.ui.theme = piTheme('tokyo-night', { ...PALETTE, accent: rgb(9, 9, 9) });
    await running.tick();
    assert.equal(notices.length, 1, 'the palette-only success is silent, and the failure was cleared');

    // A NEW failure is news again: the text is distinct from the first one.
    fx.setHerdrExit(3);
    ctx.ui.theme = piTheme('tokyo-night', { ...PALETTE, accent: rgb(8, 8, 8) });
    await running.tick();
    assert.equal(notices.length, 2);
    assert.equal(notices[1][1], 'warning');
    assert.match(notices[1][0], /^Herdr theme written; Herdr reload failed: /);
    assert.equal(notices[1][0].endsWith(" Run 'herdr server reload-config' to apply it."), true);
  });
});

describe('availability is decided by the writer, never guessed here (S3, S4)', () => {
  test('outside a Herdr pane: one informational notice, no write', async () => {
    const fx = fixture('not-herdr');
    fx.writeState({ sync: true, theme: null });
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    const before = fx.stat();
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    await running.tick();
    await running.tick();

    assert.deepEqual(notices, [[
      'Herdr theme sync is inactive: this Pi session is not inside a Herdr pane.',
      'info',
    ]], 'once per session, at info: it is a state, not an error the user caused');
    assert.equal(fx.bytes(), userConfig(), 'a Pi session outside Herdr writes nothing');
    assert.equal(fx.stat().ino, before.ino);
    assert.deepEqual(fx.calls(), []);
  });

  test('an SSH session says Herdr reads its config on another machine', async () => {
    const fx = fixture('remote');
    fx.writeState({ sync: false, theme: 'nord' });
    process.env.SSH_CONNECTION = '10.0.0.1 22 10.0.0.2 22';
    const { ctx, notices } = context({
      theme: piTheme('tokyo-night', PALETTE),
      themes: { nord: piTheme('nord', { accent: rgb(136, 192, 208) }) },
    });

    const running = await startSession(ctx);
    await running.tick();

    assert.deepEqual(notices, [[
      'Herdr theme sync is inactive: this is a remote session and Herdr reads its config on another machine.',
      'info',
    ]]);
    assert.equal(fx.bytes(), userConfig(), 'a pinned theme is not written either');
    assert.deepEqual(fx.calls(), []);
  });

  test('an unsupported environment says so instead of writing a guess', async () => {
    const fx = fixture('unsupported');
    fx.writeState({ sync: true, theme: null });
    // A build-tree binary belongs to whoever develops Herdr, not to this user.
    process.env.HERDR_BIN_PATH = path.join(fx.dir, 'bin', 'herdr-dev');
    fs.writeFileSync(process.env.HERDR_BIN_PATH, herdrBinary(path.join(fx.dir, 'unused.log')), { mode: 0o755 });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    await running.tick();

    assert.deepEqual(notices, [['Herdr theme sync is not supported in this environment.', 'info']]);
    assert.equal(fx.bytes(), userConfig());
    assert.deepEqual(fx.calls(), []);
  });
});

describe('the child guard', () => {
  test('a subagent child registers no hook and no timer', async () => {
    const fx = fixture('child');
    fx.writeState({ sync: true, theme: null });
    process.env.GENTLE_PI_AGENTS_CHILD = '1';
    const handlers = new Map();
    const pi = { on: (kind) => handlers.set(kind, (handlers.get(kind) ?? 0) + 1) };
    const factory = (await factoryPromise).default;

    factory(pi);

    assert.deepEqual([...handlers.entries()], [], 'nothing is registered at all');
    assert.deepEqual(timeline.intervals, [], 'no timer, so no tick can ever write');
    assert.equal(fx.bytes(), userConfig(), 'a child never touches the user\'s config');
    assert.deepEqual(fx.calls(), []);
  });
});

describe('session lifecycle', () => {
  test('one 500 ms unref`d interval, cleared on session_shutdown; the palette survives', async () => {
    const fx = fixture('timer');
    fx.writeState({ sync: true, theme: null });
    const { ctx } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const running = await startSession(ctx);
    assert.equal(timeline.intervals.length, 1, 'one timer per session');
    assert.equal(running.handle.ms, 500);
    assert.equal(running.handle.unrefd, true, 'a follower must not keep Pi alive');
    assert.equal(running.handle.cleared, false);
    assert.deepEqual(running.commands, [], 'the follower registers no command of its own');

    running.shutdown();
    assert.equal(running.handle.cleared, true, 'shutdown clears the interval');
    assert.equal(fx.bytes(), APPLIED_CONFIG, 'the applied bytes survive shutdown');
    assert.deepEqual(fx.calls(), ['server reload-config'], 'no second reload, no removal');
  });

  test('flipping the stored sync on after startup is picked up by the next tick', async () => {
    const fx = fixture('flip-on');
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);
    assert.equal(fx.bytes(), userConfig(), 'still off at startup');

    fx.writeState({ sync: true, theme: null });
    await running.tick();

    assert.equal(fx.bytes(), APPLIED_CONFIG, 'the stored change is observed without a restart');
    assert.deepEqual(fx.calls(), ['server reload-config']);
    assert.deepEqual(notices, [['Herdr theme applied: tokyo-night; reload requested', 'info']]);
  });
});

// The verifier's corrections. Each of these is a way the follower could decide,
// wrongly, when the user's config is rewritten or Herdr is reloaded.
describe('turning the sync off and back on (F1)', () => {
  test('re-applies after the user repaired the config a refusal named', async () => {
    const fx = fixture('reenable', { config: userConfig({ autoSwitch: 'true' }) });
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);
    assert.match(notices[0][0], /^Herdr theme not applied: line 4: /);

    // Off with nothing pinned is inert, and it must also FORGET what it applied:
    // otherwise the next "on" looks unchanged and the palette never returns.
    fx.writeState({ sync: false, theme: null });
    await running.tick();
    assert.equal(fx.bytes(), userConfig({ autoSwitch: 'true' }), 'turning the sync off still writes nothing');

    // The user repaired the config the refusal named; palette and theme name are
    // untouched, so only the on-transition can trigger the apply.
    fs.writeFileSync(fx.configPath, userConfig());
    fx.writeState({ sync: true, theme: null });
    await running.tick();

    assert.equal(fx.bytes(), APPLIED_CONFIG, 'the repaired config received the palette');
    assert.deepEqual(fx.calls(), ['server reload-config']);
    assert.deepEqual(notices.at(-1), ['Herdr theme applied: tokyo-night; reload requested', 'info']);
  });

  test('re-enabling with an already-matching config is a harmless unchanged', async () => {
    const fx = fixture('reenable-matching');
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);
    const applied = fx.stat();
    assert.equal(fx.bytes(), APPLIED_CONFIG);

    fx.writeState({ sync: false, theme: null });
    await running.tick();
    fx.writeState({ sync: true, theme: null });
    await running.tick();

    // The apply DOES run (the record was reset); the writer answers `unchanged`,
    // so nothing is rewritten, reloaded or announced.
    assert.equal(fx.bytes(), APPLIED_CONFIG);
    assert.equal(fx.stat().ino, applied.ino, 'the identical document is not rewritten');
    assert.equal(fx.stat().mtimeMs, applied.mtimeMs);
    assert.deepEqual(fx.calls(), ['server reload-config'], 'an unchanged apply never reloads');
    assert.equal(notices.length, 1, 'and never announces a no-op');
  });
});

describe('a failed reload is repaired by the next apply (F2)', () => {
  test('an unchanged config is reloaded with forceReload and reports requested', async () => {
    const fx = fixture('reload-owed', { herdrExit: 1 });
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);

    // The write committed and the reload failed. The config now already matches the
    // projection, so without forceReload every later plan would be `unchanged` and
    // Herdr would stay out of date for the rest of the session.
    assert.equal(fx.bytes(), APPLIED_CONFIG, 'the write is committed before the reload');
    assert.deepEqual(fx.calls(), ['server reload-config'], 'the one reload that failed');
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'warning');
    assert.match(notices[0][0], /^Herdr theme written; Herdr reload failed: /);
    assert.equal(notices[0][0].endsWith(" Run 'herdr server reload-config' to apply it."), true);

    // An unchanged tick still invents no apply attempt.
    await running.tick();
    assert.deepEqual(fx.calls(), ['server reload-config']);

    const applied = fx.stat();
    fx.setHerdrExit(0);

    // The off -> on transition is the next apply attempt, and the config it sees is
    // byte-identical to the projection: only the forced reload can repair Herdr.
    fx.writeState({ sync: false, theme: null });
    await running.tick();
    assert.deepEqual(fx.calls(), ['server reload-config'], 'turning the sync off reloads nothing');

    fx.writeState({ sync: true, theme: null });
    await running.tick();

    assert.equal(fx.bytes(), APPLIED_CONFIG, 'repairing a reload never rewrites an identical config');
    assert.equal(fx.stat().ino, applied.ino, 'forceReload skips the write');
    assert.equal(fx.stat().mtimeMs, applied.mtimeMs);
    assert.deepEqual(fx.calls(), ['server reload-config', 'server reload-config'], 'the owed reload ran');
    assert.equal(notices.length, 2, 'the on-transition is a user action, so its success is announced');
    assert.deepEqual(notices.at(-1), ['Herdr theme applied: tokyo-night; reload requested', 'info']);
  });
});

describe('switching to another projection (stale tokens)', () => {
  // The second Pi theme maps fewer roles AND has no accent at all, so one plan has
  // to do both halves of the reconciliation: drop what the first projection added
  // and give back what the user had before we replaced it.
  const SECOND_CONFIG = [
    '[theme]',
    '# herdr-gentle-shell: was name = "catppuccin"',
    'name = "one-dark"',
    '',
    'auto_switch = false',
    '[theme.custom]',
    'panel_bg = "#1a1b26"',
    'accent = "#7aa2f7"',
    'blue = "#7aa2f7"',
    '# herdr-gentle-shell: begin',
    'text = "#010203"',
    'subtext0 = "#040506"',
    'overlay0 = "#040506"',
    '# herdr-gentle-shell: end',
    '',
  ].join('\n');

  test('a token that leaves the projection disappears and a replaced value comes back', async () => {
    const fx = fixture('switch-projection');
    fx.writeState({ sync: true, theme: null });
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', PALETTE) });
    const running = await startSession(ctx);
    assert.equal(fx.bytes(), APPLIED_CONFIG, 'the first projection owns its absent tokens in the block');

    ctx.ui.theme = piTheme('nord', { text: rgb(1, 2, 3), muted: rgb(4, 5, 6) });
    await running.tick();

    assert.equal(fx.bytes(), SECOND_CONFIG, 'one plan reconciles both directions');
    // The stale-token defect, one token at a time: a token the first projection
    // added and the second does not carry must be gone, not merely unmentioned.
    for (const token of ['red', 'green', 'overlay1', 'mauve']) {
      assert.equal(
        new RegExp(`^${token} = `, 'm').test(fx.bytes()),
        false,
        `${token} from the first projection is stale`,
      );
    }
    // The user's own accent was replaced IN PLACE with a `was` marker; both the
    // value and the removal of the marker belong to leaving that projection.
    assert.equal(fx.bytes().includes('accent = "#7aa2f7"'), true, 'the user\'s own value was restored');
    assert.equal(fx.bytes().includes('was accent'), false, 'and the marker went with it');
    assert.equal(fx.bytes().includes('panel_bg = "#1a1b26"'), true, 'untouched user tokens still survive');
    // A palette-only switch stays quiet, and Herdr is told once per real change.
    assert.equal(notices.length, 1, 'switching while sync is on is not a user-configured switch');
    assert.deepEqual(fx.calls(), ['server reload-config', 'server reload-config']);
  });
});

describe('a palette with nothing to project (F3)', () => {
  test('a live theme with no concrete colour applies nothing and warns once', async () => {
    const fx = fixture('colourless');
    fx.writeState({ sync: true, theme: null });
    const before = fx.stat();
    const { ctx, notices } = context({ theme: piTheme('tokyo-night', { accent: '' }) });

    const running = await startSession(ctx);
    await running.tick();

    assert.deepEqual(notices, [
      ['Herdr theme not applied: tokyo-night has no concrete colours to project.', 'warning'],
    ]);
    assert.equal(fx.bytes(), userConfig(), 'the theme name is not rewritten without a palette to go with it');
    assert.equal(fx.stat().ino, before.ino);
    assert.equal(fx.stat().mtimeMs, before.mtimeMs);
    assert.deepEqual(fx.calls(), [], 'and certainly not reloaded');
  });

  test('a pinned theme with no concrete colour is refused the same way', async () => {
    const fx = fixture('colourless-pinned');
    fx.writeState({ sync: false, theme: 'nord' });
    const { ctx, notices } = context({
      theme: piTheme('tokyo-night', PALETTE),
      themes: { nord: piTheme('nord', {}) },
    });

    await startSession(ctx);

    assert.deepEqual(notices, [
      ['Herdr theme not applied: nord has no concrete colours to project.', 'warning'],
    ]);
    assert.equal(fx.bytes(), userConfig());
    assert.deepEqual(fx.calls(), []);
  });
});

describe('a shutdown during the initial apply (F4)', () => {
  test('no timer is armed when session_shutdown races session_start', async () => {
    const fx = fixture('shutdown-race');
    fx.writeState({ sync: true, theme: null });
    const lib = stubLib('shutdown-race', { defer: true, results: [{ status: 'requested' }] });
    const { ctx } = context({ theme: piTheme('tokyo-night', PALETTE) });

    const session = await registerSession(ctx);
    // Deliberately NOT awaited: the initial evaluation is waiting on the writer,
    // which is exactly the window a shutdown can land in.
    const started = session.start();
    assert.equal(lib.applies().length, 1, 'the initial apply reached the writer');

    session.shutdown();
    lib.stub().__pending.shift()();
    await started;

    assert.deepEqual(timeline.intervals, [], 'a stopped session must never arm a tick that would keep writing');
  });
});
