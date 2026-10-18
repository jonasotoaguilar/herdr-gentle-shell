'use strict';
// T36 (customize-command S46) tests: the optional issues + odd
// multi-select steps of the create-from-warp flow.
//
// Lib unit tests (lib/warp-create-picker.js, pure Node, no subprocess,
// no prompt): the pinned `gh` fetch shape (`gh issue list --state open
// --json number,title` with the CLI's own paging flags), the skip paths,
// the number-or-title search filter, the odd listing from the CURRENT
// checkout, pagination, and the reusable multi-select component driven
// with synthetic keys.
//
// Flow tests (same file, extension harness at the bottom): type -> name
// -> issues -> odd -> creation registers the selected values; Esc in
// either new step cancels the whole creation with no state change;
// confirm-with-none proceeds with empty values; both steps skip cleanly
// when empty or unavailable; several odd documents survive; the odd list
// comes from the current checkout; the creation still reuses the existing
// create path (duplicate refusal byte-identical).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const picker = require('../lib/warp-create-picker.js');

// Optional real dependency: the host's pi-tui package. CI installs NO
// dependencies, so resolve it once here and SKIP the tests that genuinely
// need the real module instead of failing (the
// worktree-warp-real-session pattern). Every test that only needs the
// raw-byte fallback keeps running everywhere, with or without the package.
let TUI_AVAILABLE = false;
try {
  require.resolve('@earendil-works/pi-tui');
  TUI_AVAILABLE = true;
} catch {
  TUI_AVAILABLE = false;
}
if (!TUI_AVAILABLE) {
  console.error(
    'warp-create-picker: SKIPPING real-matcher tests (no @earendil-works/pi-tui found; '
    + 'install the package, e.g. npm install @earendil-works/pi-tui, to run them)',
  );
}

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function track(p) {
  roots.push(p);
  return p;
}

function scratchDir(tag) {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-pick-${tag}-`)));
}

describe('gh fetch shape and pagination flags', { concurrency: false }, () => {
  test('the fetch runs gh issue list over open issues as JSON number/title with a limit', async () => {
    const seen = [];
    const spawnImpl = (bin, argv, opts) => {
      seen.push({ bin, argv, cwd: opts && opts.cwd });
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 12, title: 'Fix the crash' }, { number: 7, title: 'Docs' }]),
        stderr: '',
        error: null,
      };
    };
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
    assert.deepEqual(seen.length, 1, 'exactly one gh call');
    assert.equal(seen[0].bin, 'gh', 'the gh CLI');
    assert.deepEqual(
      seen[0].argv,
      ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '200'],
      'the verified fetch shape with the CLI paging flag',
    );
    assert.equal(seen[0].cwd, '/repo', 'the fetch runs in the current checkout');
    assert.deepEqual(out.issues, [
      { number: 12, title: 'Fix the crash' },
      { number: 7, title: 'Docs' },
    ]);
  });

  test('a search string rides the CLI search flag', async () => {
    const seen = [];
    const spawnImpl = (bin, argv) => {
      seen.push(argv);
      return { status: 0, stdout: '[]', stderr: '', error: null };
    };
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', search: 'crash', spawnImpl });
    assert.equal(out.ok, true);
    assert.deepEqual(out.issues, [], 'no open issues is ok with an empty list');
    assert.deepEqual(
      seen[0],
      ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '200', '--search', 'crash'],
      'the search rides --search behind the same shape',
    );
  });

  test('a missing gh binary skips instead of throwing', async () => {
    const spawnImpl = () => {
      const err = new Error("spawnSync gh ENOENT");
      err.code = 'ENOENT';
      return { status: null, stdout: '', stderr: '', error: err };
    };
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: '/no/such/gh', spawnImpl });
    assert.equal(out.ok, false, 'not ok');
    assert.ok(typeof out.skipped === 'string' && out.skipped.length > 0, 'a skip reason travels along');
  });

  test('an erroring gh skips instead of throwing', async () => {
    const spawnImpl = () => ({ status: 1, stdout: '', stderr: 'Not logged in. Run gh auth login.', error: null });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, false, 'an unauthenticated gh is a skip, never a block');
    assert.ok(typeof out.skipped === 'string' && out.skipped.length > 0);
  });

  test('unparseable gh output skips instead of throwing', async () => {
    const spawnImpl = () => ({ status: 0, stdout: 'not json', stderr: '', error: null });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, false);
    assert.ok(typeof out.skipped === 'string' && out.skipped.length > 0);
  });

  test('a non-array gh payload skips instead of throwing', async () => {
    const spawnImpl = () => ({ status: 0, stdout: '{"number":1}', stderr: '', error: null });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, false);
  });

  test('malformed rows are dropped while good rows survive', async () => {
    const spawnImpl = () => ({
      status: 0,
      stdout: JSON.stringify([
        { number: 3, title: 'Good' },
        { number: 'x', title: 'Bad number' },
        { number: 4 },
        null,
        { number: 5, title: 'Also good' },
      ]),
      stderr: '',
      error: null,
    });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, true);
    assert.deepEqual(out.issues, [
      { number: 3, title: 'Good' },
      { number: 5, title: 'Also good' },
    ]);
  });
});

describe('issues search: number or title from the same box', { concurrency: false }, () => {
  const issues = [
    { number: 12, title: 'Fix the crash on empty' },
    { number: 123, title: 'Docs for warp' },
    { number: 7, title: 'Crash report 12' },
    { number: 45, title: 'Unrelated chore' },
  ];

  test('a numeric query matches by number', () => {
    const found = picker.filterIssueItems(issues, '12').map((i) => i.number).sort((a, b) => a - b);
    assert.deepEqual(found, [7, 12, 123], '12, 123 by number and 7 by its title containing 12');
  });

  test('a text query matches as a case-insensitive substring of the title', () => {
    const found = picker.filterIssueItems(issues, 'CRASH').map((i) => i.number).sort((a, b) => a - b);
    assert.deepEqual(found, [7, 12]);
  });

  test('a query that is neither number nor title filters the row out', () => {
    assert.deepEqual(picker.filterIssueItems(issues, 'zzz'), [], 'nothing matches');
    assert.deepEqual(
      picker.filterIssueItems(issues, '99').map((i) => i.number),
      [],
      'no number contains 99 and no title mentions it',
    );
  });

  test('an empty query returns every row', () => {
    assert.deepEqual(picker.filterIssueItems(issues, '   ').map((i) => i.number), [12, 123, 7, 45]);
  });
});

describe('odd listing comes from the given checkout only', { concurrency: false }, () => {
  function checkoutWithDocs(tag, names) {
    const root = scratchDir(tag);
    fs.mkdirSync(path.join(root, 'odd', 'tasks'), { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(root, 'odd', 'tasks', name), `# ${name}\n`);
    return root;
  }

  test('it lists the top-level odd/tasks/*.md names sorted, with absolute paths', () => {
    const root = checkoutWithDocs('odd-list', ['b-change.md', 'a-change.md', 'notes.txt', 'README']);
    fs.mkdirSync(path.join(root, 'odd', 'tasks', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'odd', 'tasks', 'sub', 'nested.md'), '# nested\n');
    const docs = picker.listOddTaskDocs(root);
    assert.deepEqual(
      docs.map((d) => d.name),
      ['a-change.md', 'b-change.md'],
      'sorted .md files only, no txt, no nested dir, no bare README',
    );
    for (const doc of docs) {
      assert.equal(doc.abs, path.join(root, 'odd', 'tasks', doc.name), 'the absolute path travels along');
      assert.ok(fs.statSync(doc.abs).isFile(), 'it names a real file');
    }
  });

  test('it lists THAT checkout documents, never another checkout', () => {
    const current = checkoutWithDocs('odd-current', ['current-change.md']);
    const other = checkoutWithDocs('odd-other', ['other-change.md']);
    assert.ok(other.length > 0, 'the other checkout really has its own doc');
    const docs = picker.listOddTaskDocs(current);
    assert.deepEqual(docs.map((d) => d.name), ['current-change.md']);
  });

  test('a missing odd/tasks directory means no documents, never a throw', () => {
    const root = scratchDir('odd-missing');
    assert.deepEqual(picker.listOddTaskDocs(root), [], 'no odd/ at all');
    assert.deepEqual(picker.listOddTaskDocs(path.join(root, 'no-such-checkout')), [], 'no checkout at all');
    fs.mkdirSync(path.join(root, 'odd'), { recursive: true });
    assert.deepEqual(picker.listOddTaskDocs(root), [], 'odd/ without tasks/');
  });
});

