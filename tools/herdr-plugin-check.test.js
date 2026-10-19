'use strict';
// T15 (customize-command S22) tests: the startup check of the installed
// `herdr-gentle-shell` Herdr plugin in lib/herdr-plugin-check.js, wired
// from extensions/gentle-worktree-tools.ts.
//
// Contract under test (observable behavior only — the returned status,
// the exact alert text, whether notify was called, and which argv the
// stub saw; never internal function names):
// - at startup the installed plugin for id `herdr-gentle-shell` is
//   compared against the version this package ships in
//   herdr-plugin/herdr-plugin.toml;
// - missing, wrong id (retired `herdr-gentle-agents` only), disabled, or
//   a different version notifies ONCE per session with one short alert
//   naming the mismatch and the real install command;
// - a locally linked plugin (source.kind === "local") counts as
//   installed and is reported as linked, never as missing;
// - an absent/erroring Herdr CLI or unreadable metadata fails silent and
//   harmless: never throws, never blocks loading, never writes user
//   config, never repeats the alert, never mentions /reload.
//
// Loading pattern mirrors tools/customize-panel.test.js for the wiring
// half: the TypeScript extension is plain JS under the hood
// (// @ts-nocheck, no type annotations), so the test copies it to a
// temporary .mjs path with the package import lines stubbed and
// import()s it with a fake `pi` object. The pure unit half injects a
// stub `run` and never spawns anything; the wiring half points
// HERDR_BIN_PATH at a fixture shell shim, never at a real Herdr server.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const REPO_ROOT = path.resolve(__dirname, '..');
const pluginCheck = require('../lib/herdr-plugin-check.js');

const PLUGIN_ID = 'herdr-gentle-shell';
const LEGACY_PLUGIN_ID = 'herdr-gentle-agents';
const INSTALL_PREFIX = 'herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin --ref herdr-v';
const ENABLE_COMMAND = 'herdr plugin enable herdr-gentle-shell';
const UPDATE_COMMAND = 'herdr plugin update herdr-gentle-shell';

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function writeManifest(version) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-manifest-')));
  const file = path.join(dir, 'herdr-plugin.toml');
  fs.writeFileSync(file, `id = "${PLUGIN_ID}"\nname = "Herdr Gentle Shell"\nversion = "${version}"\n`);
  return file;
}

function listDoc(entries) {
  return JSON.stringify({ id: 'cli:plugin', result: { plugins: entries }, type: 'plugin_list' });
}

function entry(overrides = {}) {
  return {
    plugin_id: PLUGIN_ID,
    plugin_root: '/tmp/fixture/herdr-plugin',
    version: '0.4.0',
    enabled: true,
    source: { kind: 'github' },
    ...overrides,
  };
}

// Stub `run(bin, args)` answering each plugin id from `byId`, recording
// every call. A `failWith` makes every call throw (Herdr CLI absent).
function stubRun(byId, { failWith = null } = {}) {
  const seen = [];
  const run = (bin, args) => {
    seen.push({ bin, args: [...args] });
    if (failWith) throw failWith;
    const at = args.indexOf('--plugin');
    const want = at >= 0 ? args[at + 1] : null;
    const plugins = (want && byId[want]) || [];
    return { status: 0, stdout: listDoc(plugins), stderr: '', error: null };
  };
  return { run, seen };
}

function checkAndNotify(options) {
  const calls = [];
  const notify = (message, level) => { calls.push([message, level]); };
  const result = pluginCheck.checkAndNotifyHerdrPlugin({ ...options, notify });
  return { result, calls };
}

const savedEnv = { ...process.env };
function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

