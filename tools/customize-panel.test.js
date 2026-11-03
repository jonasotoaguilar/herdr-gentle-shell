'use strict';
// T1 (customize-command S1,S2,S3,S5,S6,S10,S12) tests: the
// `/herdr-gentle:customize` command in extensions/gentle-worktree-tools.ts.
//
// Contract under test (observable behavior only — the select/custom calls,
// the exact notified text, the mode file bytes, and whether ctx.reload was
// called; never internal function names):
// - registered unconditionally next to /herdr-gentle:warp (the three old
//   commands are gone — S7);
// - no argument opens the two-pane panel through ctx.ui.custom with the
//   exact overlay options, and writes nothing until Enter;
// - Esc closes with zero writes;
// - worktree Disabled writes the mode file and reloads per the
//   registration predicate (enabled !== toolsRegistered), while Enabled
//   while already registered does not reload;
// - sidebar/moshi choices reach the provider slot with the right value and
//   reload exactly when the provider said so;
// - a missing or malformed provider renders the category unavailable and
//   Enter on it writes nothing;
// - `customize status` prints the fixed one-line-per-switch summary and
//   writes nothing;
// - when the TUI helpers cannot be loaded (or ctx.ui.custom is missing)
//   the panel falls back to the plain ctx.ui.select menu and says nothing
//   about /reload.
//
// Loading pattern mirrors tools/worktree-mode-command.test.js: the
// TypeScript extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with the
// package import lines stubbed and import()s it with a fake `pi` object.