describe('pagination', { concurrency: false }, () => {
  test('pages clamp and slice', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    assert.deepEqual(picker.paginate(items, 0, 5), { items: [0, 1, 2, 3, 4], page: 0, pageCount: 3, total: 12 });
    assert.deepEqual(picker.paginate(items, 2, 5).items, [10, 11], 'the last page holds the rest');
    assert.equal(picker.paginate(items, 9, 5).page, 2, 'a far page clamps to the last one');
    assert.equal(picker.paginate(items, -3, 5).page, 0, 'a negative page clamps to the first one');
    assert.deepEqual(picker.paginate([], 0, 5), { items: [], page: 0, pageCount: 1, total: 0 });
  });
});

describe('the reusable multi-select component', { concurrency: false }, () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const identityFilter = (rows, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(query));
  };

  function open(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select rows (optional)',
      items,
      filterFn: identityFilter,
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  function textOf(view, width = 90) {
    return view.render(width).join('\n');
  }

  test('it renders rules, prompt, search box, DATA rows only and a key footer', () => {
    const { view, finished } = open();
    const lines = view.render(90);
    const text = lines.join('\n');
    assert.ok(/^─+$/.test(lines[0]), 'a thin accent rule opens the component');
    assert.ok(/^─+$/.test(lines[lines.length - 1]), 'a thin accent rule closes it');
    assert.ok(text.includes('Select rows (optional)'), 'the prompt travels');
    assert.ok(text.includes('Search:'), 'the search box sits under the prompt');
    assert.ok(text.includes('row 1'), 'the first page shows');
    assert.ok(!text.includes('row 6'), 'the second page stays off-screen');
    assert.match(text, /page 1\/3/i, 'the footer names the page');
    assert.match(text, /enter.*confirm/i, 'the footer names Enter as the confirm key');
    assert.match(text, /space.*toggle/i, 'the footer names Space as the toggle key');
    assert.match(text, /←\/→ pages/i, 'the footer names LEFT/RIGHT as the page keys');
    assert.match(text, /tab.*back/i, 'the footer reserves Tab for Back');
    assert.match(text, /t search/i, 'the footer names T as the search key');
    assert.ok(!text.includes('← Back'), 'no selectable Back row renders anywhere');
    assert.ok(!text.includes('Back'), 'no Back row label renders anywhere');
    assert.ok(!text.includes('Confirm'), 'there is no Confirm row: Enter confirms');
    // Raw Tab is the only Back affordance: it returns without completing.
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back with no selectable row');
  });

  test('panels are standalone: no cross-field chips, tabs or step counters leak into the render', () => {
    const { view } = open({
      title: 'Select issues (optional)',
    });
    const text = textOf(view);
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('▸'), 'no chip strip renders');
    assert.ok(!text.includes('✓'), 'no answered-step mark renders');
    const { view: second } = open({ title: 'Select odd documents (optional)' });
    const again = textOf(second);
    assert.ok(!/\[\d+\/\d+\]/.test(again), 'the second panel carries no counter either');
    assert.ok(!again.includes('Issues') || !again.includes('Odd'), 'no joint Type/Name/Issues/Odd header groups the panels');
    assert.ok(again.includes('Select odd documents (optional)'), 'each panel keeps only its own title');
    // Pagination of THIS list is fine: it is not a wizard step indicator.
    assert.match(text, /page 1\/3/i, 'the page counter of the current list stays');
  });

  test('focused rows carry the distinct chevron and checked boxes align', () => {
    const { view } = open({ pageSize: 12 });
    view.handleInput('space');
    const lines = view.render(90);
    const row = lines.find((line) => line.includes('row 1'));
    assert.ok(row.includes('[x]'), 'the toggled box reads checked');
    assert.ok(row.includes('❯'), 'the focused row carries the chevron');
    const other = lines.find((line) => line.includes('row 2'));
    assert.ok(other.includes('[ ]'), 'the untoggled box reads empty');
  });

  test('moving pages shows the later rows', () => {
    const { view } = open();
    view.handleInput('pagedown');
    const text = textOf(view);
    assert.ok(text.includes('row 6'), 'the second page shows after pagedown');
    assert.ok(!text.includes('row 1\n') && !text.includes('row 1 '), 'the first page is gone');
    assert.match(text, /page 2\/3/i);
  });

  test('space toggles, enter confirms, tab goes back preserving values', () => {
    const { view, finished } = open();
    view.handleInput('down');
    assert.equal(view.state.focus, 'list', 'arrowing focuses the list');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [2], 'Space toggles the focused checkbox');
    assert.ok(textOf(view).includes('1 selected'), 'the footer counts the selection');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [], 'Space toggles it back off');
    assert.deepEqual(finished, [], 'toggling never completes');
    view.handleInput('space');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [2], uiState: { query: '', page: 0, cursor: 1 } }], 'Tab alone returns with selections and list position echoed');
    assert.deepEqual(view.state.selected, [2], 'the selections are kept for the return trip');
  });

  test('multi-word title queries keep working from the T search field', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('x');
    assert.equal(view.state.query, '', 'stray typing in list mode never filters');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T opens the dedicated search field');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.equal(view.state.query, 'row 1', 'the space typed into the query');
    const text = textOf(view);
    assert.ok(text.includes('row 1'), 'the filter narrows to row 1');
    assert.ok(!text.includes('row 2'), 'row 2 is filtered out');
    assert.deepEqual(view.state.selected, [], 'filtering never selects');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search for the list');
    assert.deepEqual(finished, [], 'leaving search never confirms');
    assert.equal(view.state.query, 'row 1', 'the filter is retained');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'Enter in list confirms, echoing the kept filter');
  });

  test('confirming with nothing selected is valid and carries an empty list', () => {
    const { view, finished } = open();
    // No Confirm row exists: Enter on the list confirms immediately.
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 0 } }]);
  });

  test('typing filters the rows and keeps working after a multi-selection', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [2, 3], 'two rows selected');
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.equal(view.state.query, 'row 1');
    const text = textOf(view);
    assert.ok(text.includes('row 1'), 'the filter narrows to row 1');
    assert.ok(!text.includes('row 2'), 'row 2 is filtered out');
    assert.deepEqual(view.state.selected, [2, 3], 'the selection survives filtering');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search first');
    assert.deepEqual(finished, [], 'leaving search never confirms');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [2, 3], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'Enter in list confirms the multi-selection, echoing the kept filter');
  });

  test('backspace edits the query', () => {
    const { view } = open({ pageSize: 12 });
    view.handleInput('t');
    view.handleInput('x');
    assert.equal(view.state.query, 'x');
    view.handleInput('backspace');
    assert.equal(view.state.query, '');
    assert.equal(view.state.mode, 'search', 'editing stays in the field');
  });

  test('escape cancels the whole step', () => {
    const { view, finished } = open();
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('escape');
    assert.deepEqual(finished, [null], 'Esc finishes with null: cancel, not confirm');
  });

  test('a key release changes nothing', () => {
    const { view } = open({
      helpers: { isKeyRelease: () => true },
    });
    view.handleInput('down');
    view.handleInput('x');
    view.handleInput('enter');
    assert.equal(view.state.query, '', 'no typing leaked through the release guard');
  });

  test('it never crashes on hostile dimensions', () => {
    const { view } = open();
    assert.deepEqual(view.render(0), []);
    assert.deepEqual(view.render(-4), []);
  });
});

