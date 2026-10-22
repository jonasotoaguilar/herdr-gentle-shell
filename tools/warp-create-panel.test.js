'use strict';
// T5 (worktree-ui-redesign S6): the worktree CREATION panel.
//
// Creating asks for exactly TWO things, in this order: the change type
// (with its sub-panel — there is no native dropdown in this host) and the
// change name with its live branch/path preview. `enter` on the name is the
// creation. The Issues/Odd association panes, their selection state and
// their previews are NOT part of this surface; they survive only in the
// panel's editing mode, which the editing tests below still drive. Every
// test renders headlessly at a fixed size and asserts that every line is
// EXACTLY the requested width, and drives the component with synthetic
// keys. The create tests use the real seams (`lib/gh-issues.js` through
// `setGhRunner`) to prove the panel reads NO issue or odd source.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const panel = require('../lib/warp-create-panel.js');
const realGit = require('../lib/worktree-git.js');
const ghIssues = require('../lib/gh-issues.js');

const scratch = [];
after(() => {
  ghIssues.setGhRunner(null);
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function scratchDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-panel-${tag}-`));
  scratch.push(dir);
  return dir;
}

// A real repository: `validateBranch` runs `git check-ref-format` and the
// path derivation reads the real repository identity, so the preview is
// proven against the same helpers the create path uses.
function makeRepo() {
  const dir = scratchDir('repo');
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  return dir;
}

const REPO = makeRepo();

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function stripAnsi(text) {
  // CSI colors, OSC links and the zero-width APC cursor marker the host
  // inserts for the hardware cursor are not columns.
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[^\x07\x1b]*\x07/g, '');
}

function boxLines(view, width, height) {
  const lines = view.render(width);
  assert.equal(lines.length, height, `expected ${height} lines, got ${lines.length}`);
  for (const line of lines) {
    assert.equal([...stripAnsi(line)].length, width, `line is not ${width} wide: ${JSON.stringify(line)}`);
  }
  return lines;
}

function findLine(lines, needle) {
  const line = lines.find((entry) => stripAnsi(entry).includes(needle));
  assert.ok(line !== undefined, `no line contains ${JSON.stringify(needle)}\n${lines.map(stripAnsi).join('\n')}`);
  return stripAnsi(line);
}

function allText(lines) {
  return lines.map(stripAnsi).join('\n');
}

const DEFAULT_ISSUES = [
  { number: 12, title: 'Crash on empty' },
  { number: 7, title: 'Docs drift' },
];
const DEFAULT_ODD = [
  { name: 'alpha', path: '/odd/alpha.md' },
  { name: 'beta', path: '/odd/beta.md' },
];

function openPanel(overrides = {}) {
  const finished = [];
  const reads = { issues: [], odd: [] };
  const view = panel.createWarpCreatePanel({
    cwd: REPO,
    git: realGit,
    helpers: null,
    hostTui: null,
    theme: null,
    rowsAvailable: () => 24,
    fetchIssues: () => ({ ok: true, issues: DEFAULT_ISSUES.map((entry) => ({ ...entry })) }),
    listOdd: () => ({ ok: true, docs: DEFAULT_ODD.map((entry) => ({ ...entry })) }),
    readIssuePreview: (number) => {
      reads.issues.push(number);
      return {
        ok: true,
        issue: {
          number,
          title: `Issue ${number}`,
          state: 'open',
          author: 'ana',
          body: `body of issue ${number}`,
        },
      };
    },
    readOddPreview: (doc) => {
      reads.odd.push(doc.path);
      return { ok: true, text: `# ${doc.name}\n\nspecs for ${doc.name}` };
    },
    renderMarkdown: (text) => String(text).split('\n'),
    done: (value) => { finished.push(value); },
    ...overrides,
  });
  return { view, finished, reads };
}

// Focus shortcuts for the EDITING mode (the create panel has no panes).
function focusName(view) {
  view.handleInput('down'); // type -> name
}
function focusIssues(view) {
  view.handleInput('\t');
}
// Tab only toggles the dataset once a pane owns focus, so the Odd dataset
// takes two presses from the header fields (S11).
function focusOdd(view) {
  view.handleInput('\t');
  view.handleInput('\t');
}
function typeText(view, text) {
  for (const char of text) view.handleInput(char);
}

