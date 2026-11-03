'use strict';
// S11 tests: a surface that needs a checkout answers a directory that is
// not a Git repository with ONE identical line and opens nothing.
//
// The `/herdr-gentle:warp` selector suite lives in
// tools/customize-warp.test.js (moved there verbatim); this file pins the
// warp surface's checkout guard, which the selector suite does not own:
// the no-argument command path and the `worktree_warp` tool must hand the
// agent the same sentence a human reads.
//
// Loading pattern mirrors tools/customize-warp.test.js: the TypeScript
// extension is plain JS under the hood, so the test copies it to a
// temporary .mjs with the package import lines stubbed and import()s it
// with a fake `pi` object. Only observable behavior is asserted.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

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
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv() {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

// A plain directory that is deliberately NOT a Git repository.
function plainDir(tag) {
  return fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-warp-${tag}-`))));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-warp-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

// gentle-shell answers YOLO questions on this channel with an adapter whose
// read() is 'ON' only while the live session holds the grant (upstream
// lib/yolo-session-policy.ts). `null` stands for a host that never answers.
let yoloResponder = null;

function answerYolo(display) {
  yoloResponder = (channel, payload) => {
    if (channel !== 'gentle:yolo:host-ui') return;
    if (display === null) return;
    payload.respond({ read: async () => display, dispose: () => {} });
  };
}

function resetYolo() {
  yoloResponder = null;
}

async function loadExtension({ sendUserMessage } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    registerMessageRenderer: () => {},
    on: () => () => {},
    ...(sendUserMessage ? { sendUserMessage } : {}),
    events: {
      emit: (channel, payload) => {
        if (typeof yoloResponder === 'function') yoloResponder(channel, payload);
      },
    },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, commands, mod };
}

function warpDef(commands) {
  const def = commands.get('herdr-gentle:warp');
  assert.ok(def, 'expected the herdr-gentle:warp command to be registered');
  assert.equal(typeof def.handler, 'function');
  return def;
}

function makeCtx({ cwd, customImpl, selectImpl } = {}) {
  const notes = [];
  const customs = [];
  const selects = [];
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
  return { ctx, notes, customs, selects };
}

const expectedLine = (cwd) => `not a git repository: ${cwd}; run 'git init' first`;

describe('/herdr-gentle:warp outside a Git checkout (S11)', { concurrency: false }, () => {
  test('the no-argument command notifies the one line at info and opens no overlay', async () => {
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-state-'))),
    });
    try {
      const outside = plainDir('cmd-outside');
      const { commands } = await loadExtension();
      const { ctx, notes, customs, selects } = makeCtx({ cwd: outside, customImpl: async () => null });
      await warpDef(commands).handler('', ctx);
      assert.equal(customs.length, 0, 'no overlay outside a checkout');
      assert.equal(selects.length, 0, 'no fallback selector outside a checkout');
      assert.deepEqual(notes, [[expectedLine(outside), 'info']], 'exactly the one shared line');
    } finally {
      restoreEnv();
    }
  });

  test('the worktree_warp tool returns the same sentence as an error result', async () => {
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-state-'))),
    });
    try {
      const outside = plainDir('tool-outside');
      const { tools } = await loadExtension({ sendUserMessage: () => { throw new Error('must not dispatch outside a repository'); } });
      const tool = tools.get('worktree_warp');
      assert.ok(tool, 'expected worktree_warp to be registered');
      const switched = [];
      const ctx = {
        cwd: outside,
        switchSession: async () => { switched.push(true); },
        ui: { notify: () => {} },
      };
      const out = await tool.execute('call-1', { name: 'somewhere' }, undefined, undefined, ctx);
      assert.equal(out.isError, true, 'the agent reads it as an error result');
      assert.equal(out.content[0].text, expectedLine(outside), 'the agent reads the same sentence');
      assert.deepEqual(switched, [], 'nothing was switched');
    } finally {
      restoreEnv();
    }
  });

  test('inside a checkout the ordinary no-other-checkout path is unchanged', async () => {
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-state-'))),
    });
    try {
      const root = makeRepo('cmd-inside');
      const { commands } = await loadExtension();
      // No ctx.ui.custom: the plain select path, exactly as before this
      // change. With no other checkout the selector is never reached.
      const { ctx, notes, customs, selects } = makeCtx({ cwd: root });
      await warpDef(commands).handler('', ctx);
      assert.deepEqual(notes, [['warp: no other checkout to move the session to', 'info']]);
      assert.equal(customs.length, 0, 'no overlay');
      assert.equal(selects.length, 0, 'no selector when there is nothing to offer');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// W5 wiring: the redesigned surface (the popup overlay, its warp/create
// completions, the extended-list delete flow, the rejected-overlay fallback,
// and the byte-identical explicit-name path). Driving is observable-only:
// the mounted component is fed raw keys and the harness records what the
// command did (custom options, select/confirm calls, session switches).

const registryLib = require('../lib/worktree-registry.js');
const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text), bold: (text) => String(text) };
const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function addRegisteredWorktree(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-wired-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const real = fs.realpathSync(target);
  const upserted = registryLib.upsertWorktree(root, { branch, path: real, thread: 'thread-1', issues: [], odd: null });
  assert.equal(upserted.ok, true, `registry upsert failed: ${upserted.error}`);
  return real;
}

// S4 (round 3): these repositories are created with `git init`, whose default
// branch is `master`, so the deletion prompt's ahead-of-MAIN read has no base
// to compare with. A test that creates `main` here pins a KNOWN ahead count
// (0 unless the target gained commits); a test that omits it is deliberately
// the "main missing" case whose evidence must read as unknown, never as 0.
function addMainBranch(root) {
  git(root, ['branch', 'main', 'HEAD']);
}

// SessionManager double: the warp resolves the class from the instance's own
// constructor when the package import does not resolve (plain-node copies),
// so this fake is what makes a real move observable.
function makeFakeSM(calls) {
  class FakeTarget {
    constructor(cwd, dir, file, carried) {
      this.cwd = cwd;
      this.dir = dir;
      this.file = file;
      this.carried = Array.isArray(carried) ? carried : [];
      this.leaf = null;
    }
    getSessionFile() { return this.file; }
    getEntries() { return this.carried; }
    getLeafId() { return this.leaf === undefined ? null : this.leaf; }
    branch(id) { this.leaf = id; }
    resetLeaf() { this.leaf = null; }
    appendCustomEntry(type, data) {
      const id = `warp-entry-${this.carried.length + 1}`;
      this.carried.push({ id, parentId: this.leaf, type: 'custom', customType: type, data });
      this.leaf = id;
      return id;
    }
    appendSessionInfo(name) {
      const id = `session-info-${this.carried.length + 1}`;
      this.carried.push({ id, parentId: this.leaf, type: 'session_info', name });
      this.leaf = id;
      return id;
    }
    _appendEntry(entry) { this.carried.push(entry); }
  }
  return class FakeSM {
    static forkFrom(sourcePath, targetCwd, sessionDir) {
      calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
      const file = path.join(targetCwd, 'forked-session.jsonl');
      fs.writeFileSync(file, '{"type":"session"}\n');
      return new FakeTarget(targetCwd, sessionDir, file, []);
    }
    static create(cwd, sessionDir) {
      calls.push(['create', cwd, sessionDir]);
      return { getSessionFile: () => path.join(cwd, 'created-session.jsonl'), getHeader: () => ({ type: 'session', cwd }) };
    }
    static open(file, sessionDir, cwdOverride) {
      calls.push(['open', file, sessionDir, cwdOverride]);
      return new FakeTarget(cwdOverride, sessionDir, file);
    }
  };
}

function sessionFileIn() {
  const file = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-wired-sess-'))), 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session"}\n');
  return file;
}

// A command context whose `ui.custom` delegate decides how each mounted
// component is driven. `mount(factory, options)` is awaited by the handler,
// exactly like the real host: it must resolve the component's `done`.
function makeWiredCtx({ cwd, FakeSM, sessionFile, sessionDir, calls, mount, selectImpl, confirmImpl }) {
  const notes = [];
  const customs = [];
  const selects = [];
  const confirms = [];
  const switches = [];
  const waited = [];
  const sent = [];
  const sm = new FakeSM();
  Object.assign(sm, {
    getSessionFile: () => sessionFile,
    getLeafId: () => 'leaf-1',
    getEntries: () => [],
    getSessionDir: () => sessionDir,
  });
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => { notes.push([message, level]); },
      setStatus: () => {},
      select: async (title, options) => {
        selects.push([title, options]);
        return typeof selectImpl === 'function' ? selectImpl(title, options) : selectImpl;
      },
      confirm: async (title, body) => {
        confirms.push([title, body]);
        return typeof confirmImpl === 'function' ? confirmImpl(title, body) : confirmImpl;
      },
    },
    sessionManager: sm,
    waitForIdle: async () => { waited.push(true); },
    switchSession: async (file, options) => {
      switches.push([file, typeof options?.withSession]);
      if (typeof options?.withSession === 'function') {
        await options.withSession({ ui: { setStatus: () => {} }, sendMessage: async (message, sendOptions) => { sent.push([message, sendOptions]); } });
      }
      return { cancelled: false };
    },
  };
  if (mount) {
    ctx.ui.custom = async (factory, options) => {
      customs.push(options);
      return mount(factory, options);
    };
  }
  return { ctx, notes, customs, selects, confirms, switches, waited, sent };
}

function warpStateEnv(extra) {
  return {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-wired-state-'))),
    ...(extra || {}),
  };
}

// Mount the popup (first custom mount) and drive it with `keys`; later mounts
// resolve themselves by pressing Esc. Returns the captured component.
function selectorDriver(keys) {
  const views = [];
  let mounts = 0;
  const mount = async (factory) => {
    mounts += 1;
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('warp selector did not settle')), 3000);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      let view;
      try {
        view = factory(hostTui, plainTheme, {}, done);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      views.push(view);
      try {
        if (mounts === 1) for (const key of keys) view.handleInput(key);
        else view.handleInput('\x1b');
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  };
  return { mount, views, mounts: () => mounts };
}

describe('W5 wiring: the redesigned warp surface', { concurrency: false }, () => {
  test('no argument mounts the popup as an overlay sized for its rows', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-popup');
      addRegisteredWorktree(root, 'feat/one');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      let rendered = '';
      const mount = async (factory) => new Promise((resolve) => {
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        const view = factory(hostTui, plainTheme, {}, resolve);
        rendered = clean(view.render(80).join('\n'));
        view.handleInput('\x1b');
      });
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.customs.length, 1, 'the popup mounted once');
      const options = built.customs[0];
      assert.equal(options.overlay, true, 'the panel is an overlay');
      // T3/S3-S4: a bottom panel, not a centred popup box. Its height is the
      // view's own content, so no maxHeight and no minimum width are pinned.
      assert.equal(options.overlayOptions.anchor, 'bottom-center');
      assert.equal(options.overlayOptions.width, '100%');
      assert.equal(options.overlayOptions.margin, 0);
      assert.equal(options.overlayOptions.minWidth, undefined, 'full width needs no minimum');
      assert.equal(options.overlayOptions.maxHeight, undefined, 'the panel computes its own height');
      assert.match(rendered, /Warp/, 'the panel title renders');
      assert.match(rendered, /feat-one/, 'the registered worktree renders as a row');
      assert.ok(!rendered.includes('create a worktree'), 'S6: creation is a hotkey, not a row');
      assert.deepEqual(built.notes, [], 'Esc is silent');
    } finally {
      restoreEnv();
    }
  });

  test('{warp} reaches the warp execution and moves the session', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-warp');
      const target = addRegisteredWorktree(root, 'feat/warp-target');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['\r']); // enter on the first (only) worktree row
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: driver.mount });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.switches.length, 1, 'the session switched');
      assert.equal(calls[0][0], 'forkFrom', 'the warp forked the session');
      assert.equal(calls[0][2], target, 'the fork landed in the chosen checkout');
      assert.deepEqual(built.notes, [], 'a real move is silent (the card confirms)');
      assert.equal(built.sent.length, 1, 'exactly one confirmation card');
      assert.equal(built.sent[0][0].customType, 'worktree-warp');
    } finally {
      restoreEnv();
    }
  });

  test('{create} opens the single create panel as an overlay', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-create-open');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['c']); // S6: the create hotkey
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: driver.mount });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      // S7: `esc` on the create panel cancels the CREATION and hands the
      // selector back, so the flow mounts the selector, the create panel, then
      // the selector again — closing that one is what ends it.
      assert.equal(built.customs.length, 3, 'the selector, the create panel, then the selector again');
      assert.equal(built.customs[1].overlay, true, 'the create panel is an overlay too');
      assert.equal(built.customs[2].overlay, true, 'the returned selector is the same bottom overlay');
      assert.ok(!built.notes.some(([message]) => /nothing was created/.test(message)), 'no create failure');
    } finally {
      restoreEnv();
    }
  });

  // S7: creation is CREATION. The panel payload still reaches the one
  // creation path (same branch, same registry row), and then the SELECTOR
  // comes back with a fresh listing so the human picks any checkout —
  // including the one just created. Nothing warps on its own any more: the
  // created checkout is a row, never an automatic move.
  test('the panel payload creates the branch and the selector comes back with it selectable (S7)', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-run');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: async () => null });
      const { commands } = await loadExtension();
      let mounts = 0;
      let returnedSelector = null;
      let switchesAfterCreation = null;
      built.ctx.ui.custom = async (factory, options) => {
        mounts += 1;
        built.customs.push(options);
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('component did not settle')), 3000);
          const done = (value) => { clearTimeout(timer); resolve(value); };
          let view;
          try {
            view = factory(hostTui, plainTheme, {}, done);
          } catch (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          const drive = () => {
            try {
              if (mounts === 1) {
                view.handleInput('c'); // S6: the create hotkey
                return;
              }
              if (mounts === 2) {
                view.handleInput('\x1b[B'); // the inline type list moves to Bug fix
                view.handleInput('\x1b[A'); // and back to Feature, the expected type
                view.handleInput('\t'); // Tab hands the flow to the name field
                for (const char of 'panel-change') view.handleInput(char);
                view.handleInput('enter'); // enter creates
                return;
              }
              // S7: the SELECTOR is back — nothing has been warped yet.
              returnedSelector = view;
              switchesAfterCreation = built.switches.length;
              const others = view.state.checkouts.filter((entry) => entry.path !== root);
              const at = others.findIndex((entry) => entry.name === 'feat-panel-change');
              assert.ok(at >= 0, `the created checkout is a selectable row (${JSON.stringify(others.map((e) => e.name))})`);
              for (let step = 0; step < at; step += 1) view.handleInput('\x1b[B');
              view.handleInput('\r'); // now the human chooses it
            } catch (err) {
              clearTimeout(timer);
              reject(err);
            }
          };
          if (mounts === 1) drive();
          else tick().then(drive);
        });
      };
      await warpDef(commands).handler('', built.ctx);
      const rows = registryLib.readRegistry(root).worktrees;
      const created = rows.find((row) => row.branch === 'feat/panel-change');
      assert.ok(created, `the payload branch was created and registered (${JSON.stringify(rows)})`);
      assert.equal(created.thread, 'wired-thread');
      assert.deepEqual(created.issues, [], 'S6: a created row carries no issue association');
      assert.equal(created.odd, null, 'S6: a created row carries no odd association');
      // S7: the panel closed into the selector, not into a warp.
      assert.equal(mounts, 3, 'the selector mounted again after the creation panel closed');
      assert.ok(returnedSelector !== null, 'the returning surface is the warp selector');
      assert.equal(switchesAfterCreation, 0, 'S7: creating never warps by itself');
      // ...and the human picking that row is the ONE warp of this flow.
      assert.equal(built.switches.length, 1, 'the chosen checkout is where the session went');
      assert.equal(calls[0][0], 'forkFrom', 'the first visit to a fresh checkout forks');
      assert.equal(calls[0][2], created.path, 'the warp landed in the created checkout');
      assert.deepEqual(built.notes, [], 'creating and warping are silent on success');
    } finally {
      restoreEnv();
    }
  });

  // S7: a REFUSED creation must say WHY. The create path answers a TOOL result
  // (`{content:[{type:"text",text}], isError}`), not a warp failure (`{text}`),
  // so reading `.text` off it notified `undefined` and the human saw no reason
  // at all — the flow just closed. The refusal is reported in the create path's
  // own words, the selector comes back, and nothing was created.
  test('a refused creation reports the create path\'s own reason and mutates nothing (S7)', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-refused');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      // The canonical target of the branch the panel derives is occupied by a
      // FILE: the occupancy guard refuses before any branch or registry write.
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-occupied-change');
      track(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'occupant\n');
      const before = createdState(root);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: async () => null });
      const { commands } = await loadExtension();
      let mounts = 0;
      built.ctx.ui.custom = async (factory, options) => {
        mounts += 1;
        built.customs.push(options);
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('component did not settle')), 3000);
          const done = (value) => { clearTimeout(timer); resolve(value); };
          let view;
          try {
            view = factory(hostTui, plainTheme, {}, done);
          } catch (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          const drive = () => {
            try {
              if (mounts === 1) {
                view.handleInput('c'); // the create hotkey
                return;
              }
              if (mounts === 2) {
                view.handleInput('\t'); // Tab hands the flow to the name field
                for (const char of 'occupied-change') view.handleInput(char);
                view.handleInput('enter'); // enter asks to create it
                return;
              }
              view.handleInput('\x1b'); // the returned selector closes: nothing chosen
            } catch (err) {
              clearTimeout(timer);
              reject(err);
            }
          };
          if (mounts === 1) drive();
          else tick().then(drive);
        });
      };
      await warpDef(commands).handler('', built.ctx);

      assert.equal(mounts, 3, 'the selector came back after the refused creation');
      assert.deepEqual(built.switches, [], 'a refused creation moves nothing');
      assert.deepEqual(createdState(root), before, 'no branch, no checkout and no registry row');
      assert.ok(fs.existsSync(target), 'the occupant is untouched');
      const errors = built.notes.filter(([, level]) => level === 'error');
      assert.equal(errors.length, 1, `exactly one refusal is reported, got ${JSON.stringify(built.notes)}`);
      const [message] = errors[0];
      assert.equal(typeof message, 'string', `the refusal carries text, never undefined (${JSON.stringify(built.notes)})`);
      assert.ok(message.includes(target), `the refusal names the occupied path: ${message}`);
      assert.match(message, /occup/i, `the create path's own reason reaches the human: ${message}`);
    } finally {
      restoreEnv();
    }
  });

  // S7: `esc` in the create panel cancels the CREATION, not the warp flow. The
  // selector comes back with everything it offered before, so a human who
  // changes their mind about the name still gets to pick any checkout —
  // including one they just created — and `esc` on THAT selector is what
  // closes the flow.
  test('cancelling the create panel returns to the selector, and Esc there closes it (S7)', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-cancel');
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: async () => null });
      const { commands } = await loadExtension();
      let mounts = 0;
      let returnedSelector = null;
      let switchesAfterCancel = null;
      built.ctx.ui.custom = async (factory, options) => {
        mounts += 1;
        built.customs.push(options);
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('component did not settle')), 3000);
          const done = (value) => { clearTimeout(timer); resolve(value); };
          let view;
          try {
            view = factory(hostTui, plainTheme, {}, done);
          } catch (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          const drive = () => {
            try {
              if (mounts === 1) {
                view.handleInput('c'); // the create hotkey
                return;
              }
              if (mounts === 2) {
                view.handleInput('\t'); // Tab hands the flow to the name field
                for (const char of 'never-created') view.handleInput(char);
                view.handleInput('\x1b'); // esc cancels the CREATION
                return;
              }
              // the SELECTOR is back, with nothing created
              returnedSelector = view;
              switchesAfterCancel = built.switches.length;
              view.handleInput('\x1b'); // esc on the selector closes the flow
            } catch (err) {
              clearTimeout(timer);
              reject(err);
            }
          };
          if (mounts === 1) drive();
          else tick().then(drive);
        });
      };
      await warpDef(commands).handler('', built.ctx);

      assert.equal(mounts, 3, 'the selector remounted after the create panel was cancelled');
      assert.ok(returnedSelector !== null, 'the returning surface is the warp selector');
      assert.equal(switchesAfterCancel, 0, 'a cancelled creation moves nothing');
      assert.deepEqual(built.switches, [], 'esc on the returned selector closes without a move');
      assert.deepEqual(createdState(root), before, 'no branch, no checkout and no registry row');
      const others = returnedSelector.state.checkouts.filter((entry) => entry.path !== root);
      assert.ok(
        others.some((entry) => entry.name === 'feat-one'),
        `the existing checkouts are offered again (${JSON.stringify(others.map((entry) => entry.name))})`,
      );
      assert.ok(!others.some((entry) => entry.name === 'feat-never-created'), 'the cancelled name was never created');
      assert.deepEqual(built.notes, [], 'cancelling is silent');
    } finally {
      restoreEnv();
    }
  });

  test('S7: leaving the returned selector without choosing moves nothing', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-back');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      const calls = [];
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({
        cwd: root,
        FakeSM: makeFakeSM(calls),
        sessionFile,
        sessionDir: path.dirname(sessionFile),
        calls,
        mount: async () => null,
      });
      const { commands } = await loadExtension();
      let mounts = 0;
      let switchesAfterCreation = null;
      built.ctx.ui.custom = async (factory) => {
        mounts += 1;
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('component did not settle')), 3000);
          const done = (value) => { clearTimeout(timer); resolve(value); };
          let view;
          try {
            view = factory(hostTui, plainTheme, {}, done);
          } catch (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          const drive = () => {
            try {
              if (mounts === 1) view.handleInput('c');
              else if (mounts === 2) {
                view.handleInput('\t');
                for (const char of 'back-out') view.handleInput(char);
                view.handleInput('enter');
              } else {
                switchesAfterCreation = built.switches.length;
                view.handleInput('\x1b'); // close the selector: nothing chosen
              }
            } catch (err) {
              clearTimeout(timer);
              reject(err);
            }
          };
          if (mounts === 1) drive();
          else tick().then(drive);
        });
      };
      await warpDef(commands).handler('', built.ctx);
      assert.equal(mounts, 3, 'the selector came back after the creation');
      assert.equal(switchesAfterCreation, 0, 'S7: the creation did not warp');
      assert.deepEqual(built.switches, [], 'closing the selector moves nothing');
      assert.deepEqual(built.notes, [], 'and it notifies nothing');
      assert.ok(registryLib.readRegistry(root).worktrees.some((row) => row.branch === 'feat/back-out'), 'the created branch stays registered');
    } finally {
      restoreEnv();
    }
  });

  test('a rejected overlay falls back to the plain select list', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-fallback');
      const target = addRegisteredWorktree(root, 'feat/fb');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: async () => { throw new Error('overlay rejected by the host'); },
        selectImpl: (title, options) => options[0],
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.selects.length, 1, 'the plain select list opened as the fallback');
      assert.equal(built.switches.length, 1, 'the fallback still warps');
      assert.equal(calls[0][2], target);
    } finally {
      restoreEnv();
    }
  });

  test('warp <name> is byte-identical: the explicit path opens nothing and stays silent', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-explicit');
      const target = addRegisteredWorktree(root, 'feat/warp-target');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: async () => { throw new Error('warp <name> must never mount a UI'); },
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('feat-warp-target', built.ctx);
      assert.equal(built.customs.length, 0, 'no selector or panel mounted');
      assert.deepEqual(built.selects, [], 'no select fallback');
      assert.deepEqual(built.notes, [], 'success is silent (the card confirms)');
      assert.equal(built.switches.length, 1);
      assert.equal(calls[0][2], target);
      // Already-there stays byte-identical too: silent, no switch, no card.
      const before = { notes: built.notes.length, switches: built.switches.length, sent: built.sent.length };
      await warpDef(commands).handler('principal', built.ctx);
      assert.deepEqual(built.notes.length, before.notes);
      assert.deepEqual(built.switches.length, before.switches);
      assert.deepEqual(built.sent.length, before.sent);
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// T12: the EDITING mode end to end (S13) and the panes' source order (S15).
// `e` on a checkout row opens the same single panel with the type and the
// name frozen; the panes open pre-selected from the registry; confirming
// writes both assignment fields in ONE registry write, `esc` writes nothing,
// and a refusing registry keeps its error without changing what is shown.

// A commit dated in the past: last activity is then deterministic instead of
// "now" for every checkout the ordering test mounts.
function commitAt(cwd, message, iso) {
  const result = spawnSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
  assert.equal(result.status, 0, `git commit failed: ${result.stderr}`);
}

// Let the panel's own async loads settle (issue fetch, odd listing, previews).
function flush() {
  const pending = [];
  for (let i = 0; i < 8; i += 1) pending.push(new Promise((resolve) => setImmediate(resolve)));
  return Promise.all(pending);
}

// Mount every overlay in turn: `steps[index]` is a list of raw keys or a
// function that drives that mount. Mounts past the scripted steps close with
// Esc. The selector's first mount drives synchronously (it loads nothing);
// every later mount is driven after a flush, so a panel's data is ready.
function multiDriver(steps) {
  const views = [];
  let mounts = 0;
  const mount = async (factory) => {
    mounts += 1;
    const index = mounts - 1;
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('component did not settle')), 3000);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      let view;
      try {
        view = factory(hostTui, plainTheme, {}, done);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      views.push(view);
      const step = steps[index];
      const drive = () => {
        try {
          if (typeof step === 'function') step(view);
          else for (const key of (step || ['\x1b'])) view.handleInput(key);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      };
      if (index === 0) drive();
      else flush().then(drive);
    });
  };
  return { mount, views, mounts: () => mounts };
}

