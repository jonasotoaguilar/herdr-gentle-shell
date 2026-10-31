'use strict';
// worktree-ui-redesign S1/S4/S5/S9/S8b/S12 wiring tests, as the extension
// actually reaches the warp popup.
//
// S1/S4 removed the worktree edit panel, the full-screen worktree detail and
// the keyboard delete view together with the issue/ODD association: a
// worktree is no longer modified from the warp popup. This file pins that
// public surface from the outside — the overlays the host receives, the
// component that mounted, the keys it reads, and the writes that reach the
// real modules:
// - `e` on a focused row opens nothing at all: no edit popup, no detail, no
//   second mount, and not one registry or checkout change;
// - `ctrl+d` is inert too: no confirmation, no close, nothing removed, and
//   the panel stays up until `esc`;
// - the panel legend advertises only the surviving keys (`c create`, `v all`,
//   `r reload`, `esc close`) and never `e edit` or `ctrl+d delete`;
// - the extension exposes no worktree detail or warp-close seam any more, and
//   `/herdr-gentle:worktree` is never registered (S5);
// - `worktree_list` orders the principal first, then the session's own
//   checkout, then the rest, with no duplicate when they are the same;
// - legacy associations are preserved (never migrated) and a discarded ODD
//   document is still named by the write that drops it;
// - `c` opens compact create at the bottom and a cancel creates nothing.

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

const registryLib = require('../lib/worktree-registry.js');
const ghIssues = require('../lib/gh-issues.js');

const roots = [];
const savedEnv = { ...process.env };

after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  ghIssues.setGhRunner(null);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-detail-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  const real = fs.realpathSync(dir);
  // The tool builds its checkouts beside the fixture root
  // (`<root>-worktrees/<slug>`), so that sibling directory is tracked too:
  // otherwise every created worktree outlives the suite in the temp root.
  track(path.join(path.dirname(real), `${path.basename(real)}-worktrees`));
  return real;
}

function stdEnv(extra = {}) {
  return {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-detail-state-'))),
    GENTLE_WORKTREE_THREAD: undefined,
    HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-detail'),
    ...extra,
  };
}

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

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-detail-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    registerMessageRenderer: () => {},
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    events: { emit: () => {} },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, commands, handlers, mod };
}

function addRegisteredWorktree(root, branch, { issues = [], odd = null } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-dt-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const real = fs.realpathSync(target);
  const upserted = registryLib.upsertWorktree(root, { branch, path: real, thread: 'thread-1', issues, odd });
  assert.equal(upserted.ok, true, `registry upsert failed: ${upserted.error}`);
  return real;
}

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text), bold: (text) => String(text) };
const clean = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// A mount delegate that records every overlay it receives and drives each
// mounted component with the scripted step for that mount index. A step that
// is a function receives the component and the mount index.
function scriptedCtx({ cwd, steps, confirm, notes: seededNotes = [] } = {}) {
  const notes = seededNotes.slice();
  const mounts = [];
  const confirms = [];
  let index = 0;
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: {
      notify: (message, level) => notes.push([message, level]),
      confirm: async (title, body) => {
        confirms.push([title, body]);
        return typeof confirm === 'function' ? confirm(title, body) : confirm === true;
      },
      custom: async (factory, options) => {
        const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
        const at = index;
        index += 1;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`mount ${at} never settled`)), 10000);
          const done = (value) => { clearTimeout(timer); resolve(value); };
          let component;
          try {
            component = factory(hostTui, plainTheme, {}, done);
          } catch (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          mounts.push({ component, options });
          const step = steps[at];
          const drive = async () => {
            try {
              if (typeof step === 'function') await step(component, at);
              else for (const key of (step || ['\x1b'])) component.handleInput(key);
            } catch (err) {
              clearTimeout(timer);
              reject(err);
            }
          };
          if (at === 0) drive();
          else Promise.resolve().then(drive);
        });
      },
    },
  };
  return { ctx, notes, mounts, confirms };
}

