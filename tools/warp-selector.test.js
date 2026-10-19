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
  const upserted = registryLib.upsertWorktree(root, { branch, path: real, thread: 'thread-1', issues: [], odd: [] });
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
      assert.equal(options.overlay, true, 'the popup is an overlay');
      assert.equal(options.overlayOptions.anchor, 'center');
      assert.ok(options.overlayOptions.maxHeight >= 10, 'the overlay gives the popup its 10 rows');
      assert.match(rendered, /Warp/, 'the popup title renders');
      assert.match(rendered, /current:/, 'the current checkout renders');
      assert.match(rendered, /create a worktree/, 'the create row renders');
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
      const driver = selectorDriver(['\x1b[B', '\r']); // down past create, enter
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
      const driver = selectorDriver(['\r']); // enter on the create row
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
      // Deterministic sources: no `gh`, no filesystem scan.
      mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: [] }));
      mod.setWarpCreateOddLister(() => []);
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
                view.handleInput('\r'); // enter on the create row
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

// The popup's `e` on the admin worktree row: the only other row is the
// create row, so one Down reaches it.
const EDIT_KEYS = ['\x1b[B', 'e'];

describe('T12: editing the focused checkout (S13)', { concurrency: false }, () => {
  test('e opens the panel in editing mode with the checkout REAL branch and path, frozen and pre-selected from the registry', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-open');
      const target = addRegisteredWorktree(root, 'feat/real-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: ['w1-a'] }).ok, true);
      const driver = multiDriver([EDIT_KEYS, (view) => {
        view.handleInput('\x1b[B'); // frozen type -> frozen name
        for (const char of 'zz') view.handleInput(char); // inert typing
        view.handleInput('\x1b');
      }, ['\x1b']]);
      const built = wiredCtx(root, driver);
      const { commands, mod } = await loadExtension();
      panelSources(mod);
      await warpDef(commands).handler('', built.ctx);
      assert.equal(driver.mounts(), 3, 'the selector, the edit panel, then the selector again');
      const text = clean(driver.views[1].render(160).join('\n'));
      assert.match(text, /Edit worktree/, 'the panel opened in editing mode');
      assert.ok(text.includes(`checkout branch: feat/real-target`), `the checkout's OWN branch renders verbatim\n${text}`);
      assert.ok(text.includes(`checkout path: ${target}`), `the checkout's OWN path renders verbatim\n${text}`);
      assert.match(text, /Type: Feature \(feat\) \[frozen\]/, 'the type is frozen');
      assert.match(text, /Name: real-target \[frozen\]/, 'the name is frozen and never re-derived');
      assert.ok(!text.includes('preview branch:'), 'no invented create-time branch');
      assert.match(text, /\[x\] #2/, 'the assigned issue arrives pre-selected');
      assert.match(text, /\[x\] w1-a/, 'the assigned odd document arrives pre-selected');
      assert.deepEqual(built.notes, [], 'Esc is silent');
    } finally {
      restoreEnv();
    }
  });

  test('esc writes nothing: the registry keeps its row byte for byte and the selector reopens', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-esc');
      const target = addRegisteredWorktree(root, 'feat/esc-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: ['w1-a'] }).ok, true);
      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile, 'utf8');
      const watcher = watchRegistryWrites();
      try {
        const driver = multiDriver([EDIT_KEYS, (view) => view.handleInput('\x1b'), ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
        await warpDef(commands).handler('', built.ctx);
        assert.equal(driver.mounts(), 3, 'the selector reopened after the cancel');
        assert.deepEqual(watcher.writes, [], 'Esc performed no registry write');
        const row = registryLib.readRegistry(root).worktrees.find((entry) => entry.path === target);
        assert.deepEqual(row.issues, [2], 'the assigned issues are untouched');
        assert.deepEqual(row.odd, ['w1-a'], 'the assigned odd documents are untouched');
        assert.equal(fs.readFileSync(registryFile, 'utf8'), before, 'the registry file is byte for byte unchanged');
        assert.deepEqual(built.notes, [], 'a cancel notifies nothing');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('confirming writes BOTH fields exactly once, and the selector reopens with the fresh values', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-save');
      const target = addRegisteredWorktree(root, 'feat/save-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: ['w1-a'] }).ok, true);
      const watcher = watchRegistryWrites();
      try {
        const driver = multiDriver([
          EDIT_KEYS,
          (view) => {
            view.handleInput('\t'); // issues pane
            view.handleInput(' '); // toggle #7 on
            view.handleInput('\t'); // odd pane
            view.handleInput('\x1b[B'); // second document
            view.handleInput(' '); // toggle w1-b on
            view.handleInput('\x13'); // ctrl+s saves
          },
          ['\x1b[B', '\x1b'], // focus the checkout row, then close
        ]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
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
        // The panel echoes a stored bare name unchanged and adds a toggled
        // document by its absolute path (its documented row identity), so
        // the saver stores both spellings sorted.
        assert.deepEqual(row.odd, ['/fixtures/odd/w1-b.md', 'w1-a'], 'the selected odd documents were saved');
        assert.equal(driver.mounts(), 3, 'the selector reopened after the save');
        // The popup reads the focused row's facts on the frame that draws
        // it, so prime one frame, let the read settle, then assert.
        driver.views[2].render(120);
        await flush();
        const reopened = clean(driver.views[2].render(120).join('\n'));
        assert.match(reopened, /issues #2 #7/, `the reopened popup shows the saved issues\n${reopened}`);
        assert.deepEqual(built.notes, [], 'a successful save is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('a refusing registry surfaces its error and changes nothing displayed', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-refuse');
      const target = addRegisteredWorktree(root, 'feat/refuse-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: ['w1-a'] }).ok, true);
      const original = registryLib.updateWorktree;
      registryLib.updateWorktree = () => ({ ok: false, error: 'registry is read-only' });
      try {
        const driver = multiDriver([
          EDIT_KEYS,
          (view) => {
            view.handleInput('\t');
            view.handleInput(' '); // try to add #7
            view.handleInput('\x13');
          },
          ['\x1b[B', '\x1b'],
        ]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
        await warpDef(commands).handler('', built.ctx);
        assert.deepEqual(
          built.notes,
          [['warp: cannot save the assignment: registry is read-only', 'error']],
          'the refusing registry surfaces its own error',
        );
        const row = registryLib.readRegistry(root).worktrees.find((entry) => entry.path === target);
        assert.deepEqual(row.issues, [2], 'the refused write changed nothing');
        assert.deepEqual(row.odd, ['w1-a'], 'the refused write changed nothing');
        driver.views[2].render(120);
        await flush();
        const reopened = clean(driver.views[2].render(120).join('\n'));
        assert.match(reopened, /issues #2/, `the reopened popup still shows the old assignment\n${reopened}`);
        assert.ok(!reopened.includes('#7'), 'nothing optimistic is displayed');
      } finally {
        registryLib.updateWorktree = original;
      }
    } finally {
      restoreEnv();
    }
  });
});

describe('T12: the popup and its panes keep the SOURCE order (S15)', { concurrency: false }, () => {
  test('the Issues pane renders the source order verbatim, not a numeric or alphabetical re-sort', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('edited-order');
      const target = addRegisteredWorktree(root, 'feat/order-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [], odd: [] }).ok, true);
      const driver = multiDriver([EDIT_KEYS, (view) => view.handleInput('\x1b'), ['\x1b']]);
      const built = wiredCtx(root, driver);
      const { commands, mod } = await loadExtension();
      panelSources(mod);
      await warpDef(commands).handler('', built.ctx);
      const lines = driver.views[1].render(160).map(clean);
      const at = (needle) => lines.findIndex((line) => line.includes(needle));
      const newest = at('#7 newest update');
      const middle = at('#2 middle update');
      const oldest = at('#9 oldest update');
      assert.ok(newest >= 0 && middle >= 0 && oldest >= 0, `all three rows render\n${lines.join('\n')}`);
      assert.ok(newest < middle, `insertion (recency) order wins over the numeric order\n${lines.join('\n')}`);
      assert.ok(middle < oldest, `insertion (recency) order wins over the numeric order\n${lines.join('\n')}`);
    } finally {
      restoreEnv();
    }
  });

  test('the popup rows are ordered by last activity (commit time), oldest last', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('ordered-rows');
      const older = addRegisteredWorktree(root, 'feat/older');
      commitAt(older, 'old work', '2020-01-02T03:04:05');
      const newer = addRegisteredWorktree(root, 'feat/newer');
      commitAt(newer, 'recent work', '2024-06-07T08:09:10');
      const driver = multiDriver([['\x1b[B', '\x1b']]);
      const built = wiredCtx(root, driver);
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      await flush();
      driver.views[0].render(120);
      await flush();
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
        const driver = multiDriver([['\r'], (view) => {
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

  test('opening the editing panel performs no registry write and no checkout creation, and Esc creates no state', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-open-edit');
      const target = addRegisteredWorktree(root, 'feat/real-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: ['w1-a'] }).ok, true);
      const before = createdState(root);
      const registryFile = registryLib.registryPath(root);
      const registryBytes = fs.readFileSync(registryFile, 'utf8');
      const watcher = watchMutations();
      try {
        const driver = multiDriver([EDIT_KEYS, (view) => {
          view.render(160);
          assert.equal(watcher.events.length, 0, 'drawing the edit panel mutated nothing');
          view.handleInput('\x1b'); // cancel
        }, ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
        await warpDef(commands).handler('', built.ctx);
        assert.equal(driver.mounts(), 3, 'the popup, the edit panel, then the popup again');
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
      restoreEnv();
    }
  });

  test('inside the creating panel navigating, toggling, filtering, paging and help each add no mutation', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-create-keys');
      addRegisteredWorktree(root, 'feat/one');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        let cursorAfterPage = null;
        let oddSelected = null;
        let query = null;
        let helpOpen = null;
        const driver = multiDriver([['\r'], (view) => {
          const step = stepRecorder(view, watcher);
          step('move from the type field to the name field', (v) => v.handleInput('\x1b[B'));
          step('enter the Issues pane', (v) => v.handleInput('\r'));
          step('navigate rows', (v) => v.handleInput('\x1b[B'));
          assert.ok(view.state.cursor.issues > 0, 'the row cursor moved');
          step('page the focused list', (v) => v.handleInput(']'));
          cursorAfterPage = view.state.cursor.issues;
          assert.ok(cursorAfterPage > 1, 'the page key moved the cursor to the next page');
          step('toggle an issue', (v) => v.handleInput(' '));
          assert.equal(view.state.selectedIssues.length, 1, 'the issue toggled');
          step('switch to the Odd pane', (v) => v.handleInput('\t'));
          step('toggle an odd document', (v) => v.handleInput(' '));
          oddSelected = view.state.selectedOdd.length;
          assert.equal(oddSelected, 1, 'the odd document toggled');
          step('open the pane filter with a printable key', (v) => v.handleInput('w'));
          step('type in the filter', (v) => v.handleInput('1'));
          query = view.state.queries.odd;
          assert.ok(query.length > 0, 'the filter received the typed text');
          step('close the filter', (v) => v.handleInput('\x1b'));
          step('open the help', (v) => v.handleInput('?'));
          helpOpen = view.state.help;
          assert.equal(helpOpen, true, 'the help opened');
          step('close the help', (v) => v.handleInput('\x1b'));
          step('cancel the panel', (v) => v.handleInput('\x1b'));
          assert.deepEqual(step.steps.map(([, delta]) => delta), step.steps.map(() => 0), `every interaction added no mutation: ${JSON.stringify(step.steps)}`);
          assert.ok(step.steps.length >= 12, 'every scripted interaction was measured');
        }]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
        mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: manyIssues(20) }));
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

  test('inside the editing panel navigating, toggling, filtering, paging, help and typing in a frozen field each add no mutation', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-write-edit-keys');
      const target = addRegisteredWorktree(root, 'feat/real-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: ['w1-a'] }).ok, true);
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        const driver = multiDriver([EDIT_KEYS, (view) => {
          const step = stepRecorder(view, watcher);
          step('move from the frozen type to the frozen name', (v) => v.handleInput('\x1b[B'));
          step('type in the frozen name field', (v) => {
            for (const char of 'zz') v.handleInput(char);
          });
          assert.equal(view.state.name, '', 'the frozen name field accepted no text');
          step('enter the Issues pane', (v) => v.handleInput('\r'));
          step('navigate rows', (v) => v.handleInput('\x1b[B'));
          assert.ok(view.state.cursor.issues > 0, 'the row cursor moved');
          step('page the focused list', (v) => v.handleInput(']'));
          assert.ok(view.state.cursor.issues > 1, 'the page key moved the cursor to the next page');
          step('toggle an unassigned issue', (v) => v.handleInput(' '));
          assert.equal(view.state.selectedIssues.length, 2, 'exactly the toggled issue was added');
          step('switch to the Odd pane', (v) => v.handleInput('\t'));
          step('navigate the odd rows to an unassigned document', (v) => v.handleInput('\x1b[B'));
          step('toggle an odd document', (v) => v.handleInput(' '));
          assert.equal(view.state.selectedOdd.length, 2, 'exactly the toggled document was added');
          step('open the pane filter with a printable key', (v) => v.handleInput('w'));
          step('type in the filter', (v) => v.handleInput('1'));
          assert.ok(view.state.queries.odd.length > 0, 'the filter received the typed text');
          step('close the filter', (v) => v.handleInput('\x1b'));
          step('open the help', (v) => v.handleInput('?'));
          assert.equal(view.state.help, true, 'the help opened');
          step('close the help', (v) => v.handleInput('\x1b'));
          step('cancel the panel', (v) => v.handleInput('\x1b'));
          assert.deepEqual(step.steps.map(([, delta]) => delta), step.steps.map(() => 0), `every interaction added no mutation: ${JSON.stringify(step.steps)}`);
          assert.ok(step.steps.length >= 15, 'every scripted interaction was measured');
        }, ['\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
        mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: manyIssues(20) }));
        await warpDef(commands).handler('', built.ctx);
        assert.equal(watcher.writes().length, 0, 'zero registry writes across every interaction');
        assert.equal(watcher.creations().length, 0, 'zero checkout creations across every interaction');
        assert.deepEqual(createdState(root), before, 'the assignments and every created state are untouched');
        assert.deepEqual(built.notes, [], 'a cancel is silent');
      } finally {
        watcher.restore();
      }
    } finally {
      restoreEnv();
    }
  });

  test('confirming the edit is the FIRST mutation: exactly one registry write and no creation', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('first-mutation-edit');
      const target = addRegisteredWorktree(root, 'feat/save-target');
      assert.equal(registryLib.updateWorktree(root, target, { issues: [2], odd: ['w1-a'] }).ok, true);
      const watcher = watchMutations();
      try {
        let confirmedAt = 0;
        const driver = multiDriver([EDIT_KEYS, (view) => {
          view.handleInput('\t');
          view.handleInput(' '); // toggle #7 on
          view.handleInput('\t');
          view.handleInput('\x1b[B');
          view.handleInput(' '); // toggle the second odd document on
          assert.deepEqual(watcher.kinds(), [], 'every selection before the confirm wrote nothing');
          confirmedAt = watcher.events.length;
          view.handleInput('\x13'); // the explicit confirm
        }, ['\x1b[B', '\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands, mod } = await loadExtension();
        panelSources(mod);
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
        const driver = multiDriver([['\r'], (view) => {
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
        const driver = multiDriver([['\r'], (view) => {
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
      commitAt(older, 'old work', '2020-01-02T03:04:05');
      const newer = addRegisteredWorktree(root, 'feat/newer');
      commitAt(newer, 'recent work', '2024-06-07T08:09:10');
      const driver = multiDriver([['r', '\x1b']]);
      const built = wiredCtx(root, driver);
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', built.ctx);
      await flush();
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