describe('herdr-plugin-check: missing plugin', { concurrency: false }, () => {
  test('a missing plugin notifies once with the real install command', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run, seen } = stubRun({});
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'missing');
    assert.equal(result.shippedVersion, '0.4.0');
    assert.equal(calls.length, 1, 'exactly one alert');
    const [message, level] = calls[0];
    assert.equal(level, 'info');
    assert.ok(message.includes(PLUGIN_ID), `names the plugin id: ${message}`);
    assert.ok(message.includes('0.4.0'), `names the shipped version: ${message}`);
    assert.ok(
      message.includes(`${INSTALL_PREFIX}0.4.0`),
      `carries the real install ref: ${message}`,
    );
    assert.ok(message.includes(ENABLE_COMMAND), `carries the enable step: ${message}`);
    assert.ok(!message.includes('/reload'), 'never tells the user to run /reload');
    assert.ok(seen.length >= 1, 'the plugin list was queried');
    assert.ok(seen[0].args.includes('--json'), 'read-only list query');
    assert.equal(result.notified, true);
  });

  test('a second check in the same session never repeats the alert', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({});
    const first = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(first.calls.length, 1);
    const second = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(second.calls.length, 0, 'no second alert in the same session');
    assert.equal(second.result.status, 'missing');
    assert.equal(second.result.notified, false);
  });

  test('resetting re-arms the once-per-session alert', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({});
    assert.equal(checkAndNotify({ manifestPath, run, env: {} }).calls.length, 1);
    pluginCheck.resetHerdrPluginCheckForTests();
    assert.equal(checkAndNotify({ manifestPath, run, env: {} }).calls.length, 1);
  });
});

describe('herdr-plugin-check: wrong id, disabled, version drift', { concurrency: false }, () => {
  test('a retired-id-only install reports the wrong id with the install command', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const legacy = { ...entry(), plugin_id: LEGACY_PLUGIN_ID };
    delete legacy.id;
    const { run, seen } = stubRun({ [LEGACY_PLUGIN_ID]: [legacy] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'wrong-id');
    assert.equal(calls.length, 1);
    const [message] = calls[0];
    assert.ok(message.includes(LEGACY_PLUGIN_ID), `names the retired id: ${message}`);
    assert.ok(message.includes(`${INSTALL_PREFIX}0.4.0`), `carries the real install ref: ${message}`);
    assert.ok(!message.includes('/reload'), 'never tells the user to run /reload');
    assert.ok(
      seen.some((call) => call.args.includes(PLUGIN_ID)),
      'the active id is queried first',
    );
  });

  test('a disabled plugin names the enable command', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({ [PLUGIN_ID]: [entry({ enabled: false })] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'disabled');
    assert.equal(calls.length, 1);
    const [message] = calls[0];
    assert.ok(message.includes(PLUGIN_ID), `names the plugin id: ${message}`);
    assert.ok(message.includes(ENABLE_COMMAND), `carries the enable command: ${message}`);
    assert.ok(!message.includes('/reload'), 'never tells the user to run /reload');
  });

  test('disabled wins over version drift: enable first, then update', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({ [PLUGIN_ID]: [entry({ enabled: false, version: '0.3.0' })] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'disabled');
    assert.ok(calls[0][0].includes(ENABLE_COMMAND));
  });

  test('a version drift on a remote install names both versions and the update command', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({ [PLUGIN_ID]: [entry({ version: '0.3.0' })] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'version-mismatch');
    assert.equal(result.linked, false);
    assert.equal(result.installedVersion, '0.3.0');
    assert.equal(calls.length, 1);
    const [message] = calls[0];
    assert.ok(message.includes('0.3.0') && message.includes('0.4.0'), `names both versions: ${message}`);
    assert.ok(message.includes(UPDATE_COMMAND), `carries the update command: ${message}`);
    assert.ok(!message.includes('/reload'), 'never tells the user to run /reload');
  });

  test('a version drift on a linked checkout is reported as linked, never as missing', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const linked = entry({ version: '0.3.0', source: { kind: 'local' } });
    const { run } = stubRun({ [PLUGIN_ID]: [linked] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'version-mismatch');
    assert.equal(result.linked, true);
    assert.equal(calls.length, 1);
    const [message] = calls[0];
    assert.ok(message.includes('locally linked'), `reported as linked: ${message}`);
    assert.ok(!message.toLowerCase().includes('not installed'), 'never reported as missing');
    assert.ok(message.includes(`${INSTALL_PREFIX}0.4.0`), `carries the real install ref: ${message}`);
  });

  test('an active install wins over a legacy residue without a second lookup', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run, seen } = stubRun({
      [PLUGIN_ID]: [entry()],
      [LEGACY_PLUGIN_ID]: [{ ...entry(), plugin_id: LEGACY_PLUGIN_ID }],
    });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'ok');
    assert.equal(calls.length, 0, 'a healthy install stays silent');
    assert.equal(seen.length, 1, 'the legacy id is never queried when the active id matches');
  });

  test('a missing enabled flag is not a disabled plugin', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const bare = entry();
    delete bare.enabled;
    const { run } = stubRun({ [PLUGIN_ID]: [bare] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'ok');
    assert.equal(calls.length, 0);
  });
});

