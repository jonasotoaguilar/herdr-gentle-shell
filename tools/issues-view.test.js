'use strict';
// P2 (issues-view S2-S5,S8,S17-S19) tests: lib/issues-view.js — the pure
// three-bucket issues overlay (list on the left, issue detail on the right).
//
// Contract under test, as observable output only: the component renders
// exactly the requested rows at the requested width; tabs carry counts;
// search opens/filters/leaves keeping the filter; pagination bounds and the
// totals line; selection movement; right-pane scroll to the last line;
// labels/state/author/dates/reactions/comments; assignment toggle/save;
// label editor; comment input; close/reopen confirm; the lazy page/label
// loader seams (S19); open-only totals and the open/closed toggle (S18);
// empty/error/gh-unavailable states; no key outside S8 mutates state.
//
// S17: the generic `?` key-help overlay is gone; the footer legend is the
// only key reference.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createIssuesView } = require('../lib/issues-view.js');
const ghIssues = require('../lib/gh-issues.js');

afterEach(() => {
  ghIssues.setGhRunner(null);
});

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

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text) };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function issue(number, overrides = {}) {
  return {
    number,
    title: `issue title ${number}`,
    state: 'open',
    author: 'octo',
    labels: [{ name: 'bug' }],
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 1800_000).toISOString(),
    commentsCount: 0,
    reactions: { total: 0, plusOne: 3 },
    url: `https://example.test/i/${number}`,
    body: `body of issue ${number}`,
    ...overrides,
  };
}

function pagesOf(lists) {
  const names = ['My issues', 'Assigned', 'Involved'];
  return lists.map((rows, at) => ({ id: `p${at}`, label: names[at], issues: rows, total: rows.length }));
}

function makeView(opts = {}) {
  const paints = [];
  let settled = 'pending';
  const actions = opts.actions || {};
  const view = createIssuesView({
    pages: opts.pages,
    issues: opts.issues,
    loadIssue: opts.loadIssue,
    loadPages: opts.loadPages,
    loadLabels: opts.loadLabels,
    assigned: opts.assigned,
    saveAssignment: opts.saveAssignment,
    actions,
    labels: opts.labels,
    helpers,
    theme: plainTheme,
    rowsAvailable: () => opts.rows || 24,
    requestRender: () => { paints.push(true); },
    done: (result) => { settled = result; },
    checkoutName: opts.checkoutName,
    ghAvailable: opts.ghAvailable,
    loadError: opts.loadError,
    assignmentEnabled: opts.assignmentEnabled,
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

// Pages as the loader seam hands them over: same shape the eager `pages`
// option takes, counts included when the source knows them.
function loadedPage(label, rows, extra = {}) {
  return { id: label.toLowerCase().replace(/\s+/g, '-'), label, issues: rows, total: rows.length, ...extra };
}

function pagesResult(lists, extra = {}) {
  const names = ['My issues', 'Assigned', 'Involved'];
  return {
    ok: true,
    pages: lists.map((rows, at) => ({ id: `p${at}`, label: names[at], issues: rows, total: rows.length })),
    ...extra,
  };
}

function bodyOf(view, width) {
  const lines = view.render(width);
  for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `not ${width} wide: "${strip(line)}"`);
  return strip(lines.join('\n'));
}

describe('issues view tabs and list', () => {
  test('renders the framed card with the three tabs and their counts', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1), issue(2)], [issue(3)], []]),
      issues: [issue(1), issue(2)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    // Width 124: the footer grew by the two mandated copy keys (K4), so
    // the card needs the extra room to show its full tail incl. esc close.
    const body = bodyOf(view, 124);
    assert.match(body, /My issues.*2/, 'first tab carries its count');
    assert.match(body, /Assigned.*1/, 'second tab carries its count');
    assert.match(body, /Involved.*0/, 'third tab carries its count');
    assert.match(body, /issue title 1/, 'the current page rows are listed');
    assert.match(body, /esc close/, 'the footer names the close key');
  });

  test('tab and arrows switch pages; shift+tab goes back', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [issue(2)], [issue(3)]]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 100), /issue title 1/);
    view.handleInput('tab');
    assert.equal(view.state.page, 1);
    assert.match(bodyOf(view, 100), /issue title 2/);
    view.handleInput('right');
    assert.equal(view.state.page, 2);
    view.handleInput('shift+tab');
    assert.equal(view.state.page, 1);
    view.handleInput('left');
    assert.equal(view.state.page, 0);
  });

  test('up/down and j/k move the selection; home/end jump', async () => {
    const rows = [issue(1), issue(2), issue(3)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('down');
    assert.equal(view.state.index, 1);
    view.handleInput('j');
    assert.equal(view.state.index, 2);
    view.handleInput('up');
    assert.equal(view.state.index, 1);
    view.handleInput('k');
    assert.equal(view.state.index, 0);
    view.handleInput('end');
    assert.equal(view.state.index, 2);
    view.handleInput('home');
    assert.equal(view.state.index, 0);
  });

  test('the totals line uses the singular "1 issue" for exactly one issue', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /1 issue\b/, 'exactly one renders the singular');
    assert.ok(!body.includes('1 issues'), 'exactly one never renders the plural');
  });

  test('pagination bounds and the totals line name the filtered count, never the total', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => issue(i + 1));
    const { view } = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.state.pageSize = 4;
    const first = bodyOf(view, 100);
    assert.match(first, /page 1\/3 · 10 issues/, 'totals line shows page and count');
    view.handleInput(']');
    view.handleInput(']');
    view.handleInput(']');
    assert.equal(view.state.listPage, 3, 'never past the last page');
    assert.match(bodyOf(view, 100), /page 3\/3 · 10 issues/);
    view.handleInput('[');
    assert.equal(view.state.listPage, 2);
    view.handleInput('[');
    view.handleInput('[');
    assert.equal(view.state.listPage, 1, 'never before the first page');
  });

  test('state filter f toggles open-only versus closed-only, never both', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 100), /issue title 1/);
    assert.ok(!bodyOf(view, 100).includes('issue title 2'), 'closed hidden by default');
    view.handleInput('f');
    const closed = bodyOf(view, 100);
    assert.match(closed, /issue title 2/, 'f shows the closed issues');
    assert.ok(!closed.includes('issue title 1'), 'closed view excludes the open rows');
    view.handleInput('f');
    const open = bodyOf(view, 100);
    assert.match(open, /issue title 1/, 'f returns to the open issues');
    assert.ok(!open.includes('issue title 2'), 'the open view excludes closed rows');
  });
});

