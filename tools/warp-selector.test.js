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

async function loadExtension() {
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
      const { tools } = await loadExtension();
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
      addRegisteredWorktree(root, 'feat/one');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['c']); // S6: the create hotkey
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: driver.mount });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.customs.length, 2, 'the selector then the create panel mounted');
      assert.equal(built.customs[1].overlay, true, 'the create panel is an overlay too');
      assert.ok(!built.notes.some(([message]) => /nothing was created/.test(message)), 'no create failure');
    } finally {
      restoreEnv();
    }
  });

  test("the panel payload reaches the existing creation path: the branch is created, registered and warped into", async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'wired-thread' }));
    try {
      const root = makeRepo('wired-create-run');
      addRegisteredWorktree(root, 'feat/one');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const built = makeWiredCtx({ cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, mount: async () => null });
      const { commands, mod } = await loadExtension();
      // S6: the create panel consults NO issue or odd source, so these two
      // stubs throw if the creation ever asks for one.
      mod.setWarpCreateIssuesFetcher(async () => { throw new Error('the create panel must not list issues'); });
      mod.setWarpCreateOddLister(() => { throw new Error('the create panel must not list odd documents'); });
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
                view.handleInput('c'); // S6: the create hotkey
                return;
              }
              view.handleInput('\x1b[B'); // type -> name
              for (const char of 'panel-change') view.handleInput(char);
              view.handleInput('\x13'); // ctrl+s creates
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
      assert.equal(built.switches.length, 1, 'the session warped into the new worktree');
      assert.deepEqual(built.notes, [], 'creation then warp is silent on success');
    } finally {
      restoreEnv();
    }
  });

  test('the extended-list delete flow stays reachable and still guarded', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-delete');
      const target = addRegisteredWorktree(root, 'feat/del');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      // `v` opens the extended list; Ctrl+D on the principal is guarded;
      // down + Ctrl+D targets the agent worktree.
      const driver = selectorDriver(['v', '\x04', '\x1b[B', '\x04']);
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: driver.mount, confirmImpl: () => true,
      });
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => {
        closeCalls.push(params);
        return { isError: false, text: 'removed: feat-del \u00b7 feat/del', details: {} };
      });
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.confirms.length, 1, 'the principal row is never deletable');
      assert.equal(built.confirms[0][0], `Delete worktree 'feat-del'?`);
      assert.equal(built.confirms[0][1], `Delete worktree checkout at ${target} for branch 'feat/del'? This removes the checkout but keeps the branch.`);
      assert.deepEqual(closeCalls, [{ path: target }], 'the shared close ran once for the approved row');
      assert.deepEqual(built.notes, [['removed: feat-del \u00b7 feat/del', 'info']], 'the success text is unchanged');
      assert.equal(driver.mounts(), 2, 'the selector reopened after the delete');
    } finally {
      restoreEnv();
    }
  });

  test('a refused deletion changes nothing and reopens the selector', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-delete-cancel');
      addRegisteredWorktree(root, 'feat/del');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['v', '\x1b[B', '\x04']);
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: driver.mount, confirmImpl: () => false,
      });
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => { closeCalls.push(params); return { isError: false, text: 'removed', details: {} }; });
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.confirms.length, 1);
      assert.deepEqual(closeCalls, [], 'a refusal removes nothing');
      assert.deepEqual(built.notes, [], 'a refusal notifies nothing');
      assert.equal(driver.mounts(), 2, 'the selector reopened');
    } finally {
      restoreEnv();
    }
  });

  test('a dirty target names its pending changes and the approval carries force for exactly that row', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-delete-dirty');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
      git(root, ['add', 'a.txt']);
      git(root, ['commit', '-m', 'seed']);
      const target = addRegisteredWorktree(root, 'feat/del');
      fs.appendFileSync(path.join(target, 'a.txt'), 'dirty\n');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['v', '\x04', '\x1b[B', '\x04']);
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: driver.mount, confirmImpl: () => true,
      });
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => { closeCalls.push(params); return { isError: false, text: 'removed', details: {} }; });
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.confirms.length, 1);
      assert.match(built.confirms[0][1], /Pending changes: 1 file, \+1\/-0\.$/, 'the dirty row names its pending changes');
      assert.deepEqual(closeCalls, [{ path: target, force: true }], 'the explicit Yes carries force for that row');
    } finally {
      restoreEnv();
    }
  });

  test('YOLO active waives the deletion confirmation for a clean row', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-delete-yolo');
      const target = addRegisteredWorktree(root, 'feat/del');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['v', '\x04', '\x1b[B', '\x04']);
      // confirmImpl refuses everything: the row must be deleted without ever
      // consulting it, which is what proves the waiver.
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: driver.mount, confirmImpl: () => false,
      });
      answerYolo('ON');
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => { closeCalls.push(params); return { isError: false, text: 'removed', details: {} }; });
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.confirms.length, 0, 'YOLO waives the clean row confirmation');
      assert.deepEqual(closeCalls, [{ path: target }], 'the shared close ran once, without force');
      assert.deepEqual(built.notes, [['removed', 'info']], 'the success text is unchanged');
    } finally {
      restoreEnv();
      resetYolo();
    }
  });

  test('YOLO never waives the deletion confirmation of a dirty row', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-delete-yolo-dirty');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
      git(root, ['add', 'a.txt']);
      git(root, ['commit', '-m', 'seed']);
      const target = addRegisteredWorktree(root, 'feat/del');
      fs.appendFileSync(path.join(target, 'a.txt'), 'dirty\n');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['v', '\x04', '\x1b[B', '\x04']);
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: driver.mount, confirmImpl: () => true,
      });
      answerYolo('ON');
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => { closeCalls.push(params); return { isError: false, text: 'removed', details: {} }; });
      await warpDef(commands).handler('', built.ctx);
      assert.equal(built.confirms.length, 1, 'a dirty row is confirmed even under YOLO');
      assert.deepEqual(closeCalls, [{ path: target, force: true }], 'the explicit Yes still carries force for that row');
    } finally {
      restoreEnv();
      resetYolo();
    }
  });

  test('the ordinary delete failure text is unchanged and nothing is removed silently', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('wired-delete-fail');
      addRegisteredWorktree(root, 'feat/del');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const driver = selectorDriver(['v', '\x1b[B', '\x04']);
      const built = makeWiredCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        mount: driver.mount, confirmImpl: () => true,
      });
      const { commands, mod } = await loadExtension();
      const refusal = 'cannot close the worktree at /somewhere: dirty checkout';
      mod.setWarpCloseRunner(async () => ({ isError: true, text: refusal, details: {} }));
      await warpDef(commands).handler('', built.ctx);
      assert.deepEqual(built.notes, [[refusal, 'error']], 'the close refusal is reported verbatim');
      assert.equal(driver.mounts(), 2, 'the selector reopened after the failure');
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