describe('the rendered panel', { concurrency: false }, () => {
  test('shows the change type, the change name, the live branch and path preview, the two steps and the footers', () => {
    const { view } = openPanel({ initialName: 'new-change' });
    const lines = boxLines(view, 100, 24);
    const text = allText(lines);
    assert.match(text, /Type: Feature \(feat\)/, 'the conventional type with its human label');
    assert.match(text, /Name: new-change/, 'the typed name');
    findLine(lines, 'preview branch: feat/new-change');
    findLine(lines, `preview path: ${path.join(path.dirname(REPO), `${path.basename(REPO)}-worktrees`, 'feat-new-change')}`);
    assert.match(text, /Step 1 of 2 · change type/, 'the first step is named');
    assert.match(text, /↑\/↓ fields/, 'the footer names the arrow map');
    assert.match(text, /←\/→ type/, 'the footer names the type keys');
    assert.match(text, /Enter confirm/, 'the footer names the confirm key');
    assert.match(text, /Ctrl\+S create/, 'the keys footer names ctrl+s');
    assert.match(text, /Esc cancel/, 'the keys footer names esc');
    assert.ok(!text.includes('? help'), 'the footer never advertises a help key');
  });

  test('every line is exactly the requested width at several terminal sizes', () => {
    for (const [width, height] of [[60, 18], [80, 24], [100, 24], [120, 30]]) {
      const { view } = openPanel({ rowsAvailable: () => height });
      boxLines(view, width, height);
    }
  });

  test('typing the name moves the branch and path preview live, character by character', () => {
    const { view } = openPanel();
    focusName(view);
    typeText(view, 'new');
    let lines = boxLines(view, 100, 24);
    assert.match(findLine(lines, 'preview branch:').trim(), /feat\/new$/);
    typeText(view, '-change');
    lines = boxLines(view, 100, 24);
    findLine(lines, 'preview branch: feat/new-change');
    findLine(lines, 'preview path:');
    const preview = findLine(lines, 'preview path:');
    assert.ok(preview.includes('feat-new-change'), 'the path follows the typed name');
    assert.match(findLine(lines, 'Name:'), /Name: new-change▊/);
  });

  test('an invalid name is shown as invalid instead of a derived branch', () => {
    const { view } = openPanel();
    const lines = boxLines(view, 100, 24);
    const branch = findLine(lines, 'preview branch:');
    assert.ok(branch.includes('✗'), 'the invalid state is marked');
    assert.match(branch, /name is empty/);
    assert.ok(!branch.includes('feat/worktree'), 'no fake branch is derived from an empty name');
    const target = findLine(lines, 'preview path:');
    assert.match(target, /✗ not derived/);
    // A name with nothing slug-worthy is refused, not silently turned into `worktree`.
    focusName(view);
    typeText(view, '!!!');
    assert.match(findLine(boxLines(view, 100, 24), 'preview branch:'), /name has no letters or digits/);
  });

  test('a git refusal of the derived branch is surfaced verbatim', () => {
    const git = {
      slugifyBranch: () => '-bad',
      validateBranch: (branch) => ({ ok: false, reason: `invalid branch name: ${branch}` }),
      canonicalWorktreePath: () => '/nowhere',
    };
    const { view } = openPanel({ git, initialName: 'x' });
    assert.match(findLine(boxLines(view, 100, 24), 'preview branch:'), /invalid branch name: feat\/-bad/);
  });

  test('the name field renders a real placeholder and a cursor, and never treats the placeholder as the value', () => {
    const { view, finished } = openPanel();
    focusName(view);
    let text = allText(boxLines(view, 100, 24));
    assert.match(text, /Name: ▊name-change/, 'the placeholder is ghost text after the caret');
    view.handleInput('n');
    text = allText(boxLines(view, 100, 24));
    assert.match(text, /Name: n▊/, 'the typed value replaces the ghost text');
    assert.ok(!text.includes('name-change'), 'the placeholder disappears once there is a value');
    // The placeholder is not a name: creating from it is refused.
    view.handleInput('\x7f');
    view.handleInput('\x13');
    assert.deepEqual(finished, [], 'a ghost placeholder never creates anything');
    assert.match(allText(boxLines(view, 100, 24)), /cannot create: name is empty/);
  });
});