describe('issues view search', () => {
  test('the idle search row reads as a search widget, never the broken "T// search"', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.ok(!body.includes('T// search'), 'the broken hint is gone');
    assert.match(body, /› Search \(T\)/, 'the idle row names the Search widget and its key');
  });

  test('T opens the box, typing filters live, Enter leaves keeping the filter', async () => {
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    assert.equal(view.state.searching, true);
    for (const ch of 'beta') view.handleInput(ch);
    const filtered = bodyOf(view, 100);
    assert.match(filtered, /issue title 2/);
    assert.ok(!filtered.includes('alpha crash'), 'live filter hides the other row');
    view.handleInput('enter');
    assert.equal(view.state.searching, false);
    assert.equal(view.state.query, 'beta', 'the filter is kept after leaving');
    assert.ok(!bodyOf(view, 100).includes('alpha crash'));
  });

  test('/ also opens; Esc leaves keeping the filter; @ and # tokens filter', async () => {
    const rows = [
      issue(7, { title: 'login flow', author: 'alice' }),
      issue(8, { title: 'logout flow', author: 'bob' }),
    ];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('/');
    for (const ch of '@bob') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /issue title 8/);
    view.handleInput('escape');
    assert.equal(view.state.searching, false);
    assert.equal(view.state.query, '@bob');
    view.handleInput('T');
    view.state.query = '';
    view.state.searching = true;
    for (const ch of '#7') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /issue title 7/);
    assert.ok(!bodyOf(view, 100).includes('issue title 8'), '#number selects the issue');
  });
});

describe('issues view right pane', () => {
  test('renders labels, state, author, dates, reactions, body and separated comments', async () => {
    const comments = [
      { id: 1, author: 'bob', createdAt: new Date(Date.now() - 600_000).toISOString(), body: 'first comment', reactions: { total: 1, plusOne: 2 } },
      { id: 2, author: 'carol', createdAt: new Date(Date.now() - 300_000).toISOString(), body: 'second comment', reactions: { total: 0, plusOne: 0 } },
    ];
    const { view } = makeView({
      pages: pagesOf([[issue(1, { title: 'Big bug', labels: [{ name: 'bug' }, { name: 'urgent' }] })], [], []]),
      issues: [issue(1, { title: 'Big bug', labels: [{ name: 'bug' }, { name: 'urgent' }] })],
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'Big bug', labels: [{ name: 'bug' }, { name: 'urgent' }] }), comments }),
      rows: 30,
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /Big bug/);
    assert.match(body, /open/);
    assert.match(body, /bug/, 'labels row names the labels');
    assert.match(body, /urgent/);
    assert.match(body, /octo/, 'author is shown');
    assert.match(body, /created/, 'created date is shown');
    assert.match(body, /updated/, 'updated date is shown');
    assert.match(body, /👍 3/, 'reactions are shown');
    assert.match(body, /2 comments/);
    assert.match(body, /first comment/);
    assert.match(body, /second comment/);
    assert.match(body, /bob/);
    assert.match(body, /carol/);
  });

  test('ctrl+j/pgDn scroll to the last line of a long issue; home resets to the top', async () => {
    const longBody = Array.from({ length: 100 }, (_, i) => `body line ${i + 1}`).join('\n');
    const { view } = makeView({
      pages: pagesOf([[issue(1, { body: longBody })], [], []]),
      issues: [issue(1, { body: longBody })],
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('ctrl+j');
    assert.ok(view.state.scroll > 0, 'ctrl+j scrolls the issue pane');
    for (let i = 0; i < 20 && !bodyOf(view, 100).includes('body line 100'); i += 1) view.handleInput('pagedown');
    const bottom = bodyOf(view, 100);
    assert.match(bottom, /body line 100/, 'the last line is reachable via the pane scroll keys');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0);
  });

  test('a failed loadIssue renders its error instead of fake content', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: () => ({ ok: false, error: 'boom' }),
    });
    await tick();
    assert.match(bodyOf(view, 100), /boom/);
  });
});

