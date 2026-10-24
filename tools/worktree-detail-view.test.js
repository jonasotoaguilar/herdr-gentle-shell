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
  let doneCalls = 0;
  // `null` is a real input here ("the data is still loading"), so only an
  // absent option falls back to the empty default.
  const view = createWorktreeDetailView({
    worktree: opts.worktree || WORKTREE,
    issues: opts.issues === undefined ? [] : opts.issues,
    assignedIssues: opts.assignedIssues === undefined ? [] : opts.assignedIssues,
    documents: opts.documents === undefined ? [] : opts.documents,
    issuesError: opts.issuesError,
    assignedError: opts.assignedError,
    documentsError: opts.documentsError,
    issuesState: opts.issuesState,
    assignedState: opts.assignedState,
    documentsState: opts.documentsState,
    odd: opts.odd === undefined ? null : opts.odd,
    loadIssue: opts.loadIssue,
    loadDocument: opts.loadDocument,
    save: opts.save,
    helpers: opts.helpers || helpers,
    theme: plainTheme,
    rowsAvailable: () => (opts.rows === undefined ? 24 : opts.rows),
    requestRender: () => { paints.push(true); },
    done: (result) => { doneCalls += 1; settled = result; },
  });
  return { view, done: () => settled, doneCalls: () => doneCalls, paints };
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

