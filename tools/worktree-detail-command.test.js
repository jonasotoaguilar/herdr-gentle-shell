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
  yoloResponder = null;
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
    events: {
      emit: (channel, payload) => {
        if (typeof yoloResponder === 'function') yoloResponder(channel, payload);
      },
    },
  };
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, commands, handlers, mod };
}

// gentle-shell answers YOLO questions on this channel with an adapter whose
// read() is 'ON' only while the live session holds the grant. `null` stands
// for a host that never answers, which is the default here.
let yoloResponder = null;

function answerYolo(display) {
  yoloResponder = (channel, payload) => {
    if (channel !== 'gentle:yolo:host-ui') return;
    payload.respond({ read: async () => display, dispose: () => {} });
  };
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

// S18: the detail mounts BEFORE its slow reads, so a test that asserts data or
// saves must wait for that enrichment. Polling the component's own observable
// state keeps the wait deterministic instead of guessing a tick count.
async function waitForDetail(component, predicate, label = 'the detail data') {
  for (let step = 0; step < 400; step += 1) {
    if (predicate()) return true;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

const detailReady = (component) => {
  const data = component && component.state && component.state.dataState;
  return Boolean(data && data.issues === 'ready' && data.assigned === 'ready');
};

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
      // The detail is measured while it is OPEN: a closed view paints nothing
      // (S18), so the frame is captured before the close key.
      let detailLines = [];
      const built = scriptedCtx({
        cwd: root,
        steps: [
          ['e'],            // warp panel: edit the focused row
          (component) => {  // detail: measure the live frame, then close
            detailLines = component.render(100);
            component.handleInput('\x1b');
          },
          ['\x1b'],         // warp panel: close
        ],
      });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);

      assert.equal(built.mounts.length, 3, 'the panel, the detail, then the panel again');
      // The FIRST mount is the warp panel, the SECOND the detail.
      assert.equal(built.mounts[0].component.state.tab, undefined, 'the warp panel is not the detail');
      detailOf(built.mounts, 1);
      assert.deepEqual(built.mounts[1].options, FULLSCREEN, 'the detail is a full-screen overlay');
      assert.equal(detailLines.length, 24, 'it fills every terminal row');
      for (const line of detailLines) assert.equal(clean(line).length, 100, 'and every column');
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
          async (component) => {
            await waitForDetail(
              component,
              () => /^│[^│]*created (now|\d)/m.test(clean(component.render(120).join('\n'))),
              'the header facts',
            );
            rendered = clean(component.render(120).join('\n'));
            component.handleInput('\x1b');
          },
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
          steps: [async (component) => {
            // S18: the stored assignment paints at once but the write path opens
            // only once the list and the verification have settled.
            await waitForDetail(component, () => detailReady(component), 'the detail initialization');
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
          await waitForDetail(component, () => detailReady(component), 'the detail initialization');
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
      // S4 (round 3): a real `main` so the prompt's ahead-of-main read is a
      // KNOWN answer (0) instead of the unknown branch of the message.
      git(root, ['branch', 'main', 'HEAD']);
      const target = addRegisteredWorktree(root, 'feat/del-one');
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      const closeCtxs = [];
      mod.setWarpCloseRunner(async (params, closeCtx) => {
        closeCalls.push(params);
        closeCtxs.push(closeCtx);
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
      // A clean row with no commits of its own raises no warning: the panel
      // route and the extended list word the same body.
      assert.equal(built.confirms[0][1], `Delete worktree checkout at ${target} for branch 'feat/del-one'? This removes the checkout but keeps the branch.`);
      assert.deepEqual(closeCalls, [{ path: target }], 'the shared close ran once for that row');
      assert.equal(closeCtxs[0].hasUI, false, 'the confirmed delete shows no second dialog');
      assert.deepEqual(built.notes, [['removed: feat-del-one', 'info']]);
    } finally {
      restoreEnv();
    }
  });

  test('the panel route always asks: YOLO never deletes a clean row on the keypress alone', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('panel-delete-yolo');
      git(root, ['branch', 'main', 'HEAD']);
      const target = addRegisteredWorktree(root, 'feat/kept-yolo');
      const { commands, mod } = await loadExtension();
      const closeCalls = [];
      mod.setWarpCloseRunner(async (params) => {
        closeCalls.push(params);
        return { isError: false, text: 'removed', details: {} };
      });
      answerYolo('ON');
      // The row is provably clean and YOLO is ON: the dialog is still asked,
      // and its refusal removes nothing.
      const built = scriptedCtx({ cwd: root, confirm: false, steps: [['\x04'], ['\x1b']] });
      const beforeList = git(root, ['worktree', 'list', '--porcelain']);
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.equal(built.confirms.length, 1, 'YOLO never waives a keyboard delete');
      assert.equal(built.confirms[0][0], "Delete worktree 'feat-kept-yolo'?");
      assert.deepEqual(closeCalls, [], 'the refusal under YOLO removed nothing');
      assert.equal(git(root, ['worktree', 'list', '--porcelain']), beforeList, 'no checkout disappeared');
      assert.ok(fs.existsSync(target), 'the refused checkout still exists');
      assert.equal(built.mounts.length, 2, 'the panel reopened');
    } finally {
      yoloResponder = null;
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


describe('S12 feedback: create is a bottom interaction', { concurrency: false }, () => {
  test('the public warp flow mounts compact create at the bottom; cancel changes nothing', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('bottom-create');
      addRegisteredWorktree(root, 'feat/existing-bottom');
      stubGh([]);
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

// ---------------------------------------------------------------------------
// ui-consistency-round3 T9/S18 (L6): the detail must MOUNT before its slow
// reads. The command used to serially await assignment verification, the whole
// open-issue prime and the checkout facts, so a cold repository showed nothing
// until every gh/git call had finished. This suite pins the progressive
// contract on the exported `openWorktreeDetail` seam: the overlay exists first,
// the stored assignment/ODD paint immediately, no count or fact is invented,
// and the SAME mounted view is enriched as each independent read lands.
// ---------------------------------------------------------------------------
describe('T9 S18: the detail mounts before its slow reads', { concurrency: false }, () => {
  const gitLib = require('../lib/worktree-git.js');

  function deferred() {
    let resolve = () => {};
    let reject = () => {};
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  const METADATA_JSON = `${JSON.stringify({
    data: {
      repository: {
        viewerPermission: 'WRITE',
        issue: {
          assignees: { nodes: [{ login: 'ana' }], pageInfo: { hasNextPage: false } },
          closedByPullRequestsReferences: { totalCount: 0 },
        },
      },
    },
  })}\n`;

  const PROJECTS_JSON = `${JSON.stringify({
    data: { repository: { issue: { projectItems: { nodes: [], pageInfo: { hasNextPage: false } } } } },
  })}\n`;

  function graphqlOpenPayload(numbers) {
    const rows = numbers.map((number) => ({
      number,
      title: `issue title ${number}`,
      state: 'OPEN',
      stateReason: '',
      url: `https://example.test/issues/${number}`,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: `2024-01-0${(number % 9) + 1}T00:00:00Z`,
      author: { login: 'octo' },
      labels: { nodes: [] },
      comments: { totalCount: 0 },
      reactionGroups: [],
    }));
    return {
      status: 0,
      stderr: '',
      stdout: `${JSON.stringify({
        data: {
          repository: {
            issues: { totalCount: rows.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: rows },
          },
        },
      })}\n`,
    };
  }

  function issueViewJson(number, { state = 'open', comments = [] } = {}) {
    return {
      status: 0,
      stderr: '',
      stdout: `${JSON.stringify({
        number,
        title: `issue title ${number}`,
        state,
        stateReason: '',
        author: { login: 'octo' },
        labels: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        url: `https://example.test/issues/${number}`,
        body: `body of issue ${number}`,
        comments,
      })}\n`,
    };
  }

  // A gh client whose two slow reads (the open snapshot and one issue read) are
  // gates the test owns, so nothing depends on wall-clock timing.
  function gatedGh({ openIssues, verify }) {
    const calls = [];
    ghIssues.setGhRunner(async (bin, argv) => {
      calls.push(argv.slice());
      const head = `${argv[0] || ''} ${argv[1] || ''}`;
      if (head === 'api user') return { status: 0, stdout: '{"login":"octo"}\n', stderr: '' };
      if (head === 'repo view') return { status: 0, stdout: '{"nameWithOwner":"octo/repo"}\n', stderr: '' };
      if (head === 'api graphql') {
        const query = argv.filter((item) => item.startsWith('query=')).join('');
        if (query.includes('assignees')) return { status: 0, stdout: METADATA_JSON, stderr: '' };
        if (query.includes('projectItems')) return { status: 0, stdout: PROJECTS_JSON, stderr: '' };
        return openIssues();
      }
      if (head === 'issue view') return verify(Number(argv[2]));
      return { status: 0, stdout: '{}', stderr: '' };
    });
    return calls;
  }

  const FULL_FACTS = {
    branch: { available: true, value: 'feat/slow', detached: false },
    changes: { available: true, value: { files: 3, added: 5, deleted: 1 } },
    aheadBehind: { available: true, value: { ahead: 2, behind: 1 } },
    createdAt: { available: true, value: new Date(Date.now() - 86400_000).toISOString() },
    lastActivity: { available: true, value: new Date(Date.now() - 3600_000).toISOString() },
  };

  function factsDouble({ peeked = null } = {}) {
    const order = [];
    const peekCalls = [];
    const factCalls = [];
    const gate = deferred();
    const provider = {
      ttlMs: 1000,
      peek: (checkoutPath) => {
        order.push('peek');
        peekCalls.push(checkoutPath);
        return peeked;
      },
      invalidate: () => {},
      facts: (checkoutPath) => {
        order.push('facts');
        factCalls.push(checkoutPath);
        return gate.promise;
      },
    };
    return { provider, order, peekCalls, factCalls, gate };
  }

  async function waitForMount(built) {
    for (let step = 0; step < 40 && built.mounts.length === 0; step += 1) await flush();
    return built.mounts[0] ? built.mounts[0].component : null;
  }

  // Closes whatever this run mounted, waiting (bounded) for a mount that only
  // becomes possible once the gates are released. In the pre-change RED run the
  // mount happens late, and this keeps the 10s host timeout out of the report.
  async function closeMounted(built) {
    const component = built.mounts[0] ? built.mounts[0].component : await waitForMount(built);
    if (!component) return;
    component.handleInput('\x1b');
    await flush();
    component.handleInput('\x1b');
  }

  const renderDetail = (component) => clean(component.render(120).join('\n'));

  test('the overlay exists first, the stored assignment paints, then the same view is enriched', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('progressive-mount');
      const target = addRegisteredWorktree(root, 'feat/slow', { issues: [7], odd: 'odd/tasks/one.md' });
      writeDoc(target, 'one');
      writeDoc(target, 'two');
      const primeGate = deferred();
      const verifyGate = deferred();
      const verifiedIssue = issueViewJson(7, {
        comments: [{ author: { login: 'ana' }, createdAt: '2024-01-03T00:00:00Z', body: 'first comment' }],
      });
      const calls = gatedGh({
        openIssues: () => primeGate.promise,
        verify: () => verifyGate.promise,
      });
      const facts = factsDouble();
      const { mod } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [() => {}] });
      const running = mod.openWorktreeDetail(built.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-slow', path: target, branch: 'feat/slow' },
        notify: built.ctx.ui.notify,
        checkoutFacts: facts.provider,
      });
      running.catch(() => {});
      try {
        const component = await waitForMount(built);
        assert.ok(component, 'the detail mounts before the slow reads resolve');
        let rendered = renderDetail(component);
        assert.match(rendered, /◈ feat-slow/, 'the worktree is named');
        assert.ok(rendered.includes(target), 'its path');
        assert.match(rendered, /odd: one/, 'the stored ODD association is named immediately');
        assert.match(rendered, /issues: #7/, 'the stored assignment is displayed immediately');
        assert.match(rendered, /Issues \(…\)/, 'a pending list never claims a zero count');
        assert.doesNotMatch(rendered, /Issues \(0\)|ODD \(0\)/);
        assert.doesNotMatch(rendered, /changes \d|created \d/, 'no fact is invented before the facts land');
        assert.equal(facts.peekCalls.length, 1, 'peek is the only synchronous facts read');
        assert.equal(facts.factCalls.length, 1, 'the full read starts after the mount');
        assert.deepEqual(facts.order.slice(0, 2), ['peek', 'facts']);

        // 1) the stored assignment verification settles; 2) the list lands.
        verifyGate.resolve(verifiedIssue);
        await flush();
        assert.match(renderDetail(component), /issues: #7/, 'the verified assignment keeps the stored id');
        primeGate.resolve(graphqlOpenPayload([7, 12]));
        await flush();
        await flush();
        rendered = renderDetail(component);
        assert.match(rendered, /Issues \(2\)/, 'the known list reaches the SAME view');
        assert.match(rendered, /#7 issue title 7/);
        assert.match(rendered, /#12 issue title 12/);
        // The focused issue's detail read is the shared, metadata-bearing one;
        // it lands after the mount like every other read.
        await waitForDetail(component, () => /assignees: ana/.test(renderDetail(component)), 'the issue preview metadata');
        rendered = renderDetail(component);
        assert.ok(calls.some((argv) => argv[0] === 'issue' && argv[1] === 'view' && argv.includes('--json')), 'the preview reads the issue');
        assert.match(rendered, /assignees: ana/, 'S16: the metadata read still reaches the preview');
        assert.match(rendered, /first comment/, 'S16: the comments envelope still reaches the preview');

        facts.gate.resolve(FULL_FACTS);
        await flush();
        await flush();
        rendered = renderDetail(component);
        assert.match(rendered, /3 changes/, 'the facts land in the same view');
        assert.match(rendered, /created 1d/);
        assert.match(rendered, /modified 1hr/);
        assert.deepEqual(built.notes, [], 'a successful enrichment is silent');
      } finally {
        verifyGate.resolve(issueViewJson(7));
        primeGate.resolve(graphqlOpenPayload([]));
        facts.gate.resolve(FULL_FACTS);
        await closeMounted(built);
        await running.catch(() => {});
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('a save while the initialization is pending writes nothing and says why', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('pending-save');
      const target = addRegisteredWorktree(root, 'feat/pending-save', { issues: [7] });
      writeDoc(target, 'one');
      const primeGate = deferred();
      const verifyGate = deferred();
      gatedGh({ openIssues: () => primeGate.promise, verify: () => verifyGate.promise });
      const { mod } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [() => {}] });
      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile);
      const running = mod.openWorktreeDetail(built.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-pending-save', path: target, branch: 'feat/pending-save' },
        notify: built.ctx.ui.notify,
      });
      running.catch(() => {});
      try {
        const component = await waitForMount(built);
        assert.ok(component, 'the detail mounts while the data is still loading');
        component.handleInput('ctrl+s');
        await flush();
        await flush();
        assert.deepEqual(fs.readFileSync(registryFile), before, 'no write happens from an unverified set');
        const rendered = renderDetail(component);
        assert.match(rendered, /save waits for/, 'the refusal is explained');
        assert.deepEqual(built.notes, [], 'and nothing is claimed');
      } finally {
        verifyGate.resolve(issueViewJson(7));
        primeGate.resolve(graphqlOpenPayload([7]));
        await closeMounted(built);
        await running.catch(() => {});
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('closing before the reads land writes nothing, notifies nothing and asks nothing more', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('close-before-reads');
      const target = addRegisteredWorktree(root, 'feat/close-early', { issues: [7] });
      writeDoc(target, 'one');
      const primeGate = deferred();
      const verifyGate = deferred();
      const calls = gatedGh({ openIssues: () => primeGate.promise, verify: () => verifyGate.promise });
      const { mod } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [() => {}] });
      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile);
      const running = mod.openWorktreeDetail(built.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-close-early', path: target, branch: 'feat/close-early' },
        notify: built.ctx.ui.notify,
      });
      try {
        const component = await waitForMount(built);
        assert.ok(component, 'the detail mounts before the slow reads resolve');
        component.handleInput('\x1b');
        await running;
        const callsAtClose = calls.length;
        // The verification now proves #7 closed. After `done` it must not drop
        // the assignment, notify, or start another query.
        verifyGate.resolve(issueViewJson(7, { state: 'closed' }));
        primeGate.resolve(graphqlOpenPayload([12]));
        await flush();
        await flush();
        assert.deepEqual(fs.readFileSync(registryFile), before, 'no registry write after close');
        assert.deepEqual(built.notes, [], 'no notification after close');
        assert.equal(calls.length, callsAtClose, 'no further gh query after close');
      } finally {
        verifyGate.resolve(issueViewJson(7));
        primeGate.resolve(graphqlOpenPayload([]));
        await flush();
        if (built.mounts[0] && built.mounts[0].component.state.tab) built.mounts[0].component.handleInput('\x1b');
        await running.catch(() => {});
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('a failed issue list is named as a failure, never as an empty list, and blocks the save', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('failed-list');
      const target = addRegisteredWorktree(root, 'feat/failed-list', { issues: [7] });
      writeDoc(target, 'one');
      const verifyGate = deferred();
      gatedGh({
        openIssues: () => ({ status: 1, stdout: '', stderr: 'HTTP 502' }),
        verify: () => verifyGate.promise,
      });
      const { mod } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [() => {}] });
      const registryFile = registryLib.registryPath(root);
      const before = fs.readFileSync(registryFile);
      const running = mod.openWorktreeDetail(built.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-failed-list', path: target, branch: 'feat/failed-list' },
        notify: built.ctx.ui.notify,
      });
      running.catch(() => {});
      try {
        const component = await waitForMount(built);
        assert.ok(component, 'the detail mounts before the list fails');
        verifyGate.resolve(issueViewJson(7));
        await flush();
        await flush();
        const rendered = renderDetail(component);
        assert.match(rendered, /issue list unreadable/, 'the failure is named in the list pane');
        assert.doesNotMatch(rendered, /no open issues/, 'a failure is not an empty list');
        assert.match(rendered, /Issues \(\?\)/, 'the count is marked unknown, never 0');
        assert.equal(built.notes.length, 1, `one notice names the failure: ${JSON.stringify(built.notes)}`);
        assert.match(String(built.notes[0][0]), /cannot list open issues/);
        component.handleInput('ctrl+s');
        await flush();
        assert.deepEqual(fs.readFileSync(registryFile), before, 'an unverified set is never written');
      } finally {
        verifyGate.resolve(issueViewJson(7));
        await closeMounted(built);
        await running.catch(() => {});
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('the delayed verification never clobbers an unsaved selection on a warm cache mount', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('dirty-baseline');
      const target = addRegisteredWorktree(root, 'feat/dirty-baseline', { issues: [7] });
      writeDoc(target, 'one');
      // Warm the shared snapshot with #12 only: #7 stays unknown to the cache,
      // so its verification has to ask gh and can be held open.
      stubGh([12]);
      const { mod } = await loadExtension();
      // Keep the warm-up mount open until its snapshot is really primed, so the
      // second mount genuinely starts on a warm cache.
      const warm = scriptedCtx({ cwd: root, steps: [() => {}] });
      const warmRun = mod.openWorktreeDetail(warm.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-dirty-baseline', path: target, branch: 'feat/dirty-baseline' },
        notify: warm.ctx.ui.notify,
      });
      warmRun.catch(() => {});
      const warmComponent = await waitForMount(warm);
      await waitForDetail(warmComponent, () => warmComponent.state.dataState.issues === 'ready', 'the warm snapshot');
      warmComponent.handleInput('\x1b');
      await warmRun;

      const verifyGate = deferred();
      gatedGh({ openIssues: () => graphqlOpenPayload([12]), verify: () => verifyGate.promise });
      const built = scriptedCtx({ cwd: root, steps: [() => {}] });
      const running = mod.openWorktreeDetail(built.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-dirty-baseline', path: target, branch: 'feat/dirty-baseline' },
        notify: built.ctx.ui.notify,
      });
      running.catch(() => {});
      try {
        const component = await waitForMount(built);
        assert.ok(component, 'the warm detail mounts before the verification resolves');
        assert.match(renderDetail(component), /Issues \(1\)/, 'a primed snapshot paints at mount');
        assert.match(renderDetail(component), /issues: #7/, 'the stored assignment is displayed');
        component.handleInput('space');
        assert.deepEqual(component.state.issues.slice().sort((a, b) => a - b), [7, 12], 'the reader adds #12');
        assert.equal(component.state.dirty, true);

        verifyGate.resolve(issueViewJson(7));
        await flush();
        await flush();
        assert.deepEqual(component.state.issues.slice().sort((a, b) => a - b), [7, 12],
          'the delayed baseline never overwrites the unsaved selection');
        assert.equal(component.state.dirty, true, 'and it stays unsaved');
      } finally {
        verifyGate.resolve(issueViewJson(7));
        await closeMounted(built);
        await running.catch(() => {});
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('a proven-closed assignment is dropped without losing a concurrently assigned id', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('concurrent-assign');
      const target = addRegisteredWorktree(root, 'feat/concurrent', { issues: [7] });
      writeDoc(target, 'one');
      const primeGate = deferred();
      const verifyGate = deferred();
      gatedGh({ openIssues: () => primeGate.promise, verify: () => verifyGate.promise });
      const { mod } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [() => {}] });
      const running = mod.openWorktreeDetail(built.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-concurrent', path: target, branch: 'feat/concurrent' },
        notify: built.ctx.ui.notify,
      });
      running.catch(() => {});
      try {
        const component = await waitForMount(built);
        assert.ok(component, 'the detail mounts before the verification resolves');
        // A concurrent writer adds #12 while the initial snapshot only knew #7.
        assert.equal(registryLib.updateWorktree(root, target, { issues: [7, 12] }).ok, true);

        verifyGate.resolve(issueViewJson(7, { state: 'closed' }));
        primeGate.resolve(graphqlOpenPayload([12]));
        await flush();
        await flush();
        await flush();
        const row = registryLib.findByPath(root, target);
        assert.deepEqual(row.issues, [12], 'only the proven-closed id is dropped; the concurrent one survives');
        assert.match(renderDetail(component), /issues: #12/, 'and the view shows the merged assignment');
      } finally {
        verifyGate.resolve(issueViewJson(7));
        primeGate.resolve(graphqlOpenPayload([]));
        await closeMounted(built);
        await running.catch(() => {});
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });

  test('a warm cache paints the full header from peek without waiting for the full read', async () => {
    setEnv(stdEnv());
    try {
      const root = makeRepo('warm-peek');
      const target = addRegisteredWorktree(root, 'feat/warm-peek', { issues: [], odd: null });
      writeDoc(target, 'one');
      stubGh([]);
      const facts = factsDouble({ peeked: FULL_FACTS });
      const { mod } = await loadExtension();
      const built = scriptedCtx({ cwd: root, steps: [() => {}] });
      const running = mod.openWorktreeDetail(built.ctx, {
        repoRoot: gitLib.repoIdentity(root).root,
        target: { name: 'feat-warm-peek', path: target, branch: 'feat/warm-peek' },
        notify: built.ctx.ui.notify,
        checkoutFacts: facts.provider,
      });
      running.catch(() => {});
      try {
        const component = await waitForMount(built);
        assert.ok(component, 'the warm detail mounts immediately');
        const rendered = renderDetail(component);
        assert.match(rendered, /branch feat\/slow/, 'the cached branch paints at mount');
        assert.match(rendered, /3 changes/, 'the cached change size paints at mount');
        assert.match(rendered, /created 1d/, 'the cached ages paint at mount');
        assert.equal(facts.peekCalls.length, 1, 'exactly one synchronous peek');
        assert.equal(facts.factCalls.length, 1, 'and one background read, not a blocking one');
      } finally {
        facts.gate.resolve(FULL_FACTS);
        await closeMounted(built);
        await running.catch(() => {});
      }
    } finally {
      ghIssues.setGhRunner(null);
      restoreEnv();
    }
  });
});