describe('issues view assignment', () => {
  test('stored marks show ✓, space toggles ✎ locally, ctrl+s saves, failure keeps marks', async () => {
    const calls = [];
    const rows = [issue(1), issue(2)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      assigned: [1],
      saveAssignment: (nums) => { calls.push(nums); return { ok: true }; },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    let body = bodyOf(view, 100);
    assert.match(body.split('\n').find((l) => l.includes('issue title 1')), /✓/);
    view.handleInput('down');
    view.handleInput('space');
    body = bodyOf(view, 100);
    assert.match(body, /unsaved/);
    assert.deepEqual(calls, [], 'toggle alone never saves');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(calls, [[[1, 2]][0]], 'the whole pending set is saved');
    body = bodyOf(view, 100);
    assert.ok(!body.includes('unsaved'), 'success clears the indicator');

    const failCalls = [];
    const second = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      assigned: [],
      saveAssignment: (nums) => { failCalls.push(nums); return { ok: false, error: 'disk full' }; },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    second.view.handleInput('space');
    second.view.handleInput('ctrl+s');
    await tick();
    const failed = bodyOf(second.view, 100);
    assert.match(failed, /save failed: disk full/);
    assert.match(failed, /unsaved/);
    assert.equal(failCalls.length, 1);
  });
});

describe('issues view editors and confirmations', () => {
  test('L opens the label editor; toggle plus create plus ctrl+s applies', async () => {
    const calls = [];
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      actions: {
        editLabels: (number, add, remove, created) => { calls.push([number, add, remove, created]); return { ok: true }; },
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { labels: [{ name: 'bug' }] }), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    assert.equal(view.state.mode, 'labels');
    let body = bodyOf(view, 100);
    assert.match(body, /bug/);
    assert.match(body, /docs/);
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(calls.length, 1, 'one apply call');
    assert.deepEqual(calls[0][0], 1);
    assert.ok(calls[0][1].includes('docs'), 'docs was added');
    assert.equal(view.state.mode, 'list', 'success closes the editor');
  });

  test('a failed label apply keeps the editor and shows the error', async () => {
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      actions: { editLabels: () => ({ ok: false, error: 'nope' }) },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { labels: [{ name: 'bug' }] }), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'labels', 'failure keeps the editor open');
    assert.match(bodyOf(view, 100), /nope/);
  });

  test('c opens the comment input; Enter is a newline, ctrl+s posts, esc asks before discarding', async () => {
    const calls = [];
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: { postComment: (number, text) => { calls.push([number, text]); return { ok: true }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('c');
    assert.equal(view.state.mode, 'comment');
    for (const ch of 'hi') view.handleInput(ch);
    view.handleInput('enter');
    for (const ch of 'there') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /hi/);
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [1, 'hi\nthere']);
    assert.equal(view.state.mode, 'list');

    view.handleInput('c');
    for (const ch of 'draft') view.handleInput(ch);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'esc on a non-empty draft asks instead of discarding');
    assert.match(bodyOf(view, 100), /Discard this draft/, 'the ask names what is at stake');
    view.handleInput('y');
    assert.equal(view.state.mode, 'list', 'y discards the draft');
    assert.equal(calls.length, 1, 'discard posts nothing');
  });

  test('a failed comment post keeps the draft and shows the error', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: { postComment: () => ({ ok: false, error: 'rate limited' }) },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'hey') view.handleInput(ch);
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'comment');
    assert.match(bodyOf(view, 100), /rate limited/);
  });

  test('x asks to close and X asks to reopen; confirm runs setState', async () => {
    const calls = [];
    const openRows = [issue(1, { state: 'open' })];
    const first = makeView({
      pages: pagesOf([openRows, [], []]),
      issues: openRows,
      actions: { setState: (number, state) => { calls.push([number, state]); return { ok: true }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    first.view.handleInput('x');
    assert.equal(first.view.state.mode, 'confirm');
    assert.match(bodyOf(first.view, 100), /close/i);
    first.view.handleInput('enter');
    await tick();
    assert.deepEqual(calls, [[1, 'closed']]);

    const closedRows = [issue(9, { state: 'closed' })];
    const second = makeView({
      pages: pagesOf([closedRows, [], []]),
      issues: closedRows,
      actions: { setState: (number, state) => { calls.push([number, state]); return { ok: true }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { state: 'closed' }), comments: [] }),
    });
    await tick();
    second.view.state.showClosed = true;
    second.view.handleInput('X');
    assert.equal(second.view.state.mode, 'confirm');
    second.view.handleInput('enter');
    await tick();
    assert.deepEqual(calls[1], [9, 'open']);
  });

  test('o opens in the browser without changing state; r reloads', async () => {
    let opened = null;
    let rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: {
        openBrowser: (number) => { opened = number; return { ok: true }; },
        reload: () => ({ ok: true, issues: [issue(1), issue(5, { title: 'fresh issue' })] }),
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const before = JSON.stringify({ page: view.state.page, index: view.state.index });
    view.handleInput('o');
    assert.equal(opened, 1);
    assert.equal(JSON.stringify({ page: view.state.page, index: view.state.index }), before);
    view.handleInput('r');
    await tick();
    assert.match(bodyOf(view, 100), /fresh issue/);
  });

  test('the generic ? help overlay is gone and the footer legend stays (S17)', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const before = bodyOf(view, 160);
    assert.ok(!before.includes('? help'), 'no ? hint anywhere');
    assert.ok(!before.includes('Keys'), 'no key-help overlay before the key');
    view.handleInput('?');
    const after = bodyOf(view, 160);
    assert.equal(after, before, '? repaints nothing: there is no overlay to open');
    assert.equal(view.state.help, undefined, 'no help state survives');
    assert.match(after, /esc close/, 'the footer shortcut legend survives');
    assert.match(after, /f open\/closed/, 'the footer documents the open/closed key');
  });
});

describe('issues view states and key discipline', () => {
  test('empty page renders the empty state, not fake rows', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 80), /no issues/i);
  });

  test('loadError renders the error state', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      loadError: 'network down',
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 80), /network down/);
  });

  test('gh unavailable renders its own state', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      ghAvailable: false,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 80), /gh unavailable/i);
  });

  test('end selects the last issue and leaves the detail scroll at the top', async () => {
    const longBody = Array.from({ length: 60 }, (_, i) => `body line ${i + 1}`).join('\n');
    const rows = [issue(1, { body: longBody }), issue(2, { body: longBody }), issue(3, { body: longBody })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('ctrl+j');
    assert.ok(view.state.scroll > 0, 'precondition: the pane is scrolled');
    view.handleInput('end');
    assert.equal(view.state.index, 2, 'end selects the last issue');
    assert.equal(view.state.scroll, 0, 'end resets the newly selected issue to its top');
    const bottom = bodyOf(view, 100);
    assert.match(bottom, /body line 1/, 'the top of the last issue is shown, not the scrolled bottom');
  });

  test('home selects the first issue and leaves the detail scroll at the top', async () => {
    const longBody = Array.from({ length: 60 }, (_, i) => `body line ${i + 1}`).join('\n');
    const rows = [issue(1, { body: longBody }), issue(2, { body: longBody }), issue(3, { body: longBody })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('end');
    view.handleInput('ctrl+j');
    assert.ok(view.state.scroll > 0, 'precondition: the pane is scrolled');
    view.handleInput('home');
    assert.equal(view.state.index, 0, 'home selects the first issue');
    assert.equal(view.state.scroll, 0, 'home resets the newly selected issue to its top');
    const top = bodyOf(view, 100);
    assert.match(top, /body line 1/, 'the top of the first issue is shown');
  });

  test('a truncated fetch renders the totals line with N+ and a plain fetch renders N', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    const truncated = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length, truncated: true }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(truncated.view, 100), /5\+ issues/, 'truncated totals line carries the + marker');
    const plain = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(plain.view, 100), /5 issues/, 'plain totals line has no + marker');
    assert.ok(!bodyOf(plain.view, 100).includes('5+ issues'), 'plain totals line never carries +');
  });

  test('esc closes with null; no key outside S8 changes state', async () => {
    const { view, done } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const snapshot = JSON.stringify(view.state);
    const rendered = view.render(80).join('\n');
    for (const key of ['e', 'p', 'z', 'a', 'd', 'w', 'v', 'u', 'g', 'i', 'm', 'h', 'b', 's', 'n', 'ctrl+u', 'ctrl+d', 'alt+x']) {
      view.handleInput(key);
    }
    assert.equal(JSON.stringify(view.state), snapshot, 'foreign keys change nothing');
    assert.equal(view.render(80).join('\n'), rendered, 'foreign keys repaint nothing');
    view.handleInput('escape');
    assert.equal(done(), null);
  });
});

