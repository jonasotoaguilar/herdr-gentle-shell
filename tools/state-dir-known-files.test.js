'use strict';
// One known-file family for every state-dir resolver.
//
// The stored plugin state dir is proven "ours" by a family of flag files. A
// consumer only falls back from the Herdr-injected dir to the stored dir when
// it recognises one of those files, so a family that differs between
// consumers splits the state between two directories. The visible failure is
// fail-OPEN: a stored `gentle-sidebar-mode.json` disabling publishing is
// invisible to the resolver that does not know the file, so the mode reads as
// MISSING, and missing means enabled.
//
// These tests pin the family file-by-file against the behavior every consumer
// exposes: a stored dir holding ONLY that file, with an empty injected dir,
// must win on every resolver. Legacy behavior stays pinned too (an explicit
// override always wins; a legacy install whose flags live only in the active
// plugin id dir is still found).
//
// S1b: the stored canonical dir is the FINAL fallback, and the active plugin id
// dir (`plugins/herdr-gentle-shell`) is a candidate in every context — not only
// in the daemon that happens to receive HERDR_PLUGIN_STATE_DIR. Every launch
// context must therefore resolve the SAME dir on a fresh install (neither dir
// holding a known file), which is what the cross-context probes below assert.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');

const SIDEBAR = require('../lib/gentle-sidebar.js');
const DIAGNOSTICS = require('../herdr-plugin/lib/gentle-diagnostics.js');
const TRACE = require('../lib/perf-trace.js');
// The daemon's `stateRoot` is not exported; `readSidebarMode()` reads the mode
// file through it, so it is the daemon's state-dir observable.
const STATUS = require('../herdr-plugin/bin/gentle-status.js');

const STORED_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-agents');

// The five resolvers that must agree on the state dir (S1) and the array name
// each one declares the family under. The names are read from source below, so
// drift between them fails a test instead of a manual review.
const RESOLVER_SOURCES = [
  'extensions/gentle-herdr-state.ts',
  'lib/perf-trace.js',
  'lib/gentle-sidebar.js',
  'herdr-plugin/bin/gentle-status.js',
  'herdr-plugin/lib/gentle-diagnostics.js',
];

function knownFileFamilyOf(relativePath) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
  const match = /STATE_KNOWN_FILES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(match, `${relativePath} declares a STATE_KNOWN_FILES family`);
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((entry) => entry[1] ?? entry[2]);
}

// Every file the family must contain. The two retired flag names stay in it
// because an upgraded install still carries them, and a family that differs
// between consumers splits the state across both dirs.
const KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
  'gentle-plugin-tools.json',
];

const roots = [];
after(() => {
  for (const dir of roots) removePath(dir);
});

// Cleanup must never throw on a path the test only pretended to use. A
// candidate below an unusable state home (a regular file) has a non-directory
// ancestor, so its removal fails with ENOTDIR — `force` suppresses ENOENT only,
// and Node 22's recursive implementation surfaces ENOTDIR (Node 26 tolerates
// it). Nothing can exist below a regular file, so an unreachable target is
// already clean; everything the harness actually created is still removed.
function removePath(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw error;
  }
}

function track(dir) {
  roots.push(dir);
  return dir;
}

// The active plugin id dir: what Herdr injects as HERDR_PLUGIN_STATE_DIR, and
// where a pre-fix install may still keep live flags. Derived from the same
// state home so both contexts name the identical path.
const ACTIVE_ID_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-shell');

// A stored (pre-rename) dir plus a Herdr-injected dir, both under one sandbox
// XDG state home, so the stored default is computed the same way every
// resolver computes it. The injected dir is a sibling of the state root, which
// keeps it a genuinely different directory.
function sandbox(tag) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `state-known-${tag}-`)));
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, STORED_SEGMENT);
  const injected = path.join(root, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  return {
    root,
    xdg,
    stored,
    injected,
    agent: path.join(root, 'agent'),
    env: { XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: injected },
  };
}

// The two candidates every context must agree on: the stored canonical dir and
// the active plugin id dir. Nothing is created here — a fresh install has
// neither, and the point of the cross-context probes is that both contexts
// still name the same directory.
function crossSandbox(tag) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `state-known-${tag}-`)));
  const xdg = path.join(root, 'xdg');
  return {
    root,
    xdg,
    stored: path.join(xdg, STORED_SEGMENT),
    activeId: path.join(xdg, ACTIVE_ID_SEGMENT),
    agent: path.join(root, 'agent'),
  };
}

function touch(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body ?? 'placeholder\n');
}

