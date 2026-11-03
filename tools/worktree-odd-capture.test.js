'use strict';
// S1: the worktree tool pipeline observes ODD writes for ONE purpose — naming
// the session — and records no association.
//
// The extension used to associate the first `odd/` document a worktree touched
// (plus a bounded re-scan complement) with the worktree's registry row. S1
// removed the association from every worktree surface: a worktree carries no
// issue and no ODD document, so the pipeline must not write one — and the
// registry's stored records stay exactly as they are. What the same wiring DOES
// keep is the session auto-name derived from the ODD task document being
// written (`pi.setSessionName`), which is a session property, not an
// association.
//
// Loading pattern mirrors tools/worktree-create.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck, no type annotations),
// so the test copies it to a temporary .mjs path with the package import lines
// stubbed and import()s it with a fake `pi` object that records tool/command/
// event registrations, the session name it is given, and lets the test dispatch
// tool pipeline events.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// (real `git init` + one commit), a real linked worktree (`git worktree add -b`),
// a registry entry for that worktree, and a principal `odd/` directory
// symlinked into the worktree exactly like the creation hooks do. Only
// observable behavior is asserted: the registry file's bytes inside the git
// common dir, the session name the fake host received, and the handler's
// return value (nothing). The user's real checkouts are never touched.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
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
    'import { defineTool } from "@earendil-pi-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  )
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

