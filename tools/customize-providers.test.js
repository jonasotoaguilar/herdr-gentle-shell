'use strict';
// T1 (customize-command S6) tests: the provider slot the state extension
// registers for the customize panel.
//
// The sidebar and moshi actions are NOT reimplemented and NOT extracted:
// they stay inline in extensions/gentle-herdr-state.ts, which registers
// them once at load into the single provider slot
// `globalThis[Symbol.for("herdr-gentle.customize.v1")]` as
// `{sidebar:{read,apply}, moshi:{read,apply}}`, where read() returns the
// active value id and apply(value, ctx) returns
// {changed, needsReload, text} through the existing sidebarEnable /
// sidebarDisable and writeMoshiFlag / setMoshiExclusion /
// moshiFlagEnabled paths unchanged.
//
// Only observable behavior is asserted: the slot shape, the value ids,
// the returned verdicts, the state files, and the registered commands.
// Never internal function names.
//
// Loading pattern mirrors tools/gentle-sidebar-toggle.test.js: the
// TypeScript extension is plain JS under the hood, so the test copies it
// to a fresh temporary .mjs path per load with the single package import
// line stubbed and import()s it with a fake `pi` object.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
const CONFIGURE_SRC = path.resolve(__dirname, '../herdr-plugin/bin/configure.js');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');

const SLOT_KEY = 'herdr-gentle.customize.v1';

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

// Fresh module copy per load (import() caches by URL): the slot closure
// always belongs to this load.
async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-prov-')));
  const copy = path.join(dir, 'gentle-herdr-state.mjs');
  fs.writeFileSync(copy, stubbed);
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    events: { on: () => {}, emit: () => {} },
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { commands, mod };
}

function takeSlot() {
  const key = Symbol.for(SLOT_KEY);
  const slot = globalThis[key];
  delete globalThis[key];
  return slot;
}

function makeCtx() {
  const notes = [];
  return {
    ctx: { ui: { notify: (message, level) => { notes.push([message, level]); } } },
    notes,
  };
}

// Isolated state/agent/config dirs plus a fake `herdr` shim whose
// `plugin list` reports the fixture plugin root (a copy of the real
// self-contained bin/configure.js), mirroring
// tools/gentle-sidebar-toggle.test.js.
function fixture() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-fix-')));
  const stateDir = path.join(dir, 'state');
  const agentDir = path.join(dir, 'agent');
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  const configFile = path.join(dir, 'herdr-config.toml');
  const pluginRoot = path.join(dir, 'plugin');
  fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  fs.copyFileSync(CONFIGURE_SRC, path.join(pluginRoot, 'bin', 'configure.js'));
  const shimDir = path.join(dir, 'shimbin');
  fs.mkdirSync(shimDir, { recursive: true });
  const shimLog = path.join(dir, 'herdr-argv.log');
  const shim = path.join(shimDir, 'herdr');
  fs.writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${shimLog}"`,
      'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
      '  if [ "${HERDR_SHIM_NO_PLUGIN:-0}" = "1" ]; then printf \'{"id":"cli:plugin","result":{"plugins":[]}}\\n\'; exit 0; fi',
      '  printf \'{"id":"cli:plugin","result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s"}]}}\\n\' "$HERDR_SHIM_PLUGIN_ROOT"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, stateDir, agentDir, configFile, pluginRoot, shimDir, shim, shimLog };
}

