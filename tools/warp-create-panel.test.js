'use strict';
// T4 (worktree-ui-feedback S4,S12,S15): the worktree CREATION and EDITING
// panel.
//
// Creating is the TABBED bottom flow a human reported as still being a
// pop-up (S12), with the fields stacked together instead of tabbed (S7): a
// preview of the REAL derived branch and path ABOVE, then `Type` and `Name` as
// the two tabs of one strip, only the active field's content under them (the
// type tab holds the inline list, the name tab the text field). The preview
// stays BLANK (`-`) until both fields derive a real branch and path: an
// untouched form is not an error, so nothing in the preview is painted red or
// names a failure, while a refused submit still says exactly why.
// `tab`/`shift+tab`/`←`/`→` move between the two tabs and `↑`/`↓` pick the
// type; `enter` on the name creates. Only type and name exist: no Issues/Odd
// selector, no association, no step counter. The component derives its own
// compact content height (the host mounts it at the bottom), so a wrapped
// surface never leaves slack rows. The Issues/Odd association panes, their
// selection state and their previews are NOT part of this surface; they
// survive only in the panel's editing mode, which the editing tests below
// still drive. Every test renders headlessly and asserts that every line is
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

// S12: the create surface derives its own height, so the assertion is the
// width of every line plus "no filler below the closing rule" instead of a
// fixed frame size.
function renderedLines(view, width) {
  const lines = view.render(width);
  assert.ok(lines.length > 0, 'the panel renders something');
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
// Creating moves between its two fields with Tab/←/→ (S12), so this helper
// uses the same key; the editing header keeps its own ↓ between fields.
function focusName(view) {
  view.handleInput('\t'); // type -> name
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
  test('shows the preview above the Type|Name tabs, with only the active field under them', () => {
    const { view } = openPanel({ initialName: 'new-change' });
    const lines = renderedLines(view, 100);
    const text = allText(lines);
    const at = (needle) => lines.findIndex((line) => stripAnsi(line).includes(needle));
    assert.match(text, /Type · Name/, 'the two fields are TABS, not two stacked rows (S7)');
    assert.match(text, /Type: Feature \(feat\)/, 'the conventional type with its human label');
    assert.ok(!text.includes('Name:'), 'only the ACTIVE tab renders its field under the strip');
    findLine(lines, 'preview branch: feat/new-change');
    findLine(lines, `preview path: ${path.join(path.dirname(REPO), `${path.basename(REPO)}-worktrees`, 'feat-new-change')}`);
    assert.ok(at('preview branch:') < at('Type · Name'), 'the preview sits ABOVE the tabs');
    assert.ok(at('preview path:') < at('Type · Name'), 'both preview rows sit above the tabs');
    assert.ok(at('Type · Name') < at('Type: Feature'), 'the active field sits UNDER its tab strip');
    for (const type of panel.CHANGE_TYPES) {
      assert.ok(text.includes(`${type.label} (${type.id})`), `the type list is inline: ${type.id}`);
    }
    assert.ok(!text.includes('Step 1 of 2'), 'no step counter: the surface is the two fields');
    assert.ok(!text.includes('Step 2 of 2'), 'no step counter on the name either');
    assert.ok(!text.includes('Choose the change type'), 'the type is a list in place, not a second pop-up surface');
    assert.match(text, /↑\/↓ type/, 'the footer names the type-selection keys');
    assert.match(text, /Enter confirm/, 'the footer names the confirm key');
    assert.match(text, /Ctrl\+S create/, 'the keys footer names ctrl+s');
    assert.match(text, /Esc cancel/, 'the keys footer names esc');
    assert.ok(!text.includes('? help'), 'the footer never advertises a help key');
    // The Name tab is the name field alone: the type row and its list belong
    // to the other tab and are not rendered under this one.
    view.handleInput('\t');
    const nameTab = allText(renderedLines(view, 100));
    assert.match(nameTab, /Type · Name/, 'the tab strip stays visible');
    assert.match(nameTab, /Name: new-change/, 'the Name tab renders the name field');
    assert.ok(!nameTab.includes('Type: Feature'), 'the Type field belongs to the Type tab');
    assert.ok(!nameTab.includes('Bug fix (fix)'), 'the inline type list is not shown under the Name tab');
  });

  test('every line is exactly the requested width and the surface ends at its own content', () => {
    for (const [width, height] of [[40, 24], [60, 24], [80, 24], [100, 24], [120, 40]]) {
      const { view } = openPanel({ rowsAvailable: () => height });
      const lines = renderedLines(view, width);
      assert.ok(lines.length <= height, `${width}x${height}: the surface never exceeds the host budget`);
      assert.ok(lines.length < height, `${width}x${height}: it derives its own height instead of filling the host rows`);
      assert.match(stripAnsi(lines[lines.length - 1]), /^─+$/, `${width}x${height}: the closing rule is the last row`);
    }
    // A short host windows the inline type list to the rows left over and
    // still ends on its closing rule: no filler rows above or below.
    const short = openPanel({ rowsAvailable: () => 18 });
    const lines = renderedLines(short.view, 80);
    assert.equal(lines.length, 18, 'a short host is filled exactly, never overflowed');
    assert.match(stripAnsi(lines[lines.length - 1]), /^─+$/);
    assert.ok(!allText(lines).includes('Revert (revert)'), 'the type list windows around the selection');
  });

  test('a host too short for the two fields says so in one line instead of overflowing', () => {
    const { view } = openPanel({ rowsAvailable: () => 6 });
    const lines = renderedLines(view, 60);
    assert.equal(lines.length, 1, 'one honest row, never more than the host offers');
    assert.match(stripAnsi(lines[0]), /New worktree .* enlarge the terminal/);
    assert.equal(view.render(0).length, 0, 'a hostile width renders nothing');
    // A refusal adds a row, so the same guard covers the tightest host that
    // fits the fixed form plus its message.
    const refused = openPanel({ rowsAvailable: () => 8 });
    refused.view.handleInput('\x13');
    const tight = renderedLines(refused.view, 60);
    assert.equal(tight.length, 1, 'the refusal never overflows a too-short host');
  });

  test('typing the name moves the branch and path preview live, character by character', () => {
    const { view } = openPanel();
    focusName(view);
    typeText(view, 'new');
    let lines = renderedLines(view, 100);
    assert.match(findLine(lines, 'preview branch:').trim(), /feat\/new$/);
    typeText(view, '-change');
    lines = renderedLines(view, 100);
    findLine(lines, 'preview branch: feat/new-change');
    findLine(lines, 'preview path:');
    const preview = findLine(lines, 'preview path:');
    assert.ok(preview.includes('feat-new-change'), 'the path follows the typed name');
    assert.match(findLine(lines, 'Name:'), /Name: new-change▊/);
  });

  test('an incomplete form leaves the preview blank and neutral, never red (S7)', () => {
    const { view, finished } = openPanel();
    const lines = renderedLines(view, 100);
    assert.equal(findLine(lines, 'preview branch:').trim(), 'preview branch: -', 'an empty name previews nothing yet');
    assert.equal(findLine(lines, 'preview path:').trim(), 'preview path: -');
    const text = allText(lines);
    for (const noise of ['✗', 'name is empty', 'not derived', 'invalid', 'cannot create']) {
      assert.ok(!text.includes(noise), `the untouched preview carries no ${JSON.stringify(noise)}\n${text}`);
    }
    assert.ok(!text.includes('feat/worktree'), 'no fake branch is derived from an empty name');
    // A name with nothing slug-worthy is refused on SUBMIT, not painted into
    // the preview while the user is still typing.
    focusName(view);
    typeText(view, '!!!');
    const typed = renderedLines(view, 100);
    assert.equal(findLine(typed, 'preview branch:').trim(), 'preview branch: -', 'an underivable name stays blank');
    assert.equal(findLine(typed, 'preview path:').trim(), 'preview path: -');
    view.handleInput('\x13');
    assert.deepEqual(finished, [], 'an invalid name still never creates');
    assert.match(allText(renderedLines(view, 100)), /cannot create: name has no letters or digits/);
  });

  test('a git refusal is refused honestly on submit and never painted into the preview', () => {
    const git = {
      slugifyBranch: () => '-bad',
      validateBranch: (branch) => ({ ok: false, reason: `invalid branch name: ${branch}` }),
      canonicalWorktreePath: () => '/nowhere',
    };
    const { view, finished } = openPanel({ git, initialName: 'x' });
    assert.equal(
      findLine(renderedLines(view, 100), 'preview branch:').trim(),
      'preview branch: -',
      'an underivable branch stays blank instead of going red',
    );
    view.handleInput('\x13');
    assert.deepEqual(finished, [], 'the refusal creates nothing');
    assert.match(allText(renderedLines(view, 100)), /cannot create: invalid branch name: feat\/-bad/);
  });

  test('the name field renders a real placeholder and a cursor, and never treats the placeholder as the value', () => {
    const { view, finished } = openPanel();
    focusName(view);
    let text = allText(renderedLines(view, 100));
    assert.match(text, /Name: ▊name-change/, 'the placeholder is ghost text after the caret');
    view.handleInput('n');
    text = allText(renderedLines(view, 100));
    assert.match(text, /Name: n▊/, 'the typed value replaces the ghost text');
    assert.ok(!text.includes('name-change'), 'the placeholder disappears once there is a value');
    // The placeholder is not a name: creating from it is refused.
    view.handleInput('\x7f');
    view.handleInput('\x13');
    assert.deepEqual(finished, [], 'a ghost placeholder never creates anything');
    assert.match(allText(renderedLines(view, 100)), /cannot create: name is empty/);
  });
});

