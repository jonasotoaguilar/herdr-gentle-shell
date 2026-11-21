'use strict';
// The Herdr page of Gentle Shell's own customize menu, as the extension wires it
// (odd/tasks/herdr-customize-page.md T2/T3; specs S1-S4).
//
// What these tests pin, through the two surfaces the user actually gets and
// nothing else:
// - S1/S2: `/herdr-gentle:customize` is registered in the FACTORY, before any
//   session event and before the pane gate, exactly as on `865d360`; when
//   gentle-shell-bridge answers the runtime handshake (the published object at
//   `Symbol.for("gentle-shell-bridge/api/v1")`, not a package dependency) the
//   extension ADDS one row provider on the `Herdr` page beside it. The page is
//   additive: no user can end up with none, and the command never goes away;
// - the page is idempotent: a late `gentle-shell-bridge:ready` announce still
//   produces it, and a second `session_start` or a repeated announce leaves
//   exactly ONE provider, never two;
// - a bridge that answers with no host menu changes nothing for the command: the
//   provider is either refused (and the command keeps working) or harmless;
// - the provider reads the live model on every build, so `current()` is the
//   stored value and not a copy taken at registration;
// - S3: a row action runs the command's own apply path — the theme switch writes
//   `gentle-theme.json`, and a Moshi refusal leaves the flag and settings.json
//   byte-identical while the refusal reaches the user exactly ONCE;
// - S4: every refusal still names `/herdr-gentle:customize`, byte for byte the
//   text `865d360` shipped: the command always exists, so no message needs a
//   surface-dependent wording;
// - the Moshi reload: the exclusion write still lands, and because a row action
//   has no reload handle the notice asks for a restart instead of claiming a
//   reload that cannot happen;
// - the disposer: session shutdown removes the provider only — the command stays
//   as registered — and a second session adds one provider again.
//
// The bridge is a handshake, not an import: the tests publish a frozen object at
// the documented symbol exactly as `src/api.ts` does, and the extension is never
// given a package dependency to resolve.

const { describe, test, after, beforeEach } = require('node:test');
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
const HANDLES_BRIDGE = srcText.includes('gentle-shell-bridge');
assert.equal(
  /^import .*gentle-shell-bridge/m.test(srcText),
  false,
  'the bridge is a handshake, never an import',
);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-bridge-page-'));
// The copied extension lives outside the repo, so the row builder is loaded from
// the real lib/ through the documented override.
process.env.GENTLE_CUSTOMIZE_LIB_DIR = path.join(REPO_ROOT, 'lib');
const COPY = path.join(ROOT, 'gentle-herdr-state.mjs');
fs.writeFileSync(COPY, srcText);
const copyUrl = pathToFileURL(COPY).href;

// The whole surface must work outside a Herdr pane: the pane gate is closed for
// every test in this file.
delete process.env.HERDR_ENV;
delete process.env.HERDR_SOCKET_PATH;
delete process.env.HERDR_PANE_ID;
const factoryPromise = import(copyUrl);

const COMMAND = 'herdr-gentle:customize';
// The bridge's published key, mirrored by hand exactly like `src/api.ts`: this
// file cannot import it either.
const BRIDGE_API_KEY = Symbol.for('gentle-shell-bridge/api/v1');
const PAGE = 'Herdr';
const THEME_UNASSIGN = 'Off (no theme assigned)';
// The package's ONE wording for "that theme is not installed": the notice the
// theme-sync surface already gives for a stored name this install does not have
// (`extensions/herdr-theme-sync.ts`, S4). A refusal reuses it instead of
// inventing a second spelling for the same fact.
const THEME_NOT_INSTALLED = (name) =>
  `The Pi theme "${name}" is not installed, so Herdr's palette was left unchanged; pick an installed theme in /herdr-gentle:customize.`;

