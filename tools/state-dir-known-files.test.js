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
// The daemon's `stateRoot` is not exported; `readSidebarMode()` reads the mode
// file through it, so it is the daemon's state-dir observable.
const STATUS = require('../herdr-plugin/bin/gentle-status.js');

const STORED_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-agents');

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
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

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
  for (const dir of candidates) fs.rmSync(path.join(dir, REFRESH_FILE), { force: true });
  const reports = await extensionRun(env, waitMs);
  return { reports, dirs: candidates.filter((dir) => fs.existsSync(path.join(dir, REFRESH_FILE))) };
}

// The daemon's `stateRoot()` is not exported and it CREATES the dir it resolves,
// so the created candidate dir is the resolution.
function daemonResolvedDir(env, candidates) {
  for (const dir of candidates) fs.rmSync(dir, { recursive: true, force: true });
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
    fs.rmSync(path.join(fixture.stored, 'gentle-sidebar-mode.json'));
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

  // The two owned names: the active plugin id (what Herdr injects today) and
  // the stored canonical segment (a stale or dev checkout may still name it
  // from another parent). Both are honoured; a third name is not.
  test('an injected path whose basename is an owned name still wins when the stored dir holds no known file', () => {
    const fixture = crossSandbox('owned-injected');
    for (const owned of ['herdr-gentle-shell', 'herdr-gentle-agents']) {
      const injected = path.join(fixture.root, 'elsewhere', owned);
      touch(injected, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
      const env = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: injected };
      for (const [label, resolve] of resolvers) {
        assert.equal(resolve(env), injected, `${label} honours an injected dir named ${owned}`);
      }
      try {
        applyEnv(env);
        assert.deepEqual(
          STATUS.readSidebarMode(),
          { enabled: false, malformed: false, raw: null },
          `the daemon reads the mode flag from the injected ${owned} dir`,
        );
      } finally {
        applyEnv({});
      }
      fs.rmSync(injected, { recursive: true, force: true });
    }
  });

  test('the stored family still outranks a stray known file in the active-id dir', () => {
    const fixture = crossSandbox('owned-trapped');
    const injected = path.join(fixture.root, 'elsewhere', 'herdr-gentle-shell');
    touch(injected, 'gentle-interruptions.json', '{"version":1,"panes":{}}\n');
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    const env = { XDG_STATE_HOME: fixture.xdg, HERDR_PLUGIN_STATE_DIR: injected };
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