describe('herdr-plugin-check: healthy installs stay silent', { concurrency: false }, () => {
  test('a matching remote install notifies nothing', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({ [PLUGIN_ID]: [entry()] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'ok');
    assert.equal(result.linked, false);
    assert.equal(result.notified, false);
    assert.equal(calls.length, 0);
  });

  test('a matching linked checkout counts as installed and is reported as linked', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({ [PLUGIN_ID]: [entry({ source: { kind: 'local' } })] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'ok');
    assert.equal(result.linked, true);
    assert.equal(calls.length, 0, 'a healthy linked install stays silent');
  });
});

describe('herdr-plugin-check: silent and harmless failures', { concurrency: false }, () => {
  test('a throwing runner (Herdr CLI absent) never throws and never notifies', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({}, { failWith: new Error('spawn herdr ENOENT') });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
    assert.equal(result.notified, false);
  });

  test('a nonzero plugin list exit fails silent', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const run = () => ({ status: 1, stdout: '', stderr: 'boom', error: null });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
  });

  test('malformed plugin list JSON fails silent', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const run = () => ({ status: 0, stdout: '{ nope', stderr: '', error: null });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
  });

  test('a plugin list without a plugins array fails silent', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const run = () => ({ status: 0, stdout: '{"result":{}}', stderr: '', error: null });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
  });

  test('an unreadable manifest fails silent without notifying', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const { run } = stubRun({ [PLUGIN_ID]: [entry()] });
    const missing = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-'))), 'no.toml');
    const { result, calls } = checkAndNotify({ manifestPath: missing, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
  });

  test('a manifest without a version fails silent', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-')));
    const manifestPath = path.join(dir, 'herdr-plugin.toml');
    fs.writeFileSync(manifestPath, `id = "${PLUGIN_ID}"\nname = "Herdr Gentle Shell"\n`);
    const { run } = stubRun({ [PLUGIN_ID]: [entry()] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
  });

  test('an installed entry without a version fails silent instead of alerting', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const noversion = entry();
    delete noversion.version;
    const { run } = stubRun({ [PLUGIN_ID]: [noversion] });
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
  });

  test('a failing legacy lookup after zero active hits fails silent', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const run = (bin, args) => {
      const at = args.indexOf('--plugin');
      if (args[at + 1] === PLUGIN_ID) {
        return { status: 0, stdout: listDoc([]), stderr: '', error: null };
      }
      throw new Error('legacy lookup failed');
    };
    const { result, calls } = checkAndNotify({ manifestPath, run, env: {} });
    assert.equal(result.status, 'silent');
    assert.equal(calls.length, 0);
  });

  test('the real default runner against a missing binary fails silent', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const result = pluginCheck.checkHerdrPlugin({
      manifestPath,
      env: { HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-herdr-xyz') },
    });
    assert.equal(result.status, 'silent');
  });

  test('without a notify function the message is still computed and nothing throws', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({});
    const result = pluginCheck.checkAndNotifyHerdrPlugin({ manifestPath, run, env: {} });
    assert.equal(result.status, 'missing');
    assert.equal(result.notified, false);
    assert.ok(result.message.includes(`${INSTALL_PREFIX}0.4.0`));
  });

  test('no mismatch alert ever mentions /reload', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const legacy = { ...entry(), plugin_id: LEGACY_PLUGIN_ID };
    const cases = [
      stubRun({}),
      stubRun({ [LEGACY_PLUGIN_ID]: [legacy] }),
      stubRun({ [PLUGIN_ID]: [entry({ enabled: false })] }),
      stubRun({ [PLUGIN_ID]: [entry({ version: '0.3.0' })] }),
      stubRun({ [PLUGIN_ID]: [entry({ version: '0.3.0', source: { kind: 'local' } })] }),
    ];
    for (const stub of cases) {
      pluginCheck.resetHerdrPluginCheckForTests();
      const { result } = checkAndNotify({ manifestPath, run: stub.run, env: {} });
      assert.ok(result.message, `a mismatch carries a message (${result.status})`);
      assert.ok(!result.message.includes('/reload'), `${result.status} never mentions /reload`);
    }
  });

  test('the check writes no user config', () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const home = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-home-')));
    const { run } = stubRun({});
    checkAndNotify({
      manifestPath,
      run,
      env: { HOME: home, XDG_STATE_HOME: home, XDG_CONFIG_HOME: home },
    });
    assert.deepEqual(fs.readdirSync(home), [], 'no config is written anywhere');
  });
});