describe('freeze/cancel/key regression (S52: real matcher + raw fallback)', { concurrency: false }, () => {
  const items = [
    { id: 11, label: '#11 First' },
    { id: 12, label: '#12 Second' },
  ];
  const identityFilter = (rows, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(query));
  };

  function open(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items,
      filterFn: identityFilter,
      pageSize: 8,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  test("the installed matcher accepts the ids the picker passes ('escape', 'enter', 'tab')", { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    assert.equal(typeof tui.matchesKey, 'function', 'the host exposes matchesKey');
    // The explorer claim that 'escape' is invalid never executed: the
    // installed keys.js matches BOTH spellings, plus raw sequences.
    assert.equal(tui.matchesKey('\x1b', 'escape'), true, 'raw Esc matches escape');
    assert.equal(tui.matchesKey('\x1b', 'esc'), true, 'raw Esc matches esc');
    assert.equal(tui.matchesKey('\r', 'enter'), true, 'raw CR matches enter');
    assert.equal(tui.matchesKey('\r', 'return'), true, 'raw CR matches return');
    assert.equal(tui.matchesKey('\t', 'tab'), true, 'raw Tab matches tab');
  });

  test('with the real helpers, raw terminal keys drive the picker', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = open({ helpers });
    first.view.handleInput('\x1b');
    assert.deepEqual(first.finished, [null], 'raw Esc cancels');
    const second = open({ helpers });
    second.view.handleInput('\x1b[B');
    second.view.handleInput(' ');
    assert.deepEqual(second.view.state.selected, [12], 'raw arrow moved, raw Space toggled');
    second.view.handleInput('\r');
    assert.deepEqual(second.finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'raw CR confirms');
    const third = open({ helpers });
    third.view.handleInput('\t');
    assert.deepEqual(third.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back with selections and position echoed');
    const fourth = open({ helpers });
    fourth.view.handleInput('\x1b[C');
    assert.equal(fourth.view.state.page, 0, 'one page: RIGHT clamps');
  });

  test('without helpers, raw control sequences still work (never a dead picker)', () => {
    const esc = open();
    esc.view.handleInput('\x1b');
    assert.deepEqual(esc.finished, [null], 'raw Esc cancels with no helpers');
    const enter = open();
    enter.view.handleInput('\r');
    assert.deepEqual(enter.finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw CR confirms empty with no helpers');
    const space = open();
    space.view.handleInput(' ');
    assert.deepEqual(space.view.state.selected, [11], 'raw Space toggles the focused row');
    const tab = open();
    tab.view.handleInput('\t');
    assert.deepEqual(tab.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back, never toggles');
    const arrows = open();
    arrows.view.handleInput('\x1b[B');
    arrows.view.handleInput(' ');
    assert.deepEqual(arrows.view.state.selected, [12], 'raw arrow moves before toggling');
    const bs = open({ pageSize: 12 });
    bs.view.handleInput('t');
    bs.view.handleInput('x');
    bs.view.handleInput('\x7f');
    assert.equal(bs.view.state.query, '', 'raw DEL edits the query');
  });

  test('completion fires exactly once under an input storm', () => {
    const { view, finished } = open();
    view.handleInput('escape');
    view.handleInput('escape');
    view.handleInput('enter');
    view.handleInput('\x1b');
    view.handleInput('\r');
    view.handleInput('tab');
    view.handleInput(' ');
    assert.deepEqual(finished, [null], 'one cancel, never a second resolution');
    const confirm = open();
    confirm.view.handleInput('enter');
    confirm.view.handleInput('enter');
    confirm.view.handleInput('escape');
    confirm.view.handleInput('tab');
    assert.equal(confirm.finished.length, 1, 'one confirm, never a second resolution');
    assert.deepEqual(confirm.finished[0], { selected: [], uiState: { query: '', page: 0, cursor: 0 } });
    const back = open();
    back.view.handleInput('tab');
    back.view.handleInput('tab');
    back.view.handleInput('enter');
    assert.deepEqual(back.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'one back, never a second resolution');
  });

  test('Enter confirms the step (empty valid); Space toggles; no Confirm row, no Back row', () => {
    const { view, finished } = open();
    const text = view.render(90).join('\n');
    assert.ok(!text.includes('Confirm'), 'no Confirm row renders: Enter confirms');
    assert.ok(!text.includes('Back'), 'no selectable Back row renders: Tab goes back');
    // No phantom focus row after the last data item: the cursor roams
    // data rows only, so Enter on the last row still confirms.
    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter on the last data row confirms, never goes back');
  });

  test('Space toggles the focused checkbox without completing', () => {
    const { view, finished } = open();
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [11], 'Space toggles on');
    assert.deepEqual(finished, [], 'toggling never completes');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [], 'Space toggles off');
    view.handleInput('down');
    view.handleInput(' ');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter confirms the toggled selection');
  });

  test('Tab alone returns to the previous step; Enter always confirms, Space always toggles', () => {
    const { view, finished } = open();
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [12], 'the second item is selected');
    // No selectable Back row exists, so moving past the last data item
    // clamps there and Enter still confirms the selection.
    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter past the last row confirms, never a Back row');
    const viaSpace = open();
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput(' ');
    assert.deepEqual(viaSpace.view.state.selected, [12], 'Space past the last row toggles data, never a Back row');
    assert.deepEqual(viaSpace.finished, [], 'toggling never completes');
    const viaTab = open();
    viaTab.view.handleInput('down');
    viaTab.view.handleInput(' ');
    viaTab.view.handleInput('\t');
    assert.deepEqual(viaTab.finished, [{ back: true, selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'raw Tab alone goes back with values and position kept');
    assert.deepEqual(viaTab.view.state.selected, [12], 'the selections survive for the return trip');
  });

  test('initialSelected restores the previous pass selections', () => {
    const { view, finished } = open({ initialSelected: [12] });
    assert.deepEqual(view.state.selected, [12], 'the earlier selection survives the round trip');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 0 } }], 'Enter confirms the restored selection');
  });

  test('an empty filter renders no selectable rows; raw Tab still goes back', () => {
    const { view, finished } = open();
    view.handleInput('t');
    for (const ch of 'zzz-no-match') view.handleInput(ch);
    const text = view.render(90).join('\n');
    assert.ok(text.includes('(no matches)'), 'items filter out');
    assert.ok(!text.includes('Confirm'), 'no Confirm row appears on an empty filter either');
    assert.ok(!text.includes('Back'), 'no selectable Back row appears on an empty filter either');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search for the list');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [], uiState: { query: 'zzz-no-match', page: 0, cursor: 0 } }], 'raw Tab goes Back even with an empty filter');
  });

  test('T reopens the kept query; clearing it restores every row', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('t');
    for (const ch of 'zzz') view.handleInput(ch);
    assert.ok(view.render(120).join('\n').includes('(no matches)'), 'the live filter hides every row');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T reopens the field');
    assert.equal(view.state.query, 'zzz', 'the kept query is there for editing');
    for (let i = 0; i < 3; i += 1) view.handleInput('backspace');
    assert.equal(view.state.query, '', 'clearing empties the query');
    view.handleInput('enter');
    const text = view.render(120).join('\n');
    assert.ok(text.includes('#11 First') && text.includes('#12 Second'), 'clearing restores every row');
    assert.deepEqual(finished, [], 'nothing completed along the way');
  });

  test('Esc in search exits to the list without cancelling', () => {
    const { view, finished } = open();
    view.handleInput('t');
    view.handleInput('1');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list', 'Esc leaves search for the list');
    assert.equal(view.state.query, '1', 'the filter is retained');
    assert.deepEqual(finished, [], 'Esc in search never cancels the step');
    view.handleInput('escape');
    assert.deepEqual(finished, [null], 'Esc in list still cancels');
  });

  test('T and Space in search are text; arrows never page there', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null, done: () => {},
    });
    const textOf = () => view.render(120).join('\n');
    view.handleInput('t');
    view.handleInput('t');
    view.handleInput(' ');
    view.handleInput('t');
    assert.equal(view.state.query, 't t', 'T and Space type inside the field');
    view.handleInput('left');
    view.handleInput('right');
    assert.match(textOf(), /page 1\/3/i, 'LEFT/RIGHT in search never page');
    assert.equal(view.state.mode, 'search', 'the field stays open');
    const footer = textOf();
    assert.match(footer, /back to list/i, 'the search footer says how to leave');
    assert.match(footer, /filter kept/i, 'the search footer promises the retained filter');
  });

  test('selections persist across filters and pages', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null,
      filterFn: (list, q) => {
        const query = String(q || '').trim().toLowerCase();
        if (!query) return list;
        return list.filter((r) => r.label.toLowerCase().includes(query));
      },
      done: (out) => { finished.push(out); },
    });
    view.handleInput(' ');
    view.handleInput('right');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [1, 6], 'one per page');
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.deepEqual(view.state.selected, [1, 6], 'filtering keeps selections');
    view.handleInput('enter');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [1, 6], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'confirm carries selections across filters and pages');
  });

  test('LEFT/RIGHT turn item pages; selections and search survive', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null,
      done: (out) => { finished.push(out); },
    });
    const textOf = () => view.render(90).join('\n');
    assert.match(textOf(), /page 1\/3/i);
    view.handleInput('right');
    assert.match(textOf(), /page 2\/3/i, 'RIGHT turns to the next page');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [6], 'Space toggles on the new page');
    view.handleInput('left');
    assert.match(textOf(), /page 1\/3/i, 'LEFT turns back');
    view.handleInput('right');
    assert.deepEqual(view.state.selected, [6], 'the selection survives page changes');
    view.handleInput('right');
    view.handleInput('right');
    assert.match(textOf(), /page 3\/3/i, 'the last page clamps');
    view.handleInput('left');
    view.handleInput('left');
    view.handleInput('left');
    assert.match(textOf(), /page 1\/3/i, 'the first page clamps');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [6], uiState: { query: '', page: 0, cursor: 0 } }], 'Enter confirms across pages');
  });

  test('raw LEFT/RIGHT sequences page; raw arrows respect search mode', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null, done: () => {},
      filterFn: (list, q) => {
        const query = String(q || '').trim().toLowerCase();
        if (!query) return list;
        return list.filter((r) => r.label.toLowerCase().includes(query));
      },
    });
    const textOf = () => view.render(120).join('\n');
    view.handleInput('\x1b[C');
    assert.match(textOf(), /page 2\/3/i, 'raw RIGHT turns the page');
    view.handleInput('\x1b[D');
    assert.match(textOf(), /page 1\/3/i, 'raw LEFT turns back');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T opens the search field');
    view.handleInput('q');
    assert.equal(view.state.query, 'q', 'typing filters inside the field');
    assert.equal(view.state.page, 0, 'typing resets to the first page');
    view.handleInput('\x1b[C');
    assert.match(textOf(), /page 1\/1/i, 'raw RIGHT in search never pages');
    assert.equal(view.state.mode, 'search', 'search mode is kept');
    view.handleInput('\x1b[B');
    assert.equal(view.state.mode, 'list', 'raw DOWN moves from the search into the rows');
  });

  test('the async gh fetch keeps the verified argv shape', async () => {
    const seen = [];
    const { EventEmitter } = require('node:events');
    const spawnFn = (bin, argv, opts) => {
      seen.push({ bin, argv });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      setImmediate(() => {
        proc.stdout.emit('data', JSON.stringify([{ number: 5, title: 'Async row' }]));
        proc.emit('close', 0);
      });
      return proc;
    };
    const out = await picker.fetchOpenIssuesAsync({ cwd: '/repo', ghBin: 'gh', spawnFn });
    assert.equal(out.ok, true);
    assert.deepEqual(out.issues, [{ number: 5, title: 'Async row' }]);
    assert.deepEqual(
      seen[0].argv,
      ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '200'],
      'same shape as the sync fetch, never a shell string',
    );
  });

  test('the async gh fetch aborts on timeout instead of blocking', async () => {
    const out = await picker.fetchOpenIssuesAsync({
      cwd: '/repo', ghBin: 'gh', timeoutMs: 20,
      spawnFn: () => ({ stdout: '', stderr: '', on: () => {}, kill: () => {} }),
    });
    assert.equal(out.ok, false, 'a hanging gh becomes a silent skip, never a frozen wizard');
  });
});

