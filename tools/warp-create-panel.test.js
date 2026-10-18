'use strict';
// W4 (warp-popup S3,S4,S5,S7,S8): the SINGLE-PANEL worktree creation.
//
// One component holds everything a creation needs at once: the change
// type (with its sub-panel — there is no native dropdown in this host),
// the change name with its live branch/path preview, and the Issues and
// Odd panes side by side with the focused row's complete, read-only
// preview. Every test renders headlessly at a fixed size and asserts that
// every line is EXACTLY the requested width, and drives the component with
// synthetic keys. The issue fetcher, the odd lister and both preview
// readers are injected; two tests use the real seams (lib/gh-issues.js
// through `setGhRunner`, lib/odd-docs.js + lib/odd-markdown.js on a temp
// checkout) to prove the wiring, not a re-implementation.

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

// The Odd pane's row order as PAINTED: every odd row renders as
// `[ ] <name>` (or `❯ [x] <name>` when focused and selected), so the
// sequence a pane actually shows can be read back from the frame without
// reaching into internal state.
function oddRowOrder(lines, names) {
  const out = [];
  for (const line of lines) {
    const text = stripAnsi(line);
    for (const name of names) {
      if (out.includes(name)) continue;
      if (text.includes(`[ ] ${name}`) || text.includes(`[x] ${name}`)) out.push(name);
    }
  }
  return out;
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

// Focus shortcuts (the panel's own documented keys).
function focusName(view) {
  view.handleInput('down'); // type -> name
}
function focusIssues(view) {
  view.handleInput('\t');
}
function typeText(view, text) {
  for (const char of text) view.handleInput(char);
}

describe('the rendered panel', { concurrency: false }, () => {
  test('shows the type and name fields, the live branch and path preview, both panes and the footers', () => {
    const { view } = openPanel({ initialName: 'new-change' });
    const lines = boxLines(view, 100, 24);
    const text = allText(lines);
    assert.match(text, /Type: Feature \(feat\)/, 'the conventional type with its human label');
    assert.match(text, /Name: new-change/, 'the typed name');
    findLine(lines, 'preview branch: feat/new-change');
    findLine(lines, `preview path: ${path.join(path.dirname(REPO), `${path.basename(REPO)}-worktrees`, 'feat-new-change')}`);
    assert.match(text, /Issues/, 'the Issues pane header');
    assert.match(text, /Odd/, 'the Odd pane header');
    assert.match(text, /Preview/, 'the preview header');
    assert.match(text, /#12 Crash on empty/, 'the first issue row');
    assert.match(text, /alpha/, 'the first odd row');
    assert.match(text, /body of issue 12/, 'the focused row preview');
    assert.match(text, /Ctrl\+S create/, 'the keys footer names ctrl+s');
    assert.match(text, /Esc cancel/, 'the keys footer names esc');
    assert.match(text, /\? help/, 'the keys footer names the help key');
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

describe('the two panes', { concurrency: false }, () => {
  test('both panes list their rows and the focused row preview is read on focus, once per row', () => {
    const { view, reads } = openPanel();
    assert.deepEqual(reads.issues, [12], 'the row in focus at open is read exactly once');
    let lines = boxLines(view, 100, 24);
    assert.match(allText(lines), /#12 Crash on empty/);
    assert.match(allText(lines), /#7 Docs drift/);
    assert.match(allText(lines), /alpha/);
    assert.match(allText(lines), /body of issue 12/);
    focusIssues(view);
    view.handleInput('down');
    assert.deepEqual(reads.issues, [12, 7], 'the newly focused row is read');
    lines = boxLines(view, 100, 24);
    assert.match(allText(lines), /body of issue 7/, 'the preview follows the focused row');
    assert.ok(!allText(lines).includes('body of issue 12'), 'the previous preview is not shown');
    view.handleInput('up');
    assert.deepEqual(reads.issues, [12, 7], 'a revisited row comes from the cache');
    assert.match(allText(boxLines(view, 100, 24)), /body of issue 12/);
  });

  test('the odd preview reads the document and renders it with the markdown renderer', () => {
    const { view, reads } = openPanel();
    view.handleInput('\t');
    view.handleInput('\t'); // issues -> odd
    const text = allText(boxLines(view, 100, 24));
    assert.deepEqual(reads.odd, ['/odd/alpha.md']);
    assert.match(text, /specs for alpha/);
    assert.match(text, /# alpha/, 'the injected renderer received the document text');
  });

  test('the Odd pane renders the order it is handed, newest first, instead of re-sorting by label (S15, T14)', () => {
    // lib/odd-docs.js hands these already newest-first and the first element
    // is LAST alphabetically, so a pane that sorted by label would render it
    // last instead of first. The preview is a constant so only the list
    // column carries the document names.
    const docs = [
      { name: 'zulu', path: '/odd/zulu.md' },
      { name: 'mike', path: '/odd/mike.md' },
      { name: 'alpha-early', path: '/odd/alpha-early.md' },
    ];
    const { view } = openPanel({
      pageSize: 10,
      listOdd: () => ({ ok: true, docs: docs.map((entry) => ({ ...entry })) }),
      readOddPreview: () => ({ ok: true, text: 'PREVIEW' }),
      renderMarkdown: () => ['PREVIEW'],
    });
    const order = oddRowOrder(boxLines(view, 100, 24), docs.map((entry) => entry.name));
    assert.equal(order[0], 'zulu', 'the newest document (last alphabetically) is the first row');
    assert.deepEqual(order, ['zulu', 'mike', 'alpha-early'], 'the whole pane keeps the handed order');
  });

  test('a document whose timestamp could not be read is listed last, never dropped or promoted', () => {
    // lib/odd-docs.js places an unreadable-timestamp document after the
    // readable ones; the pane must keep that position and the document.
    const docs = [
      { name: 'zulu', path: '/odd/zulu.md' },
      { name: 'mike', path: '/odd/mike.md' },
      { name: 'ghost', path: '/odd/ghost.md' },
    ];
    const { view } = openPanel({
      pageSize: 10,
      listOdd: () => ({ ok: true, docs: docs.map((entry) => ({ ...entry })) }),
      readOddPreview: () => ({ ok: true, text: 'PREVIEW' }),
      renderMarkdown: () => ['PREVIEW'],
    });
    const order = oddRowOrder(boxLines(view, 100, 24), docs.map((entry) => entry.name));
    assert.deepEqual(order, ['zulu', 'mike', 'ghost'], 'every document is listed in the source order');
    assert.equal(order[order.length - 1], 'ghost', 'the unreadable one stays last, never promoted or dropped');
  });

  test('paging moves the pane page and clamps at both ends', () => {
    const issues = Array.from({ length: 5 }, (_, index) => ({ number: index + 1, title: `row ${index + 1}` }));
    const { view } = openPanel({ pageSize: 3, fetchIssues: () => ({ ok: true, issues }) });
    focusIssues(view);
    let text = allText(boxLines(view, 100, 24));
    assert.match(text, /Issues 5 open .*page 1\/2/);
    assert.ok(text.includes('#1 row 1'));
    assert.ok(!text.includes('#4 row 4'), 'the second page stays off-screen');
    view.handleInput(']');
    text = allText(boxLines(view, 100, 24));
    assert.match(text, /page 2\/2/);
    assert.ok(text.includes('#4 row 4'), '] turns to the second page');
    assert.ok(!text.includes('#1 row 1'));
    view.handleInput('pagedown');
    assert.match(allText(boxLines(view, 100, 24)), /page 2\/2/, 'pagedown clamps at the last page');
    view.handleInput('[');
    view.handleInput('pageup');
    assert.match(allText(boxLines(view, 100, 24)), /page 1\/2/, 'pageup and [ clamp at the first page');
  });

  test('an empty issue list still shows the Issues pane and says there are no open issues', () => {
    const { view } = openPanel({ fetchIssues: () => ({ ok: true, issues: [] }) });
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /Issues/);
    assert.match(text, /no open issues/);
    assert.match(text, /nothing to preview/);
  });

  test('no odd documents says so in the Odd pane', () => {
    const { view } = openPanel({ listOdd: () => ({ ok: true, docs: [] }) });
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /Odd/);
    assert.match(text, /no odd documents in this/);
    assert.match(text, /checkout/);
  });

  test('gh unavailable says so in the Issues pane and creation still works', () => {
    const { view, finished } = openPanel({
      initialName: 'new-change',
      fetchIssues: () => ({ ok: false, error: 'gh CLI is not available' }),
    });
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /gh unavailable/);
    assert.match(text, /not available/);
    view.handleInput('\x13');
    assert.deepEqual(finished, [{ ok: true, type: 'feat', name: 'new-change', issues: [], odd: [] }]);
  });

  test('an odd listing failure says so instead of an empty pane', () => {
    const { view } = openPanel({ listOdd: () => ({ ok: false, error: 'odd/tasks is unreadable' }) });
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /cannot list odd/);
    assert.match(text, /unreadable/);
  });

  test('a slow fetch renders a loading line and never blocks the frame', async () => {
    let resolveIssues;
    const pending = new Promise((resolve) => { resolveIssues = resolve; });
    const { view } = openPanel({ fetchIssues: () => pending });
    let text = allText(boxLines(view, 100, 24));
    assert.match(text, /loading open issues/);
    resolveIssues({ ok: true, issues: DEFAULT_ISSUES });
    await flush();
    text = allText(boxLines(view, 100, 24));
    assert.match(text, /#12 Crash on empty/);
    assert.ok(!text.includes('loading open issues'));
  });
});

describe('the pane filter (S6 rule)', { concurrency: false }, () => {
  test('T opens the filter, printable keys and space go to the text, enter keeps it', () => {
    const { view } = openPanel();
    focusIssues(view);
    view.handleInput('T');
    assert.equal(view.state.filterOpen, true, 'T opens the filter');
    assert.equal(view.state.queries.issues, '', 'the trigger key is not text');
    typeText(view, 'crash');
    assert.equal(view.state.queries.issues, 'crash');
    view.handleInput(' '); // space is text once the filter is open
    assert.equal(view.state.queries.issues, 'crash ', 'space goes to the filter text');
    assert.deepEqual(view.state.selectedIssues, [], 'space does not toggle while filtering');
    let text = allText(boxLines(view, 100, 24));
    assert.match(text, /#12 Crash on empty/);
    assert.ok(!text.includes('#7 Docs drift'), 'the filter narrows the list');
    assert.match(text, /filter:"crash "▊/);
    view.handleInput('enter');
    assert.equal(view.state.filterOpen, false, 'enter leaves the filter');
    assert.equal(view.state.queries.issues, 'crash ', 'the filter is kept');
    assert.ok(!allText(boxLines(view, 100, 24)).includes('#7 Docs drift'), 'the narrowed list stays narrowed');
    view.handleInput(' ');
    assert.deepEqual(view.state.selectedIssues, [12], 'space toggles again once the filter is closed');
  });

  test('a printable key opens the filter, esc leaves it keeping the text, and paging still works', () => {
    const { view } = openPanel({
      pageSize: 1,
      fetchIssues: () => ({ ok: true, issues: DEFAULT_ISSUES }),
    });
    focusIssues(view);
    view.handleInput('d');
    assert.equal(view.state.filterOpen, true, 'a printable key opens the filter');
    assert.equal(view.state.queries.issues, '', 'the opening key is consumed');
    typeText(view, 'docs');
    assert.equal(view.state.queries.issues, 'docs');
    view.handleInput('escape');
    assert.equal(view.state.filterOpen, false, 'esc leaves the filter');
    assert.equal(view.state.queries.issues, 'docs', 'esc keeps the filter');
    let text = allText(boxLines(view, 100, 24));
    assert.ok(text.includes('#7 Docs drift'));
    assert.ok(!text.includes('#12 Crash on empty'));
    // ↑/↓ keep navigating while the filter is open.
    view.handleInput('T');
    view.handleInput('down');
    assert.equal(view.state.cursor.issues, 0, 'a one-row filtered list clamps the cursor');
    text = allText(boxLines(view, 100, 24));
    assert.match(text, /no matches|#7 Docs drift/);
    view.handleInput('\x7f');
    view.handleInput('\x7f');
    view.handleInput('\x7f');
    view.handleInput('\x7f');
    assert.equal(view.state.queries.issues, '', 'backspace edits the filter text');
    text = allText(boxLines(view, 100, 24));
    assert.ok(text.includes('#12 Crash on empty'), 'clearing the filter restores every row');
  });
});

describe('selection and focus', { concurrency: false }, () => {
  test('space toggles the selection in both panes', () => {
    const { view, finished } = openPanel({ initialName: 'new-change' });
    focusIssues(view);
    view.handleInput(' ');
    assert.deepEqual(view.state.selectedIssues, [12]);
    assert.match(allText(boxLines(view, 100, 24)), /\[x\] #12 Crash on empty/);
    view.handleInput('\t');
    assert.equal(view.state.focus, 'odd', 'tab switches to the Odd pane');
    view.handleInput(' ');
    assert.deepEqual(view.state.selectedOdd, ['/odd/alpha.md']);
    assert.match(allText(boxLines(view, 100, 24)), /\[x\] alpha/);
    view.handleInput(' ');
    assert.deepEqual(view.state.selectedOdd, [], 'space toggles it back off');
    view.handleInput(' ');
    view.handleInput('\x13');
    assert.deepEqual(finished, [{
      ok: true,
      type: 'feat',
      name: 'new-change',
      issues: [12],
      odd: ['/odd/alpha.md'],
    }]);
  });

  test('tab switches between the Issues and Odd panes, never back a step', () => {
    const { view, finished } = openPanel();
    view.handleInput('\t');
    assert.equal(view.state.focus, 'issues', 'tab enters the Issues pane');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'odd');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'issues', 'tab toggles the two panes');
    assert.deepEqual(finished, [], 'tab never completes or cancels');
  });

  test('left/right move between fields off the type field', () => {
    const { view } = openPanel();
    focusIssues(view);
    view.handleInput('left');
    assert.equal(view.state.focus, 'name');
    view.handleInput('left');
    assert.equal(view.state.focus, 'type');
    view.handleInput('down');
    assert.equal(view.state.focus, 'name', 'down reaches the name field from the type field');
  });
});

describe('completion', { concurrency: false }, () => {
  test('enter on the last field creates with the whole payload', () => {
    const { view, finished } = openPanel();
    // type: pick `fix` through the sub-panel
    view.handleInput('enter');
    view.handleInput('down');
    view.handleInput('enter');
    typeText(view, 'new-change');
    view.handleInput('enter'); // name -> issues
    assert.equal(view.state.focus, 'issues');
    view.handleInput(' '); // select #12
    view.handleInput('enter'); // issues -> odd
    assert.equal(view.state.focus, 'odd');
    view.handleInput(' '); // select alpha
    view.handleInput('enter'); // last field -> create
    assert.deepEqual(finished, [{
      ok: true,
      type: 'fix',
      name: 'new-change',
      issues: [12],
      odd: ['/odd/alpha.md'],
    }]);
  });

  test('ctrl+s creates from any field, and fires exactly once', () => {
    const { view, finished } = openPanel({ cwd: REPO });
    focusName(view);
    typeText(view, 'new-change');
    view.handleInput('\x13');
    view.handleInput('\x13');
    assert.equal(finished.length, 1, 'completion fires exactly once');
    assert.deepEqual(finished[0], { ok: true, type: 'feat', name: 'new-change', issues: [], odd: [] });
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

  test('esc cancels the whole creation with null, exactly once', () => {
    const { view, finished } = openPanel();
    view.handleInput('escape');
    view.handleInput('escape');
    assert.deepEqual(finished, [null]);
  });

  test('esc unwinds the type sub-panel and the filter before cancelling', () => {
    const { view, finished } = openPanel();
    view.handleInput('enter');
    view.handleInput('escape');
    assert.equal(view.state.typePanelOpen, false);
    assert.deepEqual(finished, [], 'closing the sub-panel does not cancel the creation');
    focusIssues(view);
    view.handleInput('T');
    view.handleInput('escape');
    assert.equal(view.state.filterOpen, false);
    assert.deepEqual(finished, []);
    view.handleInput('escape');
    assert.deepEqual(finished, [null]);
  });

  test('? opens the key help and any other key closes it', () => {
    const { view } = openPanel();
    view.handleInput('?');
    assert.equal(view.state.help, true);
    let text = allText(boxLines(view, 100, 24));
    assert.match(text, /Ctrl\+S {2,}create/);
    assert.match(text, /\? {2,}close this help/);
    assert.match(text, /Tab {2,}switch between the Issues and Odd panes/);
    assert.match(text, /Space {2,}select the focused row/);
    assert.ok(!text.includes('#12 Crash on empty'), 'the help replaces the panes');
    view.handleInput('x');
    assert.equal(view.state.help, false);
    assert.match(allText(boxLines(view, 100, 24)), /#12 Crash on empty/);
  });
});

describe('the default wiring (real libraries, injected process seams)', { concurrency: false }, () => {
  test('issues and issue bodies come from lib/gh-issues.js', async () => {
    const seen = [];
    ghIssues.setGhRunner((bin, argv) => {
      seen.push(argv);
      if (argv[1] === 'list') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify([{
            number: 5,
            title: 'Fix the crash',
            state: 'OPEN',
            author: { login: 'ana' },
            labels: [],
            comments: [],
            reactionGroups: [],
            url: 'https://example.test/5',
          }]),
        };
      }
      if (argv[1] === 'view') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            number: 5,
            title: 'Fix the crash',
            state: 'OPEN',
            author: { login: 'ana' },
            comments: [],
            body: 'the complete body text',
          }),
        };
      }
      return { status: 1, stderr: 'unexpected', stdout: '' };
    });
    const { view } = openPanel({ fetchIssues: undefined, readIssuePreview: undefined, listOdd: () => ({ ok: true, docs: [] }) });
    await flush();
    view.handleInput('\t');
    await flush();
    const text = allText(boxLines(view, 100, 24));
    assert.match(text, /#5 Fix the crash/, 'the issue list comes from gh issue list');
    assert.match(text, /the complete body text/, 'the preview comes from gh issue view');
    const lists = seen.filter((argv) => argv[1] === 'list');
    assert.ok(lists.length >= 1, 'gh issue list ran');
    assert.deepEqual(lists[0].slice(0, 4), ['issue', 'list', '--state', 'open']);
    assert.ok(seen.some((argv) => argv[1] === 'view' && argv[2] === '5'), 'gh issue view 5 ran');
    ghIssues.setGhRunner(null);
  });

  test('odd documents come from lib/odd-docs.js and render through lib/odd-markdown.js', async () => {
    const root = scratchDir('checkout');
    fs.mkdirSync(path.join(root, 'odd', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'odd', 'tasks', 'alpha.md'), '# Alpha\n\nSome specs.\n', 'utf8');
    const git = {
      slugifyBranch: (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree',
      validateBranch: () => ({ ok: true, reason: null }),
      canonicalWorktreePath: (cwd, branch) => path.join(cwd, '..', 'checkout-worktrees', branch.replace(/\//g, '-')),
    };
    const { view } = openPanel({
      cwd: root,
      git,
      initialName: 'new-change',
      listOdd: undefined,
      readOddPreview: undefined,
      renderMarkdown: undefined,
      fetchIssues: () => ({ ok: true, issues: [] }),
    });
    await flush();
    view.handleInput('\t');
    view.handleInput('\t');
    await flush();
    const lines = boxLines(view, 100, 24);
    const text = allText(lines);
    assert.match(text, /alpha/, 'the document list comes from odd/tasks');
    assert.match(text, /▌ Alpha/, 'the document renders through the odd markdown renderer');
    assert.match(text, /Some specs\./);
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
      initialOdd: ['/odd/alpha.md'],
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
    assert.match(text, /\[x\] alpha/, 'the assigned odd document is pre-selected');
    assert.deepEqual(view.state.selectedIssues, [12]);
    assert.deepEqual(view.state.selectedOdd, ['/odd/alpha.md']);
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
    assert.deepEqual(finished, [{ ok: true, mode: 'edit', type: null, name: 'main', issues: [], odd: [] }]);
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
    // ← and → still move focus, but never cycle the frozen type.
    view.handleInput('left');
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

  test('an empty pre-selection stays empty and saving carries the empty sets', () => {
    const { view, finished } = editPanel({ initialIssues: [], initialOdd: [] });
    assert.deepEqual(view.state.selectedIssues, []);
    assert.deepEqual(view.state.selectedOdd, []);
    assert.ok(!allText(boxLines(view, 100, 24)).includes('[x]'));
    view.handleInput('\x13');
    assert.deepEqual(finished, [{ ok: true, mode: 'edit', type: 'feat', name: 'old-change', issues: [], odd: [] }]);
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
      initialOdd: ['/odd/beta.md'],
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
      ok: true, mode: 'edit', type: 'feat', name: 'old-change', issues: [3, 12], odd: ['/odd/beta.md'],
    }]);
  });

  test('a stored odd assignment named by its relative path still marks its document', () => {
    const { view, finished } = editPanel({ initialOdd: ['odd/tasks/alpha.md'] });
    assert.deepEqual(view.state.selectedOdd, ['odd/tasks/alpha.md'], 'the caller value is preserved');
    assert.match(allText(boxLines(view, 100, 24)), /\[x\] alpha/);
    view.handleInput('\x13');
    assert.deepEqual(finished[0].odd, ['odd/tasks/alpha.md']);
  });

  test('enter on the last field saves the edit with the mode marker', () => {
    const { view, finished } = editPanel({
      initialType: 'fix',
      branch: 'fix/old-change',
      initialIssues: [12],
      initialOdd: ['/odd/alpha.md'],
    });
    view.handleInput('\t'); // issues
    view.handleInput(' '); // toggle #12 off
    view.handleInput('enter'); // issues -> odd
    assert.equal(view.state.focus, 'odd');
    view.handleInput('enter'); // last field -> save
    assert.deepEqual(finished, [{
      ok: true, mode: 'edit', type: 'fix', name: 'old-change', issues: [], odd: ['/odd/alpha.md'],
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

  test('the filter, paging and the help still work while editing', () => {
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
    view.handleInput('?');
    assert.equal(view.state.help, true);
    assert.match(allText(boxLines(view, 100, 24)), /frozen/i);
    view.handleInput('x');
    assert.equal(view.state.help, false);
  });

  test('create mode keeps its editable fields, its sub-panel and its payload without a mode marker', () => {
    const { view, finished } = openPanel({ initialName: 'new-change' });
    view.handleInput('down');
    typeText(view, '-2');
    assert.equal(view.state.name, 'new-change-2', 'the create name is still editable');
    view.handleInput('right'); // -> issues
    assert.equal(view.state.focus, 'issues');
    view.handleInput('left'); // -> name
    view.handleInput('left'); // -> type
    view.handleInput('right');
    assert.equal(view.state.typeIndex, 1, '←/→ still cycle the type while creating');
    view.handleInput('\x13');
    assert.equal(finished.length, 1);
    assert.ok(!('mode' in finished[0]), 'a creation carries no mode marker');
    assert.deepEqual(Object.keys(finished[0]).sort(), ['issues', 'name', 'odd', 'ok', 'type']);
  });
});