// Two spellings name the same directory when their canonical forms match: the
// T12 rule compares paths, not strings, so a symlinked or relative spelling of
// the derived dir is never rejected as a different directory.
function canonical(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

// The producer extension resolves this same dir for the two flags it reads.
// Its only remaining observable is the sidebar-mode gate: with
// `gentle-sidebar-mode.json` saying enabled:false it publishes nothing at all,
// and a missing file means enabled (the compatibility default). Each probe
// imports its own copy, because the extension captures its environment at
// module load.
function extensionSource() {
  const srcText = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-herdr-state.ts'), 'utf8');
  const stubbed = srcText.replace(
    /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
    'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
  );
  assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');
  return stubbed;
}

// A landed beat requests one coalesced daemon wake, and that refresh flag is
// written into the directory the extension resolved — the producer's only
// observable verdict on the state dir itself. `reports` remains the mode-gate
// observable (a disabled mode file publishes nothing at all).
const REFRESH_FILE = 'gentle-status.refresh';

async function extensionRun(env, waitMs) {
  const sockPath = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-sock-'))), 'herdr.sock');
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const message = JSON.parse(line);
          if (message && message.method === 'pane.report_metadata') seen.push(message.params);
        } catch {}
        try {
          socket.write('{}\n');
        } catch {}
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(sockPath, resolve);
  });
  if (typeof server.unref === 'function') server.unref();

  const copy = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-ext-'))), 'gentle-herdr-state.mjs');
  fs.writeFileSync(copy, extensionSource());
  applyEnv({
    ...env,
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: sockPath,
    HERDR_PANE_ID: 'known-files-pane',
  });
  try {
    const mod = await import(pathToFileURL(copy).href);
    const handlers = new Map();
    const pi = {
      on: (kind, fn) => {
        if (!handlers.has(kind)) handlers.set(kind, []);
        handlers.get(kind).push(fn);
      },
      events: { on: () => {}, emit: () => {} },
    };
    mod.default(pi);
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-repo-')));
    const sessionFile = path.join(cwd, 'session.json');
    fs.writeFileSync(sessionFile, '{}\n');
    const ctx = {
      mode: 'tui',
      cwd,
      sessionManager: { getSessionId: () => 'known-files-session', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => true,
      hasUI: false,
    };
    for (const fn of handlers.get('session_start') ?? []) fn({}, ctx);
    for (const fn of handlers.get('agent_settled') ?? []) fn({}, ctx);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && seen.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return seen.length;
  } finally {
    applyEnv({});
    server.close();
  }
}

// Run one beat in the given env from a clean slate, and report both the number
// of landed reports and which candidate dirs received the refresh flag.
async function extensionResolvedDir(env, candidates, waitMs) {
  for (const dir of candidates) removePath(path.join(dir, REFRESH_FILE));
  const reports = await extensionRun(env, waitMs);
  return { reports, dirs: candidates.filter((dir) => fs.existsSync(path.join(dir, REFRESH_FILE))) };
}

// The daemon's `stateRoot()` is not exported and it CREATES the dir it resolves,
// so the created candidate dir is the resolution.
function daemonResolvedDir(env, candidates) {
  for (const dir of candidates) removePath(dir);
  try {
    applyEnv(env);
    STATUS.readSidebarMode();
  } finally {
    applyEnv({});
  }
  return candidates.filter((dir) => fs.existsSync(dir));
}

const MANAGED_ENV = [
  'XDG_STATE_HOME',
  'HERDR_PLUGIN_STATE_DIR',
  'GENTLE_STATUS_STATE_DIR',
  'GENTLE_PI_AGENT_HOME',
  'PI_CODING_AGENT_DIR',
  'HERDR_ENV',
  'HERDR_SOCKET_PATH',
  'HERDR_PANE_ID',
];
const savedEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));

