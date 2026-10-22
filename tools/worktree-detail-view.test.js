'use strict';
// T6/T10 (worktree-ui-redesign S7, S7a, S7b, S7c, S8, S11, S12) tests:
// lib/worktree-detail-view.js — the pure full-screen worktree detail
// component (worktree header, Issues/ODD tabs, list on the left, preview on
// the right).
//
// Contract under test, as observable output only: the component fills the
// requested width and exactly the available rows; the header carries the
// name, path and facts once; both tabs switch and only open issues are
// listed with assigned first and descending numbers; space toggles an issue
// assignment while keeping every other one; the ODD tab selects exactly ONE
// document and never an array; the preview is a separate pane that scrolls
// without moving the list; `ctrl+s` saves with truthful pending/failure
// states that leave the local selection untouched; `esc` closes with null;
// empty/loading/error states are honest; the footer legend is ONE row at
// every width; and the module requires nothing but the markdown renderer
// (no filesystem, network or registry access).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createWorktreeDetailView } = require('../lib/worktree-detail-view.js');

// Optional real host helpers, guarded exactly like tools/odd-view.test.js:
// CI installs no dependencies, so the byte-level key assertions run only
// when the installed matcher resolves and skip honestly when it does not.
let realTui = null;
try {
  realTui = require('@earendil-works/pi-tui');
} catch {
  realTui = null;
}

