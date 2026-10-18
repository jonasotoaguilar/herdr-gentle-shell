'use strict';
// T4 (odd-viewer S1,S3,S6) tests: the `/herdr-gentle:odd` command in
// extensions/gentle-worktree-tools.ts.
//
// Contract under test (observable behavior only — the custom/select calls,
// the exact notified text, the rendered rows; never internal names):
// - registered unconditionally next to /herdr-gentle:customize and
//   /herdr-gentle:warp;
// - no argument opens the two-pane view through ctx.ui.custom with the
//   full-screen overlay options, over the CURRENT checkout's odd/tasks
//   documents, and writes nothing;
// - Esc closes with no notification;
// - a checkout without odd documents still opens the view (its own empty
//   state), never a fake document;
// - a cwd outside any Git checkout notifies and opens nothing;
// - when the TUI helpers cannot be loaded (or ctx.ui.custom is missing) the
//   command falls back to the plain ctx.ui.select menu.
//
// Loading pattern mirrors tools/customize-panel.test.js: the TypeScript
// extension is plain JS under the hood, so the test copies it to a temporary
// .mjs with the package import lines stubbed and import()s it with a fake
// `pi` object.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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
  .replace('import { Type } from "@earendil-works/pi-ai";', TYPE_STUB)
  .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (def) => def;');
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