function applyEnv(vars) {
  for (const key of MANAGED_ENV) {
    const value = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

after(() => {
  applyEnv({});
});

describe('state-dir known-file family', () => {
  // S1: the five resolvers keep byte-identical known-file families, in the same
  // order. A family that differs between consumers splits the state across both
  // dirs, and a flag stored disabled then reads as missing (missing means
  // enabled), so equality is the contract — not "each list is plausible".
  test('every resolver declares the identical eight-file family in the same order', () => {
    const families = RESOLVER_SOURCES.map((relativePath) => [relativePath, knownFileFamilyOf(relativePath)]);
    for (const [relativePath, family] of families) {
      assert.deepEqual(family, KNOWN_FILES, `${relativePath} declares the eight known files in the pinned order`);
      assert.equal(new Set(family).size, family.length, `${relativePath} declares no duplicate`);
    }
    const [referencePath, reference] = families[0];
    for (const [relativePath, family] of families.slice(1)) {
      assert.deepEqual(family, reference, `${relativePath} matches ${referencePath} entry for entry`);
    }
  });

  // The three resolvers whose verdict is directly observable.
  const resolvers = [
    ['sidebar', (env) => SIDEBAR.stateDir(env)],
    ['diagnostics', (env) => DIAGNOSTICS.resolveStateDir(env)],
  ];

  for (const name of KNOWN_FILES) {
    test(`a stored dir holding only ${name} wins on every resolver`, async () => {
      const fixture = sandbox(name.replace(/\W+/g, '-'));
      touch(fixture.stored, name);
      assert.deepEqual(fs.readdirSync(fixture.injected), [], 'the injected dir starts empty');

      for (const [label, resolve] of resolvers) {
        assert.equal(resolve(fixture.env), fixture.stored, `${label} resolves the stored dir for ${name}`);
      }
    });
  }

  // The reported split-brain, without any daemon: a stored dir holding ONLY
  // one family file, an empty injected dir, and a consumer write. The write must
  // not create a second copy of the state that makes the stored value read as
  // missing.
  test('a consumer write cannot move the state to the injected dir', () => {
    const fixture = sandbox('split-brain');
    touch(fixture.stored, 'gentle-plugin-tools.json');
    SIDEBAR.writeMode(true, fixture.env);
    assert.equal(SIDEBAR.modePath(fixture.env), path.join(fixture.stored, 'gentle-sidebar-mode.json'));
    assert.ok(!fs.existsSync(path.join(fixture.injected, 'gentle-sidebar-mode.json')), 'nothing lands in the injected dir');
    assert.equal(SIDEBAR.stateDir(fixture.env), fixture.stored, 'resolution stays on the stored dir after the write');
  });

  // The reported split (L2): one stray family file in the injected dir made
  // every resolver keep choosing it, so the daemon's pidfile landed there and
  // the choice became self-perpetuating. A stray injected file may never
  // outrank the stored family — not for the readers, and not for the daemon
  // that wrote the stray file.
  test('a stray known file in the injected dir never outranks the stored family', () => {
    const fixture = sandbox('trapped');
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    touch(fixture.injected, 'gentle-interruptions.json', '{"version":1,"panes":{}}\n');
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(fixture.env), fixture.stored, `${label} ignores the stray injected file`);
    }
    try {
      applyEnv(fixture.env);
      assert.deepEqual(
        STATUS.readSidebarMode(),
        { enabled: false, malformed: false, raw: null },
        'the daemon resolves the stored dir instead of the dir holding the stray file',
      );
    } finally {
      applyEnv({});
    }
  });

  test('the producer extension prefers the stored dir over a stray injected file', async () => {
    const fixture = sandbox('ext-trapped');
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    touch(fixture.injected, 'gentle-interruptions.json', '{"version":1,"panes":{}}\n');
    assert.equal(await extensionRun(fixture.env, 1200), 0, 'the stored disabled mode gates the producer');
  });

  // The same precedence for the producer when the injected variable names
  // exactly the derived active-id dir: the stored family still wins.
  test('the producer extension prefers the stored family over a stray file in the derived active-id dir', async () => {
    const fixture = crossSandbox('ext-derived-trapped');
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    touch(fixture.activeId, 'gentle-interruptions.json', '{"version":1,"panes":{}}\n');
    assert.equal(
      await extensionRun({ XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: fixture.activeId }, 1200),
      0,
      'the stored disabled mode gates the producer',
    );
  });

  test('an explicit-but-empty override keeps the stored default on every resolver (preserved)', () => {
    const fixture = sandbox('explicit-empty');
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    touch(fixture.injected, 'gentle-status.pid', '123\n');
    const env = { ...fixture.env, GENTLE_STATUS_STATE_DIR: '' };
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(env), fixture.stored, `${label} ignores every override for an empty explicit value`);
    }
    try {
      applyEnv(env);
      assert.equal(STATUS.readSidebarMode().enabled, false, 'the daemon uses the stored default too');
    } finally {
      applyEnv({});
    }
  });

  // S1b: the final fallback is the stored canonical dir, not the injected one.
  // Keeping the injected dir as the last resort made a fresh install split: the
  // daemon created the injected dir while the Pi extension named the absent
  // stored dir, so the producer's refresh write failed and the sidebar fell back
  // to polling.
  test('a fresh install converges on the stored canonical dir on every resolver', () => {
    const fixture = sandbox('fresh');
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(fixture.env), fixture.stored, `${label} uses the stored canonical dir when nothing is stored`);
    }
  });

  // The cross-context regression test: the injected variable must not change the
  // verdict. On a fresh install the daemon sees HERDR_PLUGIN_STATE_DIR and every
  // other context does not, so any difference here IS the split.
  test('a fresh install resolves the same dir with and without the injected variable (cross-context)', () => {
    const fixture = crossSandbox('fresh-cross');
    const onlyXdg = { XDG_STATE_HOME: fixture.xdg };
    const withInjected = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: fixture.activeId };
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(onlyXdg), fixture.stored, `${label} names the stored canonical dir without the variable`);
      assert.equal(resolve(withInjected), resolve(onlyXdg), `${label} resolves the same dir with the injected variable`);
    }
    const candidates = [fixture.stored, fixture.activeId];
    assert.deepEqual(
      daemonResolvedDir(onlyXdg, candidates),
      [fixture.stored],
      'daemon stateRoot creates the stored canonical dir without the variable',
    );
    assert.deepEqual(
      daemonResolvedDir(withInjected, candidates),
      [fixture.stored],
      'daemon stateRoot creates the same dir with the injected variable',
    );
  });

  // S1b legacy case: an install whose live flags sit only in the active plugin
  // id dir. The daemon always found them; every context that never received the
  // injected variable must find them too.
  test('a legacy install holding its flags only in the active-id dir is found without the injected variable (cross-context)', () => {
    const fixture = crossSandbox('legacy-cross');
    touch(fixture.activeId, 'gentle-plugin-tools.json', '{"version":1,"odd":false,"issues":false}\n');
    const onlyXdg = { XDG_STATE_HOME: fixture.xdg };
    const withInjected = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: fixture.activeId };
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(onlyXdg), fixture.activeId, `${label} finds the active-id dir without the variable`);
      assert.equal(resolve(withInjected), resolve(onlyXdg), `${label} agrees with the injected context`);
    }
    try {
      applyEnv({ ...onlyXdg, GENTLE_STATUS_STATE_DIR: undefined });
      assert.deepEqual(
        STATUS.readSidebarMode(),
        { enabled: true, malformed: false, raw: null },
        'the daemon reads the same active-id dir without the injected variable (the tools toggle is not a mode flag)',
      );
    } finally {
      applyEnv({});
    }
  });

  test('a legacy disabled mode flag in the active-id dir gates the daemon without the injected variable', () => {
    const fixture = crossSandbox('legacy-mode-cross');
    touch(fixture.activeId, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    for (const env of [{ XDG_STATE_HOME: fixture.xdg }, { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: fixture.activeId }]) {
      try {
        applyEnv(env);
        assert.deepEqual(
          STATUS.readSidebarMode(),
          { enabled: false, malformed: false, raw: null },
          'the daemon honours the active-id mode flag in both contexts',
        );
      } finally {
        applyEnv({});
      }
    }
  });

  test('the producer extension resolves the stored canonical dir on a fresh install with and without the injected variable', async () => {
    const fixture = crossSandbox('ext-fresh-cross');
    fs.mkdirSync(fixture.stored, { recursive: true });
    fs.mkdirSync(fixture.activeId, { recursive: true });
    const candidates = [fixture.stored, fixture.activeId];
    const withoutVariable = await extensionResolvedDir({ XDG_STATE_HOME: fixture.xdg }, candidates, 3000);
    assert.deepEqual(withoutVariable.dirs, [fixture.stored], 'the extension requests its refresh in the stored canonical dir');
    const withVariable = await extensionResolvedDir(
      { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: fixture.activeId },
      candidates,
      3000,
    );
    assert.deepEqual(withVariable.dirs, withoutVariable.dirs, 'the injected variable changes nothing on a fresh install');
  });

  test('the producer extension finds a legacy install whose flags live only in the active-id dir', async () => {
    const fixture = crossSandbox('ext-legacy-cross');
    // A disabled mode flag is visible only if the extension resolved that dir;
    // anywhere else it reads as missing, and missing means enabled.
    touch(fixture.activeId, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    const withoutVariable = await extensionRun({ XDG_STATE_HOME: fixture.xdg }, 2000);
    const withVariable = await extensionRun({ XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: fixture.activeId }, 2000);
    assert.equal(withVariable, 0, 'the injected context reads the active-id disabled mode');
    assert.equal(withoutVariable, withVariable, 'the extension reads the same active-id mode without the variable');
  });

  test('the producer extension resolves the stored dir: a disabled sidebar mode gates its beats', async () => {
    const fixture = sandbox('ext-mode');
    // A stored mode file is visible only if the extension resolved the stored
    // dir; any other resolution would read it as missing, and missing means
    // enabled, so a beat would arrive.
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    assert.equal(await extensionRun(fixture.env, 1200), 0, 'a stored disabled mode stops the producer');
    removePath(path.join(fixture.stored, 'gentle-sidebar-mode.json'));
    assert.ok(await extensionRun(fixture.env, 3000) > 0, 'without the flag the producer publishes (missing means enabled)');
  });

  // S1c: HERDR_PLUGIN_STATE_DIR is honoured only when its basename names a dir
  // this package owns — the active plugin id or the stored canonical segment.
  // Any other path (a third plugin id, a stale name, a dev/linked id) is
  // ignored. The daemon receives the variable and the producer never does, so
  // honouring an unrelated path IS the split independent verification of T7
  // recorded (L12): one `gentle-status.pid` in a directory this package does
  // not own selected it for the daemon while the extension resolved stored.
  test('an unrelated populated injected dir is ignored by the daemon and every resolver', () => {
    const fixture = crossSandbox('unowned-injected');
    const foreign = path.join(fixture.root, 'plugins', 'third-plugin');
    touch(foreign, 'gentle-status.pid', '123\n');
    // Nothing owned holds a family file, so the unrelated dir is the only one
    // that looks like ours: before S1c it won for the daemon (L12).
    const daemonEnv = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: foreign };
    const producerEnv = { XDG_STATE_HOME: fixture.xdg };
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(daemonEnv), fixture.stored, `${label} ignores the unrelated injected dir`);
      assert.equal(resolve(daemonEnv), resolve(producerEnv), `${label} agrees across both contexts`);
    }
    try {
      applyEnv(daemonEnv);
      STATUS.readSidebarMode();
      assert.ok(fs.existsSync(fixture.stored), 'the daemon resolves the stored dir, not the unrelated one');
      assert.ok(!fs.existsSync(fixture.activeId), 'the daemon never selects a dir this package does not own');
    } finally {
      applyEnv({});
    }
  });

  test('an unrelated populated injected dir changes nothing for the producer extension (cross-context)', async () => {
    const fixture = crossSandbox('unowned-injected-ext');
    const foreign = path.join(fixture.root, 'plugins', 'third-plugin');
    touch(foreign, 'gentle-status.pid', '123\n');
    // Neither owned candidate holds a family file, so before S1c the injected
    // context resolved the unrelated dir while the producer resolved stored.
    fs.mkdirSync(fixture.stored, { recursive: true });
    const candidates = [fixture.stored, fixture.activeId, foreign];
    const withoutVariable = await extensionResolvedDir({ XDG_STATE_HOME: fixture.xdg }, candidates, 3000);
    assert.deepEqual(withoutVariable.dirs, [fixture.stored], 'the producer writes its refresh in the stored dir');
    const withVariable = await extensionResolvedDir(
      { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: foreign },
      candidates,
      3000,
    );
    assert.deepEqual(withVariable.dirs, withoutVariable.dirs, 'the unrelated injected dir changes nothing');
  });

  // S1c (T12): an owned BASENAME is not enough — the injected path must BE the
  // directory this package derives for that name under the resolved state home.
  // An owned name under ANOTHER root is the case the basename-only rule let
  // through: the daemon (which receives the variable) selected there while a
  // context without it derived its own state home, so the state split exactly
  // as in L12. One known file there is what made it look like ours.
  test('an owned-basename injected dir under a different root is ignored (cross-context)', () => {
    const fixture = crossSandbox('owned-foreign-root');
    const onlyXdg = { XDG_STATE_HOME: fixture.xdg };
    for (const owned of ['herdr-gentle-shell', 'herdr-gentle-agents']) {
      const foreignRoot = path.join(fixture.root, 'other-herdr');
      const injected = path.join(foreignRoot, owned);
      touch(injected, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
      const env = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: injected };
      for (const [label, resolve] of resolvers) {
        assert.equal(resolve(env), fixture.stored, `${label} ignores ${owned} under a foreign root`);
        assert.equal(resolve(env), resolve(onlyXdg), `${label} resolves the same dir in both contexts for ${owned}`);
      }
      try {
        applyEnv(env);
        assert.deepEqual(
          STATUS.readSidebarMode(),
          { enabled: true, malformed: false, raw: null },
          `the daemon ignores ${owned} under a foreign root (missing mode means enabled)`,
        );
      } finally {
        applyEnv({});
      }
      assert.ok(
        !fs.existsSync(path.join(injected, 'gentle-status.pid')),
        `the daemon writes nothing into the foreign-root ${owned} dir`,
      );
      // Cleanup covers the injected dir too: `foreignRoot` is its parent, so one
      // guarded removal of the whole foreign root replaces the per-candidate one.
      removePath(foreignRoot);
    }
  });

  test('an owned-basename injected dir under a different root changes nothing for the producer extension (cross-context)', async () => {
    const fixture = crossSandbox('owned-foreign-root-ext');
    const foreign = path.join(fixture.root, 'other-herdr', 'herdr-gentle-shell');
    touch(foreign, 'gentle-interruptions.json', '{"version":1,"panes":{}}\n');
    // The producer's only observable verdict is the refresh flag it writes into
    // the dir it resolved, so the stored dir must exist to receive it.
    fs.mkdirSync(fixture.stored, { recursive: true });
    const candidates = [fixture.stored, fixture.activeId, foreign];
    const withoutVariable = await extensionResolvedDir({ XDG_STATE_HOME: fixture.xdg }, candidates, 3000);
    assert.deepEqual(withoutVariable.dirs, [fixture.stored], 'the producer writes its refresh in the stored dir');
    const withVariable = await extensionResolvedDir(
      { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: foreign },
      candidates,
      3000,
    );
    assert.deepEqual(withVariable.dirs, withoutVariable.dirs, 'the foreign-root owned name changes nothing');
  });

  // The same rule must not over-tighten: a spelling of the DERIVED dir that only
  // differs by a symlink or by being relative still names that directory, so it
  // is honoured (used as given) instead of being rejected as foreign.
  test('an owned-basename injected dir under the same root is honoured (symlinked and relative spellings)', async () => {
    const fixture = crossSandbox('owned-same-root');
    const realPlugins = path.join(fixture.xdg, 'herdr', 'plugins');
    touch(fixture.activeId, 'gentle-plugin-tools.json', '{"version":1,"odd":false,"issues":false}\n');
    const link = path.join(fixture.root, 'plugins-link');
    fs.symlinkSync(realPlugins, link, 'dir');
    const symlinked = path.join(link, 'herdr-gentle-shell');
    assert.equal(canonical(symlinked), canonical(fixture.activeId), 'the fixture really is a spelling of the derived dir');
    const env = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: symlinked };
    assert.equal(SIDEBAR.stateDir(env), symlinked, 'the sidebar uses the injected symlinked spelling as given');
    assert.equal(
      DIAGNOSTICS.resolveStateDir(env),
      path.resolve(symlinked),
      'diagnostics honours the same symlinked spelling',
    );
    try {
      applyEnv(env);
      assert.deepEqual(
        STATUS.readSidebarMode(),
        { enabled: true, malformed: false, raw: null },
        'the daemon resolves through the symlinked spelling (the tools toggle is not a mode flag)',
      );
      assert.ok(!fs.existsSync(path.join(fixture.activeId, 'gentle-status.pid')), 'the reader creates nothing');
    } finally {
      applyEnv({});
    }
    // The extension's verdict is the refresh flag: it must land in that same
    // directory, whether reached by the injected spelling or derived.
    const resolved = await extensionResolvedDir(env, [fixture.stored, fixture.activeId], 3000);
    assert.deepEqual(resolved.dirs, [fixture.activeId], 'the producer writes its refresh in the derived dir');

    const previous = process.cwd();
    try {
      process.chdir(fixture.root);
      const relative = path.join('xdg', 'herdr', 'plugins', 'herdr-gentle-shell');
      const relativeEnv = { XDG_STATE_HOME: 'xdg', HERDR_PLUGIN_STATE_DIR: relative };
      assert.equal(SIDEBAR.stateDir(relativeEnv), relative, 'the sidebar uses the relative spelling as given');
      assert.equal(
        DIAGNOSTICS.resolveStateDir(relativeEnv),
        fixture.activeId,
        'diagnostics resolves the relative spelling to the same dir',
      );
    } finally {
      process.chdir(previous);
    }
  });

  test('the stored family still outranks a stray known file in the derived active-id dir', () => {
    const fixture = crossSandbox('owned-trapped');
    // The injected variable names exactly the derived dir, and that dir holds
    // one stray known file; the stored dir holds the family.
    touch(fixture.activeId, 'gentle-interruptions.json', '{"version":1,"panes":{}}\n');
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    const env = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: fixture.activeId };
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(env), fixture.stored, `${label} keeps the stored dir over the stray active-id file`);
    }
    try {
      applyEnv(env);
      assert.deepEqual(
        STATUS.readSidebarMode(),
        { enabled: false, malformed: false, raw: null },
        'the daemon keeps resolving the stored dir',
      );
    } finally {
      applyEnv({});
    }
  });

  // S1c path edges: every consumer must degrade the same way when the state home
  // is relative, symlinked, or unusable. The three readers are pure path
  // resolutions; the daemon CREATES the dir it resolves and the producer's only
  // observable verdict is the refresh flag it writes into that dir, so all five
  // are asserted against one expected directory.
  function readerDirs(env) {
    return {
      sidebar: SIDEBAR.stateDir(env),
      diagnostics: DIAGNOSTICS.resolveStateDir(env),
      trace: path.dirname(TRACE.tracePath(env)),
    };
  }

  function assertReadersAgree(env, expected, why) {
    for (const [label, dir] of Object.entries(readerDirs(env))) {
      assert.equal(dir, expected, `${label} ${why}`);
    }
  }

  test('a relative XDG_STATE_HOME resolves the same relative stored dir on every consumer', async () => {
    const cwd = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-relative-')));
    const env = { XDG_STATE_HOME: 'rel-state' };
    const expected = path.join('rel-state', STORED_SEGMENT);
    assertReadersAgree(env, expected, 'resolves the relative stored dir');
    const previous = process.cwd();
    try {
      process.chdir(cwd);
      assert.deepEqual(daemonResolvedDir(env, [expected]), [expected], 'the daemon creates the same relative dir');
      const resolved = await extensionResolvedDir(env, [expected], 4000);
      assert.ok(resolved.reports > 0, 'the producer still publishes its beat');
      assert.deepEqual(resolved.dirs, [expected], 'the producer writes its refresh in the same relative dir');
    } finally {
      process.chdir(previous);
    }
  });

  test('a symlinked state home resolves through the link on every consumer', async () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-symlink-')));
    const real = path.join(root, 'state-real');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(root, 'state-link');
    fs.symlinkSync(real, link, 'dir');
    const env = { XDG_STATE_HOME: link };
    const stored = path.join(link, STORED_SEGMENT);
    assertReadersAgree(env, stored, 'resolves through the symlinked state home');
    assert.deepEqual(daemonResolvedDir(env, [stored]), [stored], 'the daemon creates the dir through the link');
    const resolved = await extensionResolvedDir(env, [stored], 4000);
    assert.ok(resolved.reports > 0, 'the producer still publishes its beat');
    assert.deepEqual(resolved.dirs, [stored], 'the producer writes its refresh through the link');
    assert.ok(
      fs.existsSync(path.join(real, STORED_SEGMENT, REFRESH_FILE)),
      'one real directory behind the link, not a second copy beside it',
    );
  });

  test('a state home that is a regular file degrades without throwing on every consumer', async () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-fileval-')));
    const stateHome = path.join(root, 'state-home');
    fs.writeFileSync(stateHome, 'not a directory\n');
    const env = { XDG_STATE_HOME: stateHome };
    const expected = path.join(stateHome, STORED_SEGMENT);
    assertReadersAgree(env, expected, 'still names the stored dir under the unusable state home');
    assert.deepEqual(daemonResolvedDir(env, [expected]), [], 'the daemon creates nothing and never throws');
    try {
      applyEnv(env);
      assert.deepEqual(
        STATUS.readSidebarMode(),
        { enabled: true, malformed: false, raw: null },
        'the daemon degrades to the missing-mode default',
      );
    } finally {
      applyEnv({});
    }
    const reports = await extensionRun(env, 3000);
    // An unreadable mode flag fails CLOSED in the producer (a malformed flag
    // never publishes), while the daemon defaults to enabled; both degrade
    // without throwing and neither creates anything. The dir-resolution
    // verdict above is what S1c pins — the policy difference is the existing
    // malformed-flag rule, not a second directory.
    assert.equal(reports, 0, 'the producer fails closed on the unreadable mode flag instead of throwing');
    assert.deepEqual(fs.readdirSync(root), ['state-home'], 'no consumer created anything under the file');
  });

  test('an absent foreign injected dir changes nothing on every consumer', async () => {
    const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-foreign-absent-')));
    const xdg = path.join(root, 'xdg');
    const stored = path.join(xdg, STORED_SEGMENT);
    fs.mkdirSync(stored, { recursive: true });
    const foreign = path.join(root, 'plugins', 'third-plugin');
    const env = { XDG_STATE_HOME: xdg, HERDR_PLUGIN_STATE_DIR: foreign };
    assertReadersAgree(env, stored, 'ignores the absent unrelated injected dir');
    assert.deepEqual(daemonResolvedDir(env, [stored]), [stored], 'the daemon resolves the stored dir');
    const resolved = await extensionResolvedDir(env, [stored], 4000);
    assert.ok(resolved.reports > 0, 'the producer still publishes its beat');
    assert.deepEqual(resolved.dirs, [stored], 'the producer writes its refresh in the stored dir');
    assert.equal(fs.existsSync(foreign), false, 'nothing creates a dir this package does not own');
  });

  test('the explicit override wins over stored and injected dirs (preserved)', () => {
    const fixture = sandbox('explicit');
    touch(fixture.stored, 'gentle-plugin-tools.json', '{"version":1,"odd":false,"issues":false}\n');
    touch(fixture.injected, 'gentle-status.pid', '123\n');
    const explicit = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-explicit-')));
    const env = { ...fixture.env, GENTLE_STATUS_STATE_DIR: explicit };
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(env), explicit, `${label} honors GENTLE_STATUS_STATE_DIR`);
    }
  });
});