// The gh client spawns a real binary otherwise; the warp flow's own reads
// never need an issue, so an empty authenticated answer keeps every path
// offline and deterministic.
function stubGh() {
  ghIssues.setGhRunner(async (bin, argv) => {
    if (argv[0] === 'api' && argv[1] === 'user') return { status: 0, stdout: '{"login":"octo"}\n', stderr: '' };
    if (argv[0] === 'repo' && argv[1] === 'view') return { status: 0, stdout: '{"nameWithOwner":"octo/repo"}\n', stderr: '' };
    if (argv[0] === 'api' && argv[1] === 'graphql') {
      return {
        status: 0,
        stdout: `${JSON.stringify({ data: { repository: { issues: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } })}\n`,
        stderr: '',
      };
    }
    if (argv[0] === 'issue' && argv[1] === 'list') return { status: 0, stdout: '[]\n', stderr: '' };
    return { status: 0, stdout: '{}', stderr: '' };
  });
}

describe('S1/S4: the warp popup only warps or creates', { concurrency: false }, () => {
  test('`e` on the focused row opens nothing and changes nothing', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('e-inert');
      const target = addRegisteredWorktree(root, 'feat/detail-one');
      stubGh();
      const { commands } = await loadExtension();
      const registryBefore = fs.readFileSync(registryLib.registryPath(root));
      const checkoutsBefore = git(root, ['worktree', 'list', '--porcelain']);
      const built = scriptedCtx({ cwd: root, steps: [['e', '\x1b']] });

      await commands.get('herdr-gentle:warp').handler('', built.ctx);

      // Exactly one overlay: the popup. No edit panel, no full-screen detail,
      // no second mount of any kind.
      assert.equal(built.mounts.length, 1, 'the popup is the only overlay');
      assert.equal(built.mounts[0].component.state.tab, undefined, 'the mounted component is the popup, not a detail');
      assert.deepEqual(built.notes, [], '`e` claims nothing');
      assert.deepEqual(fs.readFileSync(registryLib.registryPath(root)), registryBefore, 'no registry write');
      assert.equal(git(root, ['worktree', 'list', '--porcelain']), checkoutsBefore, 'no checkout change');
      assert.ok(fs.existsSync(target), 'the checkout is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('`ctrl+d` on the focused row is inert: it never asks and never deletes', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('delete-inert');
      const target = addRegisteredWorktree(root, 'feat/del-one');
      stubGh();
      const { commands } = await loadExtension();
      const checkoutsBefore = git(root, ['worktree', 'list', '--porcelain']);
      // The first panel row is the agent worktree (the session sits in the
      // principal), so this is the row the old delete binding used to target.
      const built = scriptedCtx({ cwd: root, confirm: true, steps: [['\x04', '\x1b']] });

      await commands.get('herdr-gentle:warp').handler('', built.ctx);

      assert.deepEqual(built.confirms, [], 'no confirmation is ever asked');
      assert.equal(built.mounts.length, 1, 'nothing reopened: the panel simply stayed up');
      assert.deepEqual(built.notes, [], 'and nothing is claimed');
      assert.equal(git(root, ['worktree', 'list', '--porcelain']), checkoutsBefore, 'no checkout disappeared');
      assert.ok(fs.existsSync(target), 'the checkout still exists');
      assert.ok(registryLib.findByPath(root, target), 'its registry row is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('the panel legend names the surviving keys and never edit or delete', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('legend');
      // Six rows exceed the panel's five visible list rows, so the
      // `view all worktrees` offer (and its `v all` token) is on screen.
      for (let index = 1; index <= 6; index += 1) addRegisteredWorktree(root, `feat/legend-${index}`);
      stubGh();
      const { commands } = await loadExtension();
      let frame = '';
      const built = scriptedCtx({
        cwd: root,
        steps: [(component) => {
          frame = clean(component.render(120).join('\n'));
          component.handleInput('\x1b');
        }],
      });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);

      assert.match(frame, /c create/, 'creating is still advertised');
      assert.match(frame, /v all/, 'the extended-list offer is still advertised');
      assert.match(frame, /r reload/, 'reloading is still advertised');
      assert.match(frame, /esc close/, 'closing is still advertised');
      assert.doesNotMatch(frame, /e edit/, 'the removed edit binding is never advertised');
      assert.doesNotMatch(frame, /ctrl\+d/, 'the removed delete binding is never advertised');
      assert.doesNotMatch(frame, /delete/i, 'no delete token survives anywhere in the panel');
    } finally {
      restoreEnv();
    }
  });

  test('the removed detail and warp-close seams are not part of the extension surface', async () => {
    setEnv(stdEnv());
    try {
      makeRepo('seams');
      const { mod } = await loadExtension();
      for (const name of ['openWorktreeDetail', 'executeWorktreeDetail', 'setWarpCloseRunner']) {
        assert.equal(typeof mod[name], 'undefined', `${name} is removed with the worktree detail`);
      }
      // The surviving warp/create seams stay exported: removing the detail must
      // not take the popup's own entry points with it.
      for (const name of ['executeWorktreeWarp', 'executeWorktreeCreate', 'executeWorktreeList']) {
        assert.equal(typeof mod[name], 'function', `${name} is still exported`);
      }
    } finally {
      restoreEnv();
    }
  });
});

