'use strict';
// T10/S14 failure modes the queued warp handoff used to hide:
//
// 1. The tool copied its `changes` selection into the destination BEFORE it
//    queued the move. The command then re-validated the request (decode,
//    destination drift, source drift) and could refuse it, leaving a copy in a
//    checkout the session never entered — and the retry the agent was told to
//    make failed, because `lib/worktree-changes.js` refuses to copy onto a
//    destination that already modifies a selected path. The handoff is
//    fail-safe only if a refused handoff mutates NOTHING.
//
// 2. The handoff token's length cap lived in the DECODE side only, so the tool
//    happily queued a token the command would always reject and reported
//    "handoff queued" — a success that could never happen (and, with (1), left
//    the stranded copy behind).
//
// The contract this file pins: the tool resolves, validates the selection and
// queues; the COMMAND performs the copy after every refusal check and before
// the switch. Everything is asserted through the public surface — the
// `worktree_warp` tool, the `/herdr-gentle:warp` command handler and the files
// on disk — never through internal helpers.

const { test, describe, beforeEach, after } = require('node:test');
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
beforeEach(() => {
  process.env.GENTLE_STATUS_STATE_DIR = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hc-mode-')));
});
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

function modeLib() {
  return require('../lib/worktree-mode.js');
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

// A repository with one committed file, so a pending change and an untracked
// file are both meaningful to the shared copy helper.
function makeFileRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-hc-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-m', 'init']);
  return fs.realpathSync(dir);
}

function addRegistered(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-wt${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const registryLib = require('../lib/worktree-registry.js');
  assert.equal(registryLib.upsertWorktree(root, { branch, path: target, thread: 'thread-1', issues: [], odd: [] }).ok, true);
  return fs.realpathSync(target);
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hc-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const dispatches = [];
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    registerMessageRenderer: () => {},
    on: () => () => {},
    sendUserMessage: (text, sendOptions) => { dispatches.push([text, sendOptions]); },
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  const mod = await import(pathToFileURL(copy).href);
  return { tools, commands, mod, dispatches };
}

// The host's TOOL context: cwd, session manager and UI, and NO session control.
function makeToolCtx({ cwd, sessionFile, entries = [] }) {
  return {
    cwd,
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getLeafId: () => 'leaf-1',
      getEntries: () => entries,
      getSessionDir: () => path.dirname(sessionFile),
    },
  };
}

// The host's COMMAND context: it owns the idle wait and the switch. A test can
// make the switch cancel (`switchResult`) or throw (`switchThrows`) AFTER the
// pending-changes copy has already landed in the destination.
function makeWarpCtx({ cwd, sessionFile, sessionDir, calls, switchResult = { cancelled: false }, switchThrows = null }) {
  const notes = [];
  const sent = [];
  const waited = [];
  const switches = [];
  const session = {
    getSessionFile: () => sessionFile,
    getLeafId: () => 'leaf-1',
    getEntries: () => [],
    getSessionDir: () => sessionDir,
  };
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => { notes.push([message, level]); },
      setStatus: () => {},
    },
    sessionManager: session,
    waitForIdle: async () => { waited.push(true); },
    switchSession: async (file, options) => {
      switches.push([file, typeof options?.withSession]);
      if (switchThrows !== null) throw switchThrows;
      if (typeof options?.withSession === 'function' && switchResult.cancelled !== true) {
        await options.withSession({
          ui: { setStatus: () => {} },
          sendMessage: async (message, sendOptions) => { sent.push([message, sendOptions]); },
        });
      }
      return switchResult;
    },
  };
  void calls;
  return { ctx, notes, sent, waited, switches, session };
}

