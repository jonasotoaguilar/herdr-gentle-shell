'use strict';
// T2/T3 (warp-popup S1,S2,S5,S6,S9) tests: lib/warp-selector-view.js — the
// redesigned warp selector as ONE component with two views: the framed
// popup (current checkout, create row, bounded checkout list with a final
// "View all" row, the focused checkout's facts, the key footer) and the
// extended list (always-active filter row, pagination, `esc` back one
// level).
//
// Contract under test, as observable output only: every rendered line is
// exactly the requested width and the frame fills the requested height;
// section order is current → create → separator → choose; the list is
// bounded by the height and gains a final "View all" row only when rows
// were left out; the facts line carries branch, issues, odd, uncommitted
// changes, `↑N ↓M` and created-at for the focused checkout and says
// `unavailable` — never `0` — for each fact it cannot read; the facts are
// read for the focused checkout only and cached; S6's printable-key rule
// holds exactly (`space` toggles while the filter is closed, types once it
// is open); `esc` steps back one level from the list; no key outside the
// documented map changes state.
//
// The popup frame is pinned: 9 fixed rows (top rule, current, section
// title, create row, separator, section title, facts, footer, bottom rule)
// plus as many list rows as the height allows. The list frame is pinned: 5
// fixed rows (top rule, filter, page row, footer, bottom rule) plus a page.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createWarpSelectorView, formatFactsLine } = require('../lib/warp-selector-view.js');

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

