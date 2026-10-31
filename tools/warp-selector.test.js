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
              view.handleInput('\x1b[B'); // the inline type list moves to Bug fix
              view.handleInput('\x1b[A'); // and back to Feature, the expected type
              view.handleInput('\t'); // Tab hands the flow to the name field
              for (const char of 'panel-change') view.handleInput(char);
              view.handleInput('enter'); // enter creates
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
// S1/S4: the warp popup reaches NO worktree modification any more. The old
// `e` opened the full-screen worktree detail and deleted issues/ODD
// associations there; `ctrl+d` (panel and extended list) opened the delete
// confirmation. Both views were removed with the association, so every one of
// those keys is inert and mutates nothing.
describe('S1/S4: the warp popup cannot edit or delete a worktree', { concurrency: false }, () => {
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

  test('`ctrl+d` in the panel and in the extended list deletes nothing', async () => {
    setEnv(warpStateEnv());
    try {
      const root = makeRepo('no-delete-key');
      const target = addRegisteredWorktree(root, 'feat/del-target');
      const before = createdState(root);
      const watcher = watchMutations();
      try {
        // `v` enters the extended list, where Ctrl+D used to resolve a delete.
        const driver = multiDriver([['v', '\x04', 'ctrl+d', '\x1b', '\x04', 'ctrl+d', '\x1b']]);
        const built = wiredCtx(root, driver);
        const { commands } = await loadExtension();
        await warpDef(commands).handler('', built.ctx);
        assert.deepEqual(built.confirms, [], 'no deletion confirmation was asked');
        assert.deepEqual(watcher.kinds(), [], 'nothing was removed and nothing was written');
        assert.deepEqual(createdState(root), before, 'the checkout is still there');
        assert.ok(fs.existsSync(target), 'the checkout directory still exists on disk');
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
        const { commands } = await loadExtension();
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
          view.handleInput('enter'); // the explicit confirm key
        }]);
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
