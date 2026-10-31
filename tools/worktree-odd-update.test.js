'use strict';
// T18-T23 / S25-S32 tests (test-first RED): odd docs on list, create
// odd + create-or-update, startup discovery, name-or-path resolution,
// principal rules, detector boundary.
//
// Loading pattern mirrors tools/worktree-list.test.js: stub the two
// package imports, copy the extension to a temp .mjs, import with a fake
// pi. Fixtures are isolated repos under os.tmpdir(); only roots tracked
// here are removed.

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
const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-ou-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  const real = fs.realpathSync(dir);
  // The tool builds its checkouts beside the fixture root
  // (`<root>-worktrees/<slug>`), so that sibling directory is tracked too:
  // otherwise every created worktree outlives the suite in the temp root.
  track(path.join(path.dirname(real), `${path.basename(real)}-worktrees`));
  return real;
}

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

function stdEnv() {
  return {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ou-mode-'))),
    GENTLE_WORKTREE_THREAD: undefined,
    // Fail-closed herdr injection: with no binary injected the extension
    // refuses to spawn live herdr (resolveHerdrBinary throws under the
    // test harness), so every test here names a binary that cannot exist.
    // The herdr-first create path then falls back to `git worktree add`
    // without ever touching a live Herdr session.
    HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-ou'),
  };
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ou-ext-')));
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

function makeCtx(cwd, thread = 'thread-1') {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => thread },
    ui: { confirm: async () => true, notify: () => {} },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

function addRegistered(root, branch, { thread = 'thread-1', issues = [], odd = null } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-ou-${slug}`);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const realTarget = fs.realpathSync(target);
  const registryLib = require('../lib/worktree-registry.js');
  const stored = registryLib.upsertWorktree(root, {
    branch, path: realTarget, thread, issues, odd,
  });
  assert.equal(stored.ok, true);
  return realTarget;
}

function addUnregistered(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-ou-${slug}`);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  return fs.realpathSync(target);
}

describe('S1: list publishes no ODD association and no document inventory', { concurrency: false }, () => {
  test('available documents stay unread: neither text nor details carries an association', async () => {
    const root = makeRepo('list-odd');
    setEnv(stdEnv());
    try {
      // The registry row keeps its legacy association; the checkout also holds
      // a document of its own. S1 removed the association from every worktree
      // surface, so the listing publishes neither and scans nothing.
      const target = addRegistered(root, 'feat/odd-list', { odd: 'odd/tasks/stored.md' });
      fs.mkdirSync(path.join(target, 'odd'), { recursive: true });
      fs.writeFileSync(path.join(target, 'odd', 'notes.md'), '# notes\n');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_list').execute('c1', {}, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      const row = result.details.worktrees.find((item) => item.branch === 'feat/odd-list');
      assert.ok(row, 'row present in details');
      assert.ok(path.isAbsolute(row.path), 'details keeps the absolute checkout path');
      for (const key of ['odd', 'assignedOdd', 'issues', 'droppedOdd']) {
        assert.equal(Object.hasOwn(row, key), false, `details publish no ${key}: ${JSON.stringify(row)}`);
      }
      const line = text.split('\n').find((l) => l.includes('feat/odd-list'));
      assert.equal(line, `feat-odd-list · feat/odd-list · ${target} · agent · live`);
      assert.doesNotMatch(text, /notes\.md|stored\.md/, 'neither the inventory nor the association document reaches the text');
      assert.doesNotMatch(text, /issues=|odd=|assignedOdd|available odd/i, `no association cell or key: ${text}`);
      // Legacy data preservation: the stored association is untouched.
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/odd-list').odd, 'odd/tasks/stored.md');
    } finally {
      restoreEnv();
    }
  });
});