describe('the inline name input (S52 Back on every field)', { concurrency: false }, () => {
  function open(overrides = {}) {
    const finished = [];
    const view = picker.createTextInput({
      title: 'New worktree change name',
      placeholder: 'name-change',
      initial: '',
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  test('it renders the questionnaire frame with a write footer and no cross-field header', () => {
    const { view } = open();
    const lines = view.render(90);
    const text = lines.join('\n');
    assert.ok(/^─+$/.test(lines[0]), 'a thin accent rule opens');
    assert.ok(/^─+$/.test(lines[lines.length - 1]), 'a thin accent rule closes');
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('Type') || !text.includes('Issues'), 'no joint Type Name Issues Odd header groups the panels');
    assert.ok(!text.includes('Odd'), 'the name panel leaks no Odd tab');
    assert.ok(text.includes('New worktree change name'), 'the panel keeps only its own title');
    assert.match(text, /enter.*confirm/i, 'Enter confirms');
    assert.match(text, /tab.*back/i, 'Tab goes back');
    assert.match(text, /esc.*cancel/i, 'Esc cancels');
  });

  test('the name field starts truly empty: no example text in the rendered input', () => {
    const { view } = open();
    assert.equal(view.state.value, '', 'the initial value is empty, not prefilled');
    const text = view.render(90).join('\n');
    assert.ok(!text.includes('name-change'), 'no example placeholder renders inside the input');
    assert.ok(!text.includes('picked'), 'no stale value renders either');
  });

  test('first typing lands as the actual value with the cursor after it', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const { view } = open();
    view.handleInput('a');
    assert.equal(view.state.value, 'a', 'the first keystroke is the actual value');
    const line = view.render(90).join('\n').split('\n').find((l) => l.includes('❯'));
    assert.ok(line, 'the input line renders');
    assert.ok(line.includes('a'), 'the typed value renders in the input line');
    const marker = tui.CURSOR_MARKER;
    const at = line.indexOf(marker);
    assert.ok(at >= 0, 'the real Pi cursor marker renders in the input line');
    assert.equal(line[at + marker.length], '▊', 'the visual cursor sits immediately after the marker');
    assert.ok(line.indexOf('a') < at, 'the marker (and cursor) sit after the actual value, never after a placeholder');
  });

  test('the cursor marker is zero-width: Unicode/ANSI width stays exact', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const { view } = open();
    for (const ch of 'caf\u00e9 \u4e2d') view.handleInput(ch);
    const line = view.render(120).join('\n').split('\n').find((l) => l.includes('caf'));
    assert.ok(line, 'the unicode value renders');
    const stripped = String(line).replace(/\x1b\[[0-9;]*m/g, '');
    const withMarker = tui.visibleWidth(stripped);
    const withoutMarker = tui.visibleWidth(stripped.split(tui.CURSOR_MARKER).join(''));
    assert.equal(withMarker, withoutMarker - 1 + 1, 'marker is zero-width, cursor cell counts one');
    assert.ok(withoutMarker > [...'caf\u00e9 \u4e2d'].length, 'wide characters count wider than codepoints');
  });

  test('Back restores only the actually typed prior value, still with no example text', () => {
    const { view, finished } = open({ initial: 'picked' });
    assert.equal(view.state.value, 'picked', 'the actually typed value is restored');
    const text = view.render(90).join('\n');
    assert.ok(text.includes('picked'), 'the restored value renders');
    assert.ok(!text.includes('name-change'), 'the example never renders, even on return');
    view.handleInput('tab');
    assert.deepEqual(finished, [{ back: true, value: 'picked' }], 'Tab alone goes back carrying the typed value');
    assert.equal(view.state.value, 'picked', 'the typed value is kept for the return trip');
  });

  test('typing appends (spaces included), Enter submits, Esc cancels, Tab goes back', () => {
    const { view, finished } = open();
    for (const ch of 'my change') view.handleInput(ch);
    assert.equal(view.state.value, 'my change', 'spaces type in a text input');
    view.handleInput('backspace');
    assert.equal(view.state.value, 'my chang');
    view.handleInput('enter');
    assert.deepEqual(finished, ['my chang'], 'Enter submits the typed value');
  });

  test('Tab returns {back:true} with the typed value and Esc returns null, exactly once', () => {
    const tab = open();
    tab.view.handleInput('t');
    tab.view.handleInput('tab');
    assert.deepEqual(tab.finished, [{ back: true, value: 't' }], 'Tab alone goes back carrying the typed value');
    assert.equal(tab.view.state.value, 't', 'the typed value is kept for the return trip');
    tab.view.handleInput('tab');
    tab.view.handleInput('escape');
    assert.deepEqual(tab.finished, [{ back: true, value: 't' }], 'one back, never a second resolution');
    const esc = open();
    esc.view.handleInput('escape');
    esc.view.handleInput('enter');
    assert.deepEqual(esc.finished, [null], 'one cancel, never a second resolution');
  });

  test('the initial value is kept for editing', () => {
    const { view, finished } = open({ initial: 'picked' });
    assert.equal(view.state.value, 'picked', 'Back from a later step restores the kept name');
    view.handleInput('enter');
    assert.deepEqual(finished, ['picked'], 'submitting unchanged keeps it');
  });

  test('raw terminal keys drive it with real helpers', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = open({ helpers });
    first.view.handleInput('a');
    first.view.handleInput('\x7f');
    first.view.handleInput('b');
    first.view.handleInput('\t');
    assert.deepEqual(first.finished, [{ back: true, value: 'b' }], 'raw Tab goes back carrying the typed value with real helpers');
  });
  test('raw terminal keys drive it with the raw fallback (no helpers)', () => {
    const second = open();
    second.view.handleInput('x');
    second.view.handleInput('\x1b');
    assert.deepEqual(second.finished, [null], 'raw Esc cancels with no helpers');
    const third = open();
    third.view.handleInput('y');
    third.view.handleInput('\r');
    assert.deepEqual(third.finished, ['y'], 'raw CR submits with no helpers');
    const fourth = open();
    fourth.view.handleInput(' ');
    assert.equal(fourth.view.state.value, ' ', 'raw Space types with no helpers');
  });
});