/* ------------------------------------------------------------ fixtures */

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function fixture(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The published bridge object, with the shape gate's members (`schema`,
// `version`, `registerRows`, `registerSection`, `createStore`) and nothing the
// extension is allowed to require beyond `registerRows`.
function fakeBridge() {
  const rows = new Map();
  const registrations = [];
  const disposes = [];
  const api = {
    schema: 'gentle-shell-bridge/api',
    version: 1,
    VERSION: '0.8.0-test',
    registerRows(provider) {
      registrations.push(provider);
      rows.set(provider.id, provider);
      return () => {
        disposes.push(provider.id);
        if (rows.get(provider.id) === provider) rows.delete(provider.id);
      };
    },
    registerSection() {
      throw new Error('the page is a row category, never a sidebar section');
    },
    createStore() {
      throw new Error('the page stores nothing through the bridge');
    },
  };
  return {
    api,
    rows,
    registrations,
    disposes,
    publish() {
      globalThis[BRIDGE_API_KEY] = Object.freeze(api);
    },
  };
}

function harness({ bridge, themes = ['Dark', 'Light'] } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const listeners = new Map();
  const notices = [];
  const reloads = [];
  const pi = {
    on(kind, handler) {
      const list = handlers.get(kind) ?? [];
      if (typeof handler === 'function') list.push(handler);
      handlers.set(kind, list);
      return () => {};
    },
    // Pi's event bus, as the bridge's own `onBridgeApi` uses it: the announce is
    // a notification, never a registry.
    events: {
      on(name, handler) {
        const list = listeners.get(name) ?? [];
        if (typeof handler === 'function') list.push(handler);
        listeners.set(name, list);
        return () => {};
      },
      emit: () => {},
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  const ui = {
    notify: (message, level) => notices.push([message, level ?? 'info']),
    select: async () => undefined,
    // Pi's own theme catalogue, the shape `ctx.ui.getAllThemes()` documents.
    getAllThemes: () => themes.map((name) => ({ name, path: `/themes/${name}.json` })),
  };
  const ctx = { ui, reload: async () => reloads.push(true) };
  const h = {
    pi,
    ctx,
    commands,
    notices,
    reloads,
    handlers,
    listeners,
    bridge: bridge ?? null,
  };
  h.load = async () => {
    const mod = await factoryPromise;
    mod.default(pi);
    return mod;
  };
  // Pi's own order: the factory returns, then session_start arrives.
  h.start = async () => {
    for (const handler of handlers.get('session_start') ?? []) {
      await handler({ reason: 'startup' }, ctx);
    }
  };
  h.shutdown = async () => {
    for (const handler of handlers.get('session_shutdown') ?? []) {
      await handler({ reason: 'quit' }, ctx);
    }
  };
  // The one provider the bridge holds for the Herdr page, if any.
  h.provider = () => {
    if (!bridge) return undefined;
    for (const provider of bridge.rows.values()) {
      if (provider.category === PAGE) return provider;
    }
    return undefined;
  };
  // The bridge announces itself on its own channel; the symbol stays the
  // authority, so an announce after the publish is all a late bridge needs.
  h.announce = () => {
    for (const handler of listeners.get('gentle-shell-bridge:ready') ?? []) handler({});
  };
  h.noticeTexts = () => notices.map(([message]) => message);
  return h;
}

function setupEnvironment(name, { moshiHooks = false } = {}) {
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
  process.env.GENTLE_CUSTOMIZE_LIB_DIR = path.join(REPO_ROOT, 'lib');
  process.env.GENTLE_HERDR_PLUGIN_ROOT = path.join(REPO_ROOT, 'herdr-plugin');
  const configPath = path.join(dir, 'config.toml');
  fs.writeFileSync(configPath, '');
  process.env.HERDR_CONFIG_PATH = configPath;
  process.env.HERDR_BIN_PATH = path.join(dir, 'fake-bin', 'herdr');
  const pathDir = path.join(dir, 'path-bin');
  fs.mkdirSync(pathDir, { recursive: true });
  process.env.PATH = pathDir;
  return {
    dir,
    stateDir,
    agentDir,
    pathDir,
    settingsPath: path.join(agentDir, 'settings.json'),
    flagPath: path.join(stateDir, 'gentle-moshi.json'),
    themePath: path.join(stateDir, 'gentle-theme.json'),
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

function readThemeFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The row for one value of one line, the way the host finds it: the line's NAME
// and the value word, never the apply path's structural id.
function rowFor(rows, line, value) {
  const row = rows.find((candidate) => candidate.choice && candidate.choice.setting === line && candidate.choice.value === value);
  assert.ok(row, `no row for ${line} = ${value}; got ${JSON.stringify(rows.map((r) => [r.choice && r.choice.setting, r.choice && r.choice.value]))}`);
  return row;
}

const INLINE_HELPERS = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

beforeEach(() => {
  // Every test owns its own answer from the bridge.
  delete globalThis[BRIDGE_API_KEY];
});

after(() => {
  delete globalThis[BRIDGE_API_KEY];
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------ tests */

describe('the command always exists and the page is added beside it (S1, S2)', () => {
  test('the extension reaches the bridge by symbol, never by import', () => {
    assert.equal(HANDLES_BRIDGE, true, 'the handshake symbols are inlined in the extension');
  });

  test('with the bridge present: the command AND one Herdr page provider', async () => {
    const env = setupEnvironment('bridge-present');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    // S1/S2: the command is there before any session event, exactly as on
    // 865d360 — the page never replaces it.
    assert.ok(h.commands.has(COMMAND), 'the command is registered in the factory');
    await h.start();

    assert.equal(h.commands.has(COMMAND), true, 'a session never removes the command');
    assert.equal(bridge.rows.size, 1, 'exactly one provider is registered');
    assert.deepEqual(bridge.disposes, [], 'the provider is live, not disposed');

    const provider = h.provider();
    assert.ok(provider, `a provider owns the ${PAGE} page`);
    assert.equal(typeof provider.rows, 'function');
    const rows = provider.rows();
    assert.ok(rows.length > 0, 'the page is not empty');
    for (const row of rows) assert.equal(row.category, PAGE);
    const lines = [...new Set(rows.map((row) => row.choice.setting))];
    assert.deepEqual(lines, ['Herd agents', 'Moshi', 'Theme sync', 'Select theme']);
    // Every theme in Pi's catalogue plus the unassign entry is on the page.
    assert.ok(rowFor(rows, 'Select theme', THEME_UNASSIGN));
    assert.ok(rowFor(rows, 'Select theme', 'Dark'));
  });

  test('without the bridge: today\'s command works and no page is contributed (S2)', async () => {
    const env = setupEnvironment('bridge-absent');
    writeSettings(env.settingsPath, { extensions: [] });
    const h = harness();
    await h.load();
    assert.ok(h.commands.has(COMMAND), 'the command is registered at factory time');
    await h.start();

    const command = h.commands.get(COMMAND);
    assert.ok(command, 'the command stays registered outside a Herdr pane');
    assert.match(command.description, /sidebar agent rows/);
    assert.match(command.description, /Moshi notifications/);
    assert.equal(h.provider(), undefined, 'no page is contributed without a bridge');

    // The registered handler is the one that works today: `status` prints one
    // read-only line and writes nothing.
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    await command.handler('status', h.ctx);
    assert.deepEqual(h.noticeTexts(), [
      'customize status: sidebar=off moshi=off theme-sync=off theme=none',
    ]);
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
  });

  test('the provider reads the live model on every build', async () => {    const env = setupEnvironment('live-model');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();
    const provider = h.provider();
    assert.ok(provider);

    const first = provider.rows();
    assert.equal(rowFor(first, 'Moshi', 'On').choice.current(), false);
    assert.equal(rowFor(first, 'Moshi', 'Off').choice.current(), true);

    // The stored state changes behind the page: a new build must show it.
    fs.writeFileSync(env.flagPath, `${JSON.stringify({ enabled: true })}\n`);
    const second = provider.rows();
    assert.notEqual(second, first, 'every build is a fresh row set');
    assert.equal(rowFor(second, 'Moshi', 'On').choice.current(), true);
    assert.equal(rowFor(second, 'Moshi', 'Off').choice.current(), false);
  });
});

describe('the rows apply through the command\'s own path (S3)', () => {
  test('a row action changes the stored state through the real switch path', async () => {
    const env = setupEnvironment('row-applies');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();
    const provider = h.provider();

    const on = rowFor(provider.rows(), 'Theme sync', 'On');
    await on.action(INLINE_HELPERS);

    assert.equal(readThemeFile(env.themePath).sync, true, 'the theme store is the real one');
    assert.deepEqual(h.noticeTexts(), [
      "Theme sync on; Herdr's palette follows the theme active in Pi.",
    ]);
    assert.deepEqual(h.reloads, [], 'the theme switch needs no Pi reload');
    // The host repaints after the action, so the live build shows the new value.
    assert.equal(rowFor(provider.rows(), 'Theme sync', 'On').choice.current(), true);
  });

  test('a refused row writes nothing and surfaces the refusal once', async () => {
    const env = setupEnvironment('row-refused');
    writeSettings(env.settingsPath, { extensions: ['keep-me'] });
    const settingsBefore = fs.readFileSync(env.settingsPath, 'utf8');
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();
    const provider = h.provider();

    // No `moshi-hook` on PATH: the prerequisite gate refuses before any write.
    await rowFor(provider.rows(), 'Moshi', 'On').action(INLINE_HELPERS);

    assert.equal(h.notices.length, 1, 'the refusal is reported exactly once');
    const [text, level] = h.notices[0];
    assert.equal(level, 'error');
    assert.match(text, /Moshi notifications cannot be enabled/);
    assert.match(text, /`moshi-hook` CLI was not found on PATH/);
    assert.equal(fs.existsSync(env.flagPath), false, 'no flag file was written');
    assert.equal(fs.readFileSync(env.settingsPath, 'utf8'), settingsBefore);
    assert.deepEqual(h.reloads, []);
  });

  test('the Moshi exclusion write lands and the reload becomes a restart notice', async () => {
    const env = setupEnvironment('row-moshi-reload', { moshiHooks: true });
    writeSettings(env.settingsPath, { extensions: [] });
    installMoshiHook(env.pathDir, { paired: true });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();
    const provider = h.provider();

    await rowFor(provider.rows(), 'Moshi', 'On').action(INLINE_HELPERS);

    // The write the command performs is still performed...
    assert.equal(JSON.parse(fs.readFileSync(env.flagPath, 'utf8')).enabled, true);
    assert.deepEqual(readSettings(env.settingsPath).extensions, ['-extensions/moshi-hooks.ts']);
    // ...and the sentence says what a row can actually do: a row action has no
    // reload handle, so the user restarts Pi. The WHOLE notice, level included.
    assert.deepEqual(h.notices, [[
      'Moshi notifications enabled. added -extensions/moshi-hooks.ts. Restart Pi so the new Moshi hook exclusion takes effect.',
      'info',
    ]]);
    assert.deepEqual(h.reloads, [], 'no reload is attempted from a row');
    assert.equal(rowFor(provider.rows(), 'Moshi', 'On').choice.current(), true);
  });

  // The verifier's regression, shaped like the host: Gentle Shell's
  // VisualCustomizeView repaints the rows it ALREADY mounted
  // (`lib/visual-customize-view.ts:224-231`, `:391-392` re-read `choice.current()`
  // and the gate on the same objects after the action settles), so a second
  // build proves nothing — the mounted objects must answer the applied state.
  test('the rows the host already mounted repaint the applied state', async () => {
    const env = setupEnvironment('row-mounted-repaint');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();

    // ONE build. These are the objects the host holds and repaints.
    const mounted = h.provider().rows();
    const on = rowFor(mounted, 'Theme sync', 'On');
    const theme = rowFor(mounted, 'Select theme', 'Dark');
    assert.equal(on.choice.current(), false, 'the sync starts off');
    assert.equal(theme.visible(), true, 'so the picker is shown');

    // Enter on `On`: the command's own apply path writes the real store.
    await on.action(INLINE_HELPERS);
    assert.equal(readThemeFile(env.themePath).sync, true, 'the store really says sync: true');

    // No rebuild, no reopen: the SAME objects.
    assert.deepEqual([on.choice.current(), theme.visible()], [true, false], 'the bullet moves and the picker disappears in place');
  });
});

// T10 (independent verification, reproduced on the real host): the page holds
// ONE ROW PER THEME from the build, so a theme removed from the catalogue
// afterwards keeps a selectable row. The command's own picker cannot do this —
// it reads the catalogue when it prompts — so the page applied the vanished name
// and claimed success. The apply now checks the name against a FRESH read before
// it writes, and a name that is gone refuses instead of landing in the store.
describe('a mounted theme row never writes a theme that no longer exists (T10)', () => {
  test('a removed theme is refused, the store stays untouched and no success is claimed', async () => {
    const env = setupEnvironment('theme-vanished');
    writeSettings(env.settingsPath, { extensions: [] });
    const catalog = ['Dark', 'Light'];
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge, themes: catalog });
    await h.load();
    await h.start();

    // ONE build: these are the objects the host keeps and repaints.
    const mounted = h.provider().rows();
    const dark = rowFor(mounted, 'Select theme', 'Dark');

    // The catalogue changes behind the open menu: `Dark` is uninstalled.
    catalog.splice(catalog.indexOf('Dark'), 1);
    assert.deepEqual(catalog, ['Light']);

    // Enter on the stale row: no write, and the refusal the package already
    // gives for a theme this install does not have — never a success notice.
    await dark.action(INLINE_HELPERS);
    assert.deepEqual(h.notices, [[THEME_NOT_INSTALLED('Dark'), 'warning']]);
    assert.equal(fs.existsSync(env.themePath), false, 'no store document is created');
    assert.deepEqual(h.reloads, [], 'nothing is reloaded either');
  });

  test('a theme that still exists applies, and the unassign entry is unchanged', async () => {
    const env = setupEnvironment('theme-still-there');
    writeSettings(env.settingsPath, { extensions: [] });
    const catalog = ['Dark', 'Light'];
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge, themes: catalog });
    await h.load();
    await h.start();
    const mounted = h.provider().rows();

    // The same catalogue change, then Enter on a theme that is still installed.
    catalog.splice(catalog.indexOf('Dark'), 1);
    await rowFor(mounted, 'Select theme', 'Light').action(INLINE_HELPERS);
    const doc = readThemeFile(env.themePath);
    assert.equal(doc.theme, 'Light', 'a theme that still exists is written');
    assert.equal(doc.sync, false, 'a pinned theme never turns the sync on');
    assert.deepEqual(h.notices, [['Gentle Shell theme set to Light.', 'info']]);

    // The unassign choice is not a theme name: it keeps working, catalogue or
    // not, and still writes the stored `null`.
    await rowFor(mounted, 'Select theme', THEME_UNASSIGN).action(INLINE_HELPERS);
    assert.equal(readThemeFile(env.themePath).theme, null, 'the pin is cleared');
    assert.deepEqual(h.notices.slice(1), [[
      'Gentle Shell theme set to Off; Herdr keeps the palette it was last given.',
      'info',
    ]]);
    assert.deepEqual(h.reloads, []);
  });

  test('an unreadable catalogue at apply time refuses with its own honest sentence', async () => {
    const env = setupEnvironment('theme-catalogue-gone');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();
    const dark = rowFor(h.provider().rows(), 'Select theme', 'Dark');

    // The host can no longer answer the catalogue: existence cannot be proven,
    // so nothing is written and the page says exactly that — in its own words,
    // never the command's "this host exposes no getAllThemes()" sentence, which
    // describes a different fact (the accessor existed a moment ago).
    h.ctx.ui.getAllThemes = () => { throw new Error('catalogue gone'); };
    await dark.action(INLINE_HELPERS);
    assert.deepEqual(h.notices, [[
      "Could not read Pi's theme list at apply time; nothing was changed.",
      'warning',
    ]]);
    assert.equal(fs.existsSync(env.themePath), false, 'nothing was written');
    assert.deepEqual(h.reloads, []);
  });
});

// S3 ordering (independent verification): with the stored sync ON the gate is the
// ONLY thing the user can act on — the pinned theme is not available at all — so
// it must answer FIRST, exactly as it does on every other surface. The apply path
// used to read the catalogue before the gate, which turned "Turn Theme sync off"
// into a refusal about a theme the row could never apply in the first place.
//
// The shape is the host's: the rows are built once and repainted, and the cache
// window (`lib/customize-rows.js`) keeps the picker on screen while another
// process turns the sync on, so the clock is pinned and the row is provably still
// visible when Enter arrives.
describe('the sync gate answers before the catalogue check (S3)', () => {
  // Pin `Date.now` for the duration of the action: the row cache expires after
  // 1000ms, and this test is about the mounted row, not about a rebuild.
  function frozenClock(now) {
    const real = Date.now;
    Date.now = () => now;
    return () => {
      Date.now = real;
    };
  }

  function writeThemeFile(file, doc) {
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  }

  // Mount the page once, then let ANOTHER process turn the sync on and change the
  // catalogue. Returns the mounted `Dark` row, still visible, about to be Entered.
  async function mountedRowWithSyncOn(name, changeCatalogue) {
    const env = setupEnvironment(name);
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();

    // ONE build: these are the objects the host keeps and repaints. The clock is
    // pinned to the instant of that build, so the cache window never lapses and
    // the row stays exactly as mounted.
    const mounted = h.provider().rows();
    const dark = rowFor(mounted, 'Select theme', 'Dark');
    const mountedAt = Date.now();

    writeThemeFile(env.themePath, { sync: true, theme: 'Dark', updatedAt: '2024-01-01T00:00:00.000Z' });
    changeCatalogue(h.ctx.ui);
    const before = fs.readFileSync(env.themePath);
    return { env, h, dark, before, mountedAt };
  }

  async function assertSyncSentenceWins({ env, h, dark, before, mountedAt }) {
    const restore = frozenClock(mountedAt);
    try {
      assert.equal(dark.visible(), true, 'the picker is still mounted inside its cache window');
      await dark.action(INLINE_HELPERS);
    } finally {
      restore();
    }
    // The gate's sentence and nothing else: no catalogue refusal, no success.
    assert.deepEqual(h.notices, [['Turn Theme sync off to pick a specific theme.', 'warning']]);
    assert.ok(before.equals(fs.readFileSync(env.themePath)), 'the theme document is byte-unchanged');
    assert.deepEqual(h.reloads, [], 'nothing is reloaded either');
  }

  test('a theme removed from the catalogue while the sync is on gets the sync sentence', async () => {
    const state = await mountedRowWithSyncOn('sync-gate-theme-vanished', (ui) => {
      // The theme is uninstalled behind the open menu: the catalogue no longer
      // lists `Dark`, so the pre-fix ordering answered "not installed".
      ui.getAllThemes = () => [{ name: 'Light', path: '/themes/Light.json' }];
    });
    await assertSyncSentenceWins(state);
  });

  test('an unreadable catalogue while the sync is on gets the sync sentence', async () => {
    const state = await mountedRowWithSyncOn('sync-gate-catalogue-throws', (ui) => {
      ui.getAllThemes = () => {
        throw new Error('catalogue gone');
      };
    });
    await assertSyncSentenceWins(state);
  });
});

describe('every message names the command that always exists (S4)', () => {
  test('a page refusal keeps the 865d360 spelling', async () => {
    const env = setupEnvironment('s4-strings');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();
    const provider = h.provider();

    await rowFor(provider.rows(), 'Moshi', 'On').action(INLINE_HELPERS);
    const [text] = h.notices[0];
    // S4: the command is always registered, so no string needs a
    // surface-dependent wording and the page's refusals are byte for byte the
    // ones the command gives (tools/gentle-customize-command.test.js pins the
    // same bytes on the command's own path).
    assert.equal(
      text,
      'Moshi notifications cannot be enabled: the `moshi-hook` CLI was not found on PATH; install the Moshi CLI, then re-apply On from /herdr-gentle:customize.',
    );
    assert.equal(text.includes('customize menu'), false, 'no message names a menu that may be absent');
  });

  test('the unpaired refusal keeps it too, in its own sentence', async () => {
    const env = setupEnvironment('s4-not-paired');
    writeSettings(env.settingsPath, { extensions: [] });
    installMoshiHook(env.pathDir, { paired: false });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();

    await rowFor(h.provider().rows(), 'Moshi', 'On').action(INLINE_HELPERS);

    assert.deepEqual(h.notices, [[
      'Moshi notifications cannot be enabled: `moshi-hook status --json` reports paired:false (this device is not paired); run `moshi-hook pair --token <pairing-token>`, then re-apply On from /herdr-gentle:customize.',
      'error',
    ]]);
    assert.equal(fs.existsSync(env.flagPath), false, 'the refusal writes nothing');
  });
});

describe('the page is additive, never a replacement (S1, S2)', () => {
  test('a bridge that answers with no host menu leaves the command working', async () => {
    const env = setupEnvironment('no-host-menu');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    // The published object is valid, but there is no host menu to add a page to:
    // its bus refuses this provider. The verifier's "zero surfaces" defect must
    // never come back — the command is registered before this is even asked.
    bridge.api.registerRows = () => {
      throw new Error('the page was refused');
    };
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();

    assert.equal(bridge.rows.size, 0, 'no page is offered');
    const command = h.commands.get(COMMAND);
    assert.ok(command, 'the command is the reachable surface');
    await command.handler('status', h.ctx);
    assert.deepEqual(h.noticeTexts(), [
      'customize status: sidebar=off moshi=off theme-sync=off theme=none',
    ]);
  });

  test('a provider that exists beside the command is harmless', async () => {
    const env = setupEnvironment('page-beside-command');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();

    assert.equal(bridge.rows.size, 1, 'the page exists');
    const command = h.commands.get(COMMAND);
    assert.ok(command, 'and so does the command');
    await command.handler('status', h.ctx);
    assert.deepEqual(h.noticeTexts(), [
      'customize status: sidebar=off moshi=off theme-sync=off theme=none',
    ]);
  });
});

describe('exactly one provider, never two', () => {
  test('a late bridge announce still produces the page', async () => {
    const env = setupEnvironment('late-announce');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    // The bridge is NOT published yet: this is the load order the verifier
    // found, where a global extension sees `session_start` before a configured
    // package's module publishes.
    const h = harness({ bridge });
    await h.load();
    await h.start();

    assert.ok(h.commands.has(COMMAND), 'the command is there from the factory');
    assert.equal(bridge.rows.size, 0, 'no page before the bridge answers');

    bridge.publish();
    h.announce();
    assert.equal(bridge.rows.size, 1, 'the page appears anyway');
    assert.equal(h.commands.has(COMMAND), true, 'and the command stays');

    // A repeated announce and a second session start: still exactly one.
    h.announce();
    await h.start();
    assert.equal(bridge.rows.size, 1, 'one provider, never two');
    assert.equal(bridge.registrations.length, 1, 'and the provider was registered once');
  });

  test('session shutdown drops the provider and keeps the command', async () => {
    const env = setupEnvironment('dispose');
    writeSettings(env.settingsPath, { extensions: [] });
    const bridge = fakeBridge();
    bridge.publish();
    const h = harness({ bridge });
    await h.load();
    await h.start();

    const firstProvider = h.provider();
    assert.ok(firstProvider);
    assert.equal(bridge.rows.size, 1);

    await h.shutdown();
    assert.deepEqual(bridge.disposes, [firstProvider.id], 'the provider is disposed');
    assert.equal(bridge.rows.size, 0, 'no provider survives the session');
    assert.ok(h.commands.has(COMMAND), 'the command survives it: only the page is session-scoped');

    await h.start();
    assert.equal(bridge.rows.size, 1, 'the next session adds one provider again');
    assert.notEqual(h.provider(), firstProvider);
    assert.equal(h.commands.has(COMMAND), true, 'and still one command');
  });
});