describe('S1/S6: a create never takes an odd document', { concurrency: false }, () => {
  test('a supplied odd path — one document, a list, or a missing file — is ignored', async () => {
    const root = makeRepo('create-odd');
    setEnv(stdEnv());
    try {
      const doc = path.join(root, 'odd-doc.md');
      fs.writeFileSync(doc, '# doc\n');
      const second = path.join(root, 'second-odd.md');
      fs.writeFileSync(second, '# second\n');
      const missing = path.join(root, 'no-such-odd.md');
      const { tools } = await loadExtension();
      const registryLib = require('../lib/worktree-registry.js');
      // One document, a list of them and a path that does not exist all take
      // the same route: the tool reads the branch and nothing else.
      for (const [branch, odd] of [
        ['feat/with-odd', doc],
        ['feat/list-odd', [doc, second]],
        ['feat/bad-odd', missing],
      ]) {
        const result = await tools.get('worktree_create').execute(
          'c1', { branch, odd }, undefined, undefined, makeCtx(root, `thread-${branch}`),
        );
        const text = resultText(result);
        assert.equal(result.isError, undefined, `${branch}: an odd field must not refuse a create: ${text}`);
        assert.equal('odd' in result.details, false, `${branch}: no odd field travels`);
        const entry = registryLib.findByBranch(root, branch);
        assert.ok(entry, `${branch}: registered`);
        assert.equal(entry.odd, null, `${branch}: no document is stored`);
      }
    } finally {
      restoreEnv();
    }
  });
});

describe('S1: a create never updates an existing worktree', { concurrency: false }, () => {
  test('another thread asking for a live branch is refused and the stored row is untouched', async () => {
    const root = makeRepo('create-update');
    setEnv(stdEnv());
    try {
      const branch = 'feat/upd';
      const slug = 'feat-upd';
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);
      track(path.dirname(target));
      git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
      const realTarget = fs.realpathSync(target);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.upsertWorktree(root, {
        branch, path: realTarget, thread: 'thread-upd', issues: [1], odd: null,
      }).ok, true);
      const before = registryLib.findByBranch(root, branch);
      const doc = path.join(root, 'upd-odd.md');
      fs.writeFileSync(doc, '# u\n');
      const { tools } = await loadExtension();
      // An association field and a foreign thread change nothing: there is no
      // update path, so this is the historical refusal.
      const result = await tools.get('worktree_create').execute(
        'c1', { branch, odd: doc, issues: [2] }, undefined, undefined, makeCtx(root, 'thread-other'),
      );
      assert.equal(result.isError, true, `expected the refusal, got: ${resultText(result)}`);
      assert.match(resultText(result), /already checked out/);
      assert.deepEqual(registryLib.findByBranch(root, branch), before, 'the stored row is untouched');
    } finally {
      restoreEnv();
    }
  });
});

describe('T20/S28: startup discovery registers missing repository worktrees', { concurrency: false }, () => {
  test('session_start registers a live checkout the registry never saw', async () => {
    const root = makeRepo('discover');
    setEnv(stdEnv());
    try {
      const ghost = addUnregistered(root, 'feat/ghost-disc');
      const { handlers } = await loadExtension();
      const starters = handlers.get('session_start') || [];
      assert.ok(starters.length > 0, 'a session_start subscription exists');
      for (const handler of starters) {
        await handler({ cwd: root }, makeCtx(root));
      }
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/ghost-disc');
      assert.ok(entry, 'discovery registered the missing worktree');
      assert.equal(entry.path, ghost, 'the checkout path is registered');
    } finally {
      restoreEnv();
    }
  });
});