// Fake SessionManager: the fork inherits the source entries verbatim, like the
// real one, and writes its own session file inside the destination checkout.
function makeFakeSM(calls) {
  let created = 0;
  class FakeTarget {
    constructor(cwd, dir, file) {
      this.cwd = cwd;
      this.dir = dir;
      this.file = file;
      this.leaf = null;
    }
    getSessionFile() { return this.file; }
    getEntries() { return []; }
    getLeafId() { return this.leaf; }
    branch(id) { calls.push(['branch', id]); this.leaf = id; }
    resetLeaf() { calls.push(['resetLeaf']); this.leaf = null; }
    appendCustomEntry(type, data) { calls.push(['appendCustomEntry', type, data]); return 'warp-entry'; }
    appendSessionInfo(name) { calls.push(['appendSessionInfo', name]); return 'session-info'; }
    _appendEntry(entry) { calls.push(['_appendEntry', entry.id]); }
  }
  return class FakeSM {
    static forkFrom(sourcePath, targetCwd, sessionDir) {
      calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
      created += 1;
      const file = path.join(targetCwd, `forked-session-${created}.jsonl`);
      fs.writeFileSync(file, '{"type":"session"}\n');
      return new FakeTarget(targetCwd, sessionDir, file);
    }
    static create(cwd, sessionDir) {
      calls.push(['create', cwd, sessionDir]);
      created += 1;
      const file = path.join(cwd, `created-session-${created}.jsonl`);
      return { getSessionFile: () => file, getHeader: () => ({ type: 'session', cwd }) };
    }
    static open(file, sessionDir, cwdOverride) {
      calls.push(['open', file, sessionDir, cwdOverride]);
      return new FakeTarget(cwdOverride, sessionDir, file);
    }
  };
}

function sessionFileIn() {
  const file = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hc-sess-'))), 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session"}\n');
  return file;
}

