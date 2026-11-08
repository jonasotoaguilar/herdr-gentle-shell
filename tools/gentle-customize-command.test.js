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

function harness() {
  const commands = new Map();
  const notices = [];
  const selections = [];
  const reloads = [];
  const handlerKinds = [];
  const pi = {
    on: (kind) => handlerKinds.push(kind),
    events: { on: () => {}, emit: () => {} },
    registerCommand: (name, definition) => commands.set(name, definition),
  };
  const ctx = {
    ui: {
      notify: (message, level) => notices.push([message, level ?? 'info']),
      select: async () => selections.shift(),
    },
    reload: async () => reloads.push(true),
  };
  return { pi, ctx, commands, notices, selections, reloads, handlerKinds };
}

let moduleCache = null;
async function loadExtension(h) {
  if (moduleCache === null) moduleCache = await factoryPromise;
  moduleCache.default(h.pi);
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