// Fresh fixture repository with one commit, a principal `odd/` directory
// holding `docs`, a real linked worktree whose `odd/` is a symlink into the
// principal checkout (exactly what the creation hooks build), and a registry
// entry owning that worktree.
function makeRepoWithWorktree(tag, { branch = 'feat/odd', docs = ['notes.md'] } = {}) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-noassoc-${tag}-`)));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '--allow-empty', '-m', 'init']);
  const realRoot = fs.realpathSync(root);

  const principalOdd = path.join(realRoot, 'odd');
  fs.mkdirSync(principalOdd, { recursive: true });
  for (const doc of docs) {
    const full = path.join(principalOdd, doc);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `# ${doc}\n`);
  }

  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-wt-${slug}`);
  track(target);
  git(realRoot, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const realTarget = fs.realpathSync(target);
  fs.symlinkSync(principalOdd, path.join(realTarget, 'odd'));

  const registryLib = require('../lib/worktree-registry.js');
  const stored = registryLib.upsertWorktree(realRoot, {
    branch, path: realTarget, thread: 'thread-1', issues: [35], odd: null,
  });
  assert.equal(stored.ok, true);
  return { root: realRoot, target: realTarget, branch, principalOdd };
}

function oddOf(root, branch) {
  return require('../lib/worktree-registry.js').findByBranch(root, branch).odd;
}

function registryBytes(root) {
  return fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root), 'utf8');
}

// Hand-write the legacy shape an older version left behind: the row carries
// the old `odd[]` list and a field this version does not model. Nothing the
// pipeline does may touch it.
function seedLegacyRow(root, branch, legacyOdd) {
  const registryLib = require('../lib/worktree-registry.js');
  const file = registryLib.registryPath(root);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.worktrees = doc.worktrees.map((row) => (row.branch === branch
    ? { ...row, odd: legacyOdd.slice(), note: 'kept verbatim' }
    : row));
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return fs.readFileSync(file, 'utf8');
}

const savedEnv = { ...process.env };
// Isolated mode state per test: missing file means enabled. The ambient
// user's flag must never decide a fixture's outcome; a test that wants
// disabled mode writes it into its own dir.
function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-noassoc-mode-'))) };
}
function setEnv(vars) {
  const env = 'GENTLE_STATUS_STATE_DIR' in vars ? vars : { ...vars, ...scratchModeEnv() };
  for (const [key, value] of Object.entries(env)) {
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

// Import the stubbed extension copy with the lib override in place. The fake
// `pi` records registrations, every `pi.on` subscription, and the session name
// it is given (the ONE thing the pipeline still writes).
async function loadExtension({ currentName = '' } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-noassoc-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map(); // event name -> [handler]
  const session = { name: currentName, names: [] };
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    getSessionName: () => session.name,
    setSessionName: (name) => {
      session.names.push(name);
      session.name = name;
    },
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return { tools, commands, handlers, session };
}

function toolEvent(toolName, filePath) {
  return { toolName, args: { path: filePath } };
}

function ctxFor(cwd) {
  return { cwd, sessionManager: { getSessionId: () => 'thread-1' }, ui: { notify: () => {} } };
}

async function dispatch(handlers, eventName, event, ctx) {
  const list = handlers.get(eventName) || [];
  assert.ok(list.length > 0, `expected a ${eventName} subscription`);
  const returns = [];
  for (const handler of list) {
    returns.push(await handler(event, ctx));
  }
  return returns;
}

describe('worktree pipeline records no association', { concurrency: false }, () => {
  // Round-3 performance: the hook runs on EVERY tool_call and tool_result.
  // Resolving the repo identity spawns two git children, so the same cwd must
  // not respawn them per event: that was ~35ms of blocked event loop per tool
  // call, and it is what made the agent and the TUI feel slow.
  test('repeated tool events resolve the repository once, not per event', async () => {
    const { target } = makeRepoWithWorktree('hotpath');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    const childProcess = require('node:child_process');
    const realSpawnSync = childProcess.spawnSync;
    let spawns = 0;
    childProcess.spawnSync = function counted(...args) {
      spawns += 1;
      return realSpawnSync.apply(this, args);
    };
    // The library destructures spawnSync when it loads, so drop the cached
    // copy: the counted function must be the one it binds.
    delete require.cache[require.resolve('../lib/worktree-git.js')];
    try {
      const { handlers } = await loadExtension();
      const ctx = ctxFor(target);
      await dispatch(handlers, 'tool_call', toolEvent('bash', '/tmp/not-an-odd-path'), ctx);
      const afterFirst = spawns;
      assert.ok(afterFirst > 0, `the first event resolves the repository (${afterFirst} git children)`);
      for (let event = 0; event < 12; event += 1) {
        await dispatch(handlers, 'tool_call', toolEvent('bash', '/tmp/not-an-odd-path'), ctx);
        await dispatch(handlers, 'tool_result', toolEvent('bash', '/tmp/not-an-odd-path'), ctx);
      }
      assert.equal(spawns, afterFirst, `no git child per event after the first (${spawns} total)`);
    } finally {
      childProcess.spawnSync = realSpawnSync;
      delete require.cache[require.resolve('../lib/worktree-git.js')];
    }
  });

  test('no event associates a document — worktree, principal, bash or tool_result', async () => {
    const { root, target, branch } = makeRepoWithWorktree('no-association', { docs: ['notes.md', 'unseen.md'] });
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const before = seedLegacyRow(root, branch, ['odd/tasks/kept-a.md', 'odd/tasks/kept-b.md']);
      const { handlers } = await loadExtension();
      const inWorktree = ctxFor(target);
      const atPrincipal = ctxFor(root);
      for (const [toolName, doc] of [['read', 'notes.md'], ['edit', 'notes.md'], ['write', 'tasks/plan.md']]) {
        const full = path.join(target, 'odd', doc);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, `# ${doc}\n`);
        for (const value of await dispatch(handlers, 'tool_call', toolEvent(toolName, full), inWorktree)) {
          assert.equal(value, undefined, 'the handler returns nothing and never blocks the pipeline');
        }
      }
      // The re-scan complement, the opaque bash call and the result half are
      // all part of the same pipeline and must associate nothing either.
      await dispatch(handlers, 'tool_call', { toolName: 'bash', args: { command: 'ls odd/' } }, inWorktree);
      await dispatch(handlers, 'tool_result', { toolName: 'read', input: { path: path.join(target, 'odd', 'notes.md') } }, inWorktree);
      // Neither does the same event seen from the principal checkout.
      await dispatch(handlers, 'tool_call', toolEvent('read', path.join(root, 'odd', 'notes.md')), atPrincipal);

      assert.equal(oddOf(root, branch), 'odd/tasks/kept-a.md', 'reads still resolve the legacy list to one document in memory');
      assert.equal(
        registryBytes(root),
        before,
        'not one byte of the registry changed: the pipeline wrote no association at all',
      );
    } finally {
      restoreEnv();
    }
  });

  test('a write of an odd task document still names the session', async () => {
    const { root, target, branch } = makeRepoWithWorktree('naming');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const before = registryBytes(root);
      const { handlers, session } = await loadExtension({ currentName: '' });
      const ctx = ctxFor(target);
      const doc = path.join(target, 'odd', 'tasks', 'session-naming.md');
      fs.mkdirSync(path.dirname(doc), { recursive: true });
      fs.writeFileSync(doc, '# Session naming\n\nBody.\n');
      for (const value of await dispatch(handlers, 'tool_call', toolEvent('write', doc), ctx)) {
        assert.equal(value, undefined, 'the handler still never blocks the pipeline');
      }
      assert.deepEqual(session.names, ['Session naming @ feat/odd'], 'the write names the session after the document');
      // A repeat is idempotent: the same label is never re-written.
      await dispatch(handlers, 'tool_call', toolEvent('write', doc), ctx);
      assert.deepEqual(session.names, ['Session naming @ feat/odd'], 'and never writes the same name twice');
      // Naming is a session property: it records no association.
      assert.equal(registryBytes(root), before, 'the registry row is untouched by naming');
      assert.equal(oddOf(root, branch), null, 'the worktree still carries no document');
    } finally {
      restoreEnv();
    }
  });

  test('a human-chosen session name is never overwritten', async () => {
    const { target } = makeRepoWithWorktree('naming-human');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, session } = await loadExtension({ currentName: 'my own name' });
      const doc = path.join(target, 'odd', 'tasks', 'other.md');
      fs.mkdirSync(path.dirname(doc), { recursive: true });
      fs.writeFileSync(doc, '# Other\n');
      await dispatch(handlers, 'tool_call', toolEvent('write', doc), ctxFor(target));
      assert.deepEqual(session.names, [], 'a human name is left alone');
    } finally {
      restoreEnv();
    }
  });

  test('the handler never throws nor leaves a write behind when the registry is unwritable', async () => {
    const { root, target, branch } = makeRepoWithWorktree('unwritable');
    const commonDir = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    const before = registryBytes(root);
    fs.chmodSync(commonDir, 0o555);
    try {
      const { handlers } = await loadExtension();
      let threw = null;
      let returns = null;
      try {
        returns = await dispatch(handlers, 'tool_call', toolEvent('read', path.join(target, 'odd', 'notes.md')), ctxFor(target));
      } catch (err) {
        threw = err;
      }
      assert.equal(threw, null, 'the handler never throws');
      for (const value of returns) assert.equal(value, undefined, 'the pipeline is never blocked');
      assert.equal(oddOf(root, branch), null, 'stored data is unchanged');
      assert.equal(
        fs.existsSync(path.join(commonDir, 'pi-worktrees.lock')),
        false,
        'no registry write was even attempted: no lock file is left behind',
      );
    } finally {
      fs.chmodSync(commonDir, 0o755);
      assert.equal(registryBytes(root), before, 'and the file is exactly as it was');
      restoreEnv();
    }
  });
});