describe('the type field', { concurrency: false }, () => {
  test('enter opens the type sub-panel and a pick closes it and moves to the name', () => {
    const { view } = openPanel();
    view.handleInput('enter');
    assert.equal(view.state.typePanelOpen, true, 'enter opens the sub-panel');
    let text = allText(boxLines(view, 100, 24));
    assert.match(text, /Choose the change type/);
    for (const type of panel.CHANGE_TYPES) {
      assert.ok(text.includes(`${type.label} (${type.id})`), `the sub-panel lists ${type.id}`);
    }
    view.handleInput('down');
    view.handleInput('enter');
    assert.equal(view.state.typePanelOpen, false, 'picking closes the sub-panel');
    assert.equal(view.state.focus, 'name', 'a pick moves focus to the name');
    text = allText(boxLines(view, 100, 24));
    assert.match(text, /Type: Bug fix \(fix\)/);
  });

  test('left/right cycle the type as a shortcut', () => {
    const { view } = openPanel({ initialName: 'new-change' });
    view.handleInput('right');
    assert.match(findLine(boxLines(view, 100, 24), 'preview branch:').trim(), /^preview branch: fix\/new-change$/);
    assert.match(allText(boxLines(view, 100, 24)), /Type: Bug fix \(fix\)/);
    view.handleInput('left');
    view.handleInput('left');
    const last = panel.CHANGE_TYPES[panel.CHANGE_TYPES.length - 1];
    assert.match(allText(boxLines(view, 100, 24)), new RegExp(`Type: ${last.label} \\(${last.id}\\)`));
  });

  test('the type set and the branch format match the repository branch-pr convention', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'gentle-worktree-tools.ts'), 'utf8');
    const block = /const WARP_CHANGE_TYPES = \[([\s\S]*?)\n\];/.exec(source);
    assert.ok(block, 'the extension declares the change types');
    const pairs = [...block[1].matchAll(/\{ id: "([^"]+)", label: "([^"]+)" \}/g)].map((match) => ({ id: match[1], label: match[2] }));
    assert.ok(pairs.length > 0, 'the extension list parses');
    assert.deepEqual(panel.CHANGE_TYPES, pairs, 'the panel reuses the convention instead of inventing a second list');
    const line = source.split('\n').find((entry) => entry.includes('const WARP_CREATE_BRANCH_RE ='));
    const literal = line.slice(line.indexOf('= ') + 2).replace(/;\s*$/, '');
    const branchRe = new RegExp(literal.slice(1, literal.lastIndexOf('/')).replace(/\\\//g, '/'));
    const { view } = openPanel({ initialName: 'new-change' });
    const branch = findLine(boxLines(view, 100, 24), 'preview branch:').trim().replace('preview branch: ', '');
    assert.ok(branchRe.test(branch), `${branch} must match the skill's <type>/<slug> shape`);
  });
});

