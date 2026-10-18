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

  test('a checkout without odd documents still opens the view with its empty state', async () => {
    const { commands, mod } = await loadExtension();
    const def = commands.get('herdr-gentle:odd');
    const root = makeRepo({ docs: {} });
    mod.setOddTuiLoader(async () => stubTui);
    const host = makeHostTui(12);
    const { ctx, customs, notes } = makeCtx({ cwd: root, customImpl: async () => null });
    await def.handler('', ctx);
    assert.equal(customs.length, 1);
    const { component } = openComponent(customs[0][0], host);
    const body = component.render(80).join('\n');
    assert.match(body, /0 documents/);
    assert.match(body, /no odd documents/);
    assert.deepEqual(notes, []);
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
    const { ctx, customs, selects, notes } = makeCtx({
      cwd: root,
      selectImpl: (title, options) => { picked = [title, options]; return 'alpha'; },
    });
    await def.handler('', ctx);
    assert.equal(customs.length, 0);
    assert.equal(selects.length >= 1, true, 'the fallback asks the host to select');
    assert.ok(picked[1].includes('alpha'), 'the fallback lists the document names');
    assert.equal(notes.length, 1, 'the fallback names the file it would show');
    assert.match(notes[0][0], /odd\/tasks\/alpha\.md/);
  });
});
