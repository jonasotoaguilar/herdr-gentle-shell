'use strict';
// `/herdr-gentle:customize` after the cleanup: exactly two switches, both
// local state, both reachable from a plain Pi session outside a Herdr pane.
//
// What these tests pin, through the command's own public surface only (the
// registered handler plus `ctx.ui.select`/`ctx.ui.notify`/`ctx.reload`):
// - the command is registered BEFORE the `enabled()` pane gate, so a closed
//   gate still exposes it and registers nothing else;
// - `customize status` prints one read-only line and writes nothing;
// - an unknown argument is refused and writes nothing;
// - a cancelled menu writes nothing at all;
// - the Moshi enable path runs the `moshi-hook` prerequisite gate BEFORE any
//   write, so a refusal leaves the flag file and settings.json byte-identical;
// - disabling needs no gate and converges the flag and the owned exclusion;
// - a Pi reload happens only when the settings exclusion entry actually
//   changed;
// - the sidebar switch drives the Herdr plugin's own
//   `bin/configure.js --check|--apply --reload|--uninstall --reload`;
// - the theme rows (theme-sync T3a, S1/S2/S4/S7) write only
//   `gentle-theme.json`: the toggle never reloads Pi, the theme value opens the
//   host's own theme list and is refused while the sync is on, and every
//   refusal or cancellation leaves the file byte-identical.
//
// The restored floating panel (odd/tasks/restore-customize-panel.md T1) adds
// one more path, pinned below through `ctx.ui.custom` only: no argument opens
// the former two-pane overlay with the exact options, its factory renders and
// navigates both switches, Esc writes nothing, and Enter runs the same single
// apply path the menu uses. The menu itself stays the fallback when the TUI
// helpers or `ctx.ui.custom` are unavailable.
//
// The extension is TypeScript with one package import that is unresolvable
// under plain node, so the tests load a renamed copy with exactly that import
// line srcText (same approach as tools/gentle-herdr-state.test.js). Every
// filesystem and process seam is an isolated temp directory; no live Herdr
// config, state dir or `moshi-hook` is ever touched.

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..');
const src = path.join(REPO_ROOT, 'extensions', 'gentle-herdr-state.ts');
const srcText = fs.readFileSync(src, 'utf8');
assert.ok(
  !/^import .* from "\.\//m.test(srcText),
  'state.ts must stay self-contained (no relative imports)',
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-customize-'));
// The copied extension lives outside the repo, so the panel helper is loaded
// from the real lib/ through the documented override.
process.env.GENTLE_CUSTOMIZE_LIB_DIR = path.join(REPO_ROOT, 'lib');
const COPY = path.join(ROOT, 'gentle-herdr-state.mjs');
fs.writeFileSync(COPY, srcText);
const copyUrl = pathToFileURL(COPY).href;

// The whole point of the command: it must work outside a Herdr pane. The
// module-level pane binding is captured at import, so it is cleared first.
delete process.env.HERDR_ENV;
delete process.env.HERDR_SOCKET_PATH;
delete process.env.HERDR_PANE_ID;
const factoryPromise = import(copyUrl);

const MANAGED_BEGIN = '# BEGIN herdr-gentle-agents (managed; do not edit)';
const MANAGED_END = '# END herdr-gentle-agents';
// The exact block the shipped configure.js writes, so `--check` accepts the
// fixture as current instead of assuming a hand-written shape.
const MANAGED_BLOCK = require('../herdr-plugin/bin/configure.js').MANAGED_BLOCK;
const MOSHI_ENTRY = '-extensions/moshi-hooks.ts';
// S2 (odd/tasks/herdr-customize-page.md): with no bridge the command IS the
// surface, so its refusals name `/herdr-gentle:customize` — byte for byte the
// text 865d360 shipped. The page's own wording is pinned in
// tools/customize-bridge-page.test.js.
const MISSING_CLI_TEXT =
  'Moshi notifications cannot be enabled: the `moshi-hook` CLI was not found on PATH; install the Moshi CLI, then re-apply On from /herdr-gentle:customize.';
const NOT_PAIRED_TEXT =
  'Moshi notifications cannot be enabled: `moshi-hook status --json` reports paired:false (this device is not paired); run `moshi-hook pair --token <pairing-token>`, then re-apply On from /herdr-gentle:customize.';

const COMMAND = 'herdr-gentle:customize';

// The theme picker's "no theme assigned" entry. It is deliberately distinct from
// `Off`, the label the row paints for a stored `null`: a theme may be called
// `Off`, and reusing that spelling as the sentinel would shadow the theme.
const THEME_UNASSIGN = 'Off (no theme assigned)';

// The panel rows the command offers before the first prompt; the theme rows are
// part of it so the feature is reachable without `ctx.ui.custom`.
const MENU_OPTIONS = ['Sidebar agent rows', 'Moshi notifications', 'Theme sync', 'Gentle Shell theme'];

/* ------------------------------------------------------------ fixtures */

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

// Paths are recomputed per test: each one is a fresh temp directory.
function fixture(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function harness({ customImpl, themes, getTheme } = {}) {
  const commands = new Map();
  const notices = [];
  const selections = [];
  const customs = [];
  const reloads = [];
  const handlerKinds = [];
  const handlers = new Map();
  const pi = {
    on: (kind, handler) => {
      handlerKinds.push(kind);
      const list = handlers.get(kind) ?? [];
      if (typeof handler === 'function') list.push(handler);
      handlers.set(kind, list);
      return () => {};
    },
    events: { on: () => {}, emit: () => {} },
    registerCommand: (name, definition) => commands.set(name, definition),
  };
  const ui = {
    notify: (message, level) => notices.push([message, level ?? 'info']),
    select: async () => selections.shift(),
  };
  // The host's theme catalogue: `{ name, path }` records, exactly the shape
  // `ctx.ui.getAllThemes()` documents. A test that omits it simulates a host
  // without the accessor.
  if (themes !== undefined) ui.getAllThemes = () => themes;
  // The host's per-theme palette reader. A test that omits it simulates a host
  // whose themes cannot be previewed, which must read `Preview unavailable`.
  if (typeof getTheme === 'function') ui.getTheme = getTheme;
  if (typeof customImpl === 'function') {
    ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  const ctx = { ui, reload: async () => reloads.push(true) };
  const h = { pi, ctx, commands, notices, selections, customs, reloads, handlerKinds, handlers };
  // Pi's own order: the factory returns, then `session_start` arrives. The
  // command is registered by the factory itself (S1/S2); the session only adds
  // the Gentle Shell page when the bridge answers the handshake.
  h.start = async () => {
    for (const handler of handlers.get('session_start') ?? []) {
      await handler({ reason: 'startup' }, ctx);
    }
  };
  return h;
}

let moduleCache = null;
async function loadExtension(h) {
  if (moduleCache === null) moduleCache = await factoryPromise;
  moduleCache.default(h.pi);
  return moduleCache;
}

async function run(h, args) {
  await loadExtension(h);
  await h.start();
  const command = h.commands.get(COMMAND);
  assert.ok(command, `${COMMAND} was not registered`);
  await command.handler(args, h.ctx);
}

function noticeTexts(h) {
  return h.notices.map(([message]) => message);
}

// The pi-tui shape the panel consumes; inputs arrive as plain strings.
const stubTui = {
  visibleWidth: (s) => [...String(s)].length,
  truncateToWidth: (s, w) => {
    const chars = [...String(s)];
    return chars.length > w ? chars.slice(0, w).join('') : String(s);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

// Drive the component the way the host does: factory(hostTui, theme,
// keybindings, done), keystrokes through handleInput and the result through
// done(). A component that never finishes fails fast instead of hanging.
function openPanel(factory, hostTui = {}, theme = {}) {
  let settled = 'pending';
  const component = factory(hostTui, theme, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  return { component, done: () => settled };
}

// Enter confirms an option behind the panel's busy guard and the panel stays
// open, so every test waits for the apply instead of assuming a tick.
async function settlePanel(component) {
  for (let attempt = 0; attempt < 400 && component.state.busy; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(component.state.busy, false, 'the panel apply settled');
}

before(() => {
  // The real artifact the sidebar switch drives, plus a fake `herdr` for the
  // `--reload` leg: the plugin root is the repository checkout, the config is
  // a temp file, and the binary only records its argv.
  fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Every test owns an isolated state dir, agent dir, PATH and Herdr config.
  for (const key of [
    'GENTLE_STATUS_STATE_DIR',
    'GENTLE_PI_AGENT_HOME',
    'GENTLE_HERDR_PLUGIN_ROOT',
    'HERDR_CONFIG_PATH',
    'HERDR_BIN_PATH',
    'HERDR_GENTLE_TEST_PAIRING',
  ]) {
    delete process.env[key];
  }
});

function setupEnvironment(name, { moshiHooks = true } = {}) {
  const dir = fixture(name);
  const stateDir = path.join(dir, 'state');
  const agentDir = path.join(dir, 'agent');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  if (moshiHooks) {
    fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'extensions', 'moshi-hooks.ts'), '// moshi hook\n');
  }
  process.env.GENTLE_STATUS_STATE_DIR = stateDir;
  process.env.GENTLE_PI_AGENT_HOME = agentDir;
  process.env.GENTLE_HERDR_PLUGIN_ROOT = path.join(REPO_ROOT, 'herdr-plugin');
  process.env.GENTLE_CUSTOMIZE_LIB_DIR = path.join(REPO_ROOT, 'lib');
  const configPath = path.join(dir, 'config.toml');
  process.env.HERDR_CONFIG_PATH = configPath;
  const callLog = path.join(dir, 'herdr-calls.log');
  const herdrBin = path.join(dir, 'fake-bin', 'herdr');
  writeExecutable(herdrBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callLog}"\nexit 0\n`);
  process.env.HERDR_BIN_PATH = herdrBin;
  const pathDir = path.join(dir, 'path-bin');
  fs.mkdirSync(pathDir, { recursive: true });
  process.env.PATH = pathDir;
  return {
    dir,
    stateDir,
    agentDir,
    configPath,
    callLog,
    pathDir,
    settingsPath: path.join(agentDir, 'settings.json'),
    flagPath: path.join(stateDir, 'gentle-moshi.json'),
  };
}

// A `moshi-hook` stand-in: `status --json` prints the pairing document the
// scenario asked for. Nothing else is ever called by the gate.
function installMoshiHook(pathDir, { paired }) {
  const statusJson = JSON.stringify({ paired, secretStore: 'keychain', hooks: [] });
  writeExecutable(
    path.join(pathDir, 'moshi-hook'),
    `#!/bin/sh\nif [ "$1" = "status" ]; then printf '%s\\n' '${statusJson}'; exit 0; fi\nexit 1\n`,
  );
}

function writeSettings(file, doc) {
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function readSettings(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The theme store's one document, in the same state dir the Moshi flag uses.
function themePath(env) {
  return path.join(env.stateDir, 'gentle-theme.json');
}

function writeThemeFile(env, doc) {
  fs.writeFileSync(themePath(env), `${JSON.stringify(doc, null, 2)}\n`);
}

function readThemeFile(env) {
  return JSON.parse(fs.readFileSync(themePath(env), 'utf8'));
}

/* ------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers the command in the factory, before the pane gate and before any session event', async () => {
    const h = harness();
    await loadExtension(h);
    // S1/S2: the command exists before `session_start` arrives — exactly as on
    // 865d360. Nothing about the bridge, the page or a session can remove it.
    assert.ok(h.commands.has(COMMAND), 'the command must register at factory time, outside a Herdr pane');
    assert.match(h.commands.get(COMMAND).description, /sidebar agent rows/);
    assert.match(h.commands.get(COMMAND).description, /Moshi notifications/);

    await h.start();
    assert.ok(h.commands.has(COMMAND), 'and a session never removes it');
    // The pane gate is closed in this process, so the factory must have returned
    // after binding the customize page's own events: no producer handler was bound.
    assert.deepEqual(h.handlerKinds, ['session_start', 'session_shutdown']);
  });

  test('registers the command even when a bridge answers the handshake', async () => {
    // S1: the page is ADDITIVE. The handshake, not a package dependency, is a
    // frozen object at the bridge's published key, and it changes nothing about
    // the command (tools/customize-bridge-page.test.js owns the page itself).
    const providers = [];
    const published = {
      schema: 'gentle-shell-bridge/api',
      version: 1,
      registerRows: (provider) => {
        providers.push(provider);
        return () => {};
      },
      registerSection: () => {},
      createStore: () => {},
    };
    const key = Symbol.for('gentle-shell-bridge/api/v1');
    globalThis[key] = Object.freeze(published);
    try {
      const h = harness();
      await loadExtension(h);
      assert.ok(h.commands.has(COMMAND), 'the command registers at factory time');
      await h.start();
      assert.equal(h.commands.has(COMMAND), true, 'the page never replaces it');
      assert.equal(providers.length, 1, 'and the page is contributed beside it');
    } finally {
      delete globalThis[key];
    }
  });
});

describe('status', () => {
  test('reports both switches in one read-only line', async () => {
    const env = setupEnvironment('status');
    fs.writeFileSync(env.configPath, '');
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness();
    await run(h, 'status');
    assert.deepEqual(noticeTexts(h), ['customize status: sidebar=off moshi=off theme-sync=off theme=none']);
    assert.deepEqual(h.reloads, []);
    // Read-only: no flag file, no theme store, no settings write, no config write.
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.existsSync(themePath(env)), false, 'a status read never creates the theme store');
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
  });

  test('reads the stored theme state in the same line', async () => {
    const env = setupEnvironment('status-theme');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: true, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const themeBefore = fs.readFileSync(themePath(env), 'utf8');
    const h = harness({ themes: [{ name: 'nord' }] });
    await run(h, 'status');
    assert.deepEqual(noticeTexts(h), ['customize status: sidebar=off moshi=off theme-sync=on theme=dracula']);
    assert.equal(fs.readFileSync(themePath(env), 'utf8'), themeBefore, 'status writes nothing');
    assert.deepEqual(h.reloads, []);
  });

  test('an unreadable theme store reads unknown, never a guessed value', async () => {
    const env = setupEnvironment('status-theme-unknown');
    fs.writeFileSync(env.configPath, '');
    fs.writeFileSync(themePath(env), '{not json');
    const h = harness();
    await run(h, 'status');
    assert.deepEqual(noticeTexts(h), ['customize status: sidebar=off moshi=off theme-sync=unknown theme=unknown']);
  });

  test('reads the managed sidebar block through configure.js --check', async () => {
    const env = setupEnvironment('status-on');
    fs.writeFileSync(env.configPath, MANAGED_BLOCK);
    const configBefore = fs.readFileSync(env.configPath, 'utf8');
    const h = harness();
    await run(h, 'status');
    assert.deepEqual(noticeTexts(h), ['customize status: sidebar=on moshi=off theme-sync=off theme=none']);
    assert.equal(fs.readFileSync(env.configPath, 'utf8'), configBefore);
  });
});

describe('refusals', () => {
  test('refuses an unknown argument and writes nothing', async () => {
    const env = setupEnvironment('unknown-arg');
    writeSettings(env.settingsPath, { extensions: [] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness();
    h.selections.push('Moshi notifications');
    await run(h, 'bogus');
    assert.deepEqual(noticeTexts(h), [
      'Unknown option "bogus". Use /herdr-gentle:customize or /herdr-gentle:customize status.',
    ]);
    assert.deepEqual(h.notices.map(([, level]) => level), ['error']);
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
    assert.deepEqual(h.reloads, []);
  });

  test('a cancelled menu writes nothing at all', async () => {
    const env = setupEnvironment('esc');
    writeSettings(env.settingsPath, { extensions: [] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness();
    h.selections.push(undefined);
    await run(h, '');
    assert.deepEqual(noticeTexts(h), []);
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
    assert.deepEqual(h.reloads, []);
  });

  test('an unsupported Moshi prereq answer refuses and writes nothing', async () => {
    const env = setupEnvironment('moshi-status-failed');
    installMoshiHook(env.pathDir, { paired: false });
    // paired:false is the not-paired leg; the status-failed leg comes from a
    // CLI whose status output is not JSON.
    writeExecutable(
      path.join(env.pathDir, 'moshi-hook'),
      `#!/bin/sh\nprintf '%s\\n' 'not json'\nexit 0\n`,
    );
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness();
    h.selections.push('Moshi notifications', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [
      'Moshi notifications cannot be enabled: `moshi-hook status --json` did not confirm pairing (produced no parseable JSON); make sure the Moshi CLI is installed and paired (`moshi-hook pair --token <pairing-token>`), then re-apply On from /herdr-gentle:customize.',
    ]);
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
    assert.deepEqual(h.reloads, []);
  });
});

describe('moshi switch', () => {
  test('enabling without moshi-hook on PATH refuses and writes nothing', async () => {
    const env = setupEnvironment('moshi-no-cli');
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness();
    h.selections.push('Moshi notifications', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [MISSING_CLI_TEXT]);
    assert.deepEqual(h.notices.map(([, level]) => level), ['error']);
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
    assert.deepEqual(h.reloads, []);
  });

  test('enabling while unpaired refuses with the paired:false message and writes nothing', async () => {
    const env = setupEnvironment('moshi-unpaired');
    installMoshiHook(env.pathDir, { paired: false });
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness();
    h.selections.push('Moshi notifications', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [NOT_PAIRED_TEXT]);
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
    assert.deepEqual(h.reloads, []);
  });

  test('enabling when paired writes the flag, adds the exclusion and reloads', async () => {
    const env = setupEnvironment('moshi-enable');
    installMoshiHook(env.pathDir, { paired: true });
    writeSettings(env.settingsPath, { extensions: ['keep-me'], other: { keep: true } });
    const h = harness();
    h.selections.push('Moshi notifications', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [
      `Moshi notifications enabled. added ${MOSHI_ENTRY}. Reloading now to apply the change.`,
    ]);
    assert.equal(readSettings(env.flagPath).enabled, true);
    const settings = readSettings(env.settingsPath);
    assert.deepEqual(settings.extensions, ['keep-me', MOSHI_ENTRY]);
    assert.deepEqual(settings.other, { keep: true });
    assert.equal(h.reloads.length, 1);
  });

  test('enabling never reloads when the exclusion entry was already present', async () => {
    const env = setupEnvironment('moshi-enable-no-reload');
    installMoshiHook(env.pathDir, { paired: true });
    writeSettings(env.settingsPath, { extensions: [MOSHI_ENTRY] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness();
    h.selections.push('Moshi notifications', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), ['Moshi notifications enabled. exclusion already present.']);
    assert.equal(readSettings(env.flagPath).enabled, true);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
    assert.deepEqual(h.reloads, []);
  });

  test('disabling skips the gate and converges the flag and exclusion', async () => {
    const env = setupEnvironment('moshi-disable');
    // No `moshi-hook` on PATH at all: disabling must not consult the gate.
    fs.writeFileSync(env.flagPath, `${JSON.stringify({ enabled: true })}\n`);
    writeSettings(env.settingsPath, { extensions: ['keep-me', MOSHI_ENTRY], other: { keep: true } });
    const h = harness();
    h.selections.push('Moshi notifications', 'Off');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [
      `Moshi notifications disabled. removed ${MOSHI_ENTRY}. Reloading now to apply the change.`,
    ]);
    assert.equal(readSettings(env.flagPath).enabled, false);
    const settings = readSettings(env.settingsPath);
    assert.deepEqual(settings.extensions, ['keep-me']);
    assert.deepEqual(settings.other, { keep: true });
    assert.equal(h.reloads.length, 1);
  });
});

describe('sidebar switch', () => {
  test('applies and removes the managed rows through configure.js', async () => {
    const env = setupEnvironment('sidebar-toggle');
    fs.writeFileSync(env.configPath, '[ui.sidebar.agents]\nignored = true\n');

    const on = harness();
    on.selections.push('Sidebar agent rows', 'On');
    await run(on, '');
    assert.deepEqual(noticeTexts(on), [
      'Sidebar agent rows enabled; the managed block is in place and Herdr reloaded its config.',
    ]);
    const applied = fs.readFileSync(env.configPath, 'utf8');
    assert.ok(applied.includes(MANAGED_BEGIN) && applied.includes(MANAGED_END));
    assert.match(applied, /^\[ui\.sidebar\.agents\]$/m);
    assert.deepEqual(on.reloads, []);

    const off = harness();
    off.selections.push('Sidebar agent rows', 'Off');
    await run(off, '');
    assert.deepEqual(noticeTexts(off), [
      'Sidebar agent rows disabled; the managed block is gone and Herdr reloaded its config.',
    ]);
    const removed = fs.readFileSync(env.configPath, 'utf8');
    assert.equal(removed.includes(MANAGED_BEGIN), false);
    assert.match(removed, /^\[ui\.sidebar\.agents\]$/m);

    // Both changes asked Herdr to reload its config, and nothing else was run.
    const calls = fs.readFileSync(env.callLog, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['server reload-config', 'server reload-config']);
  });

  test('the shared apply path leaves the theme store alone', async () => {
    // PRESERVE (theme-sync T3a): the apply path now routes three switches, so the
    // untouched sidebar switch is pinned to write only its own state.
    const env = setupEnvironment('sidebar-leaves-theme-store');
    fs.writeFileSync(env.configPath, '[ui.sidebar.agents]\nignored = true\n');
    const h = harness();
    h.selections.push('Sidebar agent rows', 'On');
    await run(h, '');
    assert.equal(fs.existsSync(themePath(env)), false, 'the sidebar switch writes no theme state');
    assert.deepEqual(h.reloads, []);
  });

  test('reporting "already enabled" writes nothing', async () => {
    const env = setupEnvironment('sidebar-already');
    const on = harness();
    on.selections.push('Sidebar agent rows', 'On');
    await run(on, '');
    const applied = fs.readFileSync(env.configPath, 'utf8');
    const callsBefore = fs.readFileSync(env.callLog, 'utf8');

    const again = harness();
    again.selections.push('Sidebar agent rows', 'On');
    await run(again, '');
    assert.deepEqual(noticeTexts(again), [
      'Sidebar agent rows already enabled; nothing was changed.',
    ]);
    assert.equal(fs.readFileSync(env.configPath, 'utf8'), applied);
    assert.equal(fs.readFileSync(env.callLog, 'utf8'), callsBefore);
  });
});

test('customize menu offers both switches, the theme rows and On/Off', async () => {
  const h = harness();
  const offered = [];
  const queueNext = h.ctx.ui.select;
  h.ctx.ui.select = async (title, options) => {
    offered.push([title, options]);
    return queueNext();
  };
  h.selections.push('Moshi notifications', 'Off');
  await run(h, '');
  assert.deepEqual(offered.map(([, options]) => options), [
    MENU_OPTIONS,
    ['On', 'Off'],
  ]);
  assert.equal(offered[0][0], 'Customize · Herdr Gentle Shell');
  assert.equal(offered[1][0], 'Moshi notifications (currently off)');
});

describe('theme sync switch', () => {
  test('the toggle writes the theme store and never reloads Pi', async () => {
    const env = setupEnvironment('theme-sync-on');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness();
    h.selections.push('Theme sync', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), ["Theme sync on; Herdr's palette follows the theme active in Pi."]);
    assert.deepEqual(h.notices.map(([, level]) => level), ['info']);
    const doc = readThemeFile(env);
    assert.equal(doc.sync, true);
    assert.equal(doc.theme, 'dracula', 'the assigned theme is preserved across the toggle');
    assert.match(doc.updatedAt, /^\d{4}-\d{2}-\d{2}T/, 'the store stamps its own timestamp');
    assert.deepEqual(h.reloads, [], 'a theme change never reloads Pi');
    assert.equal(fs.existsSync(env.flagPath), false, 'the theme switch writes no Moshi flag');
  });

  test('turning the sync off keeps the theme the user had assigned', async () => {
    const env = setupEnvironment('theme-sync-off');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: true, theme: 'nord', updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness();
    h.selections.push('Theme sync', 'Off');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), ["Theme sync off; Herdr keeps the palette it was last given."]);
    const doc = readThemeFile(env);
    assert.equal(doc.sync, false);
    assert.equal(doc.theme, 'nord');
    assert.deepEqual(h.reloads, []);
  });

  test('reporting "already on" writes nothing', async () => {
    const env = setupEnvironment('theme-sync-already');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: true, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const before = fs.readFileSync(themePath(env), 'utf8');
    const h = harness();
    h.selections.push('Theme sync', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), ['Theme sync already on; nothing was changed.']);
    assert.equal(fs.readFileSync(themePath(env), 'utf8'), before);
    assert.deepEqual(h.reloads, []);
  });
});

describe('theme selection', () => {
  test('refuses while the sync is on and leaves the store byte-identical', async () => {
    const env = setupEnvironment('theme-select-refused');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: true, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const before = fs.readFileSync(themePath(env), 'utf8');
    const h = harness({ themes: [{ name: 'nord' }] });
    const offered = [];
    const queueNext = h.ctx.ui.select;
    h.ctx.ui.select = async (title, options) => {
      offered.push([title, options]);
      return queueNext();
    };
    h.selections.push('Gentle Shell theme');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), ['Turn Theme sync off to pick a specific theme.']);
    assert.deepEqual(h.notices.map(([, level]) => level), ['warning']);
    assert.equal(fs.readFileSync(themePath(env), 'utf8'), before, 'the refusal writes nothing');
    assert.deepEqual(offered.map(([, options]) => options), [MENU_OPTIONS], 'the theme list never opens');
    assert.deepEqual(h.reloads, []);
  });

  test('lists the host themes in host order, deduplicated and without subdirectory names', async () => {
    const env = setupEnvironment('theme-select-choose');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({
      themes: [
        { name: 'zeta', path: '/themes/zeta.json' },
        { name: 'alpha' },
        { name: 'nested/theme' },
        { name: 'alpha', path: '/themes/alpha-light.json' },
      ],
    });
    const offered = [];
    const queueNext = h.ctx.ui.select;
    h.ctx.ui.select = async (title, options) => {
      offered.push([title, options]);
      return queueNext();
    };
    h.selections.push('Gentle Shell theme', 'zeta');
    await run(h, '');
    // S2: Pi's own order is kept and a name under a subdirectory is not a theme.
    assert.deepEqual(offered[1], ['Gentle Shell theme', ['zeta', 'alpha', THEME_UNASSIGN]]);
    const doc = readThemeFile(env);
    assert.equal(doc.sync, false, 'a pinned theme never turns the sync on');
    assert.equal(doc.theme, 'zeta');
    assert.deepEqual(h.reloads, []);
    assert.equal(fs.existsSync(env.flagPath), false);
  });

  // A user theme may legitimately be called `Off`, the label the row paints for
  // "no theme assigned". The picker sentinel must therefore be a different
  // entry, or selecting that theme would be read as clearing the pin and the
  // theme would be unpinnable.
  test('a theme named Off is pinned, not read as "unassign"', async () => {
    const env = setupEnvironment('theme-select-named-off');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({ themes: [{ name: 'Off' }, { name: 'nord' }] });
    h.selections.push('Gentle Shell theme', 'Off');
    await run(h, '');
    const doc = readThemeFile(env);
    assert.equal(doc.theme, 'Off', 'the real theme named Off is written as the assigned theme');
    assert.equal(doc.sync, false);
    assert.deepEqual(h.reloads, []);
  });

  test('the picker\'s unassign entry is its own label and writes an unassigned theme', async () => {
    const env = setupEnvironment('theme-select-off');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({ themes: [{ name: 'Off' }, { name: 'nord' }] });
    const prompts = [];
    // The command appends its unassign entry AFTER the sorted theme list, so
    // answering with the last option proves that exactly this entry unassigns.
    h.ctx.ui.select = async (title, options) => {
      prompts.push([title, options]);
      if (prompts.length === 1) return 'Gentle Shell theme';
      return options[options.length - 1];
    };
    await run(h, '');
    const options = prompts[1][1];
    assert.deepEqual(options.slice(0, 2), ['Off', 'nord'], 'every real theme keeps its own entry');
    assert.notEqual(options[2], 'Off', 'the unassign entry never claims the Off theme name');
    assert.equal(new Set(options).size, options.length, 'the unassign entry cannot collide with a theme name');
    const doc = readThemeFile(env);
    assert.equal(doc.theme, null, 'the unassign entry means no theme is assigned');
    assert.equal(doc.sync, false);
    assert.deepEqual(h.reloads, []);
    // `Off` stays the STORED-value label the panel paints, so the confirmation
    // still speaks about Off even though the picker entry is spelled differently.
    assert.match(noticeTexts(h)[0], /theme set to Off/);
  });

  test('a theme named like the unassign entry still gets its own entry', async () => {
    const env = setupEnvironment('theme-select-sentinel-collision');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({ themes: [{ name: THEME_UNASSIGN }] });
    const prompts = [];
    h.ctx.ui.select = async (title, options) => {
      prompts.push([title, options]);
      if (prompts.length === 1) return 'Gentle Shell theme';
      // The theme itself, listed before the sentinel that had to move aside.
      return options[0];
    };
    await run(h, '');
    assert.deepEqual(
      prompts[1][1],
      [THEME_UNASSIGN, `${THEME_UNASSIGN} 2`],
      'the sentinel moves instead of shadowing a theme that carries its spelling',
    );
    assert.equal(readThemeFile(env).theme, THEME_UNASSIGN, 'the theme keeps its own name');
  });

  test('a cancelled theme selection writes nothing', async () => {
    const env = setupEnvironment('theme-select-cancelled');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const before = fs.readFileSync(themePath(env), 'utf8');
    const h = harness({ themes: [{ name: 'nord' }] });
    // The menu pick is consumed; the theme list prompt is then cancelled.
    h.selections.push('Gentle Shell theme');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), []);
    assert.equal(fs.readFileSync(themePath(env), 'utf8'), before);
    assert.deepEqual(h.reloads, []);
  });

  test('an unreadable theme list is reported and writes nothing', async () => {
    const env = setupEnvironment('theme-select-no-list');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const before = fs.readFileSync(themePath(env), 'utf8');
    // No `getAllThemes` on this host: the command must say so instead of
    // guessing a theme list or writing an unresolvable name.
    const h = harness();
    h.selections.push('Gentle Shell theme');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [
      "Could not read Pi's theme list (this host exposes no getAllThemes()); nothing was changed.",
    ]);
    assert.deepEqual(h.notices.map(([, level]) => level), ['warning']);
    assert.equal(fs.readFileSync(themePath(env), 'utf8'), before);
    assert.deepEqual(h.reloads, []);
  });
});

/* ------------------------------------------------ restored floating panel */

describe('floating customize panel', () => {
  function makeHostTui() {
    const paints = [];
    return { paints, tui: { requestRender: () => { paints.push(true); } } };
  }

  test('no argument opens the restored two-pane overlay with the exact options', async () => {
    const env = setupEnvironment('overlay-open');
    fs.writeFileSync(env.configPath, '');
    const configBefore = fs.readFileSync(env.configPath, 'utf8');
    const h = harness({ customImpl: async () => undefined });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.equal(h.customs.length, 1, 'expected exactly one custom() call');
    assert.deepEqual(h.customs[0][1], {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' },
    });
    // Opening the panel writes and announces nothing: the factory is only
    // captured, and the overlay is disposed by the host without a result.
    assert.deepEqual(noticeTexts(h), []);
    assert.deepEqual(h.reloads, []);
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.configPath, 'utf8'), configBefore);

    const host = makeHostTui();
    const { component } = openPanel(h.customs[0][0], host.tui);
    const seen = component.render(100).map((line) => String(line)).join('\n');
    for (const copy of [
      'Customize · Herdr Gentle Shell',
      'CATEGORIES',
      'Herdr Sidebar · 1/1',
      'Moshi notifications',
      'Sidebar agent rows',
      '● Off',
      '○ On',
      'Click · ←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close',
      'Preview · Off · static sidebar sample',
    ]) {
      assert.ok(seen.includes(copy), `panel copy missing: ${copy}`);
    }
    assert.equal(seen.includes('Notifications'), false, 'the Herdr Sidebar category lists no notification row');
    for (const gone of ['Plugin tools', 'Worktree tools', 'Reset every option']) {
      assert.equal(seen.includes(gone), false, `removed section still rendered: ${gone}`);
    }
  });

  test('the panel budgets rows for the overlay box the host actually renders', async () => {
    // The overlay is capped at 85% of the terminal. A panel that budgets the
    // whole terminal renders a taller card, the host clips it, and every click
    // lands on a frame height the panel never rendered — the reported bug.
    const env = setupEnvironment('overlay-clipped-box');
    fs.writeFileSync(env.configPath, '');
    const host = { terminal: { rows: 20 }, requestRender() {} };
    const observed = {};
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, host);
        const rendered = component.render(100);
        const box = rendered.slice(0, Math.floor(20 * 0.85));
        observed.rendered = rendered.length;
        observed.box = box.length;
        const observedRow = box.find((line) => String(line).includes('○ On'));
        observed.rowVisible = observedRow !== undefined;
        const result = component.handleMouse({
          type: 'click',
          button: 'left',
          x: observedRow === undefined ? 0 : String(observedRow).indexOf('○ On'),
          y: Math.max(0, box.indexOf(observedRow)),
          width: 100,
          height: box.length,
          shift: false,
          alt: false,
          ctrl: false,
        });
        observed.result = result;
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.equal(observed.box, 17, 'the overlay box is 85% of a 20-row terminal');
    assert.equal(observed.rendered, observed.box, 'the card already fits the overlay box');
    assert.equal(observed.rowVisible, true, 'the first sidebar option is inside the box');
    assert.equal(observed.result?.handled, true, 'the click on the rendered option is handled');
    assert.deepEqual(noticeTexts(h), [
      'Sidebar agent rows enabled; the managed block is in place and Herdr reloaded its config.',
    ]);
  });

  test('movement repaints and writes nothing', async () => {
    const env = setupEnvironment('overlay-navigation');
    fs.writeFileSync(env.configPath, '');
    const configBefore = fs.readFileSync(env.configPath, 'utf8');
    const host = makeHostTui();
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, host.tui);
        assert.ok(component.render(100).join('\n').includes('▸ Herdr Sidebar'));
        component.handleInput('down');
        assert.equal(host.paints.length, 1, 'a selection change requests a repaint');
        assert.ok(component.render(100).join('\n').includes('▸ Moshi notifications'));
        assert.equal(done(), 'pending', 'movement never finishes the overlay');
        component.handleInput('escape');
        return done();
      },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.deepEqual(noticeTexts(h), []);
    assert.deepEqual(h.reloads, []);
    assert.equal(fs.readFileSync(env.configPath, 'utf8'), configBefore);
  });

  test('Esc closes the overlay with zero writes', async () => {
    const env = setupEnvironment('overlay-esc');
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('escape');
        assert.equal(done(), null, 'Esc finishes the overlay with null');
        return done();
      },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.deepEqual(noticeTexts(h), []);
    assert.deepEqual(h.reloads, []);
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
  });

  test('Enter applies the chosen sidebar option through the same apply path', async () => {
    const env = setupEnvironment('overlay-sidebar-on');
    fs.writeFileSync(env.configPath, '[ui.sidebar.agents]\nignored = true\n');
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('right');
        assert.ok(component.render(100).join('\n').includes('▸ Sidebar agent rows'));
        // The cursor lands on the stored option: one step left is the other one.
        component.handleInput('left');
        component.handleInput('enter');
        await settlePanel(component);
        assert.equal(done(), 'pending', 'the panel stays open after an apply');
        component.handleInput('escape');
        return done();
      },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [
      'Sidebar agent rows enabled; the managed block is in place and Herdr reloaded its config.',
    ]);
    const applied = fs.readFileSync(env.configPath, 'utf8');
    assert.ok(applied.includes(MANAGED_BEGIN) && applied.includes(MANAGED_END));
    assert.deepEqual(h.reloads, []);
    assert.equal(fs.existsSync(env.flagPath), false, 'the sidebar switch writes no Moshi flag');
  });

  test('the sidebar switch never reads or writes the Moshi flag', async () => {
    const env = setupEnvironment('overlay-sidebar-no-moshi');
    fs.writeFileSync(env.configPath, '[ui.sidebar.agents]\nignored = true\n');
    // The user's reported bug: turning the agent rows off also turned the
    // Moshi channel off. An existing flag must survive byte-identical.
    const flagBefore = `${JSON.stringify({ enabled: true, updatedAt: '2024-01-01T00:00:00.000Z' })}\n`;
    fs.writeFileSync(env.flagPath, flagBefore);
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('right');
        const seen = component.render(100).join('\n');
        assert.ok(seen.includes('▸ Sidebar agent rows'));
        assert.equal(seen.includes('Notifications'), false, 'the category carries no Moshi switch');
        component.handleInput('left');
        component.handleInput('enter');
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [
      'Sidebar agent rows enabled; the managed block is in place and Herdr reloaded its config.',
    ]);
    assert.equal(fs.readFileSync(env.flagPath, 'utf8'), flagBefore, 'the Moshi flag stays byte-identical');
    assert.deepEqual(h.reloads, []);
  });

  test('Enter applies the chosen Moshi option with the usual gate and reload', async () => {
    const env = setupEnvironment('overlay-moshi-on');
    installMoshiHook(env.pathDir, { paired: true });
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('right');
        // The stored Off is the second option, so ← is the way to On.
        component.handleInput('left');
        component.handleInput('enter');
        await settlePanel(component);
        return done();
      },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [
      `Moshi notifications enabled. added ${MOSHI_ENTRY}. Reloading now to apply the change.`,
    ]);
    assert.equal(readSettings(env.flagPath).enabled, true);
    assert.deepEqual(readSettings(env.settingsPath).extensions, ['keep-me', MOSHI_ENTRY]);
    assert.equal(h.reloads.length, 1);
  });

  test('the Moshi category reads the flag it just wrote', async () => {
    const env = setupEnvironment('overlay-notifications-consistency');
    installMoshiHook(env.pathDir, { paired: true });
    fs.writeFileSync(env.configPath, '');
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });

    const enable = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('left');
        component.handleInput('enter');
        await settlePanel(component);
        return done();
      },
    });
    const mod = await loadExtension(enable);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(enable, '');
    assert.equal(readSettings(env.flagPath).enabled, true);

    // Reopening reads the same flag: the `Moshi notifications` category shows
    // the new state, and `Herdr Sidebar` still shows its own switch alone.
    const seen = {};
    const reopen = harness({
      customImpl: async (factory) => {
        const { component } = openPanel(factory, makeHostTui().tui);
        seen.sidebar = component.render(100).join('\n');
        component.handleInput('down');
        seen.moshi = component.render(100).join('\n');
        component.handleInput('escape');
        return null;
      },
    });
    const mod2 = await loadExtension(reopen);
    mod2.setCustomizeTuiLoader(async () => stubTui);
    await run(reopen, '');
    assert.ok(seen.sidebar.includes('Herdr Sidebar · 1/1'));
    const sidebarLine = seen.sidebar.split('\n').find((line) => line.includes('Sidebar agent rows'));
    assert.ok(sidebarLine.includes('● Off'), 'the sidebar rows keep their own stored state');
    assert.equal(seen.sidebar.includes('Notifications'), false, 'no notification row under Herdr Sidebar');
    assert.ok(seen.moshi.includes('Moshi notifications · 1/1'));
    assert.ok(seen.moshi.includes('● On'), 'the Moshi notifications category reads the flag it just wrote');

    // And Off through the Moshi category is what it shows next time.
    const disable = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('right');
        // The stored On is the first option; the second one is Off.
        component.handleInput('right');
        component.handleInput('enter');
        await settlePanel(component);
        return done();
      },
    });
    const mod3 = await loadExtension(disable);
    mod3.setCustomizeTuiLoader(async () => stubTui);
    await run(disable, '');
    assert.equal(readSettings(env.flagPath).enabled, false);
    assert.deepEqual(readSettings(env.settingsPath).extensions, ['keep-me']);

    let after = '';
    const reopenOff = harness({
      customImpl: async (factory) => {
        const { component } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        after = component.render(100).join('\n');
        component.handleInput('escape');
        return null;
      },
    });
    const mod4 = await loadExtension(reopenOff);
    mod4.setCustomizeTuiLoader(async () => stubTui);
    await run(reopenOff, '');
    assert.ok(after.includes('● Off'), 'the Moshi category fell back to Off');
  });

  test('an unavailable TUI helper keeps the menu fallback', async () => {
    const env = setupEnvironment('overlay-no-tui');
    fs.writeFileSync(env.flagPath, `${JSON.stringify({ enabled: true })}\n`);
    writeSettings(env.settingsPath, { extensions: ['keep-me', MOSHI_ENTRY] });
    const h = harness({
      customImpl: async () => { throw new Error('the overlay must not open without helpers'); },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => { throw new Error('pi-tui unavailable'); });
    h.selections.push('Moshi notifications', 'Off');
    await run(h, '');
    assert.equal(h.customs.length, 0);
    assert.deepEqual(noticeTexts(h), [
      `Moshi notifications disabled. removed ${MOSHI_ENTRY}. Reloading now to apply the change.`,
    ]);
    assert.equal(h.reloads.length, 1);
  });

  test('a missing panel module keeps the menu fallback (single-file deployment)', async () => {
    const env = setupEnvironment('overlay-no-module');
    process.env.GENTLE_CUSTOMIZE_LIB_DIR = path.join(env.dir, 'missing-lib');
    fs.writeFileSync(env.flagPath, `${JSON.stringify({ enabled: true })}\n`);
    writeSettings(env.settingsPath, { extensions: ['keep-me', MOSHI_ENTRY] });
    const h = harness({ customImpl: async () => { throw new Error('the overlay needs the panel module'); } });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    h.selections.push('Moshi notifications', 'Off');
    await run(h, '');
    assert.equal(h.customs.length, 0);
    assert.deepEqual(noticeTexts(h), [
      `Moshi notifications disabled. removed ${MOSHI_ENTRY}. Reloading now to apply the change.`,
    ]);
    assert.equal(h.reloads.length, 1);
  });

  test('a host that rejects the overlay degrades to the menu', async () => {
    const env = setupEnvironment('overlay-rejected');
    fs.writeFileSync(env.flagPath, `${JSON.stringify({ enabled: true })}\n`);
    writeSettings(env.settingsPath, { extensions: ['keep-me', MOSHI_ENTRY] });
    const h = harness({
      customImpl: async () => { throw new Error('overlay unsupported'); },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    h.selections.push('Moshi notifications', 'Off');
    await run(h, '');
    assert.equal(h.customs.length, 1);
    assert.deepEqual(noticeTexts(h), [
      `Moshi notifications disabled. removed ${MOSHI_ENTRY}. Reloading now to apply the change.`,
    ]);
    assert.equal(h.reloads.length, 1);
  });
});

/* --------------------------------------------- floating panel theme rows */

describe('floating panel theme rows', () => {
  // Everything the panel needs to reach the Herdr Theme category without
  // touching a live theme store or Pi settings.
  async function withThemePanel(h, drive) {
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    return drive;
  }

  test('the overlay carries the Herdr Theme category and its two settings', async () => {
    const env = setupEnvironment('overlay-theme-rows');
    fs.writeFileSync(env.configPath, '');
    const seen = {};
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        seen.categories = component.render(100).join('\n');
        component.handleInput('right');
        seen.controls = component.render(100).join('\n');
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.ok(seen.categories.includes('▸ Herdr Theme'), 'the cursor reaches the theme category');
    assert.ok(seen.controls.includes('Herdr Theme · 1/2'), 'the category counts its two settings');
    const syncLine = seen.controls.split('\n').find((line) => line.includes('Theme sync'));
    assert.ok(syncLine.includes('● Off'), 'the sync setting reads the inert default Off');
    const themeLine = seen.controls.split('\n').find((line) => line.includes('Gentle Shell theme'));
    // S2: a host without the theme API shows the note and NO options at all, so
    // the setting can never look like a pickable list.
    assert.ok(seen.controls.includes('Themes unavailable; use Pi /settings'), 'the missing list says so');
    assert.equal(themeLine.includes('None'), false, 'no inert option is invented without the host list');
    assert.equal(themeLine.includes('●'), false, 'and nothing is marked current');
    assert.deepEqual(noticeTexts(h), []);
    assert.equal(fs.existsSync(themePath(env)), false, 'opening the panel writes nothing');
  });

  test('the theme setting lists Pi themes in host order, deduped, without subdirectory names', async () => {
    const env = setupEnvironment('overlay-theme-list');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const seen = {};
    const h = harness({
      themes: [
        { name: 'zeta', path: '/themes/zeta.json' },
        { name: 'nested/theme' },
        { name: 'alpha' },
        { name: 'alpha', path: '/themes/alpha-light.json' },
      ],
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        seen.row = component.render(100).join('\n');
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    const themeLine = seen.row.split('\n').find((line) => line.includes('Gentle Shell theme'));
    assert.ok(themeLine.includes('● None'));
    assert.ok(themeLine.includes('○ zeta') && themeLine.includes('○ alpha'), 'the host order is kept');
    assert.equal(themeLine.indexOf('○ zeta') < themeLine.indexOf('○ alpha'), true, 'zeta stays before alpha');
    assert.equal(seen.row.includes('nested/theme'), false, 'a subdirectory name is not a theme');
  });

  test('Enter on an inline theme writes the pinned name and never reloads Pi', async () => {
    const env = setupEnvironment('overlay-theme-inline');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({
      themes: [{ name: 'nord' }, { name: 'dracula' }],
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        // None -> nord.
        component.handleInput('right');
        component.handleInput('enter');
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    const doc = readThemeFile(env);
    assert.deepEqual(Object.keys(doc).sort(), ['sync', 'theme', 'updatedAt'], 'only the store document fields');
    assert.equal(doc.sync, false, 'a pinned theme never turns the sync on');
    assert.equal(doc.theme, 'nord');
    assert.deepEqual(h.reloads, []);
    assert.equal(fs.existsSync(env.flagPath), false);
  });

  test('Enter on None writes an unassigned theme', async () => {
    const env = setupEnvironment('overlay-theme-none');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({
      themes: [{ name: 'nord' }],
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        // The stored value is not in Pi's list, so the cursor lands on None.
        component.handleInput('enter');
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.equal(readThemeFile(env).theme, null, 'the None option writes no theme');
    assert.equal(readThemeFile(env).sync, false);
    assert.deepEqual(h.reloads, []);
  });

  test('a theme named Off is pinned, not read as the inert choice', async () => {
    const env = setupEnvironment('overlay-theme-named-off');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({
      themes: [{ name: 'Off' }],
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('enter');
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.equal(readThemeFile(env).theme, 'Off', 'the structural option id keeps the theme pinnable');
  });

  test('the preview renders the swatch of the highlighted theme through ctx.ui.getTheme', async () => {
    const env = setupEnvironment('overlay-theme-preview');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const seen = {};
    const h = harness({
      themes: [{ name: 'nord' }],
      getTheme: (name) => ({
        name,
        getBgAnsi: () => '\x1b[48;5;17m',
        getFgAnsi: () => '\x1b[38;5;250m',
      }),
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        component.handleInput('right');
        seen.frame = component.render(100).join('\n');
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.ok(seen.frame.includes('Preview · nord · source palette'), 'the upstream headline');
    assert.ok(seen.frame.includes('\x1b[48;5;17m'), "the swatch uses that theme's own accent background");
    assert.ok(seen.frame.includes('Aa  sample text'), 'the upstream sample text');
  });

  test('a theme that cannot be read renders Preview unavailable, never the active theme', async () => {
    const env = setupEnvironment('overlay-theme-preview-unavailable');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: null, updatedAt: '2024-01-01T00:00:00.000Z' });
    const seen = {};
    const h = harness({
      themes: [{ name: 'nord' }],
      getTheme: () => undefined,
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        component.handleInput('right');
        seen.frame = component.render(100).join('\n');
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.ok(seen.frame.includes('Preview unavailable'));
    assert.equal(seen.frame.includes('source palette'), false);
  });

  test('the overlay reads the stored theme and disables the setting while the sync is on', async () => {
    const env = setupEnvironment('overlay-theme-stored');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: true, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    let seen = '';
    const h = harness({
      themes: [{ name: 'dracula' }, { name: 'nord' }],
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        seen = component.render(100).join('\n');
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.ok(seen.includes('● On'), 'the sync setting reads its stored On');
    assert.ok(seen.includes('● dracula'), 'the assigned theme stays readable');
    assert.ok(seen.includes('Turn Theme sync off to pick a specific theme.'), 'the disabled setting explains itself');
  });

  test('Enter on the sync setting writes the store, keeps the pin and skips the Pi reload', async () => {
    const env = setupEnvironment('overlay-theme-toggle');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: false, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const h = harness({
      themes: [{ name: 'dracula' }],
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('right');
        component.handleInput('enter');
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.deepEqual(noticeTexts(h), ["Theme sync on; Herdr's palette follows the theme active in Pi."]);
    const doc = readThemeFile(env);
    assert.equal(doc.sync, true);
    assert.equal(doc.theme, 'dracula', 'the pinned name survives the toggle');
    assert.deepEqual(h.reloads, [], 'the theme watch applies the palette; Pi is not reloaded');
    assert.equal(fs.existsSync(env.flagPath), false);
  });

  test('the disabled theme setting refuses through the overlay and writes nothing', async () => {
    const env = setupEnvironment('overlay-theme-refused');
    fs.writeFileSync(env.configPath, '');
    writeThemeFile(env, { sync: true, theme: 'dracula', updatedAt: '2024-01-01T00:00:00.000Z' });
    const before = fs.readFileSync(themePath(env), 'utf8');
    const h = harness({
      themes: [{ name: 'nord' }],
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('down');
        assert.ok(component.render(100).join('\n').includes('▸ Gentle Shell theme'));
        component.handleInput('enter');
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    await withThemePanel(h);
    assert.deepEqual(noticeTexts(h), ['Turn Theme sync off to pick a specific theme.']);
    assert.deepEqual(h.notices.map(([, level]) => level), ['warning']);
    assert.equal(fs.readFileSync(themePath(env), 'utf8'), before, 'the refusal writes nothing');
    assert.deepEqual(h.reloads, []);
  });

  test('a Moshi apply that needs a reload closes the overlay before Pi reloads', async () => {
    const env = setupEnvironment('overlay-moshi-close-first');
    installMoshiHook(env.pathDir, { paired: true });
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    let reloadsWhileOpen = null;
    const h = harness({
      customImpl: async (factory) => {
        const { component } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('left');
        component.handleInput('enter');
        await settlePanel(component);
        // The panel closed itself (close:true) so the host can reload.
        reloadsWhileOpen = h.reloads.length;
        return null;
      },
    });
    await withThemePanel(h);
    assert.equal(reloadsWhileOpen, 0, 'nothing reloaded while the overlay was still mounted');
    assert.equal(h.reloads.length, 1, 'the reload runs after the overlay resolved');
    assert.equal(readSettings(env.flagPath).enabled, true);
    assert.deepEqual(readSettings(env.settingsPath).extensions, ['keep-me', MOSHI_ENTRY]);
  });
});

/* ------------------------------------------- inconclusive sidebar --check */

describe('inconclusive sidebar state', () => {
  // A foreign rows_by_agent override makes configure.js --check exit 2, which
  // readSidebarRows reports as `unknown`. The baseline menu never blocked the
  // repair on that verdict: choosing On still ran --apply and reported its own
  // refusal. These tests pin that observable behavior for both entry points.
  const UNMANAGED_CONFIG = '[ui.sidebar.agents.rows_by_agent]\nuser = "x"\n';
  const INCONCLUSIVE_APPLY_TEXT =
    'Could not enable the sidebar agent rows: configure exited 2: ' +
    'configure: refusing --apply: an unmanaged [ui.sidebar.agents.rows_by_agent] override already exists. ' +
    'This tool only manages its marked block and will not adopt or overwrite foreign config. ' +
    'Remove or rename the existing override, then re-run --apply. Nothing was changed.';

  test('baseline: the menu still attempts On and reports the apply refusal', async () => {
    const env = setupEnvironment('sidebar-inconclusive-menu');
    fs.writeFileSync(env.configPath, UNMANAGED_CONFIG);
    const h = harness();
    h.selections.push('Sidebar agent rows', 'On');
    await run(h, '');
    assert.deepEqual(noticeTexts(h), [INCONCLUSIVE_APPLY_TEXT]);
    assert.deepEqual(h.notices.map(([, level]) => level), ['error']);
    assert.equal(fs.readFileSync(env.configPath, 'utf8'), UNMANAGED_CONFIG, 'the refusal writes nothing');
    assert.deepEqual(h.reloads, []);
  });

  test('the overlay conveys unknown and still attempts On', async () => {
    const env = setupEnvironment('sidebar-inconclusive-overlay');
    fs.writeFileSync(env.configPath, UNMANAGED_CONFIG);
    let renderSeen = '';
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        renderSeen = component.render(100).join('\n');
        // The cursor lands on the first option (an unknown state has no stored
        // one), and Enter confirms it through the same apply path.
        component.handleInput('right');
        component.handleInput('enter');
        await settlePanel(component);
        component.handleInput('escape');
        return done();
      },
    });
    const mod = await loadExtension(h);
    mod.setCustomizeTuiLoader(async () => stubTui);
    await run(h, '');
    assert.ok(renderSeen.includes('state unknown'), 'the panel explains the inconclusive state');
    assert.equal(renderSeen.includes('(unavailable in this session)'), false, 'the repair is never blocked');
    assert.deepEqual(noticeTexts(h), [INCONCLUSIVE_APPLY_TEXT]);
    assert.deepEqual(h.notices.map(([, level]) => level), ['error']);
    assert.equal(fs.readFileSync(env.configPath, 'utf8'), UNMANAGED_CONFIG, 'the refusal writes nothing');
    assert.deepEqual(h.reloads, []);
  });
});

function makeHostTui() {
  const paints = [];
  return { paints, tui: { requestRender: () => { paints.push(true); } } };
}