describe('the inline type single-select (Tab Back, no selectable rows)', { concurrency: false }, () => {
  const TYPE_ITEMS = [
    'Feature (feat)', 'Bug fix (fix)', 'Chore (chore)', 'Docs (docs)', 'Style (style)',
    'Refactor (refactor)', 'Performance (perf)', 'Test (test)', 'Build (build)', 'CI (ci)', 'Revert (revert)',
  ];
  function openType(overrides = {}) {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'New worktree change type',
      items: TYPE_ITEMS,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('it renders eleven data rows only with a Tab-back footer', () => {
    const { view, finished } = openType();
    const text = view.render(90).join('\n');
    assert.equal(TYPE_ITEMS.length, 11, 'eleven conventional types');
    for (const item of TYPE_ITEMS) assert.ok(text.includes(item), `renders ${item}`);
    assert.ok(!text.includes('Back'), 'no selectable Back row anywhere');
    assert.ok(!text.includes('Confirm'), 'no selectable Confirm row anywhere');
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('Name') && !text.includes('Issues') && !text.includes('Odd'), 'the type panel leaks no other-field tabs');
    assert.ok(text.includes('New worktree change type'), 'the panel keeps only its own title');
    assert.match(text, /enter.*confirm/i, 'the footer names Enter as confirm');
    assert.match(text, /tab.*back/i, 'the footer names Tab as back');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true }], 'raw Tab returns Back (single-select carries no list state)');
  });
  test('raw keys with the real matcher: arrows move, Enter confirms, Tab goes back', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = openType({ helpers });
    first.view.handleInput('\x1b[B');
    first.view.handleInput('\r');
    assert.deepEqual(first.finished, ['Bug fix (fix)'], 'raw arrow moved, raw CR confirmed the data row');
    const second = openType({ helpers });
    second.view.handleInput('\t');
    assert.deepEqual(second.finished, [{ back: true }], 'raw Tab goes Back with the real matcher');
    const third = openType({ helpers });
    third.view.handleInput('\x1b');
    assert.deepEqual(third.finished, [null], 'raw Esc cancels');
  });
  test('Enter on the last data row confirms; no phantom row after it', () => {
    const { view, finished } = openType();
    for (let i = 0; i < 20; i += 1) view.handleInput('down');
    view.handleInput('\r');
    assert.deepEqual(finished, ['Revert (revert)'], 'clamped on the last data row, Enter confirms it');
  });
  test('prior selection on return restores the cursor', () => {
    const { view, finished } = openType({ initialSelected: 'Bug fix (fix)' });
    view.handleInput('\r');
    assert.deepEqual(finished, ['Bug fix (fix)'], 'the kept type confirms directly');
  });
});