// The editing panel's fixture world: issues in the SOURCE (recency) order,
// odd documents in modification order, and previews that never spawn `gh`.
const SOURCE_ISSUES = [
  { number: 7, title: 'newest update' },
  { number: 2, title: 'middle update' },
  { number: 9, title: 'oldest update' },
];
const SOURCE_ODD = [
  { name: 'w1-a', path: '/fixtures/odd/w1-a.md' },
  { name: 'w1-b', path: '/fixtures/odd/w1-b.md' },
];

function panelSources(mod) {
  mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: SOURCE_ISSUES.map((row) => ({ ...row })) }));
  mod.setWarpCreateOddLister(() => SOURCE_ODD.map((doc) => ({ ...doc })));
  // Both seams are optional while the wiring is incomplete (RED), so a
  // missing setter never makes a suite reach for a live `gh`.
  if (typeof mod.setWarpCreateIssuePreviewReader === 'function') {
    mod.setWarpCreateIssuePreviewReader((number) => ({
      ok: true,
      issue: { number, title: `Issue ${number}`, state: 'open', author: 'ana', body: `body ${number}` },
      comments: [],
    }));
  }
  if (typeof mod.setWarpCreateOddPreviewReader === 'function') {
    mod.setWarpCreateOddPreviewReader((doc) => ({ ok: true, text: `# ${doc.name}\n\nspecs` }));
  }
}