// S1: the popup now mounts before its facts arrive, so a wiring test that
// asserts activity order must let the background enrichment land. Poll the
// mounted component's public state until every row carries an activity, or
// the bounded wait runs out.
async function waitForActivity(view, tries = 400) {
  for (let i = 0; i < tries; i += 1) {
    const rows = view && view.state && Array.isArray(view.state.checkouts) ? view.state.checkouts : [];
    if (rows.length > 0 && rows.every((row) => row.lastActivity !== null && row.lastActivity !== undefined)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// A driver whose FIRST mount waits for the background enrichment before it
// presses its keys; later mounts drive after a tick like `multiDriver`. S1
// mounts before the facts, so an activity-order assertion must keep the
// component alive long enough for the enrichment to apply.
function activityDriver(keys) {
  const views = [];
  let mounts = 0;
  const mount = async (factory) => {
    mounts += 1;
    const index = mounts - 1;
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('component did not settle')), 5000);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      let view;
      try {
        view = factory(hostTui, plainTheme, {}, done);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      views.push(view);
      const drive = async () => {
        try {
          if (index === 0) await waitForActivity(view);
          for (const key of keys) view.handleInput(key);
        } catch (err) {
          reject(err);
        }
      };
      if (index === 0) setTimeout(drive, 0);
      else flush().then(drive).catch(reject);
    });
  };
  return { mount, views, mounts: () => mounts };
}