describe('multi-select revisit state (query, page, cursor, selections)', { concurrency: false }, () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const filterFn = (list, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return list;
    return list.filter((r) => r.label.toLowerCase().includes(query));
  };
  function openRevisit(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select rows (optional)',
      items: rows,
      filterFn,
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('initialQuery/initialPage/initialCursor restore the previous pass', () => {
    const { view } = openRevisit({ initialQuery: 'row 1', initialPage: 0, initialCursor: 2 });
    assert.equal(view.state.query, 'row 1', 'the kept filter is restored');
    assert.equal(view.state.cursor, 2, 'the kept cursor is restored');
    const text = view.render(120).join('\n');
    assert.ok(text.includes('row 12'), 'the filter still narrows (row 1, 10, 11, 12)');
    assert.ok(!text.includes('row 3'), 'unmatched rows stay filtered out');
    assert.match(text, /page 1\/1/i, 'the restored page fits the filtered list');
  });
  test('Tab Back echoes selections and uiState with a raw Tab', () => {
    const { view, finished } = openRevisit();
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [2], 'the second row is toggled');
    view.handleInput('t');
    view.handleInput('1');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [2], uiState: { query: '1', page: 0, cursor: 0 } }], 'raw Tab carries selections plus filter/page/cursor');
  });
  test('Enter confirm echoes uiState alongside the selection', () => {
    const { view, finished } = openRevisit();
    view.handleInput(' ');
    view.handleInput('\r');
    assert.deepEqual(finished, [{ selected: [1], uiState: { query: '', page: 0, cursor: 0 } }], 'raw CR confirms with the list position echoed');
  });
  test('a revisit round-trips filter, page and cursor through the echo', () => {
    const first = openRevisit();
    first.view.handleInput('right');
    first.view.handleInput('t');
    for (const ch of 'row 1') first.view.handleInput(ch);
    first.view.handleInput('\t');
    assert.equal(first.finished.length, 1, 'one back resolution');
    const echo = first.finished[0].uiState;
    assert.equal(echo.query, 'row 1', 'the filter travels in the echo');
    const second = openRevisit({
      initialQuery: echo.query,
      initialPage: echo.page,
      initialCursor: echo.cursor,
      initialSelected: first.finished[0].selected,
    });
    assert.equal(second.view.state.query, 'row 1', 'the revisit restores the filter');
    const text = second.view.render(120).join('\n');
    assert.ok(text.includes('row 1'), 'filtered rows render on revisit');
    second.view.handleInput('\r');
    assert.deepEqual(second.finished, [{ selected: [], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'confirm on revisit carries the restored filter');
  });
});