const WIDTH = 80;
const WIDE = 100;
const HEIGHT = 20;
// Pinned clock: the ages the facts line renders are asserted against this
// instant instead of the host's real time.
const NOW = Date.parse('2026-03-01T00:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const CURRENT = { name: 'feat-odd-viewer', path: '/w/feat-odd-viewer', branch: 'feat/odd-viewer' };
const CHECKOUTS = [
  CURRENT,
  { name: 'main', path: '/w/herdr', branch: 'main', isPrincipal: true },
  { name: 'feat-alpha', path: '/w/feat-alpha', branch: 'feat/alpha' },
  { name: 'fix-beta', path: '/w/fix-beta', branch: 'fix/beta' },
];

const DEFAULT_FACTS = { branch: 'feat/alpha', issues: [12], odd: ['w1-a'], changes: 2, ahead: 1, behind: 0, createdAt: '2026-02-01' };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeView(options = {}) {
  const paints = [];
  const results = [];
  const factCalls = [];
  const reloadCalls = [];
  const toggles = [];
  const factsReader = options.facts || (() => DEFAULT_FACTS);
  const view = createWarpSelectorView({
    checkouts: options.checkouts || CHECKOUTS,
    current: options.current === undefined ? { name: CURRENT.name, path: CURRENT.path } : options.current,
    facts: (path) => {
      factCalls.push(path);
      return factsReader(path);
    },
    reload: options.reload || (() => {
      reloadCalls.push(true);
      return options.reloadTo || CHECKOUTS;
    }),
    onToggle: options.onToggle ? (path) => {
      toggles.push(path);
      return options.onToggle(path);
    } : undefined,
    helpers,
    theme: plainTheme,
    now: options.now === undefined ? NOW : options.now,
    rowsAvailable: () => (options.rows === undefined ? HEIGHT : options.rows),
    requestRender: () => { paints.push(true); },
    done: (value) => { results.push(value); },
  });
  return { view, paints, results, factCalls, reloadCalls, toggles };
}

// Strip the frame and return the exact inner text of every content row
// (the frame is `│ <inner> │`, so inner is width-4 wide).
function screen(view, width = WIDTH) {
  const lines = view.render(width).map(strip);
  const rows = lines.map((line) => (line.startsWith('│') ? line.slice(2, -2).replace(/\s+$/, '') : line));
  return { lines, rows };
}

function assertWidth(lines, width = WIDTH) {
  for (const line of lines) {
    assert.equal(helpers.visibleWidth(line), width, `not ${width} wide: "${line}"`);
  }
}

describe('popup frame (S1)', () => {
  test('renders the title, esc, current checkout, create section, separator, choose section and footer in that order', async () => {
    const { view } = makeView();
    await tick();
    const { lines, rows } = screen(view);
    assert.equal(lines.length, HEIGHT, 'the frame fills the requested height');
    assertWidth(lines);

    assert.match(lines[0], /^╭─ Warp ─+ esc ─╮$/, 'the frame carries the title and esc at the right');
    assert.match(lines.at(-1), /^╰─+╯$/, 'the frame is closed');
    assert.equal(rows[1], 'current: feat-odd-viewer  /w/feat-odd-viewer', 'the current checkout is named with its path');
    assert.equal(rows[2], 'New worktree');
    assert.equal(rows[3], '▸ create a worktree', 'the create row is focused first');
    assert.equal(rows[4], '', 'a blank separator follows the create section');
    assert.equal(rows[5], 'Choose worktree');
    assert.match(rows[6], /^ {2}main\s+main · use the local project$/, 'the principal says the local project');
    assert.match(rows[7], /^ {2}feat-alpha\s+feat\/alpha$/);
    assert.match(rows[8], /^ {2}fix-beta\s+fix\/beta$/);
    assert.equal(rows[9], '', 'unused list rows are blank');
    assert.match(rows[18], /↑↓ move/, 'the footer names moving');
    assert.match(rows[18], /enter choose/);
    assert.match(rows[18], /v all/, 'the footer names the extended list');
    assert.match(rows[18], /r reload/);
    assert.match(rows[18], /esc close/);

    const choose = rows.slice(6, 17).join('\n');
    assert.ok(!choose.includes('/w/feat-odd-viewer'), 'the current checkout is not listed again');
    assert.ok(!choose.includes('View all'), 'everything fits: no View all row');
  });

  test('bounds the list by the height and ends it with a View all row only when rows were left out', async () => {
    const many = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const { view } = makeView({ checkouts: many, current: { name: 'cur', path: '/w/cur' }, rows: 14 });
    await tick();
    const { lines, rows } = screen(view);
    assert.equal(lines.length, 14);
    assertWidth(lines);
    // 14 rows - 9 fixed rows = 5 list rows: 4 checkouts then the final View all.
    assert.match(rows[6], /^ {2}wt-1\s+feat\/wt-1$/);
    assert.match(rows[9], /^ {2}wt-4\s+feat\/wt-4$/);
    assert.match(rows[10], /^ {2}View all\s+4 more$/, 'View all is the last list row and counts the rest');
    const body = rows.join('\n');
    assert.ok(!body.includes('wt-5'), 'the rows beyond the bound are not rendered');
    assert.ok(!body.includes('wt-8'));
    assert.match(rows[11], /creates a worktree/);
  });

  test('keeps every line exactly the requested width at a narrow width', async () => {
    const { view } = makeView({ rows: 10 });
    await tick();
    const { lines } = screen(view, 24);
    assert.equal(lines.length, 10);
    assertWidth(lines, 24);
  });

  test('an empty checkout list names its state and still offers creation', async () => {
    const { view, results } = makeView({ checkouts: [], current: { name: 'cur', path: '/w/cur' } });
    await tick();
    const { lines, rows } = screen(view);
    assertWidth(lines);
    assert.equal(rows[6], '(no other worktrees)');
    assert.ok(!rows.join('\n').includes('View all'));
    view.handleInput('enter');
    assert.deepEqual(results, [{ create: true }]);
  });

  test('a terminal too small for the popup says so in one line', async () => {
    const { view } = makeView({ rows: 4 });
    const lines = view.render(80).map(strip);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Warp .* enlarge the terminal/);
    assertWidth(lines);
  });
});

