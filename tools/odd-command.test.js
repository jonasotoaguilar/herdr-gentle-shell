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

const { test, describe, before, after } = require('node:test');
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
  // Declared oldest first: each later document gets a newer explicit mtime, so
  // the newest-first rule (S10) yields a deterministic order instead of one that
  // depends on how fast the filesystem stamps two consecutive writes.
  const base = Date.now() - 60 * 60 * 1000;
  let age = 0;
  for (const [name, content] of Object.entries(docs)) {
    const target = path.join(root, 'odd', 'tasks', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const stamp = new Date(base + age++ * 60 * 1000);
    fs.utimesSync(target, stamp, stamp);
  }
  return root;
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

// Every test in this file runs against an isolated worktree-mode directory: a
// missing mode file means enabled, so the assignment tests never read the
// user's real flag (which may be disabled) and never write to it. The S29
// block overrides this per test with its own isolated directory.
before(() => {
  process.env.GENTLE_STATUS_STATE_DIR = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-odd-mode-iso-')));
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
        'beta.md': '# beta\n\n## Tasks\nT1 | S1 | done | a row\n',
        'alpha.md': '# alpha\n\n## Specs\nS1. first rule\n',
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

  test('outside a Git checkout it notifies the one shared line and opens nothing', async () => {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    const outside = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-odd-plain-'))));
    mod.setOddTuiLoader(async () => stubTui);
    const { ctx, customs, selects, notes } = makeCtx({ cwd: outside, customImpl: async () => null });
    await def.handler('', ctx);
    assert.equal(customs.length, 0, 'no overlay outside a checkout');
    assert.equal(selects.length, 0, 'no fallback selector outside a checkout');
    assert.deepEqual(
      notes,
      [[`not a git repository: ${outside}; run 'git init' first`, 'info']],
      'exactly the one shared line at info',
    );
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

// S10b: the odd viewer no longer associates a checkout with documents. These
// drive the public command end to end: the frame never shows an association
// and the removed keys (`space`, list `ctrl+s`) never write, even though the
// command still supplies the old `assigned`/`saveAssignment` options.
describe('/herdr-gentle:odd read-only association (S10b)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

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

  // S8: the registry stores ONE odd path or `null`, never a list.
  function storedRow(root, odd) {
    return { branch: branchOf(root), path: root, thread: 'test-thread', issues: [], odd };
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
    const { component, done } = openComponent(factory, host);
    return { component, notes, done };
  }

  // The list rows are the cells between the left border and the divider; the
  // title icon (`✎`) and the legend separators (`·`) live outside them.
  const listRows = (body) => body.split('\n').filter((line) => /│ [▸ ] (alpha|beta)( |$)/.test(line));

  test('renders no association mark, hint or unsaved claim even with a stored odd', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    writeRegistry(root, [storedRow(root, 'odd/tasks/alpha.md')]);
    const { component, notes } = await openOdd(root);
    const body = clean(component.render(220).join('\n'));
    const rows = listRows(body);
    assert.equal(rows.length, 2, 'both documents still list');
    assert.ok(rows.every((line) => !/[✓✎]/.test(line)), 'no association mark on any row');
    assert.match(rows[0], /│ ▸ (alpha|beta)( |$)/, 'the focused row renders unmarked');
    assert.ok(!body.includes('assigned'), 'no assigned count is claimed');
    assert.ok(!body.includes('unsaved'), 'no unsaved claim exists');
    assert.ok(!body.includes('space toggle'), 'the space toggle leaves the legend');
    assert.ok(!body.includes('ctrl+s'), 'the save key leaves the legend');
    assert.match(body, /shift\+j\/k scroll/, 'the reading legend names the effective fallback');
    assert.match(body, /› Search /, 'the search row names the filter alone, with no key above (S4)');
    assert.ok(!/› Search \(T\)/.test(body), 'the search row never carries the (T) key hint (S4)');
    assert.match(body, /T search/, 'the filter key lives in the footer instead (S4)');
    assert.ok(!/T filter/.test(body), 'the footer never repeats the search hint (S13)');
    assert.match(body, /o open/, 'the open legend stays');
    assert.match(body, /esc close/, 'the close legend stays');
    assert.deepEqual(notes, [], 'reading writes nothing and notifies nothing');
  });

  test('the stored odd changes no cell: the frame matches a row with odd null', async () => {
    const withOdd = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    writeRegistry(withOdd, [storedRow(withOdd, 'odd/tasks/alpha.md')]);
    const withoutOdd = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    writeRegistry(withoutOdd, [storedRow(withoutOdd, null)]);
    const first = await openOdd(withOdd);
    const second = await openOdd(withoutOdd);
    assert.equal(
      clean(first.component.render(100).join('\n')),
      clean(second.component.render(100).join('\n')),
      'the stored association renders nothing in either direction',
    );
  });

  test('space and list ctrl+s leave the registry bytes unchanged', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n', 'beta.md': '# beta\n' } });
    const file = writeRegistry(root, [storedRow(root, 'odd/tasks/alpha.md')]);
    const before = readRaw(file);
    const { component } = await openOdd(root);
    component.handleInput('down');
    assert.equal(component.state.index, 1, 'navigation still works');
    component.handleInput('space');
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(readRaw(file), before, 'the removed keys write nothing to the registry');
  });

  test('with no registry at all, space and ctrl+s create nothing', async () => {
    const root = makeRepo({ docs: { 'alpha.md': '# alpha\n' } });
    const file = registryFile(root);
    assert.ok(!fs.existsSync(file), 'the fixture starts with no registry');
    const { component } = await openOdd(root);
    component.handleInput('space');
    component.handleInput('ctrl+s');
    await tick();
    assert.equal(fs.existsSync(file), false, 'no registry row is created by the removed keys');
  });

  test('the viewer still reads, filters, scrolls and closes with a stored odd', async () => {
    const long = ['# alpha', ...Array.from({ length: 60 }, (_, index) => `line ${index + 1}`)].join('\n');
    const longBeta = ['# beta', ...Array.from({ length: 60 }, (_, index) => `beta line ${index + 1}`)].join('\n');
    const root = makeRepo({ docs: { 'alpha.md': `${long}\n`, 'beta.md': `${longBeta}\n` } });
    writeRegistry(root, [storedRow(root, 'odd/tasks/alpha.md')]);
    const { component, notes, done } = await openOdd(root);
    component.handleInput('ctrl+shift+j');
    assert.ok(component.state.scroll > 0, 'the preview still scrolls');
    component.handleInput('T');
    component.handleInput('b');
    component.handleInput('enter');
    let body = clean(component.render(100).join('\n'));
    assert.ok(!listRows(body).some((line) => line.includes('alpha')), 'the filter still narrows the list');
    assert.ok(listRows(body).some((line) => line.includes('beta')), 'the match stays listed');
    component.handleInput('/');
    component.handleInput('\x7f');
    component.handleInput('enter');
    body = clean(component.render(100).join('\n'));
    assert.equal(listRows(body).length, 2, 'the filter still clears');
    assert.equal(component.state.index, 0, 'navigation is untouched');
    component.handleInput('escape');
    assert.equal(done(), null, 'esc still closes with a null result');
    assert.deepEqual(notes, [], 'reading and closing notify nothing');
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

// ---------------------------------------------------------------------------
// S29: `/herdr-gentle:odd` stays registered while the worktree mode is off or
// malformed; only the worktree association is disabled. This file covers the
// extension seam (mode read plus refuse-to-save); the view-side hiding of the
// association marks, hints and keys is asserted in tools/odd-view.test.js.
// ---------------------------------------------------------------------------
describe('/herdr-gentle:odd assignment mode gate (S29)', () => {
  const modeLib = require('../lib/worktree-mode.js');
  const S29_REFUSAL = 'worktree tools are disabled; enable them in /herdr-gentle:customize to assign issues or odd documents';

  function modeDir() {
    return track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-odd-mode-')));
  }

  async function withModeDir(run, { malformed = false } = {}) {
    const dir = modeDir();
    const saved = { ...process.env };
    process.env.GENTLE_STATUS_STATE_DIR = dir;
    try {
      if (malformed) fs.writeFileSync(modeLib.modePath(process.env), 'not json\n');
      // Await inside the try so the isolated dir is still in effect while the
      // async handler runs; restoring first let the mode read ambient state.
      return await run();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    }
  }

  function oddRegistryFile(root) {
    const common = git(root, ['rev-parse', '--git-common-dir']).trim();
    const dir = path.isAbsolute(common) ? common : path.resolve(root, common);
    return path.join(dir, 'pi-worktrees.json');
  }

  function captureOddView() {
    const lib = require('../lib/odd-view.js');
    const original = lib.createOddView;
    const holder = { options: null };
    lib.createOddView = (options) => {
      holder.options = options;
      return { render: () => [], handleInput: () => {}, invalidate: () => {} };
    };
    return { holder, restore: () => { lib.createOddView = original; } };
  }

  async function openOdd(root) {
    const { commands, mod } = await loadExtension();
    mod.setOddTuiLoader(async () => stubTui);
    const { ctx } = makeCtx({
      cwd: root,
      customImpl: async (factory) => {
        factory(makeHostTui(20).tui, {}, {}, () => {});
        return null;
      },
    });
    await commands.get('herdr-gentle:odd').handler('', ctx);
    return commands;
  }

  test('mode off: the command exists, assignmentEnabled is false and the callback refuses with zero writes', async () => {
    await withModeDir(async () => {
      modeLib.writeMode(false, process.env);
      const capture = captureOddView();
      try {
        const root = makeRepo({ docs: { 'a.md': '# a\n\n## Specs\nS1. one rule\n' }, tag: 'odd-s29-off' });
        const file = oddRegistryFile(root);
        const commands = await openOdd(root);
        assert.ok(commands.has('herdr-gentle:odd'), 'the command stays registered while the mode is off');
        assert.ok(capture.holder.options, 'the view was constructed');
        assert.equal(capture.holder.options.assignmentEnabled, false, 'the disabled mode travels to the view');
        const result = await capture.holder.options.saveAssignment(['odd/tasks/a.md']);
        assert.deepEqual(result, { ok: false, error: S29_REFUSAL }, 'the refusal is honest and exact');
        assert.equal(fs.existsSync(file), false, 'a refused save writes no registry');
      } finally {
        capture.restore();
      }
    });
  });

  test('malformed mode: assignmentEnabled is false and the callback refuses', async () => {
    await withModeDir(async () => {
      const capture = captureOddView();
      try {
        const root = makeRepo({ docs: { 'a.md': '# a\n' }, tag: 'odd-s29-malformed' });
        const file = oddRegistryFile(root);
        const commands = await openOdd(root);
        assert.ok(commands.has('herdr-gentle:odd'));
        assert.equal(capture.holder.options.assignmentEnabled, false, 'a malformed mode never enables assignment');
        const result = await capture.holder.options.saveAssignment(['odd/tasks/a.md']);
        assert.deepEqual(result, { ok: false, error: S29_REFUSAL });
        assert.equal(fs.existsSync(file), false, 'a malformed mode never writes');
      } finally {
        capture.restore();
      }
    }, { malformed: true });
  });

  test('mode switched off after opening: the callback re-reads and refuses', async () => {
    await withModeDir(async () => {
      modeLib.writeMode(true, process.env);
      const capture = captureOddView();
      try {
        const root = makeRepo({ docs: { 'a.md': '# a\n' }, tag: 'odd-s29-switched' });
        const file = oddRegistryFile(root);
        await openOdd(root);
        assert.equal(capture.holder.options.assignmentEnabled, true, 'the enabled mode opened normally');
        modeLib.writeMode(false, process.env);
        const result = await capture.holder.options.saveAssignment(['odd/tasks/a.md']);
        assert.deepEqual(result, { ok: false, error: S29_REFUSAL }, 'the callback re-reads the mode, not the snapshot');
        assert.equal(fs.existsSync(file), false, 'the registry is untouched');
      } finally {
        capture.restore();
      }
    });
  });

  test('enabled mode: assignmentEnabled stays true (regression)', async () => {
    await withModeDir(async () => {
      // Explicit, not inferred: a missing file also means enabled, but the
      // test names the enabled state it exercises.
      modeLib.writeMode(true, process.env);
      const capture = captureOddView();
      try {
        const root = makeRepo({ docs: { 'a.md': '# a\n' }, tag: 'odd-s29-on' });
        await openOdd(root);
        assert.equal(capture.holder.options.assignmentEnabled, true, 'the enabled mode passes true');
      } finally {
        capture.restore();
      }
    });
  });
});