function shimCalls(shimLog) {
  try {
    return fs.readFileSync(shimLog, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

describe('customize provider slot', { concurrency: false }, () => {
  test('the state extension registers the slot once at load with the exact shape', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      assert.ok(slot && typeof slot === 'object', 'expected the provider slot to be registered');
      assert.deepEqual(Object.keys(slot).sort(), ['moshi', 'sidebar'], 'the slot carries exactly the two inline providers');
      for (const name of ['sidebar', 'moshi']) {
        assert.equal(typeof slot[name].read, 'function', `${name}.read`);
        assert.equal(typeof slot[name].apply, 'function', `${name}.apply`);
      }
    } finally {
      restoreEnv();
    }
  });

  test('the old sidebar and moshi commands are gone (S7)', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      const { commands } = await loadExtension();
      assert.ok(!commands.has('herdr-gentle:sidebar'), 'the sidebar toggle is removed outright (S7)');
      assert.ok(!commands.has('herdr-gentle:moshi'), 'the moshi toggle is removed outright (S7)');
    } finally {
      restoreEnv();
    }
  });

  test('sidebar read reports the active value id (missing mode means gentle)', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      assert.equal(slot.sidebar.read(), 'gentle', 'missing mode defaults to enabled, like the command');
      fs.mkdirSync(fix.stateDir, { recursive: true });
      fs.writeFileSync(path.join(fix.stateDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
      assert.equal(slot.sidebar.read(), 'native');
      fs.writeFileSync(path.join(fix.stateDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":true}\n');
      assert.equal(slot.sidebar.read(), 'gentle');
    } finally {
      restoreEnv();
    }
  });

  test('sidebar apply reuses the existing disable path: writes the mode file and always needs reload', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
      PATH: `${fix.shimDir}${path.delimiter}${savedEnv.PATH ?? ''}`,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.sidebar.apply('native', ctx);
      assert.equal(result.changed, true);
      assert.equal(result.needsReload, true, 'S6: the sidebar switch always reloads');
      assert.equal(typeof result.text, 'string');
      assert.ok(!result.text.includes('/reload'), 'the panel never asks the user to run /reload');
      assert.deepEqual(
        readJson(path.join(fix.stateDir, 'gentle-sidebar-mode.json')),
        { version: 1, enabled: false },
        'the existing disable path wrote the mode file',
      );
    } finally {
      restoreEnv();
    }
  });

  test('sidebar apply with the already-active value changes nothing and runs nothing', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
      PATH: `${fix.shimDir}${path.delimiter}${savedEnv.PATH ?? ''}`,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.sidebar.apply('gentle', ctx);
      assert.equal(result.changed, false);
      assert.equal(result.needsReload, false);
      assert.deepEqual(shimCalls(fix.shimLog), [], 'no configure run for a no-op');
      assert.equal(readJson(path.join(fix.stateDir, 'gentle-sidebar-mode.json')), null, 'no mode file is created');
    } finally {
      restoreEnv();
    }
  });

  test('sidebar apply fails closed when the plugin root cannot be resolved', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      // No herdr binary and no shim root: resolution fails.
      HERDR_BIN_PATH: path.join(fix.dir, 'no-such-herdr'),
      PATH: savedEnv.PATH ?? '',
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.sidebar.apply('native', ctx);
      assert.equal(result.changed, false);
      assert.equal(result.needsReload, false);
      assert.equal(readJson(path.join(fix.stateDir, 'gentle-sidebar-mode.json')), null, 'failure writes nothing');
    } finally {
      restoreEnv();
    }
  });

  test('moshi read reports the active value id (default off)', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      assert.equal(slot.moshi.read(), 'off', 'missing flag defaults to off');
    } finally {
      restoreEnv();
    }
  });

  test('moshi apply refuses while the CLI is missing and writes nothing (S38)', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      const { mod } = await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      // Stubbed discovery (never a real spawn): no CLI resolves.
      assert.equal(typeof mod.setMoshiHookResolver, 'function', 'the resolver seam is exposed');
      assert.equal(typeof mod.setMoshiStatusRunner, 'function', 'the runner seam is exposed');
      const runs = [];
      mod.setMoshiHookResolver(() => null);
      mod.setMoshiStatusRunner((cli) => { runs.push(cli); return { ok: true }; });
      const result = await slot.moshi.apply('on', ctx);
      assert.equal(result.changed, false);
      assert.equal(result.needsReload, false);
      assert.match(result.text, /moshi-hook/);
      assert.deepEqual(runs, [], 'no status run without a CLI');
      assert.ok(!fs.existsSync(path.join(fix.stateDir, 'gentle-moshi.json')), 'a refusal creates no flag file');
      assert.equal(slot.moshi.read(), 'off', 'the switch stays Off');
    } finally {
      restoreEnv();
    }
  });

  test('moshi apply reuses the existing flag path and needs no reload while the hook is not installed', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      const { mod } = await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      // Stubbed prerequisites (never a real spawn): CLI present, paired.
      mod.setMoshiHookResolver(() => '/test-only/moshi-hook');
      mod.setMoshiStatusRunner(() => ({ ok: true }));
      const result = await slot.moshi.apply('on', ctx);
      assert.equal(result.changed, true);
      assert.equal(result.needsReload, false, 'S6: no exclusion change without the hook means no reload');
      assert.equal(typeof result.text, 'string');
      assert.ok(!result.text.includes('/reload'), 'the panel never asks the user to run /reload');
      const flag = readJson(path.join(fix.stateDir, 'gentle-moshi.json'));
      assert.equal(flag && flag.enabled, true, 'the existing flag path wrote the file');
      assert.equal(slot.moshi.read(), 'on', 'read follows the write');
    } finally {
      restoreEnv();
    }
  });

  test('moshi apply with the already-active value writes nothing', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.moshi.apply('off', ctx);
      assert.equal(result.changed, false);
      assert.equal(result.needsReload, false);
      assert.ok(!fs.existsSync(path.join(fix.stateDir, 'gentle-moshi.json')), 'a no-op creates no flag file');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// customize-reset (S1-S5, T1-T3): the panel's reset-to-defaults row.
//
// The reset is ONE routine in extensions/gentle-worktree-tools.ts that writes
// each option's documented default THROUGH the writer the panel's own row
// uses: sidebar -> the state slot's `sidebar.apply('gentle')` (owned exclusion
// + managed Herdr rows + marker), moshi -> `moshi.apply('off')` (flag + the Pi
// settings.json exclusion), worktree -> `worktree-mode writeMode(true)`. It
// never unlinks a flag file, a failed option is named as unchanged, and an
// all-default run writes nothing and says so. It never requires the Herdr
// plugin: the reset is always attempted and an unreachable sidebar default is
// reported honestly. The row is reached through the panel's documented
// fallback menu (no ctx.ui.custom), so every assertion stays at the public
// command surface.
// ---------------------------------------------------------------------------

const WORKTREE_SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const WORKTREE_TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

const worktreeSrcText = fs.readFileSync(WORKTREE_SRC, 'utf8');
const worktreeStubbed = worktreeSrcText
  .replace('import { Type } from "@earendil-works/pi-ai";', WORKTREE_TYPE_STUB)
  .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (def) => def;');
assert.ok(worktreeStubbed !== worktreeSrcText, 'expected both worktree package import lines to be stubbed');

const LIB_DIR = path.resolve(__dirname, '../lib');
const RESET_ROW = 'Reset every option to its default';
const CATEGORY_TITLES = ['Agentes sidebar', 'Moshi notifications', 'Worktree tools', 'Performance switches', 'Reset'];

async function loadWorktreeExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-reset-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, worktreeStubbed);
  const commands = new Map();
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => { commands.set(name, def); },
    on: () => () => {},
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { commands, mod };
}