// The five canonicalisation functions are run in isolation below, read from
// source so a sixth resolver cannot silently escape the boundaries.
const vm = require('node:vm');

// S1/S1c end to end: a foreign-root owned basename is ignored by every reader
// (and the producer writes no refresh there), the same-root spellings of the
// derived dir are honoured, and each canonicalisation function survives the
// path edges the rule compares paths with.
test('independent foreign root, same root, refresh and canonical boundaries', async () => {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-independent-')));
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, STORED_SEGMENT);
  const active = path.join(xdg, ACTIVE_ID_SEGMENT);
  const foreign = path.join(root, 'foreign', 'herdr-gentle-shell');
  const base = { XDG_STATE_HOME: xdg };
  const readers = (env) => [
    SIDEBAR.stateDir(env),
    DIAGNOSTICS.resolveStateDir(env),
    path.dirname(TRACE.tracePath(env)),
  ];
  touch(foreign, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}');
  fs.mkdirSync(stored, { recursive: true });
  const injected = { ...base, HERDR_PLUGIN_STATE_DIR: foreign };

  // The owned basename under a foreign root is not ours: no reader moves to it,
  // so the daemon reads the absent stored mode as enabled instead of the
  // foreign disabled one.
  assert.deepEqual(readers(injected), Array(3).fill(stored), 'every reader ignores the foreign-root owned basename');
  try {
    applyEnv(injected);
    assert.equal(
      STATUS.readSidebarMode().enabled,
      true,
      'the daemon ignores the foreign-root owned basename (missing mode means enabled)',
    );
  } finally {
    applyEnv({});
  }

  // The producer's only verdict is where its refresh flag lands: the stored dir,
  // never the foreign dir the variable names.
  let ext = await extensionResolvedDir(injected, [stored, active, foreign], 3000);
  assert.deepEqual(ext.dirs, [stored], 'the producer writes its refresh in the stored dir, never the foreign one');

  // An absent owned basename under a foreign root is never created either.
  const absent = path.join(root, 'absent', 'herdr-gentle-shell');
  readers({ ...base, HERDR_PLUGIN_STATE_DIR: absent });
  try {
    applyEnv({ ...base, HERDR_PLUGIN_STATE_DIR: absent });
    STATUS.readSidebarMode();
  } finally {
    applyEnv({});
  }
  assert.equal(fs.existsSync(absent), false, 'no consumer creates an absent foreign-root dir');

  // The rule must not over-tighten: exact, symlinked and relative spellings of
  // the DERIVED dir all name that directory, so all five consumers use it.
  fs.rmSync(foreign, { recursive: true, force: true });
  touch(active, 'gentle-plugin-tools.json', '{}');
  const link = path.join(root, 'link');
  fs.symlinkSync(path.dirname(active), link, 'dir');
  const previous = process.cwd();
  process.chdir(root);
  try {
    for (const spelling of [active, path.join(link, 'herdr-gentle-shell'), path.relative(root, active)]) {
      const env = { ...base, HERDR_PLUGIN_STATE_DIR: spelling };
      const got = readers(env);
      assert.equal(path.resolve(got[0]), path.resolve(spelling), `the sidebar honours the ${spelling} spelling`);
      assert.equal(path.resolve(got[1]), path.resolve(spelling), `diagnostics honours the ${spelling} spelling`);
      assert.equal(path.resolve(got[2]), path.resolve(spelling), `trace honours the ${spelling} spelling`);
      try {
        applyEnv(env);
        assert.equal(
          STATUS.readSidebarMode().enabled,
          true,
          `the daemon resolves through the ${spelling} spelling (the tools toggle is not a mode flag)`,
        );
      } finally {
        applyEnv({});
      }
      ext = await extensionResolvedDir(env, [stored, active], 3000);
      assert.deepEqual(ext.dirs, [active], `the producer writes its refresh in the derived dir for ${spelling}`);
    }
  } finally {
    process.chdir(previous);
  }

  // Every canonicalisation function must survive the edges the path comparison
  // faces: a missing tail under an existing ancestor reached through a symlink,
  // a broken symlink, and a tail with no ancestor at all. Each pair names one
  // directory, so the canonical forms must be equal (and must not throw).
  const real = path.join(root, 'real');
  fs.mkdirSync(real, { recursive: true });
  const alias = path.join(root, 'alias');
  if (!fs.existsSync(alias)) fs.symlinkSync(real, alias, 'dir');
  const broken = path.join(root, 'broken');
  if (!fs.existsSync(broken)) {
    try {
      fs.symlinkSync(path.join(root, 'missing-target'), broken, 'dir');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  for (const file of RESOLVER_SOURCES) {
    const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const match = text.match(/function (?:sidebarCanonicalDir|canonicalStateDir)\(dir\) \{[\s\S]*?\n\}/);
    assert.ok(match, `${file} declares its canonicalisation function`);
    const fn = vm.runInNewContext(`(${match[0]})`, {
      fs,
      path,
      resolvePath: path.resolve,
      dirname: path.dirname,
      join: path.join,
      pathBasename: path.basename,
    });
    for (const [a, b] of [
      [path.join(alias, 'missing', 'herdr-gentle-shell'), path.join(real, 'missing', 'herdr-gentle-shell')],
      [path.join(broken, 'missing', 'herdr-gentle-shell'), path.join(broken, 'missing', 'herdr-gentle-shell')],
      [
        path.join(root, 'no-ancestor', 'deep', 'herdr-gentle-shell'),
        path.join(root, 'no-ancestor', 'deep', 'herdr-gentle-shell'),
      ],
    ]) {
      assert.equal(fn(a), fn(b), `${file} canonicalises ${a} and ${b} identically`);
    }
  }
});