const { test, describe, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

const SLOT_KEY = 'herdr-gentle.customize.v1';
function slotLiteral() {
  return `Symbol.for("${SLOT_KEY}")`;
}

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

function scratchStateEnv() {
  // A scratch agent dir too: the moshi exclusion and the whole panel write
  // under Pi's agent home, and no test may touch the real one.
  return {
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-state-'))),
    GENTLE_PI_AGENT_HOME: undefined,
    PI_CODING_AGENT_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-agent-'))),
  };
}

function modeLib() {
  return require('../lib/worktree-mode.js');
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-ext-')));
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

function customizeDef(commands) {
  const def = commands.get('herdr-gentle:customize');
  assert.ok(def, 'expected the herdr-gentle:customize command to be registered');
  assert.equal(typeof def.handler, 'function');
  return def;
}

// Stub TUI helpers: the shape S10 names (measure/truncate/match/release).
// Raw input arrives as plain strings in tests ("escape", "enter",
// "up", "down", ...); "release" models a Kitty key-release event.
const stubTui = {
  visibleWidth: (s) => [...String(s)].length,
  truncateToWidth: (s, w) => {
    const chars = [...String(s)];
    return chars.length > w ? chars.slice(0, w).join('') : String(s);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

function installTuiLoader(mod, loader) {
  assert.equal(typeof mod.setCustomizeTuiLoader, 'function', 'expected the injectable TUI loader seam');
  mod.setCustomizeTuiLoader(loader);
}

// Command context. reload/notify order is recorded in seq so tests pin the
// mandatory ordering (panel closed, then notify, then reload).
function makeCtx({ customImpl, selectImpl } = {}) {
  const notes = [];
  const selects = [];
  const customs = [];
  const seq = [];
  const ctx = {
    ui: {
      notify: (message, level) => { notes.push([message, level]); seq.push(`notify:${message}`); },
      select: async (title, options) => {
        selects.push([title, options]);
        if (typeof selectImpl === 'function') return selectImpl(title, options);
        return selectImpl;
      },
    },
    reload: async () => { seq.push('reload'); },
  };
  if (customImpl !== undefined) {
    ctx.ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  return { ctx, notes, selects, customs, seq };
}

// Fake host TUI: only requestRender() is observable from the panel.
function makeHostTui() {
  const paints = [];
  return {
    paints,
    tui: { requestRender: () => { paints.push(true); } },
  };
}

function failAfter(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

// Open the component through the REAL host factory signature
// (hostTui, theme, keybindings, done) and assert its shape: the host
// delivers keystrokes through handleInput and finishes through done.
function openComponent(factory, host) {
  let settled = 'pending';
  const component = factory(host.tui, {}, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function', 'component must implement render(width)');
  assert.equal(typeof component.handleInput, 'function', 'component must implement handleInput(data)');
  assert.equal(typeof component.invalidate, 'function', 'component must implement invalidate()');
  return { component, done: () => settled };
}

// Feed raw input bytes; the done() value is what ctx.ui.custom() resolves
// with. A component that never calls done() fails fast instead of hanging
// the suite the way the real host would hang the command.
async function driveContract(factory, host, inputs) {
  const { component, done } = openComponent(factory, host);
  for (const input of inputs) component.handleInput(input);
  if (done() === 'pending') {
    await Promise.race([
      (async () => { while (done() === 'pending') await new Promise((r) => setTimeout(r, 10)); })(),
      failAfter(1000, 'done() was never called: ctx.ui.custom() would hang with the overlay owning input'),
    ]);
  }
  return { component, result: done() };
}

function setSlot(slot) {
  const key = Symbol.for(SLOT_KEY);
  const had = Object.hasOwn(globalThis, key) ? globalThis[key] : undefined;
  if (slot === undefined) delete globalThis[key];
  else globalThis[key] = slot;
  return had;
}

function stubSlot({ sidebarRead = 'gentle', moshiRead = 'off', applyImpl } = {}) {
  const applied = [];
  const slot = {
    sidebar: {
      read: () => sidebarRead,
      apply: async (value, ctx) => {
        applied.push(['sidebar', value]);
        if (typeof applyImpl === 'function') return applyImpl('sidebar', value, ctx);
        return { changed: true, needsReload: false, text: `sidebar ${value}` };
      },
    },
    moshi: {
      read: () => moshiRead,
      apply: async (value, ctx) => {
        applied.push(['moshi', value]);
        if (typeof applyImpl === 'function') return applyImpl('moshi', value, ctx);
        return { changed: true, needsReload: false, text: `moshi ${value}` };
      },
    },
  };
  return { slot, applied };
}

function modeBytes() {
  try {
    return fs.readFileSync(modeLib().modePath(process.env), 'utf8');
  } catch {
    return null;
  }
}

function pluginToolsBytes() {
  try {
    return fs.readFileSync(modeLib().pluginToolsPath(process.env), 'utf8');
  } catch {
    return null;
  }
}

describe('customize command registration', { concurrency: false }, () => {
  test('the command is registered under the exact name while enabled', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:customize'), `exact name, got ${JSON.stringify([...commands.keys()])}`);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('the command is registered unconditionally while disabled', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(false, process.env);
      const { commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:customize'), 'the panel must exist even while the tools are unregistered');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('the old toggles are gone and the removed worktree command never registers', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { commands } = await loadExtension();
      // S1/S5: `/herdr-gentle:worktree` was the mode-toggle command for the
      // association editor. Worktrees carry no association any more, and the
      // association editor, the full-screen detail and the delete view were
      // removed with it (S4), so nothing registers that name.
      assert.ok(!commands.has('herdr-gentle:worktree'),
        `the removed command never registers, got ${JSON.stringify([...commands.keys()])}`);
      // The old mode verbs stay dead: the surviving customize command refuses
      // them and leaves the mode file byte-identical, so a disabled mode can
      // never be flipped from a toggle verb.
      const modeBefore = modeBytes();
      const { ctx: detailCtx, notes: detailNotes } = makeCtx();
      await customizeDef(commands).handler('enabled', detailCtx);
      assert.deepEqual(detailNotes, [['Unknown option "enabled". Use /herdr-gentle:customize or /herdr-gentle:customize status.', 'error']], 'the removed toggle verbs are refused');
      assert.equal(modeBytes(), modeBefore, 'a toggle verb never writes the mode');
      assert.ok(commands.has('herdr-gentle:warp'), 'warp stays registered');
      assert.ok(commands.has('herdr-gentle:customize'), 'customize stays registered');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('both extensions carry the identical provider slot literal (drift guard)', async () => {
    const worktreeSrc = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts'), 'utf8');
    const stateSrc = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-herdr-state.ts'), 'utf8');
    assert.ok(worktreeSrc.includes(slotLiteral()), 'worktree extension must read the exact slot key');
    assert.ok(stateSrc.includes(slotLiteral()), 'state extension must write the exact slot key');
  });
});

describe('customize panel', { concurrency: false }, () => {
  test('no argument opens the two-pane panel with the exact overlay options and writes nothing until Enter', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, notes, customs, seq } = makeCtx({
        customImpl: async () => {},
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      assert.deepEqual(customs[0][1], {
        overlay: true,
        overlayOptions: { anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' },
      });
      // The factory was captured but never driven: nothing applied.
      assert.equal(applied.length, 0, 'opening the panel must not reach any provider');
      assert.equal(modeBytes(), before, 'opening the panel must not touch the mode file');
      assert.equal(notes.length, 0, 'opening the panel notifies nothing');
      assert.ok(!seq.includes('reload'), 'opening the panel never reloads');
      // The captured factory renders the fixed copy: the left pane lists
      // all three switches, the right pane the focused category's rows.
      // The factory receives the host arguments (tui, theme, keybindings,
      // done) per the host contract.
      const host = makeHostTui();
      const { component, done } = openComponent(customs[0][0], host);
      const seen = () => component.render(100).join('\n');
      for (const copy of [
        'Customize · Herdr Gentle Shell',
        'CATEGORIES',
        'Herdr Sidebar',
        'Moshi notifications',
        'Plugin tools',
        'Gentle (this extension)',
        'publishes agent state and SessionChanges from Gentle',
        'Native Herdr',
        'Preview · Gentle (this extension)',
        '←/→ or Tab panes · ↑/↓ or j/k move · Enter apply · Esc close',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      assert.ok(seen().includes('→'), 'the active row carries the → marker');
      component.handleInput('down');
      for (const copy of [
        'Moshi notifications',
        'On',
        'Off',
        'leaves notifications to the host',
        'Preview · Off',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      component.handleInput('down');
      // The grouped Plugin tools section carries the three independent
      // toggles, each row naming its own stored state.
      for (const copy of [
        'Plugin tools',
        'Worktree tools · Enabled',
        'ODD command · Enabled',
        'Issues command · Enabled',
        'agents can create, list, close, warp between and open sessions in agent worktrees',
        'Preview · Worktree tools',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      assert.equal(done(), 'pending', 'movement keys never finish the overlay');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('Esc closes with zero writes', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => (await driveContract(factory, host, ['escape'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(applied.length, 0, 'Esc must not reach any provider');
      assert.equal(modeBytes(), before, 'Esc must not touch the mode file');
      assert.equal(notes.length, 0, 'Esc notifies nothing');
      assert.ok(!seq.includes('reload'), 'Esc never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('Esc resolves done() with null: no notification, no write, no reload', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { result } = await driveContract(factory, host, ['escape']);
          assert.equal(result, null, 'Esc finishes the overlay with null');
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'Esc writes nothing');
      assert.equal(notes.length, 0, 'Esc notifies nothing');
      assert.ok(!seq.includes('reload'), 'Esc never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a movement key repaints and moves the cursor without finishing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component, done } = openComponent(factory, host);
          const first = component.render(100).join('\n');
          assert.ok(first.includes('▸ Herdr Sidebar'), 'cursor starts on the first category');
          component.handleInput('down');
          assert.equal(host.paints.length, 1, 'a selection change requests a repaint');
          const second = component.render(100).join('\n');
          assert.ok(second.includes('▸ Moshi notifications'), 'the cursor moved');
          assert.equal(done(), 'pending', 'movement never finishes the overlay');
          component.handleInput('escape');
          assert.equal(done(), null);
          return done();
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'navigation writes nothing');
      assert.equal(notes.length, 0, 'navigation notifies nothing');
      assert.ok(!seq.includes('reload'), 'navigation never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a key-release event changes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component, done } = openComponent(factory, host);
          const first = component.render(100).join('\n');
          component.handleInput('release');
          assert.equal(host.paints.length, 0, 'a release requests no repaint');
          assert.equal(component.render(100).join('\n'), first, 'a release moves nothing');
          assert.equal(done(), 'pending', 'a release never finishes the overlay');
          component.handleInput('escape');
          return done();
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'a release writes nothing');
      assert.equal(notes.length, 0, 'a release notifies nothing');
      assert.ok(!seq.includes('reload'), 'a release never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('flipping Worktree tools off writes the mode file and reloads after notify when the tools are registered', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        // sidebar -> moshi -> Plugin tools, values pane on the worktree row.
        customImpl: async (factory, options) => {
          assert.deepEqual(options.overlayOptions, { anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' });
          const { result } = await driveContract(factory, host, ['down', 'down', 'right', 'enter']);
          assert.deepEqual(result, { categoryId: 'plugin-tools', valueId: 'worktree' }, 'Enter resolves done() with the toggle');
          assert.equal(modeBytes(), '{"version":1,"enabled":true}\n', 'nothing is written while the overlay is still up');
          assert.equal(notes.length, 0, 'nothing is notified while the overlay is still up');
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(modeBytes(), '{"version":1,"enabled":false}\n', 'the flip writes the legacy mode file');
      assert.equal(notes.length, 1, 'exactly one notification');
      assert.equal(notes[0][0], 'Worktree tools disabled. Reloading now to apply the change.');
      assert.ok(!notes[0][0].includes('/reload'), 'the panel never asks the user to run /reload');
      assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload'], 'notify runs before the reload');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('flipping ODD command writes only its own key of the plugin tools file and reloads', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      modeLib().writePluginTools({ odd: true, issues: true }, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        // Plugin tools values pane: worktree, then ODD.
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'down', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(modeBytes(), before, 'the legacy worktree flag is untouched');
      assert.equal(pluginToolsBytes(), '{"version":1,"odd":false,"issues":true}\n', 'only the ODD key flipped');
      assert.equal(notes[0][0], 'ODD command disabled. Reloading now to apply the change.');
      assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload']);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('flipping Issues command leaves the ODD value alone', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      modeLib().writePluginTools({ odd: false, issues: true }, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes } = makeCtx({
        // Plugin tools values pane, third row = Issues command.
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'down', 'down', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(pluginToolsBytes(), '{"version":1,"odd":false,"issues":false}\n', 'the ODD value is preserved');
      assert.equal(notes[0][0], 'Issues command disabled. Reloading now to apply the change.');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a flip that lands on the runtime registration writes the file but does not reload', async () => {
    // Loaded with ODD disabled, so the runtime registered no ODD command; the
    // stored flag is then flipped out of band. The panel's flip back to
    // Disabled matches the runtime, so no rebuild is needed.
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      modeLib().writePluginTools({ odd: false, issues: true }, process.env);
      const { commands, mod } = await loadExtension();
      modeLib().writePluginTools({ odd: true, issues: true }, process.env);
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'down', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(pluginToolsBytes(), '{"version":1,"odd":false,"issues":true}\n', 'the file is written');
      assert.equal(notes[0][0], 'ODD command disabled.');
      assert.ok(!seq.includes('reload'), 'a registration that already matches needs no reload');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('either direction reloads when the runtime registration must change', async () => {
    // Carried over from the removed mode-command suite: the
    // `enabled !== runtime registration` predicate in both directions.
    for (const loaded of ['enabled', 'disabled']) {
      const modeEnv = scratchStateEnv();
      setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
      const { slot } = stubSlot();
      const hadSlot = setSlot(slot);
      try {
        modeLib().writeMode(loaded === 'enabled', process.env);
        const { commands, mod } = await loadExtension();
        installTuiLoader(mod, async () => stubTui);
        const host = makeHostTui();
        const { ctx, notes, seq } = makeCtx({
          customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'enter'])).result,
        });
        await customizeDef(commands).handler('', ctx);
        assert.equal(
          modeBytes(),
          loaded === 'enabled' ? '{"version":1,"enabled":false}\n' : '{"version":1,"enabled":true}\n',
          'the flip writes the mode file either way',
        );
        assert.equal(notes.length, 1);
        assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload'], 'a registration change reloads after notify');
      } finally {
        setSlot(hadSlot);
        restoreEnv();
      }
    }
  });

  test('a sidebar choice reaches the provider with the right value and reloads exactly when the provider said so', async () => {
    for (const needsReload of [true, false]) {
      const modeEnv = scratchStateEnv();
      setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
      const { slot, applied } = stubSlot({
        sidebarRead: 'gentle',
        applyImpl: () => ({ changed: true, needsReload, text: 'Gentle sidebar disabled (native renders again).' }),
      });
      const hadSlot = setSlot(slot);
      try {
        modeLib().writeMode(true, process.env);
        const before = modeBytes();
        const { commands, mod } = await loadExtension();
        installTuiLoader(mod, async () => stubTui);
        const host = makeHostTui();
        const { ctx, notes, seq } = makeCtx({
          // sidebar values pane, down to Native Herdr, Enter.
          customImpl: async (factory) => (await driveContract(factory, host, ['right', 'down', 'enter'])).result,
        });
        await customizeDef(commands).handler('', ctx);
        assert.deepEqual(applied, [['sidebar', 'native']], 'the provider gets the chosen value id');
        assert.equal(modeBytes(), before, 'a sidebar choice never touches the worktree mode file');
        assert.equal(notes.length, 1);
        assert.ok(!notes[0][0].includes('/reload'), 'no /reload instruction');
        if (needsReload) {
          assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload'], 'provider needsReload reloads after notify');
        } else {
          assert.ok(!seq.includes('reload'), 'provider needsReload:false never reloads');
        }
      } finally {
        setSlot(hadSlot);
        restoreEnv();
      }
    }
  });

  test('a moshi choice reaches the provider with the right value', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot({
      moshiRead: 'off',
      applyImpl: () => ({ changed: true, needsReload: false, text: 'Moshi notifications enabled.' }),
    });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        // moshi values pane, up to On, Enter.
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'right', 'up', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.deepEqual(applied, [['moshi', 'on']], 'the provider gets the chosen value id');
      assert.equal(modeBytes(), before, 'a moshi choice never touches the worktree mode file');
      assert.equal(notes.length, 1);
      assert.ok(!seq.includes('reload'), 'needsReload:false never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a missing provider renders the category unavailable and Enter on it writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component } = openComponent(factory, host);
          const lines = component.render(100).join('\n');
          assert.ok(lines.toLowerCase().includes('unavailable'), 'missing provider renders unavailable');
          const { result } = await driveContract(factory, host, ['right', 'down', 'enter']);
          assert.deepEqual(result, { categoryId: 'sidebar', valueId: 'native' });
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'Enter on an unavailable category writes nothing');
      assert.ok(!seq.includes('reload'), 'Enter on an unavailable category never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a malformed provider renders the category unavailable and cannot write', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const applied = [];
    const hadSlot = setSlot({ sidebar: null, moshi: { read: () => { throw new Error('broken'); } } });
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component } = openComponent(factory, host);
          const lines = component.render(100).join('\n');
          assert.ok(lines.toLowerCase().includes('unavailable'), 'malformed provider renders unavailable');
          const { result } = await driveContract(factory, host, ['down', 'right', 'enter']);
          assert.deepEqual(result, { categoryId: 'moshi', valueId: 'on' });
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.deepEqual(applied, [], 'a malformed provider is never called');
      assert.equal(modeBytes(), before, 'Enter on an unavailable category writes nothing');
      assert.ok(!seq.includes('reload'), 'Enter on an unavailable category never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('customize status prints the fixed line and writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands } = await loadExtension();
      const { ctx, notes, seq } = makeCtx();
      await customizeDef(commands).handler('status', ctx);
      assert.equal(notes.length, 1);
      assert.equal(notes[0][0], 'customize status: sidebar=gentle moshi=off worktree=enabled odd=enabled issues=enabled');
      assert.equal(modeBytes(), before, 'status writes nothing');
      assert.ok(!seq.includes('reload'), 'status never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('an unknown argument prints usage and writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands } = await loadExtension();
      const { ctx, notes, seq } = makeCtx();
      await customizeDef(commands).handler('frobnicate', ctx);
      assert.equal(notes.length, 1);
      assert.match(notes[0][0], /status/, 'usage names the status verb');
      assert.equal(modeBytes(), before, 'usage writes nothing');
      assert.ok(!seq.includes('reload'), 'usage never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('customize fallback menu', { concurrency: false }, () => {
  test('falls back to ctx.ui.select when the TUI helpers cannot be loaded', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no such module'); });
      const answers = ['Plugin tools', 'Worktree tools · Enabled'];
      const { ctx, notes, selects, customs, seq } = makeCtx({
        customImpl: async () => { throw new Error('custom must not be called without helpers'); },
        selectImpl: () => answers.shift(),
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 0, 'no custom panel without helpers');
      assert.equal(selects.length, 2, 'category then value');
      assert.equal(modeBytes(), '{"version":1,"enabled":false}\n', 'the fallback writes through the same path');
      assert.equal(notes.length, 1);
      assert.ok(!notes[0][0].includes('/reload'), 'the fallback says nothing about /reload');
      assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload']);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('falls back to ctx.ui.select when ctx.ui.custom is missing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot({
      moshiRead: 'off',
      applyImpl: () => ({ changed: true, needsReload: false, text: 'Moshi notifications enabled.' }),
    });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const answers = ['Moshi notifications', 'On'];
      const { ctx, notes, selects, seq } = makeCtx({
        selectImpl: () => answers.shift(),
      });
      assert.equal(typeof ctx.ui.custom, 'undefined', 'precondition: no custom surface');
      await customizeDef(commands).handler('', ctx);
      assert.equal(selects.length, 2, 'category then value');
      assert.deepEqual(applied, [['moshi', 'on']], 'the fallback reaches the provider with the value id');
      assert.equal(modeBytes(), before, 'a moshi choice never touches the mode file');
      assert.equal(notes.length, 1);
      assert.ok(!notes[0][0].includes('/reload'), 'the fallback says nothing about /reload');
      assert.ok(!seq.includes('reload'), 'needsReload:false never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('cancelling the fallback selector writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no such module'); });
      const { ctx, notes, seq } = makeCtx({ selectImpl: () => undefined });
      await customizeDef(commands).handler('', ctx);
      assert.deepEqual(applied, [], 'cancel reaches no provider');
      assert.equal(modeBytes(), before, 'cancel writes nothing');
      assert.equal(notes.length, 0, 'cancel notifies nothing');
      assert.ok(!seq.includes('reload'), 'cancel never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// The grouped "Plugin tools" section: one category with THREE independent
// toggles — Worktree tools, ODD command, Issues command. Each toggle persists
// on its own (the worktree flag keeps its legacy file and bytes; ODD and Issues
// share one file with their own keys), flips on Enter, and reloads only when the
// runtime's own registration must change. A runtime that could not be reloaded
// still refuses the invocation, so a toggle never silently keeps working.
// ---------------------------------------------------------------------------
describe('customize Plugin tools section', { concurrency: false }, () => {
  async function openPluginPanel() {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      const opened = openComponent(customs[0][0], makeHostTui());
      return { ...opened, cleanup: () => { setSlot(hadSlot); restoreEnv(); } };
    } catch (err) {
      setSlot(hadSlot);
      restoreEnv();
      throw err;
    }
  }

  test('the section lists the three toggles with their stored state', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      modeLib().writePluginTools({ odd: false, issues: true }, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes } = makeCtx({
        customImpl: async (factory) => {
          const { component, done } = openComponent(factory, host);
          component.handleInput('down');
          component.handleInput('down');
          const text = component.render(100).join('\n');
          for (const copy of [
            'Plugin tools',
            'Worktree tools · Enabled',
            'ODD command · Disabled',
            'Issues command · Enabled',
            'Preview · Worktree tools',
          ]) {
            assert.ok(text.includes(copy), `panel copy missing: ${copy}`);
          }
          assert.equal(done(), 'pending');
          component.handleInput('escape');
          return done();
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(notes.length, 0, 'reading the section writes and notifies nothing');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a malformed plugin tools file fails closed: both commands stay unregistered and read Disabled', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      fs.writeFileSync(path.join(process.env.GENTLE_STATUS_STATE_DIR, 'gentle-plugin-tools.json'), '{"version":1,"odd":"yes"}\n');
      const { commands, mod } = await loadExtension();
      assert.ok(!commands.has('herdr-gentle:odd'), 'a malformed file never registers the ODD command');
      assert.ok(!commands.has('herdr-gentle:issues'), 'a malformed file never registers the Issues command');
      assert.ok(commands.has('herdr-gentle:customize'), 'the panel always stays registered');
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx } = makeCtx({
        customImpl: async (factory) => {
          const { component, done } = openComponent(factory, host);
          component.handleInput('down');
          component.handleInput('down');
          const text = component.render(100).join('\n');
          assert.ok(text.includes('ODD command · Disabled'), 'malformed state reads Disabled');
          assert.ok(text.includes('Issues command · Disabled'), 'malformed state reads Disabled');
          component.handleInput('escape');
          return done();
        },
      });
      await customizeDef(commands).handler('', ctx);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('disabling ODD without a reload refuses the invocation and says when it applies', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      // The panel degrades to the plain menu here, and this ctx has no
      // reload: the registration cannot be rebuilt in this session.
      installTuiLoader(mod, async () => { throw new Error('no TUI here'); });
      const answers = ['Plugin tools', 'ODD command · Enabled'];
      const { ctx, notes, seq } = makeCtx({ selectImpl: () => answers.shift() });
      delete ctx.reload;
      await customizeDef(commands).handler('', ctx);
      assert.equal(pluginToolsBytes(), '{"version":1,"odd":false,"issues":true}\n', 'the flip is persisted');
      assert.equal(notes[0][0], 'ODD command disabled. The change applies from the next session.');

      // The stale runtime still holds the command: invoking it must refuse
      // instead of opening the viewer.
      const oddCtx = makeCtx({ customImpl: async () => { throw new Error('the viewer must not open'); } });
      await commands.get('herdr-gentle:odd').handler('', oddCtx.ctx);
      assert.equal(oddCtx.customs.length, 0, 'a disabled command opens nothing');
      assert.deepEqual(
        oddCtx.notes,
        [['odd command is disabled; open /herdr-gentle:customize and apply the Plugin tools ODD command toggle to enable it', 'error']],
      );
      assert.ok(!seq.includes('reload'));
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('disabling the ODD command keeps the automatic capture handlers registered', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      modeLib().writePluginTools({ odd: false, issues: true }, process.env);
      const { commands, handlers } = await loadExtension();
      assert.ok(!commands.has('herdr-gentle:odd'), 'only the command is unregistered');
      assert.ok(Array.isArray(handlers.get('tool_call')) && handlers.get('tool_call').length > 0,
        'the automatic ODD capture keeps observing tool calls');
      assert.ok(Array.isArray(handlers.get('tool_result')) && handlers.get('tool_result').length > 0,
        'the automatic ODD capture keeps observing tool results');
      assert.ok(Array.isArray(handlers.get('session_start')) && handlers.get('session_start').length > 0,
        'unrelated startup work still runs');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('the headless fallback menu reaches the three toggles', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no TUI here'); });
      const answers = ['Plugin tools', 'Worktree tools · Enabled'];
      const { ctx, notes, selects, seq } = makeCtx({ selectImpl: () => answers.shift() });
      await customizeDef(commands).handler('', ctx);
      assert.equal(selects.length, 2, 'category then toggle');
      assert.deepEqual(selects[1][1], [
        'Worktree tools · Enabled',
        'ODD command · Enabled',
        'Issues command · Enabled',
      ], 'the fallback carries the same three toggles');
      assert.equal(modeBytes(), '{"version":1,"enabled":false}\n', 'the fallback writes through the same path');
      assert.equal(notes[0][0], 'Worktree tools disabled. Reloading now to apply the change.');
      assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload']);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('Reset returns ODD and Issues to Enabled through the same writers', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      modeLib().writePluginTools({ odd: false, issues: false }, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no TUI here'); });
      const answers = ['Reset', 'Reset every option to its default'];
      const { ctx, notes } = makeCtx({ selectImpl: () => answers.shift() });
      await customizeDef(commands).handler('', ctx);
      assert.equal(pluginToolsBytes(), '{"version":1,"odd":true,"issues":true}\n', 'both commands return to their default');
      assert.equal(modeBytes(), '{"version":1,"enabled":true}\n', 'the worktree default is unchanged');
      assert.equal(notes[0][0], 'Defaults saved.');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('customize two-column card geometry', { concurrency: false }, () => {
  // RED (T5/S2): the panel must render as one bordered card with two
  // side-by-side panes — categories left, values right of a vertical
  // divider — like the gentle-shell reference, not as stacked flat text.
  // Every assertion below is geometric: row counts, exact line widths,
  // divider column coordinates, and focus movement — never bare copy.
  function stripAnsi(line) {
    return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
  }

  function visible(line) {
    return [...stripAnsi(line)].length;
  }

  async function openPanel({ terminalRows } = {}) {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      const host = makeHostTui();
      if (terminalRows !== undefined) host.tui.terminal = { rows: terminalRows };
      const opened = openComponent(customs[0][0], host);
      return { ...opened, host, cleanup: () => { setSlot(hadSlot); restoreEnv(); } };
    } catch (err) {
      setSlot(hadSlot);
      restoreEnv();
      throw err;
    }
  }

  // Divider column of the two-pane body: every content row that carries
  // a divider carries exactly one │ strictly inside the borders, at the
  // same visible column. Title, preview and footer rows carry none.
  function dividerColumn(lines) {
    const columns = new Set();
    let divided = 0;
    for (const line of lines.slice(1, -1)) {
      const plain = stripAnsi(line);
      if (!plain.startsWith('│') || !plain.endsWith('│')) return null;
      const inner = plain.slice(1, -1);
      const at = [];
      for (let i = 0; i < inner.length; i += 1) {
        if (inner[i] === '│') at.push(i);
      }
      if (at.length > 1) return null;
      if (at.length === 1) {
        divided += 1;
        columns.add(at[0]);
      }
    }
    return divided > 0 && columns.size === 1 ? [...columns][0] : null;
  }

  for (const width of [60, 80, 100]) {
    test(`width ${width}: one bordered card, every row exactly ${width} columns`, async () => {
      const { component, cleanup } = await openPanel();
      try {
        const lines = component.render(width);
        assert.ok(lines.length >= 12, `a card needs room for two panes, got ${lines.length} rows`);
        for (const line of lines) {
          assert.equal(visible(line), width, `row is not ${width} columns: ${JSON.stringify(stripAnsi(line))}`);
        }
        assert.ok(stripAnsi(lines[0]).startsWith('╭') && stripAnsi(lines[0]).endsWith('╮'), 'card opens with a top border');
        const last = stripAnsi(lines[lines.length - 1]);
        assert.ok(last.startsWith('╰') && last.endsWith('╯'), 'card closes with a bottom border');
      } finally {
        cleanup();
      }
    });

    test(`width ${width}: categories left and values right of one stable divider`, async () => {
      const { component, cleanup } = await openPanel();
      try {
        const lines = component.render(width);
        const column = dividerColumn(lines);
        assert.ok(column !== null && column > 10, `expected one stable inner divider column, got ${column}`);
        const body = lines.slice(1, -1).map(stripAnsi);
        const leftOf = (line) => line.slice(1, 1 + column);
        const rightOf = (line) => line.slice(1 + column + 1, -1);
        assert.ok(leftOf(body[1]).includes('CATEGORIES'), 'left heading sits left of the divider');
        assert.ok(rightOf(body[1]).includes('· 1/2'), 'right heading names the category with i/N right of the divider');
        assert.ok(leftOf(body[2]).includes('Herdr Sidebar'), 'first category sits left of the divider');
        assert.ok(rightOf(body[2]).includes('Gentle (this extension)'), 'first value sits right of the divider');
      } finally {
        cleanup();
      }
    });

    test(`width ${width}: title and esc share the top row`, async () => {
      const { component, cleanup } = await openPanel();
      try {
        const top = stripAnsi(component.render(width)[1]);
        assert.ok(top.includes('Customize · Herdr Gentle Shell'), 'title on the top row');
        const inside = top.slice(0, -1).trimEnd();
        assert.ok(inside.endsWith('esc'), 'esc aligned to the top-right of the same row');
        assert.ok(top.indexOf('Customize · Herdr Gentle Shell') < top.indexOf('esc'), 'title stays left of esc');
      } finally {
        cleanup();
      }
    });
  }

  test('input navigation moves the visible focus highlight, not just the model', async () => {
    const { component, cleanup } = await openPanel();
    try {
      const rightFocusRow = (width) => {
        const lines = component.render(width).slice(1, -1).map(stripAnsi);
        const column = dividerColumn(component.render(width));
        assert.ok(column !== null, 'precondition: two panes with a divider');
        for (let i = 0; i < lines.length; i += 1) {
          const right = lines[i].slice(1 + column + 1, -1);
          if (right.includes('▸')) return i;
        }
        return -1;
      };
      component.handleInput('right');
      const before = rightFocusRow(80);
      assert.ok(before >= 0, 'values pane shows a ▸ focus row once focused');
      component.handleInput('down');
      const after = rightFocusRow(80);
      assert.ok(after >= 0 && after !== before, `focus visibly moved from row ${before} to ${after}`);
    } finally {
      cleanup();
    }
  });

  test('narrow width clips to a single navigable pane instead of squeezing two', async () => {
    const { component, cleanup } = await openPanel();
    try {
      const lines = component.render(50);
      for (const line of lines) assert.equal(visible(line), 50, 'every narrow row still fits');
      assert.equal(dividerColumn(lines), null, 'no inner divider in single-pane mode');
      const text = lines.map(stripAnsi).join('\n');
      assert.ok(text.includes('Herdr Sidebar') && text.includes('Plugin tools'), 'categories stay navigable');
    } finally {
      cleanup();
    }
  });

  test('constrained height clips the card to the available rows', async () => {
    const { component, cleanup } = await openPanel({ terminalRows: 12 });
    try {
      const lines = component.render(80);
      assert.equal(lines.length, 12, `card clips to 12 rows, got ${lines.length}`);
      for (const line of lines) assert.equal(visible(line), 80, 'every clipped row still fits');
      assert.ok(stripAnsi(lines[0]).startsWith('╭'), 'clipped card keeps its top border');
      assert.ok(stripAnsi(lines[lines.length - 1]).startsWith('╰'), 'clipped card keeps its bottom border');
    } finally {
      cleanup();
    }
  });

  test('full height keeps the preview section and the footer inside the card', async () => {
    const { component, cleanup } = await openPanel();
    try {
      const text = component.render(80).map(stripAnsi).join('\n');
      assert.ok(text.includes('Preview · Gentle (this extension)'), 'preview names the focused choice');
      assert.ok(text.includes('←/→ or Tab panes · ↑/↓ or j/k move · Enter apply · Esc close'), 'footer survives inside the card');
    } finally {
      cleanup();
    }
  });

  // S2: the key legend is ONE terminal row at every width. A legend that does
  // not fit the card is compacted (short tokens, then the lowest-priority keys
  // dropped) instead of ellipsis-clipped, so the close key never disappears.
  test('the key legend owns exactly one row at every width', async () => {
    const { component, cleanup } = await openPanel();
    try {
      for (const width of [40, 60, 80, 120]) {
        const lines = component.render(width);
        for (const line of lines) assert.equal(visible(line), width, `width ${width}: every row stays cell-exact`);
        const legend = lines.map(stripAnsi).filter((line) => /Esc close|esc close/.test(line));
        assert.equal(legend.length, 1, `width ${width}: exactly one footer row, got ${legend.length}`);
        assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
        assert.match(legend[0], /close/, `width ${width}: the close key survives`);
      }
    } finally {
      cleanup();
    }
  });

  test('the card paints through the injected theme instead of hardcoding escapes', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      const roles = [];
      const theme = { fg: (role, text) => { roles.push(role); return text; } };
      let settled = 'pending';
      const component = customs[0][0](makeHostTui().tui, theme, {}, (result) => { settled = result; });
      assert.equal(settled, 'pending');
      const lines = component.render(80);
      assert.ok(lines.length > 0, 'themed render produces rows');
      // S11: every role the panel names comes from the shared palette — the
      // frame/divider (border), the title and keys (accent), the descriptions
      // and counts (muted) and the static labels (dim).
      for (const role of ['border', 'accent', 'muted', 'dim']) {
        assert.ok(roles.includes(role), `theme.fg paints the ${role} role`);
      }
      for (const line of lines) assert.ok(!line.includes('\x1b'), 'injected theme adds no escapes of its own here');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('customize label-only rows with focused preview', { concurrency: false }, () => {
  // Panel fix: right-pane rows are LABELS ONLY (gentle-shell
  // visual-customize-view style) — the focused choice's S2 detail
  // appears ONCE in the bottom block as `Preview · <focused label>`
  // plus the description line, never under each row.
  function stripRowAnsi(line) {
    return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
  }

  async function openSidebarPanel() {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      const host = makeHostTui();
      const opened = openComponent(customs[0][0], host);
      return { ...opened, host, cleanup: () => { setSlot(hadSlot); restoreEnv(); } };
    } catch (err) {
      setSlot(hadSlot);
      restoreEnv();
      throw err;
    }
  }

  const countIn = (text, needle) => text.split(needle).length - 1;

  for (const width of [60, 80, 100]) {
    test(`width ${width}: right pane rows are label-only, the focused detail appears exactly once`, async () => {
      const { component, cleanup } = await openSidebarPanel();
      try {
        const text = component.render(width).map(stripRowAnsi).join('\n');
        // Both rows render as labels; the active value keeps its → mark.
        assert.ok(text.includes('Gentle (this extension)'), 'focused row label renders');
        assert.ok(text.includes('Native Herdr'), 'unfocused row label renders');
        assert.ok(text.includes('→'), 'the active row keeps the → marker');
        // The heading still names the category with i/N.
        assert.ok(text.includes('Herdr Sidebar · 1/2'), 'heading still renders');
        // No per-row detail line: the unfocused row's detail is absent.
        assert.equal(countIn(text, "hands the pane back to Herdr's own agent state"), 0, 'unfocused detail renders nowhere');
        // The focused row's detail appears exactly once, in the bottom block.
        assert.equal(countIn(text, 'publishes agent state and SessionChanges from Gentle'), 1, 'focused detail appears exactly once');
        assert.ok(text.includes('Preview · Gentle (this extension)'), 'bottom block names the focused label');
        assert.ok(!text.includes('Active:'), 'the redundant Active: repeat is gone');
      } finally {
        cleanup();
      }
    });
  }

  test('moving the value focus swaps only the preview description', async () => {
    const { component, cleanup } = await openSidebarPanel();
    try {
      component.handleInput('right');
      component.handleInput('down');
      const text = component.render(80).map(stripRowAnsi).join('\n');
      assert.ok(text.includes('Preview · Native Herdr'), 'bottom block follows the focused label');
      assert.equal(countIn(text, "hands the pane back to Herdr's own agent state"), 1, 'new focused detail appears exactly once');
      assert.equal(countIn(text, 'publishes agent state and SessionChanges from Gentle'), 0, 'old focused detail is gone');
      assert.ok(text.includes('→'), 'the active marker stays on the active value');
      assert.ok(text.includes('Herdr Sidebar · 2/2'), 'the heading tracks the focused row');
    } finally {
      cleanup();
    }
  });

  test('moving across categories swaps only the preview description', async () => {
    const { component, cleanup } = await openSidebarPanel();
    try {
      component.handleInput('down');
      const text = component.render(80).map(stripRowAnsi).join('\n');
      assert.ok(text.includes('Preview · Off'), 'bottom block follows the new category focus');
      assert.equal(countIn(text, 'leaves notifications to the host'), 1, 'new focused detail appears exactly once');
      assert.equal(countIn(text, 'notifies ask and finish episodes through Moshi'), 0, 'unfocused moshi detail renders nowhere');
      assert.equal(countIn(text, 'publishes agent state and SessionChanges from Gentle'), 0, 'previous category detail is gone');
    } finally {
      cleanup();
    }
  });
});

describe('worktree registration under an injected state dir (S15)', { concurrency: false }, () => {
  const WORKTREE_TOOLS = ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open', 'worktree_warp'];

  // A sandbox XDG state home plus an injected (new-id) dir. A stored flag
  // means <sandbox>/herdr/plugins/herdr-gentle-agents holds the mode file.
  function injectedSandbox(storedDoc) {
    const sandbox = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-panel-xdg-')));
    const injected = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-panel-injected-')));
    if (storedDoc !== undefined) {
      const stored = path.join(sandbox, 'herdr', 'plugins', 'herdr-gentle-agents');
      fs.mkdirSync(stored, { recursive: true });
      fs.writeFileSync(path.join(stored, 'gentle-worktree-mode.json'), `${JSON.stringify(storedDoc)}\n`);
    }
    return { injected, sandbox };
  }

  test('a stored disabled flag leaves the tools unregistered', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: false });
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: undefined,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const hadSlot = setSlot(undefined);
    try {
      const { tools, commands } = await loadExtension();
      for (const name of WORKTREE_TOOLS) {
        assert.ok(!tools.has(name), `${name} must stay unregistered while the stored flag is disabled`);
      }
      assert.ok(!commands.has('herdr-gentle:warp'), 'S28: warp is hidden while the mode is disabled');
      assert.ok(commands.has('herdr-gentle:customize'), 'customize stays registered');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a stored enabled flag registers the tools', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: true });
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: undefined,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const hadSlot = setSlot(undefined);
    try {
      const { tools } = await loadExtension();
      for (const name of WORKTREE_TOOLS) {
        assert.ok(tools.has(name), `${name} must register while the stored flag is enabled`);
      }
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('an explicit disabled dir wins over injected and stored dirs', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: true });
    const explicit = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-panel-explicit-')));
    fs.writeFileSync(path.join(explicit, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: explicit,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const hadSlot = setSlot(undefined);
    try {
      const { tools } = await loadExtension();
      for (const name of WORKTREE_TOOLS) {
        assert.ok(!tools.has(name), `${name} must stay unregistered under an explicit disabled dir`);
      }
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('customize status reports the stored worktree state under an injected dir', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: false });
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: undefined,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      const { commands } = await loadExtension();
      const { ctx, notes } = makeCtx();
      await customizeDef(commands).handler('status', ctx);
      assert.equal(notes.length, 1);
      assert.equal(notes[0][0], 'customize status: sidebar=gentle moshi=off worktree=disabled odd=enabled issues=enabled');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('single Worktree tools switch covers the session and warp tools (S21, T40)', { concurrency: false }, () => {
  // The extension registers exactly five tools and two of them move or open
  // sessions; the single mode gate governs all five (S21 verified
  // inventory, T40 adds the agent warp). These tests pin that the one switch
  // stays the whole story: the copy names the session and warp coverage,
  // enabled registers exactly the five tools, disabled registers none, and
  // every disabled-path refusal keeps its exact bytes.
  const FOUR = ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open', 'worktree_warp'];
  const REFUSAL =
    'worktree tools are disabled; open /herdr-gentle:customize and apply the Plugin tools Worktree tools toggle to enable them';
  const ENABLED_DETAIL = 'agents can create, list, close, warp between and open sessions in agent worktrees; the warp command follows this toggle';

  function textOf(result) {
    return (result.content || []).map((part) => part.text || '').join('\n');
  }

  test('the Worktree tools toggle names the session coverage in its exact bytes', async () => {
    // Byte pin on the toggle's own copy: one short detail line, same shape
    // as the other detail strings. (The panel render path asserting this
    // copy is visible lives in the customize panel test above.)
    const line =
      'detail: "agents can create, list, close, warp between and open sessions in agent worktrees; the warp command follows this toggle",';
    assert.equal(srcText.split(line).length - 1, 1, 'the Worktree tools toggle keeps its exact copy');
    assert.ok(ENABLED_DETAIL.includes('open sessions'), 'the coverage names opening sessions');
    assert.ok(ENABLED_DETAIL.includes('warp'), 'the coverage names the warp capability');
  });

  test('enabled registers exactly the five tools including the session opener and the warp', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { tools } = await loadExtension();
      assert.deepEqual(
        [...tools.keys()].sort(),
        [...FOUR].sort(),
        'enabled registers exactly the five tools, no more and no fewer',
      );
      assert.ok(tools.has('worktree_session_open'), 'the single session tool is among them');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('disabled registers no tool at all', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(false, process.env);
      const { tools } = await loadExtension();
      assert.deepEqual([...tools.keys()], [], 'disabled registers none of the five tools');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('every tool refuses with the byte-identical disabled message', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { tools } = await loadExtension();
      assert.deepEqual(
        [...tools.keys()].sort(),
        [...FOUR].sort(),
        'precondition: all five tools are registered while enabled',
      );
      // The mode gate runs before any repo or backend access, so these
      // calls need no fixture repository and no Herdr/gh shim: a plain
      // refusal is the whole observable effect.
      modeLib().writeMode(false, process.env);
      const calls = [
        ['worktree_create', { branch: 'feat/off' }],
        ['worktree_list', {}],
        ['worktree_close', { branch: 'feat/off' }],
        ['worktree_session_open', { worktree: 'feat-off' }],
        ['worktree_warp', { name: 'feat-off' }],
      ];
      for (const [name, params] of calls) {
        const tool = tools.get(name);
        assert.ok(tool, `${name} is registered`);
        const result = await tool.execute('call-1', params, undefined, undefined, {});
        assert.equal(result.isError, true, `${name} refuses while disabled`);
        assert.equal(textOf(result), REFUSAL, `${name} refusal keeps its exact bytes`);
      }
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('customize key consistency (K1/K3)', { concurrency: false }, () => {
  function stripAnsi(line) {
    return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
  }

  async function openPanel() {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      const opened = openComponent(customs[0][0], makeHostTui());
      return { ...opened, cleanup: () => { setSlot(hadSlot); restoreEnv(); } };
    } catch (err) {
      setSlot(hadSlot);
      restoreEnv();
      throw err;
    }
  }

  test('j moves the selection down alongside the down arrow', async () => {
    const { component, done, cleanup } = await openPanel();
    try {
      component.handleInput('right');
      assert.equal(component.state.pane, 'values');
      const before = component.state.row[component.state.cat];
      component.handleInput('j');
      assert.equal(component.state.row[component.state.cat], (before + 1) % 2, 'j moves down one row');
      assert.equal(done(), 'pending', 'movement never finishes the overlay');
      const text = component.render(80).map(stripAnsi).join('\n');
      assert.match(text, /Preview · Native Herdr/, 'the preview follows the j move');
    } finally {
      cleanup();
    }
  });

  test('k moves the selection up alongside the up arrow', async () => {
    const { component, done, cleanup } = await openPanel();
    try {
      component.handleInput('right');
      component.handleInput('j');
      const moved = component.state.row[component.state.cat];
      assert.equal(moved, 1);
      component.handleInput('k');
      assert.equal(component.state.row[component.state.cat], 0, 'k moves back up');
      assert.equal(done(), 'pending', 'movement never finishes the overlay');
    } finally {
      cleanup();
    }
  });

  test('? is unbound: no key-help overlay, and esc still closes the panel', async () => {
    const { component, done, cleanup } = await openPanel();
    try {
      const before = component.render(80).map(stripAnsi).join('\n');
      component.handleInput('?');
      assert.equal(component.render(80).map(stripAnsi).join('\n'), before, '? changes nothing');
      component.handleInput('escape');
      assert.equal(done(), null, 'esc closes the panel');
    } finally {
      cleanup();
    }
  });

  test('the footer names only the real keys', async () => {
    const { component, cleanup } = await openPanel();
    try {
      const text = component.render(80).map(stripAnsi).join('\n');
      assert.match(text, /↑\/↓ or j\/k move/, 'the footer names the j/k aliases');
      assert.ok(!text.includes('? help'), 'no redundant help key');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// S22: the panel has no Performance section at all. Its categories are sidebar,
// moshi, worktree and reset — in that order — and no performance row, no
// optimisation switch and no trace toggle is reachable from it. The trace is
// switched on by the GENTLE_PERF_TRACE environment variable instead (S24), so
// nothing in this panel may name it.
// ---------------------------------------------------------------------------
describe('customize has no performance category (S22)', { concurrency: false }, () => {
  const CATEGORY_TITLES = ['Herdr Sidebar', 'Moshi notifications', 'Plugin tools', 'Reset'];

  test('the card offers exactly four categories and names no performance option', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_PERF_TRACE: undefined, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    const customs = [];
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx } = makeCtx({
        customImpl: async (factory) => { customs.push(factory); },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'the panel opened');

      const host = makeHostTui();
      const { component, done } = openComponent(customs[0], host);
      const seen = () => component.render(100).map((line) => String(line)).join('\n');

      for (let index = 0; index < CATEGORY_TITLES.length; index += 1) {
        assert.ok(seen().includes(`▸ ${CATEGORY_TITLES[index]}`), `focused category ${index} is ${CATEGORY_TITLES[index]}`);
        component.handleInput('down');
      }
      assert.ok(seen().includes('▸ Herdr Sidebar'), 'the fourth entry wraps back to the first category');
      assert.equal(done(), 'pending', 'walking the categories never applies anything');

      const card = seen();
      assert.ok(!/Performance/i.test(card), 'no performance category, row or trace toggle is rendered');
      assert.ok(!/trace/i.test(card), 'the trace is not advertised from the panel');
      assert.ok(!/optimis|optimiz/i.test(card), 'no optimisation wording survives');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('the headless fallback menu offers the same four categories and nothing else', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_PERF_TRACE: undefined, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => null);
      const { ctx, notes, selects } = makeCtx({ selectImpl: () => null });
      await customizeDef(commands).handler('', ctx);
      assert.deepEqual(selects[0][1], CATEGORY_TITLES, 'the category menu carries exactly these four entries');
      assert.deepEqual(notes, [], 'cancelling writes and notifies nothing');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('the reset summary names only the options this package owns', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_PERF_TRACE: undefined, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => null);
      const picked = [];
      const { ctx, notes } = makeCtx({
        selectImpl: (title, options) => {
          picked.push([title, options]);
          return title === 'Customize · Herdr Gentle Shell' ? 'Reset' : options[0];
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.deepEqual(picked[0][1], CATEGORY_TITLES, 'the reset is reached as its own category');
      assert.deepEqual(
        notes,
        [['Nothing to reset: sidebar, moshi, worktree, odd and issues already match their defaults.', 'info']],
        'the all-default run names the three options and no performance switch',
      );
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// S11/T9: the customize panel paints through the ONE shared palette
// (lib/tui-paint.js) with the injected theme, exactly like the warp panel, the
// create flow, odd and issues — a shortcut KEY (a BUTTON) is accent+bold and its
// description muted, a TITLE (the panel title, a section heading) takes the
// Agents view's own title role, a static label is dim, a choice is ordinary
// text, a position count is muted and the frame plus its divider are the border
// role. S13/S16: the panel keeps three levels apart — secondary titles, primary
// buttons and normal rows — so it does not paint every row in the accent. Focus
// stays visible through its own marks (▸/→) and the selected row's own band, the
// legend still owns ONE row at every width, and a hostile theme still renders
// every row in plain text.
describe('S11: the shared palette', { concurrency: false }, () => {
  const ROLE_SGR = { accent: 96, customMessageLabel: 33, muted: 90, dim: 2, border: 34, error: 91, text: 39, mdHeading: 35 };

  function stripAnsi(line) {
    return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
  }

  // The real host measures a PAINTED line by its visible columns, so the
  // palette assertions below install an ANSI-aware helper instead of the
  // plain codepoint counter the untouched stubs use.
  const ansiStubTui = {
    ...stubTui,
    visibleWidth: (text) => [...stripAnsi(String(text))].length,
    truncateToWidth: (text, width) => {
      const chars = [...stripAnsi(String(text))];
      return chars.length > width ? chars.slice(0, width).join('') : String(text);
    },
  };

  // A theme that RECORDS which role painted each string and paints every role
  // with its own SGR code, so a rendered line can be read for the ROLE behind a
  // token instead of trusting an eyeballed colour.
  function recordingTheme() {
    const calls = [];
    const code = (role) => ROLE_SGR[role] ?? 95;
    return {
      calls,
      fg(role, text) {
        const value = String(text);
        calls.push({ role, text: value });
        return `\x1b[${code(role)}m${value}\x1b[0m`;
      },
      bold(text) {
        const value = String(text);
        calls.push({ role: 'bold', text: value });
        return `\x1b[1m${value}\x1b[22m`;
      },
      bg(role, text) {
        calls.push({ role: `bg:${role}`, text: String(text) });
        return String(text);
      },
    };
  }

  function findRaw(lines, needle) {
    const line = lines.find((entry) => stripAnsi(entry).includes(needle));
    assert.ok(line !== undefined, `no line contains ${JSON.stringify(needle)}\n${lines.map(stripAnsi).join('\n')}`);
    return line;
  }

  async function openThemedPanel(theme) {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => ansiStubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      const opened = openComponent(customs[0][0], makeHostTui());
      const component = customs[0][0](makeHostTui().tui, theme, {}, () => {});
      assert.equal(opened.done(), 'pending');
      return { component, cleanup: () => { setSlot(hadSlot); restoreEnv(); } };
    } catch (err) {
      setSlot(hadSlot);
      restoreEnv();
      throw err;
    }
  }

  test('the footer paints every key accent+bold and its description muted', async () => {
    const theme = recordingTheme();
    const { component, cleanup } = await openThemedPanel(theme);
    try {
      const legend = findRaw(component.render(80), 'Esc close');
      assert.match(legend, /\x1b\[1m\x1b\[96m←\/→\x1b\[0m\x1b\[22m\x1b\[90m or Tab panes\x1b\[0m/,
        'the pane key is accent+bold and its description muted');
      assert.match(legend, /\x1b\[1m\x1b\[96m↑\/↓\x1b\[0m\x1b\[22m\x1b\[90m or j\/k move\x1b\[0m/,
        'so is the movement key');
      assert.match(legend, /\x1b\[1m\x1b\[96mEnter\x1b\[0m\x1b\[22m\x1b\[90m apply\x1b\[0m/,
        'and the apply key');
      assert.match(legend, /\x1b\[1m\x1b\[96mEsc\x1b\[0m\x1b\[22m\x1b\[90m close\x1b\[0m/,
        'and the close key');
      assert.match(legend, /\x1b\[34m · \x1b\[0m/, 'the entries are joined by the border role');
      assert.ok(theme.calls.some((call) => call.role === 'bold' && call.text.includes('Enter')),
        'the key is bolded through the theme, never by a literal escape');
      assert.ok(theme.calls.some((call) => call.role === 'muted' && call.text === ' apply'),
        'the description asks the injected theme for the muted role');
    } finally {
      cleanup();
    }
  });

  test('the title is the reference dim title role, the label dim, the choice ordinary text and the count muted', async () => {
    const theme = recordingTheme();
    const { component, cleanup } = await openThemedPanel(theme);
    try {
      const lines = component.render(80);
      const top = findRaw(lines, 'Customize · Herdr Gentle Shell');
      assert.match(top, /\x1b\[1m\x1b\[33mCustomize · Herdr Gentle Shell\x1b\[0m\x1b\[22m/,
        'the panel title is the Agents view title role, bold');
      assert.ok(theme.calls.some((call) => call.role === 'customMessageLabel' && call.text === 'Customize · Herdr Gentle Shell'),
        'the title asks the injected theme for the title role');
      assert.ok(!theme.calls.some((call) => call.role === 'accent' && call.text === 'Customize · Herdr Gentle Shell'),
        'the title never takes the button accent');
      assert.match(top, /\x1b\[1m\x1b\[96mesc\x1b\[0m\x1b\[22m/, 'the esc hint on that row is a button key');
      const heading = findRaw(lines, 'CATEGORIES');
      assert.match(heading, /\x1b\[2mCATEGORIES\x1b\[0m/, 'the section label is dim');
      assert.match(heading, /\x1b\[1m\x1b\[33mHerdr Sidebar\x1b\[0m\x1b\[22m/, 'the section heading is a title');
      assert.match(heading, /\x1b\[90m1\/2\x1b\[0m/, 'the position count is muted');
      const row = findRaw(lines, 'Gentle (this extension)');
      assert.match(row, /\x1b\[39m {2}→ Gentle \(this extension\)\x1b\[0m/, 'a choice is ordinary text');
      assert.ok(!/\x1b\[96m/.test(row), 'an unselected choice is never painted with the button accent');
      const preview = findRaw(lines, 'Preview · Gentle');
      assert.match(preview, /\x1b\[2mPreview\x1b\[0m\x1b\[2m · \x1b\[0m\x1b\[39mGentle \(this extension\)\x1b\[0m/,
        'the preview label is dim and the focused label it names is ordinary text');
      const detail = findRaw(lines, 'publishes agent state and SessionChanges');
      assert.match(detail, /\x1b\[90mpublishes agent state and SessionChanges from Gentle\x1b\[0m/,
        'the description under the preview is muted');
      assert.match(lines[0], /^\x1b\[34m╭/, 'the frame is painted with the border role');
      assert.match(findRaw(lines, 'Herdr Sidebar'), /\x1b\[34m│\x1b\[0m/, 'the pane divider is the border role');
    } finally {
      cleanup();
    }
  });

  test('focus markers survive the palette', async () => {
    // A theme that paints no background has to keep focus readable through the
    // ▸ mark, and a theme that does paint one shows the selected band instead.
    const markerTheme = {
      fg: (role, text) => `\x1b[${ROLE_SGR[role] ?? 95}m${String(text)}\x1b[0m`,
      bold: (text) => `\x1b[1m${String(text)}\x1b[22m`,
    };
    const bandTheme = recordingTheme();
    const markers = await openThemedPanel(markerTheme);
    try {
      const bands = await openThemedPanel(bandTheme);
      try {
        const focusedCategory = findRaw(markers.component.render(80), '▸ Herdr Sidebar');
        assert.match(focusedCategory, /\x1b\[96m▸ /, 'the focused category keeps its accent ▸ mark');
        markers.component.handleInput('right');
        const text = markers.component.render(80).map(stripAnsi).join('\n');
        assert.ok(text.includes('▸ → Gentle (this extension)'), 'the focused value keeps both ▸ and its → active mark');
        bandTheme.calls.length = 0;
        const banded = bands.component.render(80);
        assert.ok(banded.length > 0, 'the background theme renders the same rows');
        const bandCalls = bandTheme.calls.filter((call) => call.role === 'bg:selectedBg');
        assert.ok(bandCalls.length > 0, 'a background theme paints the focused row as a band');
        assert.ok(bandCalls.some((call) => call.text.includes('Herdr Sidebar')), 'the band carries the focused category');
      } finally {
        bands.cleanup();
      }
    } finally {
      markers.cleanup();
    }
  });

  test('the painted legend still owns exactly one row at every width', async () => {
    const theme = recordingTheme();
    const { component, cleanup } = await openThemedPanel(theme);
    try {
      for (const width of [40, 60, 80, 120]) {
        const lines = component.render(width);
        for (const line of lines) {
          assert.equal([...stripAnsi(line)].length, width, `width ${width}: every row stays cell-exact`);
        }
        const legend = lines.filter((line) => /Esc close|esc close/.test(stripAnsi(line)));
        assert.equal(legend.length, 1, `width ${width}: exactly one footer row, got ${legend.length}`);
        assert.ok(!stripAnsi(legend[0]).includes('…'), `width ${width}: compacted, never ellipsis-clipped`);
        assert.match(stripAnsi(legend[0]), /close/, `width ${width}: the close key survives`);
        assert.match(legend[0], /\x1b\[1m\x1b\[96mEsc\x1b\[0m/, `width ${width}: the surviving close key keeps the key role`);
      }
    } finally {
      cleanup();
    }
  });

  test('a hostile theme never breaks the panel and keeps every key readable', async () => {
    const hostile = {
      fg() { throw new Error('no colour support'); },
      bold() { throw new Error('no bold support'); },
      bg() { throw new Error('no background support'); },
    };
    const { component, cleanup } = await openThemedPanel(hostile);
    try {
      const lines = component.render(80);
      for (const line of lines) {
        assert.equal([...stripAnsi(line)].length, 80, `line is not 80 wide: ${JSON.stringify(line)}`);
      }
      const text = lines.map(stripAnsi).join('\n');
      assert.ok(text.includes('Customize · Herdr Gentle Shell'), 'the title still renders');
      assert.ok(text.includes('←/→ or Tab panes · ↑/↓ or j/k move · Enter apply · Esc close'),
        'the legend still spells every key');
      assert.ok(text.includes('Preview · Gentle (this extension)'), 'the preview still renders');
      assert.ok(text.includes('▸ Herdr Sidebar'), 'focus still renders through its mark');
      for (const line of lines) assert.ok(!line.includes('\x1b'), 'a hostile theme adds no escapes');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin tools: split state and concurrent flips (extension side).
//
// The stored pair of toggles can exist in TWO directories — the Herdr-injected
// state dir and the stored pre-rename dir. These tests pin the user-visible
// contract of the fix in lib/worktree-mode.js:
//  * a flip writes the copy that exists, never a second one beside it (the old
//    behavior created a second, ENABLED copy that shadowed a stored Disabled
//    toggle — fail open);
//  * two copies that disagree refuse the flip with an actionable diagnostic
//    and write neither file;
//  * `customize status` never reports a Disabled toggle without the reason.
// ---------------------------------------------------------------------------
const STORED_SEGMENT = path.join('herdr', 'plugins', 'herdr-gentle-agents');

// A sandbox where the Herdr-injected dir and the stored dir are genuinely
// different, so both locations of the toggle file are reachable.
function splitStateEnv() {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-split-')));
  const xdg = path.join(root, 'xdg');
  const stored = path.join(xdg, STORED_SEGMENT);
  const injected = path.join(root, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  return {
    root,
    stored,
    injected,
    env: {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: undefined,
      XDG_STATE_HOME: xdg,
      HERDR_PLUGIN_STATE_DIR: injected,
      GENTLE_PI_AGENT_HOME: undefined,
      PI_CODING_AGENT_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-split-agent-'))),
    },
  };
}

function toolsBody(odd, issues) {
  return `{"version":1,"odd":${odd},"issues":${issues}}\n`;
}

function seedTools(dir, odd, issues) {
  fs.writeFileSync(path.join(dir, 'gentle-plugin-tools.json'), toolsBody(odd, issues));
}

function toolsBytesOf(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'gentle-plugin-tools.json'), 'utf8');
  } catch {
    return null;
  }
}

describe('plugin tools split state (extension)', { concurrency: false }, () => {
  test('a flip writes the existing stored copy and never a second one', async () => {
    const fixture = splitStateEnv();
    setEnv(fixture.env);
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      seedTools(fixture.stored, false, true);
      fs.writeFileSync(path.join(fixture.injected, 'gentle-status.pid'), '424242\n');
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        // Plugin tools values pane: worktree, then ODD.
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'down', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(true, true), 'the existing copy was updated in place');
      assert.equal(toolsBytesOf(fixture.injected), null, 'no shadow copy was created in the injected dir');
      assert.equal(notes.length, 1, 'exactly one notification');
      assert.equal(notes[0][0], 'ODD command enabled. Reloading now to apply the change.');
      assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload']);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a flip updates both copies when they already agree, and says so', async () => {
    const fixture = splitStateEnv();
    setEnv(fixture.env);
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      seedTools(fixture.stored, true, true);
      seedTools(fixture.injected, true, true);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes } = makeCtx({
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'down', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true));
      assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, true), 'the pair stays identical');
      assert.match(notes[0][0], /^ODD command disabled\./);
      assert.ok(notes[0][0].includes('stored in 2 places'), `the notification names both copies: ${notes[0][0]}`);
      assert.ok(notes[0][0].includes(path.join(fixture.stored, 'gentle-plugin-tools.json')), 'it names the stored copy');
      assert.ok(notes[0][0].includes(path.join(fixture.injected, 'gentle-plugin-tools.json')), 'it names the injected copy');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a conflicting pair refuses the flip with a diagnostic and writes nothing', async () => {
    const fixture = splitStateEnv();
    setEnv(fixture.env);
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      seedTools(fixture.stored, false, true);
      seedTools(fixture.injected, true, true);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'down', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(notes.length, 1, 'exactly one notification');
      assert.equal(notes[0][1], 'error', 'the refusal is an error, never a success message');
      assert.match(notes[0][0], /could not write/i);
      assert.match(notes[0][0], /different values/i, 'the diagnostic says what is wrong');
      assert.ok(notes[0][0].includes(path.join(fixture.stored, 'gentle-plugin-tools.json')), 'it names the stored copy');
      assert.ok(notes[0][0].includes(path.join(fixture.injected, 'gentle-plugin-tools.json')), 'it names the injected copy');
      assert.match(notes[0][0], /nothing was changed/i);
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true), 'the stored copy is byte-identical');
      assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'the injected copy is byte-identical');
      assert.ok(!seq.includes('reload'), 'a refused flip never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('customize status names the conflict instead of reporting a bare Disabled', async () => {
    const fixture = splitStateEnv();
    setEnv(fixture.env);
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      seedTools(fixture.stored, false, true);
      seedTools(fixture.injected, true, true);
      const { commands } = await loadExtension();
      const { ctx, notes } = makeCtx({});
      await customizeDef(commands).handler('status', ctx);
      assert.equal(notes.length, 1);
      assert.match(notes[0][0], /^customize status: .*odd=disabled/);
      assert.match(notes[0][0], /different values/i, 'the line carries the reason');
      assert.ok(notes[0][0].includes(path.join(fixture.stored, 'gentle-plugin-tools.json')));
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true), 'status writes nothing');
      assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'status writes nothing');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin tools: a flip writes EVERY copy of the toggle document, so it can stop
// half-way, and it OVERWRITES a copy that does not parse. Both are real states
// the panel has to report truthfully:
//  * a copy that already holds the new value makes "nothing was changed" a lie,
//    so a half-applied flip names what landed, what was left untouched and that
//    the pair now disagrees (which reads as Disabled);
//  * a repaired copy discarded whatever the user had in it, so its path is
//    named instead of the overwrite staying silent.
// ---------------------------------------------------------------------------

// A lib dir whose `worktree-mode.js` re-exports the real module but replaces
// ONE writer, so a half-applied flip can be provoked deterministically. The
// failure cannot be injected with permissions: both copies are written from one
// writable sandbox under one set of locks, so the OS never fails the second
// write. The substitute therefore lands the canonical copy through the REAL
// writer (with the injected duplicate hidden), restores that duplicate
// untouched — exactly the on-disk state a failed second write leaves — and
// raises the library's documented `plugin_tools_write_partial` error with its
// `failed`/`written` fields. What is under test is the extension's report.
function partialWriteLibDir() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-partial-lib-')));
  for (const entry of fs.readdirSync(LIB_DIR)) {
    if (entry === 'worktree-mode.js') continue;
    fs.symlinkSync(path.join(LIB_DIR, entry), path.join(dir, entry));
  }
  const shim = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const real = require(${JSON.stringify(path.join(LIB_DIR, 'worktree-mode.js'))});`,
    "async function halfWrite(patch, options) {",
    "  const env = (options && options.env) || process.env;",
    "  const legacy = real.pluginToolsFiles(env).slice(1);",
    "  const saved = legacy.map((file) => ({ file, raw: fs.existsSync(file) ? fs.readFileSync(file) : null }));",
    "  for (const entry of saved) fs.rmSync(entry.file, { force: true });",
    "  try {",
    "    await real.updatePluginTools(patch, options);",
    "  } finally {",
    "    for (const entry of saved) if (entry.raw) fs.writeFileSync(entry.file, entry.raw);",
    "  }",
    "  return saved.map((entry) => entry.file);",
    "}",
    "module.exports = {",
    "  ...real,",
    "  async updatePluginTools(patch, options) {",
    "    const untouched = await halfWrite(patch, options);",
    "    const env = (options && options.env) || process.env;",
    "    const failed = untouched[0] || null;",
    "    const err = new Error(`could not write the plugin tools state ${failed}: EACCES: permission denied`);",
    "    err.code = 'plugin_tools_write_partial';",
    "    err.failed = failed;",
    "    err.written = [real.pluginToolsPath(env)];",
    "    throw err;",
    "  },",
    "};",
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'worktree-mode.js'), shim);
  return dir;
}

describe('plugin tools half-applied flip and repair (extension)', { concurrency: false }, () => {
  test('a half-applied flip names the copy that already changed, never "nothing was changed"', async () => {
    const fixture = splitStateEnv();
    setEnv({ ...fixture.env, GENTLE_WORKTREE_LIB_DIR: partialWriteLibDir() });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      seedTools(fixture.stored, true, true);
      seedTools(fixture.injected, true, true);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no TUI here'); });
      const answers = ['Plugin tools', 'ODD command · Enabled'];
      const { ctx, notes, seq } = makeCtx({ selectImpl: () => answers.shift() });
      await customizeDef(commands).handler('', ctx);

      const storedFile = path.join(fixture.stored, 'gentle-plugin-tools.json');
      const injectedFile = path.join(fixture.injected, 'gentle-plugin-tools.json');
      assert.equal(notes.length, 1, 'exactly one notification');
      const [text, level] = notes[0];
      assert.equal(level, 'error', 'a half-applied flip is an error, never a success');
      assert.match(text, /half applied/i, 'the verdict says the flip only half landed');
      assert.ok(!/nothing was changed/i.test(text), `a copy DID change, so that sentence is false: ${text}`);
      assert.ok(text.includes(storedFile), 'the copy that already holds the new value is named');
      assert.ok(text.includes(injectedFile), 'the copy left untouched is named');
      assert.match(text, /disable/i, 'it says the toggle now reads Disabled');
      // The message describes the state that is really on disk.
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true), 'the first copy holds the new value');
      assert.equal(toolsBytesOf(fixture.injected), toolsBody(true, true), 'the second copy was left untouched');
      assert.ok(!seq.includes('reload'), 'a half-applied flip never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a flip that repairs an unreadable duplicate names the path it overwrote', async () => {
    const fixture = splitStateEnv();
    setEnv(fixture.env);
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      seedTools(fixture.stored, true, true);
      const injectedFile = path.join(fixture.injected, 'gentle-plugin-tools.json');
      fs.writeFileSync(injectedFile, '{"version":1,"odd":true}\n');
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no TUI here'); });
      const answers = ['Plugin tools', 'ODD command · Enabled'];
      const { ctx, notes } = makeCtx({ selectImpl: () => answers.shift() });
      await customizeDef(commands).handler('', ctx);

      const text = notes[0][0];
      assert.match(text, /^ODD command disabled\./, 'the flip itself succeeded');
      assert.ok(text.includes(injectedFile), `the repaired copy is named explicitly: ${text}`);
      assert.match(text, /did not parse/i, 'it says why the copy was rewritten');
      assert.match(text, /discarded/i, 'it says what repairing it cost');
      assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, true), 'the repaired copy now agrees');
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(false, true));
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a reset whose plugin tools write half landed is not reported as a clean no-op', async () => {
    const fixture = splitStateEnv();
    setEnv({ ...fixture.env, GENTLE_WORKTREE_LIB_DIR: partialWriteLibDir() });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      seedTools(fixture.stored, false, false);
      seedTools(fixture.injected, false, false);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no TUI here'); });
      const answers = ['Reset', 'Reset every option to its default'];
      const { ctx, notes } = makeCtx({ selectImpl: () => answers.shift() });
      await customizeDef(commands).handler('', ctx);

      const text = notes[0][0];
      assert.match(text, /^Partial reset: /);
      assert.ok(!/Nothing was changed\./i.test(text), `a copy DID change, so that sentence is false: ${text}`);
      assert.match(text, /half applied/i, 'the summary names the half-applied write');
      assert.ok(text.includes(path.join(fixture.stored, 'gentle-plugin-tools.json')), 'the copy that changed is named');
      assert.ok(text.includes(path.join(fixture.injected, 'gentle-plugin-tools.json')), 'the copy left untouched is named');
      assert.equal(toolsBytesOf(fixture.stored), toolsBody(true, true), 'the first copy holds the new value');
      assert.equal(toolsBytesOf(fixture.injected), toolsBody(false, false), 'the second copy was left untouched');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});