describe('warp selector Ctrl+D delete (single-select extension)', { concurrency: false }, () => {
  const ITEMS = ['principal — /tmp/principal', 'feat-one — /tmp/one', 'Create new worktree…'];
  // Eligible: every checkout row except the principal (index 0) and the
  // create row (last). Mirrors the warp selector rule: principal and
  // create are never deletable.
  const canDelete = (index) => index === 1;
  function openWarp(overrides = {}) {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'Warp session · current: principal /tmp/principal',
      items: ITEMS,
      helpers: null,
      hostTui: null,
      theme: null,
      canDelete,
      confirmLabel: 'warp',
      showTab: false,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('raw Ctrl+D (\\x04) via the raw fallback invokes delete on the eligible row', () => {
    const { view, finished } = openWarp();
    view.handleInput('down');
    assert.equal(view.state.cursor, 1, 'focus on the eligible worktree');
    view.handleInput('\x04');
    assert.deepEqual(finished, [{ delete: true, index: 1, value: ITEMS[1] }], 'raw Ctrl+D deletes the focused eligible row');
  });
  test('raw Ctrl+D via the installed matcher invokes delete on the eligible row', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    assert.equal(tui.matchesKey('\x04', 'ctrl+d'), true, 'precondition: the installed matcher owns Ctrl+D');
    const { view, finished } = openWarp({ helpers: { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease } });
    view.handleInput('down');
    view.handleInput('\x04');
    assert.deepEqual(finished, [{ delete: true, index: 1, value: ITEMS[1] }], 'installed matcher Ctrl+D deletes');
  });
  test('Ctrl+D on principal and create rows is a safe no-op', () => {
    const { view, finished } = openWarp();
    assert.equal(view.state.cursor, 0, 'starts on the principal');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'principal never deletes');
    view.handleInput('down');
    view.handleInput('down');
    assert.equal(view.state.cursor, 2, 'focus on the create row');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'create never deletes');
    view.handleInput('\r');
    assert.deepEqual(finished, [ITEMS[2]], 'Enter still confirms the create row');
  });
  test('footer shows Ctrl+D only on the eligible row with the actual key', () => {
    const { view } = openWarp();
    const principalFooter = view.render(90).join('\n');
    assert.match(principalFooter, /enter.*warp/i, 'footer names Enter warp');
    assert.ok(!principalFooter.includes('Ctrl+D'), 'no delete hint on the principal row');
    assert.ok(!principalFooter.includes('Tab'), 'no Tab hint when showTab is false');
    view.handleInput('down');
    const eligibleFooter = view.render(90).join('\n');
    assert.ok(eligibleFooter.includes('Ctrl+D delete'), 'the actual Ctrl+D key shows only on the eligible row');
    view.handleInput('down');
    const createFooter = view.render(90).join('\n');
    assert.ok(!createFooter.includes('Ctrl+D'), 'no delete hint on the create row');
  });
  test('Enter still warps and Esc still cancels with the warp footer', () => {
    const first = openWarp();
    first.view.handleInput('down');
    first.view.handleInput('\r');
    assert.deepEqual(first.finished, [ITEMS[1]], 'Enter confirms the focused checkout');
    const second = openWarp();
    second.view.handleInput('\x1b');
    assert.deepEqual(second.finished, [null], 'Esc cancels');
  });
  test('without canDelete the footer and keys stay byte-identical to before', () => {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'New worktree change type',
      items: ['Feature (feat)', 'Bug fix (fix)'],
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
    });
    const text = view.render(90).join('\n');
    assert.match(text, /enter.*confirm/i, 'default confirm verb unchanged');
    assert.match(text, /tab.*back/i, 'default Tab hint unchanged');
    assert.ok(!text.includes('Ctrl+D'), 'no delete hint without canDelete');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'Ctrl+D without canDelete does nothing');
  });
});

