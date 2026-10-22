'use strict';
// worktree-ui-redesign S7/S7a-d/S8/S11/S12/S24 wiring tests: the ONE
// full-screen worktree detail (lib/worktree-detail-view.js) as the extension
// actually reaches it, and the panel delete marker that feeds the existing
// deletion authority.
//
// Contract under test, observable only (the overlay options the host receives,
// the component that mounted, the argv/writes that reach the real modules, and
// the text the component renders):
// - `e` on a focused warp row mounts the detail FULL SCREEN (100% width, 100%
//   height, no margin) and never the old create/edit popup;
// - `/herdr-gentle:worktree` is registered eagerly and opens the SAME
//   component for the session's CURRENT checkout;
// - the header carries the worktree name, path and its data (branch, changes,
//   commits, created, modified) once;
// - the issues tab lists only OPEN issues, assigned first, and `ctrl+s` writes
//   ONE odd document plus every selected issue in a single registry write;
// - a save while the worktree tools are disabled is refused with the shared
//   authority's wording and writes nothing;
// - the panel's `ctrl+d` marker reaches the existing confirmation and the
//   shared close exactly once, while the principal/current rows stay refused;
// - `worktree_list` orders the principal first, then the session's own
//   checkout, then the rest, with no duplicate when they are the same.

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
  return fs.realpathSync(dir);
}

// Registered rows carry `createdAt` with millisecond precision, while a commit
// timestamp is whole seconds: a same-second commit still predates the row, so
// the fixture dates it an hour ahead to make "modified" unambiguously local.
function laterCommit(cwd, message) {
  const when = new Date(Date.now() + 3600_000).toISOString();
  const result = spawnSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
  assert.equal(result.status, 0, `git commit failed: ${result.stderr}`);
}

function writeDoc(root, name, text = `# ${name}\n`) {
  const file = path.join(root, 'odd', 'tasks', `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
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
const flush = () => new Promise((resolve) => setImmediate(resolve));

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
          else flush().then(drive);
        });
      },
    },
  };
  return { ctx, notes, mounts, confirms };
}

// The gh client spawns a real binary otherwise; every detail here answers from
// this fixture (the open snapshot, the cursor pages and one preview are the
// only reads that happen).
function stubGh(openNumbers = []) {
  const calls = [];
  const openPage = (argv) => {
    const field = (name) => {
      for (let index = 0; index < argv.length - 1; index += 1) {
        if (argv[index] === '-F' && argv[index + 1].startsWith(`${name}=`)) return argv[index + 1].slice(name.length + 1);
      }
      return null;
    };
    const first = Number(field('first'));
    const cursor = field('cursor');
    const offset = cursor === null ? 0 : Number(cursor.replace('page-', ''));
    const rows = openNumbers.map((number) => ({
      number,
      title: `issue title ${number}`,
      state: 'OPEN',
      stateReason: '',
      author: { login: 'octo' },
      labels: { nodes: [] },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: `2024-01-0${(number % 9) + 1}T00:00:00Z`,
      url: `https://example.test/issues/${number}`,
      comments: { totalCount: 0 },
      reactionGroups: [],
    }));
    const nodes = rows.slice(offset, offset + (Number.isFinite(first) ? first : rows.length));
    const hasNextPage = offset + nodes.length < rows.length;
    return JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount: rows.length,
            pageInfo: { hasNextPage, endCursor: hasNextPage ? `page-${offset + nodes.length}` : null },
            nodes,
          },
        },
      },
    });
  };
  ghIssues.setGhRunner(async (bin, argv) => {
    calls.push({ bin, argv: argv.slice() });
    if (argv[0] === 'api' && argv[1] === 'user') return { status: 0, stdout: '{"login":"octo"}\n', stderr: '' };
    if (argv[0] === 'api' && argv[1] === 'graphql') return { status: 0, stdout: `${openPage(argv)}\n`, stderr: '' };
    if (argv[0] === 'repo' && argv[1] === 'view') return { status: 0, stdout: '{"nameWithOwner":"octo/repo"}\n', stderr: '' };
    if (argv[0] === 'issue' && argv[1] === 'list') {
      const state = argv[argv.indexOf('--state') + 1];
      const rows = openNumbers.map((number) => ({
        number,
        title: `issue title ${number}`,
        state: 'open',
        author: { login: 'octo' },
        labels: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: `2024-01-0${(number % 9) + 1}T00:00:00Z`,
      }));
      const body = state === 'closed' ? [] : rows;
      return { status: 0, stdout: `${JSON.stringify(body)}\n`, stderr: '' };
    }
    if (argv[0] === 'issue' && argv[1] === 'view') {
      const number = Number(argv[2]);
      return {
        status: 0,
        stdout: `${JSON.stringify({
          number,
          title: `issue title ${number}`,
          state: 'open',
          body: `body of issue ${number}`,
          comments: [],
        })}\n`,
        stderr: '',
      };
    }
    return { status: 0, stdout: '{}', stderr: '' };
  });
  return calls;
}

