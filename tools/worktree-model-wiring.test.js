'use strict';
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { formatWorktreeModelResult, WORKTREE_MODEL_TOOLS } = require('../lib/worktree-model-result.js');

// The four tools whose model text this adapter formats. The create tool is
// deliberately absent: it writes its own short ordered text, and the retired
// `worktree_upsert` builder that used to sit beside it is gone.
const FORMATTED = [...WORKTREE_MODEL_TOOLS];

const roots = [];
const originalEnv = {
  GENTLE_WORKTREE_LIB_DIR: process.env.GENTLE_WORKTREE_LIB_DIR,
  GENTLE_STATUS_STATE_DIR: process.env.GENTLE_STATUS_STATE_DIR,
};
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

async function registeredTools({ missingFormatter = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-model-wiring-'));
  roots.push(root);
  process.env.GENTLE_STATUS_STATE_DIR = path.join(root, 'state');
  const lib = path.resolve(__dirname, '../lib');
  process.env.GENTLE_WORKTREE_LIB_DIR = lib;
  if (missingFormatter) {
    const partial = path.join(root, 'partial-lib');
    fs.mkdirSync(partial);
    fs.writeFileSync(path.join(partial, 'worktree-mode.js'), 'module.exports = { readMode: () => ({ enabled: true, state: "enabled" }) };');
    process.env.GENTLE_WORKTREE_LIB_DIR = partial;
  }
  // Intercept only the backend at defineTool, before the real registration
  // adapter runs. Tests exercise registered tool.execute, not exported helpers,
  // without invoking Git, Herdr, GitHub or a user registry.
  const source = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts'), 'utf8')
    .replace('import { Type } from "@earendil-works/pi-ai";', 'const Type = new Proxy({}, { get: () => () => ({}) });')
    .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', `
      export const produced = new Map();
      export const calls = [];
      const defineTool = (definition) => ({ ...definition, execute: async function (...args) {
        calls.push({ name: definition.name, receiver: this, args });
        const result = produced.get(definition.name);
        if (result instanceof Error) throw result;
        return result;
      } });`);
  const copy = path.join(root, 'extension.mjs');
  fs.writeFileSync(copy, source);
  const mod = await import(pathToFileURL(copy).href);
  const tools = new Map();
  mod.default({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  // S1/S6: the create tool emits its own one-row-per-fact text, so it is
  // registered beside the four tools this adapter formats; the retired
  // `worktree_upsert` contract has no builder and no registration left.
  assert.deepEqual([...tools.keys()].sort(), [...FORMATTED, 'worktree_create'].sort());
  return { tools, mod };
}

const details = {
  worktree_list: { count: 1, worktrees: [{ name: 'demo', path: '/repo/demo', branch: 'feat/demo', kind: 'agent', status: 'live', issues: [7], assignedOdd: 'odd/tasks/active.md', odd: ['odd/tasks/discovered-only.md'] }] },
  worktree_close: { path: '/repo/demo', branch: 'feat/demo', removed: true, branchKept: true, warnings: ['legacy association dropped'], droppedOdd: ['old.md'] },
  worktree_session_open: { worktree: 'demo', path: '/repo/demo', sessionId: 'session-7', workspaceId: 'workspace-7', paneId: 'pane-7', resumed: true },
  worktree_warp: { name: 'demo', path: '/repo/demo', fromName: 'principal', from: '/repo', branch: 'feat/demo' },
};

for (const name of FORMATTED) {
  test(`${name}: registered execute formats successful text without changing its contract`, async () => {
    const { tools, mod } = await registeredTools();
    const image = { type: 'image', mimeType: 'image/png', data: 'fixture' };
    const raw = { content: [{ type: 'text', text: 'RAW DISCOVERY DUMP' }, image], details: details[name], isError: false, evidence: 'kept' };
    mod.produced.set(name, raw);
    const receiver = { identity: 'caller' };
    const args = ['call-7', { name: 'demo' }, { aborted: false }, () => {}, { cwd: '/repo' }];
    const result = await tools.get(name).execute.apply(receiver, args);
    assert.deepEqual(result, formatWorktreeModelResult(name, raw));
    assert.notStrictEqual(result, raw, 'successful model text actually passed through the adapter');
    assert.strictEqual(result.details, raw.details);
    assert.strictEqual(result.content[1], image);
    assert.equal(result.evidence, 'kept');
    assert.equal(result.isError, false);
    assert.doesNotMatch(result.content[0].text, /RAW DISCOVERY DUMP|discovered-only/);
    assert.strictEqual(mod.calls[0].receiver, receiver);
    assert.deepEqual(mod.calls[0].args, args);
    if (name === 'worktree_close') assert.match(result.content[0].text, /warning: legacy association dropped/);
  });
}

test('errors, partials and backend exceptions keep their identity and diagnostics', async () => {
  const { tools, mod } = await registeredTools();
  for (const name of FORMATTED) {
    for (const extra of [{ isError: true }, { isPartial: true }]) {
      const raw = { content: [{ type: 'text', text: 'exact failure diagnostic' }], details: details[name], ...extra };
      mod.produced.set(name, raw);
      assert.strictEqual(await tools.get(name).execute(), raw);
    }
    const failure = new Error('backend rejected');
    mod.produced.set(name, failure);
    await assert.rejects(tools.get(name).execute(), (error) => error === failure);
  }
});

test('a missing presentation module leaves registered execution untouched', async () => {
  const { tools, mod } = await registeredTools({ missingFormatter: true });
  for (const name of FORMATTED) {
    const raw = { content: [{ type: 'text', text: 'backend result' }], details: details[name] };
    mod.produced.set(name, raw);
    assert.strictEqual(await tools.get(name).execute(), raw);
  }
});

// S1/S6: the create tool is deliberately NOT in the adapter's list. Its text
// is already the short ordered form the agent reads (`created:`/`path:`/
// `codegraph:` plus one `warning:` row each), so the adapter leaves it alone —
// which is exactly what this pins.
test('worktree_create keeps its own ordered text: the adapter never rewrites it', async () => {
  const { tools, mod } = await registeredTools();
  const raw = {
    content: [{ type: 'text', text: 'created: demo \u00B7 feat/demo\npath: /repo/demo\ncodegraph: initialized' }],
    details: { branch: 'feat/demo', path: '/repo/demo', codegraph: { status: 'done', detail: '' } },
  };
  mod.produced.set('worktree_create', raw);
  const result = await tools.get('worktree_create').execute('call-7', { branch: 'feat/demo', changes: 'none' }, undefined, undefined, { cwd: '/repo' });
  assert.strictEqual(result, raw, 'the extension text reaches the model unchanged');
  assert.ok(!WORKTREE_MODEL_TOOLS.includes('worktree_create'), 'and the adapter has no create builder to drift from');
  assert.ok(!WORKTREE_MODEL_TOOLS.includes('worktree_upsert'), 'and none for the retired upsert name either');
});

// Extension wiring for the click-to-expand seam.
//
// The renderer's own seam lives in lib/worktree-card.js and is pinned there
// (tools/worktree-card-render.test.js). What THESE tests pin is the half the
// extension owns: which session supplies the toggle, that a session switch
// replaces it, that a session without a usable UI leaves the cards
// keyboard-only, and that a host-like press/click on the rendered hint really
// flips the host's expansion flag through BOTH registered renderer paths (the
// tool cards and the warp message card).
//
// They drive the registered renderers, not the lib factories, and the mouse
// dispatch goes through the real pi-tui primitives the host uses
// (`MouseRegion` for tool cards, `Container` for `CustomMessageComponent`), so
// the assertions cover the wiring the user clicks on, not a stand-in.

const THEME = { bold: (text) => text, fg: (_role, text) => text };

function stripAnsi(line) {
  return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
}

const HINT_TEXT = /ctrl\+o to (expand|collapse)/;

// The hint's own cell rectangle, read from the rendered card exactly like the
// card renderer measures it: the row it was drawn on plus its column range.
function hintCell(lines) {
  for (let row = 0; row < lines.length; row += 1) {
    const found = HINT_TEXT.exec(stripAnsi(lines[row]));
    if (found) return { row, start: found.index, end: found.index + found[0].length };
  }
  return undefined;
}

function renderLines(component, width) {
  const lines = component.render(width);
  assert.ok(Array.isArray(lines), 'the renderer returns component lines');
  return lines;
}

function mouseEvent(type, x, y, over) {
  return { type, button: 'left', x, y, width: 60, height: 8, shift: false, alt: false, ctrl: false, ...(over || {}) };
}

// The host's own gesture pipeline (pi-tui tui-alt-screen): the press records
// the claiming component, and the click is retargeted to it with the target's
// origin subtracted. A host MouseRegion wraps the tool card, so its handler
// must stay silent once the card claims the press.
function hostClick(region, lines, cell) {
  const press = { ...mouseEvent('press', cell.start, cell.row), screenX: cell.start, screenY: cell.row, height: lines.length };
  const pressResult = region.handleMouse(press);
  const click = { ...press, type: 'click' };
  const target = pressResult && pressResult.target;
  const localised = target
    ? { ...click, x: click.screenX - target.originX, y: click.screenY - target.originY, width: target.width, height: target.height }
    : click;
  const clickResult = target && target.component ? target.component.handleMouse(localised) : undefined;
  return { pressResult, clickResult, target };
}

// A session context shaped like the real ExtensionContext for this seam: the
// two methods the extension may use, plus a notify the other handlers expect.
function sessionContext() {
  const state = { expanded: false, writes: [] };
  const ui = {
    getToolsExpanded: () => state.expanded,
    setToolsExpanded: (value) => { state.expanded = value; state.writes.push(value); },
    notify: () => {},
  };
  return { state, ui, ctx: { hasUI: true, ui, cwd: '/repo/feat-cards' } };
}

// Loads the real extension with the backend and the host stubbed, capturing
// every handler it registers so a test can drive the session lifecycle.
async function loadedExtension() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-card-wiring-'));
  roots.push(root);
  process.env.GENTLE_STATUS_STATE_DIR = path.join(root, 'state');
  process.env.GENTLE_WORKTREE_LIB_DIR = path.resolve(__dirname, '../lib');
  const source = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts'), 'utf8')
    .replace('import { Type } from "@earendil-works/pi-ai";', 'const Type = new Proxy({}, { get: () => () => ({}) });')
    .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (definition) => definition;');
  const copy = path.join(root, 'extension.mjs');
  fs.writeFileSync(copy, source);
  const mod = await import(pathToFileURL(copy).href);
  const api = {
    tools: new Map(),
    handlers: [],
    renderers: new Map(),
    registerTool(tool) { api.tools.set(tool.name, tool); },
    registerCommand() {},
    registerMessageRenderer(customType, renderer) { api.renderers.set(customType, renderer); },
    on(event, handler) { api.handlers.push({ event, handler }); return () => {}; },
  };
  mod.default(api);
  // Handler lookup by the named function the extension registers: the seam's
  // lifecycle hooks carry their own names, so a test drives exactly those and
  // never the session-side effects of the other startup handlers.
  api.handler = (event, name) => {
    const found = api.handlers.find((entry) => entry.event === event && entry.handler.name === name);
    assert.ok(found, `the extension registers the ${name} ${event} handler`);
    return found.handler;
  };
  return { api, root };
}

function callContext(overrides) {
  return {
    args: { branch: 'feat/cards' },
    state: {},
    toolCallId: 'call-7',
    cwd: '/repo',
    isPartial: false,
    expanded: false,
    isError: false,
    outputPad: 0,
    ...(overrides || {}),
  };
}

function warpMessage() {
  return {
    customType: 'worktree-warp',
    content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
    display: true,
    details: {
      from: '/repo/from',
      to: '/repo/to',
      fromDesc: 'principal \u00B7 main',
      fromName: 'principal',
      name: 'feat-cards',
      branch: 'feat/cards',
    },
  };
}

function requireTui(t) {
  try {
    const tui = require('@earendil-works/pi-tui');
    if (!tui || typeof tui.MouseRegion !== 'function' || typeof tui.Container !== 'function' || typeof tui.Spacer !== 'function') return null;
    return tui;
  } catch {
    return null;
  }
}

test('a session click on the tool card hint flips the host expansion flag it owns', async () => {
  const tui = requireTui();
  assert.ok(tui, 'the installed pi-tui primitives are available to drive the host dispatch');
  const { api } = await loadedExtension();
  const session = sessionContext();
  api.handler('session_start', 'rememberWorktreeCardUi')({}, session.ctx);

  const tool = api.tools.get('worktree_create');
  const component = tool.renderCall({ branch: 'feat/cards' }, THEME, callContext());
  assert.equal(typeof component.handleMouse, 'function', 'the extension injects the toggle, so the card exposes the seam');
  const lines = renderLines(component, 60);
  const cell = hintCell(lines);
  assert.ok(cell, `the settled card renders its hint: ${JSON.stringify(lines.map(stripAnsi))}`);

  const hostToggles = [];
  const region = new tui.MouseRegion(component, (event) => {
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    hostToggles.push('host');
    return { handled: true };
  });
  const first = hostClick(region, lines, cell);
  assert.ok(first.pressResult && first.pressResult.handled === true, 'the press is claimed so the host retargets the click');
  assert.strictEqual(first.target.component, component, 'the gesture target is the registered card component');
  assert.ok(first.clickResult && first.clickResult.handled === true, 'the retargeted click is handled by the card');
  assert.deepStrictEqual(session.state.writes, [true], 'the click called the session UI exactly once, with the flipped value');
  assert.equal(session.state.expanded, true, 'the host expansion flag really is on');
  assert.deepStrictEqual(hostToggles, [], 'the host MouseRegion did not toggle a second time');

  // The callback reads the LIVE flag: the re-rendered collapsed-by-default card
  // now offers collapse, and clicking it flips the same flag back.
  const collapsed = tool.renderCall({ branch: 'feat/cards' }, THEME, callContext({ expanded: session.state.expanded }));
  const collapsedLines = renderLines(collapsed, 60);
  const collapsedCell = hintCell(collapsedLines);
  assert.ok(collapsedCell, 'the expanded card renders the collapse hint');
  assert.ok(stripAnsi(collapsedLines[collapsedCell.row]).includes('ctrl+o to collapse'));
  const second = hostClick(new tui.MouseRegion(collapsed, () => undefined), collapsedLines, collapsedCell);
  assert.ok(second.clickResult && second.clickResult.handled === true);
  assert.deepStrictEqual(session.state.writes, [true, false], 'the second click flips the live flag back');
  assert.equal(session.state.expanded, false);
});

test('the registered warp message card toggles the same session flag on a container-dispatched click', async () => {
  const tui = requireTui();
  assert.ok(tui, 'the installed pi-tui primitives are available to drive the host dispatch');
  const { api } = await loadedExtension();
  const session = sessionContext();
  api.handler('session_start', 'rememberWorktreeCardUi')({}, session.ctx);

  const renderer = api.renderers.get('worktree-warp');
  assert.equal(typeof renderer, 'function', 'the warp message renderer is registered');
  const component = renderer(warpMessage(), { expanded: false, outputPad: 0 }, THEME);
  assert.equal(typeof component.handleMouse, 'function', 'the message card gets the same session toggle');
  const lines = renderLines(component, 60);
  const cell = hintCell(lines);
  assert.ok(cell, 'the warp heading carries the hint');

  // CustomMessageComponent is a Container that opens with a one-row Spacer, so
  // the card starts one row down and the container forwards with that offset.
  const container = new tui.Container();
  container.addChild(new tui.Spacer(1));
  container.addChild(component);
  const height = lines.length + 1;
  const press = { ...mouseEvent('press', cell.start, cell.row + 1), screenX: cell.start, screenY: cell.row + 1, height };
  const pressResult = container.handleMouse(press);
  assert.ok(pressResult && pressResult.handled === true, 'the message container forwards the claimed press');
  assert.strictEqual(pressResult.target.component, component, 'the message gesture target is the card component');
  const click = { ...press, type: 'click' };
  const localised = {
    ...click,
    x: click.screenX - pressResult.target.originX,
    y: click.screenY - pressResult.target.originY,
    width: pressResult.target.width,
    height: pressResult.target.height,
  };
  const clickResult = pressResult.target.component.handleMouse(localised);
  assert.ok(clickResult && clickResult.handled === true, 'the warp click is handled');
  assert.deepStrictEqual(session.state.writes, [true], 'the warp click toggled the session flag exactly once');
});

test('a session switch replaces the toggle instead of reusing an invalidated context', async () => {
  const tui = requireTui();
  assert.ok(tui, 'the installed pi-tui primitives are available to drive the host dispatch');
  const { api } = await loadedExtension();
  const first = sessionContext();
  const second = sessionContext();
  api.handler('session_start', 'rememberWorktreeCardUi')({}, first.ctx);

  const tool = api.tools.get('worktree_create');
  // Drawn while the FIRST session was live…
  const component = tool.renderCall({ branch: 'feat/cards' }, THEME, callContext());
  const lines = renderLines(component, 60);
  const cell = hintCell(lines);
  assert.ok(cell);

  // …then the session is replaced, so the old context is invalid.
  api.handler('session_shutdown', 'forgetWorktreeCardUi')({});
  api.handler('session_start', 'rememberWorktreeCardUi')({}, second.ctx);

  const dispatch = hostClick(new tui.MouseRegion(component, () => undefined), lines, cell);
  assert.ok(dispatch.clickResult && dispatch.clickResult.handled === true);
  assert.deepStrictEqual(second.state.writes, [true], 'the click reaches the CURRENT session');
  assert.deepStrictEqual(first.state.writes, [], 'the invalidated session context is never reused');
});

test('no usable UI keeps the cards keyboard-only: nothing to claim, nothing to throw', async () => {
  const { api } = await loadedExtension();
  const tool = api.tools.get('worktree_create');
  const renderer = api.renderers.get('worktree-warp');

  function assertKeyboardOnly(label) {
    const component = tool.renderCall({ branch: 'feat/cards' }, THEME, callContext());
    assert.equal(typeof component.handleMouse, 'undefined', `${label}: the tool card exposes no mouse seam`);
    assert.equal(typeof component.render, 'function', `${label}: the tool card still renders`);
    assert.equal(typeof component.invalidate, 'function', `${label}: the tool card still invalidates`);
    const lines = renderLines(component, 60);
    assert.ok(hintCell(lines), `${label}: the ctrl+o hint still tells the keyboard path`);
    const warp = renderer(warpMessage(), { expanded: false, outputPad: 0 }, THEME);
    assert.equal(typeof warp.handleMouse, 'undefined', `${label}: the warp card exposes no mouse seam`);
  }

  // Before any session started, in a session with no UI capability, and in a
  // session whose UI lacks the two expansion methods.
  assertKeyboardOnly('no session');
  api.handler('session_start', 'rememberWorktreeCardUi')({}, { hasUI: false, ui: sessionContext().ui, cwd: '/repo' });
  assertKeyboardOnly('hasUI false');
  api.handler('session_start', 'rememberWorktreeCardUi')({}, { hasUI: true, ui: { notify: () => {} }, cwd: '/repo' });
  assertKeyboardOnly('ui without the expansion methods');

  // A live session owns the seam, and shutting it down gives it back.
  api.handler('session_start', 'rememberWorktreeCardUi')({}, sessionContext().ctx);
  assert.equal(typeof tool.renderCall({ branch: 'feat/cards' }, THEME, callContext()).handleMouse, 'function', 'a live session wires the seam');
  api.handler('session_shutdown', 'forgetWorktreeCardUi')({});
  assertKeyboardOnly('after shutdown');
});

test('a hostile host UI never breaks the card: a throwing toggle stays contained', async () => {
  const { api } = await loadedExtension();
  const ui = {
    getToolsExpanded: () => { throw new Error('host is not ready'); },
    setToolsExpanded: () => {},
    notify: () => {},
  };
  api.handler('session_start', 'rememberWorktreeCardUi')({}, { hasUI: true, ui, cwd: '/repo' });
  const component = api.tools.get('worktree_create').renderCall({ branch: 'feat/cards' }, THEME, callContext());
  const lines = renderLines(component, 60);
  const cell = hintCell(lines);
  assert.ok(cell);
  assert.equal(typeof component.handleMouse, 'function');
  // The card's seam catches a throwing callback, so the click is still claimed
  // without propagating the host's failure into the transcript.
  const result = component.handleMouse(mouseEvent('click', cell.start, cell.row));
  assert.ok(result && result.handled === true, 'the click is handled even when the host UI throws');
});

test('with no session the registered renderers are byte-identical to the plain card factory', async () => {
  // PRESERVE: the wiring is injectable and inert. Before the extension had a
  // session UI to hand over, its renderers were the card factory's own hooks;
  // that must stay true byte for byte, so nothing but the seam's presence
  // changes when a session arrives.
  const { api } = await loadedExtension();
  const cards = require('../lib/worktree-card.js');
  for (const tool of ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open', 'worktree_warp']) {
    const plain = cards.createWorktreeCardRenderer(tool);
    for (const expanded of [false, true]) {
      const context = callContext({ expanded });
      const registered = api.tools.get(tool);
      assert.deepStrictEqual(
        renderLines(registered.renderCall(context.args, THEME, context), 60),
        renderLines(plain.renderCall(context.args, THEME, context), 60),
        `${tool}: the call card matches the factory (expanded=${expanded})`,
      );
      const result = { content: [{ type: 'text', text: 'done: feat-cards' }], details: {} };
      assert.deepStrictEqual(
        renderLines(registered.renderResult(result, { expanded, isPartial: false }, THEME, context), 60),
        renderLines(plain.renderResult(result, { expanded, isPartial: false }, THEME, context), 60),
        `${tool}: the result card matches the factory (expanded=${expanded})`,
      );
    }
  }
  const warp = cards.createWarpMessageRenderer();
  const registeredWarp = api.renderers.get('worktree-warp');
  for (const expanded of [false, true]) {
    assert.deepStrictEqual(
      renderLines(registeredWarp(warpMessage(), { expanded, outputPad: 1 }, THEME), 60),
      renderLines(warp(warpMessage(), { expanded, outputPad: 1 }, THEME), 60),
      `the warp card matches the factory (expanded=${expanded})`,
    );
  }
  // A foreign customType still falls through to the host's default renderer.
  assert.equal(registeredWarp({ customType: 'other', content: 'x' }, { expanded: false }, THEME), undefined);
});
