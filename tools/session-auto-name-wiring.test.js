'use strict';
// T2 wiring tests (test-first) for odd/tasks/session-auto-name.md D2-D7:
// the automatic session NAME derived from a WRITE to `odd/tasks/<feature>.md`
// in extensions/gentle-worktree-tools.ts.
//
// Loading pattern mirrors tools/worktree-odd-capture.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck, no type annotations),
// so the test copies it to a temporary .mjs path with the package import
// lines stubbed and import()s it with a fake `pi` that also plays the session
// record (`getSessionName`/`setSessionName`).
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// (real `git init` + one commit, real linked worktrees, registry entries, a
// principal `odd/` directory symlinked into the worktrees). Only observable
// behavior is asserted: the names written through `pi.setSessionName` and how
// many calls were made (idempotence = no repeated calls). The user's real
// checkouts are never touched; only the fixture dirs tracked in `roots` are
// removed.

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

// Fresh fixture repository with one commit, a principal `odd/tasks/`
// directory, one real linked worktree per requested branch (each with the
// principal `odd/` symlinked in, exactly like the creation hooks build) and a
// registry entry owning every worktree.
function makeRepo(tag, branches = ['feat/session-auto-name']) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-name-${tag}-`)));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '--allow-empty', '-m', 'init']);
  const realRoot = fs.realpathSync(root);

  const principalOdd = path.join(realRoot, 'odd');
  fs.mkdirSync(path.join(principalOdd, 'tasks'), { recursive: true });

  const registryLib = require('../lib/worktree-registry.js');
  const worktrees = {};
  for (const branch of branches) {
    const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
    const target = track(path.join(path.dirname(realRoot), `${path.basename(realRoot)}-wt-${slug}`));
    git(realRoot, ['worktree', 'add', '-b', branch, target, 'HEAD']);
    const realTarget = fs.realpathSync(target);
    fs.symlinkSync(principalOdd, path.join(realTarget, 'odd'));
    const stored = registryLib.upsertWorktree(realRoot, {
      branch, path: realTarget, thread: `thread-${slug}`, issues: [], odd: [],
    });
    assert.equal(stored.ok, true);
    worktrees[branch] = realTarget;
  }
  return { root: realRoot, principalOdd, worktrees, branch: branches[0] };
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

// Import the stubbed extension copy with the lib override in place. The fake
// `pi` records every `pi.on` subscription and plays the session record: the
// name starts at `initialName` and every write is recorded, so idempotence is
// observable as a call count. Each load gets its own session id, because the
// module remembers the last ODD label per session.
let sessionSeq = 0;
async function loadExtension(initialName = '') {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-name-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const handlers = new Map(); // event name -> [handler]
  const names = { current: initialName, calls: [] };
  const sessionId = `session-${++sessionSeq}`;
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    // The session record: `setSessionName` appends an entry and the next
    // `getSessionName` returns it, exactly like the host's sanitized name.
    getSessionName: () => (names.current.length > 0 ? names.current : undefined),
    setSessionName: (name) => {
      names.calls.push(name);
      names.current = name.replace(/[\r\n]+/g, ' ').trim();
    },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return { handlers, names, sessionId };
}

function ctxFor(cwd, sessionId) {
  return { cwd, sessionManager: { getSessionId: () => sessionId }, ui: { notify: () => {} } };
}

async function dispatch(handlers, eventName, event, ctx) {
  const list = handlers.get(eventName) || [];
  assert.ok(list.length > 0, `expected a ${eventName} subscription`);
  for (const handler of list) {
    await handler(event, ctx);
  }
}

function writeEvent(toolName, filePath) {
  return { toolName, args: { path: filePath } };
}

// Touch `odd/tasks/<feature>.md` through a worktree's symlinked `odd/`
// directory. The document is created first, like a real write already landed.
function oddTaskPath(worktree, feature) {
  const full = path.join(worktree, 'odd', 'tasks', `${feature}.md`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (!fs.existsSync(full)) fs.writeFileSync(full, `# ${feature}\n`);
  return full;
}