describe('the type field', { concurrency: false }, () => {
  test('↑/↓ move the type selection in place and the preview follows live', () => {
    const { view } = openPanel({ initialName: 'new-change' });
    assert.equal(view.state.typeIndex, 0);
    view.handleInput('\x1b[B'); // down
    assert.equal(view.state.typeIndex, 1);
    assert.equal(view.state.focus, 'type', 'picking a type never leaves the list');
    assert.match(allText(renderedLines(view, 100)), /Type: Bug fix \(fix\)/);
    assert.match(findLine(renderedLines(view, 100), 'preview branch:').trim(), /^preview branch: fix\/new-change$/);
    assert.match(stripAnsi(renderedLines(view, 100).find((line) => stripAnsi(line).includes('Bug fix') && stripAnsi(line).includes('❯ '))), /Bug fix \(fix\)/, 'the selected row carries the marker');
    view.handleInput('\x1b[A'); // up
    assert.equal(view.state.typeIndex, 0);
    view.handleInput('\x1b[A');
    assert.equal(view.state.typeIndex, 0, 'the first type is a clamp');
    for (let i = 0; i < panel.CHANGE_TYPES.length + 3; i += 1) view.handleInput('\x1b[B');
    assert.equal(view.state.typeIndex, panel.CHANGE_TYPES.length - 1, 'the last type is a clamp');
  });

  test('a printable key on the type field starts the name instead of typing into a list', () => {
    const { view } = openPanel();
    view.handleInput('n');
    assert.equal(view.state.focus, 'name', 'the typed character moves to the name field');
    assert.equal(view.state.name, 'n', 'and is kept as its first character');
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
    const branch = findLine(renderedLines(view, 100), 'preview branch:').trim().replace('preview branch: ', '');
    assert.ok(branchRe.test(branch), `${branch} must match the skill's <type>/<slug> shape`);
  });
});