// ---------------------------------------------------------------------------
// Extension wiring: the check runs at session startup, once per session.
// ---------------------------------------------------------------------------

const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText
  .replace(
    'import { Type } from "@earendil-works/pi-ai";',
    TYPE_STUB,
  )
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

function scratchStateEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-state-'))) };
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, commands, handlers, mod };
}

// Fixture `herdr` shim: answers `plugin list --json` from
// HERDR_PLUGIN_CHECK_JSON, exits HERDR_PLUGIN_CHECK_EXIT otherwise 0.
// Never touches a real Herdr server.
function makeHerdrShim() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-herdr-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'code="${HERDR_PLUGIN_CHECK_EXIT:-0}"',
      '[ "$code" = "0" ] || exit "$code"',
      "printf '%s' \"$HERDR_PLUGIN_CHECK_JSON\"",
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

function shippedVersion() {
  return pluginCheck.readShippedVersion(pluginCheck.defaultManifestPath());
}

function fireSessionStart(handlers, { json, exit = '0', notes } = {}) {
  setEnv({
    HERDR_PLUGIN_CHECK_JSON: json,
    HERDR_PLUGIN_CHECK_EXIT: exit,
  });
  const ctx = {
    cwd: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-cwd-'))),
    ui: { notify: (message, level) => { notes.push([message, level]); } },
  };
  return (async () => {
    for (const handler of handlers.get('session_start') || []) {
      await handler({ reason: 'startup' }, ctx);
    }
  })();
}

// Only this check's own alerts, for every describe that drives a real startup.
// `fireSessionStart` runs EVERY registered `session_start` handler, and another
// one legitimately notifies too: the `/herdr-gentle:issues` gate sends one
// message when `gh` is missing or unauthenticated, which is exactly the CI
// runner's state and never this checkout's. Counting every startup
// notification measured that handler instead of this one.
//
// The predicate is sound and complete for this check: every message it can
// emit names the plugin id — the drift and disabled/local-link alerts, and the
// sidebar switch-off notices whose cause and command both carry it — while the
// gate's message names `/herdr-gentle:issues` instead.
const pluginAlerts = (notes) => notes.filter(([message]) => String(message).includes(PLUGIN_ID));

