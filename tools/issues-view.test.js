'use strict';
// P2 (issues-view S2-S5,S8) tests: lib/issues-view.js — the pure three-page
// issues overlay (list on the left, issue detail on the right).
//
// Contract under test, as observable output only: the component renders
// exactly the requested rows at the requested width; tabs carry counts;
// search opens/filters/leaves keeping the filter; pagination bounds and the
// totals line; selection movement; right-pane scroll to the last line;
// labels/state/author/dates/reactions/comments; assignment toggle/save;
// label editor; comment input; close/reopen confirm; help overlay;
// empty/error/gh-unavailable states; no key outside S8 mutates state.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createIssuesView } = require('../lib/issues-view.js');

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
  });
  return { view, done: () => settled, paints };
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

  test('state filter f toggles open-only versus all', async () => {
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
    const both = bodyOf(view, 100);
    assert.match(both, /issue title 2/, 'f reveals closed issues');
    view.handleInput('f');
    assert.ok(!bodyOf(view, 100).includes('issue title 2'), 'f toggles back');
  });
});

describe('issues view search', () => {
  test('the idle search hint reads "T search", never the broken "T// search"', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.ok(!body.includes('T// search'), 'the broken hint is gone');
    assert.match(body, /T search/, 'the hint reads "T search"');
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

  test('? shows the help overlay and esc closes it', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('?');
    assert.equal(view.state.help, true);
    assert.match(bodyOf(view, 100), /Keys/);
    view.handleInput('escape');
    assert.equal(view.state.help, false);
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
