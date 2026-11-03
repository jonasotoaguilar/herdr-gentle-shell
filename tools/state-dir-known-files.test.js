'use strict';
// One known-file family for every state-dir resolver.
//
// The stored plugin state dir is proven "ours" by a family of flag files. A
// consumer only falls back from the Herdr-injected dir to the stored dir when
// it recognises one of those files, so a family that differs between
// consumers splits the state between two directories. The visible failure is
// fail-OPEN: a stored `gentle-plugin-tools.json` with the ODD/Issues toggles
// DISABLED is invisible to the resolver that does not know the file, so the
// toggle reads as MISSING, and missing means enabled.
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
const { pathToFileURL } = require('node:url');

const WORKTREE_MODE = require('../lib/worktree-mode.js');
const SIDEBAR = require('../lib/gentle-sidebar.js');
const DIAGNOSTICS = require('../herdr-plugin/lib/gentle-diagnostics.js');

const STORED_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-agents');

// Every file the family must contain. The plugin toggles file is the one that
// was missing from the sidebar, daemon, diagnostics and extension resolvers.
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

// The extension is one self-contained TypeScript file with a single package
// import that plain node cannot resolve; the copy used here stubs exactly that
// line, the same loading pattern as tools/customize-providers.test.js. Its
// state-dir resolution is only observable through the files it writes, so the
// Moshi toggle (a plain flag-file write, no Herdr calls) is the probe.
const srcText = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-herdr-state.ts'), 'utf8');
const stubbedSrc = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbedSrc !== srcText, 'expected the package import line to be stubbed');
const extensionRoot = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-ext-')));
const extensionCopy = path.join(extensionRoot, 'gentle-herdr-state.mjs');
fs.writeFileSync(extensionCopy, stubbedSrc);

process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = path.join(extensionRoot, 'no-socket.sock');
process.env.HERDR_PANE_ID = 'known-files-pane';
const extensionPromise = import(pathToFileURL(extensionCopy).href);

const SLOT_KEY = 'herdr-gentle.customize.v1';

async function loadExtension() {
  const mod = await extensionPromise;
  const pi = {
    registerCommand: () => {},
    on: () => () => {},
    events: { on: () => {}, emit: () => {} },
  };
  mod.default(pi);
  // The enable gate would otherwise scan PATH and spawn the real CLI; both
  // hooks are replaced so the test only exercises flag-file placement.
  mod.setMoshiHookResolver(() => '/nonexistent/moshi-hook');
  mod.setMoshiStatusRunner(() => ({ ok: true }));
  const slot = globalThis[Symbol.for(SLOT_KEY)];
  delete globalThis[SLOT_KEY];
  assert.ok(slot && slot.moshi && typeof slot.moshi.apply === 'function', 'extension registered the customize slot');
  return slot;
}

// Turns Moshi ON through the extension, then reports which of the two state
// dirs the flag landed in.
async function extensionFlagDir(fixture) {
  const slot = await loadExtension();
  applyEnv({ ...fixture.env, GENTLE_PI_AGENT_HOME: fixture.agent });
  try {
    const result = await slot.moshi.apply('on', { ui: { notify: () => {} } });
    assert.equal(result.changed, true, 'the Moshi toggle wrote its flag');
  } finally {
    applyEnv({});
  }
  if (fs.existsSync(path.join(fixture.stored, 'gentle-moshi.json'))) return fixture.stored;
  if (fs.existsSync(path.join(fixture.injected, 'gentle-moshi.json'))) return fixture.injected;
  return null;
}