// S12: creating a worktree asks for exactly TWO things — the change type and
// the change name — and then creates it. The Issues/Odd association panes,
// their selection state, their keys and their previews belong to no part of
// this surface any more.
describe('S12: two fields, nothing else', { concurrency: false }, () => {
  test('the panel has no Issues pane, no Odd pane, no pane tab and no preview column', () => {
    const { view } = openPanel({ initialName: 'new-change' });
    const text = allText(renderedLines(view, 120));
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
    assert.deepEqual(Object.keys(view.state).sort(), ['focus', 'message', 'name', 'typeIndex']);
  });

  test('tab, shift+tab, ← and → move between the type list and the name field', () => {
    const { view, finished } = openPanel({ initialName: 'new-change' });
    assert.equal(view.state.focus, 'type');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'name', 'tab reaches the name');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'type', 'tab returns to the type');
    view.handleInput('\x1b[C'); // right
    assert.equal(view.state.focus, 'name', '→ reaches the name');
    view.handleInput('\x1b[D'); // left
    assert.equal(view.state.focus, 'type', '← returns to the type');
    view.handleInput('\x1b[D');
    assert.equal(view.state.focus, 'name', '← at the first field wraps to the name');
    view.handleInput('\x1b[C');
    assert.equal(view.state.focus, 'type', '→ at the last field wraps to the type');
    view.handleInput('\x1b[Z'); // shift+tab
    assert.equal(view.state.focus, 'name', 'shift+tab walks the fields back');
    assert.deepEqual(finished, [], 'moving between fields never completes or cancels');
  });

  test('the two-field flow creates with the chosen type and name', () => {
    const { view, finished } = openPanel();
    let text = allText(renderedLines(view, 100));
    assert.ok(!text.includes('cannot create'), 'nothing has been refused yet');
    view.handleInput('\x1b[B'); // pick the second type
    text = allText(renderedLines(view, 100));
    assert.match(text, /Type: Bug fix \(fix\)/, 'the Type tab shows the picked type');
    assert.deepEqual(finished, [], 'picking the type creates nothing yet');
    view.handleInput('\t'); // reach the name
    assert.equal(view.state.focus, 'name', 'tab hands the flow to the name');
    text = allText(renderedLines(view, 100));
    assert.match(text, /Name: ▊/, 'the Name tab renders the name field');
    typeText(view, 'panel-change');
    assert.deepEqual(finished, [], 'typing the name creates nothing yet');
    view.handleInput('enter'); // confirm
    assert.deepEqual(finished, [{ ok: true, type: 'fix', name: 'panel-change' }]);
  });

  test('enter on the type field reaches the name without creating', () => {
    const { view, finished } = openPanel();
    view.handleInput('enter');
    assert.equal(view.state.focus, 'name');
    assert.deepEqual(finished, [], 'enter on the type only moves the flow on');
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
    focusName(view);
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
    assert.match(allText(renderedLines(view, 100)), /cannot create: name is empty/);
    focusName(view);
    typeText(view, 'new-change');
    assert.ok(!allText(renderedLines(view, 100)).includes('cannot create'), 'fixing the name clears the refusal');
    view.handleInput('\x13');
    assert.equal(finished.length, 1);
  });

  test('enter on an invalid name refuses with the same message instead of creating', () => {
    const { view, finished } = openPanel({ initialName: '!!!' });
    focusName(view);
    view.handleInput('enter');
    assert.deepEqual(finished, [], 'nothing is created');
    assert.match(allText(renderedLines(view, 100)), /cannot create: name has no letters or digits/);
  });

  test('cancel writes nothing and emits null exactly once, from either field', () => {
    const fromType = openPanel();
    fromType.view.handleInput('escape');
    fromType.view.handleInput('escape');
    assert.deepEqual(fromType.finished, [null]);

    const fromName = openPanel({ initialName: 'typed-but-discarded' });
    focusName(fromName.view);
    typeText(fromName.view, '-more');
    fromName.view.handleInput('escape');
    assert.deepEqual(fromName.finished, [null], 'a typed name is discarded, never created');
  });

  test('there is no key-help overlay: the footer already carries every shortcut', () => {
    const { view } = openPanel();
    view.handleInput('?');
    const after = allText(renderedLines(view, 100));
    assert.ok(!after.includes('close this help'), 'no key list replaces the content');
    assert.ok(!after.includes('? help'), 'the footer never advertises a help key');
    assert.equal('help' in view.state, false, 'the surface keeps no help overlay state');
    assert.match(after, /Enter confirm/);
    assert.match(after, /Ctrl\+S create/);
    assert.match(after, /Esc cancel/);
  });
});