const ghIssues = require('../lib/gh-issues.js');

// The worktree detail lists the checkout's OPEN issues and previews them
// through the shared gh client; this stub answers both, and answers 404 for a
// number it does not know, so no test ever spawns the binary.
function stubDetailGh(openNumbers = [2, 7]) {
  const calls = [];
  // The same cursor-paged connection the production prime reads: the detail's
  // open-issue snapshot arrives through it, never through a live binary.
  const graphqlSnapshot = () => JSON.stringify({
    data: {
      repository: {
        issues: {
          totalCount: openNumbers.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: openNumbers.map((number) => ({
            number,
            title: `issue title ${number}`,
            state: 'OPEN',
            stateReason: '',
            author: { login: 'octo' },
            labels: { nodes: [] },
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-02T00:00:00Z',
            url: `https://example.test/issues/${number}`,
            comments: { totalCount: 0 },
            reactionGroups: [],
          })),
        },
      },
    },
  });
  ghIssues.setGhRunner(async (bin, argv) => {
    calls.push(argv.slice());
    if (argv[0] === 'api' && argv[1] === 'graphql') return { status: 0, stdout: graphqlSnapshot(), stderr: '' };
    if (argv[0] === 'api' && argv[1] === 'user') return { status: 0, stdout: '{"login":"octo"}', stderr: '' };
    if (argv[0] === 'repo' && argv[1] === 'view') return { status: 0, stdout: '{"nameWithOwner":"octo/repo"}', stderr: '' };
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const rows = openNumbers.map((number) => ({
        number,
        title: `issue title ${number}`,
        state: 'open',
        author: { login: 'octo' },
        labels: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      }));
      return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
    if (argv[0] === 'issue' && argv[1] === 'view') {
      const number = Number(argv[2]);
      if (!openNumbers.includes(number)) {
        return { status: 1, stdout: '', stderr: `GraphQL: Could not resolve to an Issue with the number of ${number}. (repository.issue)` };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ number, title: `issue title ${number}`, state: 'open', body: `body ${number}`, comments: [] }),
        stderr: '',
      };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  });
  return calls;
}

// An odd document inside the checkout the detail reads.
function writeOddDoc(target, name) {
  const file = path.join(target, 'odd', 'tasks', `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${name}\n\nspecs\n`);
  return file;
}

// Drive the registry's write seam: the count and the patch are what prove
// "both fields, exactly one write". The extension requires the same module
// object, so a local wrapper observes every save without touching git.
function watchRegistryWrites() {
  const original = registryLib.updateWorktree;
  const writes = [];
  registryLib.updateWorktree = (repoRoot, key, patch, opts) => {
    writes.push({ key, patch });
    return original(repoRoot, key, patch, opts);
  };
  return {
    writes,
    restore: () => { registryLib.updateWorktree = original; },
  };
}

// The panel's `e` on the first listed worktree row: creation is no longer a
// row (S6), so the first row is already the focused checkout.
const EDIT_KEYS = ['e'];