function strip(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

const helpers = {
  visibleWidth: (text) => [...strip(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

const realHelpers = realTui
  ? { ...helpers, matchesKey: realTui.matchesKey, isKeyRelease: realTui.isKeyRelease }
  : null;

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text) };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const WORKTREE = {
  name: 'add-warp-panel',
  path: '/repo/worktrees/w1',
  branch: 'feat/w1',
  changes: 3,
  ahead: 2,
  behind: 1,
  created: '1d',
  modified: '2hr',
};

function issue(number, overrides = {}) {
  return {
    number,
    title: `issue title ${number}`,
    state: 'open',
    author: 'octo',
    labels: [{ name: 'bug' }],
    body: `body of issue ${number}`,
    ...overrides,
  };
}

function document(name, overrides = {}) {
  return { name, path: `/repo/worktrees/w1/odd/tasks/${name}.md`, ...overrides };
}

function makeView(opts = {}) {
  const paints = [];
  let settled = 'pending';
  const view = createWorktreeDetailView({
    worktree: opts.worktree || WORKTREE,
    issues: opts.issues || [],
    assignedIssues: opts.assignedIssues || [],
    documents: opts.documents || [],
    odd: opts.odd === undefined ? null : opts.odd,
    loadIssue: opts.loadIssue,
    loadDocument: opts.loadDocument,
    save: opts.save,
    helpers: opts.helpers || helpers,
    theme: plainTheme,
    rowsAvailable: () => (opts.rows === undefined ? 24 : opts.rows),
    requestRender: () => { paints.push(true); },
    done: (result) => { settled = result; },
  });
  return { view, done: () => settled, paints };
}

// A promise whose settlement the test owns, so no expectation depends on
// wall-clock timing.
function deferred() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function saveSpy(result) {
  const calls = [];
  const fn = (payload) => {
    calls.push({ issues: payload.issues.slice(), odd: payload.odd });
    return typeof result === 'function' ? result(payload) : result;
  };
  fn.calls = calls;
  return fn;
}

function lines(view, width = 100) {
  return view.render(width);
}

// The frame is `│ <left> │ <right> │`, so field 1 is the list pane and
// field 2 the preview pane; rows without a divider yield an empty string.
function pane(rendered, index) {
  return rendered.map((line) => strip(line).split('│')[index] ?? '').join('\n');
}
const leftOf = (rendered) => pane(rendered, 1);
const rightOf = (rendered) => pane(rendered, 2);

function issueNumbers(text) {
  return [...String(text).matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function assertExactFrame(rendered, width, rows) {
  assert.equal(rendered.length, rows, `expected ${rows} rows, got ${rendered.length}`);
  for (const line of rendered) {
    assert.equal(helpers.visibleWidth(line), width, `not ${width} wide: "${strip(line)}"`);
  }
}

describe('worktree detail dimensions', () => {
  test('fills the terminal exactly at every supported width', () => {
    const { view } = makeView({
      issues: [issue(12), issue(7), issue(5)],
      assignedIssues: [7],
      documents: [document('alpha'), document('beta')],
    });
    for (const width of [40, 60, 80, 120]) {
      assertExactFrame(view.render(width), width, 24);
    }
  });

  test('degrades without overflowing a narrow terminal', () => {
    const { view } = makeView({ issues: [issue(12)], documents: [document('alpha')] });
    for (const width of [6, 10, 20]) {
      for (const rows of [5, 8, 24]) {
        const narrow = makeView({ issues: [issue(12)], rows });
        assertExactFrame(narrow.view.render(width), width, rows);
      }
      assertExactFrame(view.render(width), width, 24);
    }
  });

  test('uses every available row at small heights', () => {
    for (const rows of [1, 2, 3, 4, 5, 6, 7, 8, 12]) {
      const { view } = makeView({ issues: [issue(12)], rows });
      assertExactFrame(view.render(60), 60, rows);
    }
  });
});

describe('worktree detail header and tabs', () => {
  test('names the worktree, its path and its facts exactly once', () => {
    const { view } = makeView({ issues: [issue(12)], documents: [document('alpha')] });
    const body = strip(lines(view).join('\n'));
    assert.equal((body.match(/add-warp-panel/g) || []).length, 1, 'the name is not repeated');
    assert.match(body, /\/repo\/worktrees\/w1/);
    assert.match(body, /branch feat\/w1/);
    assert.match(body, /3 changes/);
    assert.match(body, /↑2 ↓1/);
    assert.match(body, /created 1d/);
    assert.match(body, /modified 2hr/);
    assert.equal((body.match(/Issues \(/g) || []).length, 1, 'the issue count is not repeated');
  });

  test('tab and shift+tab switch between Issues and ODD', () => {
    const { view } = makeView({
      issues: [issue(12), issue(7)],
      documents: [document('alpha'), document('beta')],
    });
    let body = strip(lines(view).join('\n'));
    assert.match(body, /▸ Issues \(2\)/);
    assert.match(body, /ODD \(2\)/);

    view.handleInput('tab');
    assert.equal(view.state.tab, 'odd');
    body = strip(lines(view).join('\n'));
    assert.match(body, /Issues \(2\)/);
    assert.match(body, /▸ ODD \(2\)/);
    assert.match(leftOf(lines(view)), /alpha/);

    view.handleInput('shift+tab');
    assert.equal(view.state.tab, 'issues');
    assert.match(strip(lines(view).join('\n')), /▸ Issues \(2\)/);
  });

  test('does not fabricate ages the caller never supplied', () => {
    const { view } = makeView({
      worktree: { name: 'w', path: '/repo/w', branch: 'main' },
      issues: [issue(4)],
    });
    const body = strip(lines(view).join('\n'));
    assert.doesNotMatch(body, /created/);
    assert.doesNotMatch(body, /modified/);
    assert.match(body, /branch main/);
  });

  test('derives a relative age when the caller supplies a timestamp', () => {
    const { view } = makeView({
      worktree: { name: 'w', path: '/repo/w', created: Date.now() - 3 * 3600_000 },
      issues: [issue(4)],
    });
    assert.match(strip(lines(view).join('\n')), /created 3hr/);
  });
});

describe('issues tab listing', () => {
  test('lists only open issues, assigned first then descending number', () => {
    const { view } = makeView({
      issues: [issue(2), issue(9, { state: 'closed' }), issue(5), issue(12), issue(7)],
      assignedIssues: [5, 9],
    });
    const left = leftOf(lines(view));
    assert.deepEqual(issueNumbers(left), [5, 12, 7, 2]);
    assert.doesNotMatch(strip(lines(view).join('\n')), /#9\b/);
    assert.match(strip(lines(view).join('\n')), /Issues \(4\)/);
    // S7d: an assigned issue that is closed is dropped from the selection.
    assert.deepEqual(view.state.issues, [5]);
  });

  test('space toggles one assignment and keeps every selected issue', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({
      issues: [issue(3), issue(8), issue(11)],
      assignedIssues: [],
      save,
    });
    assert.deepEqual(issueNumbers(leftOf(lines(view))), [11, 8, 3]);

    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('space');
    let left = leftOf(lines(view));
    assert.deepEqual(issueNumbers(left), [3, 11, 8], 'the assigned issue moves to the front');
    assert.match(left, /▸ \[x\] #3/);

    view.handleInput('down');
    view.handleInput('space');
    left = leftOf(lines(view));
    assert.deepEqual(issueNumbers(left), [11, 3, 8]);
    assert.deepEqual(view.state.issues.slice().sort((a, b) => a - b), [3, 11]);

    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [3, 11], odd: null });
  });

  test('toggling the same issue twice removes it again', () => {
    const { view } = makeView({ issues: [issue(4)], assignedIssues: [4] });
    view.handleInput('space');
    assert.deepEqual(view.state.issues, []);
    assert.match(leftOf(lines(view)), /▸ \[ \] #4/);
  });

  test('preview shows the focused issue while j/k move the list', () => {
    const { view } = makeView({
      issues: [issue(12), issue(7)],
      loadIssue: (number) => ({ ok: true, issue: issue(number), comments: [] }),
    });
    let right = rightOf(lines(view));
    assert.match(right, /#12 issue title 12/);
    view.handleInput('j');
    right = rightOf(lines(view));
    assert.match(right, /#7 issue title 7/);
    assert.match(leftOf(lines(view)), /#12/);
  });
});

describe('odd tab selection', () => {
  test('lists every document and selects exactly one, never a list', () => {
    const save = saveSpy({ ok: true });
    const documents = [
      document('alpha', { text: '# Alpha' }),
      document('beta', { text: '# Beta' }),
      document('gamma', { text: '# Gamma' }),
    ];
    const { view } = makeView({
      documents,
      odd: '/repo/worktrees/w1/odd/tasks/alpha.md',
      save,
    });
    view.handleInput('tab');
    let left = leftOf(lines(view));
    assert.match(left, /▸ ● alpha/);
    assert.match(left, /○ beta/);
    assert.match(left, /○ gamma/);

    view.handleInput('down');
    view.handleInput('space');
    assert.equal(view.state.odd, '/repo/worktrees/w1/odd/tasks/beta.md');
    assert.equal(Array.isArray(view.state.odd), false);
    left = leftOf(lines(view));
    assert.match(left, /▸ ● beta/);
    assert.match(left, /○ alpha/);

    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [], odd: '/repo/worktrees/w1/odd/tasks/beta.md' });

    // Enter selects (never clears) ...
    view.handleInput('down');
    view.handleInput('enter');
    assert.equal(view.state.odd, '/repo/worktrees/w1/odd/tasks/gamma.md');
    view.handleInput('enter');
    assert.equal(view.state.odd, '/repo/worktrees/w1/odd/tasks/gamma.md');

    // ... while space on the selected document clears the association.
    view.handleInput('space');
    assert.equal(view.state.odd, null);
    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [], odd: null });
  });

  test('preview renders the focused document through the markdown renderer', async () => {
    const { view } = makeView({
      documents: [{ name: 'slow', path: '/repo/worktrees/w1/odd/tasks/slow.md' }],
      loadDocument: () => ({ ok: true, text: '# Heading\n\n- bullet one' }),
    });
    view.handleInput('tab');
    await tick();
    const right = rightOf(lines(view));
    assert.match(right, /▌ Heading/);
    assert.match(right, /• bullet one/);
  });

  test('an unreadable document reports the failure', async () => {
    const { view } = makeView({
      documents: [{ name: 'broken', path: '/repo/worktrees/w1/odd/tasks/broken.md' }],
      loadDocument: () => ({ ok: false, error: 'EACCES' }),
    });
    view.handleInput('tab');
    await tick();
    assert.match(rightOf(lines(view)), /unreadable: EACCES/);
  });
});

describe('preview scrolling', () => {
  const longText = Array.from({ length: 40 }, (_unused, at) => `- item ${String(at + 1).padStart(2, '0')}`).join('\n');

  function scrollingView(opts = {}) {
    return makeView({
      rows: 12,
      documents: [
        document('alpha', { text: longText }),
        document('beta', { text: longText }),
      ],
      ...opts,
    });
  }

  test('ctrl+j, ctrl+d, J and pageup scroll the preview, not the list', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    let right = rightOf(lines(view));
    assert.match(right, /• item 01/);
    assert.doesNotMatch(right, /• item 07/);

    view.handleInput('ctrl+j');
    right = rightOf(lines(view));
    assert.match(right, /• item 06/);
    assert.doesNotMatch(right, /• item 01/);
    assert.match(leftOf(lines(view)), /▸ ○ alpha/, 'the list cursor stays put');

    view.handleInput('ctrl+d');
    assert.match(rightOf(lines(view)), /• item 08/);

    view.handleInput('J');
    assert.match(rightOf(lines(view)), /• item 10/);

    view.handleInput('pageup');
    assert.match(rightOf(lines(view)), /• item 05/);

    view.handleInput('ctrl+u');
    assert.match(rightOf(lines(view)), /• item 03/);
  });

  test('lowercase j moves the list and resets the preview', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    view.handleInput('ctrl+j');
    assert.doesNotMatch(rightOf(lines(view)), /• item 01/);
    view.handleInput('j');
    const right = rightOf(lines(view));
    assert.match(right, /• item 01/);
    assert.match(leftOf(lines(view)), /▸ ○ beta/);
  });

  test('ctrl+k and K scroll back up', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    view.handleInput('ctrl+j');
    view.handleInput('ctrl+k');
    assert.match(rightOf(lines(view)), /• item 01/);
    view.handleInput('ctrl+j');
    view.handleInput('K');
    assert.match(rightOf(lines(view)), /• item 04/);
  });

  test('the real host bytes for ctrl+j scroll the preview', { skip: !realHelpers }, () => {
    const { view } = makeView({
      rows: 12,
      helpers: realHelpers,
      documents: [document('alpha', { text: longText })],
    });
    view.handleInput('tab');
    assert.match(rightOf(lines(view)), /• item 01/);
    view.handleInput('\n');
    assert.match(rightOf(lines(view)), /• item 06/);
  });
});

describe('saving', () => {
  test('ctrl+s sends the current selection and reports success', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({ issues: [issue(5), issue(9)], save });
    view.handleInput('space');
    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [9], odd: null });
    const body = strip(lines(view).join('\n'));
    assert.match(body, /saved/);
    assert.doesNotMatch(body, /unsaved/);
  });

  test('a failed save is reported and leaves the selection unchanged', () => {
    const save = saveSpy({ ok: false, error: 'registry locked' });
    const { view } = makeView({ issues: [issue(5), issue(9)], save });
    view.handleInput('space');
    view.handleInput('ctrl+s');
    const body = strip(lines(view).join('\n'));
    assert.match(body, /save failed: registry locked/);
    assert.deepEqual(view.state.issues, [9], 'nothing is rolled back or dropped');
    assert.match(leftOf(lines(view)), /\[x\] #9/);
    assert.match(body, /unsaved/);

    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [9], odd: null }, 'the same selection is retried');
    assert.equal(save.calls.length, 2);
  });

  test('a pending save is visible and repeated ctrl+s does not write twice', async () => {
    const pending = deferred();
    const save = saveSpy(() => pending.promise);
    const { view } = makeView({ issues: [issue(5)], save });
    view.handleInput('space');
    view.handleInput('ctrl+s');
    view.handleInput('ctrl+s');
    assert.equal(save.calls.length, 1);
    assert.match(strip(lines(view).join('\n')), /saving/);

    pending.resolve({ ok: true });
    await tick();
    assert.match(strip(lines(view).join('\n')), /saved/);
  });

  test('a save seam that throws or is missing says so honestly', async () => {
    const missing = makeView({ issues: [issue(5)] });
    missing.view.handleInput('space');
    missing.view.handleInput('ctrl+s');
    assert.match(strip(lines(missing.view).join('\n')), /saving is unavailable/);

    const throwing = makeView({
      issues: [issue(5)],
      save: () => { throw new Error('boom'); },
    });
    throwing.view.handleInput('space');
    throwing.view.handleInput('ctrl+s');
    await tick();
    assert.match(strip(lines(throwing.view).join('\n')), /save failed: boom/);
  });
});