// S6: creating a worktree asks for exactly TWO things — the change type and
// the change name — and then creates it. The Issues/Odd association panes,
// their selection state, their keys and their previews belong to no part of
// this surface any more.
describe('S6: creation asks for the type and the name, nothing else', { concurrency: false }, () => {
  test('the panel has no Issues pane, no Odd pane, no pane tab and no preview column', () => {
    const { view } = openPanel({ initialName: 'new-change' });
    const text = allText(boxLines(view, 120, 24));
    assert.ok(!text.includes('Issues'), `no Issues pane\n${text}`);
    assert.ok(!text.includes('Odd'), `no Odd pane\n${text}`);
    assert.ok(!text.includes('Preview'), `no preview column header\n${text}`);
    assert.ok(!text.includes('Search Issues:') && !text.includes('Search Odd:'), `no pane filter row\n${text}`);
    assert.ok(!text.includes('[ ] '), `no association rows\n${text}`);
    assert.ok(!text.includes('[x] '), `no association rows\n${text}`);
    assert.ok(!/selected: \d+ issue/.test(text), `no association counts line\n${text}`);
  });

  test('the panel carries no pane or selection state at all', () => {
    const { view } = openPanel();
    for (const key of ['pane', 'filterOpen', 'queries', 'cursor', 'selectedIssues', 'selectedOdd', 'issues', 'odd']) {
      assert.equal(key in view.state, false, `the create panel keeps no ${key} state`);
    }
    assert.deepEqual(Object.keys(view.state).sort(), ['focus', 'message', 'name', 'typeCursor', 'typeIndex', 'typePanelOpen']);
  });

  test('tab and shift+tab are inert: they never switch panes nor move a field', () => {
    const { view, finished } = openPanel({ initialName: 'new-change' });
    const before = allText(boxLines(view, 100, 24));
    view.handleInput('\t');
    assert.equal(view.state.focus, 'type', 'tab does not leave the type field');
    assert.equal(allText(boxLines(view, 100, 24)), before, 'the frame is byte-identical after tab');
    view.handleInput('\x1b[Z'); // shift+tab
    assert.equal(view.state.focus, 'type', 'shift+tab moves no field either');
    view.handleInput('\x1b[B'); // -> name
    view.handleInput('\t');
    assert.equal(view.state.focus, 'name', 'tab from the name field is inert too');
    assert.deepEqual(finished, [], 'tab never completes or cancels a creation');
  });

  test('the two steps run in order and create with the chosen type and name', () => {
    const { view, finished } = openPanel();
    let text = allText(boxLines(view, 100, 24));
    assert.match(text, /Step 1 of 2 · change type/);
    assert.ok(!text.includes('cannot create'), 'nothing has been refused yet');
    view.handleInput('enter'); // step 1: open the change-type picker
    assert.equal(view.state.typePanelOpen, true);
    view.handleInput('down'); // Feature -> Bug fix
    view.handleInput('enter'); // pick it and reach step 2
    assert.equal(view.state.focus, 'name', 'the type pick hands over to the name');
    text = allText(boxLines(view, 100, 24));
    assert.match(text, /Type: Bug fix \(fix\)/);
    assert.match(text, /Step 2 of 2 · change name/);
    assert.deepEqual(finished, [], 'picking the type creates nothing yet');
    typeText(view, 'panel-change');
    assert.deepEqual(finished, [], 'typing the name creates nothing yet');
    view.handleInput('enter'); // step 2: create
    assert.deepEqual(finished, [{ ok: true, type: 'fix', name: 'panel-change' }]);
  });

  test('the created payload carries no issues and no odd fields, and ignores injected associations', () => {
    const { view, finished } = openPanel({
      initialName: 'new-change',
      initialIssues: [12],
      initialOdd: '/odd/alpha.md',
    });
    view.handleInput('\x13');
    assert.equal(finished.length, 1);
    assert.deepEqual(finished[0], { ok: true, type: 'feat', name: 'new-change' });
    assert.deepEqual(Object.keys(finished[0]).sort(), ['name', 'ok', 'type'], 'no issues/odd/mode fields ride along');
  });

  test('the injected issue and odd sources are never consulted: no listing, no preview read', async () => {
    const calls = [];
    const { view, reads } = openPanel({
      fetchIssues: () => { calls.push('issues'); return { ok: true, issues: DEFAULT_ISSUES.map((row) => ({ ...row })) }; },
      listOdd: () => { calls.push('odd'); return { ok: true, docs: DEFAULT_ODD.map((doc) => ({ ...doc })) }; },
    });
    await flush();
    view.handleInput('enter');
    view.handleInput('enter');
    typeText(view, 'new-change');
    view.handleInput('\x13');
    assert.deepEqual(calls, [], 'neither source is asked for a list');
    assert.deepEqual(reads, { issues: [], odd: [] }, 'no preview is ever read');
  });
});

describe('completion', { concurrency: false }, () => {
  test('enter on the name field creates with the two collected values', () => {
    const { view, finished } = openPanel();
    view.handleInput('down'); // type -> name
    typeText(view, 'new-change');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ ok: true, type: 'feat', name: 'new-change' }]);
  });

  test('ctrl+s creates from any field, and fires exactly once', () => {
    const { view, finished } = openPanel({ cwd: REPO });
    focusName(view);
    typeText(view, 'new-change');
    view.handleInput('\x13');
    view.handleInput('\x13');
    assert.equal(finished.length, 1, 'completion fires exactly once');
    assert.deepEqual(finished[0], { ok: true, type: 'feat', name: 'new-change' });
  });

  test('creation is refused while the branch is invalid, and the reason is shown', () => {
    const { view, finished } = openPanel();
    view.handleInput('\x13');
    assert.deepEqual(finished, [], 'an empty name never creates');
    assert.match(allText(boxLines(view, 100, 24)), /cannot create: name is empty/);
    focusName(view);
    typeText(view, 'new-change');
    assert.ok(!allText(boxLines(view, 100, 24)).includes('cannot create'), 'fixing the name clears the refusal');
    view.handleInput('\x13');
    assert.equal(finished.length, 1);
  });

  test('enter on an invalid name refuses with the same message instead of creating', () => {
    const { view, finished } = openPanel({ initialName: '!!!' });
    view.handleInput('down'); // type -> name
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'nothing is created');
    assert.match(allText(boxLines(view, 100, 24)), /cannot create: name has no letters or digits/);
  });

  test('esc cancels the whole creation with null, exactly once', () => {
    const { view, finished } = openPanel();
    view.handleInput('escape');
    view.handleInput('escape');
    assert.deepEqual(finished, [null]);
  });

  test('esc unwinds the type sub-panel before cancelling', () => {
    const { view, finished } = openPanel();
    view.handleInput('enter');
    view.handleInput('escape');
    assert.equal(view.state.typePanelOpen, false);
    assert.deepEqual(finished, [], 'closing the sub-panel does not cancel the creation');
    view.handleInput('escape');
    assert.deepEqual(finished, [null]);
  });

  test('there is no key-help overlay: the footer already carries every shortcut', () => {
    const { view } = openPanel();
    const before = allText(boxLines(view, 100, 24));
    view.handleInput('?');
    const after = allText(boxLines(view, 100, 24));
    assert.equal(after, before, '? is not a binding: no overlay opens on the Type field');
    assert.ok(!after.includes('close this help'), 'no key list replaces the content');
    assert.ok(!after.includes('? help'), 'the footer never advertises a help key');
    assert.match(after, /Enter confirm/);
    assert.match(after, /Ctrl\+S create/);
    assert.match(after, /Esc cancel/);
  });
});