describe('T21/S29+S32: close and session_open resolve name first then path', { concurrency: false }, () => {
  test('close accepts the checkout path in the name field', async () => {
    const root = makeRepo('close-path');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/by-path');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_close').execute(
        'c1', { name: target, force: true }, undefined, undefined, makeCtx(root),
      );
      assert.equal(result.isError, undefined, `close by path succeeds, got: ${resultText(result)}`);
      assert.equal(fs.existsSync(target), false, 'checkout removed');
    } finally {
      restoreEnv();
    }
  });

  test('close refuses a foreign path with no side effect', async () => {
    const root = makeRepo('close-foreign');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/kept');
      const foreign = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ou-foreign-')));
      const { tools } = await loadExtension();
      const before = fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root));
      const result = await tools.get('worktree_close').execute(
        'c1', { name: foreign, force: true }, undefined, undefined, makeCtx(root),
      );
      assert.equal(result.isError, true, 'foreign path fails closed');
      assert.equal(fs.existsSync(target), true, 'registered checkout untouched');
      assert.deepEqual(fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root)), before, 'registry untouched');
    } finally {
      restoreEnv();
    }
  });

  test('close refuses the principal checkout before acting', async () => {
    const root = makeRepo('close-principal');
    setEnv(stdEnv());
    try {
      addRegistered(root, 'feat/other');
      const { tools } = await loadExtension();
      const before = fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root));
      const result = await tools.get('worktree_close').execute(
        'c1', { name: 'principal', force: true }, undefined, undefined, makeCtx(root),
      );
      assert.equal(result.isError, true, 'principal refused');
      assert.match(resultText(result), /principal/i, 'the refusal names the principal');
      assert.equal(fs.existsSync(root), true, 'principal checkout untouched');
      assert.deepEqual(fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root)), before, 'registry untouched');
    } finally {
      restoreEnv();
    }
  });
});

describe('S1: the tool pipeline records no association, from either context', { concurrency: false }, () => {
  // The pipeline hook used to associate the first `odd/` document a worktree
  // touched (plus a bounded re-scan of the worktree's `odd/`). S1 removed the
  // association from every worktree surface, so the hook now only names the
  // session — which is covered by tools/worktree-odd-capture.test.js. Here the
  // worktree row must stay association-free no matter how much `odd/` grows.
  test('events from the principal and from a worktree assign nothing', async () => {
    const root = makeRepo('detector-bound');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/det');
      const registryLib = require('../lib/worktree-registry.js');
      const before = fs.readFileSync(registryLib.registryPath(root), 'utf8');
      const { handlers } = await loadExtension();
      const calls = handlers.get('tool_call') || [];
      assert.ok(calls.length > 0, 'a tool_call subscription exists');
      // A new document appears in the worktree while the session runs.
      fs.mkdirSync(path.join(target, 'odd'), { recursive: true });
      fs.writeFileSync(path.join(target, 'odd', 'later.md'), '# later\n');
      for (const cwd of [root, target]) {
        for (const handler of calls) {
          const value = await handler(
            { toolName: 'read', args: { path: path.join(target, 'odd', 'later.md') } },
            makeCtx(cwd),
          );
          assert.equal(value, undefined, 'the handler never blocks the pipeline');
        }
      }
      assert.equal(registryLib.findByBranch(root, 'feat/det').odd, null, 'no detection and no assignment, anywhere');
      assert.equal(
        fs.readFileSync(registryLib.registryPath(root), 'utf8'),
        before,
        'the registry was never written by the pipeline',
      );
    } finally {
      restoreEnv();
    }
  });
});