function detailOf(mounts, at) {
  const mounted = mounts[at];
  assert.ok(mounted, `mount ${at} exists`);
  const component = mounted.component;
  assert.equal(typeof component.render, 'function', `mount ${at} renders`);
  assert.ok(component.state && (component.state.tab === 'issues' || component.state.tab === 'odd'),
    `mount ${at} is the worktree detail, not another panel (state=${JSON.stringify(component.state && component.state.tab)})`);
  return component;
}

const FULLSCREEN = { overlay: true, overlayOptions: { anchor: 'center', width: '100%', maxHeight: '100%', margin: 0 } };

describe('S7: `e` opens the full-screen worktree detail', { concurrency: false }, () => {
  test('the warp row mounts the detail full screen and never the old edit popup', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('e-fullscreen');
      writeDoc(root, 'one');
      const target = addRegisteredWorktree(root, 'feat/detail-one');
      stubGh([7]);
      const { commands } = await loadExtension();
      const built = scriptedCtx({
        cwd: root,
        steps: [
          ['e'],            // warp panel: edit the focused row
          ['\x1b'],         // detail: close
          ['\x1b'],         // warp panel: close
        ],
      });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);

      assert.equal(built.mounts.length, 3, 'the panel, the detail, then the panel again');
      // The FIRST mount is the warp panel, the SECOND the detail.
      assert.equal(built.mounts[0].component.state.tab, undefined, 'the warp panel is not the detail');
      const detail = detailOf(built.mounts, 1);
      assert.deepEqual(built.mounts[1].options, FULLSCREEN, 'the detail is a full-screen overlay');
      const lines = detail.render(100);
      assert.equal(lines.length, 24, 'it fills every terminal row');
      for (const line of lines) assert.equal(clean(line).length, 100, 'and every column');
      assert.deepEqual(built.mounts[2].options.overlayOptions.anchor, 'bottom-center', 'the panel comes back as the panel');
      assert.deepEqual(built.notes, [], 'closing is silent');
      assert.ok(fs.existsSync(target), 'nothing was created or removed');
    } finally {
      restoreEnv();
    }
  });

  test('the header names the worktree, its path and its data', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('e-header');
      writeDoc(root, 'one');
      const target = addRegisteredWorktree(root, 'feat/header');
      // A commit INSIDE the worktree, dated after its registration: last
      // activity is then real local modification rather than an inherited
      // pre-checkout commit (which S12 deliberately drops).
      laterCommit(target, 'work');
      stubGh([7]);
      const { commands } = await loadExtension();
      let rendered = '';
      const built = scriptedCtx({
        cwd: root,
        steps: [
          ['e'],
          (component) => { rendered = clean(component.render(120).join('\n')); component.handleInput('\x1b'); },
          ['\x1b'],
        ],
      });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.match(rendered, /feat-header/, 'the worktree name');
      assert.ok(rendered.includes(target), 'the worktree path');
      assert.match(rendered, /branch feat\/header/, 'the current branch');
      assert.match(rendered, /created (now|\d)/, 'a relative creation age, never a date');
      assert.match(rendered, /modified (now|\d)/, 'a relative modification age');
      assert.doesNotMatch(rendered, /\d{4}-\d{2}-\d{2}/, 'never an absolute date');
    } finally {
      restoreEnv();
    }
  });
});