describe('T12: `e` opens the worktree detail (S7, S13)', { concurrency: false }, () => {
  test('e mounts the full-screen detail with the checkout real branch, path and stored assignment', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-open');
      const target = addRegisteredWorktree(root, 'feat/real-target');
      writeOddDoc(target, 'w1-a');
      writeOddDoc(target, 'w1-b');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: 'w1-a' }).ok, true);
      stubDetailGh([2, 7]);
      let rendered = '';
      let oddRendered = '';
      const driver = multiDriver([['e'], (view) => {
        rendered = clean(view.render(120).join('\n'));
        view.handleInput('tab');
        oddRendered = clean(view.render(120).join('\n'));
        view.handleInput('\x1b');
      }, ['\x1b']]);
      const built = wiredCtx(root, driver);
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      assert.equal(driver.mounts(), 3, 'the selector, the detail, then the selector again');
      // S7: full screen, never the old centred create/edit popup.
      assert.deepEqual(built.customs[1], {
        overlay: true,
        overlayOptions: { anchor: 'center', width: '100%', maxHeight: '100%', margin: 0 },
      });
      assert.ok(rendered.includes(target), `the detail names the checkout path\n${rendered}`);
      assert.match(rendered, /feat-real-target/, 'the checkout name');
      assert.match(rendered, /branch feat\/real-target/, 'the REAL branch, read from git');
      assert.match(rendered, /\[x\] #2/, 'the stored issue arrives pre-selected');
      assert.match(oddRendered, /● w1-a/, 'the stored odd document is the active one (one, never a list)');
      assert.match(oddRendered, /○ w1-b/, 'and the other document is offered but not selected');
      assert.deepEqual(built.notes, [], 'Esc is silent');
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('esc writes nothing: the registry keeps its row byte for byte and the selector reopens', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-esc');
      const target = addRegisteredWorktree(root, 'feat/esc-target');
      writeOddDoc(target, 'w1-a');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: 'w1-a' }).ok, true);
      stubDetailGh([2, 7]);
      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile, 'utf8');
      const watcher = watchRegistryWrites();
      try {
        const driver = multiDriver([EDIT_KEYS, (view) => view.handleInput('\x1b'), ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(driver.mounts(), 3, 'the selector reopened after the cancel');
        assert.deepEqual(watcher.writes, [], 'Esc performed no registry write');
        const row = registryLib.readRegistry(root).worktrees.find((entry) => entry.path === target);
        assert.deepEqual(row.issues, [2], 'the assigned issues are untouched');
        assert.equal(row.odd, 'w1-a', 'the assigned odd document is untouched');
        assert.equal(fs.readFileSync(registryFile, 'utf8'), before, 'the registry file is byte for byte unchanged');
        assert.deepEqual(built.notes, [], 'a cancel notifies nothing');
      } finally {
        watcher.restore();
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('ctrl+s writes BOTH fields exactly once, and the selector reopens with the fresh values', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-save');
      const target = addRegisteredWorktree(root, 'feat/save-target');
      writeOddDoc(target, 'w1-a');
      writeOddDoc(target, 'w1-b');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: 'w1-a' }).ok, true);
      stubDetailGh([2, 7]);
      const watcher = watchRegistryWrites();
      try {
        const driver = multiDriver([
          EDIT_KEYS,
          (view) => {
            // ODD tab: filter down to the second document and select it.
            view.handleInput('tab');
            view.handleInput('T');
            for (const char of 'w1-b') view.handleInput(char);
            view.handleInput('\r');
            view.handleInput(' ');
            // Issues tab: filter to #7 and assign it.
            view.handleInput('tab');
            view.handleInput('T');
            view.handleInput('7');
            view.handleInput('\r');
            view.handleInput(' ');
            view.handleInput('\x13');
            view.handleInput('\x1b');
          },
          ['\x1b'],
        ]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(watcher.writes.length, 1, 'exactly ONE registry write carries both fields');
        assert.equal(watcher.writes[0].key, target, 'the write targets the edited checkout');
        assert.deepEqual(
          Object.keys(watcher.writes[0].patch).sort(),
          ['issues', 'odd'],
          'the single patch carries both assignment fields',
        );
        const row = registryLib.readRegistry(root).worktrees.find((entry) => entry.path === target);
        assert.deepEqual(row.issues, [2, 7], 'the selected issues were saved');
        // S8a: the ODD control is a SELECT, so choosing the second document
        // REPLACES the stored one instead of adding to it.
        assert.equal(row.odd, 'odd/tasks/w1-b.md', 'the chosen odd document replaced the stored one, never joined it');
        assert.equal(driver.mounts(), 3, 'the selector reopened after the save');
        const reopened = await waitForFactsFooter(driver.views[2]);
        assert.match(reopened, /issues 2/, `the reopened popup shows the saved issue count\n${reopened}`);
        assert.deepEqual(built.notes, [], 'a successful save is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('a refusing registry surfaces its error in the detail and changes nothing stored', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-refuse');
      const target = addRegisteredWorktree(root, 'feat/refuse-target');
      writeOddDoc(target, 'w1-a');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: 'w1-a' }).ok, true);
      stubDetailGh([2, 7]);
      const original = registryLib.updateWorktree;
      registryLib.updateWorktree = () => ({ ok: false, error: 'registry is read-only' });
      try {
        let rendered = '';
        const driver = multiDriver([EDIT_KEYS, async (view) => {
          view.handleInput('T');
          view.handleInput('7');
          view.handleInput('\r');
          view.handleInput(' ');
          view.handleInput('\x13');
          await tick();
          rendered = clean(view.render(120).join('\n'));
          view.handleInput('\x1b');
        }, ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.match(rendered, /save failed: registry is read-only/, 'the refusing registry surfaces its own error');
        assert.deepEqual(built.notes, [], 'the failure is shown in the surface, not announced');
      } finally {
        registryLib.updateWorktree = original;
      }
      const row = registryLib.readRegistry(root).worktrees.find((entry) => entry.path === target);
      assert.deepEqual(row.issues, [2], 'the refused write changed nothing');
      assert.equal(row.odd, 'w1-a', 'the refused write changed nothing');
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });
});