describe('herdr-plugin-check wiring at session startup', { concurrency: false }, () => {
  test('a version drift at startup notifies once with the update command', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const shipped = shippedVersion();
    assert.match(shipped, /^\d+\.\d+\.\d+$/, 'the shipped manifest carries a version');
    const shim = makeHerdrShim();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: shim,
      ...scratchStateEnv(),
    });
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      assert.ok((handlers.get('session_start') || []).length > 0, 'a session_start hook is registered');
      const json = listDoc([entry({ version: '9.9.9' })]);
      await fireSessionStart(handlers, { json, notes });
      await fireSessionStart(handlers, { json, notes });
      assert.equal(pluginAlerts(notes).length, 1, 'exactly one alert per session across two startups');
      const [message, level] = pluginAlerts(notes)[0];
      assert.equal(level, 'info');
      assert.ok(message.includes(PLUGIN_ID), `names the plugin id: ${message}`);
      assert.ok(message.includes('9.9.9') && message.includes(shipped), `names both versions: ${message}`);
      assert.ok(message.includes(UPDATE_COMMAND), `carries the update command: ${message}`);
      assert.ok(!message.includes('/reload'), 'never tells the user to run /reload');
    } finally {
      restoreEnv();
    }
  });

  test('a matching install at startup stays silent', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const shipped = shippedVersion();
    const shim = makeHerdrShim();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: shim,
      ...scratchStateEnv(),
    });
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      await fireSessionStart(handlers, { json: listDoc([entry({ version: shipped })]), notes });
      assert.equal(pluginAlerts(notes).length, 0, 'a healthy install notifies nothing');
    } finally {
      restoreEnv();
    }
  });

  test('a missing Herdr binary at startup fails silent without throwing', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-herdr-xyz'),
      ...scratchStateEnv(),
    });
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      await fireSessionStart(handlers, { json: '{}', notes });
      assert.equal(pluginAlerts(notes).length, 0, 'no alert when Herdr is unavailable');
    } finally {
      restoreEnv();
    }
  });

  test('a failing plugin list at startup fails silent without throwing', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const shim = makeHerdrShim();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      HERDR_BIN_PATH: shim,
      ...scratchStateEnv(),
    });
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      await fireSessionStart(handlers, { json: '{}', exit: '1', notes });
      assert.equal(pluginAlerts(notes).length, 0, 'no alert when the list call errors');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// T1/S2/S5: the startup flow also owns the sidebar option. The extension
// supplies a `sidebar` handle that drives the panel's own writer; the lib owns
// the once-per-session message and the install-command source, so a switch-off
// is never announced as a success it did not achieve.
// ---------------------------------------------------------------------------

describe('herdr-plugin-check: sidebar enable refusal literal (S3/S4)', { concurrency: false }, () => {
  test('missing, disabled and inconclusive each name the concrete fix command', () => {
    const missing = pluginCheck.sidebarEnableRefusal('missing');
    assert.ok(missing.includes(PLUGIN_ID), `names the plugin: ${missing}`);
    assert.ok(
      missing.includes('herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin'),
      `names the install command: ${missing}`,
    );
    assert.ok(missing.includes(ENABLE_COMMAND), `carries the enable step: ${missing}`);
    assert.ok(missing.includes('cannot be enabled'), `is a refusal, not an alert: ${missing}`);
    assert.ok(!missing.includes('/reload'), 'never asks for /reload');
    const disabled = pluginCheck.sidebarEnableRefusal('disabled');
    assert.ok(disabled.includes(ENABLE_COMMAND), `names the enable command: ${disabled}`);
    assert.notEqual(missing, disabled, 'the two fixes are distinct strings');
    const unknown = pluginCheck.sidebarEnableRefusal('unknown');
    assert.ok(unknown.includes('could not determine'), `reports the inconclusive lookup: ${unknown}`);
    assert.ok(
      unknown.includes('herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin'),
      `still names the install command: ${unknown}`,
    );
  });
});