describe('the create panel never reads the issue or odd libraries (S6)', { concurrency: false }, () => {
  test('no gh call and no odd document is listed or read with the real libraries in place', async () => {
    const seen = [];
    ghIssues.setGhRunner((bin, argv) => {
      seen.push(argv);
      return { status: 1, stderr: 'the create panel must not call gh', stdout: '' };
    });
    const root = scratchDir('checkout');
    fs.mkdirSync(path.join(root, 'odd', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'odd', 'tasks', 'alpha.md'), '# Alpha\n\nSome specs.\n', 'utf8');
    try {
      const { view, finished } = openPanel({
        cwd: root,
        initialName: 'new-change',
        fetchIssues: undefined,
        readIssuePreview: undefined,
        listOdd: undefined,
        readOddPreview: undefined,
        renderMarkdown: undefined,
      });
      await flush();
      const text = allText(boxLines(view, 100, 24));
      assert.ok(!text.includes('alpha'), 'no odd document row is listed');
      assert.ok(!text.includes('Fix the crash'), 'no issue row is listed');
      view.handleInput('\x13');
      assert.deepEqual(finished, [{ ok: true, type: 'feat', name: 'new-change' }], 'creation needs no source at all');
      assert.deepEqual(seen, [], 'gh never ran');
    } finally {
      ghIssues.setGhRunner(null);
    }
  });
});
describe('the editing mode (S13)', { concurrency: false }, () => {
  function editPanel(overrides = {}) {
    return openPanel({
      mode: 'edit',
      initialType: 'feat',
      initialName: 'old-change',
      branch: 'feat/old-change',
      path: '/checkouts/feat-old-change',
      ...overrides,
    });
  }

  test('renders the checkout type and name and its OWN branch/path, never a re-derivation', () => {
    const checkout = scratchDir('checkout');
    const { view } = editPanel({
      // The real checkout: branch and name deliberately do NOT match what
      // the create-time convention would derive from these two fields.
      initialType: 'feat',
      initialName: 'feat-odd-viewer',
      branch: 'feat/odd-viewer',
      path: checkout,
      initialIssues: [12],
      initialOdd: '/odd/alpha.md',
    });
    const lines = boxLines(view, 100, 24);
    const text = allText(lines);
    assert.match(text, /Type: Feature \(feat\)/);
    assert.match(text, /Name: odd-viewer/, 'the name splits from the checkout branch');
    assert.match(text, /\[frozen\]/, 'the frozen fields say so');
    assert.ok(!text.includes('old-change▊'), 'a frozen name has no text caret');
    findLine(lines, 'checkout branch: feat/odd-viewer');
    findLine(lines, `checkout path: ${checkout}`);
    assert.ok(!text.includes('feat/feat-odd-viewer'), 'the derived branch is never shown');
    assert.ok(!text.includes('feat-feat-odd-viewer'), 'the derived path is never shown');
    assert.match(text, /\[x\] #12 Crash on empty/, 'the assigned issue is pre-selected');
    assert.ok(!text.includes('[x] alpha'), 'the Odd list is not a second list column');
    focusOdd(view);
    assert.match(allText(boxLines(view, 100, 24)), /\[x\] alpha/, 'the assigned odd document is pre-selected');
    assert.deepEqual(view.state.selectedIssues, [12]);
    assert.equal(view.state.selectedOdd, '/odd/alpha.md');
  });

  test('a checkout whose branch is not conventional renders it without inventing a type', () => {
    const checkout = scratchDir('checkout');
    const { view } = editPanel({
      initialType: 'feat',
      initialName: 'feat-odd-viewer',
      branch: 'main',
      path: checkout,
    });
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /checkout branch: main/);
    assert.match(text, /Type: unavailable/, 'an unknowable type is shown as unavailable');
    assert.match(text, /Name: main/, 'the field shows the branch the checkout actually has');
    assert.ok(!text.includes('Feature (feat)'), 'the frozen type is never invented');
  });

  test('a missing branch or path renders as unavailable instead of a derived value', () => {
    const { view } = openPanel({
      mode: 'edit',
      initialType: 'feat',
      initialName: 'feat-odd-viewer',
    });
    const lines = boxLines(view, 100, 24);
    const text = allText(lines);
    findLine(lines, 'checkout branch: unavailable');
    findLine(lines, 'checkout path: unavailable');
    assert.match(text, /Type: unavailable/);
    assert.match(text, /Name: unavailable/);
    assert.ok(!text.includes('feat/feat-odd-viewer'), 'nothing is derived from the frozen fields');
    assert.ok(!text.includes('-worktrees'), 'no derived worktree path is shown');
  });

  test('editing never refuses a branch or path that breaks the create-time convention', () => {
    const { view, finished } = editPanel({
      branch: 'main',
      // A path that the create-time derivation would never produce (and
      // that does not exist): editing must still open and save.
      path: '/does/not/follow/feat-old-change',
    });
    assert.equal(view.state.message, '', 'editing shows no refusal');
    view.handleInput('\x13');
    assert.deepEqual(finished, [{ ok: true, mode: 'edit', type: null, name: 'main', issues: [], odd: null }]);
  });

  test('freezing ignores printable input, backspace and the ←/→ cycle', () => {
    const { view } = editPanel();
    view.handleInput('down'); // type -> name
    assert.equal(view.state.focus, 'name');
    typeText(view, 'xyz');
    view.handleInput('\x7f');
    assert.equal(view.state.name, 'old-change', 'typing and backspace never touch the frozen name');
    assert.match(allText(boxLines(view, 100, 24)), /Name: old-change/);
    assert.ok(!allText(boxLines(view, 100, 24)).includes('old-changexyz'));
    // S21: ←/→ are inert on the frozen Name; `↑` is the way back to Type,
    // where ←/→ still never cycle the frozen type.
    view.handleInput('left');
    assert.equal(view.state.focus, 'name', 'left on the frozen name moves no field');
    view.handleInput('right');
    assert.equal(view.state.focus, 'name', 'right on the frozen name moves no field');
    view.handleInput('up');
    assert.equal(view.state.focus, 'type');
    view.handleInput('right');
    assert.equal(view.state.typeIndex, 0, 'right on the frozen type never cycles');
    assert.equal(view.state.focus, 'type');
    view.handleInput('left');
    assert.equal(view.state.typeIndex, 0, 'left on the frozen type never cycles');
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /Type: Feature \(feat\)/);
    findLine(boxLines(view, 100, 24), 'checkout branch: feat/old-change');
  });

  test('the type sub-panel never opens in editing mode', () => {
    const { view } = editPanel();
    view.handleInput('enter');
    assert.equal(view.state.typePanelOpen, false);
    assert.ok(!allText(boxLines(view, 100, 24)).includes('Choose the change type'));
  });

  test('the edit header carries the checkout summary and the preselected association counts', () => {
    const { view } = editPanel({ initialIssues: [12], initialOdd: '/odd/alpha.md' });
    let lines = boxLines(view, 100, 24);
    let text = allText(lines);
    findLine(lines, 'checkout branch: feat/old-change');
    findLine(lines, 'checkout path: /checkouts/feat-old-change');
    assert.match(text, /selected: 1 issue · 1 odd/, 'the header shows the preselected counts');
    view.handleInput('\t'); // -> Issues dataset
    view.handleInput(' '); // deselect #12
    text = allText(boxLines(view, 100, 24));
    assert.match(text, /selected: 0 issues · 1 odd/, 'the header count follows the edit toggle');
  });

  test('an empty pre-selection stays empty and saving carries the empty sets', () => {
    const { view, finished } = editPanel({ initialIssues: [], initialOdd: null });
    assert.deepEqual(view.state.selectedIssues, []);
    assert.equal(view.state.selectedOdd, null);
    assert.ok(!allText(boxLines(view, 100, 24)).includes('[x]'));
    view.handleInput('\x13');
    assert.deepEqual(finished, [{ ok: true, mode: 'edit', type: 'feat', name: 'old-change', issues: [], odd: null }]);
  });

  test('a pre-selected row outside the visible page stays selected and toggling changes the saved sets', () => {
    const issues = [
      { number: 12, title: 'Crash on empty' },
      { number: 7, title: 'Docs drift' },
      { number: 3, title: 'Three' },
    ];
    const { view, finished } = editPanel({
      pageSize: 1,
      fetchIssues: () => ({ ok: true, issues }),
      initialIssues: [3],
      initialOdd: '/odd/beta.md',
    });
    assert.deepEqual(view.state.selectedIssues, [3]);
    const text = allText(boxLines(view, 100, 24));
    assert.ok(text.includes('#12 Crash on empty'), 'page 1 shows only the first row');
    assert.ok(!text.includes('#3 Three'), 'the pre-selected row is off this page');
    view.handleInput('\t'); // focus the Issues pane
    view.handleInput(' '); // toggle #12 on
    assert.deepEqual(view.state.selectedIssues, [3, 12]);
    assert.match(allText(boxLines(view, 100, 24)), /\[x\] #12 Crash on empty/);
    view.handleInput('\x13');
    assert.deepEqual(finished, [{
      ok: true, mode: 'edit', type: 'feat', name: 'old-change', issues: [3, 12], odd: '/odd/beta.md',
    }]);
  });

  test('a stored odd assignment named by its relative path still marks its document', () => {
    const { view, finished } = editPanel({ initialOdd: 'odd/tasks/alpha.md' });
    assert.equal(view.state.selectedOdd, 'odd/tasks/alpha.md', 'the caller value is preserved');
    focusOdd(view);
    assert.match(allText(boxLines(view, 100, 24)), /\[x\] alpha/);
    view.handleInput('\x13');
    assert.equal(finished[0].odd, 'odd/tasks/alpha.md');
  });

  test('the Odd control is a SINGLE SELECT: choosing another document replaces the active one', () => {
    const { view, finished } = editPanel({ initialOdd: '/odd/alpha.md' });
    focusOdd(view);
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /\[x\] alpha/, 'the active document is marked');
    assert.match(text, /\[ \] beta/, 'the other one is not');

    view.handleInput('\x1b[B'); // second document
    view.handleInput(' '); // choose it
    assert.equal(view.state.selectedOdd, '/odd/beta.md', 'choosing REPLACES the active document');
    const after = allText(boxLines(view, 100, 24));
    assert.match(after, /\[ \] alpha/, 'the previous document is no longer selected');
    assert.match(after, /\[x\] beta/, 'and the chosen one is');
    assert.equal(after.split('[x]').length - 1, 1, `exactly one document can be selected\n${after}`);
    assert.match(after, /selected: 0 issues · 1 odd/, 'the header counts one document, never two');

    view.handleInput('\x13');
    assert.equal(finished[0].odd, '/odd/beta.md', 'the saved payload carries the single choice');
    assert.equal(Array.isArray(finished[0].odd), false, 'the payload never carries a list');
  });

  test('choosing the active document again clears the association (never a second one)', () => {
    const { view, finished } = editPanel({ initialOdd: '/odd/alpha.md' });
    focusOdd(view);
    view.handleInput(' '); // the already-selected document
    assert.equal(view.state.selectedOdd, null, 'the association is cleared, nothing is duplicated');
    assert.ok(!allText(boxLines(view, 100, 24)).includes('[x]'), 'no document stays marked');
    view.handleInput('\x13');
    assert.equal(finished[0].odd, null, 'the saved payload carries no association');
  });

  test('enter on the last field saves the edit with the mode marker', () => {
    const { view, finished } = editPanel({
      initialType: 'fix',
      branch: 'fix/old-change',
      initialIssues: [12],
      initialOdd: '/odd/alpha.md',
    });
    view.handleInput('\t'); // issues
    view.handleInput(' '); // toggle #12 off
    view.handleInput('enter'); // issues -> odd
    assert.equal(view.state.focus, 'odd');
    view.handleInput('enter'); // last field -> save
    assert.deepEqual(finished, [{
      ok: true, mode: 'edit', type: 'fix', name: 'old-change', issues: [], odd: '/odd/alpha.md',
    }]);
  });

  test('esc cancels the edit with null and writes nothing', () => {
    const { view, finished } = editPanel({ initialIssues: [12] });
    view.handleInput('\t');
    view.handleInput(' '); // a change the user then discards
    view.handleInput('escape');
    view.handleInput('escape');
    assert.deepEqual(finished, [null]);
  });

  test('the filter and paging still work while editing, and there is no key-help overlay', () => {
    const { view } = editPanel({ pageSize: 1 });
    view.handleInput('\t'); // issues
    view.handleInput('T');
    assert.equal(view.state.filterOpen, true);
    typeText(view, 'crash');
    assert.equal(view.state.queries.issues, 'crash');
    view.handleInput('escape');
    assert.equal(view.state.filterOpen, false);
    assert.equal(view.state.queries.issues, 'crash', 'the filter is kept');
    view.handleInput(']');
    assert.match(allText(boxLines(view, 100, 24)), /page \d\/\d/);
    // Move back to the header so `?` is pressed on a focused field, not in
    // a pane where a printable key opens the filter.
    view.handleInput('up');
    view.handleInput('up');
    const before = allText(boxLines(view, 100, 24));
    view.handleInput('?');
    const after = allText(boxLines(view, 100, 24));
    assert.equal(after, before, '? opens no overlay in editing mode either');
    assert.ok(after.includes('[frozen]'), 'the frozen fields stay visible');
    assert.ok(!after.includes('? help'), 'the footer never advertises a help key');
    assert.match(after, /Enter save/);
    assert.match(after, /Ctrl\+S save/);
    assert.match(after, /Esc cancel/);
  });

  test('create mode keeps its editable fields and its sub-panel, and its payload carries no mode marker', () => {
    const { view, finished } = openPanel({ initialName: 'new-change' });
    view.handleInput('down'); // type -> name
    typeText(view, '-2');
    assert.equal(view.state.name, 'new-change-2', 'the create name is still editable');
    view.handleInput('down'); // S6: nothing sits below the name while creating
    assert.equal(view.state.focus, 'name');
    view.handleInput('up'); // -> type
    assert.equal(view.state.focus, 'type');
    view.handleInput('right');
    assert.equal(view.state.typeIndex, 1, '←/→ still cycle the type while creating');
    view.handleInput('\x13');
    assert.equal(finished.length, 1);
    assert.ok(!('mode' in finished[0]), 'a creation carries no mode marker');
    assert.deepEqual(Object.keys(finished[0]).sort(), ['name', 'ok', 'type']);
  });
});