describe('S11: /herdr-gentle:worktree opens the SAME detail for the current checkout', { concurrency: false }, () => {
  test('the command is registered eagerly and mounts the same component', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('cmd-detail');
      writeDoc(root, 'one');
      stubGh([7]);
      const { commands } = await loadExtension();
      const def = commands.get('herdr-gentle:worktree');
      assert.ok(def, 'the command is registered without any prior session gate');

      const built = scriptedCtx({ cwd: root, steps: [(component) => {
        const lines = component.render(90);
        assert.equal(lines.length, 24);
        assert.match(clean(lines.join('\n')), /branch /, 'the current checkout header renders');
        component.handleInput('\x1b');
      }] });
      await def.handler('', built.ctx);
      assert.equal(built.mounts.length, 1, 'one overlay');
      assert.deepEqual(built.mounts[0].options, FULLSCREEN, 'the same full-screen geometry as the warp detail');
      assert.equal(detailOf(built.mounts, 0).state.tab, 'issues', 'the same component, on the issues tab');
      assert.deepEqual(built.notes, []);
    } finally {
      restoreEnv();
    }
  });

  test('inside a worktree the command opens THAT worktree, not the principal', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('cmd-detail-wt');
      const target = addRegisteredWorktree(root, 'feat/current-one');
      writeDoc(target, 'only');
      stubGh([7]);
      const { commands } = await loadExtension();
      let rendered = '';
      const built = scriptedCtx({ cwd: target, steps: [(component) => {
        rendered = clean(component.render(120).join('\n'));
        component.handleInput('\x1b');
      }] });
      await commands.get('herdr-gentle:worktree').handler('', built.ctx);
      assert.match(rendered, /◈ feat-current-one/, "the session's own worktree");
      assert.ok(rendered.includes(target), 'its path');
      assert.match(rendered, /branch feat\/current-one/, 'its own branch');
      assert.doesNotMatch(rendered, /◈ principal/, 'never the principal');
    } finally {
      restoreEnv();
    }
  });

  test('an argument is refused and opens nothing', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('cmd-detail-args');
      const { commands } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [] });
      await commands.get('herdr-gentle:worktree').handler('feat/x', built.ctx);
      assert.equal(built.mounts.length, 0, 'nothing mounts');
      assert.deepEqual(built.notes, [['Unknown option "feat/x". Use /herdr-gentle:worktree.', 'error']]);
    } finally {
      restoreEnv();
    }
  });
});

describe('S8/S7c: saving one ODD document and every open issue', { concurrency: false }, () => {
  test('ctrl+s writes both fields in ONE registry write', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('save-both');
      const target = addRegisteredWorktree(root, 'feat/save-both', { issues: [7] });
      // The documents live in the WORKTREE, which is the checkout the detail
      // lists and the one the association belongs to.
      const doc = writeDoc(target, 'one');
      writeDoc(target, 'two');
      assert.equal(registryLib.updateWorktree(root, target, { odd: 'odd/tasks/one.md' }).ok, true);
      stubGh([7, 12]);
      const { commands } = await loadExtension();
      const writes = [];
      const original = registryLib.updateWorktree;
      registryLib.updateWorktree = (repoRoot, key, patch, opts) => {
        writes.push({ key, patch });
        return original(repoRoot, key, patch, opts);
      };
      try {
        let selectedOdd = null;
        const built = scriptedCtx({
          cwd: target,
          steps: [(component) => {
            // Switch to the ODD tab and keep the stored document selected, then
            // add one more open issue on the Issues tab.
            component.handleInput('tab');
            component.handleInput('tab');
            selectedOdd = component.state.odd;
            component.handleInput('down'); // #12 is below the assigned #7
            component.handleInput('space');
            component.handleInput('ctrl+s');
            component.handleInput('\x1b');
          }],
        });
        await commands.get('herdr-gentle:worktree').handler('', built.ctx);
        assert.equal(writes.length, 1, `exactly one registry write\n${JSON.stringify(writes)}`);
        assert.equal(selectedOdd, doc, 'the view selects the document by its path identity');
        assert.deepEqual(writes[0].patch, { issues: [7, 12], odd: 'odd/tasks/one.md' },
          'both fields travel together, mapped back to the stored checkout-relative form');
        const row = registryLib.findByPath(root, target);
        assert.deepEqual(row.issues, [7, 12], 'the issues are stored');
        assert.equal(row.odd, 'odd/tasks/one.md', 'the ONE document keeps its stored checkout-relative form');
        assert.equal(Array.isArray(row.odd), false, 'never a list');
        assert.deepEqual(built.notes, [], 'a successful save is silent');
      } finally {
        registryLib.updateWorktree = original;
      }
    } finally {
      restoreEnv();
    }
  });

  test('a save with the worktree tools disabled is refused and writes nothing', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('save-disabled');
      writeDoc(root, 'one');
      addRegisteredWorktree(root, 'feat/save-off', { issues: [7], odd: null });
      stubGh([7]);
      const { commands } = await loadExtension();
      // Flip the shared mode flag the same way the customize panel does; the
      // save seam re-reads it live, exactly like the odd/issues savers.
      require('../lib/worktree-mode.js').writeMode(false);
      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile);
      let rendered = '';
      const built = scriptedCtx({
        cwd: root,
        steps: [async (component) => {
          component.handleInput('tab');
          component.handleInput('ctrl+s');
          // The refusal arrives on the save's own microtask.
          await flush();
          rendered = clean(component.render(120).join('\n'));
          component.handleInput('\x1b');
        }],
      });
      await commands.get('herdr-gentle:worktree').handler('', built.ctx);
      assert.deepEqual(fs.readFileSync(registryFile), before, 'a refused save writes nothing');
      assert.match(rendered, /worktree tools are disabled/, 'the refusal names the switch');
    } finally {
      require('../lib/worktree-mode.js').writeMode(true);
      restoreEnv();
    }
  });
});