describe('the create panel never reads the issue or odd libraries (S6)', { concurrency: false }, () => {
  test('no gh call and no odd document is listed or read with the real libraries in place', async () => {
    const seen = [];
    ghIssues.setGhRunner((_bin, argv) => {
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
      const text = allText(renderedLines(view, 100));
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

  test('the type picker never opens in editing mode', () => {
    const { view } = editPanel();
    view.handleInput('enter');
    assert.equal('typePanelOpen' in view.state, false, 'the edit surface keeps no type-picker state');
    const text = allText(boxLines(view, 100, 24));
    assert.ok(!text.includes('Choose the change type'));
    assert.ok(!text.includes('Bug fix (fix)'), 'no inline type list on the frozen surface');
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

  test('create mode keeps both editable fields and its two-field navigation, and its payload carries no mode marker', () => {
    const { view, finished } = openPanel({ initialName: 'new-change' });
    focusName(view);
    typeText(view, '-2');
    assert.equal(view.state.name, 'new-change-2', 'the create name is still editable');
    view.handleInput('down'); // S12: nothing sits below the name while creating
    assert.equal(view.state.focus, 'name');
    view.handleInput('up'); // -> type
    assert.equal(view.state.focus, 'type');
    view.handleInput('down');
    assert.equal(view.state.typeIndex, 1, '↑/↓ pick the type in place');
    view.handleInput('\t');
    assert.equal(view.state.focus, 'name', 'tab still moves to the name');
    view.handleInput('\x13');
    assert.equal(finished.length, 1);
    assert.ok(!('mode' in finished[0]), 'a creation carries no mode marker');
    assert.deepEqual(Object.keys(finished[0]).sort(), ['name', 'ok', 'type']);
  });
});

// S7: the creation surface is TABBED like the worktree editor — a `Type ·
// Name` strip with only the active field's content under it — and its preview
// stays blank until both fields derive a real branch and path. An untouched
// form is not an error: nothing in the preview is painted red or names a
// failure, while a refused submit still says exactly why.
describe('S7: Type|Name tabs and a neutral preview', { concurrency: false }, () => {
  // A theme that records every role it is asked to paint, so "is it red?" is
  // a fact about the painted output instead of a guess about copy.
  function recordingPanel(overrides = {}) {
    const roles = [];
    const theme = {
      fg: (role, text) => { roles.push(role); return text; },
      bold: (text) => text,
    };
    return { roles, ...openPanel({ theme, ...overrides }) };
  }

  test('nothing in the preview is red or error copy until an actual submit is refused', () => {
    const { view, roles } = recordingPanel();
    renderedLines(view, 100);
    assert.ok(!roles.includes('error'), `an untouched form paints no error role\n${roles.join(',')}`);
    const text = allText(renderedLines(view, 100));
    assert.ok(!text.includes('✗'), 'no error glyph in the preview');
    assert.equal(findLine(renderedLines(view, 100), 'preview branch:').trim(), 'preview branch: -');
    assert.equal(findLine(renderedLines(view, 100), 'preview path:').trim(), 'preview path: -');
    // Half-filled is still neutral: a picked type with no name is not an error.
    view.handleInput('\x1b[B');
    renderedLines(view, 100);
    assert.ok(!roles.includes('error'), 'a picked type alone is not an error');
    // The refusal appears only after the user actually asks to create.
    view.handleInput('\x13');
    const refused = renderedLines(view, 100);
    assert.ok(roles.includes('error'), 'a refused submit is painted as an error');
    assert.match(allText(refused), /cannot create: name is empty/);
  });

  test('the tabs hold one field each and keep both values while switching', () => {
    const { view } = openPanel();
    view.handleInput('\x1b[B'); // type: Bug fix
    view.handleInput('\t'); // -> Name tab
    typeText(view, 'tab-change');
    let text = allText(renderedLines(view, 100));
    assert.match(text, /Name: tab-change▊/);
    assert.ok(!text.includes('Bug fix (fix)'), 'the type list belongs to the Type tab');
    view.handleInput('\x1b[Z'); // shift+tab back to Type
    text = allText(renderedLines(view, 100));
    assert.match(text, /Type: Bug fix \(fix\)/, 'the picked type survived the round trip');
    assert.ok(!text.includes('Name:'), 'the name field is not rendered under the Type tab');
    view.handleInput('\x1b[C'); // -> back to the name
    assert.equal(view.state.name, 'tab-change', 'the typed name survived too');
    assert.match(allText(renderedLines(view, 100)), /Name: tab-change/);
    view.handleInput('\x1b[D'); // -> Type
    text = allText(renderedLines(view, 100));
    for (const type of panel.CHANGE_TYPES) {
      assert.ok(text.includes(`${type.label} (${type.id})`), `the type list is whole: ${type.id}`);
    }
    assert.match(findLine(renderedLines(view, 100), 'preview branch:').trim(), /^preview branch: fix\/tab-change$/);
  });

  test('a valid type and name preview the exact branch and path', () => {
    const { view } = openPanel({ initialType: 'fix', initialName: 'new-change' });
    const lines = renderedLines(view, 100);
    findLine(lines, 'preview branch: fix/new-change');
    const expected = path.join(path.dirname(REPO), `${path.basename(REPO)}-worktrees`, 'fix-new-change');
    findLine(lines, `preview path: ${expected}`);
    assert.ok(!allText(lines).includes('preview branch: -'), 'a derived branch replaces the blank preview');
  });

  test('cancel writes nothing and a confirmed creation fires exactly once', () => {
    const cancelled = openPanel();
    focusName(cancelled.view);
    typeText(cancelled.view, 'discarded');
    cancelled.view.handleInput('escape');
    cancelled.view.handleInput('escape');
    assert.deepEqual(cancelled.finished, [null], 'cancel emits null exactly once and nothing else');
    assert.ok(!cancelled.finished.some((value) => value && value.ok === true), 'cancel never creates');

    const confirmed = openPanel();
    focusName(confirmed.view);
    typeText(confirmed.view, 'new-change');
    confirmed.view.handleInput('enter');
    confirmed.view.handleInput('enter');
    confirmed.view.handleInput('\x13');
    assert.deepEqual(
      confirmed.finished,
      [{ ok: true, type: 'feat', name: 'new-change' }],
      'one creation, never a duplicate',
    );
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
      const lines = renderedLines(view, width);
      const legend = legendRows(lines, LEGEND);
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /confirm/, `width ${width}: the confirm key survives`);
      assert.match(legend[0], /Esc cancel/, `width ${width}: the cancel key survives`);
      assert.ok(!legend[0].includes('Step'), `width ${width}: no step counter rides the footer`);
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