// S2: a key legend is ONE terminal row. The create panel used to spend two
// rows on the same legend; a merged legend that does not fit is compacted
// (short tokens, then the lowest-priority keys dropped), never clipped with
// an ellipsis and never wrapped onto a second row.
describe('S2: one-row key legends', { concurrency: false }, () => {
  const WIDTHS = [40, 60, 80, 120];
  const LEGEND = /Esc cancel|Ctrl\+S create/;

  function legendRows(lines, marker) {
    return lines.map(stripAnsi).filter((line) => marker.test(line));
  }

  test('the create legend owns exactly one row at every width', () => {
    for (const width of WIDTHS) {
      const { view } = openPanel();
      const lines = boxLines(view, width, 24);
      const legend = legendRows(lines, LEGEND);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /↑\/↓/, `width ${width}: the field keys survive`);
      assert.match(legend[0], /Esc cancel/, `width ${width}: the cancel key survives`);
    }
  });

  test('the type sub-panel legend owns exactly one row at every width', () => {
    for (const width of WIDTHS) {
      const { view } = openPanel();
      view.handleInput('enter');
      const lines = boxLines(view, width, 24);
      const legend = legendRows(lines, /Esc close|Enter pick/);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /Esc close/, `width ${width}: the close key survives`);
    }
  });

  test('the edit panel filter legend owns exactly one row at every width', () => {
    for (const width of WIDTHS) {
      const { view } = openPanel({ mode: 'edit', branch: 'feat/old-change', path: '/checkouts/feat-old-change' });
      focusIssues(view);
      view.handleInput('T');
      const lines = boxLines(view, width, 24);
      const legend = legendRows(lines, /filter|type to narrow/);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /narrow/, `width ${width}: the filter hint survives`);
    }
  });
});