// The panel degrades to ctx.ui.select when there is no custom surface; the
// answers pick the Reset category and its single row.
function resetCtx() {
  const notes = [];
  const selects = [];
  const reloads = [];
  const ctx = {
    ui: {
      notify: (message, level) => { notes.push([message, level]); },
      select: async (title, options) => {
        selects.push([title, options]);
        if (title === 'Customize · Herdr Gentle Shell') return 'Reset';
        return RESET_ROW;
      },
    },
    reload: async () => { reloads.push(true); },
  };
  return { ctx, notes, selects, reloads };
}

function resetFixture() {
  const fix = fixture();
  // The sidebar enable path only writes the owned exclusion when the managed
  // native hook is on disk.
  fs.writeFileSync(path.join(fix.agentDir, 'extensions', 'herdr-agent-state.ts'), '// native hook\n');
  return fix;
}

function setResetEnv(fix) {
  setEnv({
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: fix.stateDir,
    PI_CODING_AGENT_DIR: fix.agentDir,
    GENTLE_PI_AGENT_HOME: undefined,
    HERDR_CONFIG_PATH: fix.configFile,
    HERDR_BIN_PATH: fix.shim,
    HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    HERDR_SHIM_NO_PLUGIN: undefined,
    PATH: `${fix.shimDir}${path.delimiter}${savedEnv.PATH ?? ''}`,
  });
}

// Records every removal the process reaches, so "written, not deleted" is
// provable rather than inferred from a default read.
function withDeleteSpy(run) {
  const originals = { unlinkSync: fs.unlinkSync, rmSync: fs.rmSync, rmdirSync: fs.rmdirSync };
  const seen = [];
  fs.unlinkSync = (...args) => { seen.push(['unlinkSync', String(args[0] ?? '')]); return originals.unlinkSync.apply(fs, args); };
  fs.rmSync = (...args) => { seen.push(['rmSync', String(args[0] ?? '')]); return originals.rmSync.apply(fs, args); };
  fs.rmdirSync = (...args) => { seen.push(['rmdirSync', String(args[0] ?? '')]); return originals.rmdirSync.apply(fs, args); };
  return Promise.resolve()
    .then(run)
    .then((value) => ({ value, seen }))
    .finally(() => {
      fs.unlinkSync = originals.unlinkSync;
      fs.rmSync = originals.rmSync;
      fs.rmdirSync = originals.rmdirSync;
    });
}

