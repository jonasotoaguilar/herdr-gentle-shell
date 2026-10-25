'use strict';
// P2 (issues-view S2-S5,S8,S17-S19) tests: lib/issues-view.js — the pure
// three-bucket issues overlay (list on the left, issue detail on the right).
//
// Contract under test, as observable output only: the component renders
// exactly the requested rows at the requested width; tabs carry counts;
// search opens/filters/leaves keeping the filter; pagination bounds and the
// totals line; selection movement; right-pane scroll to the last line;
// labels/state/author/dates/reactions/comments; label editor; comment
// input; close confirm; the lazy page/label loader seams (S19);
// open-only listing with no state toggle (S10a); empty/error/
// gh-unavailable states; no key outside S8 mutates state.
//
// S9/S10/S11/S13/S14/S15 additions: the fourth `All` bucket, a visited tab that
// reuses its rows and page, the fixed page indicator on the search row, the
// server search seam (query in every page request, no local re-filter, cursors
// bound to their query, stale answers dropped), and the write lock with the
// comment caret.
//
// S17: the generic `?` key-help overlay is gone; the footer legend is the
// only key reference.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createIssuesView } = require('../lib/issues-view.js');
const ghIssues = require('../lib/gh-issues.js');
const layout = require('../lib/view-layout.js');

// Optional real host helpers, guarded exactly like tools/odd-view.test.js:
// CI installs no dependencies, so the byte-level key assertions run only
// when the installed matcher resolves and skip honestly when it does not.
let realTui = null;
try {
  realTui = require('@earendil-works/pi-tui');
} catch {
  realTui = null;
}

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

// S16: every permission the editor gates on, confirmed true. Fixtures that
// mean to open an editor carry this explicitly; a fixture without it is a
// repository where editing is not permitted.
const EDITABLE = { canEditLabels: true, canEditAssignees: true, canCreateLabels: true };

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

// One server page answer and one issue row carrying its cursor, as the
// `loadIssuePage` seam delivers them.
function pageResult(issues, extra = {}) {
  return { ok: true, issues, total: issues.length, hasNextPage: false, ...extra };
}

function cursorRow(cursor, row) {
  return { ...row, cursor };
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
    loadIssuePage: opts.loadIssuePage,
    loadLabels: opts.loadLabels,
    loadAssignees: opts.loadAssignees,
    assigned: opts.assigned,
    saveAssignment: opts.saveAssignment,
    actions,
    labels: opts.labels,
    helpers: opts.helpers || helpers,
    theme: opts.theme || plainTheme,
    rowsAvailable: () => opts.rows || 24,
    requestRender: () => { paints.push(true); },
    done: (result) => { settled = result; },
    checkoutName: opts.checkoutName,
    ghAvailable: opts.ghAvailable,
    loadError: opts.loadError,
    assignmentEnabled: opts.assignmentEnabled,
    // S9: the remote-search debounce clock is injected, so a burst of typing is
    // observed without wall-clock waits.
    scheduleQuery: opts.scheduleQuery,
    cancelSchedule: opts.cancelSchedule,
  });
  return { view, done: () => settled, paints };
}

// A scheduler the test owns: nothing fires until `fire()` is called, so the
// debounce window (and any stale callback inside it) is fully deterministic.
function manualScheduler() {
  const entries = [];
  return {
    entries,
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs, cancelled: false };
      entries.push(entry);
      return entry;
    },
    cancel: (entry) => { if (entry) entry.cancelled = true; },
    live: () => entries.filter((entry) => !entry.cancelled),
    fire() {
      const live = entries.filter((entry) => !entry.cancelled);
      for (const entry of live) entry.fn();
      return live.length;
    },
  };
}

// A promise whose settlement the test owns, so no expectation depends on
// wall-clock timing.
function deferred() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