function sidebarHandle({ side = 'gentle', rows = false, applyResult } = {}) {
  const calls = { read: 0, applied: [], rowsManaged: 0 };
  let state = side;
  return {
    handle: {
      read() {
        calls.read += 1;
        return state;
      },
      async apply(value) {
        calls.applied.push(value);
        if (applyResult && applyResult.changed) state = 'native';
        return applyResult || { changed: false, needsReload: false, text: 'stub' };
      },
      rowsManaged() {
        calls.rowsManaged += 1;
        return rows;
      },
    },
    calls,
  };
}

describe('herdr-plugin-check: startup auto-disable (T1/S2/S5)', { concurrency: false }, () => {
  test('a missing plugin switches the option OFF through the panel writer in one honest message', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({});
    const notes = [];
    const { handle, calls } = sidebarHandle({
      side: 'gentle',
      rows: true,
      applyResult: { changed: true, needsReload: true, text: 'Gentle sidebar disabled.' },
    });
    const result = await pluginCheck.checkAndHandleHerdrPluginStartup({
      manifestPath,
      run,
      env: {},
      notify: (message, level) => notes.push([message, level]),
      sidebar: handle,
    });
    assert.deepEqual(calls.applied, ['native'], 'the panel writer runs with the native value');
    assert.equal(notes.length, 1, 'exactly one message');
    assert.equal(notes[0][1], 'info');
    const message = notes[0][0];
    assert.ok(/switched OFF/.test(message), `says it was switched off: ${message}`);
    assert.ok(
      message.includes('herdr plugin install jonasotoaguilar/herdr-gentle-agents/herdr-plugin --ref herdr-v0.4.0'),
      `names the install command: ${message}`,
    );
    assert.ok(/rows were left as found/.test(message), `notes the deliberately left rows: ${message}`);
    assert.equal(result.switchedOff, true);
    assert.equal(result.notified, true);
  });

  test('a usable plugin leaves the sidebar option untouched and stays quiet', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({ [PLUGIN_ID]: [entry()] });
    const notes = [];
    const { handle, calls } = sidebarHandle({ side: 'gentle' });
    await pluginCheck.checkAndHandleHerdrPluginStartup({
      manifestPath,
      run,
      env: {},
      notify: (message) => notes.push(message),
      sidebar: handle,
    });
    assert.deepEqual(calls.applied, [], 'the sidebar is never touched');
    assert.equal(notes.length, 0, 'a healthy install stays quiet');
  });

  test('an option already off is never touched (the existing plugin alert still fires)', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({});
    const notes = [];
    const { handle, calls } = sidebarHandle({ side: 'native' });
    await pluginCheck.checkAndHandleHerdrPluginStartup({
      manifestPath,
      run,
      env: {},
      notify: (message) => notes.push(message),
      sidebar: handle,
    });
    assert.deepEqual(calls.applied, [], 'nothing to switch off');
    assert.equal(notes.length, 1);
    assert.ok(notes[0].includes('is not installed'), 'the existing plugin alert, not a sidebar claim');
    assert.ok(!/switched OFF/.test(notes[0]), 'never claims a switch that did not happen');
  });

  test('a failing switch-off write reports the truth: still ON, and why', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    const manifestPath = writeManifest('0.4.0');
    const { run } = stubRun({});
    const notes = [];
    const { handle } = sidebarHandle({
      side: 'gentle',
      applyResult: {
        changed: false,
        needsReload: false,
        text: 'Could not disable: cannot write /x: EACCES. Mode unchanged.',
      },
    });
    const result = await pluginCheck.checkAndHandleHerdrPluginStartup({
      manifestPath,
      run,
      env: {},
      notify: (message) => notes.push(message),
      sidebar: handle,
    });
    assert.equal(result.switchedOff, false);
    assert.equal(notes.length, 1);
    assert.ok(/could NOT be switched off/.test(notes[0]), `honest outcome: ${notes[0]}`);
    assert.ok(/still ON/.test(notes[0]), `says it is still on: ${notes[0]}`);
    assert.ok(notes[0].includes('EACCES'), `carries the reason: ${notes[0]}`);
  });
});