describe('closing, empty, loading and error states', () => {
  test('esc closes with a null result', () => {
    const { view, done } = makeView({ issues: [issue(5)] });
    view.handleInput('escape');
    assert.equal(done(), null);
  });

  test('esc leaves search first, and only then closes', () => {
    const { view, done } = makeView({ issues: [issue(5)] });
    view.handleInput('T');
    view.handleInput('escape');
    assert.equal(view.state.searching, false);
    assert.equal(done(), 'pending');
    view.handleInput('escape');
    assert.equal(done(), null);
  });

  test('empty tabs state it instead of painting fake rows', () => {
    const { view } = makeView({});
    assert.match(rightOf(lines(view)), /no open issues/);
    assert.doesNotMatch(leftOf(lines(view)), /#/);
    view.handleInput('tab');
    assert.match(rightOf(lines(view)), /no odd documents/);
  });

  test('loading and failed issue previews are honest', async () => {
    const pending = deferred();
    const loading = makeView({ issues: [issue(12)], loadIssue: () => pending.promise });
    assert.match(rightOf(lines(loading.view)), /loading/);
    pending.resolve({ ok: true, issue: issue(12, { body: 'loaded body' }) });
    await tick();
    assert.match(rightOf(lines(loading.view)), /loaded body/);

    const failing = makeView({
      issues: [issue(12)],
      loadIssue: () => ({ ok: false, error: 'boom' }),
    });
    failing.view.render(100);
    await tick();
    assert.match(rightOf(lines(failing.view)), /unreadable: boom/);
  });

  test('search filters the current tab only', () => {
    const { view } = makeView({
      issues: [issue(12), issue(7)],
      documents: [document('alpha'), document('beta')],
    });
    view.handleInput('T');
    view.handleInput('1');
    view.handleInput('2');
    assert.match(strip(lines(view).join('\n')), /› 12█/);
    view.handleInput('enter');
    assert.deepEqual(issueNumbers(leftOf(lines(view))), [12]);

    view.handleInput('tab');
    const left = leftOf(lines(view));
    assert.match(left, /alpha/);
    assert.match(left, /beta/);
  });
});

describe('footer legend', () => {
  test('stays on ONE row at every width and never repeats above it', () => {
    const { view } = makeView({
      issues: [issue(12)],
      assignedIssues: [12],
      documents: [document('alpha')],
    });
    for (const width of [40, 60, 80, 120]) {
      const rendered = view.render(width);
      assertExactFrame(rendered, width, 24);
      const footer = strip(rendered[22]);
      assert.match(footer, /esc/, `width ${width} keeps the close key`);
      assert.equal((strip(rendered.join('\n')).match(/esc/g) || []).length, 1, 'the close hint appears once');
      const above = strip(rendered.slice(0, 22).join('\n'));
      assert.doesNotMatch(above, /ctrl\+s/, 'the save hint is not repeated above the footer');
      assert.doesNotMatch(above, /↑↓ move/);
    }
  });

  test('compacts to the short form when the full legend does not fit', () => {
    const { view } = makeView({ issues: [issue(12)] });
    const footer = strip(view.render(40)[22]);
    assert.match(footer, /space/);
    assert.match(footer, /ctrl\+s/);
    assert.doesNotMatch(footer, /scroll/);
    const wide = strip(view.render(120)[22]);
    assert.match(wide, /space assign/);
    assert.match(wide, /T search/);
    assert.match(wide, /ctrl\+j\/k scroll/);
  });
});

describe('purity', () => {
  test('requires nothing but the odd markdown renderer', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worktree-detail-view.js'), 'utf8');
    const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    assert.deepEqual(requires, ['./odd-markdown.js'], 'no filesystem, network or registry dependency');
  });
});