// S5: the `/herdr-gentle:worktree` command is gone — worktrees are no longer
// modified, so its command surface went with them.
describe('S5: the /herdr-gentle:worktree command is removed', { concurrency: false }, () => {
  test('the command is never registered', async () => {
    setEnv(stdEnv());
    try {
      makeRepo('cmd-detail');
      stubGh();
      const { commands } = await loadExtension();
      assert.equal(commands.has('herdr-gentle:worktree'), false, 'the command is removed outright');
      // The three surviving readers keep their commands, so the absence above
      // is about the removed one and not about a broken registration.
      assert.equal(commands.has('herdr-gentle:warp'), true);
      assert.equal(commands.has('herdr-gentle:issues'), true);
      assert.equal(commands.has('herdr-gentle:odd'), true);
      assert.equal(commands.has('herdr-gentle:customize'), true);
    } finally {
      restoreEnv();
    }
  });
});

describe('S9: worktree_list ordering', { concurrency: false }, () => {
  function makeCtx(cwd) {
    return {
      cwd,
      hasUI: false,
      sessionManager: { getSessionId: () => 'thread-1' },
      ui: { confirm: async () => true, notify: () => {} },
    };
  }

  test('the principal leads, then the session checkout, then the rest', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('order-list');
      const first = addRegisteredWorktree(root, 'feat/aaa');
      const second = addRegisteredWorktree(root, 'feat/zzz');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_list').execute('c1', {}, undefined, undefined, makeCtx(second));
      assert.equal(result.isError, undefined, JSON.stringify(result.details));
      assert.deepEqual(result.details.worktrees.map((item) => item.path), [root, second, first],
        'principal first, the session checkout second, the rest after');
    } finally {
      restoreEnv();
    }
  });

  test('a session in the principal lists it once, first', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('order-same');
      const first = addRegisteredWorktree(root, 'feat/one');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_list').execute('c1', {}, undefined, undefined, makeCtx(root));
      assert.deepEqual(result.details.worktrees.map((item) => item.path), [root, first],
        'the principal is never duplicated');
      const principals = result.details.worktrees.filter((item) => item.kind === 'principal');
      assert.equal(principals.length, 1, 'exactly one principal row');
    } finally {
      restoreEnv();
    }
  });
});

