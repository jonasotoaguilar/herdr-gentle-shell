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
// must win on every resolver. Legacy behavior stays pinned too (fresh installs
// converge on the injected dir, an explicit override always wins).

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

function touch(dir, name, body) {
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

async function extensionReportCount(fixture, waitMs) {
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
    ...fixture.env,
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
    assert.equal(await extensionReportCount(fixture, 1200), 0, 'the stored disabled mode gates the producer');
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

  test('a fresh install converges on the injected dir on every resolver (preserved)', () => {
    const fixture = sandbox('fresh');
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(fixture.env), fixture.injected, `${label} uses the injected dir when nothing is stored`);
    }
  });

  test('the producer extension resolves the stored dir: a disabled sidebar mode gates its beats', async () => {
    const fixture = sandbox('ext-mode');
    // A stored mode file is visible only if the extension resolved the stored
    // dir; any other resolution would read it as missing, and missing means
    // enabled, so a beat would arrive.
    touch(fixture.stored, 'gentle-sidebar-mode.json', '{"version":1,"enabled":false}\n');
    assert.equal(await extensionReportCount(fixture, 1200), 0, 'a stored disabled mode stops the producer');
    fs.rmSync(path.join(fixture.stored, 'gentle-sidebar-mode.json'));
    assert.ok(await extensionReportCount(fixture, 3000) > 0, 'without the flag the producer publishes (missing means enabled)');
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