describe('issues view relative dates past a month (adopted reference idea 2)', () => {
  const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const DAY = 86400_000;

  function datedView(createdAgo, updatedAgo) {
    return makeView({
      pages: pagesOf([[issue(1, { createdAt: at(createdAgo), updatedAt: at(updatedAgo) })], [], []]),
      issues: [issue(1, { createdAt: at(createdAgo), updatedAt: at(updatedAgo) })],
      rows: 30,
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { createdAt: at(createdAgo), updatedAt: at(updatedAgo) }),
        comments: [],
      }),
    });
  }

  test('renders mo and y units instead of an ISO date', async () => {
    const { view } = datedView(60 * DAY, 400 * DAY);
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /2mo ago/, 'sixty days renders as months');
    assert.match(body, /1y ago/, 'four hundred days renders as years');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(body), 'no ISO date fallback for old dates');
  });

  test('month/year boundaries cut at 30 days and 365 days', async () => {
    const first = datedView(29 * DAY, 29 * DAY);
    await tick();
    assert.match(bodyOf(first.view, 100), /29d ago/, 'twenty-nine days still renders as days');
    const second = datedView(30 * DAY, 364 * DAY);
    await tick();
    const middle = bodyOf(second.view, 100);
    assert.match(middle, /1mo ago/, 'thirty days renders as one month');
    assert.match(middle, /12mo ago/, '364 days still renders as months');
    const third = datedView(365 * DAY, 730 * DAY);
    await tick();
    const old = bodyOf(third.view, 100);
    assert.match(old, /1y ago/);
    assert.match(old, /2y ago/);
  });

  test('keeps just now, minutes, hours and days', async () => {
    const now = datedView(10_000, 5 * 60_000);
    await tick();
    const fresh = bodyOf(now.view, 100);
    assert.match(fresh, /just now/);
    assert.match(fresh, /5m ago/);
    const hours = datedView(3 * 3600_000, 9 * DAY);
    await tick();
    const older = bodyOf(hours.view, 100);
    assert.match(older, /3h ago/);
    assert.match(older, /9d ago/);
  });
});

describe('issues view detail assignees (adopted reference idea 1)', () => {
  test('the detail shows one assignee row when the issue is assigned', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 30,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { assignees: ['alice', 'bob'] }), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 100), /assignees: alice, bob/);
  });

  test('the detail hides the assignee row when nobody is assigned', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 30,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.ok(!bodyOf(view, 100).includes('assignees'), 'no assignee row without assignees');
  });
});

describe('issues view clipboard copy y/Y (adopted reference idea 3)', () => {
  test('y copies the issue number through the injected writer', async () => {
    const calls = [];
    const rows = [issue(76, { title: 'copy me' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: { copyText: (text) => { calls.push(text); return { ok: true, via: 'test-clipboard' }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'copy me' }), comments: [] }),
    });
    await tick();
    view.handleInput('y');
    await tick();
    assert.deepEqual(calls, ['76']);
    assert.match(bodyOf(view, 100), /Copied 76 to clipboard/);
  });

  test('Y copies the already-loaded URL without another loadIssue call', async () => {
    let loads = 0;
    const url = 'https://example.test/i/76';
    const rows = [issue(76, { url })];
    const copies = [];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: { copyText: (text) => { copies.push(text); return { ok: true, via: 'test' }; } },
      loadIssue: (n) => {
        loads += 1;
        return { ok: true, issue: issue(n, { url }), comments: [] };
      },
    });
    await tick();
    const settled = loads;
    view.handleInput('Y');
    await tick();
    assert.deepEqual(copies, [url]);
    assert.equal(loads, settled, 'the URL comes from the loaded issue, never a new fetch');
    assert.match(bodyOf(view, 100), /Copied https:\/\/example\.test\/i\/76 to clipboard/);
  });

  test('an honest miss never pretends it copied', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(76)], [], []]),
      issues: [issue(76)],
      actions: { copyText: () => ({ ok: false, error: 'no clipboard tool available' }) },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('y');
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /clipboard unavailable/);
    assert.match(body, /nothing copied/);
    assert.ok(!body.includes('Copied'), 'a miss never claims success');
  });

  test('the footer names the two copy keys', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(view, 120), /y\/Y copy/);
  });
});

describe('issues view comment discard confirmation (adopted reference idea 4)', () => {
  function commentView(post) {
    return makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: { postComment: post },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
  }

  test('esc on a non-empty draft asks once; n keeps editing with the text intact', async () => {
    const { view } = commentView(() => ({ ok: true }));
    await tick();
    view.handleInput('c');
    for (const ch of 'keep me') view.handleInput(ch);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'still editing after the first esc');
    assert.match(bodyOf(view, 100), /Discard this draft\? \(y discard/);
    view.handleInput('n');
    assert.equal(view.state.mode, 'comment', 'n returns to editing');
    assert.equal(view.state.commentText, 'keep me', 'the draft survives the round trip');
    assert.match(bodyOf(view, 100), /keep me/);
  });

  test('esc at the ask returns to editing too', async () => {
    const { view } = commentView(() => ({ ok: true }));
    await tick();
    view.handleInput('c');
    for (const ch of 'keep me') view.handleInput(ch);
    view.handleInput('escape');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'esc at the ask returns to editing');
    assert.equal(view.state.commentText, 'keep me');
  });

  test('y at the ask discards the draft without posting', async () => {
    const calls = [];
    const { view } = commentView((number, text) => { calls.push([number, text]); return { ok: true }; });
    await tick();
    view.handleInput('c');
    for (const ch of 'throw away') view.handleInput(ch);
    view.handleInput('escape');
    view.handleInput('y');
    await tick();
    assert.equal(view.state.mode, 'list');
    assert.equal(view.state.commentText, '');
    assert.deepEqual(calls, [], 'discarding posts nothing');
  });

  test('esc on an empty draft discards at once without asking', async () => {
    const { view } = commentView(() => ({ ok: true }));
    await tick();
    view.handleInput('c');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list', 'an empty draft needs no confirmation');
  });
});