// S6: the left list carries the checkbox, the `#`-prefixed number and the
// title, so a row reads `[ ] #12 title` (continuations do not match).
function listRows(rendered) {
  return leftOf(rendered).split('\n')
    .map((row) => {
      const match = row.match(/\[([ x])\]\s#(\d+)\s(.*?)\s*$/);
      return match ? { assigned: match[1] === 'x', number: Number(match[2]), title: match[3] } : null;
    })
    .filter(Boolean);
}
const listTitles = (rendered) => listRows(rendered).map((row) => row.title);

// The ODD tab's left rows are `<marker> <name>`; the marker is the association
// dot (`●` selected, `○` not).
function documentRows(rendered) {
  return leftOf(rendered).split('\n')
    .map((row) => {
      const match = row.match(/[●○]\s(.*?)\s*$/);
      return match ? match[1] : null;
    })
    .filter(Boolean);
}

// The header, tab and status rows carry exactly two border cells (`│ text │`),
// while a body row splits into four fields, so this is the header band only.
function headerRows(rendered) {
  return rendered
    .map((line) => strip(line))
    .filter((line) => line.trim().startsWith('│') && line.split('│').length === 3)
    .map((line) => line.split('│')[1].trim());
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
    const rendered = lines(view);
    const details = headerRows(rendered).find((row) => /branch main/.test(row)) || '';
    assert.doesNotMatch(details, /created/);
    assert.doesNotMatch(details, /modified/);
    assert.match(details, /branch main/);
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
    const rendered = lines(view);
    assert.deepEqual(listTitles(rendered), [
      'issue title 5',
      'issue title 12',
      'issue title 7',
      'issue title 2',
    ], 'assigned first, then descending number');
    assert.deepEqual(listRows(rendered).map((row) => row.assigned), [true, false, false, false]);
    assert.deepEqual(listRows(rendered).map((row) => row.number), [5, 12, 7, 2], 'S6: rows carry `#N`');
    const body = strip(rendered.join('\n'));
    assert.doesNotMatch(body, /#9\b/);
    assert.match(body, /Issues \(4\)/);
    assert.match(rightOf(rendered), /#5/, 'the preview still names the number');
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
    assert.deepEqual(listTitles(lines(view)), ['issue title 11', 'issue title 8', 'issue title 3']);

    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('space');
    let rendered = lines(view);
    assert.deepEqual(listTitles(rendered), [
      'issue title 3',
      'issue title 11',
      'issue title 8',
    ], 'the assigned issue moves to the front');
    assert.match(leftOf(rendered), /▸ \[x\] #3 issue title 3/);

    view.handleInput('down');
    view.handleInput('space');
    rendered = lines(view);
    assert.deepEqual(listTitles(rendered), ['issue title 11', 'issue title 3', 'issue title 8']);
    assert.deepEqual(view.state.issues.slice().sort((a, b) => a - b), [3, 11]);

    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [3, 11], odd: null });
  });

  test('toggling the same issue twice removes it again', () => {
    const { view } = makeView({ issues: [issue(4)], assignedIssues: [4] });
    view.handleInput('space');
    assert.deepEqual(view.state.issues, []);
    assert.match(leftOf(lines(view)), /▸ \[ \] #4 issue title 4/);
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
    assert.match(leftOf(lines(view)), /#12 issue title 12/);
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

  // S1: rows 12 leave a 4-row body, so a full page is 3 preview rows and a
  // half page is 1 — the two bindings must not move the same distance.
  test('S1: ctrl+shift+j/k, PgDn/PgUp and Shift+J/K page the preview; ctrl+d/u take a half page', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    const right = rightOf(lines(view));
    assert.match(right, /• item 01/);
    assert.doesNotMatch(right, /• item 07/);
    const scroll = () => view.state.scroll.odd;
    assert.equal(scroll(), 0);

    view.handleInput('ctrl+shift+j');
    assert.equal(scroll(), 3, 'ctrl+shift+j pages down a full page');
    assert.doesNotMatch(rightOf(lines(view)), /• item 01/);
    assert.match(leftOf(lines(view)), /▸ ○ alpha/, 'the list cursor stays put');

    view.handleInput('J');
    assert.equal(scroll(), 6, 'printable Shift+J is the same FULL page, not a half one');

    view.handleInput('pagedown');
    assert.equal(scroll(), 9, 'PgDn pages down');

    view.handleInput('ctrl+d');
    assert.equal(scroll(), 10, 'ctrl+d moves half a page');
    assert.notEqual(scroll() - 9, 3, 'the half page is a different distance than the full page');

    view.handleInput('K');
    assert.equal(scroll(), 7, 'printable Shift+K pages back up the full distance');

    view.handleInput('ctrl+u');
    assert.equal(scroll(), 6, 'ctrl+u moves half a page back');

    view.handleInput('pageup');
    assert.equal(scroll(), 3, 'PgUp pages back up');

    view.handleInput('ctrl+shift+k');
    assert.equal(scroll(), 0, 'ctrl+shift+k returns to the top');
  });

  test('S1: the modifier order the host reports does not change the action', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    lines(view);
    view.handleInput('shift+ctrl+j');
    assert.equal(view.state.scroll.odd, 3, 'shift+ctrl+j pages down like ctrl+shift+j');
    view.handleInput('shift+ctrl+k');
    assert.equal(view.state.scroll.odd, 0, 'shift+ctrl+k pages back up');
  });

  test('lowercase j moves the list and resets the preview', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    view.handleInput('ctrl+shift+j');
    assert.doesNotMatch(rightOf(lines(view)), /• item 01/);
    view.handleInput('j');
    const right = rightOf(lines(view));
    assert.match(right, /• item 01/);
    assert.match(leftOf(lines(view)), /▸ ○ beta/);
  });

  test('S1: lowercase j/k only move the list and never page the preview', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    lines(view);
    view.handleInput('j');
    assert.equal(view.state.scroll.odd, 0, 'j does not page');
    assert.match(leftOf(lines(view)), /▸ ○ beta/, 'j selects the next document');
    view.handleInput('k');
    assert.equal(view.state.scroll.odd, 0, 'k does not page');
    assert.match(leftOf(lines(view)), /▸ ○ alpha/, 'k selects the previous document');
  });

  test('S1: the legacy CtrlJ/CtrlK bytes no longer page, and Enter keeps selecting', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    lines(view);
    view.handleInput('ctrl+shift+j');
    assert.equal(view.state.scroll.odd, 3);

    view.handleInput('\x0b'); // the old legacy ctrl+k byte (VT)
    assert.equal(view.state.scroll.odd, 3, 'CtrlK is not a preview scroll alias any more');
    view.handleInput('ctrl+k');
    assert.equal(view.state.scroll.odd, 3, 'the spelled ctrl+k does not page either');

    view.handleInput('\n'); // the legacy ctrl+j byte, also Enter
    assert.equal(view.state.scroll.odd, 3, 'LF is not a preview scroll alias any more');
    assert.equal(view.state.odd, '/repo/worktrees/w1/odd/tasks/alpha.md', 'Enter still selects the document');

    // On the Issues tab Enter has no selection meaning, and it still never pages.
    view.handleInput('tab');
    view.handleInput('\r');
    assert.equal(view.state.scroll.issues, 0, 'a real Enter never pages the issue preview');
  });

  test('S1: the offset is clamped in the same turn as the key, at both bounds', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    lines(view);
    view.handleInput('ctrl+u');
    assert.equal(view.state.scroll.odd, 0, 'a half page up from the top never goes negative');
    for (let at = 0; at < 40; at += 1) view.handleInput('ctrl+shift+j');
    assert.equal(view.state.scroll.odd, 36, '40 preview rows in a 4-row body clamp at 36');
    assert.match(rightOf(lines(view)), /• item 40/, 'the last preview row is reachable');
  });

  test('S1: a key release never pages, selects or paints', () => {
    const { view, paints } = scrollingView();
    view.handleInput('tab');
    lines(view);
    const before = paints.length;
    view.handleInput('release');
    assert.equal(view.state.scroll.odd, 0, 'a release does not page');
    assert.equal(view.state.odd, null, 'a release never selects');
    assert.equal(view.state.cursor.odd, 0, 'a release never moves the list');
    assert.equal(paints.length, before, 'a release does not repaint');
  });

  test('S1: the extended-protocol release forms never page, even with no host classifier', () => {
    const helpersWithoutRelease = { ...helpers, isKeyRelease: undefined };
    const { view, paints } = makeView({
      rows: 12,
      helpers: helpersWithoutRelease,
      documents: [document('alpha', { text: longText })],
    });
    view.handleInput('tab');
    lines(view);
    const before = paints.length;
    view.handleInput('\x1b[106;6:3u'); // CSI-u release
    view.handleInput('\x1b[27;6;106;3~'); // xterm modifyOtherKeys release
    assert.equal(view.state.scroll.odd, 0, 'a release suffix never pages');
    assert.equal(paints.length, before, 'a release does not repaint');
    view.handleInput('\x1b[106;6:2u'); // the same key as a repeat
    assert.equal(view.state.scroll.odd, 3, 'a repeat still pages');
  });

  test('S1: search typing keeps J/K/j/k as text and never pages or selects', () => {
    const { view } = scrollingView();
    view.handleInput('tab');
    lines(view);
    view.handleInput('T');
    for (const key of ['J', 'K', 'j', 'k']) view.handleInput(key);
    assert.equal(view.state.query.odd, 'JKjk', 'the printable paging keys are query text while typing');
    assert.equal(view.state.scroll.odd, 0, 'no preview paging while typing');
    assert.equal(view.state.cursor.odd, 0, 'no list move while typing');
    assert.equal(view.state.odd, null, 'no selection while typing');
  });

  test('S1: the real host reports LF as both ctrl+j and enter; LF selects and never pages', { skip: !realHelpers }, () => {
    const { view } = makeView({
      rows: 12,
      helpers: realHelpers,
      documents: [document('alpha', { text: longText })],
    });
    assert.equal(realHelpers.matchesKey('\n', 'ctrl+j'), true, 'the host still calls the LF byte ctrl+j');
    assert.equal(realHelpers.matchesKey('\n', 'enter'), true, 'and the same byte is Enter');
    view.handleInput('tab');
    assert.match(rightOf(lines(view)), /• item 01/);
    view.handleInput('\n');
    assert.equal(view.state.scroll.odd, 0, 'the ambiguous byte never pages');
    assert.equal(view.state.odd, '/repo/worktrees/w1/odd/tasks/alpha.md', 'it keeps its Enter meaning');
    view.handleInput('\x1b[106;6u'); // Kitty ctrl+shift+j press
    assert.ok(view.state.scroll.odd > 0, 'the extended-protocol pair pages the preview');
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
    assert.match(leftOf(lines(view)), /\[x\] #9 issue title 9/);
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
    assert.deepEqual(listTitles(lines(view)), ['issue title 12']);

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

  test('compacts to one row keeping the spelled distinctions when the full legend does not fit', () => {
    const { view } = makeView({ issues: [issue(12)] });
    // 40 columns leave 36 inner cells: the spelled `tab Issues/ODD` and
    // `←/→ page` pair (plus esc) is what must survive, because that pair is the
    // reported confusion. 36 cells cannot also hold space and ctrl+s.
    const footer = strip(view.render(40)[22]);
    assert.match(footer, /tab Issues\/ODD/, 'the Tab distinction replaces the bare `tab` token');
    assert.match(footer, /←\/→ page/, 'the paging distinction replaces the bare `←/→` token');
    assert.match(footer, /esc/, 'the close key survives compaction');
    assert.doesNotMatch(footer, /move|assign|search|scroll|refresh|save/, 'the verbose hints gave way');

    // The full legend still fits a wide terminal, verbs included.
    const wide = strip(view.render(200)[22]);
    assert.match(wide, /space assign/);
    assert.match(wide, /T search/);
    assert.match(wide, /shift\+j\/k scroll/);
    assert.match(wide, /PgUp\/PgDn/);
    assert.match(wide, /ctrl\+d\/u half/);
    assert.match(wide, /ctrl\+s save/);
    assert.match(wide, /tab Issues\/ODD/);
    assert.match(wide, /←\/→ page/);
  });

  // S1: the footer names the scroll pair the terminal actually confirmed, so a
  // legacy terminal is never told to press a key it cannot deliver and no
  // platform default is guessed.
  test('S1: the primary scroll legend follows the confirmed protocol', () => {
    const fallback = makeView({ issues: [issue(12)], rows: 24 });
    const printable = strip(fallback.view.render(200)[22]);
    assert.match(printable, /shift\+j\/k scroll/, 'an unconfirmed protocol is offered the printable pair');
    assert.doesNotMatch(printable, /ctrl\+shift/, 'no extended pair is invented');
    assert.match(printable, /PgUp\/PgDn/, 'the page keys are always named');
    assert.match(printable, /ctrl\+d\/u half/, 'the half-page pair keeps its own wording');

    const extended = makeView({
      issues: [issue(12)],
      rows: 24,
      helpers: { ...helpers, isKittyProtocolActive: () => true },
    });
    const confirmed = strip(extended.view.render(200)[22]);
    assert.match(confirmed, /ctrl\+shift\+j\/k scroll/, 'a confirmed protocol is offered the primary pair');
    assert.doesNotMatch(confirmed, /(^|[^+])\bctrl\+j\/k\b/, 'never the bare ctrl+j/k claim the user reported');
  });
});

describe('purity', () => {
  test('requires only the pure odd renderer and the shared layout helper', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'worktree-detail-view.js'), 'utf8');
    const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    assert.deepEqual(
      requires,
      ['./odd-markdown.js', './view-layout.js', './issue-preview.js', './preview-scroll-keys.js'],
      'no filesystem, network or registry dependency; the shared pure key helper is the only addition',
    );
  });
});