// A real Git checkout with odd documents: the command resolves the checkout
// through the real git plumbing, so the fixture must be a real repository.
function makeRepo({ docs = {}, tag = 'odd' } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  const root = fs.realpathSync(dir);
  for (const [name, content] of Object.entries(docs)) {
    const target = path.join(root, 'odd', 'tasks', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-odd-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const commands = new Map();
  const pi = {
    registerTool: () => {},
    registerCommand: (name, def) => { commands.set(name, def); },
    on: () => () => {},
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { commands, mod };
}

const stubTui = {
  visibleWidth: (text) => [...String(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

function makeHostTui(rows = 20) {
  const paints = [];
  return { paints, tui: { terminal: { rows }, requestRender: () => paints.push(true) } };
}

function makeCtx({ cwd, customImpl, selectImpl } = {}) {
  const notes = [];
  const selects = [];
  const customs = [];
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => notes.push([message, level]),
      select: async (title, options) => {
        selects.push([title, options]);
        return typeof selectImpl === 'function' ? selectImpl(title, options) : selectImpl;
      },
    },
  };
  if (customImpl !== undefined) {
    ctx.ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  return { ctx, notes, selects, customs };
}

function openComponent(factory, host) {
  let settled = 'pending';
  const component = factory(host.tui, {}, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  assert.equal(typeof component.invalidate, 'function');
  return { component, done: () => settled };
}

describe('/herdr-gentle:odd', () => {
  test('is registered and opens the two-pane view over the current checkout documents', async () => {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    assert.ok(def, 'expected the herdr-gentle:odd command to be registered');
    assert.equal(typeof def.handler, 'function');
    const root = makeRepo({
      docs: {
        'alpha.md': '# alpha\n\n## Specs\nS1. first rule\n',
        'beta.md': '# beta\n\n## Tasks\nT1 | S1 | done | a row\n',
      },
    });
    const host = makeHostTui(20);
    mod.setOddTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({
      cwd: root,
      customImpl: async (factory) => {
        const { component } = openComponent(factory, host);
        return component.render(80), component.handleInput('escape'), null;
      },
    });
    await def.handler('', ctx);
    assert.equal(customs.length, 1, 'the overlay is opened once');
    assert.deepEqual(customs[0][1], {
      overlay: true,
      overlayOptions: { anchor: 'center', width: '100%', maxHeight: '100%', margin: 0 },
    });
    assert.deepEqual(notes, [], 'closing writes no notification');
    const { component } = openComponent(customs[0][0], host);
    const body = component.render(100).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(body, /✎ Odd · 2 documents/);
    assert.match(body, /alpha/);
    assert.match(body, /beta/);
    assert.match(body, /S1\. first rule/, 'the right pane shows the selected document');
  });

  test('a checkout without odd documents notifies and opens nothing', async () => {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    const root = makeRepo({ docs: {} });
    mod.setOddTuiLoader(async () => stubTui);
    const host = makeHostTui(12);
    const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await def.handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay when there is nothing to read');
    assert.equal(notes.length, 1, 'the reader gets one line saying so');
    assert.match(notes[0][0], /no odd documents/i);
    assert.match(notes[0][0], /odd\/tasks/);
    assert.equal(notes[0][1], 'info');
  });

  test('outside a Git checkout it notifies and opens nothing', async () => {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    const outside = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-odd-plain-')));
    mod.setOddTuiLoader(async () => stubTui);
    const { ctx, customs, notes } = makeCtx({ cwd: outside, customImpl: async () => null });
    await def.handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay outside a checkout');
    assert.equal(notes.length, 1);
    assert.match(notes[0][0], /not inside a Git checkout/i);
  });

  test('without the TUI helpers it falls back to the plain select menu', async () => {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
    mod.setOddTuiLoader(async () => { throw new Error('pi-tui unavailable'); });
    let picked = null;
    const { ctx, selects, notes } = makeCtx({
      cwd: root,
      selectImpl: (title, options) => { picked = [title, options]; return 'alpha'; },
    });
    await def.handler('', ctx);
    assert.equal(selects.length >= 1, true, 'the fallback asks the host to select');
    assert.ok(picked[1].includes('alpha'), 'the fallback lists the document names');
    assert.equal(notes.length, 1, 'the fallback names the file it would show');
    assert.match(notes[0][0], /odd\/tasks\/alpha\.md/);
  });
});

describe('/herdr-gentle:odd assignment (S8/T9)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');
  const rowFor = (body, name) => body.split('\n').find((line) =>
    new RegExp(`[▸ ] [✓·✎] ${name}( |$)`).test(line));

  function registryFile(root) {
    const common = git(root, ['rev-parse', '--git-common-dir']).trim();
    const commonDir = path.isAbsolute(common) ? common : path.resolve(root, common);
    return path.join(commonDir, 'pi-worktrees.json');
  }

  function writeRegistry(root, worktrees) {
    const file = registryFile(root);
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, worktrees }, null, 2)}\n`);
    return file;
  }

  function readRaw(file) {
    return fs.readFileSync(file, 'utf8');
  }

  function branchOf(root) {
    return git(root, ['branch', '--show-current']).trim();
  }

  // Thread identity for created rows resolves exactly like the create
  // path: GENTLE_WORKTREE_THREAD first, then the Pi session id. The
  // viewer tests run without a session manager, so the env override is
  // the identity under test; the previous value is always restored.
  function withThread(value) {
    const prev = process.env.GENTLE_WORKTREE_THREAD;
    if (value === undefined) delete process.env.GENTLE_WORKTREE_THREAD;
    else process.env.GENTLE_WORKTREE_THREAD = value;
    return () => {
      if (prev === undefined) delete process.env.GENTLE_WORKTREE_THREAD;
      else process.env.GENTLE_WORKTREE_THREAD = prev;
    };
  }

  async function openOdd(root) {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    mod.setOddTuiLoader(async () => stubTui);
    const host = makeHostTui(20);
    let factory = null;
    const { ctx, notes } = makeCtx({
      cwd: root,
      customImpl: async (captured) => { factory = captured; return null; },
    });
    await def.handler('', ctx);
    assert.ok(factory, 'the overlay opens');
    const { component } = openComponent(factory, host);
    return { component, notes };
  }

  test('reads the stored assignment for the current checkout', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    writeRegistry(root, [{
      branch: branchOf(root), path: root, thread: 'test-thread', issues: [], odd: ['odd/tasks/alpha.md'],
    }]);
    const { component, notes } = await openOdd(root);
    const body = clean(component.render(100).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✓/, 'the stored row carries ✓');
    assert.match(rowFor(body, 'beta'), /·/, 'the unassigned row carries ·');
    assert.match(body, new RegExp(path.basename(root)), 'the title names the checkout');
    assert.match(body, /1 assigned/, 'the title carries the assigned count');
    assert.deepEqual(notes, [], 'reading writes nothing and notifies nothing');
  });

  test('ctrl+s persists the whole pending set through the registry', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    const file = writeRegistry(root, [{
      branch: branchOf(root), path: root, thread: 'test-thread', issues: [], odd: ['odd/tasks/alpha.md'],
    }]);
    const { component } = await openOdd(root);
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    const stored = JSON.parse(readRaw(file));
    assert.deepEqual(stored.worktrees[0].odd, ['odd/tasks/alpha.md', 'odd/tasks/beta.md']);
    const body = clean(component.render(100).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✓/);
    assert.match(rowFor(body, 'beta'), /✓/, 'the saved toggle is applied');
    assert.ok(!body.includes('unsaved'), 'a successful save clears the pending state');
  });

  test('saving creates the registry row when absent', async () => {
    const restoreThread = withThread('test-thread');
    try {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
    const file = registryFile(root);
    const expectedBranch = branchOf(root);
    assert.ok(!fs.existsSync(file), 'the fixture starts with no registry');
    const { component } = await openOdd(root);
    let body = clean(component.render(100).join('\n'));
    assert.match(rowFor(body, 'alpha'), /·/, 'nothing is marked when no row exists');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.ok(fs.existsSync(file), 'the save creates the registry');
    const stored = JSON.parse(readRaw(file));
    assert.equal(stored.worktrees.length, 1);
    assert.equal(stored.worktrees[0].path, root);
    assert.equal(stored.worktrees[0].branch, expectedBranch, 'the created row carries the checkout real branch');
    assert.equal(stored.worktrees[0].thread, 'test-thread', 'the created row carries the resolved thread identity');
    assert.deepEqual(stored.worktrees[0].odd, ['odd/tasks/alpha.md']);
    body = clean(component.render(100).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✓/, 'the created row reads back as stored');
    } finally { restoreThread(); }
  });

  test('a refusing registry reports the error without writing', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    const file = writeRegistry(root, []);
    fs.writeFileSync(file, '{not json');
    const before = readRaw(file);
    const { component } = await openOdd(root);
    let body = clean(component.render(100).join('\n'));
    assert.match(rowFor(body, 'alpha'), /·/, 'a malformed registry leaves the view usable with nothing marked');
    component.handleInput('down');
    assert.equal(component.state.index, 1, 'navigation still works');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    body = clean(component.render(100).join('\n'));
    assert.match(body, /save failed/, 'the failed save shows its error');
    assert.match(rowFor(body, 'beta'), /✎/, 'the pending mark survives the refusal');
    assert.equal(readRaw(file), before, 'the refusing registry is left untouched');
  });

  test('toggling without ctrl+s writes nothing to the registry', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
    const file = writeRegistry(root, [{
      branch: branchOf(root), path: root, thread: 'test-thread', issues: [], odd: ['odd/tasks/alpha.md'],
    }]);
    const before = readRaw(file);
    const { component } = await openOdd(root);
    component.handleInput('space');
    component.handleInput('escape');
    await tick();
    assert.equal(readRaw(file), before, 'no write happens without ctrl+s');
  });

  test('creating the row records the real branch and the resolved thread identity', async () => {
    const restoreThread = withThread('odd-test-thread-a');
    try {
      const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
      const file = registryFile(root);
      assert.ok(!fs.existsSync(file), 'the fixture starts with no registry');
      const expectedBranch = branchOf(root);
      assert.ok(expectedBranch.length > 0, 'the fixture checkout has a real branch');
      const { component } = await openOdd(root);
      component.handleInput('space');
      component.handleInput('ctrl+s');
      await tick();
      const body = clean(component.render(100).join('\n'));
      assert.ok(!body.includes('save failed'), 'the save succeeds');
      const stored = JSON.parse(readRaw(file));
      assert.equal(stored.worktrees.length, 1);
      assert.equal(stored.worktrees[0].branch, expectedBranch, 'the created row carries the checkout real branch, never a placeholder');
      assert.equal(stored.worktrees[0].thread, 'odd-test-thread-a', 'the created row carries the resolved thread, never a placeholder');
    } finally { restoreThread(); }
  });

  test('without a resolvable thread identity the save refuses and writes nothing', async () => {
    const restoreThread = withThread(undefined);
    try {
      const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
      const file = writeRegistry(root, []);
      const before = readRaw(file);
      const { component } = await openOdd(root);
      component.handleInput('space');
      component.handleInput('ctrl+s');
      await tick();
      const body = clean(component.render(100).join('\n'));
      assert.match(body, /save failed/, 'the refusal surfaces in the view');
      assert.match(body, /thread identity/, 'the error names the missing thread identity');
      assert.equal(readRaw(file), before, 'the registry file stays byte-identical');
      assert.deepEqual(JSON.parse(readRaw(file)).worktrees, [], 'no row is created');
    } finally { restoreThread(); }
  });

  test('without a determinable branch the save refuses and writes nothing', async () => {
    const restoreThread = withThread('odd-test-thread-c');
    try {
      const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
      git(root, ['checkout', '--detach', 'HEAD']);
      const file = writeRegistry(root, []);
      const before = readRaw(file);
      const { component } = await openOdd(root);
      component.handleInput('space');
      component.handleInput('ctrl+s');
      await tick();
      const body = clean(component.render(100).join('\n'));
      assert.match(body, /save failed/, 'the refusal surfaces in the view');
      assert.match(body, /branch/, 'the error names the missing branch');
      assert.equal(readRaw(file), before, 'the registry file stays byte-identical');
      assert.deepEqual(JSON.parse(readRaw(file)).worktrees, [], 'no row is created');
    } finally { restoreThread(); }
  });

  test('updating one row leaves the other row untouched (no data loss)', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    const otherPath = path.join(os.tmpdir(), `wt-odd-other-${process.pid}-${Date.now()}`);
    const stamp = '2026-01-01T00:00:00.000Z';
    const file = writeRegistry(root, [
      {
        branch: branchOf(root), path: root, thread: 'test-thread', issues: [3],
        odd: ['odd/tasks/alpha.md'], createdAt: stamp, updatedAt: stamp,
      },
      {
        branch: 'other-branch', path: otherPath, thread: 'other-thread', issues: [7],
        odd: ['odd/tasks/keep.md'], createdAt: stamp, updatedAt: stamp,
      },
    ]);
    const otherBefore = JSON.parse(readRaw(file)).worktrees[1];
    const { component } = await openOdd(root);
    component.handleInput('down');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    const stored = JSON.parse(readRaw(file));
    assert.equal(stored.worktrees.length, 2, 'both rows still exist');
    assert.deepEqual(stored.worktrees[1], otherBefore, 'the untouched row keeps its issues/odd/thread/timestamps');
    assert.deepEqual(stored.worktrees[0].odd, ['odd/tasks/alpha.md', 'odd/tasks/beta.md'], 'only the current row odd changes');
    assert.deepEqual(stored.worktrees[0].issues, [3], 'the current row issues survive');
  });

  test('a same-branch row at a different live checkout is kept, not replaced', async () => {
    const restoreThread = withThread('odd-test-thread-e');
    try {
      const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
      const targetBranch = branchOf(root);
      const wtBase = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-odd-collide-')));
      const linked = path.join(wtBase, 'linked');
      git(root, ['worktree', 'add', linked, '-b', 'collide-branch']);
      const linkedReal = fs.realpathSync(linked);
      const stamp = '2026-02-01T00:00:00.000Z';
      const keeper = {
        branch: targetBranch, path: linkedReal, thread: 'keeper-thread', issues: [9],
        odd: ['odd/tasks/keep.md'], createdAt: stamp, updatedAt: stamp,
      };
      const file = writeRegistry(root, [keeper]);
      const keeperBefore = JSON.parse(readRaw(file)).worktrees[0];
      const { component } = await openOdd(root);
      component.handleInput('space');
      component.handleInput('ctrl+s');
      await tick();
      const body = clean(component.render(100).join('\n'));
      assert.ok(!body.includes('save failed'), 'the save succeeds');
      const stored = JSON.parse(readRaw(file));
      assert.equal(stored.worktrees.length, 2, 'both rows still exist');
      const kept = stored.worktrees.find((row) => row.path === linkedReal);
      assert.deepEqual(kept, keeperBefore, 'the colliding row keeps its issues/odd/thread/createdAt');
      const created = stored.worktrees.find((row) => row.path === root);
      assert.ok(created, 'the new checkout is registered alongside it');
      assert.equal(created.branch, targetBranch);
      assert.equal(created.thread, 'odd-test-thread-e');
      assert.deepEqual(created.odd, ['odd/tasks/alpha.md']);
    } finally { restoreThread(); }
  });
});

describe('/herdr-gentle:odd external open (K3)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

  async function openOdd(root) {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    mod.setOddTuiLoader(async () => stubTui);
    const host = makeHostTui(20);
    let factory = null;
    const { ctx } = makeCtx({
      cwd: root,
      customImpl: async (captured) => { factory = captured; return null; },
    });
    await def.handler('', ctx);
    assert.ok(factory, 'the overlay opens');
    return openComponent(factory, host);
  }

  test('o opens the focused document through $VISUAL and stays silent on success', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
    const prevVisual = process.env.VISUAL;
    const prevEditor = process.env.EDITOR;
    process.env.VISUAL = 'true';
    delete process.env.EDITOR;
    try {
      const { component, done } = await openOdd(root);
      component.handleInput('o');
      await tick();
      await tick();
      assert.equal(done(), 'pending', 'a successful open keeps the view open');
      assert.ok(!clean(component.render(100).join('\n')).includes('open failed'), 'no error on success');
    } finally {
      if (prevVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = prevVisual;
      if (prevEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = prevEditor;
    }
  });

  test('o with no editor configured reports the honest miss in the view', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
    const prevVisual = process.env.VISUAL;
    const prevEditor = process.env.EDITOR;
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    try {
      const { component, done } = await openOdd(root);
      component.handleInput('o');
      await tick();
      await tick();
      assert.equal(done(), 'pending', 'the miss keeps the view open');
      assert.match(clean(component.render(100).join('\n')), /no editor configured/, 'the honest miss names itself');
      assert.match(clean(component.render(100).join('\n')), /\$VISUAL/, 'the miss names the variable to set');
    } finally {
      if (prevVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = prevVisual;
      if (prevEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = prevEditor;
    }
  });
});