const MANAGED_ENV = [
  'XDG_STATE_HOME',
  'HERDR_PLUGIN_STATE_DIR',
  'GENTLE_STATUS_STATE_DIR',
  'GENTLE_PI_AGENT_HOME',
  'PI_CODING_AGENT_DIR',
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

function readPluginTools(fixture) {
  return WORKTREE_MODE.readPluginTools({ ...fixture.env });
}

describe('state-dir known-file family', () => {
  // The three resolvers whose verdict is directly observable.
  const resolvers = [
    ['worktree-mode', (env) => WORKTREE_MODE.stateDir(env)],
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
      assert.equal(await extensionFlagDir(fixture), fixture.stored, `the extension writes into the stored dir for ${name}`);
    });
  }

  // The reported split-brain, without any daemon: a stored dir holding ONLY
  // the toggle file, an empty injected dir, and a consumer write. The write
  // must not create a second copy of the state that makes the disabled toggle
  // read as missing (missing means enabled).
  test('a consumer write cannot re-enable a stored disabled toggle', async () => {
    const fixture = sandbox('split-brain');
    touch(fixture.stored, 'gentle-plugin-tools.json', '{"version":1,"odd":false,"issues":false}\n');
    assert.deepEqual(readPluginTools(fixture), { state: 'ok', odd: false, issues: false }, 'the stored toggle starts disabled');

    // The sidebar publishes its own flag through the same state dir.
    SIDEBAR.writeMode(true, fixture.env);
    assert.equal(SIDEBAR.modePath(fixture.env), path.join(fixture.stored, 'gentle-sidebar-mode.json'));
    assert.ok(!fs.existsSync(path.join(fixture.injected, 'gentle-sidebar-mode.json')), 'nothing lands in the injected dir');

    assert.equal(WORKTREE_MODE.stateDir(fixture.env), fixture.stored, 'resolution stays on the stored dir after the write');
    assert.deepEqual(
      readPluginTools(fixture),
      { state: 'ok', odd: false, issues: false },
      'the disabled toggle stays disabled, never falling back to the enabled default',
    );
  });

  test('the worktree flag family keeps resolving the stored dir (preserved)', () => {
    const fixture = sandbox('worktree-only');
    touch(fixture.stored, 'gentle-worktree-mode.json', '{"version":1,"enabled":false}\n');
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(fixture.env), fixture.stored, `${label} resolves a stored-only worktree flag`);
    }
    assert.deepEqual(WORKTREE_MODE.readMode(fixture.env), { state: 'disabled', enabled: false });
  });

  test('a fresh install converges on the injected dir on every resolver (preserved)', async () => {
    const fixture = sandbox('fresh');
    for (const [label, resolve] of resolvers) {
      assert.equal(resolve(fixture.env), fixture.injected, `${label} uses the injected dir when nothing is stored`);
    }
    assert.equal(await extensionFlagDir(fixture), fixture.injected, 'the extension writes into the injected dir');
    assert.deepEqual(readPluginTools(fixture), { state: 'missing', odd: true, issues: true });
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

// The toggle document can exist in BOTH locations — the injected dir and the
// stored dir — because older writers published it into whichever dir the
// resolver happened to pick. A read must never silently pick one of two
// readable copies that disagree, and the explicit override keeps its documented
// single-location scope.
describe('plugin tools across both state locations', () => {
  test('two copies that disagree fail closed and name both files', () => {
    const fixture = sandbox('tools-conflict');
    fs.writeFileSync(path.join(fixture.stored, 'gentle-plugin-tools.json'), '{"version":1,"odd":false,"issues":true}\n');
    fs.writeFileSync(path.join(fixture.injected, 'gentle-plugin-tools.json'), '{"version":1,"odd":true,"issues":true}\n');
    fs.writeFileSync(path.join(fixture.injected, 'gentle-status.pid'), '424242\n');

    assert.equal(WORKTREE_MODE.stateDir(fixture.env), fixture.injected, 'the legacy resolution still prefers the populated injected dir');
    assert.deepEqual(
      WORKTREE_MODE.readPluginTools(fixture.env),
      { state: 'conflict', odd: false, issues: true },
      'the ambiguous toggle fails closed while the agreed one keeps its value',
    );
    const detail = WORKTREE_MODE.readPluginToolsDetail(fixture.env);
    assert.deepEqual(detail.conflicts, ['odd'], 'only the disagreeing key is ambiguous');
    assert.ok(detail.diagnostic.includes(path.join(fixture.stored, 'gentle-plugin-tools.json')), 'the diagnostic names the stored copy');
    assert.ok(detail.diagnostic.includes(path.join(fixture.injected, 'gentle-plugin-tools.json')), 'the diagnostic names the injected copy');
  });

  test('the explicit override keeps exactly one location (preserved)', () => {
    const fixture = sandbox('tools-explicit');
    fs.writeFileSync(path.join(fixture.stored, 'gentle-plugin-tools.json'), '{"version":1,"odd":false,"issues":false}\n');
    const explicit = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-tools-explicit-')));
    const env = { ...fixture.env, GENTLE_STATUS_STATE_DIR: explicit };
    assert.deepEqual(WORKTREE_MODE.pluginToolsFiles(env), [path.join(explicit, 'gentle-plugin-tools.json')], 'one candidate only');
    assert.deepEqual(
      WORKTREE_MODE.readPluginTools(env),
      { state: 'missing', odd: true, issues: true },
      'the stored copy is out of scope under an explicit override',
    );
  });

  // The shared canonical source: whichever session flips first writes the path
  // every session can compute (the stored dir, or the explicit override) — not
  // the Herdr-injected dir a plain Pi session cannot discover.
  test('a flip with no existing copy writes the shared canonical path', async () => {
    const fixture = sandbox('tools-canonical');
    const storedFile = path.join(fixture.stored, 'gentle-plugin-tools.json');
    const injectedFile = path.join(fixture.injected, 'gentle-plugin-tools.json');

    const viaHerdr = await WORKTREE_MODE.updatePluginTools({ odd: false }, { env: fixture.env, pollMs: 10 });
    assert.deepEqual(viaHerdr.paths, [storedFile], 'the injected-dir session writes the shared copy');
    assert.ok(!fs.existsSync(injectedFile), 'no copy is created in the injected dir');
    assert.deepEqual(
      WORKTREE_MODE.readPluginTools({ XDG_STATE_HOME: fixture.xdg }),
      { state: 'ok', odd: false, issues: true },
      'a plain session (no injected dir in its environment) reads the choice',
    );

    const explicit = track(fs.mkdtempSync(path.join(os.tmpdir(), 'state-known-tools-canonical-')));
    const explicitEnv = { ...fixture.env, GENTLE_STATUS_STATE_DIR: explicit };
    const viaExplicit = await WORKTREE_MODE.updatePluginTools({ issues: false }, { env: explicitEnv, pollMs: 10 });
    assert.deepEqual(viaExplicit.paths, [path.join(explicit, 'gentle-plugin-tools.json')], 'the override keeps its one location');
    assert.ok(!fs.existsSync(path.join(fixture.stored, 'installer-state')), 'nothing else is touched');
  });

  // A pre-existing injected copy is read (so a Disabled value can never read as
  // missing/enabled) and adopted by the next flip, without being deleted.
  test('a legacy injected copy is read and migrated, never dropped', async () => {
    const fixture = sandbox('tools-legacy');
    const injectedFile = path.join(fixture.injected, 'gentle-plugin-tools.json');
    const storedFile = path.join(fixture.stored, 'gentle-plugin-tools.json');
    fs.writeFileSync(injectedFile, '{"version":1,"odd":false,"issues":false}\n');

    assert.deepEqual(
      WORKTREE_MODE.readPluginTools(fixture.env),
      { state: 'ok', odd: false, issues: false },
      'the legacy copy decides while the canonical one is missing',
    );
    const result = await WORKTREE_MODE.updatePluginTools({ issues: true }, { env: fixture.env, pollMs: 10 });
    assert.deepEqual(result.paths, [storedFile, injectedFile], 'the canonical copy is created beside the legacy one');
    assert.equal(fs.readFileSync(storedFile, 'utf8'), '{"version":1,"odd":false,"issues":true}\n', 'the legacy values are adopted');
    assert.equal(fs.readFileSync(injectedFile, 'utf8'), '{"version":1,"odd":false,"issues":true}\n', 'the legacy file is kept, not deleted');
  });
});