describe('S1: the ODD and issues viewers hand the view no write path', { concurrency: false }, () => {
  // Both viewers used to receive a `saveAssignment` callback (guarded by
  // `assignmentEnabled`) that wrote the checkout's `odd`/`issues` field into
  // the worktree registry. S1 removed the association, so those callbacks are
  // gone: the view is given no way to write and the registry stays untouched.
  const stubTui = {
    visibleWidth: (text) => [...String(text)].length,
    truncateToWidth: (text, width) => {
      const chars = [...String(text)];
      return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
    },
    matchesKey: (key, name) => key === name,
    isKeyRelease: () => false,
  };

  function captureViewModule(moduleName, factoryName) {
    const lib = require(`../lib/${moduleName}`);
    const original = lib[factoryName];
    const holder = { options: null };
    lib[factoryName] = (options) => {
      holder.options = options;
      return { render: () => [], handleInput: () => {}, invalidate: () => {} };
    };
    return { holder, restore: () => { lib[factoryName] = original; } };
  }

  function viewCtx(cwd) {
    const notes = [];
    return {
      notes,
      ctx: {
        cwd,
        hasUI: true,
        sessionManager: { getSessionId: () => 'thread-1' },
        ui: {
          notify: (message, level) => notes.push([message, level]),
          custom: async (factory) => {
            factory({ terminal: { rows: 24 }, requestRender: () => {} }, {}, {}, () => {});
            return null;
          },
        },
      },
    };
  }

  test('/herdr-gentle:odd opens its view with no save callback and writes nothing', async () => {
    const root = makeRepo('viewer-odd');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/viewer-odd', { odd: 'odd/tasks/kept.md' });
      fs.mkdirSync(path.join(target, 'odd', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(target, 'odd', 'tasks', 'readme.md'), '# readme\n');
      const registryLib = require('../lib/worktree-registry.js');
      const before = fs.readFileSync(registryLib.registryPath(root), 'utf8');
      const { commands, mod } = await loadExtension();
      mod.setOddTuiLoader(async () => stubTui);
      const capture = captureViewModule('odd-view.js', 'createOddView');
      try {
        await commands.get('herdr-gentle:odd').handler('', viewCtx(target).ctx);
      } finally {
        capture.restore();
      }
      const options = capture.holder.options;
      assert.ok(options, 'the viewer was opened');
      assert.equal(Object.hasOwn(options, 'saveAssignment'), false, 'no association write path is handed over');
      assert.equal(Object.hasOwn(options, 'assignmentEnabled'), false, 'and no write gate either');
      assert.equal(
        fs.readFileSync(registryLib.registryPath(root), 'utf8'),
        before,
        'the registry is untouched by opening the viewer',
      );
    } finally {
      restoreEnv();
    }
  });

  test('/herdr-gentle:issues opens its view with no save callback and writes nothing', async () => {
    const root = makeRepo('viewer-issues');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/viewer-issues', { issues: [7] });
      const registryLib = require('../lib/worktree-registry.js');
      const before = fs.readFileSync(registryLib.registryPath(root), 'utf8');
      const { commands, mod } = await loadExtension();
      mod.setIssuesTuiLoader(async () => stubTui);
      const capture = captureViewModule('issues-view.js', 'createIssuesView');
      try {
        await commands.get('herdr-gentle:issues').handler('', viewCtx(target).ctx);
      } finally {
        capture.restore();
      }
      const options = capture.holder.options;
      assert.ok(options, 'the viewer was opened');
      assert.equal(Object.hasOwn(options, 'saveAssignment'), false, 'no association write path is handed over');
      assert.equal(Object.hasOwn(options, 'assignmentEnabled'), false, 'and no write gate either');
      assert.equal(
        fs.readFileSync(registryLib.registryPath(root), 'utf8'),
        before,
        'the registry is untouched by opening the viewer',
      );
    } finally {
      restoreEnv();
    }
  });
});

describe('S1: the principal checkout is never edited by a create', { concurrency: false }, () => {
  test('the principal branch is refused as already checked out and writes no record', async () => {
    const root = makeRepo('principal-edit');
    setEnv(stdEnv());
    try {
      const branch = git(root, ['branch', '--show-current']);
      const doc = path.join(root, 'p-odd.md');
      fs.writeFileSync(doc, '# p\n');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch, odd: doc }, undefined, undefined, makeCtx(root, 'thread-p'),
      );
      // The principal is already a live checkout of that branch, so the create
      // refuses instead of recording anything against it.
      assert.equal(result.isError, true, `expected the refusal, got: ${resultText(result)}`);
      assert.match(resultText(result), /already checked out/);
      assert.equal(
        require('../lib/worktree-registry.js').findByBranch(root, branch),
        null,
        'no record is created for the principal',
      );
    } finally {
      restoreEnv();
    }
  });
});