describe('T12: the popup and its panes keep the SOURCE order (S15)', { concurrency: false }, () => {
  test('the Issues tab lists assigned first, then descending number, and only open issues', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-order');
      const target = addRegisteredWorktree(root, 'feat/order-target');
      writeOddDoc(target, 'w1-a');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: null }).ok, true);
      stubDetailGh([2, 7, 9]);
      let rendered = '';
      const driver = multiDriver([EDIT_KEYS, (view) => {
        rendered = clean(view.render(160).join('\n'));
        view.handleInput('\x1b');
      }, ['\x1b']]);
      const built = wiredCtx(root, driver);
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      const order = [...rendered.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
      const at = (number) => order.indexOf(number);
      assert.ok(at(2) >= 0 && at(9) >= 0 && at(7) >= 0, `all three open issues render\n${rendered}`);
      assert.ok(at(2) < at(9), `the assigned issue comes first\n${rendered}`);
      assert.ok(at(9) < at(7), `then descending issue number\n${rendered}`);
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

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

describe('T16: the panels write nothing until the user confirms (S17)', { concurrency: false }, () => {
  test('opening the creating panel performs no registry write and no checkout creation, and Esc creates no state', async () => {
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
        const { commands, mod } = await loadExtension();
        panelSources(mod);
        await warpDef(commands).handler('', built.ctx);
        assert.equal(driver.mounts(), 2, 'the popup then the create panel mounted');
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

  test('opening the worktree detail performs no registry write and no checkout creation, and Esc creates no state', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-open-edit');
      const target = addRegisteredWorktree(root, 'feat/real-target');
      writeOddDoc(target, 'w1-a');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: 'w1-a' }).ok, true);
      stubDetailGh([2, 7]);
      const before = createdState(root);
      const registryFile = registryLib.registryPath(root);
      const registryBytes = fs.readFileSync(registryFile, 'utf8');
      const watcher = watchMutations();
      try {
        const driver = multiDriver([EDIT_KEYS, (view) => {
          view.render(160);
          assert.equal(watcher.events.length, 0, 'drawing the detail mutated nothing');
          view.handleInput('\x1b'); // cancel
        }, ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(driver.mounts(), 3, 'the popup, the detail, then the popup again');
        assert.deepEqual(watcher.kinds(), [], 'opening (and cancelling) wrote nothing');
        assert.equal(watcher.writes().length, 0, 'zero registry writes');
        assert.equal(watcher.creations().length, 0, 'zero checkout creations');
        assert.deepEqual(createdState(root), before, 'no created state');
        assert.equal(fs.readFileSync(registryFile, 'utf8'), registryBytes, 'the registry file is byte for byte unchanged');
        assert.deepEqual(built.notes, [], 'a cancel is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('inside the creating panel both steps, tab and help each add no mutation', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-create-keys');
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        const driver = multiDriver([['c'], (view) => {
          const step = stepRecorder(view, watcher);
          step('open the change-type picker', (v) => v.handleInput('\r'));
          assert.equal(view.state.typePanelOpen, true, 'the type picker opened');
          step('move inside the type picker', (v) => v.handleInput('\x1b[B'));
          step('pick the change type', (v) => v.handleInput('\r'));
          assert.equal(view.state.focus, 'name', 'step 1 hands over to step 2');
          step('type the change name', (v) => {
            for (const char of 'panel-change') v.handleInput(char);
          });
          assert.equal(view.state.name, 'panel-change', 'the name field kept the typed value');
          step('return to the type field', (v) => v.handleInput('\x1b[A'));
          assert.equal(view.state.focus, 'type');
          step('press tab', (v) => v.handleInput('\t'));
          assert.equal(view.state.focus, 'type', 'S6: tab reaches no pane');
          step('ask for help', (v) => v.handleInput('?'));
          assert.equal(view.state.focus, 'type', '? opens nothing');
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

  test('inside the worktree detail navigating, filtering and selecting each add no mutation', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-edit-keys');
      const target = addRegisteredWorktree(root, 'feat/real-target');
      writeOddDoc(target, 'w1-a');
      writeOddDoc(target, 'w1-b');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: 'w1-a' }).ok, true);
      stubDetailGh([2, 7]);
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        const driver = multiDriver([EDIT_KEYS, (view) => {
          const step = stepRecorder(view, watcher);
          step('navigate the issue rows', (v) => v.handleInput('down'));
          assert.ok(view.state.cursor.issues > 0, 'the row cursor moved');
          step('filter the issues', (v) => {
            v.handleInput('T');
            for (const char of '7') v.handleInput(char);
            v.handleInput('\r');
          });
          assert.deepEqual(view.state.issues, [2], 'filtering selects nothing');
          step('assign the filtered issue', (v) => v.handleInput(' '));
          assert.deepEqual(view.state.issues, [2, 7], 'exactly the toggled issue was added');
          step('switch to the ODD tab', (v) => v.handleInput('tab'));
          step('filter the documents', (v) => {
            v.handleInput('T');
            for (const char of 'w1-b') v.handleInput(char);
            v.handleInput('\r');
          });
          step('select that document', (v) => v.handleInput(' '));
          assert.match(String(view.state.odd), /w1-b/, 'the chosen document REPLACED the active one');
          assert.equal(Array.isArray(view.state.odd), false, 'never a list');
          step('scroll the preview', (v) => v.handleInput('ctrl+j'));
          step('cancel the detail', (v) => v.handleInput('\x1b'));
          assert.deepEqual(step.steps.map(([, delta]) => delta), step.steps.map(() => 0), `every interaction added no mutation: ${JSON.stringify(step.steps)}`);
          assert.ok(step.steps.length >= 8, 'every scripted interaction was measured');
        }, ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(watcher.writes().length, 0, 'zero registry writes across every interaction');
        assert.equal(watcher.creations().length, 0, 'zero checkout creations across every interaction');
        assert.deepEqual(createdState(root), before, 'the assignments and every created state are untouched');
        assert.deepEqual(built.notes, [], 'a cancel is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('confirming the edit is the FIRST mutation: exactly one registry write and no creation', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('first-mutation-edit');
      const target = addRegisteredWorktree(root, 'feat/save-target');
      writeOddDoc(target, 'w1-a');
      writeOddDoc(target, 'w1-b');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: 'w1-a' }).ok, true);
      stubDetailGh([2, 7]);
      const watcher = watchMutations();
      try {
        let confirmedAt = 0;
        const driver = multiDriver([EDIT_KEYS, (view) => {
          view.handleInput('tab');
          view.handleInput('T');
          for (const char of 'w1-b') view.handleInput(char);
          view.handleInput('\r');
          view.handleInput(' '); // choose the second odd document (replaces)
          view.handleInput('tab');
          view.handleInput('T');
          view.handleInput('7');
          view.handleInput('\r');
          view.handleInput(' '); // assign #7
          assert.deepEqual(watcher.kinds(), [], 'every selection before the confirm wrote nothing');
          confirmedAt = watcher.events.length;
          view.handleInput('\x13'); // the explicit confirm
          view.handleInput('\x1b');
        }, ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.equal(confirmedAt, 0, 'nothing was mutated before the confirm');
        assert.deepEqual(watcher.kinds(), ['registry-write'], 'confirming is the first and only mutation');
        assert.equal(watcher.writes().length, 1, 'editing performs exactly ONE registry write');
        assert.equal(watcher.creations().length, 0, 'editing creates no checkout');
        assert.equal(watcher.writes()[0].name, 'updateWorktree', 'the write goes through the registry entry point');
        assert.equal(watcher.writes()[0].key, target, 'and targets the edited checkout');
        assert.equal(driver.mounts(), 3, 'the selector reopened after the save');
        assert.deepEqual(built.notes, [], 'a successful save is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('confirming the creation is the FIRST mutation, and the checkout creation precedes the one registry write', async () => {
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'first-mutation-thread' }));
    try {
      const root = makeRepo('first-mutation-create');
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        let confirmedAt = 0;
        const driver = multiDriver([['c'], (view) => {
          view.handleInput('\x1b[B');
          for (const char of 'nothing-yet') view.handleInput(char);
          assert.deepEqual(watcher.kinds(), [], 'navigating and typing before the confirm wrote nothing');
          confirmedAt = watcher.events.length;
          view.handleInput('\x13'); // the explicit confirm
        }]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
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
        assert.equal(built.switches.length, 1, 'the session warped into the new checkout');
        assert.deepEqual(built.notes, [], 'creation then warp is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('a refused session preflight performs no mutation at all: no branch, no checkout, no write', async () => {
    // A resolvable thread identity: without the preflight this fixture WOULD
    // create, so a preflight that ran after the first mutation is caught.
    setEnv(warpStateEnv({ GENTLE_WORKTREE_THREAD: 'refused-preflight-thread' }));
    try {
      const root = makeRepo('refused-preflight');
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
          view.handleInput('\x13'); // the explicit confirm
        }]);
        const built = makeWiredCtx({
          cwd: root,
          FakeSM: makeFakeSM([]),
          sessionFile,
          sessionDir: path.dirname(sessionFile),
          calls: [],
          mount: driver.mount,
        });
        const { commands, mod } = await loadExtension();
        panelSources(mod);
        await warpDef(commands).handler('', built.ctx);
        assert.equal(confirmedAt, 0, 'nothing was mutated before the confirm');
        assert.deepEqual(watcher.kinds(), [], 'a refused preflight mutates nothing');
        assert.equal(watcher.writes().length, 0, 'zero registry writes');
        assert.equal(watcher.creations().length, 0, 'zero checkout creations');
        assert.deepEqual(createdState(root), before, 'no branch, no checkout, no registry row');
        assert.deepEqual(built.notes, [[
          'warp: no persisted session for this session and nothing in memory to carry over; open or write the session first and retry',
          'error',
        ]], 'the refusal is reported instead of a half-made worktree');
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