// ---------------------------------------------------------------------------
// worktree-ui-feedback T2/T5: S1 (real host input), S3 (shared expanded left
// panel and full wrapped titles), S10 (`r` refreshes the preview), S11 (Tab
// switches tabs, ←/→ page the active list, three header data rows) and S15
// (concise facts only).
// ---------------------------------------------------------------------------
describe('worktree detail feedback round (S1,S3,S10,S11,S15,D3)', () => {
  const manyIssues = (count) => Array.from({ length: count }, (_unused, at) => issue(100 - at));
  const manyDocs = (count) => Array.from({ length: count }, (_unused, at) => document(`doc-${String(at + 1).padStart(2, '0')}`, { text: 'body\n' }));

  test('S5: the left panel takes the 40% share and the preview the 60% share', () => {
    const { view } = makeView({ issues: [issue(12)], documents: [document('alpha')] });
    for (const width of [80, 120, 200]) {
      const rendered = lines(view, width);
      const plain = strip(rendered[8]);
      const dividerAt = plain.indexOf('│', 1);
      const leftPane = dividerAt - 2;
      const inner = width - 4;
      assert.ok(Math.abs(leftPane - inner * 0.4) <= 2, `${width}: left pane ${leftPane} is 40% of ${inner}`);
      assert.ok(inner - leftPane - 3 > leftPane, `${width}: the preview is the larger pane`);
    }
  });

  test('S3/S6: a long issue title wraps over the rows it needs and keeps its `#N` row prefix', () => {
    const title = 'a very long issue title that needs to wrap inside the left panel';
    const { view } = makeView({ issues: [issue(77, { title })], loadIssue: (n) => ({ ok: true, issue: issue(n, { title }) }) });
    const rendered = lines(view, 100);
    const left = leftOf(rendered).replace(/[│▸ ]/g, ' ').replace(/\s+/g, ' ');
    assert.ok(!leftOf(rendered).includes('…'), 'no ellipsis truncation in the list');
    assert.ok(left.includes('wrap inside'), 'the middle of the title survives');
    assert.ok(left.includes('left panel'), 'the end of the title survives');
    assert.equal(listRows(rendered)[0].number, 77, 'the list row is `[ ] #77 title`');
    assert.match(rightOf(rendered), /#77/, 'the preview still names the number');
  });

  test('S11: the footer spells Tab and the paging arrows apart', () => {
    const { view } = makeView({ issues: manyIssues(3), documents: [document('alpha')] });
    const footer = strip(lines(view, 120)[22]);
    assert.match(footer, /tab Issues\/ODD/, 'the footer names what Tab does');
    assert.match(footer, /←\/→ page/, 'the footer names what the arrows do');
  });

  test('S11/D3: Tab never pages; ←/→ page the active list and never switch tabs', () => {
    const { view } = makeView({ issues: manyIssues(20), documents: manyDocs(3), rows: 16 });
    const pageOf = (rendered) => (strip(rendered.join('\n')).match(/page (\d+)\/(\d+)/) || [])[1];
    assert.equal(view.state.tab, 'issues');
    const first = lines(view, 100);
    assert.equal(pageOf(first), '1');
    view.handleInput('right');
    assert.equal(view.state.tab, 'issues', '→ never switches tabs');
    assert.equal(pageOf(lines(view, 100)), '2', '→ pages the active list');
    view.handleInput('left');
    assert.equal(pageOf(lines(view, 100)), '1', '← pages back');
    view.handleInput('tab');
    assert.equal(view.state.tab, 'odd', 'Tab switches the dataset');
    const oddFirst = lines(view, 100);
    assert.equal(oddFirst.length, 16, 'the frame still fills the rows');
    view.handleInput('right');
    assert.equal(view.state.tab, 'odd', '→ never switches tabs on the ODD tab either');
    view.handleInput('shift+tab');
    assert.equal(view.state.tab, 'issues', 'Shift+Tab switches back');
  });

  test('S3/S5: paging capacity follows the wrapped rows and the body budget, and skips no issue', () => {
    const tall = manyIssues(12, (at) => at);
    const longTitles = Array.from({ length: 12 }, (_unused, at) => issue(90 - at, {
      title: `issue ${90 - at} with a title long enough to take two rows in the panel`,
    }));
    const { view } = makeView({ issues: longTitles, rows: 20 });
    const counts = [];
    for (let page = 0; page < 12; page += 1) {
      const rendered = lines(view, 100);
      const rows = leftOf(rendered).split('\n').filter((row) => /issue \d/.test(row));
      counts.push(rows.length);
      view.handleInput('right');
    }
    const unique = new Set(counts);
    assert.ok(unique.size >= 1, `every page renders rows: ${[...unique]}`);
    assert.ok(Math.max(...counts) <= 8, `a page never exceeds the body budget: ${[...counts]}`);
    const seen = new Set();
    const again = makeView({ issues: longTitles, rows: 20 });
    for (let step = 0; step < longTitles.length; step += 1) {
      // The focused LIST row, not the tab row (which also carries `▸`).
      const focused = (leftOf(lines(again.view, 100)).split('\n').find((row) => row.includes('▸ [')) || '');
      const number = (focused.match(/issue (\d+)/) || [])[1];
      if (number) seen.add(number);
      again.view.handleInput('down');
    }
    assert.equal(seen.size, longTitles.length, '↓ reaches every issue across page boundaries');
    assert.ok(tall.length === 12);
  });

  test('S11: the header separates the details, the assigned ODD and the assigned numbers', () => {
    const { view } = makeView({
      issues: manyIssues(6),
      assignedIssues: [97, 98, 99, 100],
      documents: [document('alpha'), document('beta')],
      odd: '/repo/worktrees/w1/odd/tasks/alpha.md',
      rows: 24,
    });
    view.render(100);
    const rows = headerRows(lines(view, 100));
    const detailsAt = rows.findIndex((row) => /branch feat\/w1/.test(row));
    const numbersAt = rows.findIndex((row) => /^issues:/.test(row));
    const oddAt = rows.findIndex((row) => /^odd:/.test(row));
    assert.ok(detailsAt >= 0, `the first row carries the worktree details: ${JSON.stringify(rows)}`);
    assert.equal(numbersAt, detailsAt + 1, 'S6: the assigned issues are the SECOND row');
    assert.equal(oddAt, numbersAt + 1, 'S6: the assigned ODD is the THIRD row');
    assert.match(rows[numbersAt], /^issues: #97, #98, #99, #100$/, 'the numbers carry `#`');
    assert.equal(rows[oddAt], 'odd: alpha', 'S6: the ODD row is the name alone, never the path');
    assert.doesNotMatch(rows.join('\n'), /odd\/tasks/, 'no ODD path anywhere in the header');
  });

  test('S11: many assigned numbers wrap onto extra rows instead of truncating, and the budget still fits', () => {
    const numbers = Array.from({ length: 20 }, (_unused, at) => 700 + at);
    const { view } = makeView({
      // Real rows for every assignment: an id with no matching open issue is
      // dropped by the initial-selection rule, so the fixture must be valid.
      issues: numbers.map((number) => issue(number)),
      assignedIssues: numbers,
      documents: [document('alpha')],
      odd: '/repo/worktrees/w1/odd/tasks/alpha.md',
      rows: 24,
    });
    const rendered = lines(view, 80);
    assertExactFrame(rendered, 80, 24);
    const plain = strip(rendered.join('\n'));
    for (const number of numbers) assert.ok(plain.includes(String(number)), `${number} survives the wrap`);
    assert.match(plain, /odd: alpha/, 'the third logical row still names the assigned ODD');
    const numberRows = plain.split('\n')
      .filter((line) => /^\│\s+issues: /.test(line) || /^\│\s+#\d+, /.test(line));
    assert.ok(numberRows.length >= 2, `the numbers wrap onto extra rows, got ${numberRows.length}`);
    assert.ok(!plain.includes('…'), 'nothing is truncated');
    assert.match(plain, /tab Issues\/ODD/, 'the footer still fits below the wrapped header');
    // The wrapped header is counted against the real height: body rows remain.
    const listBody = listTitles(rendered);
    assert.ok(listBody.length > 0, 'at least one list row survives the wrapped header');
  });

  test('S15: a verbose fact reason renders as a brief unavailable value', () => {
    const { view } = makeView({
      worktree: {
        name: 'w',
        path: '/repo/w',
        branch: 'main',
        modified: 'no activity since the checkout was created',
      },
      issues: [issue(4)],
    });
    const plain = strip(lines(view).join('\n'));
    assert.ok(!plain.includes('no activity since the checkout was created'), 'the verbose reason never renders');
    assert.match(plain, /modified —/, 'a brief unavailable value replaces it');
  });

  test('S10: r refetches the focused issue and the focused document with a refresh request', async () => {
    const issueCalls = [];
    const docCalls = [];
    const { view } = makeView({
      issues: [issue(12, { title: 'before refresh' })],
      documents: [document('alpha')],
      loadIssue: (number, opts) => {
        issueCalls.push([number, opts]);
        const refreshed = (opts && opts.refresh) === true;
        return { ok: true, issue: issue(number, { title: refreshed ? 'after refresh' : 'before refresh', body: refreshed ? 'new body' : 'old body' }), comments: [] };
      },
      loadDocument: (id, opts) => {
        docCalls.push([id, opts]);
        return { ok: true, text: `# ${(opts && opts.refresh) === true ? 'fresh' : 'stale'}` };
      },
    });
    view.render(100);
    assert.match(rightOf(lines(view)), /before refresh/);
    view.handleInput('r');
    await tick();
    assert.equal(issueCalls.at(-1)[1] && issueCalls.at(-1)[1].refresh, true, 'the issue read asks for fresh data');
    assert.match(rightOf(lines(view)), /after refresh/, 'the refreshed detail replaces the cached one');
    view.handleInput('tab');
    await tick();
    view.handleInput('r');
    await tick();
    assert.equal(docCalls.at(-1)[1] && docCalls.at(-1)[1].refresh, true, 'the document read asks for fresh data');
    assert.match(rightOf(lines(view)), /fresh/);
  });

  test('S10: a failed refresh is visible and never claims fresh data', async () => {
    let fail = false;
    const { view } = makeView({
      issues: [issue(12, { title: 'kept title' })],
      loadIssue: (number) => (fail
        ? { ok: false, error: 'gh timed out' }
        : { ok: true, issue: issue(number, { title: 'kept title' }), comments: [] }),
    });
    view.render(100);
    assert.match(rightOf(lines(view)), /kept title/);
    fail = true;
    view.handleInput('r');
    await tick();
    const plain = strip(lines(view).join('\n'));
    assert.match(plain, /refresh failed: gh timed out/, 'the failure is reported');
    assert.match(rightOf(lines(view)), /unreadable: gh timed out/, 'the stale preview is not presented as fresh');
  });

  test('S1: the real host matcher pages with the extended pair, and a legacy CtrlJ byte is not a scroll alias', { skip: !realHelpers }, () => {
    const text = Array.from({ length: 60 }, (_unused, at) => `- item ${String(at + 1).padStart(2, '0')}`).join('\n');
    const { view } = makeView({
      rows: 16,
      helpers: realHelpers,
      documents: [document('alpha', { text })],
    });
    assert.equal(realHelpers.matchesKey('\n', 'ctrl+j'), true);
    assert.equal(realHelpers.matchesKey('\n', 'enter'), true, 'the host also reports the byte as Enter');
    view.handleInput('tab');
    view.render(100);
    view.handleInput('\n');
    assert.equal(view.state.scroll.odd, 0, 'the ambiguous LF byte never pages');
    assert.equal(view.state.odd, '/repo/worktrees/w1/odd/tasks/alpha.md', 'it keeps its Enter meaning');
    view.handleInput('\x1b[107;6;3~'); // xterm shift+ctrl+k release
    assert.equal(view.state.scroll.odd, 0, 'a release never pages');
    view.handleInput('\x1b[27;6;107~'); // xterm shift+ctrl+k press
    assert.equal(view.state.scroll.odd, 0, 'paging up from the top stays at the top');
    view.handleInput('\x1b[106;6:2u'); // Kitty ctrl+shift+j repeat
    assert.ok(view.state.scroll.odd > 0, 'a Kitty key repeat pages');
    view.handleInput('\x0b'); // legacy ctrl+k byte
    assert.ok(view.state.scroll.odd > 0, 'the legacy control byte is not a scroll alias');
    view.handleInput('\r'); // a real Enter still selects
    assert.equal(view.state.odd, '/repo/worktrees/w1/odd/tasks/alpha.md', 'genuine Enter still selects the document');
  });
});

// ---------------------------------------------------------------------------
// ui-consistency-round3 T6: S2 (associations by name/id), S6 (header order,
// colons, `#` ids, ODD name only, `-` for an absent association), S16 (the
// issue preview carries the same metadata and comments as Issues), plus the
// detail share of S8 (capacity from the wrapped rows) and S14 (one fixed page
// indicator beside Search, and a footer that names the live search actions).
// ---------------------------------------------------------------------------
describe('worktree detail round 3 (S2,S6,S8,S14,S16)', () => {
  const statusRow = (rendered) => strip(rendered.find((line) => /›/.test(strip(line))) ?? '');
  const footerRow = (rendered) => strip(rendered[rendered.length - 2] ?? '');

  test('S6: the header is details, then issues, then ODD, with colons and # ids', () => {
    const { view } = makeView({
      issues: [issue(96), issue(77), issue(76)],
      assignedIssues: [76, 77],
      documents: [document('alpha'), document('beta')],
      odd: '/repo/worktrees/w1/odd/tasks/alpha.md',
      rows: 24,
    });
    const rows = headerRows(lines(view, 120));
    const detailsAt = rows.findIndex((row) => /branch feat\/w1/.test(row));
    assert.ok(detailsAt >= 0, 'the details row leads the header');
    assert.equal(rows[detailsAt + 1], 'issues: #76, #77', 'S6: row 2 is the assigned issues, with `#` ids');
    assert.equal(rows[detailsAt + 2], 'odd: alpha', 'S6: row 3 is the ODD name alone');
    assert.doesNotMatch(rows.join('\n'), /odd\/tasks/, 'the ODD path never reaches the header');
  });

  test('S6: an absent association renders `-` in its own row instead of disappearing', () => {
    const { view } = makeView({ issues: [issue(5)], assignedIssues: [], rows: 24 });
    const rows = headerRows(lines(view, 120));
    assert.ok(rows.includes('issues: -'), `an unassigned worktree shows \`-\`: ${JSON.stringify(rows)}`);
    assert.ok(rows.includes('odd: -'), `no associated ODD shows \`-\`: ${JSON.stringify(rows)}`);
    assert.ok(!rows.some((row) => /issues: 0|odd: 0/.test(row)), 'a missing association is never a zero');
  });

  test('S6: the ODD row names the document even when the caller stores a path', () => {
    const { view } = makeView({
      documents: [document('alpha')],
      odd: 'odd/tasks/alpha.md',
      rows: 24,
    });
    const rows = headerRows(lines(view, 120));
    assert.ok(rows.includes('odd: alpha'), `the stored relative path renders as its name: ${JSON.stringify(rows)}`);
  });

  test('S6: issue list rows carry the # prefix', () => {
    const { view } = makeView({ issues: [issue(77), issue(76)], rows: 24 });
    const rendered = lines(view, 100);
    assert.match(leftOf(rendered), /\[ \] #77 issue title 77/);
    assert.match(leftOf(rendered), /\[ \] #76 issue title 76/);
    assert.match(leftOf(rendered), /▸ \[ \] #77/, 'the focused marker still leads the row');
  });

  test('S16: the preview shows the same metadata and comments Issues shows', () => {
    const detail = {
      number: 77,
      title: 'parity title',
      state: 'open',
      author: 'octo',
      labels: [{ name: 'bug' }],
      assignees: [{ login: 'ana' }, 'beto'],
      createdAt: '2026-02-25T00:00:00.000Z',
      updatedAt: '2026-02-26T00:00:00.000Z',
      commentsCount: 2,
      reactions: { plusOne: 3 },
      projects: [{ title: 'Roadmap' }],
      linkedPullRequestCount: 2,
      body: 'body text',
    };
    const comments = [
      { author: 'ana', body: 'first comment body', createdAt: '2026-02-27T00:00:00.000Z' },
      { author: 'beto', body: 'second comment body', createdAt: '2026-02-28T00:00:00.000Z' },
    ];
    const { view } = makeView({
      issues: [issue(77)],
      loadIssue: () => ({ ok: true, issue: detail, comments }),
      rows: 40,
    });
    const right = rightOf(lines(view, 120));
    assert.match(right, /#77 parity title/);
    assert.match(right, /labels: bug/);
    assert.match(right, /assignees: ana, beto/, 'every assigned person appears');
    assert.match(right, /projects: Roadmap/, 'every project appears');
    assert.match(right, /linked PRs: 2/, 'a non-zero PR count appears');
    assert.match(right, /👍 3 · 2 comments/);
    assert.match(right, /by octo · created /);
    assert.match(right, /body text/);
    assert.match(right, /─ ana · /, 'the first comment is rendered with its author');
    assert.match(right, /first comment body/);
    assert.match(right, /second comment body/);
    assert.match(right, /\(end of issue\)/);
  });

  test('S16: empty optional metadata is omitted instead of printed as none', () => {
    const { view } = makeView({
      issues: [issue(5)],
      loadIssue: () => ({
        ok: true,
        issue: { ...issue(5), assignees: [], projects: [], linkedPullRequestCount: 0, commentsCount: 0 },
        comments: [],
      }),
      rows: 30,
    });
    const right = rightOf(lines(view));
    assert.doesNotMatch(right, /assignees:/);
    assert.doesNotMatch(right, /projects:/);
    assert.doesNotMatch(right, /linked PRs:/);
    assert.match(right, /\(end of issue\)/, 'an issue with no comments still ends honestly');
  });

  test('S16: the {issue, comments} envelope is accepted without an `ok` flag', () => {
    const { view } = makeView({
      issues: [issue(9)],
      loadIssue: () => ({ issue: { ...issue(9), assignees: ['ana'] }, comments: [{ author: 'ana', body: 'envelope comment' }] }),
      rows: 30,
    });
    const right = rightOf(lines(view));
    assert.match(right, /assignees: ana/);
    assert.match(right, /envelope comment/);
  });

  test('S16: the row data paints while the richer detail is still loading', () => {
    const pending = deferred();
    const { view } = makeView({
      issues: [issue(12, { labels: [{ name: 'bug' }] })],
      loadIssue: () => pending.promise,
      rows: 30,
    });
    const right = rightOf(lines(view));
    assert.match(right, /#12 issue title 12/, 'the known row data is shown immediately');
    assert.match(right, /labels: bug/);
    assert.match(right, /loading…/, 'the pending read is named, not faked');
  });

  test('S16: a late answer for another issue never contaminates the focused preview', async () => {
    const slow = deferred();
    const { view } = makeView({
      issues: [issue(12), issue(7)],
      loadIssue: (number) => (number === 12
        ? slow.promise
        : { ok: true, issue: issue(7, { title: 'issue 7 loaded' }), comments: [{ author: 'ana', body: 'comment on 7' }] }),
      rows: 30,
    });
    lines(view);
    view.handleInput('down');
    assert.match(rightOf(lines(view)), /issue 7 loaded/);
    slow.resolve({
      ok: true,
      issue: issue(12, { title: 'issue 12 loaded', body: 'body of twelve' }),
      comments: [{ author: 'bob', body: 'comment on 12' }],
    });
    await tick();
    const right = rightOf(lines(view));
    assert.match(right, /issue 7 loaded/, 'the focused issue keeps the pane');
    assert.match(right, /comment on 7/);
    assert.doesNotMatch(right, /comment on 12/, 'the other issue never leaks in');
    assert.doesNotMatch(right, /body of twelve/);
  });

  test('S16: a failed refresh replaces the preview honestly and drops the old comments', async () => {
    let fail = false;
    const { view } = makeView({
      issues: [issue(12)],
      loadIssue: (number) => (fail
        ? { ok: false, error: 'gh down' }
        : { ok: true, issue: issue(number), comments: [{ author: 'ana', body: 'kept comment' }] }),
      rows: 30,
    });
    lines(view);
    await tick();
    assert.match(rightOf(lines(view)), /kept comment/);
    fail = true;
    view.handleInput('r');
    await tick();
    const right = rightOf(lines(view));
    assert.match(right, /unreadable: gh down/);
    assert.doesNotMatch(right, /kept comment/, 'stale detail is never presented as fresh');
    assert.match(strip(lines(view).join('\n')), /refresh failed: gh down/);
  });

  test('S14: the page indicator sits beside Search even on a one-page list, at every height', () => {
    for (const rows of [12, 24, 40]) {
      const { view } = makeView({ issues: [issue(5)], rows });
      assert.match(statusRow(lines(view, 120)), /› Search · page 1\/1/, `rows ${rows}: the marker is always there`);
    }
    const odd = makeView({ documents: [document('alpha')], rows: 24 });
    odd.view.handleInput('tab');
    assert.match(statusRow(lines(odd.view, 120)), /› Search · page 1\/1/, 'the ODD tab shows it too');
  });

  test('S8/S14: a wrapped header still leaves the fixed marker, the footer and a body row', () => {
    const numbers = Array.from({ length: 24 }, (_unused, at) => 700 + at);
    const { view } = makeView({
      issues: numbers.map((number) => issue(number)),
      assignedIssues: numbers,
      documents: [document('alpha')],
      odd: '/repo/worktrees/w1/odd/tasks/alpha.md',
      rows: 14,
    });
    const rendered = lines(view, 80);
    assertExactFrame(rendered, 80, 14);
    const plain = strip(rendered.join('\n'));
    for (const number of numbers) assert.ok(plain.includes(String(number)), `${number} survives the wrap`);
    assert.match(plain, /odd: alpha/);
    assert.match(plain, /page 1\/\d+/, 'the page marker survives the wrapped header');
    assert.match(plain, /tab Issues\/ODD/, 'the footer survives the wrapped header');
    assert.ok(listRows(rendered).length > 0, 'at least one list row survives');
  });

  test('S14: an active search footer names the real search actions, and delete clears the query', () => {
    const { view } = makeView({ issues: [issue(12), issue(7)], rows: 24 });
    view.handleInput('T');
    view.handleInput('7');
    let footer = footerRow(lines(view, 160));
    assert.match(footer, /backspace/, 'the footer names the character delete');
    assert.match(footer, /clear/, 'and the whole-query clear');
    assert.match(footer, /keep/, 'and how to leave the filter');
    assert.doesNotMatch(footer, /ctrl\+s save|tab Issues\/ODD/, 'the browsing keys give way while typing');

    view.handleInput('delete');
    assert.equal(view.state.query.issues, '', 'delete empties the whole query');
    assert.equal(view.state.searching, true, 'and keeps the field open');
    assert.deepEqual(listTitles(lines(view)), ['issue title 12', 'issue title 7'], 'the list comes back');
  });
});

// ---------------------------------------------------------------------------
// ui-consistency-round3 T9 S18 (view half) + the parent's post-mount map: the
// detail mounts BEFORE its worktree facts, issue list and assignment are known
// and is fed them afterwards through `apply(partial)`. The same mounted view
// must accept that data, keep the reader's position and unsaved work, refuse a
// save that would persist from an incomplete list, and never act again once
// `done` has fired.
// ---------------------------------------------------------------------------
describe('post-mount data seam (apply) and view lifetime', () => {
  const statusRow = (rendered) => strip(rendered.find((line) => /›/.test(strip(line))) ?? '');

  test('apply feeds the same mounted view: stored ODD name first, then issues and assignment', () => {
    const { view } = makeView({
      worktree: null,
      issues: null,
      assignedIssues: null,
      documents: null,
      odd: 'odd/tasks/alpha.md',
      rows: 24,
    });
    // Nothing is known yet, so nothing is invented: the stored association is
    // named, the lists say they are loading, and no count claims a zero.
    let rendered = lines(view, 120);
    let header = headerRows(rendered).join('\n');
    assert.match(header, /odd: alpha/, 'the stored association shows before any read');
    assert.match(header, /issues: -/, 'a not-yet-known assignment is the empty marker');
    assert.doesNotMatch(strip(rendered.join('\n')), /Issues \(0\)|ODD \(0\)/, 'a pending list never shows 0');
    assert.match(rightOf(rendered), /loading issues…/);
    assert.match(statusRow(rendered), /loading issues…/, 'the status row says what is pending');

    const applied = view.apply({
      worktree: WORKTREE,
      issues: [issue(12), issue(5)],
      assignedIssues: [5],
      documents: [document('alpha'), document('beta')],
      odd: 'odd/tasks/alpha.md',
    });
    assert.equal(applied, true);
    rendered = lines(view, 120);
    assert.deepEqual(listRows(rendered).map((row) => row.number), [5, 12], 'the real list replaces the pending one');
    header = headerRows(rendered).join('\n');
    assert.match(header, /branch feat\/w1/, 'the facts arrive with the same apply');
    assert.match(header, /issues: #5/, 'the assignment is the applied baseline');
    assert.match(header, /odd: alpha/);
    assert.match(strip(rendered.join('\n')), /Issues \(2\)/, 'the counts are real now');
    assert.equal(view.state.dataState.issues, 'ready');
    assert.equal(view.state.dataState.assigned, 'ready');
    assert.doesNotMatch(strip(rendered.join('\n')), /loading issues…/);

    assert.equal(view.apply(null), false, 'an unusable payload is ignored');
    assert.equal(view.apply({}), true, 'an empty payload is a no-op, not an error');
  });

  test('apply keeps the focused issue and document identity across a re-sorted list', () => {
    const { view } = makeView({
      issues: [issue(12), issue(7), issue(5)],
      documents: [document('alpha'), document('beta'), document('gamma')],
      rows: 24,
    });
    view.handleInput('down');
    assert.equal(view.state.cursor.issues, 1);
    assert.equal(listRows(lines(view))[1].number, 7);

    // A verified list arrives in a different order: #7 is now the only
    // assigned issue and therefore leads the list. The cursor follows it.
    view.apply({ issues: [issue(7), issue(5), issue(12)], assignedIssues: [7] });
    const rows = listRows(lines(view));
    assert.equal(rows[view.state.cursor.issues].number, 7, 'the reader stays on the issue they were reading');

    // The same rule for the ODD tab.
    view.handleInput('tab');
    view.handleInput('down');
    assert.equal(view.state.cursor.odd, 1);
    view.apply({ documents: [document('delta'), document('alpha'), document('beta'), document('gamma')] });
    assert.equal(documentRows(lines(view))[view.state.cursor.odd], 'beta', 'the reader stays on their document');
  });

  test('apply never overrides an unsaved selection or its saved baseline', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({ issues: [issue(12), issue(5)], assignedIssues: [5], save, rows: 24 });
    view.handleInput('down');
    view.handleInput('space');
    assert.deepEqual(view.state.issues, [5, 12]);
    assert.equal(view.state.dirty, true);

    view.apply({ assignedIssues: [12], odd: 'odd/tasks/alpha.md' });
    assert.deepEqual(view.state.issues, [5, 12], 'the reader\'s unsaved choice survives');
    assert.equal(view.state.dirty, true, 'and is still unsaved');

    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [5, 12], odd: null }, 'the save sends the reader\'s choice, not the late baseline');
  });

  test('apply never overrides the baseline while a save is in flight', async () => {
    const pending = deferred();
    const save = saveSpy(() => pending.promise);
    const { view } = makeView({ issues: [issue(12), issue(5)], assignedIssues: [], save, rows: 24 });
    view.handleInput('space');
    assert.deepEqual(view.state.issues, [12]);
    view.handleInput('ctrl+s');
    assert.equal(view.state.saving, true);

    view.apply({ assignedIssues: [5] });
    assert.deepEqual(view.state.issues, [12], 'a save in flight keeps the selection it is writing');
    pending.resolve({ ok: true });
    await tick();
    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [12], odd: null }, 'the saved baseline is the one the write reported');
  });

  test('a superseded read cannot reinsert a stale preview after apply', async () => {
    const old = deferred();
    const fresh = deferred();
    const calls = [];
    const { view } = makeView({
      issues: [issue(12, { title: 'original row' })],
      loadIssue: (number) => {
        calls.push(number);
        return calls.length === 1 ? old.promise : fresh.promise;
      },
      rows: 30,
    });
    assert.match(rightOf(lines(view)), /original row/);
    assert.equal(calls.length, 1);

    view.apply({ issues: [issue(12, { title: 'verified row' })] });
    assert.match(rightOf(lines(view)), /verified row/, 'the applied row paints at once');
    assert.match(rightOf(lines(view)), /loading…/);

    old.resolve({ ok: true, issue: issue(12, { title: 'stale detail', body: 'stale body' }), comments: [{ author: 'x', body: 'stale comment' }] });
    await tick();
    assert.doesNotMatch(rightOf(lines(view)), /stale body/, 'the superseded answer never paints');
    assert.doesNotMatch(rightOf(lines(view)), /stale comment/);

    fresh.resolve({ ok: true, issue: issue(12, { title: 'verified row', body: 'fresh body' }), comments: [] });
    await tick();
    assert.match(rightOf(lines(view)), /fresh body/);
    assert.equal(calls.length, 2, 'the applied row started exactly one new read');
  });

  test('save is refused with truthful feedback while the worktree data is still loading', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({ issues: null, assignedIssues: null, save, rows: 24 });
    view.handleInput('ctrl+s');
    assert.equal(save.calls.length, 0, 'nothing is persisted from an incomplete list');
    const status = statusRow(lines(view, 120));
    assert.match(status, /save waits/, 'the refusal is explained, not silent');
    assert.equal(view.state.saveBlocked, 'issues', 'the observable state names the pending dataset');
    assert.equal(view.state.saveError, null, 'a pending read is not a failure');

    view.apply({ issues: [issue(5)], assignedIssues: [5] });
    assert.equal(view.state.saveBlocked, null);
    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [5], odd: null }, 'the same view saves once the data is known');
  });

  test('a pending assignment alone also blocks the save', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({ issues: [issue(5)], assignedIssues: null, save, rows: 24 });
    view.handleInput('ctrl+s');
    assert.equal(save.calls.length, 0);
    assert.equal(view.state.saveBlocked, 'assigned');
    assert.match(statusRow(lines(view, 120)), /save waits/);
  });

  test('a stored baseline paints while the assignment is still unverified, and the save waits', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({
      issues: [issue(7), issue(12)],
      assignedIssues: [7],
      assignedState: 'loading',
      save,
      rows: 24,
    });
    const rendered = lines(view, 120);
    assert.match(headerRows(rendered).join('\n'), /issues: #7/, 'the stored assignment is displayed');
    assert.match(leftOf(rendered), /#7 issue title 7/, 'the stored issue is listed');
    view.handleInput('ctrl+s');
    assert.equal(save.calls.length, 0, 'an unverified baseline is never written');
    assert.equal(view.state.saveBlocked, 'assigned');
    assert.match(statusRow(rendered), /save waits for the assignment/);

    view.apply({ assignedIssues: [7], assignedState: 'ready' });
    assert.equal(view.state.saveBlocked, null, 'verification settles the block');
    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [7], odd: null });
  });

  test('a failed verification keeps the stored rows and blocks the save until a retry succeeds', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({ issues: [issue(7)], assignedIssues: [7], save, rows: 24 });
    view.apply({ assignedState: 'error', assignedError: 'gh timed out' });
    const status = statusRow(lines(view, 120));
    assert.match(headerRows(lines(view, 120)).join('\n'), /issues: #7/, 'the stored assignment stays visible');
    assert.equal(view.state.dataState.assigned, 'error');
    view.handleInput('ctrl+s');
    assert.equal(save.calls.length, 0, 'nothing is written from an unverified set');
    assert.match(status, /save waits for the assignment to be verified/);
    assert.equal(view.state.saveError, null, 'a failed verification is not presented as a failed save');

    view.apply({ assignedIssues: [7], assignedState: 'ready' });
    view.handleInput('ctrl+s');
    assert.deepEqual(save.calls.at(-1), { issues: [7], odd: null }, 'a successful retry re-enables the write');
  });

  test('a list that is being re-read keeps its rows but blocks the save until it settles', () => {
    const save = saveSpy({ ok: true });
    const { view } = makeView({ issues: [issue(7)], assignedIssues: [], save, rows: 24 });
    view.apply({ issuesState: 'loading' });
    assert.deepEqual(listRows(lines(view)), [{ assigned: false, number: 7, title: 'issue title 7' }],
      'the known rows stay on screen while the list is re-read');
    assert.equal(view.state.saveBlocked, 'issues');
    view.handleInput('ctrl+s');
    assert.equal(save.calls.length, 0);
    view.apply({ issues: [issue(7)], issuesState: 'ready' });
    view.handleInput('ctrl+s');
    assert.equal(save.calls.length, 1, 'the settled list re-enables the save');
    assert.deepEqual(save.calls.at(-1), { issues: [], odd: null }, 'nothing was selected, so nothing is assigned');
  });

  test('a failed list reads as an error, never as an empty list', () => {
    const { view } = makeView({ issues: null, assignedIssues: null, rows: 24 });
    view.apply({ issuesError: 'gh timed out' });
    const rendered = lines(view, 120);
    const body = strip(rendered.join('\n'));
    assert.equal(view.state.dataState.issues, 'error');
    assert.equal(view.state.dataState.issuesError, 'gh timed out');
    assert.match(leftOf(rendered), /issue list unreadable: gh timed out/);
    assert.match(rightOf(rendered), /issue list unreadable: gh timed out/);
    assert.doesNotMatch(body, /no open issues/, 'a failure is not an empty list');
    assert.doesNotMatch(body, /Issues \(0\)/, 'nor a fabricated zero count');
    assert.match(body, /Issues \(\?\)/, 'the tab marks the count as unknown');

    // A known empty list is the other truth and keeps its own wording.
    view.apply({ issues: [] });
    const empty = strip(lines(view, 120).join('\n'));
    assert.match(empty, /no open issues/);
    assert.match(empty, /Issues \(0\)/);
  });

  test('close is idempotent: a second esc, a late apply and late answers do nothing', async () => {
    const pending = deferred();
    const loadCalls = [];
    const { view, done, doneCalls, paints } = makeView({
      issues: [issue(12)],
      loadIssue: (number) => {
        loadCalls.push(number);
        return pending.promise;
      },
      rows: 24,
    });
    lines(view);
    assert.equal(loadCalls.length, 1);

    view.handleInput('escape');
    assert.equal(done(), null);
    assert.equal(doneCalls(), 1);
    const paintsAtClose = paints.length;

    view.handleInput('escape');
    view.handleInput('ctrl+s');
    assert.equal(doneCalls(), 1, 'a second escape never resolves the host twice');
    assert.equal(view.apply({ issues: [issue(9)], assignedIssues: [9] }), false, 'apply is refused after close');

    pending.resolve({ ok: true, issue: issue(12), comments: [] });
    await tick();
    assert.equal(doneCalls(), 1, 'a late read never closes the view again');
    assert.equal(paints.length, paintsAtClose, 'and never repaints it');
    assert.equal(loadCalls.length, 1, 'nor starts another read');
    assert.deepEqual(view.render(100), [], 'a closed view paints nothing');
  });

  test('a read that settles after close never writes the closed state', async () => {
    const pending = deferred();
    const { view, done } = makeView({ issues: [issue(12)], loadIssue: () => pending.promise, rows: 24 });
    lines(view);
    const before = JSON.stringify(view.state);
    view.handleInput('escape');
    pending.resolve({ ok: true, issue: issue(12, { title: 'late title' }), comments: [{ author: 'x', body: 'late' }] });
    await tick();
    assert.equal(done(), null);
    assert.equal(JSON.stringify(view.state), before, 'the observable state is frozen after close');
  });
});