describe('S24: the panel delete marker reaches the existing authority', { concurrency: false }, () => {
  test('ctrl+d on the focused panel row asks once and closes through the shared runner', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('panel-delete');
      const target = addRegisteredWorktree(root, 'feat/del-one');
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => {
        closeCalls.push(params);
        return { isError: false, text: 'removed: feat-del-one', details: {} };
      });
      // The panel's first row is the agent worktree (the session sits in the
      // principal), so ctrl+d targets it directly from the PANEL.
      const built = scriptedCtx({
        cwd: root,
        confirm: true,
        steps: [['\x04'], ['\x1b']],
      });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.equal(built.confirms.length, 1, 'exactly one confirmation');
      assert.equal(built.confirms[0][0], "Delete worktree 'feat-del-one'?");
      assert.deepEqual(closeCalls, [{ path: target }], 'the shared close ran once for that row');
      assert.deepEqual(built.notes, [['removed: feat-del-one', 'info']]);
    } finally {
      restoreEnv();
    }
  });

  test('ctrl+d never reaches a row the existing predicate refuses', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('panel-delete-refused');
      // No agent worktree at all: the only row is the principal, which the
      // session already occupies, so nothing here may be deletable.
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => {
        closeCalls.push(params);
        return { isError: false, text: 'removed', details: {} };
      });
      const built = scriptedCtx({ cwd: root, confirm: true, steps: [['\x04', '\x1b']] });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.deepEqual(built.confirms, [], 'no confirmation is ever asked');
      assert.deepEqual(closeCalls, [], 'nothing is deleted');
      assert.deepEqual(built.notes, [], 'and nothing is claimed');
    } finally {
      restoreEnv();
    }
  });

  test('a refused confirmation changes nothing and reopens the panel', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('panel-delete-cancel');
      addRegisteredWorktree(root, 'feat/kept');
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => { closeCalls.push(params); return { isError: false, text: 'removed', details: {} }; });
      const built = scriptedCtx({ cwd: root, confirm: false, steps: [['\x04'], ['\x1b']] });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.equal(built.confirms.length, 1);
      assert.deepEqual(closeCalls, [], 'a refusal deletes nothing');
      assert.equal(built.mounts.length, 2, 'the panel reopened');
      assert.deepEqual(built.notes, [], 'a refusal is silent');
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
      stubGh([]);
      const { handlers } = await loadExtension();
      const boot = scriptedCtx({ cwd: root, steps: [] });
      await Promise.all((handlers.get('session_start') || []).map((handler) => handler({}, boot.ctx)));
      const raw = JSON.parse(fs.readFileSync(registryLib.registryPath(root), 'utf8'));
      const stored = raw.worktrees.find((row) => row.path === target).odd;
      assert.ok(Array.isArray(stored) || boot.notes.some(([message]) => message.includes('odd/tasks/b.md')),
        'discovery must preserve the old association or name its discarded document');
    } finally { restoreEnv(); }
  });

  for (const operation of ['worktree_upsert', 'worktree_close']) {
    test(`${operation} names associations discarded by its registry write`, async () => {
      setEnv(stdEnv());
      try {
        const root = makeRepo(`legacy-${operation}`);
        const branch = 'feat/legacy-command';
        let target;
        if (operation === 'worktree_upsert') {
          target = track(require('../lib/worktree-git.js').worktreePath(root, branch));
          git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
          registryLib.upsertWorktree(root, { branch, path: target, thread: 'another-thread', issues: [], odd: null });
        } else {
          target = addRegisteredWorktree(root, branch);
        }
        seedLegacy(root, target);
        stubGh([]);
        const { tools } = await loadExtension();
        const boot = scriptedCtx({ cwd: root, steps: [] });
        const params = operation === 'worktree_upsert' ? { branch, issues: [] } : { branch, force: true };
        const result = await tools.get(operation).execute('migration', params, undefined, undefined, boot.ctx);
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const output = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
        assert.ok(output.includes('odd/tasks/b.md') || boot.notes.some(([message]) => message.includes('odd/tasks/b.md')),
          'the public command must expose its discarded document');
      } finally { restoreEnv(); }
    });
  }
});