describe('focused checkout facts (S2, S9)', () => {
  const BASE = { branch: 'main', issues: [7], odd: ['w9-x'], changes: 4, ahead: 1, behind: 2, createdAt: '2026-01-05T00:00:00.000Z', lastActivity: '2026-02-28T00:00:00.000Z' };
  const FULL = 'branch main · issues #7 · odd w9-x · uncommitted 4 files · ↑1 ↓2 · created 1mo ago · modified 1d ago';

  async function focusSecondCheckout(options) {
    const made = makeView(options);
    const width = options.width || WIDE;
    await tick();
    made.view.handleInput('down');
    // The read starts on the frame that focuses the row, so the first render
    // shows it in flight and the one after the microtask shows the answer.
    screen(made.view, width);
    await tick();
    const { rows } = screen(made.view, width);
    return { ...made, rows };
  }

  test('the focused checkout reports branch, issues, odd, uncommitted changes, ahead/behind and created-at', async () => {
    const { rows } = await focusSecondCheckout({ facts: () => BASE, width: 200 });
    assert.equal(rows[1], 'current: feat-odd-viewer  /w/feat-odd-viewer');
    assert.match(rows[6], /^▸ main\s+main · use the local project$/, 'the selection moved');
    assert.equal(rows[17], FULL, 'the facts line carries every fact of the focused checkout');
  });

  test('every fact that cannot be read renders unavailable, never zero', async () => {
    // 200 columns keep the whole unavailable line on one row, now that it
    // names both ages too: a fact is never dropped or shortened into a false
    // value.
    const { rows } = await focusSecondCheckout({ facts: () => null, width: 200 });
    assert.equal(rows[17], 'branch unavailable · issues unavailable · odd unavailable · uncommitted unavailable · ↑unavailable ↓unavailable · created unavailable · modified unavailable');
  });

  test('each single unavailable fact is reported on its own while the others survive', async () => {
    const cases = [
      ['branch', 'branch unavailable'],
      ['issues', 'issues unavailable'],
      ['odd', 'odd unavailable'],
      ['changes', 'uncommitted unavailable'],
      ['ahead', '↑unavailable'],
      ['behind', '↓unavailable'],
      ['createdAt', 'created unavailable'],
      ['lastActivity', 'modified unavailable'],
    ];
    for (const [field, expected] of cases) {
      const facts = { ...BASE, [field]: field === 'createdAt' ? 'unavailable' : null };
      const { rows } = await focusSecondCheckout({ facts: () => facts, width: 200 });
      assert.ok(rows[17].includes(expected), `${field} renders "${expected}": ${rows[17]}`);
      assert.ok(!/↑0|↓0|uncommitted 0 file/.test(rows[17]), `a missing number is never 0: ${rows[17]}`);
    }
  });

  test('an available zero stays a zero, so unavailable and zero are distinct', async () => {
    const { rows } = await focusSecondCheckout({ facts: () => ({ ...BASE, changes: 0, ahead: 0, behind: 0, issues: [], odd: [] }), width: 200 });
    assert.equal(rows[17], 'branch main · issues none · odd none · uncommitted 0 files · ↑0 ↓0 · created 1mo ago · modified 1d ago');
  });

  test('moving the selection refreshes the facts line and reads each checkout only once', async () => {
    const facts = (path) => ({ ...BASE, branch: path === '/w/feat-alpha' ? 'feat/alpha' : 'main' });
    const { view, factCalls, paints } = await focusSecondCheckout({ facts });
    assert.deepEqual(factCalls, ['/w/herdr'], 'only the focused checkout is read');
    assert.ok(paints.length > 0, 'the component repaints after a move');
    view.handleInput('down');
    screen(view, WIDE);
    await tick();
    const { rows } = screen(view, WIDE);
    assert.deepEqual(factCalls, ['/w/herdr', '/w/feat-alpha'], 'the new focus is read on demand');
    assert.ok(rows[17].startsWith('branch feat/alpha'), `the facts follow the focus: ${rows[17]}`);
    view.handleInput('up');
    screen(view, WIDE);
    view.handleInput('down');
    screen(view, WIDE);
    assert.equal(factCalls.length, 2, 'cached facts are never re-read');
  });

  test('a slow facts read never blocks a frame and cannot be shown as zero', async () => {
    const { view } = makeView({ facts: () => new Promise(() => {}) });
    view.handleInput('down');
    const { lines, rows } = screen(view, WIDE);
    assert.equal(lines.length, HEIGHT, 'the frame renders while the read is in flight');
    assertWidth(lines, WIDE);
    assert.match(rows[17], /reading/, 'the pending read says so');
    assert.ok(!/↑0|↓0/.test(rows[17]));
  });

  test('a failing facts read degrades to unavailable instead of throwing', async () => {
    const { view } = makeView({ facts: () => Promise.reject(new Error('git failed')) });
    view.handleInput('down');
    screen(view, WIDE);
    await tick();
    const { rows } = screen(view, WIDE);
    assert.ok(rows[17].includes('branch unavailable'), rows[17]);
    assert.ok(!rows[17].includes('0'), 'a failed read never claims a number');
  });
});