// Only the LEFT pane of every body row, so a list assertion can never be
// satisfied by the preview on the right: S3 puts titles left and the number
// right, and the two are trimmed to different widths.
function leftColumn(view, width, rows = 24) {
  const panes = layout.paneWidths(layout.innerWidth(width));
  return view.render(width)
    .slice(4, Math.max(4, rows - 2))
    .map((line) => [...strip(line)].slice(2, 2 + panes.left).join(''))
    .join('\n');
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

  test('tab switches buckets; the arrows page the active list (D3)', async () => {
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
    assert.equal(view.state.page, 1, 'right pages the list, never the buckets');
    view.handleInput('shift+tab');
    assert.equal(view.state.page, 0);
    view.handleInput('left');
    assert.equal(view.state.page, 0, 'left pages back, never the buckets');
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

  test('the tab carries the issue count and the fixed indicator only the page position', async () => {
    const rows = [issue(1, { title: 'alpha bug' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'alpha bug' }), comments: [] }),
    });
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /My issues \(1\)/, 'the open tab names its count');
    assert.match(strip(view.render(100)[1]), /page 1\/1/, 'the fixed indicator sits on the search row');
    assert.ok(!leftColumn(view, 100, 12).includes('page'), 'the list spends no row on the indicator');
    assert.ok(!/\b1 issues?\b/.test(body.replace('My issues', '')), 'no second total is repeated below the list');
  });

  test('pagination bounds move the page position, never a repeated count', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => issue(i + 1));
    const { view } = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    // S5/S14: capacity follows the real body budget (12 rows - 6 frame rows;
    // the page indicator left the list for the search row), so ten single-row
    // titles need two pages.
    const first = bodyOf(view, 100);
    assert.match(first, /page 1\/2/, 'the fixed indicator shows the derived page position');
    assert.ok(!/\b10 issues\b/.test(first), 'the count is not repeated under the list');
    view.handleInput(']');
    assert.equal(view.state.listPage, 2, 'the next page holds what did not fit');
    view.handleInput(']');
    view.handleInput(']');
    assert.equal(view.state.listPage, 2, 'never past the last page');
    assert.match(bodyOf(view, 100), /page 2\/2/);
    view.handleInput('[');
    assert.equal(view.state.listPage, 1);
    view.handleInput('[');
    assert.equal(view.state.listPage, 1, 'never before the first page');
  });

  test('the state filter is gone: f changes nothing and closed rows never list (S10a)', async () => {
    const rows = [issue(1), issue(2, { state: 'closed' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const before = bodyOf(view, 100);
    assert.match(before, /issue title 1/);
    assert.ok(!before.includes('issue title 2'), 'closed rows are never listed');
    const snapshot = JSON.stringify(view.state);
    view.handleInput('f');
    assert.equal(JSON.stringify(view.state), snapshot, 'f no longer toggles any state');
    assert.equal(bodyOf(view, 100), before, 'f repaints nothing');
    assert.ok(!/f[:(]/.test(before), 'no state indicator survives in the frame');
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
    assert.match(body, /› Search/, 'the idle row names the Search widget');
    assert.ok(!body.includes('(T)'), 'no (T) hint sits above the footer');
    assert.match(bodyOf(view, 160), /T search/, 'the footer names the search key');
  });

  test('Delete clears the whole active query, Backspace one character, and only typing advertises clearing', async () => {
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'alpha cr') view.handleInput(ch);
    const footerOf = () => strip(view.render(80).at(-2));
    assert.match(bodyOf(view, 80), /› alpha cr█/);
    assert.match(footerOf(), /del clear/, 'the footer advertises clearing while the input is active');
    assert.ok(!bodyOf(view, 80).includes('beta typo'), 'the query filters the other row out');
    view.handleInput('backspace');
    assert.equal(view.state.query, 'alpha c', 'Backspace deletes one character');
    view.handleInput('delete');
    assert.equal(view.state.query, '', 'Delete clears the WHOLE query');
    const body = bodyOf(view, 80);
    assert.match(body, /› █/, 'the input row shows the emptied query');
    assert.match(footerOf(), /del clear/, 'the clearing hint stays while the input is still active');
    assert.match(body, /beta typo/, 'clearing the query lists every row again');
    view.handleInput('enter');
    assert.ok(!footerOf().includes('del clear'), 'the clearing hint leaves with the input');
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

  test('ctrl+shift+j/pgDn scroll to the last line of a long issue; home resets to the top', async () => {
    const longBody = Array.from({ length: 100 }, (_, i) => `body line ${i + 1}`).join('\n');
    const { view } = makeView({
      pages: pagesOf([[issue(1, { body: longBody })], [], []]),
      issues: [issue(1, { body: longBody })],
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
    await tick();
    view.handleInput('ctrl+shift+j');
    assert.ok(view.state.scroll > 0, 'ctrl+shift+j scrolls the issue pane');
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

// S1: extended paging and printable Shift+J/K share a full-page action;
// ctrl+d/u retain their half-page action and j/k select. These also exercise
// the installed matcher with the bytes a terminal emits.
describe('round3: every tab is read at open, and a switch never refetches', { concurrency: false }, () => {
  // The reported defect: opening Issues showed `All (0)` while the repository
  // had open issues, and each tab refetched on every switch. The reader must
  // read all four buckets ONCE when it opens, show their real totals, and reuse
  // them while switching.
  function serverView(extra = {}) {
    const requests = [];
    const queue = [];
    const view = createIssuesView({
      helpers,
      prefetchBuckets: true,
      rowsAvailable: () => 24,
      requestRender: () => {},
      done: () => {},
      loadIssuePage: (request) => {
        requests.push(request);
        return new Promise((resolve) => queue.push({ request, resolve }));
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...extra,
    });
    return { view, requests, queue };
  }

  function answer(queue, bucketId, numbers, total = numbers.length) {
    const at = queue.findIndex((entry) => entry.request.bucketId === bucketId);
    assert.ok(at >= 0, `no pending request for ${bucketId}`);
    const [entry] = queue.splice(at, 1);
    entry.resolve({ ok: true, issues: numbers.map((n) => ({ ...issue(n), cursor: `c${n}` })), total, hasNextPage: false });
  }

  test('all four buckets are requested when the view opens', async () => {
    const { view, requests } = serverView();
    view.render(120);
    await tick();
    assert.deepEqual(requests.map((entry) => entry.bucketId).sort(), ['all', 'assigned', 'involved', 'mine']);
  });

  test('an unvisited tab shows its real total instead of a false zero, and switching reads nothing', async () => {
    const { view, requests, queue } = serverView();
    // ONE layout: a resize legitimately invalidates recorded page boundaries,
    // so the reuse assertion belongs to a stable viewport.
    view.render(160);
    await tick();
    answer(queue, 'mine', [1]);
    answer(queue, 'assigned', []);
    answer(queue, 'involved', []);
    answer(queue, 'all', [1], 1);
    await tick();
    const frame = bodyOf(view, 160);
    assert.match(frame, /All \(1\)/, `All reports the repository total: ${frame.split('\n')[2]}`);
    assert.match(frame, /My issues \(1\)/, 'the active bucket keeps its own count');
    const before = requests.length;
    for (let step = 0; step < 3; step += 1) {
      view.handleInput('tab');
      await tick();
    }
    assert.equal(requests.length, before, 'switching between loaded tabs reads nothing again');
  });

  test('a bucket that has not answered yet is unknown, never a zero', async () => {
    const { view, queue } = serverView();
    view.render(120);
    await tick();
    // The active bucket answers; the other three are still in flight.
    answer(queue, 'mine', [1]);
    await tick();
    const tabs = bodyOf(view, 160).split('\n').find((line) => line.includes('My issues')) ?? '';
    assert.match(tabs, /Assigned \(–\)/, `unread bucket is unknown: ${tabs}`);
    assert.doesNotMatch(tabs, /Assigned \(0\)/, 'an unread bucket never claims zero');
  });
});

describe('issues view preview scroll variants (S15)', () => {
  const skipReal = realTui ? false : 'requires @earendil-works/pi-tui';
  const longBody = Array.from({ length: 100 }, (_, i) => `body line ${i + 1}`).join('\n');

  function realKeyView() {
    return makeView({
      helpers: realTui,
      pages: pagesOf([[issue(1, { body: longBody }), issue(2, { body: longBody })], [], []]),
      issues: [issue(1, { body: longBody }), issue(2, { body: longBody })],
      rows: 14,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: longBody }), comments: [] }),
    });
  }

  test('ctrl+d/ctrl+u and shifted J/K scroll the pane, j/k still move the list', { skip: skipReal }, async () => {
    const { view } = realKeyView();
    await tick();
    view.render(100);
    view.handleInput('\x1b[6~');            // PageDown: the full-page step
    const paged = view.state.scroll;
    assert.ok(paged > 0, 'PageDown scrolls the pane');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0, 'home returns to the top first');
    view.handleInput('\x04');               // ctrl+d
    const half = view.state.scroll;
    assert.ok(half > 0, 'raw ctrl+d scrolls the pane down');
    assert.ok(half < paged, 'ctrl+d moves half a page, less than PageDown');
    assert.equal(view.state.index, 0, 'ctrl+d never moves the list selection');
    view.handleInput('\x15');               // ctrl+u
    assert.equal(view.state.scroll, 0, 'raw ctrl+u scrolls the pane back up');
    view.handleInput('\x1b[100;5u');        // Kitty ctrl+d
    assert.ok(view.state.scroll > 0, 'Kitty ctrl+d scrolls the pane down');
    view.handleInput('\x1b[117;5u');        // Kitty ctrl+u
    assert.equal(view.state.scroll, 0, 'Kitty ctrl+u scrolls the pane back up');
    view.handleInput('\x04');
    view.handleInput('K');                  // shifted K scrolls up
    assert.equal(view.state.scroll, 0, 'K scrolls the pane back up');
    view.handleInput('J');                  // shifted J scrolls down
    assert.ok(view.state.scroll > 0, 'J scrolls the pane down');
    assert.equal(view.state.index, 0, 'J never moves the list selection');
    view.handleInput('home');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'j still moves the list selection');
    view.handleInput('k');
    assert.equal(view.state.index, 0, 'k still moves the list selection');
    view.handleInput('\n');                 // legacy Enter is not a scroll alias
    assert.equal(view.state.scroll, 0, 'LF never scrolls the pane');
    view.handleInput('\x0b');
    assert.equal(view.state.scroll, 0, 'legacy ctrl+k never scrolls the pane');
    view.handleInput('\x1b[6~');
    assert.equal(view.state.scroll, paged, 'PageDown still scrolls a full page');
    view.handleInput('\x1b[5~');
    assert.equal(view.state.scroll, 0, 'PageUp still scrolls the page back');
  });
});

// S10b: the issues viewer is read-only with respect to the checkout↔issue
// association. The options the existing callers still pass (`assigned`,
// `saveAssignment`, `assignmentEnabled`) are accepted and ignored: no mark,
// no toggle, no save, no unsaved claim — and no key that writes.
describe('issues view read-only association (S10b)', () => {
  const ASSIGNED = [1];

  function inertView(overrides = {}) {
    const saves = [];
    const rows = [issue(1), issue(2)];
    const made = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      assigned: ASSIGNED,
      saveAssignment: (nums) => { saves.push(nums); return { ok: true }; },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...overrides,
    });
    return { ...made, saves, rows };
  }

  test('no association mark, hint or unsaved claim renders even when assigned and saveAssignment are passed', async () => {
    const { view } = inertView({ assignmentEnabled: true });
    await tick();
    for (const width of [80, 160]) {
      const body = bodyOf(view, width);
      assert.ok(!body.includes('space assign'), `width ${width}: no Space hint`);
      assert.ok(!body.includes('ctrl+s save'), `width ${width}: no save hint`);
      assert.ok(!body.includes('unsaved'), `width ${width}: no unsaved claim`);
      assert.ok(!/\d+ assigned/.test(body), `width ${width}: no assigned count`);
      // S3: the left row is the title alone — the number lives in the preview.
      const left = leftColumn(view, width);
      assert.match(left, /issue title 1/, 'the issue row still renders');
      assert.ok(!left.includes('#1'), 'no issue number in the left list');
      assert.ok(!/[✓✎]/.test(left), 'no assignment mark on the row');
      assert.match(left, /issue title 2/, 'the other row still renders');
      assert.ok(!/[✓✎]/.test(left), 'no assignment mark on the other row either');
    }
    assert.match(bodyOf(view, 160), /x\/X close/, 'the footer legend stays');
  });

  test('space and ctrl+s change nothing: no save call, no state change, no repaint difference', async () => {
    const { view, saves } = inertView();
    await tick();
    const snapshot = JSON.stringify(view.state);
    const rendered = view.render(80).join('\n');
    for (const key of ['space', ' ', 'ctrl+s']) view.handleInput(key);
    await tick();
    assert.deepEqual(saves, [], 'the injected save callback is never reached');
    assert.equal(JSON.stringify(view.state), snapshot, 'no state changed');
    assert.equal(view.render(80).join('\n'), rendered, 'nothing repainted differently');
    assert.ok(!bodyOf(view, 80).includes('unsaved'), 'no pending-assignment claim appears');
    assert.ok(!/[✓✎]/.test(bodyOf(view, 80)), 'no assignment mark appears');
  });

  test('the association options are inert: the frame is identical with them and with the gate off', async () => {
    const common = {
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    };
    const plain = makeView(common);
    const passed = makeView({ ...common, assigned: ASSIGNED, saveAssignment: () => ({ ok: true }), assignmentEnabled: true });
    const gatedOff = makeView({ ...common, assigned: ASSIGNED, saveAssignment: () => ({ ok: true }), assignmentEnabled: false });
    await tick();
    const expected = plain.view.render(80).join('\n');
    assert.equal(passed.view.render(80).join('\n'), expected, 'assigned/saveAssignment/assignmentEnabled change no cell');
    assert.equal(gatedOff.view.render(80).join('\n'), expected, 'assignmentEnabled false changes no cell either');
  });

  test('reading, search and the GitHub actions stay usable with the options passed', async () => {
    const writes = [];
    const { view } = inertView({
      assignmentEnabled: false,
      actions: {
        setState: () => { writes.push('setState'); return { ok: true }; },
        postComment: () => { writes.push('postComment'); return { ok: true }; },
        editLabels: () => { writes.push('editLabels'); return { ok: true }; },
        openBrowser: () => { writes.push('openBrowser'); return { ok: true }; },
      },
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'title 2') view.handleInput(ch);
    assert.match(bodyOf(view, 80), /issue title 2/);
    assert.ok(!bodyOf(view, 80).includes('issue title 1'), 'search still filters');
    view.handleInput('enter');
    view.handleInput('T');
    for (let i = 0; i < 7; i += 1) view.handleInput('backspace');
    view.handleInput('enter');
    assert.match(leftColumn(view, 80), /issue title 1/, 'the query clears again');
    const beforeF = bodyOf(view, 80);
    view.handleInput('f');
    assert.equal(bodyOf(view, 80), beforeF, 'the removed state key repaints nothing');
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm', 'close still asks first');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(writes, ['setState'], 'the GitHub action ran, the association did not');
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
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: { canEditLabels: true, canCreateLabels: true } }),
        comments: [],
      }),
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
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: { canEditLabels: true, canCreateLabels: true } }),
        comments: [],
      }),
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

  test('c opens the comment input; Enter is a newline, ctrl+s posts and refreshes the detail, esc asks before discarding', async () => {
    const calls = [];
    const loads = [];
    let comments = [];
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: {
        postComment: (number, text) => {
          calls.push([number, text]);
          comments = [{ author: 'octo', createdAt: new Date().toISOString(), body: text }];
          return { ok: true };
        },
      },
      loadIssue: (n, detailOptions) => {
        loads.push([n, detailOptions]);
        return { ok: true, issue: issue(n), comments: comments.slice() };
      },
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
    const refreshes = loads.filter(([, detailOptions]) => detailOptions && detailOptions.refresh === true);
    assert.deepEqual(refreshes.map(([number]) => number), [1], 'the posted issue detail is refetched, never served from cache');
    const posted = bodyOf(view, 100);
    assert.match(posted, /hi/);
    assert.match(posted, /there/, 'the new comment is visible without reopening the issue');

    view.handleInput('c');
    for (const ch of 'draft') view.handleInput(ch);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'esc on a non-empty draft asks instead of discarding');
    assert.match(bodyOf(view, 100), /Discard this draft/, 'the ask names what is at stake');
    view.handleInput('y');
    assert.equal(view.state.mode, 'list', 'y discards the draft');
    assert.equal(calls.length, 1, 'discard posts nothing');
  });

  test('a failed refresh after a posted comment is visible and never claims updated data', async () => {
    let posted = false;
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      actions: { postComment: () => { posted = true; return { ok: true }; } },
      loadIssue: (n, detailOptions) => {
        if (posted && detailOptions && detailOptions.refresh === true) return { ok: false, error: 'gh timed out' };
        return { ok: true, issue: issue(n), comments: [] };
      },
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'still posted') view.handleInput(ch);
    view.handleInput('ctrl+s');
    await tick();
    const body = bodyOf(view, 100);
    assert.match(body, /unreadable: gh timed out/, 'the failed refresh is visible');
    assert.match(body, /comment posted/, 'the posted result is reported truthfully');
    assert.ok(!body.includes('(end of issue)'), 'cached content is never presented as refreshed');
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

  test('x and X close the issue, and a closed issue leaves the open list (S10a)', async () => {
    const calls = [];
    const openRows = [issue(1), issue(2)];
    const { view } = makeView({
      pages: pagesOf([openRows, [], []]),
      issues: openRows,
      actions: { setState: (number, state) => { calls.push([number, state]); return { ok: true }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('x');
    assert.equal(view.state.mode, 'confirm');
    assert.match(bodyOf(view, 100), /Confirm close #1/, 'the confirm names the close');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(calls, [[1, 'closed']], 'x closes through the injected action');
    const afterClose = bodyOf(view, 100);
    assert.ok(!leftColumn(view, 100).includes('issue title 1'), 'the closed issue leaves the open list at once');
    assert.match(afterClose, /My issues \(1\)/, 'the tab count drops with it');
    assert.match(leftColumn(view, 100), /issue title 2/, 'the remaining open issue stays listed');

    view.handleInput('X');
    assert.equal(view.state.mode, 'confirm', 'X asks the same close confirmation');
    assert.match(bodyOf(view, 100), /Confirm close #2/, 'X names a close, never a reopen');
    view.handleInput('enter');
    await tick();
    assert.deepEqual(calls, [[1, 'closed'], [2, 'closed']], 'X closes too: the view has no reopen path');
    assert.match(bodyOf(view, 100), /no issues/, 'the emptied list says so honestly');
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
    assert.match(after, /x\/X close/, 'the footer documents the close key');
    assert.ok(!after.includes('f open/closed'), 'the removed state-toggle key is gone from the legend');
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
    view.handleInput('ctrl+shift+j');
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
    view.handleInput('ctrl+shift+j');
    assert.ok(view.state.scroll > 0, 'precondition: the pane is scrolled');
    view.handleInput('home');
    assert.equal(view.state.index, 0, 'home selects the first issue');
    assert.equal(view.state.scroll, 0, 'home resets the newly selected issue to its top');
    const top = bodyOf(view, 100);
    assert.match(top, /body line 1/, 'the top of the first issue is shown');
  });

  test('a bounded fetch marks the count on the tab and never repeats it below the list', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => issue(i + 1));
    const truncated = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length, truncated: true }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(truncated.view, 100), /My issues \(5\+\)/, 'the tab marks the bounded count');
    assert.ok(!/5\+ issues/.test(bodyOf(truncated.view, 100)), 'the bound is never repeated below the list');
    const plain = makeView({
      pages: [{ id: 'p0', label: 'My issues', issues: rows, total: rows.length }],
      issues: rows,
      rows: 12,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(bodyOf(plain.view, 100), /My issues \(5\)/, 'a plain fetch renders the exact count');
    assert.ok(!bodyOf(plain.view, 100).includes('5+'), 'a plain fetch never carries the + marker');
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
    // `a` is no longer foreign: S16 binds it to the assignee editor (and it
    // stays inert for this permission-less fixture, which S16 covers).
    // ctrl+u/d are real half-page bindings, checked in the scroll tests.
    for (const key of ['e', 'p', 'z', 'd', 'w', 'v', 'u', 'g', 'i', 'm', 'h', 'b', 's', 'n', 'alt+x']) {
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

describe('issues view preview metadata (S9)', () => {
  test('shows every assignee, projects and a nonzero linked PR count, and omits empty metadata', async () => {
    const full = issue(5, {
      assignees: [{ login: 'ann' }, { login: 'bob' }],
      projects: [{ title: 'Roadmap', url: 'https://example.test/p/1' }],
      linkedPullRequestCount: 2,
    });
    const rich = makeView({
      pages: pagesOf([[full], [], []]),
      issues: [full],
      loadIssue: () => ({ ok: true, issue: full, comments: [] }),
    });
    await tick();
    const body = bodyOf(rich.view, 120);
    assert.match(body, /assignees: ann, bob/, 'every assigned person is shown');
    assert.match(body, /projects: Roadmap/, 'the associated project is shown');
    assert.match(body, /linked PRs: 2/, 'the nonzero PR count is shown');

    const bare = issue(6, { metadataError: 'Project metadata is unavailable or incomplete (read:project)' });
    const empty = makeView({
      pages: pagesOf([[bare], [], []]),
      issues: [bare],
      loadIssue: () => ({ ok: true, issue: bare, comments: [] }),
    });
    await tick();
    const thin = bodyOf(empty.view, 120);
    assert.ok(!/projects?:/i.test(thin), 'an issue without projects names none');
    assert.ok(!/linked PR/i.test(thin), 'a zero PR count is omitted, never rendered as "0 PR"');
    assert.ok(!/read:project|scope/i.test(thin), 'no scope text leaks into the compact preview');
    assert.match(thin, /metadata unavailable/, 'unavailable metadata is one concise status');
  });
});

describe('issues view Copy removal (S7)', () => {
  test('y and Y are inert: no clipboard write and no copy notice', async () => {
    const calls = [];
    const rows = [issue(76, { title: 'copy me' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: { copyText: (text) => { calls.push(text); return { ok: true, via: 'test-clipboard' }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'copy me' }), comments: [] }),
    });
    await tick();
    const before = bodyOf(view, 160);
    view.handleInput('y');
    view.handleInput('Y');
    await tick();
    assert.deepEqual(calls, [], 'y and Y never touch the clipboard');
    const after = bodyOf(view, 160);
    assert.equal(after, before, 'both keys repaint nothing');
    assert.ok(!after.includes('Copied'), 'no copy claim is rendered');
    assert.ok(!after.includes('clipboard'), 'no clipboard failure path is rendered either');
  });

  test('Y copies neither the issue URL nor anything else', async () => {
    const url = 'https://example.test/i/76';
    const rows = [issue(76, { url })];
    const copies = [];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      actions: { copyText: (text) => { copies.push(text); return { ok: true, via: 'test' }; } },
      loadIssue: (n) => ({ ok: true, issue: issue(n, { url }), comments: [] }),
    });
    await tick();
    view.handleInput('Y');
    await tick();
    assert.deepEqual(copies, [], 'the URL is not copied');
    assert.ok(!bodyOf(view, 100).includes('Copied'), 'nothing claims a copy');
  });

  test('a clipboard failure seam is never consulted, so no miss is claimed either', async () => {
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
    assert.ok(!body.includes('clipboard unavailable'), 'the copy seam is never consulted');
    assert.ok(!body.includes('Copied'), 'no success or miss notice exists');
  });

  test('the footer never names a copy key', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.ok(!bodyOf(view, 160).includes('y/Y'), 'no copy hint anywhere');
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

  test('a stale answer never wins over the newest request', async () => {
    const pending = [];
    const { view } = makeView({
      loadPages: ({ state }) => {
        const entry = deferred();
        pending.push({ state, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    assert.deepEqual(pending.map((p) => p.state), ['open'], 'the mount read asks for open');
    view.handleInput('r');
    view.handleInput('r');
    assert.deepEqual(pending.map((p) => p.state), ['open', 'open', 'open'], 'every reload asks for open again');
    const newest = pending[2].entry;
    const stale = pending[1].entry;
    newest.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    stale.resolve(pagesResult([[issue(2)], [], []]));
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(1\)/, 'the newest open-only answer is the one shown');
    assert.match(body, /issue title 1/, 'the newest answer paints its row');
    assert.ok(!body.includes('issue title 2'), 'the stale answer never paints');
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

describe('issues view open-only list (S10a)', () => {
  // A state-honest source, like `gh --state <state>`: each state carries
  // only its own rows and its own total. The view only ever asks for open.
  function stateSource(rows) {
    const asked = [];
    const pages = (state) => {
      asked.push(state);
      const matching = rows.filter((row) => String(row.state || 'open') === state);
      return pagesResult([matching, [], []]);
    };
    return { asked, pages };
  }

  test('the default fetch asks for open and the tab names the open count', async () => {
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
    assert.match(body, /page 1\/1/, 'the list footer names the page position');
    assert.ok(!/f[:(]/.test(body), 'no state indicator is left in the frame');
    assert.ok(!bodyOf(view, 160).includes('open/closed'), 'the removed toggle never reaches the legend');
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
    assert.match(body, /page 1\/1/, 'the list footer agrees');
    assert.ok(!body.includes('issue title 2'), 'no closed row is listed under open');
    assert.ok(!/\b2 issues\b|\b3 issues\b/.test(body), 'no closed row inflates a count');
  });

  test('f is inert: no other state is ever requested and closed rows never count', async () => {
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
    assert.deepEqual(source.asked, ['open'], 'the mount fetch asks for open');
    const before = bodyOf(view, 80);
    view.handleInput('f');
    await tick();
    assert.deepEqual(source.asked, ['open'], 'f never asks gh for another state');
    assert.deepEqual(asked, [], 'f never refetches through the reload seam');
    assert.equal(bodyOf(view, 80), before, 'f repaints nothing');
    view.handleInput('r');
    await tick();
    assert.deepEqual(asked, ['reload:open'], 'a reload asks for open, never for closed');
    assert.equal(source.asked.includes('closed'), false, 'the closed state is never requested');
    const reloaded = bodyOf(view, 80);
    assert.match(reloaded, /My issues \(1\)/, 'only the open row is counted');
    assert.ok(!reloaded.includes('issue title 2'), 'closed rows stay out of the reloaded list');
    assert.equal(view.state.index, 0, 'the selection stays on the first open row');
    assert.equal(view.state.listPage, 1, 'the list page stays at one');
    assert.equal(view.state.scroll, 0, 'the detail scroll stays at the top');
  });

  test('a bounded fetch marks the count on the tab only', async () => {
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
    assert.ok(!/500\+ issues|5\+ issues/.test(body), 'the bound is never repeated below the list');
  });

  test('opening, searching and the removed state key issue no write action', async () => {
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
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
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
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
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
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE }), comments: [] }),
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
    ghIssues.setGhRunner((_bin, argv) => {
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
    view.handleInput('r');
    await tick();
    const lists = calls.filter((argv) => argv[0] === 'issue' && argv[1] === 'list');
    assert.equal(lists.length, 2, 'the mount read and the reload');
    assert.deepEqual(
      lists.map((argv) => argv[argv.indexOf('--state') + 1]),
      ['open', 'open'],
      'open is the only state ever requested',
    );
    assert.ok(!calls.some((argv) => argv.includes('closed')), 'the closed state is never requested');
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
    assert.match(body, /page 1\/1/, 'the list footer names the page position');
    assert.ok(!/\b45 issues\b/.test(body), 'the total is named once, on the tab');
  });
});

describe('issues view concise header (S25)', () => {
  const CHECKOUT = 'feat-yolo-worktree-confirmations';

  test('the header repeats neither the checkout nor the active tab', async () => {
    const { view } = makeView({
      checkoutName: CHECKOUT,
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const header = strip(view.render(80)[0]);
    assert.match(header, /◈ Issues/, 'the header names the surface');
    assert.ok(!header.includes('My issues'), 'the header never repeats the active tab the tab row shows');
    assert.ok(!header.includes(CHECKOUT), 'the header never repeats the checkout/branch');
    assert.ok(!bodyOf(view, 80).includes(CHECKOUT), 'no part of the frame repeats the checkout');
    assert.ok(!/#\d/.test(header), 'the header repeats no issue id the list or preview already shows');
    const body = bodyOf(view, 160);
    assert.match(body, /My issues \(1\)/, 'the tab count survives the trim');
    assert.match(body, /x\/X close/, 'the close legend survives the trim');
    assert.match(body, /page 1\/1/, 'the list footer survives the trim');
    assert.ok(!body.includes('f open/closed'), 'the removed state toggle legend stays gone');
    const beforeSpace = strip(view.render(80).join('\n'));
    view.handleInput('space');
    const after = strip(view.render(80).join('\n'));
    assert.equal(after, beforeSpace, 'space changes nothing, the header included');
    assert.ok(!after.includes('unsaved'), 'the header never claims a pending assignment');
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
      assert.match(lines[0], /◈ Issues/, 'row 1 is the concise title');
      assert.ok(!/search/i.test(lines[0]), 'the title buries nothing about search');
      assert.match(lines[1], /› Search(?! \(T\))/, 'row 2 is the dedicated Search widget');
      assert.match(lines[2], /My issues \(1\)/, 'row 3 carries the tabs and their counts');
      assert.match(lines[2], /Assigned \(0\)/, 'every tab count stays');
      assert.ok(!/f[:(]/.test(lines[3]), 'row 4 carries notices only, no state toggle');
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
      assert.ok(!lines[1].includes('enter/esc keep'), 'the input row repeats no key hint');
      assert.match(lines[2], /My issues/, 'the tabs stay below the search row');
      const footer = lines[lines.length - 2];
      assert.match(footer, /enter\/esc keep/, 'the footer names the search keys of this interaction once');
      assert.ok(!footer.includes('esc close'), 'the close hint belongs to the reading interaction only');
    }
    view.handleInput('enter');
    const settled = chrome(view, 80);
    assert.match(settled[1], /› beta(?! \(T)/, 'a kept filter shows its query in the widget');
    assert.ok(!settled.join('\n').includes('alpha crash'), 'the kept filter still filters the list');
  });

  test('errors and notices keep their own visible row, even while typing', async () => {
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('L');
    let lines = chrome(view, 80);
    assert.match(lines[3], /labels cannot be edited/, 'the refusal lands on the notice row');
    view.handleInput('T');
    view.handleInput('1');
    lines = chrome(view, 80);
    assert.match(lines[1], /› 1█/, 'the query row stays the input');
    assert.match(lines[3], /labels cannot be edited/, 'the error never disappears while typing');
  });

  test('a long notice truncates inside the frame instead of overflowing it', async () => {
    const longError = 'the issue page could not be read: gh timed out after 30s while querying the remote repository for this bucket';
    const { view } = makeView({
      pages: pagesOf([[issue(76)], [], []]),
      issues: [issue(76)],
      loadError: longError,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 160]) {
      for (const line of view.render(width)) {
        assert.equal(helpers.visibleWidth(line), width, `every row keeps the exact cell width at ${width}`);
      }
    }
    assert.match(chrome(view, 80)[3], /the issue page could not be read/, 'the notice still shows on the notice row');
  });

  test('the loading frame keeps the search widget directly under the title', async () => {
    const gate = deferred();
    const { view } = makeView({
      loadPages: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    const loading = chrome(view, 160);
    assert.match(loading[0], /◈ Issues/, 'row 1 is the title');
    assert.match(loading[1], /› Search/, 'row 2 is the search widget while loading');
    assert.match(loading.join('\n'), /loading issues/, 'the loading state stays');
    assert.match(loading[loading.length - 2], /esc close/, 'the footer legend stays');
    gate.resolve(pagesResult([[issue(1)], [], []]));
    await tick();
    assert.match(chrome(view, 160)[1], /› Search/, 'the widget stays under the title after loading');
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

// S2: the footer legend is ONE terminal row; a legend wider than the card is
// compacted (short tokens, then the lowest-priority keys dropped) instead of
// being ellipsis-clipped inside the frame.
describe('S2: one-row key legends', () => {
  const WIDTHS = [40, 60, 80, 120];

  test('the footer legend owns exactly one row at every width', async () => {
    for (const width of WIDTHS) {
      const { view } = makeView({
        pages: pagesOf([[issue(1)], [], []]),
        issues: [issue(1)],
        loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      });
      await tick();
      const lines = view.render(width);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `width ${width}: row is not ${width} wide`);
      const legend = lines.map(strip).filter((line) => /esc close|↑↓ move/.test(line));
      assert.equal(legend.length, 1, `width ${width}: exactly one footer row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /↑↓ move/, `width ${width}: the movement keys survive`);
      assert.match(legend[0], /esc close/, `width ${width}: the close key survives`);
    }
  });
});

// S13: the issues frame says each thing once. The search key is named by the
// search row alone, the issue total by the tab alone, the active bucket by the
// tab row (never by the header too), and while the box holds the keyboard the
// footer names its keys once instead of the input and the footer both doing it.
describe('S13: the issues frame repeats nothing', () => {
  const rows = [issue(1), issue(2)];
  const footerOf = (lines) => lines[lines.length - 2];
  const tokensOf = (footer) => footer.split('·').map((token) => token.trim());

  async function opened(opts = {}) {
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...opts,
    });
    await tick();
    return view;
  }

  test('the active bucket is named by the tab, not by the header too', async () => {
    const view = await opened();
    const lines = view.render(80).map(strip);
    assert.match(lines[0], /◈ Issues/, 'the header names the surface');
    assert.ok(!lines[0].includes('My issues'), 'the header never repeats the tab below it');
    assert.match(lines[2], /▸ My issues \(2\)/, 'the tab row marks the active bucket and its count');
  });

  test('the search key is named by the footer alone, never above it', async () => {
    const view = await opened();
    const lines = view.render(80).map(strip);
    const footer = footerOf(lines);
    assert.match(lines[1], /› Search/, 'the search row names the widget');
    assert.ok(!lines[1].includes('(T)'), 'no key hint rides the search row');
    assert.equal((lines.join('\n')).match(/\(T\)/g), null, 'no parenthesised T hint survives');
    assert.ok(tokensOf(footer).some((token) => /^T( search)?$/.test(token)), `the footer owns the search key: ${footer}`);
  });

  test('while searching the footer names the search keys once and the input carries only the query', async () => {
    const view = await opened();
    view.handleInput('T');
    view.handleInput('t');
    const lines = view.render(80).map(strip);
    const body = lines.join('\n');
    assert.match(lines[1], /› t█/, 'the input row carries the live query');
    assert.ok(!lines[1].includes('enter'), 'the input row repeats no key hint');
    assert.ok(!lines[1].includes('esc'), 'the input row names no escape key');
    const footer = footerOf(lines);
    assert.match(footer, /enter\/esc keep/, 'the footer names the search keys of this interaction');
    assert.ok(!footer.includes('esc close'), 'the close hint belongs to the reading interaction only');
    assert.equal((body.match(/esc/g) || []).length, 1, `one escape hint for the current interaction: ${body}`);
    assert.equal((body.match(/enter/g) || []).length, 1, 'one enter hint for the current interaction');
  });

  test('leaving the box restores the reading legend with its one escape hint', async () => {
    const view = await opened();
    view.handleInput('T');
    view.handleInput('t');
    view.handleInput('enter');
    const lines = view.render(80).map(strip);
    const footer = footerOf(lines);
    assert.match(footer, /esc close/, 'the reading legend returns');
    assert.ok(!footer.includes('enter/esc keep'), 'the search keys leave with the box');
    assert.equal((lines.join('\n').match(/esc/g) || []).length, 1, 'still one escape hint');
  });

  test('the issue total lives in the tab, never a second time under the list', async () => {
    const view = await opened();
    const body = bodyOf(view, 80);
    assert.match(body, /My issues \(2\)/, 'the tab carries the total');
    assert.ok(!/\b2 issues\b/.test(body), 'no row under the list repeats it');
    assert.match(strip(view.render(80)[1]), /page 1\/1/, 'the fixed indicator names the page position instead');
  });

  test('no chrome row repeats the focused issue title the list and preview already show', async () => {
    const view = await opened();
    const lines = view.render(100).map(strip);
    for (const row of lines.slice(0, 4)) {
      assert.ok(!row.includes('issue title 1'), `chrome repeats no focused title: ${row}`);
    }
  });
});

// S16/D2: label and assignee editing is a repository capability, never the
// fact that the user is authenticated. Issue detail carries
// `permissions:{canEditLabels,canEditAssignees,canCreateLabels}`; absent or
// unknown reads as false, so the footer hint disappears AND the key cannot
// enter the editor — the same gate for both, and no loader or write runs.
describe('S16: repository permissions gate the label and assignee editors', () => {
  const users = () => ({ ok: true, users: [{ login: 'ann', name: 'Ann' }, { login: 'bob', name: '' }, { login: 'carol', name: 'Carol' }] });

  test('the footer names each editor only for a permission confirmed true', async () => {
    const cases = [
      [EDITABLE, true],
      [{}, false],
      [undefined, false],
      [{ canEditLabels: 'yes', canEditAssignees: 1 }, false],
    ];
    for (const [permissions, shown] of cases) {
      const rows = [issue(1)];
      const { view } = makeView({
        pages: pagesOf([rows, [], []]),
        issues: rows,
        loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions }), comments: [] }),
      });
      await tick();
      const body = bodyOf(view, 220);
      assert.equal(body.includes('L labels'), shown, `labels hint for ${JSON.stringify(permissions)}`);
      assert.equal(body.includes('a assign'), shown, `assignees hint for ${JSON.stringify(permissions)}`);
    }
  });

  test('l and a neither enter an editor nor load or write without permission', async () => {
    for (const permissions of [undefined, {}, { canEditLabels: false, canEditAssignees: false }]) {
      const calls = [];
      const rows = [issue(1)];
      const { view } = makeView({
        pages: pagesOf([rows, [], []]),
        issues: rows,
        labels: [{ name: 'bug' }],
        loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions }), comments: [] }),
        loadAssignees: () => { calls.push('loadAssignees'); return users(); },
        actions: {
          editLabels: () => { calls.push('editLabels'); return { ok: true }; },
          editAssignees: () => { calls.push('editAssignees'); return { ok: true }; },
        },
      });
      await tick();
      view.handleInput('l');
      view.handleInput('a');
      await tick();
      assert.equal(view.state.mode, 'list', `no editor opens for ${JSON.stringify(permissions)}`);
      assert.deepEqual(calls, [], 'no loader and no write ran');
      assert.match(bodyOf(view, 124), /permission/, 'the refusal names the missing permission');
    }
  });

  test('a opens the assignee editor preselected and saves add/remove deltas', async () => {
    const calls = [];
    const loads = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n, opts) => {
        loads.push(opts);
        const assignees = loads.length === 1 ? [{ login: 'bob' }] : [{ login: 'ann' }];
        return { ok: true, issue: issue(n, { permissions: EDITABLE, assignees }), comments: [] };
      },
      loadAssignees: () => users(),
      actions: { editAssignees: (number, changes) => { calls.push([number, changes]); return { ok: true }; } },
    });
    await tick();
    view.handleInput('a');
    assert.equal(view.state.mode, 'assignees');
    await tick();
    const editor = bodyOf(view, 100);
    assert.match(editor, /\[x\] bob/, 'the current assignee starts selected');
    assert.match(editor, /\[ \] ann/, 'an unassigned user starts unselected');
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(calls, [[1, { add: ['ann'], remove: ['bob'] }]], 'one delta call: add ann, remove bob');
    assert.equal(view.state.mode, 'list', 'success leaves the editor');
    assert.deepEqual(loads[1], { refresh: true }, 'the saved detail is refetched, never served from the cache');
    const body = bodyOf(view, 100);
    assert.match(body, /assignees: ann/, 'the preview shows the refetched assignees');
    assert.ok(!body.includes('assignees: bob'), 'the pre-save detail is gone');
  });

  test('the create-label row and key need canCreateLabels, not just triage', async () => {
    const created = [];
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }],
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: { canEditLabels: true, canCreateLabels: false } }),
        comments: [],
      }),
      actions: { editLabels: (_n, add, remove, made) => { created.push([add, remove, made]); return { ok: true }; } },
    });
    await tick();
    view.handleInput('l');
    assert.equal(view.state.mode, 'labels', 'triage permission alone still opens the editor');
    const editor = bodyOf(view, 100);
    assert.ok(!editor.includes('create new'), 'no create row without canCreateLabels');
    view.handleInput('n');
    assert.equal(view.state.labelCreating, false, 'n starts no creation');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(created, [[[], [], []]], 'no label creation was sent');
  });

  test('a rejected assignee save keeps the editor, the toggles and a visible error', async () => {
    const loads = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n, opts) => {
        loads.push(opts);
        return { ok: true, issue: issue(n, { permissions: EDITABLE, assignees: [{ login: 'bob' }] }), comments: [] };
      },
      loadAssignees: () => users(),
      actions: { editAssignees: () => ({ ok: false, error: 'permission denied by GitHub' }) },
    });
    await tick();
    view.handleInput('a');
    await tick();
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(view.state.mode, 'assignees', 'the editor stays open');
    const body = bodyOf(view, 100);
    assert.match(body, /permission denied by GitHub/, 'the server rejection is visible');
    assert.match(body, /\[x\] ann/, 'the local toggle survives the rejection');
    assert.match(body, /\[x\] bob/, 'the stored assignee is unchanged');
    assert.equal(loads.length, 1, 'a failed save refetches nothing');
  });

  test('moving focus to an issue without permissions withdraws both hints and both keys', async () => {
    const calls = [];
    const rows = [issue(1), issue(2)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, n === 1 ? { permissions: EDITABLE } : {}), comments: [] }),
      loadAssignees: () => { calls.push('loadAssignees'); return users(); },
    });
    await tick();
    assert.match(bodyOf(view, 220), /L labels/, 'the permitted issue shows the hint');
    view.handleInput('j');
    await tick();
    const body = bodyOf(view, 220);
    assert.ok(!body.includes('L labels'), 'the labels hint is gone');
    assert.ok(!body.includes('a assign'), 'the assignees hint is gone');
    view.handleInput('a');
    await tick();
    assert.equal(view.state.mode, 'list', 'the key cannot enter the editor');
    assert.deepEqual(calls, [], 'no assignee loader ran');
  });
});

// S3/S5/D1/D3: the widened wrapping left list and the server-page seam.
describe('issues left list width, wrapping and fresh pages (S3/S5/D1/D3)', () => {
  // One issue carrying its server cursor, as D1 delivers it.
  function cursorIssue(cursor, row) {
    return { ...row, cursor };
  }

  function page(issues, extra = {}) {
    return { ok: true, issues, total: issues.length, hasNextPage: false, ...extra };
  }

  test('the left pane takes the shared half width at 40, 80, 120 and 200 columns', async () => {
    for (const width of [40, 80, 120, 200]) {
      const { view } = makeView({
        rows: 24,
        loadIssuePage: () => page([cursorIssue('c1', issue(1, { title: 'short title' }))]),
        loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      });
      await tick();
      const expected = layout.paneWidths(layout.innerWidth(width)).left;
      const bodyRow = strip(view.render(width)[5]);
      const chars = [...bodyRow];
      assert.equal(chars.indexOf('│', 2), 3 + expected, `${width}: the left pane is ${expected} cells`);
      if (width >= 100) assert.ok(expected > 36, `${width}: no old 34/36-column cap survives`);
    }
  });

  test('the left list shows the full wrapped title and never the issue number', async () => {
    const title = 'wrapped title that keeps every single word of the issue visible';
    const { view } = makeView({
      rows: 30,
      loadIssuePage: () => page([cursorIssue('c1', issue(7, { title }))]),
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title }), comments: [] }),
    });
    await tick();
    const left = leftColumn(view, 80, 30);
    assert.ok(!left.includes('#7'), 'the issue number is not in the left list');
    assert.equal(left.replace(/\s+/g, ' ').includes(title), true, 'the whole title is readable');
    const rows = left.split('\n').filter((row) => row.trim() !== '');
    assert.ok(rows.length > 1, 'a title too long for one row wraps onto the next');
    assert.ok(rows.slice(0, rows.length - 1).length >= 2, 'the wrap uses as many rows as it needs');
  });

  test('the request limit comes from the viewport body height, never from a fixed 20', async () => {
    for (const [rows, expected] of [[12, 6], [14, 8], [30, 24], [40, 34]]) {
      const calls = [];
      const { view } = makeView({
        rows,
        loadIssuePage: (request) => {
          calls.push(request);
          return page([cursorIssue('c1', issue(1))]);
        },
      });
      await tick();
      assert.equal(calls.length, 1, `${rows}: one mount read`);
      assert.equal(calls[0].limit, expected, `${rows}: limit is the body-row upper bound`);
      assert.equal(calls[0].cursor, null, `${rows}: the first page starts at the head`);
      assert.equal(calls[0].bucketId, 'mine', `${rows}: the request names its bucket`);
      assert.ok(view);
    }
  });

  test('the next page starts after the LAST SHOWN cursor, never after unused fetched rows', async () => {
    const calls = [];
    // Both titles wrap past the body budget on their own, so only the first
    // row can be shown and the second page must start after it.
    const served = [
      cursorIssue('ca', issue(1, { title: 'alpha beta gamma delta epsilon zeta eta theta' })),
      cursorIssue('cb', issue(2, { title: 'one two three four five six seven eight nine ten' })),
    ];
    const { view } = makeView({
      rows: 12,
      loadIssuePage: (request) => {
        calls.push(request);
        return page(served, { hasNextPage: true });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const left = leftColumn(view, 40, 12);
    assert.match(left, /alpha/, 'the first row fits');
    assert.ok(!left.includes('one two'), 'the row that does not fit is not shown');
    view.handleInput(']');
    assert.equal(calls.length, 2, 'the arrow asked for the next page');
    assert.equal(calls[1].cursor, 'ca', 'the next page starts after the LAST SHOWN row');
    assert.equal(calls[1].limit, 6, 'the limit follows the body budget again');
  });

  test('previous and r fetch fresh pages, and tab switches the bucket', async () => {
    const calls = [];
    const { view } = makeView({
      rows: 12,
      loadIssuePage: (request) => {
        calls.push(request);
        const issues = request.cursor === null
          ? [cursorIssue('ca', issue(1)), cursorIssue('cb', issue(2))]
          : [cursorIssue('cc', issue(3))];
        return page(issues, { hasNextPage: request.cursor === null });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    // The host paints before it accepts a key, and only a painted list knows
    // which row was the LAST SHOWN one.
    leftColumn(view, 60, 12);
    view.handleInput(']');
    view.handleInput('[');
    assert.equal(calls.length, 3, 'previous is a real request, never a cached list');
    assert.equal(calls[2].cursor, null, 'page one starts at the head again');
    view.handleInput('r');
    assert.equal(calls.length, 4, 'r re-reads the current page');
    assert.equal(calls[3].cursor, null, 'r re-reads the page the reader is on');
    assert.equal(calls[3].bucketId, 'mine');
    view.handleInput('tab');
    assert.equal(calls.length, 5, 'the new bucket is read on selection');
    assert.equal(calls[4].bucketId, 'assigned', 'tab moves to the next bucket');
  });

  test('r refreshes the focused preview even when the page answers with the same issues', async () => {
    const served = [cursorIssue('ca', issue(1)), cursorIssue('cb', issue(2))];
    let comments = [];
    let loads = 0;
    const { view } = makeView({
      rows: 20,
      loadIssuePage: () => page(served, { hasNextPage: false }),
      loadIssue: (n) => {
        loads += 1;
        return { ok: true, issue: issue(n), comments: comments.slice() };
      },
    });
    await tick();
    leftColumn(view, 60, 20);
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'the second issue is focused');
    comments = [{ author: 'ann', createdAt: new Date().toISOString(), body: 'fresh comment' }];
    const before = loads;
    view.handleInput('r');
    await tick();
    assert.ok(loads > before, 'the focused detail is refetched');
    const body = bodyOf(view, 60);
    assert.match(body, /#2 /, 'the reader stays on the same issue');
    assert.match(body, /fresh comment/, 'the refreshed preview shows the new comment');
  });

  test('a resize resets the page boundaries and a stale answer never paints', async () => {
    const pending = [];
    const { view } = makeView({
      rows: 30,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    pending[0].entry.resolve(page([cursorIssue('c1', issue(1)), cursorIssue('c2', issue(2))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    view.handleInput(']');
    assert.equal(pending[1].request.cursor, 'c2', 'the second page starts after the last shown row');
    pending[1].entry.resolve(page([cursorIssue('c3', issue(3))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    assert.equal(view.state.listPage, 2);
    // S5/D1: boundaries derived from another viewport cannot survive a resize.
    bodyOf(view, 60);
    assert.equal(pending.length, 3, 'the resize reads the first page again');
    assert.equal(pending[2].request.cursor, null, 'the reset page starts at the head');
    assert.equal(view.state.listPage, 1, 'the page position is back at one');
    view.handleInput('r');
    assert.equal(pending.length, 4, 'r asks again');
    pending[3].entry.resolve(page([cursorIssue('c4', issue(9, { title: 'newest answer' }))]));
    await tick();
    pending[2].entry.resolve(page([cursorIssue('c0', issue(8, { title: 'stale answer' }))], { hasNextPage: true }));
    await tick();
    const left = leftColumn(view, 60, 30);
    assert.match(left, /newest answer/, 'the newest request paints');
    assert.ok(!left.includes('stale answer'), 'an earlier answer never overwrites it');
  });

  test('a resize invalidates an inactive bucket too, so its stale page never paints', async () => {
    const pending = [];
    const { view } = makeView({
      rows: 30,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    // The first bucket is read, then the reader moves to the second one and
    // leaves a second-page request in flight there.
    pending[0].entry.resolve(page([cursorIssue('a1', issue(1))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    view.handleInput('tab');
    pending[1].entry.resolve(page([cursorIssue('b1', issue(2))], { hasNextPage: true }));
    await tick();
    bodyOf(view, 120);
    view.handleInput(']');
    assert.equal(pending[2].request.cursor, 'b1', 'the inactive bucket has a second page in flight');
    // Moving on and resizing must invalidate that answer too: the reset
    // boundaries describe the new viewport, so a page requested for the old
    // one cannot paint into them just because the bucket is not on screen.
    view.handleInput('tab');
    pending[3].entry.resolve(page([cursorIssue('c1', issue(3))]));
    await tick();
    bodyOf(view, 120);
    bodyOf(view, 60);
    pending[2].entry.resolve(page([
      cursorIssue('b2', issue(9, { title: 'stale second page' })),
    ], { hasNextPage: true }));
    await tick();
    // S15 added the fourth All bucket, so returning to Assigned from Involved
    // takes three tabs (All, Mine, Assigned) instead of two.
    view.handleInput('tab');
    view.handleInput('tab');
    view.handleInput('tab');
    const left = leftColumn(view, 60, 30);
    assert.match(left, /issue title 2/, 'the bucket reads the page the reset recorded');
    assert.ok(!left.includes('stale second page'), 'the earlier bucket answer never paints after a resize');
    const returned = pending[pending.length - 1].request;
    assert.equal(returned.bucketId, 'assigned', 'the bucket is read again on return');
    assert.equal(returned.cursor, null, 'and it starts at the head of the reset page');
  });

  test('a failed page load is shown truthfully while the view stays mounted', async () => {
    const { view } = makeView({
      loadIssuePage: () => ({ ok: false, error: 'gh issue list failed: HTTP 403: rate limited' }),
    });
    await tick();
    const body = bodyOf(view, 80);
    assert.match(body, /failed to load issues: gh issue list failed: HTTP 403: rate limited/);
    assert.ok(!body.includes('issue title'), 'no rows are invented');
    assert.match(bodyOf(view, 160), /esc close/, 'the footer still names the close key');
  });

  test('static pages stay supported with no loader at all', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1, { title: 'static row' })], [], []]),
      loadIssue: (n) => ({ ok: true, issue: issue(n, { title: 'static row' }), comments: [] }),
    });
    await tick();
    assert.match(leftColumn(view, 100), /static row/, 'the eager pages still render');
    assert.match(bodyOf(view, 100), /page 1\/1/);
    assert.ok(!leftColumn(view, 100).includes('#1'), 'the eager path drops the number too');
  });
});

// S9/S13/S15: the fourth All bucket, a tab switch that reuses what it already
// loaded, and search over the COMPLETE bucket through the server page seam.
// Every request is a public input: the loader receives
// {bucketId, cursor, limit, query}.
describe('issues view All tab, tab cache and server search (S9/S13/S15)', () => {
  test('the fourth tab All lists every open issue of the repository with no dedup', async () => {
    const requests = [];
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => {
        requests.push(request);
        if (request.bucketId === 'all') {
          return pageResult([cursorRow('a1', issue(76, { title: 'belt and braces' })), cursorRow('a2', issue(77))], { total: 2 });
        }
        return pageResult([cursorRow('m1', issue(76, { title: 'belt and braces' }))], { total: 1 });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const tabs = strip(view.render(100)[2]);
    assert.match(tabs, /▸ My issues \(1\)/, 'the default bucket is still first');
    assert.match(tabs, /Assigned \(–\)/);
    assert.match(tabs, /Involved \(–\)/);
    assert.match(tabs, /All \(–\)/, 'an unread tab is unknown, never a false zero');
    assert.equal(requests.length, 1, 'only the default bucket was read');
    assert.equal(requests[0].bucketId, 'mine');
    view.handleInput('tab');
    view.handleInput('tab');
    view.handleInput('tab');
    await tick();
    assert.equal(view.state.page, 3, 'All is the fourth and last tab');
    assert.equal(requests[requests.length - 1].bucketId, 'all', 'All reads the whole open repository');
    assert.match(strip(view.render(100)[2]), /All \(2\)/, 'the All tab counts the whole open repository');
    const left = leftColumn(view, 100);
    assert.match(left, /belt and braces/, 'an issue that also lists under My issues lists here too');
    assert.match(left, /issue title 77/, 'the other open issue is listed');
    assert.equal(left.split('belt and braces').length - 1, 1, 'the list holds no duplicate row');
  });

  test('returning to a visited bucket reuses its rows and page with no request and no loading flash', async () => {
    const requests = [];
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => {
        requests.push(request);
        return pageResult([cursorRow('p1', issue(1)), cursorRow('p2', issue(2))], { hasNextPage: true });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.equal(requests.length, 1, 'the mount read the first bucket once');
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    assert.equal(requests.length, 2, 'paging reads the next page');
    view.handleInput('tab');
    await tick();
    assert.equal(requests.length, 3, 'a bucket visited for the first time is read');
    view.handleInput('shift+tab');
    await tick();
    assert.equal(requests.length, 3, 'returning to the visited bucket reads nothing');
    assert.equal(view.state.loading, false, 'the switch never enters the loading state');
    assert.equal(view.state.listPage, 2, 'the bucket keeps the page the reader left it on');
    const rendered = strip(view.render(100).join('\n'));
    assert.match(rendered, /issue title 2/, 'the loaded rows paint again');
    assert.ok(!rendered.includes('loading'), 'no loading line and no loading flash on the reused frame');
  });

  test('every page request names its bucket, row budget and exact query, and a new query starts at the head', async () => {
    const clock = manualScheduler();
    const requests = [];
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        requests.push(request);
        const head = request.cursor === null;
        return pageResult([cursorRow(head ? 'q1' : 'q2', issue(head ? 1 : 2))], { hasNextPage: true, total: 2 });
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.deepEqual(
      requests[0],
      { bucketId: 'mine', cursor: null, limit: 18, query: '' },
      'the mount read names its bucket, its body-row budget and the empty query',
    );
    view.handleInput('T');
    for (const ch of 'label:bug') view.handleInput(ch);
    assert.equal(requests.length, 1, 'typing only schedules the read');
    clock.fire();
    await tick();
    assert.equal(requests.length, 2, 'the settled burst is ONE request');
    assert.deepEqual(
      requests[1],
      { bucketId: 'mine', cursor: null, limit: 18, query: 'label:bug' },
      'the read carries the whole query, at the head of its own result set',
    );
    view.handleInput('enter');
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    assert.deepEqual(
      requests[2],
      { bucketId: 'mine', cursor: 'q1', limit: 18, query: 'label:bug' },
      'the next page starts after the last shown row of the same query',
    );
    view.handleInput('r');
    await tick();
    assert.deepEqual(
      requests[3],
      { bucketId: 'mine', cursor: 'q1', limit: 18, query: 'label:bug' },
      'r re-reads the current page of the current query',
    );
    assert.equal(view.state.listPage, 2, 'the refresh keeps the page the reader is on');
  });

  test('a stale query answer never replaces the newer query state', async () => {
    const clock = manualScheduler();
    const pending = [];
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    pending[0].entry.resolve(pageResult([cursorRow('m1', issue(1))], { total: 1 }));
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    clock.fire();
    assert.deepEqual(pending.slice(1).map((entry) => entry.request.query), ['a'], 'the settled query is read once');
    view.handleInput('b');
    clock.fire();
    assert.deepEqual(pending.slice(1).map((entry) => entry.request.query), ['a', 'ab'], 'the next settled query reads its own');
    pending[2].entry.resolve(pageResult([cursorRow('n1', issue(2, { title: 'ab match' }))], { total: 1 }));
    await tick();
    pending[1].entry.resolve(pageResult([cursorRow('o1', issue(3, { title: 'a only match' }))], { total: 1 }));
    await tick();
    const left = leftColumn(view, 100);
    assert.match(left, /ab match/, 'the newest query answer paints');
    assert.ok(!left.includes('a only match'), 'the answer for the older query never paints');
    assert.equal(view.state.loading, false);
  });

  test('server answers are never re-filtered as literal text for GitHub operators', async () => {
    const clock = manualScheduler();
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: () => pageResult([cursorRow('x1', issue(5, { title: 'crash on logout' }))], { total: 1 }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'label:bug') view.handleInput(ch);
    clock.fire();
    await tick();
    assert.equal(view.state.query, 'label:bug');
    const left = leftColumn(view, 100);
    assert.match(
      left,
      /crash on logout/,
      'a row the server matched for label:bug still lists although its title holds no operator word',
    );
  });

  test('a search result that lands on the second server page is selectable and previews its detail', async () => {
    const loads = [];
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => (request.cursor === null
        ? pageResult([cursorRow('s1', issue(41, { title: 'first hit' }))], { hasNextPage: true, total: 2 })
        : pageResult([cursorRow('s2', issue(42, { title: 'second hit' }))], { hasNextPage: false, total: 2 })),
      loadIssue: (n) => {
        loads.push(n);
        return { ok: true, issue: issue(n), comments: [] };
      },
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'is:open') view.handleInput(ch);
    await tick();
    // The box holds the keyboard, so the filter is committed before paging.
    view.handleInput('enter');
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    const left = leftColumn(view, 100);
    assert.match(left, /second hit/, 'the second page of the search answer is listed');
    assert.ok(!left.includes('first hit'), 'the previous page is not repeated');
    assert.ok(loads.includes(42), 'the second-page row previews its own detail');
    assert.match(bodyOf(view, 100), /#42/, 'the focused row is the second-page issue');
  });
});

// S14: the page indicator is fixed chrome on the search row — present even for
// a single page — and the list spends its whole body budget on issues.
describe('issues page indicator on the search row (S14)', () => {
  test('the indicator sits beside Search always, including a single page', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      rows: 24,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    for (const width of [80, 120]) {
      const lines = view.render(width).map(strip);
      assert.match(lines[1], /› Search/, 'the search widget keeps its row');
      assert.match(lines[1], /page 1\/1/, `width ${width}: the indicator is fixed beside search, even for one page`);
      assert.ok(!leftColumn(view, width).includes('page'), `width ${width}: the list spends no row on the indicator`);
      assert.ok(!/page 1\/1/.test(lines[lines.length - 2]), 'the footer still carries keys only');
    }
    view.handleInput('T');
    view.handleInput('1');
    assert.match(strip(view.render(80)[1]), /page 1\/1/, 'the indicator stays while the query is typed');
    view.handleInput('escape');
    assert.match(strip(view.render(80)[1]), /page 1\/1/, 'and after the query is kept');
  });

  test('a server frame names its own page and marks only a confirmed next page', async () => {
    const { view } = makeView({
      rows: 24,
      loadIssuePage: (request) => (request.cursor === null
        ? { ok: true, issues: [cursorRow('n1', issue(1))], total: 2, hasNextPage: true }
        : { ok: true, issues: [cursorRow('n2', issue(2))], total: 2, hasNextPage: false }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(strip(view.render(100)[1]), /page 1\+/, 'a confirmed next page is marked');
    leftColumn(view, 100);
    view.handleInput(']');
    await tick();
    assert.match(strip(view.render(100)[1]), /page 2(?!\+)/, 'the last page carries no marker');
    assert.ok(!leftColumn(view, 100).includes('page'), 'the list holds rows only');
  });
});

// S10/S11: a write owns the view from its key until its answer, and the comment
// caret marks the real insertion point. Every action is a deferred public seam,
// so the busy frame, the key lock and the unlock are observed without timers.
describe('issues view pending writes and comment caret (S10/S11)', () => {
  const LOCKED_KEYS = ['ctrl+s', 'tab', 'shift+tab', 'escape', 'enter', 'y', 'j', 'k', 'down', 'up', 'T', 'q', 'x', 'r', 'right', 'left'];

  test('a label save paints its busy frame first, locks every key, then unlocks on success', async () => {
    const gate = deferred();
    const calls = [];
    let saved = ['bug'];
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view, paints } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: saved.map((name) => ({ name })), permissions: EDITABLE }),
        comments: [],
      }),
      actions: {
        editLabels: (n, add, remove, created) => {
          calls.push([n, add, remove, created]);
          saved = ['bug', ...add];
          return gate.promise;
        },
      },
    });
    await tick();
    view.handleInput('L');
    view.handleInput('down');
    view.handleInput('space');
    const before = paints.length;
    view.handleInput('ctrl+s');
    assert.ok(paints.length > before, 'the busy state repaints before the answer arrives');
    assert.equal(view.state.saving, 'labels', 'the pending write is recorded at once');
    const busy = strip(view.render(100).join('\n'));
    assert.match(busy, /saving labels/, 'the busy frame names what is in flight');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    assert.equal(calls.length, 1, 'no second write is sent');
    assert.equal(view.state.mode, 'labels', 'the editor stays the visible state');
    assert.equal(view.state.page, 0, 'no tab move while pending');
    assert.equal(view.state.index, 0, 'no list move while pending');
    assert.equal(view.state.searching, false, 'no typing while pending');
    assert.equal(strip(view.render(100).join('\n')), busy, 'the pending frame is stable while keys arrive');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'the answer unlocks the view');
    assert.equal(view.state.mode, 'list');
    const settled = bodyOf(view, 100);
    assert.match(settled, /labels: bug, docs/, 'the refetched preview shows the saved labels');
    assert.ok(!settled.includes('saving labels'), 'the busy line is gone once it settled');
    assert.deepEqual(calls, [[1, ['docs'], [], []]], 'exactly one apply with the toggled delta');
  });

  test('a rejected label save unlocks and keeps the toggles', async () => {
    const gate = deferred();
    const rows = [issue(1, { labels: [{ name: 'bug' }] })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      labels: [{ name: 'bug' }, { name: 'docs' }],
      loadIssue: (n) => ({
        ok: true,
        issue: issue(n, { labels: [{ name: 'bug' }], permissions: EDITABLE }),
        comments: [],
      }),
      actions: { editLabels: () => gate.promise },
    });
    await tick();
    view.handleInput('L');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    gate.resolve({ ok: false, error: 'permission denied by GitHub' });
    await tick();
    assert.equal(view.state.saving, null, 'a rejected save unlocks the view');
    assert.equal(view.state.mode, 'labels', 'the editor stays open');
    const body = bodyOf(view, 100);
    assert.match(body, /permission denied by GitHub/, 'the real error is shown');
    assert.match(body, /\[x\] docs/, 'the toggled label survives the rejection');
    assert.ok(!body.includes('saving labels'), 'the busy line is gone');
  });

  test('an assignee save locks the view while pending and shows the saved state after', async () => {
    const gate = deferred();
    const calls = [];
    let assignees = [{ login: 'bob' }];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { permissions: EDITABLE, assignees }), comments: [] }),
      loadAssignees: () => ({ ok: true, users: [{ login: 'ann', name: 'Ann' }, { login: 'bob', name: '' }] }),
      actions: {
        editAssignees: (n, changes) => {
          calls.push([n, changes]);
          assignees = [{ login: 'ann' }];
          return gate.promise;
        },
      },
    });
    await tick();
    view.handleInput('a');
    await tick();
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    assert.equal(view.state.saving, 'assignees');
    assert.match(strip(view.render(100).join('\n')), /saving assignees/, 'the busy frame names the save');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    assert.equal(calls.length, 1, 'no duplicate assignee write');
    assert.match(bodyOf(view, 100), /\[x\] ann/, 'the pending frame keeps the draft toggles');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'success unlocks the view');
    assert.equal(view.state.mode, 'list');
    assert.deepEqual(calls, [[1, { add: ['ann'], remove: ['bob'] }]], 'one delta write');
    assert.match(bodyOf(view, 100), /assignees: ann/, 'the refetched preview shows the saved assignee');
  });

  test('a comment save locks typing while pending, then shows the posted comment', async () => {
    const gate = deferred();
    const calls = [];
    let comments = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: comments.slice() }),
      actions: {
        postComment: (n, text) => {
          calls.push([n, text]);
          comments = [{ author: 'octo', createdAt: new Date().toISOString(), body: text }];
          return gate.promise;
        },
      },
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'ship it') view.handleInput(ch);
    view.handleInput('ctrl+s');
    assert.equal(view.state.saving, 'comment');
    assert.match(strip(view.render(100).join('\n')), /posting comment/, 'the busy frame names the post in flight');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    for (const ch of 'xyz') view.handleInput(ch);
    assert.equal(view.state.commentText, 'ship it', 'typing is locked while the post is pending');
    assert.equal(view.state.mode, 'comment', 'esc cannot leave a pending post');
    assert.equal(calls.length, 1, 'no second post');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'success unlocks the view');
    assert.equal(view.state.mode, 'list', 'success leaves the editor');
    const settled = bodyOf(view, 100);
    assert.match(settled, /ship it/, 'the posted comment is displayed');
    assert.match(settled, /comment posted/);
    assert.equal(view.state.commentText, '', 'the sent draft is cleared');
  });

  test('a close save locks the confirmation while pending and then drops the issue', async () => {
    const gate = deferred();
    const calls = [];
    const rows = [issue(1), issue(2)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      actions: { setState: (n, state) => { calls.push([n, state]); return gate.promise; } },
    });
    await tick();
    view.handleInput('x');
    view.handleInput('enter');
    assert.equal(view.state.saving, 'close');
    assert.match(strip(view.render(100).join('\n')), /closing issue/, 'the busy frame names the close');
    for (const key of LOCKED_KEYS) view.handleInput(key);
    assert.equal(calls.length, 1, 'no duplicate close');
    assert.equal(view.state.mode, 'confirm', 'the confirmation stays visible while pending');
    gate.resolve({ ok: true });
    await tick();
    assert.equal(view.state.saving, null, 'success unlocks the view');
    assert.equal(view.state.mode, 'list');
    assert.deepEqual(calls, [[1, 'closed']], 'one close write');
    assert.ok(!leftColumn(view, 100).includes('issue title 1'), 'the closed issue leaves the open list');
    assert.match(leftColumn(view, 100), /issue title 2/, 'the remaining open issue stays listed');
  });

  test('a failed save keeps the draft and its error, and the view is usable again', async () => {
    const gate = deferred();
    const calls = [];
    const rows = [issue(1)];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      actions: { postComment: (n, text) => { calls.push([n, text]); return gate.promise; } },
    });
    await tick();
    view.handleInput('c');
    for (const ch of 'keep this') view.handleInput(ch);
    view.handleInput('ctrl+s');
    gate.resolve({ ok: false, error: 'rate limited' });
    await tick();
    assert.equal(view.state.saving, null, 'a rejected save unlocks the view');
    assert.equal(view.state.mode, 'comment', 'the editor and its draft survive the failure');
    const body = bodyOf(view, 100);
    assert.match(body, /rate limited/, 'the real error is shown');
    assert.match(body, /keep this/, 'the draft is preserved');
    assert.ok(!body.includes('posting comment'), 'the busy line is gone');
    assert.equal(calls.length, 1);
    view.handleInput('escape');
    assert.equal(view.state.mode, 'comment', 'esc still asks before discarding a draft');
    assert.match(strip(view.render(100).join('\n')), /Discard this draft/, 'the safe cancel behaviour is unchanged');
  });

  test('the comment editor paints the caret at the insertion point (S11)', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('c');
    assert.match(bodyOf(view, 100), /█/, 'an empty draft shows where typing lands');
    for (const ch of 'hi') view.handleInput(ch);
    assert.match(bodyOf(view, 100), /hi█/, 'the caret follows the typed text');
    view.handleInput('enter');
    for (const ch of 'there') view.handleInput(ch);
    const body = bodyOf(view, 100);
    assert.match(body, /there█/, 'on a new line the caret sits after the last typed character');
    assert.ok(!/h█i/.test(body), 'the caret is never detached from the insertion point');
    view.handleInput('backspace');
    assert.match(bodyOf(view, 100), /ther█/, 'Backspace moves the caret back with the text');
  });
});

// S9 (round 3, second pass): remote search is debounced. The clock is injected
// (scheduleQuery/cancelSchedule), so a burst of typing, the stale answer inside
// the wait and every flush point are observed without wall-clock waits.
describe('issues remote search scheduling (S9)', () => {
  function scheduledServerView(clock, serve, overrides = {}) {
    const requests = [];
    const made = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        requests.push(request);
        return serve(request);
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
      ...overrides,
    });
    return { ...made, requests };
  }

  test('a burst of typing schedules ONE read for the query it settles on', async () => {
    const clock = manualScheduler();
    const { view, requests, paints } = scheduledServerView(clock, () => pageResult([cursorRow('m1', issue(1))], { total: 1 }));
    await tick();
    assert.equal(requests.length, 1, 'the mount read is never debounced');
    const before = paints.length;
    view.handleInput('T');
    for (const ch of 'crash') view.handleInput(ch);
    assert.equal(view.state.query, 'crash', 'the query is recorded at once');
    assert.match(strip(view.render(100)[1]), /› crash█/, 'the box shows the query and its caret at once');
    assert.equal(requests.length, 1, 'no request per keystroke');
    assert.ok(paints.length > before, 'each keystroke repaints the box');
    assert.equal(view.state.searchPending, true, 'the scheduled read is visible state');
    const waiting = strip(view.render(100).join('\n'));
    assert.match(waiting, /searching/, 'the frame names the search being scheduled');
    assert.match(waiting, /issue title 1/, 'the rows already loaded stay on screen');
    assert.ok(!waiting.includes('loading issues'), 'no full-screen loader flash while typing');
    assert.equal(clock.live().length, 1, 'one live callback, never one per keystroke');
    assert.ok(clock.live()[0].delayMs >= 100 && clock.live()[0].delayMs <= 250,
      `a short fixed debounce delay: ${clock.live()[0].delayMs}`);
    clock.fire();
    assert.equal(requests.length, 2, 'the settled query reads once');
    assert.deepEqual(requests[1], { bucketId: 'mine', cursor: null, limit: 18, query: 'crash' });
    assert.equal(view.state.searchPending, false, 'the wait ends when the read starts');
  });

  test('an answer for the previous query cannot paint while the new one waits', async () => {
    const clock = manualScheduler();
    const pending = [];
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: (request) => {
        const entry = deferred();
        pending.push({ request, entry });
        return entry.promise;
      },
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    pending[0].entry.resolve(pageResult([cursorRow('m1', issue(1, { title: 'mount row' }))], { total: 1 }));
    await tick();
    leftColumn(view, 100);
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('enter');            // the 'a' read is in flight
    assert.deepEqual(pending[1].request, { bucketId: 'mine', cursor: null, limit: 18, query: 'a' });
    view.handleInput('T');
    view.handleInput('b');                // 'ab' waits, so 'a' is already stale
    pending[1].entry.resolve(pageResult([cursorRow('o1', issue(9, { title: 'a only match' }))], { total: 1 }));
    await tick();
    const waiting = leftColumn(view, 100);
    assert.match(waiting, /mount row/, 'the rows on screen are the ones the reader last saw');
    assert.ok(!waiting.includes('a only match'), 'the answer for the superseded query never paints');
    clock.fire();
    pending[2].entry.resolve(pageResult([cursorRow('n1', issue(3, { title: 'ab match' }))], { total: 1 }));
    await tick();
    assert.match(leftColumn(view, 100), /ab match/, 'only the newest query answer paints');
    assert.equal(pending.length, 3, 'exactly three reads: mount, flushed query, settled query');
  });

  test('leaving the box reads the pending query once and never twice', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, () => pageResult([cursorRow('b1', issue(2))], { total: 1 }));
    await tick();
    view.handleInput('T');
    for (const ch of 'bug') view.handleInput(ch);
    assert.equal(requests.length, 1, 'typing waits for the debounce');
    view.handleInput('enter');
    assert.equal(view.state.searching, false);
    assert.equal(requests.length, 2, 'leaving the box issues the read now');
    assert.deepEqual(requests[1], { bucketId: 'mine', cursor: null, limit: 18, query: 'bug' });
    assert.equal(clock.live().length, 0, 'the pending callback is cancelled, not left to fire');
    clock.fire();
    assert.equal(requests.length, 2, 'a cancelled callback never reads');
    view.handleInput('T');
    view.handleInput('x');
    view.handleInput('escape');
    assert.equal(requests.length, 3, 'escape keeps the filter and reads it once too');
    assert.equal(view.state.query, 'bugx', 'escape never changes the typed query');
    assert.equal(clock.live().length, 0);
  });

  test('a refresh under a pending query reads page one of that query only once', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, () => pageResult([cursorRow('g1', issue(1))], { total: 2, hasNextPage: true }));
    await tick();
    view.handleInput('T');
    for (const ch of 'lab') view.handleInput(ch);
    view.handleInput('enter');
    leftColumn(view, 100);
    view.handleInput('r');
    assert.equal(requests.length, 3, 'the explicit refresh reads the current page of the current query');
    assert.deepEqual(requests[2], { bucketId: 'mine', cursor: null, limit: 18, query: 'lab' },
      'never an old cursor, never the previous query');
    clock.fire();
    assert.equal(requests.length, 3, 'no second request from a cancelled callback');
  });

  test('static local search stays immediate and never schedules', async () => {
    const clock = manualScheduler();
    const rows = [issue(1, { title: 'alpha crash' }), issue(2, { title: 'beta typo' })];
    const { view } = makeView({
      pages: pagesOf([rows, [], []]),
      issues: rows,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'beta') view.handleInput(ch);
    assert.equal(view.state.searchPending, false, 'a local list filters without a scheduled read');
    assert.equal(clock.entries.length, 0, 'nothing is scheduled for local search');
    const body = bodyOf(view, 100);
    assert.match(body, /issue title 2/, 'the local filter applies at once');
    assert.ok(!body.includes('alpha crash'), 'the other local row is filtered out');
  });

  test('a late answer after the reader closed paints nothing', async () => {
    const clock = manualScheduler();
    const gate = deferred();
    const paints = [];
    let settled = 'pending';
    const view = createIssuesView({
      rowsAvailable: () => 24,
      helpers,
      theme: plainTheme,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      requestRender: () => { paints.push(true); },
      done: (result) => { settled = result; },
      loadIssuePage: () => gate.promise,
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    view.handleInput('T');
    view.handleInput('q');
    view.handleInput('enter');
    view.handleInput('escape');
    assert.equal(settled, null, 'esc still closes with null');
    const before = paints.length;
    gate.resolve(pageResult([cursorRow('z1', issue(5))], { total: 1 }));
    await tick();
    assert.equal(paints.length, before, 'a late answer repaints nothing after close');
  });

  test('a failed page keeps the rows shown and never invents a count', async () => {
    const clock = manualScheduler();
    const { view, requests } = scheduledServerView(clock, (request) => (request.query === ''
      ? pageResult([cursorRow('f1', issue(1)), cursorRow('f2', issue(2))], { total: 2 })
      : { ok: false, error: 'GitHub issue search exceeds 1000 matches; narrow the filter', truncated: true }));
    await tick();
    view.handleInput('T');
    view.handleInput('z');
    view.handleInput('enter');
    await tick();
    assert.equal(requests.length, 2);
    const body = bodyOf(view, 100);
    assert.match(body, /1000 matches; narrow the filter/, 'the search cap is reported honestly');
    assert.ok(!/1000\+/.test(body), 'no truncated result is claimed as the full dataset');
    assert.match(body, /My issues \(2\)/, 'the count still describes the rows actually listed');
    assert.equal(view.state.loading, false);
  });
});

// S14: the fixed indicator is chrome, so an empty result and a long query keep
// it — the query display is what gets clipped, never the page position.
describe('issues fixed page indicator for empty and long results (S14)', () => {
  function rightColumn(view, width, rows = 24) {
    const panes = layout.paneWidths(layout.innerWidth(width));
    return view.render(width)
      .slice(4, Math.max(4, rows - 2))
      .map((line) => [...strip(line)].slice(5 + panes.left, 5 + panes.left + panes.right).join(''))
      .join('\n');
  }

  test('an empty result keeps page 1/1 beside Search', async () => {
    const { view } = makeView({
      pages: pagesOf([[], [], []]),
      issues: [],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const lines = view.render(100).map(strip);
    assert.match(lines[1], /› Search/, 'the search widget keeps its row');
    assert.match(lines[1], /page 1\/1/, 'the empty list still names its page position');
    assert.ok(!leftColumn(view, 100).includes('page'), 'the list still holds rows only');
    assert.match(bodyOf(view, 100), /no issues/i);
  });

  test('an empty server result names its page without inventing a total', async () => {
    const clock = manualScheduler();
    const { view } = makeView({
      rows: 24,
      scheduleQuery: clock.schedule,
      cancelSchedule: clock.cancel,
      loadIssuePage: () => pageResult([], { total: 0 }),
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    assert.match(strip(view.render(100)[1]), /page 1(?!\/)/, 'a server page names only its own number');
    assert.ok(!/page 1\/1/.test(strip(view.render(100)[1])), 'no total is invented for a server page');
    assert.match(rightColumn(view, 100), /no issues/, 'the empty pane says so honestly');
  });

  test('a long query is clipped in the display only: the marker and the caret stay', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)]], [], []),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    const long = 'author:@me label:bug is:open no:assignee sort:updated-desc milestone:v1 project:roadmap';
    view.handleInput('T');
    for (const ch of long) view.handleInput(ch);
    assert.equal(view.state.query, long, 'the stored query keeps every character');
    const row = strip(view.render(80)[1]);
    assert.match(row, /page 1\/1/, 'the marker is never clipped off the line');
    assert.match(row, /…/, 'the displayed query is clamped');
    assert.ok(row.endsWith('page 1/1 │') || row.includes('page 1/1'), `marker stays on the row: ${row}`);
    assert.match(row, /█/, 'the caret stays visible where typing lands');
    assert.ok(!row.includes(long), 'the full query is not shown at the cost of the marker');
  });

  test('a query the pane can hold is not touched', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)]], [], []),
      issues: [issue(1)],
      loadIssue: (n) => ({ ok: true, issue: issue(n), comments: [] }),
    });
    await tick();
    view.handleInput('T');
    for (const ch of 'bug') view.handleInput(ch);
    assert.match(strip(view.render(120)[1]), /› bug█/, 'a short query renders verbatim');
  });
});

// S16 (T6 hand-over): the Issues preview is the SAME formatter the worktree
// detail uses — lib/issue-preview.js — so the two surfaces cannot drift.
describe('issues preview shares lib/issue-preview.js (S16)', () => {
  const { issueDetailLines } = require('../lib/issue-preview.js');

  function rightColumn(view, width, rows = 24) {
    const panes = layout.paneWidths(layout.innerWidth(width));
    return view.render(width)
      .slice(4, Math.max(4, rows - 2))
      .map((line) => [...strip(line)].slice(5 + panes.left, 5 + panes.left + panes.right).join(''))
      .join('\n');
  }

  const detail = issue(7, {
    title: 'shared preview title',
    labels: [{ name: 'bug' }, { name: 'urgent' }],
    assignees: [{ login: 'ann' }, { login: 'bob' }],
    projects: [{ title: 'Roadmap' }],
    linkedPullRequestCount: 2,
    reactions: { plusOne: 4 },
    commentsCount: 2,
    body: 'the body the preview renders',
  });
  const comments = [
    { author: 'carol', createdAt: new Date(Date.now() - 300_000).toISOString(), body: 'first shared comment' },
    { author: 'dave', createdAt: new Date(Date.now() - 60_000).toISOString(), body: 'second shared comment' },
  ];

  function previewView(theme = plainTheme) {
    return makeView({
      pages: pagesOf([[detail], [], []]),
      issues: [detail],
      rows: 40,
      theme,
      loadIssue: () => ({ ok: true, issue: detail, comments }),
    });
  }

  test('the ready pane is exactly what issueDetailLines renders', async () => {
    const { view } = previewView();
    await tick();
    const panes = layout.paneWidths(layout.innerWidth(100));
    const expected = issueDetailLines(detail, comments, { width: panes.right })
      .map((line) => line.trimEnd());
    const actual = rightColumn(view, 100, 40).split('\n').map((line) => line.trimEnd());
    // Trailing padding rows are frame, not preview.
    while (expected.length > 0 && expected[expected.length - 1] === '') expected.pop();
    while (actual.length > 0 && actual[actual.length - 1] === '') actual.pop();
    assert.deepEqual(actual, expected, 'every field, label, count, blank line and end marker matches the shared formatter');
  });

  test('the preview title takes the accent role the shared formatter paints', async () => {
    const calls = [];
    const theme = {
      fg: (role, text) => { calls.push([role, text]); return String(text); },
      bg: (_role, text) => String(text),
    };
    const { view } = previewView(theme);
    await tick();
    view.render(100);
    assert.ok(
      calls.some(([role, text]) => role === 'accent' && text === '#7 shared preview title'),
      'the title carries the shared formatter styling, not a second local variant',
    );
  });

  test('the error and loading panes stay the view own status lines', async () => {
    const failing = makeView({
      pages: pagesOf([[detail], [], []]),
      issues: [detail],
      rows: 40,
      loadIssue: () => ({ ok: false, error: 'gh timed out' }),
    });
    await tick();
    assert.match(rightColumn(failing.view, 100, 40), /unreadable: gh timed out/,
      'a failed detail read keeps its honest status line');
  });
});


describe('round3 shared preview bindings and lossless comments', () => {
  async function scrollingView(extra = {}) {
    const rows = [issue(1), issue(2)];
    const result = makeView({
      pages: pagesOf([rows, [], []]), issues: rows, rows: 18,
      loadIssue: (n) => ({ ok: true, issue: issue(n, { body: 'body line\n'.repeat(150) }), comments: [] }),
      ...extra,
    });
    result.view.render(220);
    await tick();
    result.view.render(220);
    return result;
  }

  test('extended and printable keys page before a case-folding host can select', async () => {
    const { view, paints } = await scrollingView({ helpers: {
      ...helpers,
      matchesKey: (data, name) => name.length === 1
        ? data.toLowerCase() === name.toLowerCase() : data === name,
    } });
    view.handleInput('pagedown');
    const page = view.state.scroll;
    assert.ok(page > 0);
    for (const key of ['ctrl+shift+j', 'shift+ctrl+j', '\x1b[106;6u', '\x1b[27;6;106~', 'J']) {
      view.handleInput('home');
      view.handleInput(key);
      assert.equal(view.state.scroll, page, key);
      assert.equal(view.state.index, 0, 'paging never selects');
      view.handleInput('K');
      assert.equal(view.state.scroll, 0, 'printable up is a full page');
    }
    const before = paints.length;
    view.handleInput('\x1b[106;6:3u');
    assert.equal(view.state.scroll, 0);
    assert.equal(paints.length, before, 'release never repaints');
    for (const key of ['ctrl+j', 'ctrl+k', '\n', '\r', '\x0b', '\x1b[106;5u']) view.handleInput(key);
    assert.equal(view.state.scroll, 0, 'old Enter/ctrl+j aliases are inert');
    view.handleInput('ctrl+d');
    assert.equal(view.state.scroll, Math.max(1, Math.floor(page / 2)), 'half-page stays distinct');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'lowercase still selects');
    view.handleInput('T');
    view.handleInput('J');
    assert.equal(view.state.query, 'J', 'search receives text, not preview paging');
  });

  test('legend names negotiated capability, not platform or old ctrl+j', async () => {
    for (const active of [false, true]) {
      const { view } = await scrollingView({ helpers: { ...helpers, isKittyProtocolActive: () => active } });
      const footer = strip(view.render(220).at(-2));
      assert.ok(footer.includes(active ? 'ctrl+shift+j/k' : 'shift+j/k'), footer);
      assert.ok(!footer.includes('ctrl+j/k'), footer);
      assert.match(footer, /PgUp\/(?:Pg)?Dn/);
    }
  });

  test('the Issues preview keeps every character of an overlong comment token', async () => {
    const { view } = makeView({
      pages: pagesOf([[issue(1)], [], []]), issues: [issue(1)],
      loadIssue: () => ({ ok: true, issue: issue(1), comments: [{ author: 'writer', body: 'X'.repeat(2500) }] }),
    });
    view.render(110);
    await tick();
    let seen = '';
    let previous = null;
    for (let step = 0; step < 200; step += 1) {
      const body = view.render(110).slice(4, -2).map(strip);
      const scroll = view.state.scroll;
      const overlap = previous === null ? 0 : Math.max(0, previous + body.length - scroll);
      seen += body.slice(overlap).join('');
      if (previous === scroll) break;
      previous = scroll;
      view.handleInput('pagedown');
    }
    assert.equal((seen.match(/X/g) || []).length, 2500);
    assert.match(seen, /end of issue/);
  });
});