// Render until the focused checkout's facts footer stops saying `reading`,
// then return the frame text. render() is pure, so this never starts a read.
async function waitForFactsFooter(view, width = 120, tries = 400) {
  let text = '';
  for (let i = 0; i < tries; i += 1) {
    text = clean(view.render(width).join('\n'));
    if (!text.includes('reading')) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return text;
}

function wiredCtx(root, driver, extra = {}) {
  const calls = [];
  const sessionFile = sessionFileIn();
  return makeWiredCtx({
    cwd: root,
    FakeSM: makeFakeSM(calls),
    sessionFile,
    sessionDir: path.dirname(sessionFile),
    calls,
    mount: driver.mount,
    ...extra,
  });
}

describe('T12: the popup rows keep the activity order (S15)', { concurrency: false }, () => {
  test('the popup rows are ordered by last activity (commit time), oldest last', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('ordered-rows');
      const older = addRegisteredWorktree(root, 'feat/older');
      commitAt(older, 'old work', '2099-01-02T03:04:05');
      const newer = addRegisteredWorktree(root, 'feat/newer');
      commitAt(newer, 'recent work', '2099-06-07T08:09:10');
      const driver = activityDriver(['\x1b[B', '\x1b']);
      const built = wiredCtx(root, driver);
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      const lines = driver.views[0].render(120).map(clean);
      const at = (needle) => lines.findIndex((line) => line.includes(needle));
      const newerAt = at('feat-newer');
      const olderAt = at('feat-older');
      assert.ok(newerAt >= 0 && olderAt >= 0, `both checkouts render\n${lines.join('\n')}`);
      assert.ok(newerAt < olderAt, `newest activity first, registry order ignored\n${lines.join('\n')}`);
      const footer = lines.find((line) => line.includes('modified '));
      assert.ok(footer !== undefined, `the facts footer renders both ages\n${lines.join('\n')}`);
      assert.ok(!footer.includes('modified unavailable'), 'the modified age is a real value');
      assert.ok(footer.includes('created '), 'the created age rides the same line');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// T16: "nothing until confirm" (S17) as CALL COUNTS, not just final state.
// A write that happens on open and is later overwritten must fail these.
//
// Two counters, both wrapped in this suite — no production seam was added:
// * a registry write is any call into lib/worktree-registry.js's write
//   ENTRY POINTS (upsert/append/update/remove/addOddDoc/prune/discovery) —
//   the module object the extension reaches through `libRequire`, so every
//   atomic file write the extension performs passes through one of these;
// * a checkout creation is the `git worktree add` argv the create path runs
//   through the shared lib/worktree-git.js object.
// Both are recorded in ONE ordered event log, so "the write came before the
// confirm" and "the checkout came before the row" are the same measurement.
const gitLib = require('../lib/worktree-git.js');

const REGISTRY_WRITE_ENTRY_POINTS = [
  'upsertWorktree',
  'appendWorktree',
  'updateWorktree',
  'addOddDoc',
  'removeWorktree',
  'removeWorktreeByPath',
  'removeWorktreeExact',
  'pruneWorktrees',
  'registerMissingWorktrees',
];

function watchMutations() {
  const events = [];
  const originals = [];
  for (const name of REGISTRY_WRITE_ENTRY_POINTS) {
    const original = registryLib[name];
    if (typeof original !== 'function') continue;
    originals.push([registryLib, name, original]);
    registryLib[name] = function wrapped(...args) {
      events.push({ kind: 'registry-write', name, key: args[1] });
      return original.apply(this, args);
    };
  }
  for (const name of ['runArgv', 'runArgvAsync']) {
    const original = gitLib[name];
    if (typeof original !== 'function') continue;
    originals.push([gitLib, name, original]);
    gitLib[name] = function wrapped(...args) {
      const argv = Array.isArray(args[1]) ? args[1] : [];
      if (argv[0] === 'worktree' && argv[1] === 'add') events.push({ kind: 'checkout-create', argv: argv.slice() });
      return original.apply(this, args);
    };
  }
  return {
    events,
    kinds: () => events.map((event) => event.kind),
    writes: () => events.filter((event) => event.kind === 'registry-write'),
    creations: () => events.filter((event) => event.kind === 'checkout-create'),
    restore: () => {
      for (const [target, name, original] of originals) target[name] = original;
    },
  };
}

// Every removal argv the shared close issues, recorded in ORDER. The keyboard
// delete's fail-closed contract is "no remover ran at all", which is only
// observable here: a run that leaves the fixture intact after a refused
// `git worktree remove` still asked a backend to delete a path nobody approved.
function watchRemovals() {
  const removals = [];
  const original = gitLib.runArgvAsync;
  gitLib.runArgvAsync = function wrapped(...args) {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    if (argv[0] === 'worktree' && argv[1] === 'remove') {
      removals.push({ argv: argv.slice(), cwd: args[2] && args[2].cwd });
    }
    return original.apply(this, args);
  };
  return { removals, restore: () => { gitLib.runArgvAsync = original; } };
}

// Every created-state this task calls "created": a branch, a checkout and a
// registry row. Snapshotted whole so Esc that created anything fails.
function createdState(root) {
  return {
    branches: git(root, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort(),
    checkouts: git(root, ['worktree', 'list', '--porcelain']).split('\n')
      .filter((line) => line.startsWith('worktree ')).sort(),
    rows: registryLib.readRegistry(root).worktrees.map((row) => `${row.branch} ${row.path}`).sort(),
  };
}

function manyIssues(count) {
  return Array.from({ length: count }, (_, index) => ({ number: index + 1, title: `issue ${index + 1}` }));
}

// One panel driven by a script of labelled key steps; after each step the
// mutation log must not have grown. Returns the recorded [label, delta] pairs.
function stepRecorder(view, mutations) {
  const steps = [];
  const step = (label, run) => {
    const before = mutations.events.length;
    run(view);
    steps.push([label, mutations.events.length - before]);
  };
  step.steps = steps;
  return step;
}

function missingSessionFile(tag) {
  // Never written: an allocated-but-missing session file with nothing in
  // memory is exactly what `warpCreatePreflight` refuses.
  return path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-warp-${tag}-`))), 'missing.jsonl');
}

// ---------------------------------------------------------------------------
// S1/S4: the warp popup reaches no worktree modification beyond the delete
// REQUEST. The old `e` opened the full-screen worktree detail and deleted
// issues/ODD associations there; that view was removed with the association,
// so `e` is inert. `ctrl+d` (panel and extended list) asks to DELETE, and the
// confirmation, the disclosure, the refusals and the removal are the
// extension's — nothing a keypress alone can do.
describe('S1/S4: the warp popup edits nothing, and `e` stays inert', { concurrency: false }, () => {
  test('`e` opens no detail, asks nothing, writes nothing and leaves the popup in place', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-edit-key');
      const target = addRegisteredWorktree(root, 'feat/edit-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [5], odd: 'w1-a' }).ok, true);
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['e', '\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(driver.mounts(), 1, 'only the popup mounted: `e` opened no detail');
        assert.deepEqual(built.confirms, [], 'no dialog was raised');
        assert.deepEqual(watcher.kinds(), [], 'no creation and no registry write');
        assert.deepEqual(createdState(root), before, 'the checkout and the registry are untouched');
        assert.deepEqual(built.notes, [], 'an inert key is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('S1: opening and leaving the popup preserves a legacy stored association byte for byte', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('legacy-association');
      const target = addRegisteredWorktree(root, 'feat/legacy');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [5, 6], odd: 'w1-a' }).ok, true);
      const stored = registryLib.readRegistry(root).worktrees.find((row) => row.path === target);
      assert.deepEqual(stored.issues, [5, 6], 'the fixture really stores an association');
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.deepEqual(watcher.kinds(), [], 'the popup wrote nothing');
        const after = registryLib.readRegistry(root).worktrees.find((row) => row.path === target);
        assert.deepEqual(after, stored, 'the legacy association is preserved, never migrated or dropped');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// S4 (feedback: «falta el atajo para eliminar worktree»): `ctrl+d` in the warp
// panel and in the extended list asks to DELETE the focused checkout. What is
// pinned here is the whole decision, observed from the command's outside:
//   1. the question is ALWAYS asked, names the checkout, its branch and the
//      pending changes it would lose (+lines/-lines), and gentle-shell's YOLO
//      grant never waives it (the same grant does waive `worktree_close`'s own
//      dialog for a clean checkout — that is the proof it was ON);
//   2. a decline mutates nothing at all;
//   3. confirming removes the checkout, keeps the branch and drops exactly
//      that registry row;
//   4. the principal and the checkout the session runs in are refused BEFORE
//      any question is asked;
//   5. evidence that moved while the dialog was open fails closed, because the
//      human answered about a state that no longer exists.
const NO_HERDR = () => path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-warp-delete');

// A herdr stub that makes the filesystem change INSIDE the awaited
// `herdr worktree list`. That child process is the longest window between an
// identity check and the remover, so the swap landing there is deterministic:
// the stub performs it, then exits non-zero so the close falls back to
// `git worktree remove` — a remover that resolves the spelling it is given.
//
// Two shapes of replacement, because they defeat different checks:
//   - `symlink`: the approved path becomes a link to another checkout, which a
//     realpath comparison can see;
//   - `move`: the approved directory is moved aside and ANOTHER detached
//     checkout of the same commit is moved into its place — every string stays
//     identical (same path, same realpath, not a link), so only the pinned
//     device/inode pair tells the two directories apart.
function makeSwappingHerdr({ target, aside, victim, mode = 'symlink' }) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-swap-herdr-')));
  const bin = path.join(dir, 'herdr');
  const script = path.join(dir, 'swap.sh');
  const marker = path.join(dir, 'swapped');
  const swapLines = mode === 'move'
    ? ['mv "$SWAP_VICTIM" "$SWAP_TARGET"']
    : ['ln -s "$SWAP_VICTIM" "$SWAP_TARGET"'];
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'set -e',
    'mv "$SWAP_TARGET" "$SWAP_ASIDE"',
    ...swapLines,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ ! -f "$HERDR_SWAP_MARKER" ]; then',
    '  : > "$HERDR_SWAP_MARKER"',
    '  /bin/sh "$HERDR_SWAP_SCRIPT" || exit 1',
    'fi',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, script, marker, dir };
}

// A herdr stub that ANSWERS the listing with one workspace for the target and
// removes it through git when asked by workspace id, logging every argv. It is
// what proves the reordered close keeps the Herdr-first removal intact.
function makeListingHerdr({ root, target }) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-list-herdr-')));
  const bin = path.join(dir, 'herdr');
  const log = path.join(dir, 'argv.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$HERDR_LOG"',
    'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
    '  printf \'{"result":{"worktrees":[{"path":"%s","open_workspace_id":"ws-target"}]}}\\n\' "$HERDR_TARGET"',
    '  exit 0',
    'fi',
    'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
    '  git -C "$HERDR_REPO" worktree remove --force "$HERDR_REMOVE_PATH"',
    '  exit $?',
    'fi',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });
  return { bin, log, dir };
}

describe('S4: the warp delete shortcut asks, discloses and revalidates', { concurrency: false }, () => {
  test('ctrl+d asks one confirmation that names the losing lines, and a decline removes nothing', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-decline');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-decline');
      // Two appended lines and one brand-new file: the disclosure must count
      // LINES that would be lost, not files.
      fs.appendFileSync(path.join(target, 'work.txt'), 'one\ntwo\n');
      const before = createdState(root);
      // The first row is the only other checkout (the session sits in the
      // principal), so one `ctrl+d` targets it.
      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver, { confirmImpl: false });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.equal(built.confirms.length, 1, 'exactly one question, never none and never two');
      const [title, body] = built.confirms[0];
      assert.equal(title, "Delete worktree 'feat-del-decline'?");
      assert.match(body, new RegExp(`Delete worktree checkout at ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} for branch 'feat/del-decline'`));
      assert.match(body, /Pending changes: 1 file, \+2\/-0\./, `the pending lines are named: ${body}`);
      assert.match(body, /keeps the branch/, 'the branch-kept contract travels with the question');

      assert.deepEqual(createdState(root), before, 'a decline changed no branch, no checkout and no row');
      assert.ok(fs.existsSync(target), 'the checkout is still on disk');
      assert.ok(registryLib.findByPath(root, target), 'and still registered');
      assert.deepEqual(built.notes, [['worktree delete cancelled: nothing was removed at ' + target + '.', 'info']],
        'the answer is acknowledged and the loss is not claimed');
      assert.equal(driver.mounts(), 2, 'the selector comes back with a freshly read listing');
    } finally {
      restoreEnv();
    }
  });

  test('a clean checkout is still asked under YOLO, which does waive the tool\'s own dialog', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    // The live session holds gentle-shell's YOLO grant for this test.
    answerYolo('ON');
    try {
      const root = makeRepo('delete-yolo');
      addMainBranch(root);
      const waived = addRegisteredWorktree(root, 'feat/del-waived');
      const target = addRegisteredWorktree(root, 'feat/del-yolo');
      const { tools, commands } = await loadExtension();
      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver, { confirmImpl: true });
      built.ctx.hasUI = true;
      // Proof the grant is ON: the tool's own dialog is waived for a CLEAN
      // checkout, so no question is asked for it.
      const closed = await tools.get('worktree_close').execute('close-1', { path: waived }, undefined, undefined, built.ctx);
      assert.notEqual(closed.isError, true, JSON.stringify(closed));
      assert.deepEqual(built.confirms, [], 'YOLO waived the tool dialog for a clean checkout');
      assert.ok(!fs.existsSync(waived), 'and the tool removed that checkout');

      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.confirms.length, 1, 'the warp delete asked anyway: a keypress never borrows that grant');
      assert.match(built.confirms[0][1], /^Delete worktree checkout at /);
      assert.ok(!/Pending changes/.test(built.confirms[0][1]), 'a clean checkout names no pending changes');
      assert.ok(!fs.existsSync(target), 'the approved removal happened');
      assert.equal(registryLib.findByPath(root, target), null, 'its registry row is dropped');
      assert.ok(git(root, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/del-yolo'),
        'the branch is kept, exactly like every other close');
      assert.deepEqual(built.notes, [['worktree deleted: feat-del-yolo · ' + target + "; the branch 'feat/del-yolo' is kept.", 'info']]);
    } finally {
      resetYolo();
      restoreEnv();
    }
  });

  test('confirming a dirty checkout discloses the lines it loses and forces exactly that removal', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-dirty');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-dirty');
      fs.appendFileSync(path.join(target, 'work.txt'), 'one\ntwo\nthree\n');
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['\x04', '\x1b']]);
        const built = wiredCtx(root, driver, { confirmImpl: true });
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);

        assert.equal(built.confirms.length, 1);
        assert.match(built.confirms[0][1], /Pending changes: 1 file, \+3\/-0\./);
        assert.ok(!fs.existsSync(target), 'the checkout the human agreed to lose is removed');
        assert.deepEqual(watcher.writes().map((event) => event.name), ['removeWorktreeByPath'],
          'exactly one registry write: the drop that follows a verified removal');
        assert.ok(git(root, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/del-dirty'), 'the branch survives');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('evidence that changed while the dialog was open is refused, never removed', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-toctou');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-toctou');
      const driver = multiDriver([['\x04', '\x1b']]);
      let asked = null;
      const built = wiredCtx(root, driver, {
        confirmImpl: (title, body) => {
          asked = body;
          // The human is answering about a CLEAN checkout; the work appears
          // between the answer and the removal.
          fs.writeFileSync(path.join(target, 'late.txt'), 'arrived late\n');
          return true;
        },
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.equal(built.confirms.length, 1);
      assert.ok(!/Pending changes/.test(asked), `the human was shown a clean checkout: ${asked}`);
      assert.ok(fs.existsSync(target), 'the checkout that gained work is NOT removed');
      assert.ok(fs.existsSync(path.join(target, 'late.txt')), 'and the new file is still there');
      assert.ok(registryLib.findByPath(root, target), 'its registry row is kept');
      const refusal = built.notes.map(([message]) => message).join('\n');
      assert.match(refusal, /refusing to delete/);
      assert.match(refusal, /changed while the confirmation was open/);
      assert.match(refusal, /confirmed: no pending changes/, `the refusal names what the human was shown: ${refusal}`);
      assert.match(refusal, /now: 1 file, \+1\/-0/, `and what is true now: ${refusal}`);
      assert.deepEqual(built.notes.map(([, level]) => level), ['error']);
      assert.equal(driver.mounts(), 2, 'the selector is still usable after a refusal');
    } finally {
      restoreEnv();
    }
  });

  test('B1: a live branch that already differs from the registry row is not a refusal', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-branch-moved');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-registered');
      // The checkout was moved to another branch AFTER it was registered, so
      // the live branch and the registry row legitimately disagree. The warp
      // listing offers the LIVE branch (sole claimant), and comparing it with
      // the row used to refuse this deletion every single time.
      git(target, ['checkout', '-b', 'feat/live-renamed']);
      assert.equal(registryLib.findByPath(root, target).branch, 'feat/del-registered', 'the row keeps the old name');
      assert.equal(git(target, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/live-renamed', 'the checkout is on another branch');

      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver, { confirmImpl: true });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.equal(built.confirms.length, 1, 'the question is asked, not pre-refused');
      assert.ok(!built.notes.some(([, level]) => level === 'error'), `no refusal was reported: ${JSON.stringify(built.notes)}`);
      assert.ok(!fs.existsSync(target), 'the approved removal happened');
      assert.equal(registryLib.findByPath(root, target), null, 'and its row was dropped');
      assert.ok(git(root, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/live-renamed'), 'the live branch is kept');
    } finally {
      restoreEnv();
    }
  });

  test('A1: identical +/- counts with different bytes are refused, never removed', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-content-swap');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-content');
      fs.writeFileSync(path.join(target, 'work.txt'), 'one\n');
      git(target, ['add', 'work.txt']);
      git(target, ['commit', '-m', 'seed work']);
      // +1/-1 pending, so the dialog names a real change size.
      fs.writeFileSync(path.join(target, 'work.txt'), 'two\n');
      const driver = multiDriver([['\x04', '\x1b']]);
      let asked = null;
      const built = wiredCtx(root, driver, {
        confirmImpl: (title, body) => {
          asked = body;
          // The pending size is IDENTICAL (+1/-1); only the bytes differ.
          fs.writeFileSync(path.join(target, 'work.txt'), 'three\n');
          return true;
        },
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.equal(built.confirms.length, 1);
      assert.match(asked, /Pending changes: 1 file, \+1\/-1\./, 'the human was shown a real size');
      assert.ok(fs.existsSync(target), 'a checkout whose bytes moved is NOT removed');
      assert.equal(fs.readFileSync(path.join(target, 'work.txt'), 'utf8'), 'three\n', 'the newer content survives');
      assert.ok(registryLib.findByPath(root, target), 'its registry row is kept');
      const refusal = built.notes.map(([message]) => message).join('\n');
      assert.match(refusal, /its pending content changed/, `the refusal names the content, not the counts: ${refusal}`);
      assert.match(refusal, /confirmed: 1 file, \+1\/-1, 1 ahead of main; now: 1 file, \+1\/-1, 1 ahead of main/,
        'both readings agree on the size');
    } finally {
      restoreEnv();
    }
  });

  test('A2: ignored files are disclosed in the question, and one that appears later aborts the delete', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-ignored');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-ignored');
      fs.writeFileSync(path.join(target, '.gitignore'), '*.log\n');
      git(target, ['add', '.gitignore']);
      git(target, ['commit', '-m', 'ignore rules']);
      fs.writeFileSync(path.join(target, 'build.log'), 'artifact\n');
      // Nothing git tracks is pending, so the checkout reads CLEAN while the
      // ignored file only exists here and would die with the checkout.
      const driver = multiDriver([['\x04', '\x1b']]);
      let asked = null;
      const built = wiredCtx(root, driver, {
        confirmImpl: (title, body) => {
          asked = body;
          fs.writeFileSync(path.join(target, 'late.log'), 'arrived late\n');
          return true;
        },
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.equal(built.confirms.length, 1);
      assert.match(asked, /Ignored files \(deleted with the checkout\): build\.log\./, `the human is told: ${asked}`);
      assert.ok(!/Pending changes/.test(asked), 'the tracked tree reads clean');
      assert.ok(fs.existsSync(target), 'the checkout is NOT removed');
      assert.ok(fs.existsSync(path.join(target, 'late.log')), 'and the ignored file that appeared survives');
      const refusal = built.notes.map(([message]) => message).join('\n');
      assert.match(refusal, /its ignored files changed/, `the refusal names the ignored files: ${refusal}`);
    } finally {
      restoreEnv();
    }
  });

  // The reproduced high-severity race: the approved path is replaced, while the
  // human is answering, by a symbolic link to a DIFFERENT checkout. Two DETACHED
  // checkouts at the same commit are the worst case for this surface, because
  // the one component that could reveal the swap (the live branch) is unknown
  // on both sides, and the disclosure reads identically through the link. What
  // must never happen is a removal aimed at a path that no longer names the
  // checkout the human approved — `git worktree remove` resolves the spelling it
  // is given, so that is another checkout's directory.
  test('a checkout swapped for a symlink to another detached checkout during the dialog is refused before any removal', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-symlink-swap');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-symlink-swap');
      // Detached: git reports no branch for it, so `live.branch` is null.
      git(target, ['checkout', '--detach']);
      // The other checkout an attacker would aim the removal at: a detached
      // live checkout of the SAME commit, so every disclosure number matches.
      const victim = path.join(path.dirname(root), `${path.basename(root)}-wired-victim`);
      track(victim);
      git(root, ['worktree', 'add', '--detach', victim, 'HEAD']);
      const victimReal = fs.realpathSync(victim);
      const aside = track(`${target}-swapped-aside`);
      const removalWatch = watchRemovals();
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['\x04', '\x1b']]);
        let asked = null;
        const built = wiredCtx(root, driver, {
          confirmImpl: (title, body) => {
            asked = body;
            // The swap lands between the question and the answer's use.
            fs.renameSync(target, aside);
            fs.symlinkSync(victimReal, target);
            return true;
          },
        });
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);

        assert.equal(built.confirms.length, 1, 'the human is asked once, about the real checkout');
        assert.ok(asked.includes(target), `the question named the approved checkout: ${asked}`);
        const notes = built.notes.map(([message]) => message).join('\n');
        assert.deepEqual(removalWatch.removals, [], `no removal may be attempted for an unapproved path: ${JSON.stringify(removalWatch.removals)}`);
        assert.match(notes, /refusing to delete/, `the delete is refused, not attempted: ${notes}`);
        assert.match(notes, /symbolic link/, `the refusal names the replacement: ${notes}`);
        assert.match(notes, /nothing was removed/);
        assert.deepEqual(built.notes.map(([, level]) => level), ['error'], 'one refusal, at error level');
        // Nothing at all was destroyed: the other checkout is a live worktree
        // with its own metadata, and the approved one is still where the swap
        // put it.
        assert.ok(fs.existsSync(path.join(victimReal, '.git')), 'the other checkout keeps its git metadata');
        assert.ok(git(root, ['worktree', 'list', '--porcelain']).includes(victimReal), 'it is still a live worktree of this repository');
        assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the swapped path is untouched');
        assert.ok(fs.existsSync(path.join(aside, '.git')), 'the approved checkout is untouched');
        assert.ok(registryLib.findByPath(root, target), 'its registry row is kept');
        assert.deepEqual(watcher.writes(), [], 'no registry write');
        assert.equal(driver.mounts(), 2, 'the selector comes back after the refusal');
      } finally {
        watcher.restore();
        removalWatch.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  // The same swap, one step earlier: the link is already in place when the
  // question's reading is taken. Every component matches on both sides then
  // (`live.branch` null, the disclosure read through the link), so the pin has
  // to be the identity the SELECTOR listed — a live checkout's own realpath —
  // and not whatever the path resolves to at question time.
  test('a path swapped for a symlink before the question is refused against the identity the selector listed', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-symlink-preswap');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-symlink-preswap');
      git(target, ['checkout', '--detach']);
      const victim = path.join(path.dirname(root), `${path.basename(root)}-wired-preswap-victim`);
      track(victim);
      git(root, ['worktree', 'add', '--detach', victim, 'HEAD']);
      const victimReal = fs.realpathSync(victim);
      const aside = track(`${target}-pinned-aside`);
      const removalWatch = watchRemovals();
      const watcher = watchMutations();
      try {
        // The swap lands after the selector rendered its row and BEFORE the
        // question's reading is taken: the row still names the approved path,
        // while that path already resolves to the other checkout.
        const driver = multiDriver([(view) => {
          fs.renameSync(target, aside);
          fs.symlinkSync(victimReal, target);
          view.handleInput('\x04');
        }]);
        const built = wiredCtx(root, driver, { confirmImpl: true });
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);

        assert.deepEqual(built.confirms, [], 'no question: the path is not the listed checkout any more');
        assert.deepEqual(removalWatch.removals, [], `no removal may be attempted: ${JSON.stringify(removalWatch.removals)}`);
        const notes = built.notes.map(([message]) => message).join('\n');
        assert.match(notes, /refusing to delete/, `the delete is refused: ${notes}`);
        assert.match(notes, /symbolic link/, `the refusal names the replacement: ${notes}`);
        assert.ok(fs.existsSync(path.join(victimReal, '.git')), 'the other checkout is untouched');
        assert.ok(git(root, ['worktree', 'list', '--porcelain']).includes(victimReal), 'and still a live worktree');
        assert.ok(registryLib.findByPath(root, target), 'the registry row is kept');
        assert.deepEqual(watcher.writes(), [], 'no registry write');
      } finally {
        watcher.restore();
        removalWatch.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  // The reproduced high-severity race, one step LATER than the dialog: the
  // swap lands while the removal resolves its Herdr workspace from
  // `herdr worktree list`. That listing is a child process, so it is an await
  // — the longest window between a check and the remover — and the approved
  // path is a real, live checkout on both sides of it, which is why a check
  // that runs BEFORE the listing cannot see the swap. What must hold is that
  // no remover is launched at all once the path stopped naming the approved
  // checkout; the deterministic trigger is the shim itself, so the swap lands
  // inside that exact await and nowhere else.
  test('a checkout swapped for a symlink while the removal listing is awaited is refused before any remover runs', async () => {
    const root = makeRepo('delete-swap-at-listing');
    addMainBranch(root);
    const target = addRegisteredWorktree(root, 'feat/del-swap-listing');
    // Detached, like the dialog cases: the live branch cannot reveal the swap.
    git(target, ['checkout', '--detach']);
    const victim = path.join(path.dirname(root), `${path.basename(root)}-wired-listing-victim`);
    track(victim);
    git(root, ['worktree', 'add', '--detach', victim, 'HEAD']);
    const victimReal = fs.realpathSync(victim);
    const aside = track(`${target}-listing-aside`);
    const shim = makeSwappingHerdr({ target, aside, victim: victimReal });
    setEnv(warpStateEnv({
      HERDR_BIN_PATH: shim.bin,
      HERDR_SWAP_MARKER: shim.marker,
      HERDR_SWAP_SCRIPT: shim.script,
      SWAP_TARGET: target,
      SWAP_ASIDE: aside,
      SWAP_VICTIM: victimReal,
    }));
    try {
      const removalWatch = watchRemovals();
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['\x04', '\x1b']]);
        const built = wiredCtx(root, driver, { confirmImpl: true });
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);

        assert.equal(built.confirms.length, 1, 'the human was asked once, about the real checkout');
        assert.ok(fs.existsSync(shim.marker), 'the swap really landed inside the awaited listing');
        assert.deepEqual(
          removalWatch.removals,
          [],
          `no removal may be launched for a path that stopped naming the approved checkout: ${JSON.stringify(removalWatch.removals)}`,
        );
        const notes = built.notes.map(([message]) => message).join('\n');
        assert.match(notes, /refusing to close worktree for branch 'feat\/del-swap-listing'/, `the close refuses: ${notes}`);
        assert.match(notes, /no longer resolves to the approved checkout/, `the refusal names the approved identity: ${notes}`);
        assert.match(notes, /symbolic link/, `and the replacement it found: ${notes}`);
        assert.ok(fs.existsSync(path.join(victimReal, '.git')), 'the other checkout keeps its git metadata');
        assert.ok(git(root, ['worktree', 'list', '--porcelain']).includes(victimReal), 'it is still a live worktree of this repository');
        assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the swapped path is untouched');
        assert.ok(fs.existsSync(path.join(aside, '.git')), 'the approved checkout is untouched');
        assert.ok(registryLib.findByPath(root, target), 'its registry row is kept');
        assert.deepEqual(watcher.writes(), [], 'no registry write');
      } finally {
        watcher.restore();
        removalWatch.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  // The same window, with the replacement a realpath comparison CANNOT see: the
  // approved directory is moved aside and another detached checkout of the same
  // commit takes its exact path. The spelling, the resolved path and the kind of
  // path are all identical afterwards, so the pin that answers this is the
  // approved directory's own device/inode pair — and the removal is refused
  // because the path no longer names the directory the human approved.
  test('a checkout replaced by another directory at the same path while the listing is awaited is refused', async () => {
    const root = makeRepo('delete-replace-at-listing');
    addMainBranch(root);
    const target = addRegisteredWorktree(root, 'feat/del-replace-listing');
    git(target, ['checkout', '--detach']);
    const victim = path.join(path.dirname(root), `${path.basename(root)}-wired-replace-victim`);
    track(victim);
    git(root, ['worktree', 'add', '--detach', victim, 'HEAD']);
    const victimReal = fs.realpathSync(victim);
    const aside = track(`${target}-replace-aside`);
    const shim = makeSwappingHerdr({ target, aside, victim: victimReal, mode: 'move' });
    setEnv(warpStateEnv({
      HERDR_BIN_PATH: shim.bin,
      HERDR_SWAP_MARKER: shim.marker,
      HERDR_SWAP_SCRIPT: shim.script,
      SWAP_TARGET: target,
      SWAP_ASIDE: aside,
      SWAP_VICTIM: victimReal,
    }));
    try {
      const removalWatch = watchRemovals();
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['\x04', '\x1b']]);
        const built = wiredCtx(root, driver, { confirmImpl: true });
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);

        assert.equal(built.confirms.length, 1, 'the human was asked once, about the real checkout');
        assert.ok(fs.existsSync(shim.marker), 'the replacement landed inside the awaited listing');
        assert.equal(fs.realpathSync(target), target, 'the path still resolves to itself: no link, no moved realpath');
        assert.deepEqual(
          removalWatch.removals,
          [],
          `no removal may be launched for a directory nobody approved: ${JSON.stringify(removalWatch.removals)}`,
        );
        const notes = built.notes.map(([message]) => message).join('\n');
        assert.match(notes, /refusing to close worktree for branch 'feat\/del-replace-listing'/, `the close refuses: ${notes}`);
        assert.match(notes, /no longer the confirmed checkout/, `and names the replaced directory: ${notes}`);
        assert.ok(fs.existsSync(path.join(target, '.git')), 'the replacement is untouched');
        assert.ok(fs.existsSync(path.join(aside, '.git')), 'the approved checkout is untouched where the swap put it');
        assert.ok(registryLib.findByPath(root, target), 'its registry row is kept');
        assert.deepEqual(watcher.writes(), [], 'no registry write');
      } finally {
        watcher.restore();
        removalWatch.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  // PRESERVE for the reordered close: moving the listing ahead of the final
  // check must not change the Herdr-first removal. With Herdr answering, the
  // workspace is still resolved from that listing and the checkout is removed
  // BY ID (never by a path spelling), the row drops and the branch survives.
  test('the herdr path still resolves the workspace after the listing and removes by id', async () => {
    const root = makeRepo('delete-herdr-path');
    addMainBranch(root);
    const target = addRegisteredWorktree(root, 'feat/del-herdr-path');
    const shim = makeListingHerdr({ root, target });
    setEnv(warpStateEnv({
      HERDR_BIN_PATH: shim.bin,
      HERDR_LOG: shim.log,
      HERDR_TARGET: target,
      HERDR_REPO: root,
      HERDR_REMOVE_PATH: target,
    }));
    try {
      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver, { confirmImpl: true });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.equal(built.confirms.length, 1);
      assert.ok(!fs.existsSync(target), 'the approved checkout is removed');
      const calls = fs.readFileSync(shim.log, 'utf8').split('\n').filter((line) => line.length > 0);
      const removeCall = calls.find((line) => line.startsWith('worktree remove'));
      assert.ok(removeCall, `herdr was asked to remove the workspace: ${JSON.stringify(calls)}`);
      assert.ok(removeCall.includes('--workspace ws-target'), `by workspace id: ${removeCall}`);
      assert.ok(!removeCall.includes(target), `never the path spelling: ${removeCall}`);
      assert.equal(registryLib.findByPath(root, target), null, 'the registry row is dropped');
      assert.ok(git(root, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/del-herdr-path'), 'the branch is kept');
      const notes = built.notes.map(([message]) => message).join('\n');
      assert.match(notes, /worktree deleted: feat-del-herdr-path/, `the success names the checkout: ${notes}`);
    } finally {
      restoreEnv();
    }
  });

  // PRESERVE: the shared close the keyboard delete calls is ALSO the agent
  // tool's removal. Its `path`/`force` behavior is unchanged by the identity
  // pin, which only the keyboard path supplies.
  test('worktree_close still removes exactly the checkout it names, keeping every other one', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('close-preserved');
      addMainBranch(root);
      const kept = addRegisteredWorktree(root, 'feat/close-kept');
      const target = addRegisteredWorktree(root, 'feat/close-target');
      fs.appendFileSync(path.join(target, 'work.txt'), 'pending line\n');
      const removalWatch = watchRemovals();
      try {
        const built = wiredCtx(root, multiDriver([]));
        const { tools } = await loadExtension();
        const closed = await tools.get('worktree_close').execute('close-1', { path: target, force: true }, undefined, undefined, built.ctx);

        assert.notEqual(closed.isError, true, JSON.stringify(closed));
        assert.match(closed.content[0].text, /removed|closed/i, `the tool reports its outcome: ${closed.content[0].text}`);
        assert.ok(!fs.existsSync(target), 'the named checkout is removed');
        assert.ok(fs.existsSync(kept), 'the other checkout is untouched');
        assert.equal(registryLib.findByPath(root, target), null, 'its registry row is dropped');
        assert.ok(registryLib.findByPath(root, kept), 'the other row stays');
        assert.ok(git(root, ['branch', '--format=%(refname:short)']).split('\n').includes('feat/close-target'), 'the branch is kept');
        assert.equal(removalWatch.removals.length, 1, 'exactly one removal ran');
        assert.deepEqual(removalWatch.removals[0].argv.slice(-2), ['--force', target], 'the same argv as before, --force from the caller');
      } finally {
        removalWatch.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('A2: a clean checkout whose ignored files are unreadable is refused before asking', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-ignored-unknown');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-ignored-unknown');
      const before = createdState(root);
      // A `.gitignore` rule that git itself cannot evaluate (an unreadable
      // exclude file) is the realistic shape; here the whole ignored listing
      // fails through a broken repository, so the read is unknown and the
      // deletion must not be offered at all.
      fs.rmSync(path.join(target, '.git'), { force: true });
      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver, { confirmImpl: true });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.deepEqual(built.confirms, [], 'no question: an unknown reading is a refusal');
      assert.match(built.notes.map(([message]) => message).join('\n'), /could not be read|could not be fingerprinted|could not be listed/);
      assert.deepEqual(createdState(root), before, 'nothing was removed and nothing was written');
      assert.ok(fs.existsSync(target));
    } finally {
      restoreEnv();
    }
  });

  test('the principal checkout is refused before any question is asked', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-principal');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-principal');
      const before = createdState(root);
      // The extended list is the only view that offers the principal row, and
      // it is the first row there (and the row the panel was focused on).
      const driver = multiDriver([['v', '\x04', '\x1b']]);
      const built = wiredCtx(target, driver, { confirmImpl: true });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.deepEqual(built.confirms, [], 'no question: the refusal comes first');
      assert.match(built.notes.map(([message]) => message).join('\n'), /refusing to delete the principal checkout/);
      assert.deepEqual(createdState(root), before, 'nothing was removed and nothing was written');
      assert.ok(fs.existsSync(root), 'the principal checkout still exists');
    } finally {
      restoreEnv();
    }
  });

  test('the checkout this session runs in is refused before any question is asked', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-current');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-current');
      const before = createdState(root);
      // The session lives in the agent checkout; the extended list offers it
      // (row 1, principal first) so `ctrl+d` can name the ground it stands on.
      const driver = multiDriver([['v', '\x1b[B', '\x04', '\x1b']]);
      const built = wiredCtx(target, driver, { confirmImpl: true });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.deepEqual(built.confirms, [], 'no question: the session is not deleting its own checkout');
      assert.match(built.notes.map(([message]) => message).join('\n'), /the checkout this session is running in/);
      assert.deepEqual(createdState(root), before, 'nothing was removed and nothing was written');
      assert.ok(fs.existsSync(target));
    } finally {
      restoreEnv();
    }
  });

  test('a live checkout the registry does not own is refused before any question is asked', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-unregistered');
      addMainBranch(root);
      // A real checkout nobody registered (the S14 discovery case): the warp
      // list offers it, but only the registry can authorize a close, so this
      // must never become a deletion candidate.
      const stray = path.join(path.dirname(root), `${path.basename(root)}-wired-stray`);
      track(stray);
      git(root, ['worktree', 'add', '-b', 'feat/stray', stray, 'HEAD']);
      const realStray = fs.realpathSync(stray);
      const before = createdState(root);
      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver, { confirmImpl: true });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.deepEqual(built.confirms, [], 'no question: an unowned checkout has no close path');
      assert.match(built.notes.map(([message]) => message).join('\n'), /does not own/);
      assert.deepEqual(createdState(root), before, 'nothing was removed and nothing was written');
      assert.ok(fs.existsSync(realStray), 'the checkout is still on disk');
    } finally {
      restoreEnv();
    }
  });

  test('an unreadable pending-change read refuses the delete instead of asking', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-unknown-evidence');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-unknown');
      // A checkout whose git metadata is gone: it is still listed and still a
      // directory, so the only thing that cannot be read is what is pending in
      // it. That is exactly the case that must never be guessed.
      fs.rmSync(path.join(target, '.git'), { force: true });
      const before = createdState(root);
      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver, { confirmImpl: true });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.deepEqual(built.confirms, [], 'no question: an unreadable disclosure is a refusal');
      const refusal = built.notes.map(([message]) => message).join('\n');
      assert.match(refusal, /its uncommitted changes could not be read/);
      assert.match(refusal, /nothing was removed/);
      assert.deepEqual(createdState(root), before, 'nothing was removed and nothing was written');
      assert.ok(fs.existsSync(target), 'the checkout is still on disk');
    } finally {
      restoreEnv();
    }
  });

  test('a host that cannot ask is refused instead of removing anything', async () => {
    setEnv(warpStateEnv({ HERDR_BIN_PATH: NO_HERDR() }));
    try {
      const root = makeRepo('delete-no-dialog');
      addMainBranch(root);
      const target = addRegisteredWorktree(root, 'feat/del-no-dialog');
      const before = createdState(root);
      const driver = multiDriver([['\x04', '\x1b']]);
      const built = wiredCtx(root, driver);
      // A destructive act is never performed on a host that cannot ask.
      delete built.ctx.ui.confirm;
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);

      assert.match(built.notes.map(([message]) => message).join('\n'), /cannot ask the confirmation a removal requires/);
      assert.deepEqual(createdState(root), before, 'nothing was removed and nothing was written');
      assert.ok(fs.existsSync(target));
    } finally {
      restoreEnv();
    }
  });
});

describe('T16: the panels write nothing until the user confirms (S17)', { concurrency: false }, () => {  test('opening the creating panel performs no registry write and no checkout creation, and Esc creates no state', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-open-create');
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['c'], (view) => {
          view.render(120); // the frame the user sees
          assert.equal(watcher.events.length, 0, 'drawing the create panel mutated nothing');
          view.handleInput('\x1b'); // cancel
        }]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        // S7: the cancel returns to the selector (the third mount), where `esc`
        // is the key that closes the flow. Nothing was written either way.
        assert.equal(driver.mounts(), 3, 'the popup, the create panel, then the popup again');
        assert.deepEqual(watcher.kinds(), [], 'opening (and cancelling) created nothing and wrote nothing');
        assert.equal(watcher.writes().length, 0, 'zero registry writes');
        assert.equal(watcher.creations().length, 0, 'zero checkout creations');
        assert.deepEqual(createdState(root), before, 'no branch, no checkout, no registry row');
        assert.deepEqual(built.notes, [], 'a cancel is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('inside the creating panel the inline type list, both fields and tab each add no mutation', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-create-keys');
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['c'], (view) => {
          const step = stepRecorder(view, watcher);
          step('move inside the inline type list', (v) => v.handleInput('\x1b[B'));
          assert.equal(view.state.focus, 'type', 'the type list keeps the keyboard');
          assert.equal(view.state.typeIndex, 1, 'down selects the next change type');
          step('move back to the first type', (v) => v.handleInput('\x1b[A'));
          assert.equal(view.state.typeIndex, 0, 'up selects the previous change type');
          step('tab to the name field', (v) => v.handleInput('\t'));
          assert.equal(view.state.focus, 'name', 'step 1 hands over to step 2');
          step('type the change name', (v) => {
            for (const char of 'panel-change') v.handleInput(char);
          });
          assert.equal(view.state.name, 'panel-change', 'the name field kept the typed value');
          step('return to the type field', (v) => v.handleInput('\x1b[A'));
          assert.equal(view.state.focus, 'type');
          step('left reaches the name field', (v) => v.handleInput('\x1b[D'));
          assert.equal(view.state.focus, 'name', 'left walks the two fields');
          step('right returns to the type field', (v) => v.handleInput('\x1b[C'));
          assert.equal(view.state.focus, 'type', 'right walks the two fields');
          step('press an unbound key', (v) => v.handleInput('?'));
          assert.equal(view.state.focus, 'name', '? starts the name instead of opening help');
          assert.equal(view.state.name, 'panel-change?', 'the printable key lands in the name field');
          step('cancel the panel', (v) => v.handleInput('\x1b'));
          assert.deepEqual(step.steps.map(([, delta]) => delta), step.steps.map(() => 0), `every interaction added no mutation: ${JSON.stringify(step.steps)}`);
          assert.ok(step.steps.length >= 8, 'every scripted interaction was measured');
        }]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(watcher.writes().length, 0, 'zero registry writes across every interaction');
        assert.equal(watcher.creations().length, 0, 'zero checkout creations across every interaction');
        assert.deepEqual(createdState(root), before, 'no branch, no checkout, no registry row');
        assert.deepEqual(built.notes, [], 'a cancel is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('confirming the creation is the FIRST mutation, and the checkout creation precedes the one registry write', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'first-mutation-thread' }));
    try {
      const root = makeRepo('first-mutation-create');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        let confirmedAt = 0;
        const driver = multiDriver([['c'], (view) => {
          view.handleInput('\x1b[B'); // the inline type list moves to Bug fix
          view.handleInput('\x1b[A'); // and back to Feature, the expected type
          view.handleInput('\t'); // Tab hands the flow to the name field
          for (const char of 'nothing-yet') view.handleInput(char);
          assert.equal(view.state.typeIndex, 0, 'the inline type list sits on Feature');
          assert.equal(view.state.name, 'nothing-yet', 'the name field kept every character');
          assert.deepEqual(watcher.kinds(), [], 'navigating and typing before the confirm wrote nothing');
          confirmedAt = watcher.events.length;
          view.handleInput('enter'); // the explicit confirm key
        }]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(confirmedAt, 0, 'nothing was mutated before the confirm');
        assert.deepEqual(watcher.kinds(), ['checkout-create', 'registry-write'], 'one creation then one write, in that order');
        assert.equal(watcher.creations().length, 1, 'creating performs exactly ONE checkout creation');
        assert.equal(watcher.writes().length, 1, 'creating performs exactly ONE registry write');
        const after = createdState(root);
        assert.equal(after.branches.length, before.branches.length + 1, 'the branch was created');
        assert.ok(after.branches.includes('feat/nothing-yet'), `the derived branch exists (${after.branches})`);
        assert.equal(after.checkouts.length, before.checkouts.length + 1, 'the checkout was created');
        assert.ok(after.rows.some((row) => row.startsWith('feat/nothing-yet ')), 'the registry row was created');
        // S7: the creation ends in the selector, never in an automatic warp.
        assert.equal(built.switches.length, 0, 'S7: creating does not warp on its own');
        assert.deepEqual(built.notes, [], 'creation is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  // S7: the fork-source preflight existed ONLY because the creation used to
  // end in a warp (a fork needs a session to fork from). Creation no longer
  // warps, so a session Pi has not written to disk yet creates normally: the
  // checkout and its registry row are the whole outcome.
  test('creation needs no fork source: a session with no persisted file still creates (S7)', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'refused-preflight-thread' }));
    try {
      const root = makeRepo('refused-preflight');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        const sessionFile = missingSessionFile('refused-sess');
        let confirmedAt = 0;
        const driver = multiDriver([['c'], (view) => {
          view.handleInput('\x1b[B');
          for (const char of 'refused-create') view.handleInput(char);
          confirmedAt = watcher.events.length;
          view.handleInput('enter'); // the explicit confirm key
        }, ['\x1b']]);
        const built = makeWiredCtx({
          cwd: root,
          FakeSM: makeFakeSM([]),
          sessionFile,
          sessionDir: path.dirname(sessionFile),
          calls: [],
          mount: driver.mount,
        });
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(confirmedAt, 0, 'nothing was mutated before the confirm');
        assert.deepEqual(watcher.kinds(), ['checkout-create', 'registry-write'], 'one creation then one write, in that order');
        const after = createdState(root);
        assert.equal(after.branches.length, before.branches.length + 1, 'the branch was created');
        assert.ok(after.branches.includes('fix/refused-create'), `the derived branch exists (${after.branches})`);
        assert.equal(after.checkouts.length, before.checkouts.length + 1, 'the checkout was created');
        assert.ok(after.rows.some((row) => row.startsWith('fix/refused-create ')), 'the registry row was created');
        assert.equal(driver.mounts(), 3, 'the selector came back after the creation');
        assert.deepEqual(built.switches, [], 'S7: and nothing was warped');
        assert.deepEqual(built.notes, [], 'the creation is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });
});

// PRESERVE: `r` still reloads in place. It now returns the same
// activity-carrying rows as the first mount (an async reload the view
// awaits), so the previous behavior — rows refresh, nothing closes, no
// error — must be unchanged.
describe('T12: the reload option is preserved', { concurrency: false }, () => {
  test('r reloads the rows in place, still newest first, and never closes the popup', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('reload-rows');
      const older = addRegisteredWorktree(root, 'feat/older');
      commitAt(older, 'old work', '2099-01-02T03:04:05');
      const newer = addRegisteredWorktree(root, 'feat/newer');
      commitAt(newer, 'recent work', '2099-06-07T08:09:10');
      const driver = activityDriver(['r', '\x1b']);
      const built = wiredCtx(root, driver);
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      const lines = driver.views[0].render(120).map(clean);
      const at = (needle) => lines.findIndex((line) => line.includes(needle));
      assert.equal(driver.mounts(), 1, 'r never closes and re-mounts the popup');
      assert.ok(at('feat-newer') >= 0 && at('feat-older') >= 0, `both rows survive the reload\n${lines.join('\n')}`);
      assert.ok(at('feat-newer') < at('feat-older'), 'the reload keeps the newest-first order');
      assert.deepEqual(built.notes, [], 'a reload notifies nothing');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// S1: the popup mounts before the (slow) facts resolve, render performs no
// I/O, and the background enrichment applies to the still-alive component.
// ---------------------------------------------------------------------------
describe('S1: the selector paints before the facts, then enriches', { concurrency: false }, () => {
  test('mounted before the delayed facts, no I/O in render, then the rows gain their activity', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('s1-paint-first');
      const target = addRegisteredWorktree(root, 'feat/slow');
      const delayMs = 400;
      let factsCalls = 0;
      const { commands, mod } = await loadExtension();
      mod.setWarpFactsFactory(() => ({
        peek: () => null,
        invalidate: () => {},
        ttlMs: 5000,
        facts: (checkoutPath) => {
          factsCalls += 1;
          return new Promise((resolve) => setTimeout(() => resolve({
            checkout: checkoutPath,
            fetchedAt: Date.now(),
            cached: false,
            branch: { available: true, value: 'feat/slow', reason: null },
            issues: { available: true, value: [], reason: null },
            odd: { available: true, value: [], reason: null },
            createdAt: { available: true, value: new Date(0).toISOString(), reason: null, source: 'registry' },
            lastActivity: { available: true, value: new Date().toISOString(), reason: null, source: 'commit' },
            changes: { available: true, value: { added: 0, deleted: 0 }, reason: null },
            aheadBehind: { available: true, value: { ahead: 0, behind: 0, base: 'main' }, reason: null },
          }), delayMs));
        },
      }));

      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      let view = null;
      let mountedAt = null;
      const mount = async (factory) => new Promise((resolve) => {
        mountedAt = Date.now();
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        view = factory(hostTui, plainTheme, {}, resolve);
      });
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount });
      const started = Date.now();
      const handler = warpDef(commands).handler('', built.ctx);
      // The mount happens before the facts promise can resolve.
      for (let i = 0; i < 50 && mountedAt === null; i += 1) await tick();
      assert.ok(mountedAt !== null, 'the overlay mounted');
      const mountMs = mountedAt - started;
      assert.ok(mountMs < delayMs, `mounted in ${mountMs}ms, before the ${delayMs}ms facts delay`);

      const callsBeforeRender = factsCalls;
      const firstPaint = view.render(120).map(clean).join('\n');
      assert.match(firstPaint, /Warp/, 'the first frame is usable');
      view.render(120);
      assert.equal(factsCalls, callsBeforeRender, 'render() performed no additional facts I/O');
      const before = view.state.checkouts.find((entry) => entry.path === target);
      assert.equal(before.lastActivity, null, 'no activity is invented before the read');

      await new Promise((resolve) => setTimeout(resolve, delayMs + 120));
      assert.ok(factsCalls > 0, 'the background read ran');
      const after = view.state.checkouts.find((entry) => entry.path === target);
      assert.ok(after && typeof after.lastActivity === 'number', 'the enrichment applied to the live component');

      view.handleInput('\x1b');
      await handler;
      assert.deepEqual(built.notes, [], 'Esc stays silent');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// S2: creating from the panel asks about the INVOKING checkout's uncommitted
// work. Copying is a choice the human makes at creation time — the new
// checkout is either born empty from the commit or carries the pending work —
// and the question is asked ONCE, before anything is created, so a cancel
// leaves no branch, no checkout and no registry row. The answer travels as the
// create path's own `changes` selection ('all' or 'none'), never as a second
// copy implementation.
// ---------------------------------------------------------------------------

// A fixture whose checkout sits on local main with one tracked file modified
// in the working tree and one untracked file pending.
function makePendingChangeRepo(tag) {
  const root = makeRepo(tag);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'a']);
  // S2: the worktree is born from local main, so the committed file must be in
  // main's tree for the pending change to apply.
  git(root, ['branch', '-f', 'main', 'HEAD']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'fresh\n');
  return root;
}

const panelTarget = (root, slug) => path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);

// Drive the real command: the selector opens, `c` opens the create panel, the
// panel types `name` and confirms, and the RETURNED selector closes with Esc.
// `mounts` is the observable number of overlays the run produced.
async function driveCreateFlow({ root, name, beforeFlow }) {
  const calls = [];
  const FakeSM = makeFakeSM(calls);
  const sessionFile = sessionFileIn();
  const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: async () => null });
  const { commands, mod } = await loadExtension();
  const mounts = [];
  built.ctx.ui.custom = async (factory, options) => {
    mounts.push(options);
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('component did not settle')), 3000);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      let view;
      try {
        view = factory(hostTui, plainTheme, {}, done);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      const drive = () => {
        try {
          if (mounts.length === 1) {
            view.handleInput('c'); // the create hotkey
            return;
          }
          if (mounts.length === 2) {
            view.handleInput('\t'); // Tab hands the flow to the name field
            for (const char of name) view.handleInput(char);
            view.handleInput('enter'); // enter asks to create it
            return;
          }
          view.handleInput('\x1b'); // the returned selector closes: nothing chosen
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      };
      if (mounts.length === 1) drive();
      else tick().then(drive);
    });
  };
  if (typeof beforeFlow === 'function') beforeFlow(mod);
  await warpDef(commands).handler('', built.ctx);
  return { built, mounts, mod };
}

describe('S2: creating from the panel offers the pending changes', { concurrency: false }, () => {
  test('a dirty checkout asks once, and "YES COPY" carries the pending work into the new checkout', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makePendingChangeRepo('wired-create-copy-yes');
      addRegisteredWorktree(root, 'feat/one');
      const target = panelTarget(root, 'feat-pending-change');
      track(path.dirname(target));
      let asked = 0;
      const { built, mounts } = await driveCreateFlow({
        root,
        name: 'pending-change',
        beforeFlow: (mod) => mod.setWarpDirtyAsker(async () => { asked += 1; return 'yes'; }),
      });
      // The question is asked once, and only the selector surfaces mount.
      assert.equal(asked, 1, 'the pending work is reported and the human is asked');
      assert.equal(mounts.length, 3, 'selector, create panel, selector: the question is not a third overlay');
      // The pending work reached the new checkout, and the source keeps it.
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the tracked change travelled');
      assert.equal(fs.readFileSync(path.join(target, 'b.txt'), 'utf8'), 'fresh\n', 'the untracked file travelled');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its work');
      const row = registryLib.readRegistry(root).worktrees.find((entry) => entry.branch === 'feat/pending-change');
      assert.ok(row, 'the created checkout is registered');
      assert.deepEqual(built.switches, [], 'creating still warps nothing: the human picks afterwards');
      assert.deepEqual(built.notes, [], 'nothing is reported: the question was the only interaction');
    } finally {
      restoreEnv();
    }
  });

  test('"NO COPY" creates the checkout from the commit and copies nothing', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makePendingChangeRepo('wired-create-copy-no');
      addRegisteredWorktree(root, 'feat/one');
      const target = panelTarget(root, 'feat-clean-change');
      track(path.dirname(target));
      let asked = 0;
      const { mounts } = await driveCreateFlow({
        root,
        name: 'clean-change',
        beforeFlow: (mod) => mod.setWarpDirtyAsker(async () => { asked += 1; return 'no'; }),
      });
      assert.equal(asked, 1, 'the dirty checkout is reported');
      assert.equal(mounts.length, 3, 'the selector returns after the creation');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\n', 'the checkout is born from the commit');
      assert.equal(fs.existsSync(path.join(target, 'b.txt')), false, 'nothing was copied');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its work');
    } finally {
      restoreEnv();
    }
  });

  test('cancelling the question creates nothing and returns to the selector', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makePendingChangeRepo('wired-create-copy-cancel');
      addRegisteredWorktree(root, 'feat/one');
      const target = panelTarget(root, 'feat-uncopied-change');
      track(path.dirname(target));
      const before = createdState(root);
      let asked = 0;
      const { built, mounts } = await driveCreateFlow({
        root,
        name: 'uncopied-change',
        beforeFlow: (mod) => mod.setWarpDirtyAsker(async () => { asked += 1; return null; }),
      });
      assert.equal(asked, 1, 'the question was asked');
      assert.equal(mounts.length, 3, 'closing the question hands the selector back');
      assert.deepEqual(createdState(root), before, 'no branch, no checkout and no registry row');
      assert.equal(fs.existsSync(target), false, 'the target path was never created');
      assert.deepEqual(built.switches, [], 'nothing moved');
    } finally {
      restoreEnv();
    }
  });

  // The question needs a REAL answer. A checkout whose pending changes cannot
  // be read is NOT clean: creating anyway would silently leave the human's
  // pending work behind right after they asked for a worktree. The creation
  // therefore fails closed — one visible reason, no branch, no checkout, no
  // registry row — and the selector comes back like every other closed flow.
  // The failure is produced through git itself: a corrupt index breaks
  // `git diff`/`git status` (the summary's reads) while `git worktree list`
  // still answers, so the selector itself mounts normally.
  test('an unreadable pending-change summary refuses the creation with a visible reason', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-summary-fail');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      fs.writeFileSync(path.join(root, '.git', 'index'), 'this is not a git index\n');
      const before = createdState(root);
      const target = panelTarget(root, 'feat-unreadable-change');
      track(path.dirname(target));
      const { built, mounts } = await driveCreateFlow({ root, name: 'unreadable-change' });
      assert.equal(mounts.length, 3, 'the selector comes back instead of ending the flow');
      assert.deepEqual(createdState(root), before, 'no branch, no checkout and no registry row');
      assert.equal(fs.existsSync(target), false, 'the target path was never created');
      assert.deepEqual(built.switches, [], 'nothing moved');
      const errors = built.notes.filter(([, level]) => level === 'error');
      assert.equal(errors.length, 1, `exactly one visible refusal, got ${JSON.stringify(built.notes)}`);
      const [message] = errors[0];
      assert.equal(typeof message, 'string', 'the refusal carries text, never undefined');
      assert.match(message, /pending change/i, `the reason names what could not be read: ${message}`);
      assert.match(message, /nothing was created/, 'and states that nothing was written');
    } finally {
      restoreEnv();
    }
  });

  test('a clean checkout never asks and creates exactly as before', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-copy-clean');
      addMainBranch(root); // S2: a new worktree is born from local main
      addRegisteredWorktree(root, 'feat/one');
      const target = panelTarget(root, 'feat-clean-panel');
      track(path.dirname(target));
      let asked = 0;
      const { mounts } = await driveCreateFlow({
        root,
        name: 'clean-panel',
        beforeFlow: (mod) => mod.setWarpDirtyAsker(async () => { asked += 1; return 'yes'; }),
      });
      assert.equal(asked, 0, 'a clean checkout never prompts');
      assert.equal(mounts.length, 3, 'the selector returns after the creation');
      assert.equal(fs.existsSync(target), true, 'the checkout was created');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// The create flow returns to Warp as soon as the checkout path exists.
//
// The slow half of the creation hooks (dependency install, `codegraph init`)
// is what made "confirm" feel like a hang: the selector could not come back
// until an install had finished. The path is all the warp needs, so the setup
// now runs in a managed background task and reports itself when it settles.
// The pending-changes question is one step of this flow like the panel is, so
// it mounts with the SAME bottom overlay — mounted bare it painted as a
// fullscreen component in the middle of the flow. And the question is asked
// ONCE per flow: a create that already took the answer hands it to the one
// warp that follows, so the human is never asked the same thing twice (nor
// offered a second copy the destination would refuse as an overlap).
// ---------------------------------------------------------------------------
describe('create flow: returns to Warp immediately and asks the copy question once', { concurrency: false }, () => {
  // A `codegraph` that sleeps, then drops a marker: the marker's absence at
  // the moment the selector returns is the observable proof of WHEN it ran.
  function makeSlowCodegraph() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cgslow-')));
    const marker = path.join(dir, 'done');
    fs.writeFileSync(
      path.join(dir, 'codegraph'),
      ['#!/bin/sh', 'sleep 0.3', `printf done > "${marker}"`, 'exit 0', ''].join('\n'),
      { mode: 0o755 },
    );
    return { dir, marker };
  }

  // Drive the whole flow with one mount handler that decides each surface's
  // keys: `c` on the selector, the name on the panel, the answer on the
  // question (when it is a real mount) and a choice on the returned selector.
  async function driveCreate({ root, name, asker, pickCreated }) {
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = sessionFileIn();
    const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: async () => null });
    const { commands, mod } = await loadExtension();
    const mounts = [];
    const rendered = [];
    built.ctx.ui.custom = async (factory, options) => {
      mounts.push(options);
      const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('component did not settle')), 5000);
        const done = (value) => { clearTimeout(timer); resolve(value); };
        let view;
        try {
          view = factory(hostTui, plainTheme, {}, done);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }
        rendered.push(clean(view.render(80).join('\n')));
        const drive = () => {
          try {
            const at = mounts.length;
            if (at === 1) {
              view.handleInput('c'); // the create hotkey
              return;
            }
            if (at === 2) {
              view.handleInput('\t');
              for (const char of name) view.handleInput(char);
              view.handleInput('enter'); // confirm the creation
              return;
            }
            // A REAL pending-changes question is its own overlay: answer it.
            if (/YES COPY/.test(rendered[at - 1])) {
              view.handleInput('\r'); // YES COPY
              return;
            }
            // The returned selector: pick the created checkout, or leave.
            if (pickCreated) {
              const others = view.state.checkouts.filter((entry) => entry.path !== root);
              const index = others.findIndex((entry) => entry.name === pickCreated);
              if (index >= 0) {
                for (let step = 0; step < index; step += 1) view.handleInput('\x1b[B');
                view.handleInput('\r');
                return;
              }
            }
            view.handleInput('\x1b');
          } catch (err) {
            clearTimeout(timer);
            reject(err);
          }
        };
        if (mounts.length === 1) drive();
        else tick().then(drive);
      });
    };
    if (typeof asker === 'function') asker(mod);
    await warpDef(commands).handler('', built.ctx);
    return { built, mounts, rendered, mod };
  }

  test('the selector comes back before the setup finishes, and the setup reports itself after', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-bg');
      addMainBranch(root);
      addRegisteredWorktree(root, 'feat/one');
      const target = panelTarget(root, 'feat-slow-setup');
      track(path.dirname(target));
      const slow = makeSlowCodegraph();
      setEnv({ PATH: `${slow.dir}${path.delimiter}${process.env.PATH || ''}` });
      const { built, mounts, mod } = await driveCreate({ root, name: 'slow-setup' });
      assert.equal(mounts.length, 3, 'selector, panel, selector: the flow returned without waiting');
      assert.equal(fs.existsSync(target), true, 'the path the warp needs already exists');
      assert.equal(fs.existsSync(slow.marker), false, 'the slow setup had NOT finished when the selector returned');
      assert.deepEqual(built.notes, [], 'nothing is reported while the setup is still running');
      await mod.awaitPendingCreationSetups();
      assert.equal(fs.existsSync(slow.marker), true, 'the deferred setup still ran, in the background');
      const reports = built.notes.filter(([message]) => /setup/i.test(String(message)));
      assert.equal(reports.length, 1, `exactly one setup report, got ${JSON.stringify(built.notes)}`);
      assert.match(String(reports[0][0]), /setup finished for feat\/slow-setup/, 'the report names the checkout');
      assert.equal(reports[0][1], 'info');
    } finally {
      restoreEnv();
    }
  });

  test('the pending-changes question mounts as the same bottom overlay as the panel', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makePendingChangeRepo('wired-create-question-overlay');
      addRegisteredWorktree(root, 'feat/one');
      const target = panelTarget(root, 'feat-overlay-change');
      track(path.dirname(target));
      const { mounts, rendered } = await driveCreate({ root, name: 'overlay-change' });
      assert.equal(mounts.length, 4, 'selector, panel, question, selector');
      const question = mounts[2];
      assert.equal(question.overlay, true, 'the question is an overlay, never a bare fullscreen component');
      assert.equal(question.overlayOptions.anchor, 'bottom-center', 'the same bottom geometry as Warp');
      assert.equal(question.overlayOptions.width, '100%');
      assert.equal(question.overlayOptions.margin, 0);
      assert.match(rendered[2], /Uncommitted changes/, 'the question states what is at stake');
      assert.match(rendered[2], /YES COPY/);
      assert.match(rendered[2], /NO COPY/);
      assert.equal(mounts[3].overlay, true, 'and the selector still returns as an overlay');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the answer still travels');
    } finally {
      restoreEnv();
    }
  });

  test('a create that already asked does not ask again when the created row is picked', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makePendingChangeRepo('wired-create-no-repeat');
      addRegisteredWorktree(root, 'feat/one');
      const target = panelTarget(root, 'feat-repeat-change');
      track(path.dirname(target));
      let asked = 0;
      const { built, mounts } = await driveCreate({
        root,
        name: 'repeat-change',
        asker: (mod) => mod.setWarpDirtyAsker(async () => { asked += 1; return 'yes'; }),
        pickCreated: 'feat-repeat-change',
      });
      assert.equal(mounts.length, 3, 'selector, panel, selector: the question was asked once, not twice');
      assert.equal(asked, 1, 'the same pending work is never offered twice in one flow');
      assert.deepEqual(built.notes, [], `nothing failed: ${JSON.stringify(built.notes)}`);
      assert.equal(built.switches.length, 1, 'the picked checkout is where the session went');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the copy made at creation is the one that counts');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// A copy can fail PARTWAY: the helper lands some files and then reports the
// failure together with what already landed ("N of M files already copied"),
// which is the only honest state description. The warp's refusal must never
// contradict that evidence with a blanket "nothing was overwritten" — the
// destination really does hold the files this attempt put there — while it
// keeps saying the one thing that IS always true (nothing was rolled back) and
// the partial-copy warning itself.
//
// The partial state is produced through the same seam production uses: the
// extension resolves its helpers from GENTLE_WORKTREE_LIB_DIR, so a shim module
// delegates every read to the real helper and reports a copy that landed one
// file before failing.
// ---------------------------------------------------------------------------
describe('handoff copy failure: the report matches what is really on disk', { concurrency: false }, () => {
  function libDirWithPartialCopy({ landedFile, landedBytes, error }) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-partial-lib-')));
    for (const entry of fs.readdirSync(LIB_DIR)) {
      if (!entry.endsWith('.js') || entry === 'worktree-changes.js') continue;
      fs.symlinkSync(path.join(LIB_DIR, entry), path.join(dir, entry));
    }
    fs.writeFileSync(path.join(dir, 'worktree-changes.js'), [
      "'use strict';",
      `const real = require(${JSON.stringify(path.join(LIB_DIR, 'worktree-changes.js'))});`,
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'module.exports = {',
      '  ...real,',
      '  async copyChanges(args) {',
      `    fs.writeFileSync(path.join(args.to, ${JSON.stringify(landedFile)}), ${JSON.stringify(landedBytes)});`,
      `    return { ok: false, error: ${JSON.stringify(error)} };`,
      '  },',
      '};',
      '',
    ].join('\n'));
    return dir;
  }

  test('a partial copy is reported as partial, never as nothing written', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makePendingChangeRepo('handoff-partial');
      const target = addRegisteredWorktree(root, 'feat/handoff-partial');
      // The destination is born from HEAD (`a.txt` = 'one\n'), so the shim's
      // landed `a.txt` is exactly the file this attempt wrote there.
      const libDir = libDirWithPartialCopy({
        landedFile: 'a.txt',
        landedBytes: 'one\ntwo\n',
        error: 'cannot copy changes: "blocked/second.txt" could not be written; '
          + '1 of 2 files already copied ("a.txt"); the rest were not copied; '
          + 'inspect the destination before retrying',
      });
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: async () => null });
      const { mod } = await loadExtension();
      // The loader pins GENTLE_WORKTREE_LIB_DIR to the real helpers, so the shim
      // is installed after it: every helper call the warp makes resolves through
      // the shim module, which delegates everything except `copyChanges`.
      setEnv({ GENTLE_WORKTREE_LIB_DIR: libDir });
      const out = await mod.executeWorktreeWarp('feat-handoff-partial', built.ctx, {
        handoff: {
          name: 'feat-handoff-partial',
          target: fs.realpathSync(target),
          from: root,
          branch: 'feat/handoff-partial',
          changes: { mode: 'all', paths: [] },
        },
      });
      assert.equal(out.isError, true, `the failed copy refuses the move: ${out.text}`);
      const text = String(out.text);
      assert.match(text, /1 of 2 files already copied/, `the partial-copy warning survives verbatim: ${text}`);
      assert.doesNotMatch(
        text,
        /nothing was overwritten\s*\n/,
        `the refusal never makes an UNQUALIFIED "nothing was overwritten" claim when a file landed: ${text}`,
      );
      assert.match(text, /nothing was rolled back/, `it still states that nothing was undone: ${text}`);
      assert.match(
        text,
        /nothing was overwritten beyond the files listed above/,
        `and it scopes the safety claim to what really happened: ${text}`,
      );
      assert.match(text, /now holds 1 file: a\.txt/, `it names what the destination really holds: ${text}`);
      assert.match(text, /b\.txt does not match the source byte for byte/, `and what is still missing: ${text}`);
      assert.match(text, /recovery:/, 'and offers the recovery');
      assert.deepEqual(built.switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork either');
      // The report matches the disk: the landed file is still there.
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the landed file stays on disk');
      assert.equal(fs.existsSync(path.join(target, 'b.txt')), false, 'the missing file was never written');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'the source keeps its work');
    } finally {
      restoreEnv();
    }
  });
});