// ---------------------------------------------------------------------------
// T1 end to end: the state extension registers the panel's sidebar writer slot,
// so the worktree-tools session_start hook switches the option off through the
// same path the customize panel uses.
// ---------------------------------------------------------------------------

const STATE_SRC_PATH = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
const stateSourceText = fs.readFileSync(STATE_SRC_PATH, 'utf8');
const stateStubbed = stateSourceText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stateStubbed !== stateSourceText, 'expected the state extension package import to be stubbed');

async function loadStateProviders() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-stateext-')));
  const copy = path.join(dir, 'gentle-herdr-state.mjs');
  fs.writeFileSync(copy, stateStubbed);
  const mod = await import(pathToFileURL(copy).href);
  mod.default({ on: () => {}, events: { on: () => {}, emit: () => {} } });
  return mod;
}

function seedSidebarWorld({ mode = 'enabled', nativeHook = true, settings, marker = false, managedRows = false } = {}) {
  const stateDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-sb-state-')));
  const agentDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-sb-agent-')));
  const config = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-plugin-check-sb-cfg-'))), 'config.toml');
  if (mode === 'enabled') fs.writeFileSync(path.join(stateDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":true}\n');
  if (mode === 'disabled') fs.writeFileSync(path.join(stateDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  if (nativeHook) fs.writeFileSync(path.join(agentDir, 'extensions', 'herdr-agent-state.ts'), '// native\n');
  const settingsPath = path.join(agentDir, 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  if (marker) {
    fs.writeFileSync(
      path.join(stateDir, 'pi-extension-exclusion-owned'),
      `${JSON.stringify({ version: 1, entry: '-extensions/herdr-agent-state.ts', settings: fs.realpathSync(settingsPath) })}\n`,
    );
  }
  if (managedRows) {
    fs.writeFileSync(
      config,
      '# user\n# BEGIN herdr-gentle-agents (managed; do not edit)\n[ui.sidebar.agents.rows_by_agent]\n# END herdr-gentle-agents\n',
    );
  }
  return { stateDir, agentDir, config, settingsPath };
}

function setSidebarWorldEnv(fx) {
  setEnv({
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    HERDR_BIN_PATH: makeHerdrShim(),
    GENTLE_STATUS_STATE_DIR: fx.stateDir,
    PI_CODING_AGENT_DIR: fx.agentDir,
    GENTLE_PI_AGENT_HOME: undefined,
    HERDR_PLUGIN_STATE_DIR: undefined,
    HERDR_CONFIG_PATH: fx.config,
  });
}

describe('herdr-plugin-check: startup auto-disable end to end (T1)', { concurrency: false }, () => {
  test('a missing plugin switches the option OFF and converges mode and the owned exclusion', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    await loadStateProviders();
    const shipped = shippedVersion();
    const fx = seedSidebarWorld({
      mode: 'enabled',
      settings: { extensions: ['-extensions/other-state.ts', '-extensions/herdr-agent-state.ts'], theme: 'x' },
      marker: true,
      managedRows: true,
    });
    setSidebarWorldEnv(fx);
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      await fireSessionStart(handlers, { json: listDoc([]), notes });
      const mode = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'gentle-sidebar-mode.json'), 'utf8'));
      assert.equal(mode.enabled, false, 'the option converged OFF through the panel writer');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(fx.settingsPath, 'utf8')).extensions,
        ['-extensions/other-state.ts'],
        'the owned exclusion was removed',
      );
      assert.ok(!fs.existsSync(path.join(fx.stateDir, 'pi-extension-exclusion-owned')), 'the marker was dropped');
      assert.match(fs.readFileSync(fx.config, 'utf8'), /BEGIN herdr-gentle-agents/, 'managed rows deliberately left as found');
      assert.equal(pluginAlerts(notes).length, 1, 'exactly one message');
      assert.ok(/switched OFF/.test(pluginAlerts(notes)[0][0]), pluginAlerts(notes)[0][0]);
      assert.ok(pluginAlerts(notes)[0][0].includes(`--ref herdr-v${shipped}`), `names the shipped install ref: ${pluginAlerts(notes)[0][0]}`);
      assert.ok(/rows were left as found/.test(pluginAlerts(notes)[0][0]), `says the rows were left: ${pluginAlerts(notes)[0][0]}`);
    } finally {
      restoreEnv();
    }
  });

  test('a usable plugin at startup leaves the option and its files untouched', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    await loadStateProviders();
    const shipped = shippedVersion();
    const fx = seedSidebarWorld({
      mode: 'enabled',
      settings: { extensions: ['-extensions/other-state.ts', '-extensions/herdr-agent-state.ts'] },
      marker: true,
      managedRows: true,
    });
    setSidebarWorldEnv(fx);
    const before = {
      settings: fs.readFileSync(fx.settingsPath, 'utf8'),
      config: fs.readFileSync(fx.config, 'utf8'),
      marker: fs.readFileSync(path.join(fx.stateDir, 'pi-extension-exclusion-owned'), 'utf8'),
    };
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      await fireSessionStart(handlers, { json: listDoc([entry({ version: shipped })]), notes });
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'gentle-sidebar-mode.json'), 'utf8')).enabled,
        true,
        'the option is untouched',
      );
      assert.equal(fs.readFileSync(fx.settingsPath, 'utf8'), before.settings);
      assert.equal(fs.readFileSync(fx.config, 'utf8'), before.config);
      assert.equal(fs.readFileSync(path.join(fx.stateDir, 'pi-extension-exclusion-owned'), 'utf8'), before.marker);
      assert.equal(pluginAlerts(notes).length, 0, 'a usable plugin stays quiet');
    } finally {
      restoreEnv();
    }
  });

  test('an option already off is never touched (the plugin alert still fires)', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    await loadStateProviders();
    const fx = seedSidebarWorld({ mode: 'disabled', nativeHook: false, settings: { extensions: ['-extensions/other-state.ts'] } });
    setSidebarWorldEnv(fx);
    const before = fs.readFileSync(fx.settingsPath, 'utf8');
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      await fireSessionStart(handlers, { json: listDoc([]), notes });
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'gentle-sidebar-mode.json'), 'utf8')).enabled,
        false,
        'the option stays off',
      );
      assert.equal(fs.readFileSync(fx.settingsPath, 'utf8'), before);
      assert.equal(pluginAlerts(notes).length, 1);
      assert.ok(!/switched OFF/.test(pluginAlerts(notes)[0][0]), `no sidebar claim: ${pluginAlerts(notes)[0][0]}`);
    } finally {
      restoreEnv();
    }
  });

  test('a failing switch-off write reports the truth: still ON, and why', async () => {
    pluginCheck.resetHerdrPluginCheckForTests();
    await loadStateProviders();
    const fx = seedSidebarWorld({ mode: 'missing', nativeHook: true, settings: {} });
    setSidebarWorldEnv(fx);
    fs.chmodSync(fx.stateDir, 0o555);
    const notes = [];
    try {
      const { handlers } = await loadExtension();
      await fireSessionStart(handlers, { json: listDoc([]), notes });
      assert.equal(pluginAlerts(notes).length, 1);
      assert.ok(/could NOT be switched off/.test(pluginAlerts(notes)[0][0]), `honest outcome: ${pluginAlerts(notes)[0][0]}`);
      assert.ok(/still ON/.test(pluginAlerts(notes)[0][0]), `says it is still on: ${pluginAlerts(notes)[0][0]}`);
    } finally {
      fs.chmodSync(fx.stateDir, 0o755);
      restoreEnv();
    }
  });
});