describe('issues view comments render whole (adopted reference idea 5: no silent cut)', () => {
  test('renders every comment with no silent cut and no cut line', async () => {
    const now = new Date().toISOString();
    const comments = Array.from({ length: 25 }, (_, i) => ({
      id: i, author: 'alice', createdAt: now, body: `comment body ${i}`, reactions: { total: 0, plusOne: 0 },
    }));
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 130,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /comment body 0/);
    assert.match(body, /comment body 24/, 'the last comment renders too');
    assert.ok(!body.includes('showing last'), 'no cut means no cut line');
  });
});

describe('issues view lazy page loading (S19)', () => {
  test('mount paints an honest loading state instead of claiming zero issues', async () => {
    const gate = deferred();
    const { view } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const wide = bodyOf(view, 160);
    assert.match(wide, /loading issues/, 'the wait is named');
    assert.ok(!/0 issues/.test(wide), 'a pending fetch never renders a zero count');
    assert.ok(!/page 1\/1/.test(wide), 'a pending fetch renders no totals line');
    assert.match(wide, /esc close/, 'the footer legend is there from the first paint');

    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    const loaded = bodyOf(view, 160);
    assert.match(loaded, /issue title 1/, 'the first paint after the fetch lists the rows');
    assert.match(loaded, /My issues \(1\)/);
  });

  test('mounting and the first render never block on the fetch', async () => {
    const gate = deferred();
    const started = Date.now();
    const { view } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const painted = strip(view.render(80).join('\n'));
    const elapsed = Date.now() - started;
    assert.match(painted, /loading issues/);
    // The gate is still open: a blocking mount could not have painted at all.
    assert.ok(elapsed < 150, `mount plus first paint took ${elapsed}ms with the fetch pending`);
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
  });

  test('the loader is asked for the filter state and its rows replace the pages', async () => {
    const asked = [];
    const { view } = makeView({
      loadPages: ({ state }) => {
        asked.push(state);
        return pagesResult([[issue(1), issue(2, { state: 'closed' })], [issue(3)], [issue(4)]]);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.deepEqual(asked, ['open'], 'the first fetch asks for the default state');
    const body = bodyOf(view, 80);
    assert.match(body, /My issues/);
    assert.match(body, /Assigned/);
    assert.match(body, /Involved/);
    view.handleInput('tab');
    assert.match(bodyOf(view, 80), /issue title 3/, 'each page keeps its own rows');
  });

  test('a failed load renders the honest error and paints no fake rows', async () => {
    const { view } = makeView({
      loadPages: () => ({ ok: false, error: 'gh issue list failed: HTTP 401: Bad credentials' }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /failed to load issues: gh issue list failed: HTTP 401: Bad credentials/);
    assert.ok(!body.includes('issue title'), 'no rows were invented');
    assert.match(bodyOf(view, 160), /esc close/, 'the footer legend survives the error');
  });

  test('a partially failed load keeps the pages it has and names the failure', async () => {
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1)], [], []], { loadError: 'gh issue list failed: timed out' }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 160);
    assert.match(body, /issue title 1/, 'the pages that did load render');
    assert.match(body, /timed out/, 'the failure is named, never hidden');
  });

  test('a stale state response never wins over the newest request', async () => {
    const pending = [];
    const { view } = makeView({
      loadPages: ({ state }) => {
        const entry = deferred();
        pending.push({ state, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    assert.deepEqual(pending.map((p) => p.state), ['open']);
    view.handleInput('f');
    view.handleInput('f');
    assert.deepEqual(pending.map((p) => p.state), ['open', 'closed', 'open'], 'each toggle asks for its own state');
    const newest = pending[2].entry;
    const stale = pending[1].entry;
    newest.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    stale.resolve(pagesResult([[issue(2, { state: 'closed' })], [], []]));
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(1\)/, 'the newest open-only answer is the one shown');
    assert.match(body, /issue title 1/, 'the newest open answer paints its row');
    assert.ok(!body.includes('issue title 2'), 'the stale closed answer never paints');
  });

  test('closing stops every later repaint and a late load changes nothing', async () => {
    const gate = deferred();
    const { view, done, paints } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const before = paints.length;
    view.handleInput('escape');
    assert.equal(done(), null, 'esc still closes with null');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    assert.equal(paints.length, before, 'a late answer repaints nothing after close');
  });
});

describe('issues view open-only totals and the open/closed toggle (S18)', () => {
  // A state-honest source, like `gh --state <state>`: each state carries
  // only its own rows and its own total. The view only ever asks for one of
  // the two states, never a combined all.
  function stateSource(rows) {
    const asked = [];
    const pages = (state) => {
      asked.push(state);
      const matching = rows.filter((row) => String(row.state || 'open') === state);
      return pagesResult([matching, [], []]);
    };
    return { asked, pages };
  }

  test('the default fetch asks for open and the tab names the open count only', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' }), issue(3, { state: 'closed' })];
    const source = stateSource(rows);
    const { view } = makeView({
      loadPages: ({ state }) => source.pages(state),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.deepEqual(source.asked, ['open'], 'the first fetch asks gh for open only');
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(1\)/, 'the tab counts the open row it lists');
    assert.ok(!body.includes('My issues (3)'), 'the all-state total is never shown while only open issues list');
    assert.ok(!body.includes('issue title 2'), 'closed rows stay out of the list');
    assert.match(body, /page 1\/1 · 1 issue\b/, 'the totals line agrees with the tab');
    assert.match(body, /f:open/, 'the visible hint names the current filter');
    assert.match(bodyOf(view, 160), /f open\/closed/, 'the footer documents the toggle');
  });

  test('an all-state total never inflates the open count (reported symptom)', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' }), issue(3, { state: 'closed' })];
    const { view } = makeView({
      // A source that answers an open request with every state and an
      // all-state total: the counts must follow the rows actually shown.
      loadPages: () => pagesResult([rows, [], []]),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(1\)/, 'the tab counts the one open issue it lists');
    assert.ok(!body.includes('My issues (3)'), 'closed issues never inflate the open tab');
    assert.match(body, /page 1\/1 · 1 issue\b/, 'the totals line agrees');
    assert.ok(!body.includes('issue title 2'), 'no closed row is listed under open');
  });

  test('f asks for closed: only closed rows list and the counts are the closed ones', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' }), issue(3, { state: 'closed' })];
    const source = stateSource(rows);
    const asked = [];
    const { view } = makeView({
      loadPages: ({ state }) => source.pages(state),
      actions: {
        reload: ({ state }) => { asked.push(`reload:${state}`); return source.pages(state); },
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('f');
    await tick();
    assert.deepEqual(source.asked, ['open', 'closed'], 'the toggle asks gh for closed, never for all');
    assert.deepEqual(asked, ['reload:closed'], 'the toggle refetches through the reload seam with the new state');
    const closed = bodyOf(view, 80);
    assert.match(closed, /My issues \(2\)/, 'the tab counts the closed rows it lists');
    assert.match(closed, /issue title 2/);
    assert.match(closed, /issue title 3/);
    assert.ok(!closed.includes('issue title 1'), 'the closed view excludes the open row');
    assert.match(closed, /f:closed/, 'the hint follows the filter');
    assert.match(closed, /page 1\/1 · 2 issues/, 'the totals line follows the filter too');
    assert.ok(!closed.includes('all'), 'no combined all state is ever offered');
    view.handleInput('f');
    await tick();
    assert.deepEqual(asked, ['reload:closed', 'reload:open'], 'toggling back asks for open again');
    const open = bodyOf(view, 80);
    assert.match(open, /My issues \(1\)/, 'the tab is the open count again');
    assert.match(open, /issue title 1/, 'the open row is back');
    assert.ok(!open.includes('issue title 2'), 'toggling back hides closed rows again');
    assert.match(open, /f:open/);
    assert.equal(view.state.index, 0, 'the selection is reset to the first row of the new state');
    assert.equal(view.state.listPage, 1, 'the list page is reset too');
    assert.equal(view.state.scroll, 0, 'the detail scroll is reset too');
  });

  test('a bounded fetch marks the tab count and the totals line with +', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    const { view } = makeView({
      loadPages: () => ({
        ok: true,
        pages: [{ id: 'p0', label: 'My issues', issues: rows, total: 500, truncated: true }],
      }),
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(500\+\)/, 'the tab marks the bounded count');
    assert.match(body, /5\+ issues/, 'the totals line marks the bounded count');
  });

  test('opening, searching and the state toggle issue no write action', async () => {
    const writes = [];
    const rows = [issue(1), issue(2, { state: 'closed' })];
    const { view } = makeView({
      loadPages: ({ state }) => pagesResult([
        rows.filter((row) => (row.state || 'open') === state), [], [],
      ]),
      loadLabels: () => ({ ok: true, labels: [{ name: 'bug' }] }),
      actions: {
        reload: ({ state }) => pagesResult([rows.filter((row) => (row.state || 'open') === state), [], []]),
        editLabels: () => { writes.push('editLabels'); return { ok: true }; },
        postComment: () => { writes.push('postComment'); return { ok: true }; },
        setState: () => { writes.push('setState'); return { ok: true }; },
        openBrowser: () => { writes.push('openBrowser'); return { ok: true }; },
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'issue') view.handleInput(ch);
    view.handleInput('enter');
    view.handleInput('f');
    await tick();
    view.handleInput('tab');
    view.handleInput('down');
    assert.deepEqual(writes, [], 'no key outside the four write actions writes');
  });
});
describe('issues view lazy labels (S19)', () => {
  test('labels load on the first L, never at mount, and only once', async () => {
    let labelCalls = 0;
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1, { labels: [{ name: 'bug' }] })], [], []]),
      loadLabels: () => {
        labelCalls += 1;
        return { ok: true, labels: [{ name: 'bug' }, { name: 'docs' }] };
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.equal(labelCalls, 0, 'opening the view never fetches labels');
    view.handleInput('L');
    await tick();
    assert.equal(labelCalls, 1, 'the first L fetches them');
    const body = bodyOf(view, 80);
    assert.match(body, /docs/, 'the editor lists the fetched labels');
    view.handleInput('escape');
    view.handleInput('L');
    await tick();
    assert.equal(labelCalls, 1, 'a second open reuses the loaded labels');
  });

  test('a label load failure is shown honestly and retried on the next open', async () => {
    let labelCalls = 0;
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1, { labels: [{ name: 'bug' }] })], [], []]),
      loadLabels: () => {
        labelCalls += 1;
        return { ok: false, error: 'gh label list failed: rate limited' };
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    await tick();
    const body = bodyOf(view, 160);
    assert.match(body, /labels unreadable: gh label list failed: rate limited/);
    assert.match(body, /\+ create new/, 'creating a new label stays reachable');
    view.handleInput('escape');
    view.handleInput('L');
    await tick();
    assert.equal(labelCalls, 2, 'reopening the editor retries the failed fetch');
  });

  test('a pending label fetch shows the wait and only esc leaves the editor', async () => {
    const gate = deferred();
    const { view } = makeView({
      loadPages: () => pagesResult([[issue(1)], [], []]),
      loadLabels: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    const loading = bodyOf(view, 80);
    assert.match(loading, /loading labels/);
    view.handleInput('space');
    assert.equal(view.state.labelIndex, 0, 'toggling waits for the real list');
    gate.resolve({ ok: true, labels: [{ name: 'bug' }] });
    await tick();
    assert.match(bodyOf(view, 80), /bug/, 'the labels land in the open editor');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list');
  });
});

describe('issues view over the real gh client (argv, status, stderr)', () => {
  test('reads ask for the requested state, and a gh failure surfaces honestly', async () => {
    const calls = [];
    ghIssues.setGhRunner((bin, argv) => {
      calls.push(argv.slice());
      if (argv[0] === 'issue' && argv[1] === 'list') {
        return { status: 1, stdout: '', stderr: 'HTTP 401: Bad credentials', error: null };
      }
      return { status: 0, stdout: '[]', stderr: '', error: null };
    });
    const { view } = makeView({
      loadPages: ({ state }) => ghIssues.listIssues({ query: 'author:@me', state, page: 1, pageSize: 30 }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'crash') view.handleInput(ch);
    view.handleInput('enter');
    view.handleInput('f');
    await tick();
    const lists = calls.filter((argv) => argv[0] === 'issue' && argv[1] === 'list');
    assert.equal(lists.length, 2, 'one read per requested state');
    assert.deepEqual(
      lists.map((argv) => argv[argv.indexOf('--state') + 1]),
      ['open', 'closed'],
      'the default read is open, the toggle reads closed',
    );
    assert.ok(lists.every((argv) => argv.includes('--search')), 'each read carries the page query');
    const body = bodyOf(view, 80);
    assert.match(body, /failed to load issues: gh issue list failed: HTTP 401: Bad credentials/);
    const writes = calls.filter((argv) => argv[0] === 'issue'
      && ['edit', 'comment', 'close', 'reopen'].includes(argv[1]));
    assert.deepEqual(writes, [], 'opening, searching and toggling write nothing');
  });

  test('eagerly supplied pages keep naming their reported total (legacy contract)', async () => {
    const { view } = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: [issue(1)], total: 45 }],
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(45\)/, 'the eager page keeps its own reported total');
    assert.match(body, /1 issue\b/, 'the totals line still names the loaded rows');
  });
});

describe('issues view concise header (S25)', () => {
  const CHECKOUT = 'feat-yolo-worktree-confirmations';

  test('the header never repeats the checkout and keeps the counts and filter', async () => {
    const { view } = makeView({
      checkoutName: CHECKOUT,
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const header = strip(view.render(80)[0]);
    assert.match(header, /◈ Issues · My issues/, 'the header names the surface and the active bucket');
    assert.ok(!header.includes(CHECKOUT), 'the header never repeats the checkout/branch');
    assert.ok(!bodyOf(view, 80).includes(CHECKOUT), 'no part of the frame repeats the checkout');
    assert.ok(!/#\d/.test(header), 'the header repeats no issue id the list or preview already shows');
    const body = bodyOf(view, 160);
    assert.match(body, /My issues \(1\)/, 'the tab count survives the trim');
    assert.match(body, /f:open/, 'the filter hint survives the trim');
    assert.match(body, /page 1\/1 · 1 issue\b/, 'the totals line survives the trim');
    assert.match(body, /f open\/closed/, 'the footer toggle legend survives the trim');
    view.handleInput('space');
    assert.match(
      strip(view.render(80).join('\n')),
      /◈ Issues · My issues · unsaved/,
      'the relevant pending-assignment state stays in the header',
    );
  });

  test('the loading header is the surface name alone, with no checkout', async () => {
    const gate = deferred();
    const { view } = makeView({
      checkoutName: CHECKOUT,
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const loading = bodyOf(view, 160);
    assert.match(loading, /◈ Issues/, 'the header still names the surface');
    assert.ok(!loading.includes(CHECKOUT), 'the loading header repeats no checkout');
    assert.match(loading, /loading issues/, 'the loading state survives');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    assert.ok(!bodyOf(view, 160).includes(CHECKOUT), 'the loaded frame repeats no checkout either');
  });
});

describe('issues view dedicated search row (S26)', () => {
  function chrome(view, width) {
    return view.render(width).map(strip);
  }

  test('the search widget sits directly below the title and the tabs follow it', async () => {
    const { view } = makeView({
      checkoutName: 'feat-yolo-worktree-confirmations',
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 160]) {
      const lines = chrome(view, width);
      assert.match(lines[0], /◈ Issues · My issues/, 'row 1 is the concise title');
      assert.ok(!/search/i.test(lines[0]), 'the title buries nothing about search');
      assert.match(lines[1], /› Search \(T\)/, 'row 2 is the dedicated Search widget');
      assert.match(lines[2], /My issues \(1\)/, 'row 3 carries the tabs and their counts');
      assert.match(lines[2], /Assigned \(0\)/, 'every tab count stays');
      assert.match(lines[3], /f:open/, 'row 4 keeps the open/closed state visible');
      assert.equal(lines.length, 24, 'the chrome plus body still fills the terminal exactly');
    }
  });

  test('an active query renders in the search widget at 80 and 160', async () => {
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'beta') view.handleInput(ch);
    for (const width of [80, 160]) {
      const lines = chrome(view, width);
      assert.match(lines[1], /› beta█/, 'the query renders in the search widget');
      assert.match(lines[1], /enter\/esc keep/, 'the editing hint stays with the input');
      assert.match(lines[2], /My issues/, 'the tabs stay below the search row');
      assert.match(lines[3], /f:open/, 'the filter state stays visible while typing');
    }
    view.handleInput('enter');
    const settled = chrome(view, 80);
    assert.match(settled[1], /› beta \(T to edit\)/, 'a kept filter shows its query in the widget');
    assert.ok(!settled.join('\n').includes('alpha crash'), 'the kept filter still filters the list');
  });

  test('errors and notices keep their own visible row, even while typing', async () => {
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      assigned: [],
      saveAssignment: () => ({ ok: false, error: 'disk full' }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    let lines = chrome(view, 80);
    assert.match(lines[3], /f:open/, 'the state stays on its own row');
    assert.match(lines[3], /save failed: disk full/, 'the notice lands on the state row');
    view.handleInput('T');
    view.handleInput('1');
    lines = chrome(view, 80);
    assert.match(lines[1], /› 1█/, 'the query row stays the input');
    assert.match(lines[3], /save failed: disk full/, 'the notice never disappears while typing');
    assert.match(lines[3], /f:open/, 'the state stays honest next to it');
  });

  test('a long notice truncates inside the frame instead of overflowing it', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(76)], [], []]),
      issues: [issue(76)],
      actions: { copyText: () => ({ ok: false, error: 'no clipboard tool available at all' }) },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('y');
    await tick();
    for (const width of [80, 160]) {
      for (const line of view.render(width)) {
        assert.equal(helpers.visibleWidth(line), width, `every row keeps the exact cell width at ${width}`);
      }
    }
    assert.match(chrome(view, 80)[3], /clipboard unavailable/, 'the notice still shows on the state row');
  });

  test('the loading frame keeps the search widget directly under the title', async () => {
    const gate = deferred();
    const { view } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const loading = chrome(view, 160);
    assert.match(loading[0], /◈ Issues/, 'row 1 is the title');
    assert.match(loading[1], /› Search \(T\)/, 'row 2 is the search widget while loading');
    assert.match(loading.join('\n'), /loading issues/, 'the loading state stays');
    assert.match(loading[loading.length - 2], /esc close/, 'the footer legend stays');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    assert.match(chrome(view, 160)[1], /› Search \(T\)/, 'the widget stays under the title after loading');
  });
});

describe('issues view frame header (S27)', () => {
  test('no top-right esc text; right border and corners stay cell-aligned', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 160]) {
      const lines = view.render(width);
      const first = strip(lines[0]);
      assert.ok(!/esc/.test(first), 'the header carries no esc text');
      assert.ok(first.startsWith('╭─'), 'the top-left corner is intact');
      assert.ok(first.endsWith('─╮'), 'the top-right corner is intact');
      for (const line of lines) {
        assert.equal(helpers.visibleWidth(line), width, `cell width at ${width}`);
        assert.match(strip(line), /[│╮╯]$/, 'the right border stays in the last column');
      }
    }
    const wide = view.render(160);
    assert.match(strip(wide[wide.length - 2]), /esc close/, 'the footer still names Esc');
    const narrow = view.render(80);
    assert.match(strip(narrow[narrow.length - 2]), /↑↓ move/, 'the narrow footer keeps the legend head');
    assert.equal(helpers.visibleWidth(narrow[narrow.length - 2]), 80, 'the truncated footer stays cell-exact');
  });

  test('the loader and error frames also drop the top-right esc', async () => {
    const gate = deferred();
    const loading = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    for (const width of [80, 160]) {
      const lines = loading.view.render(width);
      assert.ok(!/esc/.test(strip(lines[0])), 'no esc in the loading header');
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width);
    }
    const failed = makeView({
      loadPages: () => ({ ok: false, error: 'gh issue list failed: HTTP 401' }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const lines = failed.view.render(80);
    assert.ok(!/esc/.test(strip(lines[0])), 'no esc in the error header');
    for (const line of lines) assert.equal(helpers.visibleWidth(line), 80);
    const wide = failed.view.render(160);
    assert.match(strip(wide[wide.length - 2]), /esc close/, 'the footer keeps the Esc shortcut');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
  });
});

describe('issues view assignment gate (S29)', () => {
  const HINT = 'space assign';

  function gateView(enabled, overrides = {}) {
    const saves = [];
    const writes = [];
    const rows = [issue(1), issue(2)];
    const made = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      assigned: [1],
      saveAssignment: (nums) => { saves.push(nums); return { ok: true }; },
      assignmentEnabled: enabled,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      actions: {
        postComment: () => { writes.push('postComment'); return { ok: true }; },
        setState: () => { writes.push('setState'); return { ok: true }; },
        editLabels: () => { writes.push('editLabels'); return { ok: true }; },
        ...(overrides.actions || {}),
      },
    });
    return { ...made, saves, writes, rows };
  }

  test('disabled: no marks, no key hint and no unsaved claim in the frame', async () => {
    const on = gateView(true);
    await tick();
    const wideOn = bodyOf(on.view, 160);
    assert.match(wideOn, new RegExp(HINT), 'enabled: the state row names the Space toggle');
    assert.match(wideOn, /ctrl\+s save/, 'enabled: the state row names the save key');
    assert.match(wideOn.split('\n').find((line) => line.includes('issue title 1')), /✓/, 'enabled: stored mark');

    const off = gateView(false);
    await tick();
    for (const width of [80, 160]) {
      const body = bodyOf(off.view, width);
      assert.ok(!body.includes(HINT), `disabled at ${width}: no Space hint`);
      assert.ok(!body.includes('ctrl+s save'), `disabled at ${width}: no save hint`);
      assert.ok(!body.includes('unsaved'), `disabled at ${width}: no unsaved claim`);
      const row = body.split('\n').find((line) => line.includes('issue title 1'));
      assert.match(row, /#1 issue title 1/, 'disabled: the issue row still renders');
      assert.ok(!/[✓✎]/.test(row), 'disabled: no assignment mark');
    }
  });

  test('disabled: injected Space and ctrl+s mutate nothing and call nothing', async () => {
    const off = gateView(false);
    await tick();
    const snapshot = JSON.stringify(off.view.state);
    const rendered = off.view.render(80).join('\n');
    for (const key of ['space', ' ', 'ctrl+s', 'space', 'ctrl+s']) off.view.handleInput(key);
    await tick();
    assert.deepEqual(off.saves, [], 'the save callback is never reached');
    assert.equal(JSON.stringify(off.view.state), snapshot, 'no state changed');
    assert.equal(off.view.render(80).join('\n'), rendered, 'nothing repainted differently');
    const body = bodyOf(off.view, 80);
    assert.ok(!body.includes('unsaved'), 'no pending-assignment claim appears');
    assert.ok(!/[✓✎]/.test(body), 'no assignment mark appears');
  });

  test('enabled by default and when passed true: the toggle, save and hint stay pinned', async () => {
    for (const enabled of [undefined, true]) {
      const on = gateView(enabled);
      await tick();
      assert.match(bodyOf(on.view, 160), new RegExp(HINT), 'the hint is present');
      on.view.handleInput('down');
      on.view.handleInput('space');
      await tick();
      const pending = bodyOf(on.view, 80);
      assert.match(pending, /unsaved/, 'the pending claim appears');
      assert.match(pending, /✎/, 'the pending mark appears on the toggled row');
      assert.match(pending.split('\n').find((line) => line.includes('#1 issue title 1')), /✓/, 'the stored mark stays');
      on.view.handleInput('ctrl+s');
      await tick();
      assert.deepEqual(on.saves, [[1, 2]], 'the whole pending set saves');
      assert.ok(!bodyOf(on.view, 80).includes('unsaved'), 'success clears the claim');
    }
  });

  test('disabled: reading, filtering and GitHub actions stay usable', async () => {
    const off = gateView(false);
    await tick();
    off.view.handleInput('T');
    for (const ch of 'title 2') off.view.handleInput(ch);
    assert.match(bodyOf(off.view, 80)[0] === undefined ? '' : bodyOf(off.view, 80), /issue title 2/);
    assert.ok(!bodyOf(off.view, 80).includes('issue title 1'), 'search still filters');
    off.view.handleInput('enter');
    assert.match(bodyOf(off.view, 80), /f:open/, 'the state row stays honest');
    off.view.handleInput('T');
    for (let i = 0; i < 7; i += 1) off.view.handleInput('backspace');
    off.view.handleInput('enter');
    assert.match(bodyOf(off.view, 80), /#1 issue title 1/, 'the query clears again');
    off.view.handleInput('f');
    assert.match(bodyOf(off.view, 80), /f:closed/, 'the open/closed toggle still works');
    off.view.handleInput('f');
    assert.match(bodyOf(off.view, 80), /f:open/, 'and back to open');
    off.view.handleInput('x');
    assert.equal(off.view.state.mode, 'confirm', 'close still asks first');
    off.view.handleInput('enter');
    await tick();
    assert.deepEqual(off.writes, ['setState'], 'the GitHub action ran, the assignment did not');
    assert.deepEqual(off.saves, [], 'no assignment save ever ran');
  });
});