function flagPath(fix, name) {
  return path.join(fix.stateDir, name);
}

describe('customize reset to defaults', { concurrency: false }, () => {
  test('the row writes every documented default through the existing writers and deletes no flag file', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    takeSlot();
    try {
      fs.mkdirSync(fix.stateDir, { recursive: true });
      // Every option off its default, plus the two out-of-band effects the
      // reset must converge: the moshi Pi exclusion and the sidebar's Herdr
      // rows/marker.
      fs.writeFileSync(flagPath(fix, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
      fs.writeFileSync(flagPath(fix, 'gentle-moshi.json'), `${JSON.stringify({ enabled: true })}\n`);
      fs.writeFileSync(flagPath(fix, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
      fs.writeFileSync(path.join(fix.agentDir, 'extensions', 'moshi-hooks.ts'), '// moshi hook\n');
      fs.writeFileSync(path.join(fix.agentDir, 'settings.json'), `${JSON.stringify({ extensions: ['-extensions/moshi-hooks.ts'] }, null, 2)}\n`);
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes, selects, reloads } = resetCtx();
      const { seen } = await withDeleteSpy(() => commands.get('herdr-gentle:customize').handler('', ctx));

      // The row is discoverable through the panel's public menu: the Reset
      // category plus its single clear label.
      assert.deepEqual(selects[0][1], CATEGORY_TITLES, 'the panel lists the Reset category last');
      assert.deepEqual(selects[1][1], [RESET_ROW], 'the Reset pane carries exactly one row');

      assert.deepEqual(readJson(flagPath(fix, 'gentle-sidebar-mode.json')), { version: 1, enabled: true }, 'sidebar returns to gentle');
      assert.equal(readJson(flagPath(fix, 'gentle-moshi.json')).enabled, false, 'moshi returns to off');
      assert.deepEqual(readJson(flagPath(fix, 'gentle-worktree-mode.json')), { version: 1, enabled: true }, 'worktree returns to enabled');
      assert.ok(fs.existsSync(flagPath(fix, 'gentle-sidebar-mode.json')), 'the sidebar flag is rewritten, never removed');
      assert.ok(fs.existsSync(flagPath(fix, 'gentle-moshi.json')), 'the moshi flag is rewritten, never removed');
      assert.ok(fs.existsSync(flagPath(fix, 'gentle-worktree-mode.json')), 'the worktree flag is rewritten, never removed');
      for (const name of ['gentle-sidebar-mode.json', 'gentle-moshi.json', 'gentle-worktree-mode.json']) {
        assert.ok(
          !seen.some(([, target]) => target === flagPath(fix, name)),
          `${name} is never unlinked or removed`,
        );
      }

      // Sidebar convergence: owned exclusion + marker + Herdr managed rows.
      const settings = readJson(path.join(fix.agentDir, 'settings.json')) || {};
      const extensions = Array.isArray(settings.extensions) ? settings.extensions : [];
      assert.ok(extensions.includes('-extensions/herdr-agent-state.ts'), 'the sidebar reset added the owned exclusion');
      assert.ok(fs.existsSync(path.join(fix.stateDir, 'pi-extension-exclusion-owned')), 'the sidebar reset recorded ownership');
      assert.match(String(fs.readFileSync(fix.configFile, 'utf8')), /# BEGIN herdr-gentle-agents \(managed; do not edit\)/, 'the sidebar reset converged the Herdr managed rows');
      // Moshi convergence: the excluded hook entry is cleared again.
      assert.ok(!extensions.includes('-extensions/moshi-hooks.ts'), 'the moshi reset cleared its Pi settings exclusion');

      assert.deepEqual(notes, [['Defaults saved.', 'info']]);
      assert.equal(reloads.length, 1, 'the sidebar switch needs a reload and the reset performs it');
    } finally {
      takeSlot();
      restoreEnv();
    }
  });

  test('the row reports nothing to reset and writes nothing when all three already match', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    takeSlot();
    try {
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes, selects, reloads } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      assert.deepEqual(selects[1][1], [RESET_ROW]);
      assert.deepEqual(notes, [['Nothing to reset: sidebar, moshi, worktree and performance switches already match their defaults.', 'info']]);
      assert.ok(!fs.existsSync(flagPath(fix, 'gentle-sidebar-mode.json')), 'nothing to reset creates no sidebar flag');
      assert.ok(!fs.existsSync(flagPath(fix, 'gentle-moshi.json')), 'nothing to reset creates no moshi flag');
      assert.ok(!fs.existsSync(flagPath(fix, 'gentle-worktree-mode.json')), 'nothing to reset creates no worktree flag');
      assert.deepEqual(shimCalls(fix.shimLog), [], 'nothing to reset never even looks up the plugin');
      assert.deepEqual(reloads, [], 'nothing to reset never reloads');
    } finally {
      takeSlot();
      restoreEnv();
    }
  });

  test('an absent flag already reads its default and stays absent while the reset runs for the others', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    takeSlot();
    try {
      fs.mkdirSync(fix.stateDir, { recursive: true });
      fs.writeFileSync(flagPath(fix, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      assert.ok(!fs.existsSync(flagPath(fix, 'gentle-sidebar-mode.json')), 'an absent sidebar flag stays absent at its default');
      assert.ok(!fs.existsSync(flagPath(fix, 'gentle-moshi.json')), 'an absent moshi flag stays absent at its default');
      assert.deepEqual(readJson(flagPath(fix, 'gentle-worktree-mode.json')), { version: 1, enabled: true }, 'the worktree default is written');
      assert.deepEqual(notes, [['Defaults saved.', 'info']]);
    } finally {
      takeSlot();
      restoreEnv();
    }
  });

  test('a failing writer is named as unchanged in a partial reset while the others stay applied', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    const key = Symbol.for(SLOT_KEY);
    const hadSlot = globalThis[key];
    const calls = [];
    globalThis[key] = {
      sidebar: {
        read: () => 'native',
        apply: (value) => { calls.push(['sidebar', value]); return { changed: true, needsReload: false, text: 'Gentle sidebar enabled (ours).' }; },
      },
      moshi: {
        read: () => 'on',
        apply: (value) => {
          calls.push(['moshi', value]);
          return { changed: false, needsReload: false, text: 'Could not write the moshi flag: permission denied; nothing was changed.' };
        },
      },
    };
    try {
      fs.mkdirSync(fix.stateDir, { recursive: true });
      fs.writeFileSync(flagPath(fix, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      assert.deepEqual(calls, [['sidebar', 'gentle'], ['moshi', 'off']], 'both writers are reached, never skipped');
      assert.deepEqual(readJson(flagPath(fix, 'gentle-worktree-mode.json')), { version: 1, enabled: true }, 'the other options stay applied');
      assert.deepEqual(notes, [[
        'Partial reset: sidebar changed, moshi unchanged, worktree changed. Could not write the moshi flag: permission denied; nothing was changed.',
        'info',
      ]]);
    } finally {
      if (hadSlot === undefined) delete globalThis[key];
      else globalThis[key] = hadSlot;
      restoreEnv();
    }
  });

  test('with the Herdr plugin missing the reset reports the sidebar OFF default as applying', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    setEnv({ HERDR_SHIM_NO_PLUGIN: '1' });
    takeSlot();
    try {
      fs.mkdirSync(fix.stateDir, { recursive: true });
      // Exactly the state the startup auto-disable leaves behind.
      fs.writeFileSync(flagPath(fix, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
      fs.writeFileSync(flagPath(fix, 'gentle-moshi.json'), `${JSON.stringify({ enabled: true })}\n`);
      fs.writeFileSync(flagPath(fix, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      assert.deepEqual(readJson(flagPath(fix, 'gentle-sidebar-mode.json')), { version: 1, enabled: false }, 'the sidebar default is unreachable without the plugin and honestly stays off');
      assert.equal(readJson(flagPath(fix, 'gentle-moshi.json')).enabled, false, 'moshi still reaches its default');
      assert.deepEqual(readJson(flagPath(fix, 'gentle-worktree-mode.json')), { version: 1, enabled: true }, 'worktree still reaches its default');
      // S6/T4: OFF is the default that applies without the plugin, so the
      // notice reads as that default applying, never as a partial miss.
      assert.deepEqual(notes.map((note) => note[1]), ['info'], 'the reset reports once, at info level');
      assert.doesNotMatch(notes[0][0], /Partial reset/, 'a correct conditional default is never a partial failure');
      assert.match(notes[0][0], /^Defaults saved\./, 'moshi and worktree still reach their defaults');
      assert.match(notes[0][0], /default is OFF without the herdr-gentle-shell Herdr plugin/, 'the conditional default is stated');
      assert.match(notes[0][0], /herdr plugin install jonasotoaguilar\/herdr-gentle-agents\/herdr-plugin/, 'the install command still names the real fix');
      assert.match(notes[0][0], /herdr plugin enable herdr-gentle-shell/, 'the enable half of the fix is present');
    } finally {
      takeSlot();
      restoreEnv();
    }
  });

  test('nothing to reset with the plugin absent and the sidebar already off by default', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    setEnv({ HERDR_SHIM_NO_PLUGIN: '1' });
    takeSlot();
    try {
      fs.mkdirSync(fix.stateDir, { recursive: true });
      // Sidebar off (its conditional default), moshi off and worktree enabled
      // are all the defaults that apply in this state.
      fs.writeFileSync(flagPath(fix, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes, reloads } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      assert.match(notes[0][0], /^Nothing to reset:/, 'an off sidebar is nothing to reset while the plugin is missing');
      assert.match(notes[0][0], /sidebar .*OFF by default/, 'the conditional default is stated');
      assert.match(notes[0][0], /herdr plugin install jonasotoaguilar\/herdr-gentle-agents\/herdr-plugin/, 'the nothing-to-reset notice also names the real fix');
      assert.deepEqual(readJson(flagPath(fix, 'gentle-sidebar-mode.json')), { version: 1, enabled: false }, 'the sidebar stays off');
      assert.ok(!fs.existsSync(flagPath(fix, 'gentle-moshi.json')), 'nothing to reset creates no moshi flag');
      assert.ok(!fs.existsSync(flagPath(fix, 'gentle-worktree-mode.json')), 'nothing to reset creates no worktree flag');
      assert.deepEqual(reloads, [], 'nothing to reset never reloads');
    } finally {
      takeSlot();
      restoreEnv();
    }
  });

  test('the reset enumerates all four pi performance keys and returns them to OFF', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    takeSlot();
    try {
      const keys = ['heightIndex', 'evictOffscreenLines', 'expandRecentToolOutput', 'incrementalSearchCorpus'];
      const on = Object.fromEntries(keys.map((key) => [key, true]));
      fs.writeFileSync(
        path.join(fix.agentDir, 'settings.json'),
        `${JSON.stringify({ ...on, theme: 'gentle' }, null, 2)}\n`,
      );
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes, reloads } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      const settings = readJson(path.join(fix.agentDir, 'settings.json'));
      for (const key of keys) {
        assert.equal(settings[key], false, `${key} returns to its OFF default`);
      }
      assert.equal(settings.theme, 'gentle', 'unrelated settings survive the performance reset');
      assert.match(notes[0][0], /^Defaults saved\./, 'the switches were something to reset, and it succeeded');
      assert.equal(reloads.length, 1, 'changing a performance switch needs a reload and the reset performs it');
    } finally {
      takeSlot();
      restoreEnv();
    }
  });

  test('a performance switch alone is something to reset, and is named when its write fails', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    takeSlot();
    try {
      // A malformed file: the performance writer refuses it, the row must say
      // so, and the other option's reset must not claim the switches changed.
      fs.writeFileSync(path.join(fix.agentDir, 'settings.json'), '{ "heightIndex": tru');
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      assert.equal(fs.readFileSync(path.join(fix.agentDir, 'settings.json'), 'utf8'), '{ "heightIndex": tru');
      assert.match(notes[0][0], /^Partial reset: /);
      assert.match(notes[0][0], /invalid JSON/, 'the failure names the real obstacle');
    } finally {
      takeSlot();
      restoreEnv();
    }
  });

  test('an off sidebar is something to reset once the plugin is present', async () => {
    const fix = resetFixture();
    setResetEnv(fix);
    takeSlot();
    try {
      fs.mkdirSync(fix.stateDir, { recursive: true });
      fs.writeFileSync(flagPath(fix, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
      await loadExtension();
      const { commands } = await loadWorktreeExtension();
      const { ctx, notes, reloads } = resetCtx();
      await commands.get('herdr-gentle:customize').handler('', ctx);
      assert.deepEqual(notes, [['Defaults saved.', 'info']], 'the off sidebar is reset, not reported as already default');
      assert.deepEqual(readJson(flagPath(fix, 'gentle-sidebar-mode.json')), { version: 1, enabled: true }, 'the plugin-present default is ON and gets restored');
      assert.equal(reloads.length, 1, 'the sidebar switch still reloads');
    } finally {
      takeSlot();
      restoreEnv();
    }
  });
});