// Same document with explicit content, for the heading-derived labels.
function oddTaskDoc(worktree, feature, text) {
  const full = path.join(worktree, 'odd', 'tasks', `${feature}.md`);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

describe('session auto naming', { concurrency: false }, () => {
  test('a write to an odd task document names the session <feature> @ <branch>', async () => {
    const repo = makeRepo('write');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'session-auto-name')), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, ['session-auto-name @ feat/session-auto-name']);
      assert.equal(names.current, 'session-auto-name @ feat/session-auto-name');
    } finally {
      restoreEnv();
    }
  });

  test('a document heading with spaces becomes the label', async () => {
    const repo = makeRepo('heading');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('');
      const target = repo.worktrees[repo.branch];
      const doc = oddTaskDoc(target, 'pi-fullscreen-perf', '# Pi fullscreen performance for long sessions\n\nBody.\n');
      await dispatch(handlers, 'tool_call', writeEvent('write', doc), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, ['Pi fullscreen performance for long sessions @ feat/session-auto-name']);
    } finally {
      restoreEnv();
    }
  });

  test('a read of the same document does not name the session', async () => {
    const repo = makeRepo('read');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('');
      const target = repo.worktrees[repo.branch];
      const doc = oddTaskPath(target, 'session-auto-name');
      await dispatch(handlers, 'tool_call', writeEvent('read', doc), ctxFor(target, sessionId));
      await dispatch(handlers, 'tool_result', { toolName: 'read', input: { path: doc } }, ctxFor(target, sessionId));
      assert.deepEqual(names.calls, [], 'reading is context gathering, never a rename');
      assert.equal(names.current, '');
    } finally {
      restoreEnv();
    }
  });

  test('the same document written twice writes the name once', async () => {
    const repo = makeRepo('idempotent');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('');
      const target = repo.worktrees[repo.branch];
      const doc = oddTaskPath(target, 'session-auto-name');
      await dispatch(handlers, 'tool_call', writeEvent('write', doc), ctxFor(target, sessionId));
      await dispatch(handlers, 'tool_result', { toolName: 'edit', input: { path: doc } }, ctxFor(target, sessionId));
      await dispatch(handlers, 'tool_call', writeEvent('edit', doc), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, ['session-auto-name @ feat/session-auto-name'], 'one write, no repeated host calls');
      assert.equal(names.current, 'session-auto-name @ feat/session-auto-name');
    } finally {
      restoreEnv();
    }
  });

  test('the principal session is never named', async () => {
    const repo = makeRepo('principal');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('');
      const doc = path.join(repo.principalOdd, 'tasks', 'session-auto-name.md');
      fs.writeFileSync(doc, '# session-auto-name\n');
      await dispatch(handlers, 'tool_call', writeEvent('write', doc), ctxFor(repo.root, sessionId));
      assert.deepEqual(names.calls, [], 'the principal checkout owns no registered worktree');
      assert.equal(names.current, '');
    } finally {
      restoreEnv();
    }
  });

  test('a human-chosen session name is never touched', async () => {
    const repo = makeRepo('human');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('my own session');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'session-auto-name')), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, [], 'a name the plugin does not produce belongs to the human');
      assert.equal(names.current, 'my own session');
    } finally {
      restoreEnv();
    }
  });

  test('a human name with spaces is never touched', async () => {
    const repo = makeRepo('human-heading');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('Fix the sidebar layout by hand');
      const target = repo.worktrees[repo.branch];
      const doc = oddTaskDoc(target, 'pi-fullscreen-perf', '# Pi fullscreen performance for long sessions\n');
      await dispatch(handlers, 'tool_call', writeEvent('write', doc), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, [], 'a heading-shaped name from a different document is still a human name');
      assert.equal(names.current, 'Fix the sidebar layout by hand');
    } finally {
      restoreEnv();
    }
  });

  test('a resumed session recomputes the name when the document changed', async () => {
    const repo = makeRepo('resume');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      // The session record carries the plugin's previous label (the document
      // was renamed since), so the derive runs again through the same
      // ownership test.
      const { handlers, names, sessionId } = await loadExtension('old-feature @ feat/session-auto-name');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'new-feature')), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, ['new-feature @ feat/session-auto-name']);
      assert.equal(names.current, 'new-feature @ feat/session-auto-name');
    } finally {
      restoreEnv();
    }
  });

  test('a name a human set after the auto-name was applied stays', async () => {
    const repo = makeRepo('rename-after');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('renamed by hand');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'new-feature')), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, []);
      assert.equal(names.current, 'renamed by hand');
    } finally {
      restoreEnv();
    }
  });

  test('two worktrees on the same feature carry different names (branch suffix)', async () => {
    const repo = makeRepo('collision', ['feat/session-auto-name', 'feat/session-auto-name-alt']);
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const first = await loadExtension('');
      const second = await loadExtension('');
      const doc = 'session-auto-name';
      await dispatch(
        first.handlers, 'tool_call',
        writeEvent('write', oddTaskPath(repo.worktrees['feat/session-auto-name'], doc)),
        ctxFor(repo.worktrees['feat/session-auto-name'], first.sessionId),
      );
      await dispatch(
        second.handlers, 'tool_call',
        writeEvent('write', oddTaskPath(repo.worktrees['feat/session-auto-name-alt'], doc)),
        ctxFor(repo.worktrees['feat/session-auto-name-alt'], second.sessionId),
      );
      assert.equal(first.names.current, 'session-auto-name @ feat/session-auto-name');
      assert.equal(second.names.current, 'session-auto-name @ feat/session-auto-name-alt');
      assert.notEqual(first.names.current, second.names.current, 'concurrent forks never share a label');
    } finally {
      restoreEnv();
    }
  });

  test('an ODD phase transition re-applies the label remembered from the write', async () => {
    const repo = makeRepo('phase');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'session-auto-name')), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, ['session-auto-name @ feat/session-auto-name']);
      // A record that lost its name: the phase transition is the only event
      // left, and it re-applies the label the write remembered.
      names.current = '';
      await dispatch(
        handlers, 'tool_result',
        { toolName: 'gentle_odd_phase', input: { phase: 'implementing' } },
        ctxFor(target, sessionId),
      );
      assert.deepEqual(names.calls, [
        'session-auto-name @ feat/session-auto-name',
        'session-auto-name @ feat/session-auto-name',
      ]);
    } finally {
      restoreEnv();
    }
  });

  test('an ODD phase transition applies nothing without an earlier ODD write', async () => {
    const repo = makeRepo('phase-no-write');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('');
      await dispatch(
        handlers, 'tool_result',
        { toolName: 'gentle_odd_phase', input: { phase: 'implementing' } },
        ctxFor(repo.worktrees[repo.branch], sessionId),
      );
      assert.deepEqual(names.calls, [], 'the phase says nothing about which feature the session is on');
      assert.equal(names.current, '');
    } finally {
      restoreEnv();
    }
  });

  test('an ODD phase transition does not touch a human name', async () => {
    const repo = makeRepo('phase-human');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers, names, sessionId } = await loadExtension('my own session');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'session-auto-name')), ctxFor(target, sessionId));
      await dispatch(
        handlers, 'tool_result',
        { toolName: 'gentle_odd_phase', input: { phase: 'checking' } },
        ctxFor(target, sessionId),
      );
      assert.deepEqual(names.calls, []);
      assert.equal(names.current, 'my own session');
    } finally {
      restoreEnv();
    }
  });

  test('with the worktree toggle off, neither trigger writes a name', async () => {
    const repo = makeRepo('toggle-off');
    const stateDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-name-mode-')));
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: stateDir });
    try {
      require('../lib/worktree-mode.js').writeMode(false, process.env);
      const { handlers, names, sessionId } = await loadExtension('');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'session-auto-name')), ctxFor(target, sessionId));
      await dispatch(
        handlers, 'tool_result',
        { toolName: 'gentle_odd_phase', input: { phase: 'implementing' } },
        ctxFor(target, sessionId),
      );
      assert.deepEqual(names.calls, [], 'the toggle off leaves the session name alone');
      assert.equal(names.current, '');
    } finally {
      restoreEnv();
    }
  });

  test('with the worktree toggle on, both triggers can name the session', async () => {
    const repo = makeRepo('toggle-on');
    const stateDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-name-mode-')));
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: stateDir });
    try {
      require('../lib/worktree-mode.js').writeMode(true, process.env);
      const { handlers, names, sessionId } = await loadExtension('');
      const target = repo.worktrees[repo.branch];
      await dispatch(handlers, 'tool_call', writeEvent('write', oddTaskPath(target, 'session-auto-name')), ctxFor(target, sessionId));
      assert.deepEqual(names.calls, ['session-auto-name @ feat/session-auto-name']);
      names.current = '';
      await dispatch(
        handlers, 'tool_result',
        { toolName: 'gentle_odd_phase', input: { phase: 'checking' } },
        ctxFor(target, sessionId),
      );
      assert.equal(names.current, 'session-auto-name @ feat/session-auto-name');
      assert.equal(names.calls.length, 2, 'the phase trigger is live with the toggle on');
    } finally {
      restoreEnv();
    }
  });
});