describe('ordering and both ages (S12)', () => {
  const ORDERED = [
    { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
    { name: 'stale', path: '/w/stale', branch: 'feat/stale', lastActivity: ago(10 * 86400_000) },
    { name: 'open', path: '/w/open', branch: 'feat/open', lastActivity: null, lastActivityReason: 'not a git repository' },
    { name: 'commit-fresh', path: '/w/commit-fresh', branch: 'feat/cf', lastActivity: ago(60_000) },
    { name: 'dirty-fresh', path: '/w/dirty-fresh', branch: 'feat/df', lastActivity: ago(3600_000) },
  ];

  test('orders the rows by last activity descending, keeps the unreadable one last and shows its reason', async () => {
    const { view } = makeView({ checkouts: ORDERED, current: { name: 'cur', path: '/w/cur' }, facts: () => null });
    await tick();
    const { rows } = screen(view, 200);
    assert.match(rows[6], /^ {2}commit-fresh/, 'the most recent commit is first');
    assert.match(rows[7], /^ {2}dirty-fresh/, 'a recent dirty file follows the commit');
    assert.match(rows[8], /^ {2}stale/);
    assert.match(rows[9], /^ {2}open/, 'the unreadable row sorts last');
    for (let i = 0; i < 4; i += 1) view.handleInput('down');
    screen(view, 200);
    await tick();
    const focused = screen(view, 200).rows;
    assert.match(focused[9], /^▸ open/);
    assert.ok(focused[17].includes('modified not a git repository'), `the reason replaces a fake date: ${focused[17]}`);
    assert.ok(!/modified 20\d\d/.test(focused[17]));
  });

  test('the extended list keeps the same order', async () => {
    const { view } = makeView({ checkouts: ORDERED, current: { name: 'cur', path: '/w/cur' }, facts: () => null });
    await tick();
    view.handleInput('v');
    const { rows } = screen(view, 200);
    assert.match(rows[2], /commit-fresh/);
    assert.match(rows[3], /dirty-fresh/);
    assert.match(rows[4], /stale/);
    assert.match(rows[5], /cur/);
    assert.match(rows[6], /open/);
  });

  test('renders both ages in the package style, from just now to years', () => {
    const line = (facts) => formatFactsLine(facts, { now: NOW });
    // The suffix matches lib/issues-view.js, so one clock never reads two ways
    // across the package's surfaces.
    assert.ok(line({ createdAt: ago(30_000), lastActivity: ago(30_000) }).endsWith('created just now · modified just now'));
    assert.ok(line({ createdAt: ago(60_000), lastActivity: ago(2 * 60_000) }).endsWith('created 1m ago · modified 2m ago'));
    assert.ok(line({ createdAt: ago(3600_000), lastActivity: ago(2 * 3600_000) }).endsWith('created 1h ago · modified 2h ago'));
    assert.ok(line({ createdAt: ago(86400_000), lastActivity: ago(2 * 86400_000) }).endsWith('created 1d ago · modified 2d ago'));
    assert.ok(line({ createdAt: ago(30 * 86400_000), lastActivity: ago(60 * 86400_000) }).endsWith('created 1mo ago · modified 2mo ago'));
    assert.ok(line({ createdAt: ago(365 * 86400_000), lastActivity: ago(2 * 365 * 86400_000) }).endsWith('created 1y ago · modified 2y ago'));
    assert.ok(line({ createdAt: null, lastActivity: null }).endsWith('created unavailable · modified unavailable'));
  });
});

describe('edit key (S13)', () => {
  test('e on the focused checkout completes with an edit request and is inert elsewhere', async () => {
    const { view, results } = makeView();
    await tick();
    const { rows } = screen(view, WIDE);
    assert.match(rows[18], /e edit/, 'the footer names the edit key');
    view.handleInput('e');
    assert.deepEqual(results, [], 'e on the create row is inert');
    view.handleInput('down');
    view.handleInput('e');
    assert.deepEqual(results, [{ edit: '/w/herdr' }]);

    const empty = makeView({ checkouts: [], current: { name: 'cur', path: '/w/cur' } });
    await tick();
    screen(empty.view, WIDE);
    empty.view.handleInput('e');
    assert.deepEqual(empty.results, [], 'e on an empty list is inert');

    const listed = makeView();
    await tick();
    listed.view.handleInput('v');
    listed.view.handleInput('T');
    listed.view.handleInput('e');
    assert.equal(listed.view.state.filter, 'e', 'e is typed text while the filter is open');
    assert.deepEqual(listed.results, []);
  });
});

describe('extended list (S1, S6)', () => {
  test('v opens a paginated list of every checkout with an always-active filter row', async () => {
    const { view } = makeView();
    await tick();
    view.handleInput('v');
    assert.equal(view.state.view, 'list');
    const { lines, rows } = screen(view);
    assert.equal(lines.length, HEIGHT);
    assertWidth(lines);
    assert.match(lines[0], /^╭─ Warp · all worktrees ─+ esc ─╮$/);
    assert.equal(rows[1], 'filter: type to search', 'the filter row is always present and never selectable');
    assert.match(rows[2], /^▸ feat-odd-viewer\s+feat\/odd-viewer · current$/);
    assert.match(rows[3], /^ {2}main\s+main · use the local project$/);
    assert.match(rows[4], /^ {2}feat-alpha\s+feat\/alpha$/);
    assert.match(rows[5], /^ {2}fix-beta\s+fix\/beta$/);
    assert.equal(rows[17], 'page 1/1 · 4 worktrees');
    assert.match(rows[18], /enter warp/);
    assert.match(rows[18], /esc back/);
    assert.ok(!rows.slice(2, 17).join('\n').includes('current: '), 'the filter row is not a data row');
  });

  test('typing filters the list live and the filter row is not a selectable item', async () => {
    const { view } = makeView();
    await tick();
    view.handleInput('v');
    view.handleInput('a');
    assert.equal(view.state.filterOpen, true);
    assert.equal(view.state.filter, 'a');
    let { rows } = screen(view);
    assert.equal(rows[1], 'filter: a▏', 'the typed text lands in the filter row');
    for (const ch of 'lpha') view.handleInput(ch);
    ({ rows } = screen(view));
    assert.equal(rows[1], 'filter: alpha▏');
    assert.match(rows[2], /^▸ feat-alpha\s+feat\/alpha$/);
    assert.equal(rows[3], '');
    const body = rows.join('\n');
    assert.ok(!body.includes('fix-beta'), 'non-matching rows are filtered out');
    assert.equal(rows[17], 'page 1/1 · 1 worktree');
    assert.equal(view.state.listCursor, 0, 'the cursor tracks the filtered rows');
  });

  test('the filter excludes rows that match nothing and enter cannot warp from it', async () => {
    const { view, results } = makeView();
    await tick();
    view.handleInput('v');
    for (const ch of 'zzz') view.handleInput(ch);
    const { lines, rows } = screen(view);
    assertWidth(lines);
    assert.equal(rows[1], 'filter: zzz▏');
    assert.equal(rows[2], '(no matches for "zzz")');
    assert.equal(rows[17], 'page 1/1 · 0 worktrees');
    view.handleInput('enter');
    assert.deepEqual(results, [], 'enter on an empty result warps nowhere');
  });

  test('pgUp/pgDn page through every checkout', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` }));
    const { view } = makeView({ checkouts: many, current: { name: 'wt-1', path: '/w/wt-1' }, rows: 11 });
    await tick();
    view.handleInput('v');
    let { rows } = screen(view);
    // 11 rows - 5 fixed rows = a 6-row page.
    assert.match(rows[2], /wt-1/);
    assert.match(rows[7], /wt-6/);
    assert.equal(rows[8], 'page 1/2 · 12 worktrees', 'the page row sits right below the six rows');
    view.handleInput('pagedown');
    ({ rows } = screen(view));
    assert.equal(view.state.page, 1);
    assert.match(rows[2], /wt-7/);
    assert.match(rows[7], /wt-12/);
    assert.equal(rows[8], 'page 2/2 · 12 worktrees');
    view.handleInput('pagedown');
    assert.equal(view.state.page, 1, 'the last page is a wall');
    view.handleInput('pageup');
    ({ rows } = screen(view));
    assert.equal(view.state.page, 0);
    assert.match(rows[2], /wt-1/);
  });

  test('esc closes the filter first and then steps back to the popup', async () => {
    const { view, results } = makeView();
    await tick();
    view.handleInput('v');
    view.handleInput('a');
    assert.equal(view.state.filterOpen, true);
    view.handleInput('escape');
    assert.equal(view.state.filterOpen, false, 'esc closes the filter, keeping the query');
    assert.equal(view.state.view, 'list', 'and stays in the list');
    assert.equal(view.state.filter, 'a');
    view.handleInput('escape');
    assert.equal(view.state.view, 'popup', 'esc steps back exactly one level');
    assert.deepEqual(results, [], 'stepping back never resolves the component');
    view.handleInput('escape');
    assert.deepEqual(results, [null], 'esc from the popup closes the component');
  });

  test('ctrl+c steps back from the list too', async () => {
    const { view, results } = makeView();
    await tick();
    view.handleInput('v');
    view.handleInput('ctrl+c');
    assert.equal(view.state.view, 'popup');
    assert.deepEqual(results, []);
  });

  test('enter on a checkout warps to its path', async () => {
    const { view, results } = makeView();
    await tick();
    view.handleInput('v');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(results, [{ warp: '/w/herdr' }]);
  });
});

describe('the S6 space rule', () => {
  test('space toggles while the filter is closed, types once it is open, and toggles again after it closes', async () => {
    const { view, toggles } = makeView({ onToggle: () => {} });
    await tick();
    view.handleInput('v');
    view.handleInput('down');
    assert.equal(view.state.listCursor, 1);

    view.handleInput(' ');
    assert.deepEqual(toggles, ['/w/herdr'], 'space toggles the focused row while the filter is closed');
    assert.equal(view.state.filterOpen, false, 'and never opens the filter');
    assert.equal(view.state.filter, '');

    view.handleInput('z');
    assert.equal(view.state.filterOpen, true, 'a printable that is not a binding opens the filter');
    assert.equal(view.state.filter, 'z');
    view.handleInput(' ');
    assert.equal(view.state.filter, 'z ', 'once open, space goes to the text');
    assert.deepEqual(toggles, ['/w/herdr'], 'and no longer toggles');

    view.handleInput('escape');
    assert.equal(view.state.filterOpen, false);
    assert.equal(view.state.view, 'list');
    view.handleInput('T');
    assert.equal(view.state.filterOpen, true, 'T opens the filter explicitly');
    assert.equal(view.state.filter, '', 'and starts an empty query');
    view.handleInput('escape');
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(toggles, ['/w/herdr', '/w/herdr'], 'closing an empty filter restores the toggle');
  });

  test('without a toggle, space is a printable and opens the filter', async () => {
    const { view } = makeView();
    await tick();
    view.handleInput('v');
    view.handleInput(' ');
    assert.equal(view.state.filterOpen, true);
    assert.equal(view.state.filter, ' ');
  });
});

describe('help overlay (S5)', () => {
  test('? opens and closes a key-help overlay in both views', async () => {
    const { view } = makeView();
    await tick();
    view.handleInput('?');
    let { rows } = screen(view);
    assert.equal(rows[6], 'keys — one key per action');
    const help = rows.slice(6, 14).join('\n');
    assert.match(help, /j k\s+move the selection/);
    assert.match(help, /v\s+every worktree/);
    assert.match(help, /esc\s+back one level/);
    assert.ok(!rows.join('\n').includes('feat-alpha'), 'the overlay replaces the list rows');
    view.handleInput('?');
    ({ rows } = screen(view));
    assert.match(rows[7], /feat-alpha/);

    view.handleInput('v');
    view.handleInput('?');
    ({ rows } = screen(view));
    assert.equal(rows[2], 'keys — one key per action', 'the overlay covers the list rows too');
    view.handleInput('?');
    ({ rows } = screen(view));
    assert.match(rows[2], /feat-odd-viewer/);
  });
});

describe('keys that are not in the map', () => {
  test('no key outside the documented map changes the popup state', async () => {
    const { view, results } = makeView();
    await tick();
    screen(view, WIDE);
    const before = JSON.parse(JSON.stringify(view.state));
    for (const key of ['x', 'q', 'tab', 'home', 'end', 'left', 'right', 'ctrl+s', 'backspace']) {
      view.handleInput(key);
    }
    assert.deepEqual(view.state, before);
    assert.deepEqual(results, [], 'and none of them resolves the component');
  });

  test('no key outside the documented map changes the list state', async () => {
    const { view, results } = makeView();
    await tick();
    view.handleInput('v');
    screen(view);
    const before = { listCursor: view.state.listCursor, filter: view.state.filter, filterOpen: view.state.filterOpen, view: view.state.view, help: view.state.help };
    for (const key of ['tab', 'home', 'end', 'left', 'right', 'ctrl+s']) view.handleInput(key);
    assert.deepEqual({ listCursor: view.state.listCursor, filter: view.state.filter, filterOpen: view.state.filterOpen, view: view.state.view, help: view.state.help }, before);
    assert.deepEqual(results, []);
  });
});

describe('selection and reload', () => {
  test('j/k move the selection and clamp at both ends', async () => {
    const { view } = makeView();
    await tick();
    view.handleInput('j');
    assert.equal(view.state.cursor, 1);
    view.handleInput('k');
    assert.equal(view.state.cursor, 0);
    view.handleInput('k');
    assert.equal(view.state.cursor, 0, 'the first row is a clamp');
    for (let i = 0; i < 10; i += 1) view.handleInput('down');
    assert.equal(view.state.cursor, 3, 'create + three checkouts');
  });

  test('enter on the create row resolves create and esc resolves null exactly once', async () => {
    const create = makeView();
    await tick();
    create.view.handleInput('enter');
    assert.deepEqual(create.results, [{ create: true }]);

    const closed = makeView();
    await tick();
    closed.view.handleInput('escape');
    closed.view.handleInput('escape');
    assert.deepEqual(closed.results, [null], 'the component resolves once');
  });

  test('enter on the View all row opens the extended list instead of resolving', async () => {
    const many = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      ...Array.from({ length: 8 }, (_, index) => ({ name: `wt-${index + 1}`, path: `/w/wt-${index + 1}`, branch: `feat/wt-${index + 1}` })),
    ];
    const { view, results } = makeView({ checkouts: many, current: { name: 'cur', path: '/w/cur' }, rows: 14 });
    await tick();
    for (let i = 0; i < 5; i += 1) view.handleInput('down');
    const { rows } = screen(view);
    assert.match(rows[10], /^▸ View all/);
    view.handleInput('enter');
    assert.equal(view.state.view, 'list');
    assert.deepEqual(results, []);
  });

  test('r reloads through the injected callback and re-reads the focused facts', async () => {
    const reloaded = [
      { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
      { name: 'new-shape', path: '/w/new-shape', branch: 'feat/new-shape' },
    ];
    const { view, reloadCalls, factCalls } = makeView({
      checkouts: [
        { name: 'cur', path: '/w/cur', branch: 'feat/cur' },
        { name: 'old-shape', path: '/w/old-shape', branch: 'feat/old-shape' },
      ],
      current: { name: 'cur', path: '/w/cur' },
      reloadTo: reloaded,
    });
    await tick();
    view.handleInput('down');
    screen(view);
    await tick();
    assert.deepEqual(factCalls, ['/w/old-shape'], 'the focused checkout is read once');
    view.handleInput('r');
    assert.equal(reloadCalls.length, 1, 'the reload reader is the only source');
    await tick();
    const { rows } = screen(view);
    assert.match(rows[6], /new-shape/);
    assert.deepEqual(factCalls, ['/w/old-shape', '/w/new-shape'], 'the cached facts are dropped on reload');
  });
});