describe('S8b: migration warnings cross command boundaries', { concurrency: false }, () => {
  function seedLegacy(root, target) {
    const file = registryLib.registryPath(root);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.worktrees.find((row) => row.path === target).odd = ['odd/tasks/a.md', 'odd/tasks/b.md'];
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  }

  test('discovery names discarded legacy associations on session start', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('legacy-discovery');
      const target = addRegisteredWorktree(root, 'feat/legacy-discovery');
      seedLegacy(root, target);
      stubGh();
      const { handlers } = await loadExtension();
      const boot = scriptedCtx({ cwd: root, steps: [] });
      await Promise.all((handlers.get('session_start') || []).map((handler) => handler({}, boot.ctx)));
      const raw = JSON.parse(fs.readFileSync(registryLib.registryPath(root), 'utf8'));
      const stored = raw.worktrees.find((row) => row.path === target).odd;
      assert.ok(Array.isArray(stored) || boot.notes.some(([message]) => message.includes('odd/tasks/b.md')),
        'discovery must preserve the old association or name its discarded document');
    } finally { restoreEnv(); }
  });

  // S1: a create writes no association, so it can no longer discard one — the
  // unaddressed legacy row is carried through byte for byte and nothing about
  // it reaches the output. Close drops the row it closes and carries every
  // other row through the same way, so it names no discarded document either.
  test('a create leaves every legacy association untouched', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('legacy-create');
      const legacyTarget = addRegisteredWorktree(root, 'feat/legacy-row');
      seedLegacy(root, legacyTarget);
      stubGh();
      const { tools } = await loadExtension();
      const boot = scriptedCtx({ cwd: root, steps: [] });
      // A thread that owns no checkout: the legacy row belongs to thread-1, so
      // this call must create its own instead of returning that one.
      const fresh = { ...boot.ctx, sessionManager: { getSessionId: () => 'thread-fresh' } };
      const result = await tools.get('worktree_create').execute(
        'migration', { branch: 'feat/fresh-row' }, undefined, undefined, fresh,
      );
      assert.notEqual(result.isError, true, JSON.stringify(result));
      // The unaddressed legacy row is preserved VERBATIM: its one-document
      // rule still holds the legacy list, exactly as it was stored.
      const raw = JSON.parse(fs.readFileSync(registryLib.registryPath(root), 'utf8'));
      const storedLegacy = raw.worktrees.find((row) => row.path === legacyTarget);
      assert.deepEqual(storedLegacy.odd, ['odd/tasks/a.md', 'odd/tasks/b.md'],
        'the row the create did not address keeps its legacy list byte for byte');
      const freshRow = registryLib.findByBranch(root, 'feat/fresh-row');
      assert.deepEqual(freshRow.issues, [], 'the new row records no issue');
      assert.equal(freshRow.odd, null, 'the new row records no document');
      const output = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
      assert.ok(!output.includes('odd/tasks/a.md'), 'no association reaches the create text');
      assert.ok(!output.includes('odd/tasks/b.md'), 'and no discarded document is named');
      assert.equal('dropped' in result.details, false, 'the retired drop report is not published');
      assert.equal('droppedOdd' in result.details, false, 'the retired drop report is not published under its old name');
      assert.ok(!(result.details.warnings || []).some((warning) => /odd\//.test(warning)),
        `no warning names an association: ${JSON.stringify(result.details.warnings)}`);
    } finally { restoreEnv(); }
  });

  test('worktree_close names no association and keeps the other rows verbatim', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('legacy-worktree_close');
      const branch = 'feat/legacy-command';
      const target = addRegisteredWorktree(root, branch);
      seedLegacy(root, target);
      // A second row the close does not address: its legacy list must survive
      // the whole-file rewrite the close performs.
      const other = addRegisteredWorktree(root, 'feat/untouched-row');
      seedLegacy(root, other);
      stubGh();
      const { tools } = await loadExtension();
      const boot = scriptedCtx({ cwd: root, steps: [] });
      const result = await tools.get('worktree_close').execute('migration', { branch, force: true }, undefined, undefined, boot.ctx);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const output = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
      assert.ok(!output.includes('odd/tasks/a.md'), 'the close text names no document');
      assert.ok(!output.includes('odd/tasks/b.md'), 'and no discarded document');
      assert.ok(!boot.notes.some(([message]) => /odd\//.test(message)),
        `no close notification names an association: ${JSON.stringify(boot.notes)}`);
      assert.equal('dropped' in result.details, false, 'the retired drop report is not published');
      const raw = JSON.parse(fs.readFileSync(registryLib.registryPath(root), 'utf8'));
      const survivor = raw.worktrees.find((row) => row.path === other);
      assert.deepEqual(survivor.odd, ['odd/tasks/a.md', 'odd/tasks/b.md'],
        'the row the close did not address keeps its legacy list byte for byte');
    } finally { restoreEnv(); }
  });
});

describe('S12 feedback: create is a bottom interaction', { concurrency: false }, () => {
  test('the public warp flow mounts compact create at the bottom; cancel changes nothing', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('bottom-create');
      addRegisteredWorktree(root, 'feat/existing-bottom');
      stubGh();
      const branches = git(root, ['for-each-ref', '--format=%(refname)']);
      const checkouts = git(root, ['worktree', 'list', '--porcelain']);
      const { commands } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [['c'], ['\x1b']] });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.equal(built.mounts.length, 2, 'selector and create both mounted');
      const create = built.mounts[1];
      assert.deepEqual(create.options, { overlay: true, overlayOptions: { anchor: 'bottom-center', width: '100%', margin: 0, maxHeight: 24 } });
      assert.ok(create.component.render(100).length < 24, 'create keeps content height rather than filling the screen');
      assert.equal(git(root, ['for-each-ref', '--format=%(refname)']), branches, 'cancel creates no branch');
      assert.equal(git(root, ['worktree', 'list', '--porcelain']), checkouts, 'cancel creates no checkout');
      assert.deepEqual(built.notes, [], 'cancel stays silent');
    } finally {
      restoreEnv();
    }
  });
});