function oscFake(isTTY) {
  return { isTTY, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
}

function toolText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

function queuedToken(dispatches) {
  assert.equal(dispatches.length, 1, `expected exactly one queued handoff, got ${dispatches.length}`);
  const [text, sendOptions] = dispatches[0];
  assert.ok(text.startsWith('/herdr-gentle:warp @'), `the queued text is the warp command: ${text}`);
  assert.deepEqual(sendOptions, { expandPromptTemplates: true }, 'the command is dispatched, never sent as a prompt');
  return text.slice('/herdr-gentle:warp '.length);
}

function decodeRequest(token) {
  assert.match(token, /^@[A-Za-z0-9_-]+$/, 'the token is one opaque, charset-bounded argument');
  return JSON.parse(Buffer.from(token.slice(1), 'base64url').toString('utf8'));
}

describe('worktree_warp fail-safe handoff (T10/S14)', { concurrency: false }, () => {
  test('a refused (drifted) handoff mutates nothing, and the retry still copies the pending work', async () => {
    const root = makeFileRepo('drift');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-drift');
      const other = addRegistered(root, 'feat/hc-drift-other');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(root, 'new.txt'), 'fresh\n');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      assert.ok(tool, 'expected worktree_warp to be registered');

      // 1. The tool resolves and queues. It must not touch the destination: the
      //    move is not real yet, so neither are its side effects.
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-drift', changes: 'all' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n',
        'the tool copies nothing into the destination before the move is real');
      assert.equal(fs.existsSync(path.join(target, 'new.txt')), false,
        'the tool leaves no untracked copy in the destination');
      const request = decodeRequest(queuedToken(dispatches));
      assert.equal(request.changes && request.changes.mode, 'all',
        `the handoff carries the change selection, not a copy: ${JSON.stringify(request)}`);
      assert.deepEqual(Object.keys(request).sort(), ['branch', 'changes', 'from', 'name', 'target', 'v'],
        'the token carries checkout identity and the selection only: no file contents, no environment');

      // 2. The command refuses a drifted handoff (the checkout it was told about
      //    is not the one the name resolves to). A refused handoff mutates NOTHING.
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const command = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      const refused = await mod.executeWorktreeWarp('feat-hc-drift', command.ctx, {
        handoff: { ...request, target: other },
        sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(refused.isError, true, 'a drifted handoff refuses');
      assert.match(refused.text, /changed since the handoff was queued/);
      assert.deepEqual(command.switches, [], 'no session switch');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n',
        'the refused handoff left no copy in the destination');
      assert.equal(fs.existsSync(path.join(target, 'new.txt')), false,
        'the refused handoff left no untracked copy in the destination');

      // 3. The retry the refusal asks for still works: no stranded copy means no
      //    "destination already modifies" dead end.
      const retried = await mod.executeWorktreeWarp('feat-hc-drift', command.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(retried.isError, undefined, `the retry succeeds: ${retried.text}`);
      assert.equal(command.switches.length, 1, 'the retry is the one real switch');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n',
        'the move copies the pending change into the checkout it enters');
      assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'fresh\n',
        'the move copies the pending untracked file too');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n',
        'the source checkout keeps its pending work (nothing is moved out of it)');
      assert.equal(fs.existsSync(path.join(root, 'new.txt')), true, 'the source keeps its untracked file');
      assert.deepEqual(command.notes, [], 'a successful handoff stays silent: the card is the confirmation');
    } finally {
      restoreEnv();
    }
  });

  test('an over-limit handoff token is refused before anything is queued or copied', async () => {
    const root = makeFileRepo('oversize');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-oversize');
      // A selection too large for the handoff token: the token is the ONLY
      // input the command parses, so it has a hard length cap. The tool must
      // refuse here — a queued token the command can never decode is a false
      // "handoff queued", and (before this fix) it also stranded a copy.
      const selection = [];
      for (let index = 0; index < 90; index += 1) {
        const name = `pending-note-${String(index).padStart(3, '0')}-${'x'.repeat(24)}.txt`;
        fs.writeFileSync(path.join(root, name), `note ${index}\n`);
        selection.push(name);
      }
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-oversize', changes: selection }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(out.isError, true, `an over-limit handoff refuses: ${toolText(out)}`);
      const text = toolText(out);
      assert.match(text, /too large/i, `the refusal names the reason: ${text}`);
      assert.match(text, /2048/, `the refusal names the limit: ${text}`);
      assert.deepEqual(dispatches, [], 'nothing is queued: no false "handoff queued"');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing was copied');
      assert.equal(fs.readdirSync(target).filter((name) => name.startsWith('pending-note-')).length, 0,
        'no selected file reached the destination');
    } finally {
      restoreEnv();
    }
  });

  test('the queued token is one the command actually accepts, so "handoff queued" is never a false success', async () => {
    const root = makeFileRepo('roundtrip');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-roundtrip');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(root, 'extra.txt'), 'extra\n');
      const sessionFile = sessionFileIn();
      const { tools, commands, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-roundtrip', changes: ['a.txt'] }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      // The tool reports the selection as PENDING, never as copied.
      assert.ok(/^changes: 1 file \(copied when the move lands\)$/m.test(toolText(queued)),
        `the pending text names the pending copy: ${toolText(queued)}`);
      const token = queuedToken(dispatches);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing copied before the move');
      // The host now dispatches the queued command with a COMMAND context.
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const command = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      command.ctx.sessionManager = Object.assign(new FakeSM(), {
        getSessionFile: () => sessionFile,
        getLeafId: () => 'leaf-1',
        getEntries: () => [],
        getSessionDir: () => path.dirname(sessionFile),
      });
      await commands.get('herdr-gentle:warp').handler(token, command.ctx);
      assert.deepEqual(command.notes, [], 'the queued token decoded and warped silently');
      assert.equal(command.switches.length, 1, 'the queued token performed the one real switch');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the selection was copied');
      assert.equal(fs.existsSync(path.join(target, 'extra.txt')), false, 'unselected files stay out');
    } finally {
      restoreEnv();
    }
  });

  // PRESERVE: a handoff with no selection copies nothing and still moves — the
  // shape every pre-existing agent warp uses.
  test('a handoff without changes copies nothing and still moves', async () => {
    const root = makeFileRepo('nochanges');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-none');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-none' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      const token = queuedToken(dispatches);
      const request = decodeRequest(token);
      assert.equal('changes' in request, false, `no selection means no selection in the token: ${JSON.stringify(request)}`);
      assert.equal(/^copied:/m.test(toolText(queued)), false, 'a pending handoff claims no completed copy');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const command = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      const moved = await mod.executeWorktreeWarp('feat-hc-none', command.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(moved.isError, undefined, `the handoff moves: ${moved.text}`);
      assert.equal(command.switches.length, 1, 'the session moved once');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing was copied');
    } finally {
      restoreEnv();
    }
  });

  // PRESERVE: the HUMAN path (no handoff) keeps its interactive dirty gate.
  test('an ordinary warp keeps its dirty gate: it asks, copies and switches', async () => {
    const root = makeFileRepo('humangate');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/hc-human');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const { mod } = await loadExtension();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const command = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      let asked = 0;
      mod.setWarpDirtyAsker(async () => { asked += 1; return 'yes'; });
      try {
        const out = await mod.executeWorktreeWarp('feat-hc-human', command.ctx, {
          sessionManagerClass: FakeSM, oscStream: oscFake(false),
        });
        assert.equal(out.isError, undefined, `expected success: ${out.text}`);
        assert.equal(asked, 1, 'the human path still asks about a dirty source');
        assert.equal(command.switches.length, 1, 'the human warp switches once');
        assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the copy still happens');
      } finally {
        mod.setWarpDirtyAsker(null);
      }
    } finally {
      restoreEnv();
    }
  });

  // The blocker this file exists for, part two: the copy is applied at move time,
  // so a failure AFTER it (the host cancelling or throwing the switch, a fork
  // failure) leaves real files in the destination. That must never be silent, and
  // the retry must not dead-end on "destination already modifies".
  test('a cancelled switch after the copy names the destination and the copied files, and the retry skips the copy', async () => {
    const root = makeFileRepo('postcopy-cancel');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-postcopy');
      // A destination edit that was NOT selected: it must survive everything below.
      fs.writeFileSync(path.join(target, 'b.txt'), 'destination edit\n');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(root, 'new.txt'), 'fresh\n');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-postcopy', changes: 'all' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      const request = decodeRequest(queuedToken(dispatches));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      // The host cancels the switch AFTER the copy landed.
      const command = makeWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        switchResult: { cancelled: true },
      });
      const failed = await mod.executeWorktreeWarp('feat-hc-postcopy', command.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(failed.isError, true, 'a cancelled switch refuses');
      assert.equal(failed.details.cancelled, true, 'cancel stays a real outcome');
      const text = failed.text;
      assert.ok(text.includes(target), `the failure names the destination holding the copy: ${text}`);
      assert.match(text, /2 files: a\.txt, new\.txt/, `the failure names every copied file: ${text}`);
      assert.match(text, /nothing was rolled back/, `the failure states that nothing was undone: ${text}`);
      assert.match(text, /recovery: warp again/, `the failure offers the safe recovery: ${text}`);
      assert.deepEqual(failed.details.copiedFiles.slice().sort(), ['a.txt', 'new.txt'],
        'the details carry the copied files, not just prose');
      assert.equal(failed.details.copyDestination, target, 'the details name the destination');
      // No destructive rollback: the copy stays, the source keeps its work and the
      // destination's unrelated edit is untouched.
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'fresh\n');
      assert.equal(fs.readFileSync(path.join(target, 'b.txt'), 'utf8'), 'destination edit\n');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.existsSync(path.join(root, 'new.txt')), true);

      // The retry the failure asks for: the copy is skipped only because the
      // destination holds exactly those bytes, and the move then happens.
      const retry = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      const moved = await mod.executeWorktreeWarp('feat-hc-postcopy', retry.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(moved.isError, undefined, `the retry moves once the copy is proved identical: ${moved.text}`);
      assert.equal(retry.switches.length, 1, 'the retry performs the one real switch');
      assert.equal(moved.details.copyAlreadyPresent, true, 'the retry reports that it skipped a copy it proved');
      assert.deepEqual(moved.details.copiedFiles.slice().sort(), ['a.txt', 'new.txt']);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'fresh\n');
      assert.equal(fs.readFileSync(path.join(target, 'b.txt'), 'utf8'), 'destination edit\n',
        'the destination edit that was not selected is still untouched');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the source keeps its work');
    } finally {
      restoreEnv();
    }
  });

  test('a throwing switch after the copy reports the copy and leaves it intact', async () => {
    const root = makeFileRepo('postcopy-throw');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-postcopy-throw');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-postcopy-throw', changes: 'all' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      const request = decodeRequest(queuedToken(dispatches));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const command = makeWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        switchThrows: new Error('switch exploded'),
      });
      const failed = await mod.executeWorktreeWarp('feat-hc-postcopy-throw', command.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(failed.isError, true, 'a throwing switch refuses');
      const text = failed.text;
      assert.ok(text.includes('switch exploded'), `the failure keeps the host reason: ${text}`);
      assert.ok(text.includes(target), `the failure names the destination: ${text}`);
      assert.match(text, /1 file: a\.txt/, `the failure names the copied file: ${text}`);
      assert.match(text, /nothing was rolled back/, `the failure states that nothing was undone: ${text}`);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n',
        'the copy is left intact rather than silently deleted');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the source is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('a retry fails closed and explains recovery when the destination copy no longer matches', async () => {
    const root = makeFileRepo('postcopy-drift');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-postcopy-drift');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-postcopy-drift', changes: 'all' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      const request = decodeRequest(queuedToken(dispatches));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const cancelled = makeWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        switchResult: { cancelled: true },
      });
      await mod.executeWorktreeWarp('feat-hc-postcopy-drift', cancelled.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      // The destination's copy is edited after the failure: byte identity is gone,
      // so the retry must NOT overwrite it and must NOT pretend it can skip.
      fs.writeFileSync(path.join(target, 'a.txt'), 'one\nTWO\nedited in the destination\n');
      const retry = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      const callsBeforeRetry = calls.length;
      const refused = await mod.executeWorktreeWarp('feat-hc-postcopy-drift', retry.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(refused.isError, true, 'an unprovable retry fails closed');
      const text = refused.text;
      assert.ok(text.includes(target), `the refusal names the destination: ${text}`);
      assert.ok(text.includes('a.txt'), `the refusal names the file that differs: ${text}`);
      assert.match(text, /nothing was rolled back/, `the refusal states that nothing was undone: ${text}`);
      assert.match(text, /recovery:/, `the refusal offers the safe recovery: ${text}`);
      assert.deepEqual(retry.switches, [], 'no session switch');
      assert.equal(calls.length, callsBeforeRetry, 'the retry forks nothing');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\nedited in the destination\n',
        'the destination edit is never overwritten');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the source is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('an unknown selected file refuses before queueing anything', async () => {
    const root = makeFileRepo('unknown-selection');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-unknown');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-unknown', changes: ['nope.txt'] }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(out.isError, true, `a selection naming no pending file refuses: ${toolText(out)}`);
      const text = toolText(out);
      assert.match(text, /unknown changed file/, `the refusal names the reason: ${text}`);
      assert.ok(text.includes('nope.txt'), `the refusal names the file: ${text}`);
      assert.match(text, /nothing was queued/, `the refusal says nothing was queued: ${text}`);
      assert.deepEqual(dispatches, [], 'nothing is queued: no false "handoff queued"');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing was copied');
    } finally {
      restoreEnv();
    }
  });

  // The proof must tell a MISSING file (ENOENT) from a file this process cannot
  // read. Mode 000 is the reproduction: the summary lists the untracked file, the
  // copy's untracked leg fails on it, and the destination never receives it. If a
  // failed read were treated as "absent on both sides", the retry would claim a
  // proven copy and move the session while silently omitting the file.
  test('an unreadable selected file is never counted as an already-copied deletion', async (t) => {
    const root = makeFileRepo('unreadable');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    const unreadable = path.join(root, 'unreadable.txt');
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-unreadable');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(unreadable, 'cannot be read by this process\n');
      fs.chmodSync(unreadable, 0o000);
      // A privileged runner reads a 0o000 file, so it cannot reproduce EACCES:
      // say so instead of passing silently.
      let denied = false;
      try {
        fs.readFileSync(unreadable);
      } catch {
        denied = true;
      }
      if (!denied) {
        t.skip('this runner can read a 0o000 file (privileged); EACCES cannot be reproduced here');
        return;
      }
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-unreadable', changes: 'all' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      const request = decodeRequest(queuedToken(dispatches));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const command = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      const out = await mod.executeWorktreeWarp('feat-hc-unreadable', command.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(out.isError, true, `an unreadable selected file fails closed: ${out.text}`);
      const text = out.text;
      assert.ok(text.includes('unreadable.txt'), `the refusal names the unreadable file: ${text}`);
      assert.match(text, /could not be read/, `the refusal says why it cannot be proved: ${text}`);
      assert.match(text, /nothing was rolled back and nothing was overwritten/, `the refusal states the safety: ${text}`);
      assert.match(text, /recovery:/, `the refusal offers the recovery: ${text}`);
      assert.notEqual((out.details || {}).copyAlreadyPresent, true,
        'a failed read is never reported as a proven copy');
      assert.deepEqual(command.switches, [], 'the session never moves with the file omitted');
      assert.equal(calls.length, 0, 'no fork happens either');
      // Safety: the destination never receives the unreadable file, and the
      // source keeps it (only its content was unreadable, never its metadata).
      assert.equal(fs.existsSync(path.join(target, 'unreadable.txt')), false,
        'the copy cannot silently write some other content for it');
      assert.equal(fs.lstatSync(unreadable).isFile(), true, 'the source file is still there');
      assert.equal(fs.lstatSync(unreadable).mode & 0o777, 0, 'the source mode is untouched');
    } finally {
      try {
        fs.chmodSync(unreadable, 0o644);
      } catch {
        // Best effort teardown.
      }
      restoreEnv();
    }
  });

  // PRESERVE: a handoff refused for SOURCE DRIFT is refused before the copy, so
  // it reports no copy facts and leaves both checkouts exactly as they were.
  test('a source-drifted handoff refuses before copying anything', async () => {
    const root = makeFileRepo('source-drift');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-source-drift');
      const elsewhere = addRegistered(root, 'feat/hc-source-drift-other');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-source-drift', changes: 'all' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      const request = decodeRequest(queuedToken(dispatches));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      // The session now runs in ANOTHER checkout: the recorded source is stale.
      const command = makeWarpCtx({ cwd: elsewhere, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      const out = await mod.executeWorktreeWarp('feat-hc-source-drift', command.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(out.isError, true, 'a stale source refuses');
      assert.match(out.text, /the session moved since the handoff was queued/);
      assert.equal('copiedFiles' in (out.details || {}), false, 'a pre-copy refusal reports no copy');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing was copied');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the source keeps its work');
      assert.deepEqual(command.switches, [], 'no switch');
    } finally {
      restoreEnv();
    }
  });

  // PRESERVE: the RESUME path (a recorded warp session for this checkout) also
  // reports a post-copy failure, and its retry resumes with a proved skip.
  test('a resume-path failure after the copy reports it and the retry resumes without recopying', async () => {
    const root = makeFileRepo('resume-copy');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const target = addRegistered(root, 'feat/hc-resume');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      // Seed the destination's warp record at the current session's point, so the
      // command takes the RESUME leg (no fork) on both attempts.
      const recordedFile = sessionFileIn();
      const warpSessions = require('../lib/worktree-warp-sessions.js');
      assert.equal(warpSessions.recordWarpSession(root, target, {
        sessionFile: recordedFile, tipId: null, count: 0,
      }).ok, true, 'the destination record seeds')
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const queued = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-resume', changes: 'all' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(queued.isError, undefined, `expected a queued handoff: ${toolText(queued)}`);
      const request = decodeRequest(queuedToken(dispatches));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const failing = makeWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        switchThrows: new Error('resume switch exploded'),
      });
      const failed = await mod.executeWorktreeWarp('feat-hc-resume', failing.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(failed.isError, true, 'the resume switch failure refuses');
      assert.match(failed.text, /resume switch exploded/);
      assert.match(failed.text, /copied into .* before the move failed: 1 file: a\.txt/, `the resume failure reports the copy: ${failed.text}`);
      assert.deepEqual(failed.details.copiedFiles, ['a.txt']);
      assert.equal(calls.length, 0, 'the resume leg forks nothing');
      const retry = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      const moved = await mod.executeWorktreeWarp('feat-hc-resume', retry.ctx, {
        handoff: request, sessionManagerClass: FakeSM, oscStream: oscFake(false),
      });
      assert.equal(moved.isError, undefined, `the retry resumes: ${moved.text}`);
      assert.equal(moved.details.copyAlreadyPresent, true, 'the retry proves the copy instead of repeating it');
      assert.equal(retry.switches.length, 1, 'the retry performs the one switch');
      assert.equal(retry.switches[0][0], recordedFile, 'the retry resumes the recorded session file');
      assert.equal(calls.length, 0, 'still no fork');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n');
    } finally {
      restoreEnv();
    }
  });

  // PRESERVE: the tool's `changes` value set is unchanged — anything that is
  // not "", "all" or a list still fails closed before anything is queued.
  test('an invalid changes selection still refuses before queueing', async () => {
    const root = makeFileRepo('invalid');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      modeLib().writeMode(true, process.env);
      addRegistered(root, 'feat/hc-invalid');
      const sessionFile = sessionFileIn();
      const { tools, mod, dispatches } = await loadExtension();
      const tool = tools.get('worktree_warp');
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-hc-invalid', changes: 'none' }, makeToolCtx({ cwd: root, sessionFile }),
      );
      assert.equal(out.isError, true, 'a verbatim "none" is not a warp value');
      assert.match(toolText(out), /invalid changes selection/);
      assert.deepEqual(dispatches, [], 'nothing is queued');
    } finally {
      restoreEnv();
    }
  });
});
