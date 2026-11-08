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
//   `bin/configure.js --check|--apply --reload|--uninstall --reload`.
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
// line stubbed (same approach as tools/gentle-herdr-state.test.js). Every
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
const stubbed = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');
assert.ok(
  !/^import .* from "\.\//m.test(stubbed),
  'state.ts must stay self-contained (no relative imports)',
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-customize-'));
// The copied extension lives outside the repo, so the panel helper is loaded
// from the real lib/ through the documented override.
process.env.GENTLE_CUSTOMIZE_LIB_DIR = path.join(REPO_ROOT, 'lib');
const COPY = path.join(ROOT, 'gentle-herdr-state.mjs');
fs.writeFileSync(COPY, stubbed);
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
const MISSING_CLI_TEXT =
  'Moshi notifications cannot be enabled: the `moshi-hook` CLI was not found on PATH; install the Moshi CLI, then re-apply On from /herdr-gentle:customize.';
const NOT_PAIRED_TEXT =
  'Moshi notifications cannot be enabled: `moshi-hook status --json` reports paired:false (this device is not paired); run `moshi-hook pair --token <pairing-token>`, then re-apply On from /herdr-gentle:customize.';

const COMMAND = 'herdr-gentle:customize';

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

function harness({ customImpl } = {}) {
  const commands = new Map();
  const notices = [];
  const selections = [];
  const customs = [];
  const reloads = [];
  const handlerKinds = [];
  const pi = {
    on: (kind) => handlerKinds.push(kind),
    events: { on: () => {}, emit: () => {} },
    registerCommand: (name, definition) => commands.set(name, definition),
  };
  const ui = {
    notify: (message, level) => notices.push([message, level ?? 'info']),
    select: async () => selections.shift(),
  };
  if (typeof customImpl === 'function') {
    ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  const ctx = { ui, reload: async () => reloads.push(true) };
  return { pi, ctx, commands, notices, selections, customs, reloads, handlerKinds };
}

let moduleCache = null;
async function loadExtension(h) {
  if (moduleCache === null) moduleCache = await factoryPromise;
  moduleCache.default(h.pi);
  return moduleCache;
}

async function run(h, args) {
  await loadExtension(h);
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
function openPanel(factory, hostTui = {}) {
  let settled = 'pending';
  const component = factory(hostTui, {}, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  return { component, done: () => settled };
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

/* ------------------------------------------------------------ tests */

describe('registration', () => {
  test('registers the command before the enabled() pane gate', async () => {
    const h = harness();
    await loadExtension(h);
    assert.ok(h.commands.has(COMMAND), 'the command must register outside a Herdr pane');
    // The pane gate is closed in this process, so the factory must have
    // returned right after registration: no producer handlers were bound.
    assert.deepEqual(h.handlerKinds, []);
    assert.match(h.commands.get(COMMAND).description, /sidebar agent rows/);
    assert.match(h.commands.get(COMMAND).description, /Moshi notifications/);
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
    assert.deepEqual(noticeTexts(h), ['customize status: sidebar=off moshi=off']);
    assert.deepEqual(h.reloads, []);
    // Read-only: no flag file, no settings write, no config write.
    assert.equal(fs.existsSync(env.flagPath), false);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
  });

  test('reads the managed sidebar block through configure.js --check', async () => {
    const env = setupEnvironment('status-on');
    fs.writeFileSync(env.configPath, MANAGED_BLOCK);
    const configBefore = fs.readFileSync(env.configPath, 'utf8');
    const h = harness();
    await run(h, 'status');
    assert.deepEqual(noticeTexts(h), ['customize status: sidebar=on moshi=off']);
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

test('customize menu offers exactly the two switches and On/Off', async () => {
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
    ['Sidebar agent rows', 'Moshi notifications'],
    ['On', 'Off'],
  ]);
  assert.equal(offered[0][0], 'Customize · Herdr Gentle Shell');
  assert.equal(offered[1][0], 'Moshi notifications (currently off)');
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
    const seen = component.render(100).join('\n');
    for (const copy of [
      'Customize · Herdr Gentle Shell',
      'CATEGORIES',
      'Herdr Sidebar',
      'Moshi notifications',
      'Preview · Off',
      '←/→ or Tab panes · ↑/↓ or j/k move · Enter toggle · Esc close',
    ]) {
      assert.ok(seen.includes(copy), `panel copy missing: ${copy}`);
    }
    for (const gone of ['Plugin tools', 'Worktree tools', 'Reset every option']) {
      assert.equal(seen.includes(gone), false, `removed section still rendered: ${gone}`);
    }
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

  test('Enter applies the chosen sidebar row through the same apply path', async () => {
    const env = setupEnvironment('overlay-sidebar-on');
    fs.writeFileSync(env.configPath, '[ui.sidebar.agents]\nignored = true\n');
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('right');
        component.handleInput('up');
        component.handleInput('enter');
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
  });

  test('Enter applies the chosen Moshi row with the usual gate and reload', async () => {
    const env = setupEnvironment('overlay-moshi-on');
    installMoshiHook(env.pathDir, { paired: true });
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const h = harness({
      customImpl: async (factory) => {
        const { component, done } = openPanel(factory, makeHostTui().tui);
        component.handleInput('down');
        component.handleInput('right');
        component.handleInput('up');
        component.handleInput('enter');
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
        component.handleInput('enter');
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