describe('S64 footer totals (T50, test-first RED)', () => {
  function openTotals(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` })),
      filterFn: (rows, q) => {
        const raw = String(q ?? '').trim().toLowerCase();
        if (raw === '') return rows.slice();
        return rows.filter((r) => String(r.label).toLowerCase().includes(raw));
      },
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  function textOf(view, width = 90) {
    return view.render(width).join('\n');
  }
  test('unfiltered footer names the TOTAL available count', () => {
    const { view } = openTotals();
    const text = textOf(view);
    assert.match(text, /12\s*total/i, 'the original loaded length travels as TOTAL');
    assert.match(text, /0\s*selected/i, 'selection count stays');
    assert.match(text, /page 1\/3/i, 'page stays');
  });
  test('filtered footer distinguishes filtered-available from TOTAL', () => {
    const { view } = openTotals({ pageSize: 12 });
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    view.handleInput('enter');
    const text = textOf(view);
    assert.match(text, /4\s*of\s*12/i, 'filtered 4 of TOTAL 12, never calling the filtered count the total');
    assert.match(text, /selected/i, 'selection count stays');
    assert.match(text, /page 1\/1/i, 'page stays');
  });
  test('empty list keeps an exact zero TOTAL and a single page', () => {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items: [],
      filterFn: (rows) => rows.slice(),
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
    });
    const text = view.render(90).join('\n');
    assert.match(text, /0\s*total/i, 'empty TOTAL is exact');
    assert.match(text, /page 1\/1/i, 'empty list still yields one page');
  });
  test('paging keeps TOTAL stable across pages with a selection', () => {
    const { view } = openTotals();
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('pagedown');
    const text = textOf(view);
    assert.match(text, /12\s*total/i, 'TOTAL survives paging');
    assert.match(text, /1\s*selected/i, 'selection survives paging');
    assert.match(text, /page 2\/3/i, 'page advances');
  });
});
