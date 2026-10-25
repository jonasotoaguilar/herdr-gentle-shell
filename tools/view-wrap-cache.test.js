'use strict';
// T15 (worktree-ui-redesign S23) tests: a reading view never re-wraps content
// that did not change.
//
// Contract under test, as observable behavior only:
//   - a second paint with the same content and the same width recomputes
//     NOTHING (the wrap counter does not move) and paints exactly the rows the
//     first paint painted;
//   - a changed width and a changed content each recompute once and the pane
//     then shows the NEW rows, so a memo can never serve a stale one;
//   - the cache is a pure accelerator: the rendered bytes do not change.
//
// Two seams count recomputation, both public:
//   - `createWrapCache()` / the shared `defaultWrapCache` expose
//     `stats.wraps` (actual wraps performed) and `stats.hits`, so the issue
//     preview path can assert "zero wraps on a repaint" exactly;
//   - the injected TUI helpers count how often a wrapped probe reaches the
//     width measurement. A list label is wrapped by measuring candidate joins
//     of its atoms, and none of those probes is ever a painted row, so probes
//     longer than any rendered cell prove that the list was re-wrapped. The
//     fixtures use names/titles that are one unbreakable token far wider than
//     the pane, so every such probe is unambiguous.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createWorktreeDetailView } = require('../lib/worktree-detail-view.js');
const { createOddView } = require('../lib/odd-view.js');
const {
  issueDetailLines,
  createWrapCache,
  defaultWrapCache,
} = require('../lib/issue-preview.js');

function strip(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

// Terminal cells, not UTF-16 units: an emoji in a row must not look like two.
function cells(value) {
  return [...strip(value)].length;
}

// Any probe at least this long cannot be a painted row or a legend: every row
// is padded to its pane (at most 180 cells here) and no frame text is that
// long, so only a wrap attempt measures one.
const PROBE_MIN = 500;

function recorder() {
  const seen = [];
  const helpers = {
    visibleWidth: (text) => {
      seen.push(String(text));
      return [...strip(text)].length;
    },
    truncateToWidth: (text, width) => {
      const chars = [...String(text)];
      return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
    },
    matchesKey: (key, name) => key === name,
    isKeyRelease: (key) => key === 'release',
  };
  return {
    helpers,
    reset: () => { seen.length = 0; },
    probes: () => seen.filter((text) => [...strip(text)].length >= PROBE_MIN).length,
    // Measurements long enough that no painted row (at most the pane width) or
    // legend can be one, but short enough to catch a re-wrapped source line.
    longer: (limit) => seen.filter((text) => [...strip(text)].length >= limit).length,
  };
}

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text) };
const BEGIN = 'ZQXBEGIN';
const CONTENT = 'ZQXCONTENT';
const REPLACED = 'ZQXREPLACED';
const NOW = Date.parse('2026-03-01T00:00:00.000Z');

// 200 source lines of ~200 characters: a document long enough that wrapping it
// is the dominant per-paint cost.
function longBody(tag) {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore '.repeat(2);
  return Array.from({ length: 200 }, (_, i) => `${tag} line ${i} ${filler.slice(0, 170)}`).join('\n');
}

// One unbreakable token, far wider than any pane: only a wrap measures it whole.
function longName(tag, suffix) {
  return `${tag}${suffix}${'x'.repeat(540)}`;
}

function comments(count) {
  return Array.from({ length: count }, (_, c) => ({
    author: `author${c}`,
    body: longBody(`${CONTENT} comment ${c}`),
    createdAt: '2026-02-20T00:00:00.000Z',
  }));
}

function detailIssue(body = longBody(`${CONTENT} issue`), number = 77) {
  return {
    number,
    title: 'a title that is short enough to stay on one row',
    state: 'open',
    author: 'octo',
    labels: [{ name: 'bug' }],
    createdAt: '2026-02-25T00:00:00.000Z',
    updatedAt: '2026-02-26T00:00:00.000Z',
    commentsCount: 3,
    body,
  };
}

describe('issue preview formatter (S23)', () => {
  test('a second render with the same content and width wraps nothing and returns the same rows', () => {
    const cache = createWrapCache();
    const issue = detailIssue();
    const list = comments(3);
    const options = { width: 80, paint: (_role, text) => String(text), emphasis: (text) => String(text), now: NOW, cache };

    const first = issueDetailLines(issue, list, { ...options });
    const wrapsAfterFirst = cache.stats.wraps;
    assert.ok(wrapsAfterFirst > 0, 'the first render wraps the body and every comment');

    const second = issueDetailLines(issue, list, { ...options });
    assert.equal(cache.stats.wraps, wrapsAfterFirst, 'an unchanged repaint performs no wrap at all');
    assert.ok(cache.stats.hits > 0, 'the cached rows were reused');
    assert.deepEqual(second, first, 'the memo returns exactly the first pass rows');
  });

  test('a width change re-wraps once and the new rows fit the new width', () => {
    const cache = createWrapCache();
    const issue = detailIssue();
    const options = (width) => ({ width, paint: (_role, text) => String(text), emphasis: (text) => String(text), now: NOW, cache });

    const narrow = issueDetailLines(issue, [], options(80));
    issueDetailLines(issue, [], options(80));
    const wrapsBeforeWide = cache.stats.wraps;

    const wide = issueDetailLines(issue, [], options(180));
    assert.ok(cache.stats.wraps > wrapsBeforeWide, 'a changed width wraps again');
    assert.ok(wide.every((line) => cells(line) <= 180), 'the new rows fit the new width');
    assert.ok(wide.length < narrow.length, 'the wider pane needs fewer rows');

    const back = issueDetailLines(issue, [], options(80));
    assert.deepEqual(back, narrow, 'returning to a cached width paints the earlier rows exactly');
  });

  test('a content change re-wraps once and never shows the previous body', () => {
    const cache = createWrapCache();
    const options = { width: 80, paint: (_role, text) => String(text), emphasis: (text) => String(text), now: NOW, cache };

    const first = issueDetailLines(detailIssue(), [], options);
    assert.ok(first.join('\n').includes(CONTENT), 'the first body is on screen');
    const wrapsBefore = cache.stats.wraps;

    const changed = issueDetailLines(detailIssue(longBody(REPLACED)), [], options);
    assert.ok(cache.stats.wraps > wrapsBefore, 'new content wraps again');
    const text = changed.join('\n');
    assert.ok(text.includes(REPLACED), 'the new body is shown');
    assert.ok(!text.includes(CONTENT), 'no stale row from the previous body survives');
  });
});

describe('worktree detail view (S23)', () => {
  function makeView({ issues, loadIssue, documents = [], loadDocument, recorder: rec, rows = 30 }) {
    return createWorktreeDetailView({
      worktree: { name: 'w1', path: '/repo/w1', branch: 'feat/w1', changes: 1 },
      issues,
      assignedIssues: [],
      documents,
      odd: null,
      loadIssue,
      loadDocument: loadDocument || (() => ({ ok: false, error: 'none' })),
      save: () => ({ ok: true }),
      helpers: rec.helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: () => {},
    });
  }

  test('the second paint of an unchanged issue preview re-wraps nothing and paints the same rows', () => {
    const rec = recorder();
    const issue = detailIssue();
    const list = comments(2);
    const view = makeView({
      recorder: rec,
      issues: [issue],
      loadIssue: () => ({ ok: true, issue, comments: list }),
    });

    const first = view.render(80);
    const wrapsAfterFirst = defaultWrapCache.stats.wraps;
    assert.ok(wrapsAfterFirst >= 0);

    const second = view.render(80);
    assert.equal(defaultWrapCache.stats.wraps, wrapsAfterFirst, 'a repaint re-wraps no line of the preview');
    assert.deepEqual(second, first, 'the second paint is byte-identical to the first');
  });

  test('a width change re-wraps the preview once and refills every row to the new width', () => {
    const rec = recorder();
    const issue = detailIssue();
    const view = makeView({ recorder: rec, issues: [issue], loadIssue: () => ({ ok: true, issue, comments: [] }) });

    const narrow = view.render(80);
    view.render(80);
    const wrapsBeforeWide = defaultWrapCache.stats.wraps;

    const wide = view.render(180);
    assert.ok(defaultWrapCache.stats.wraps > wrapsBeforeWide, 'a changed width wraps the preview again');
    assert.equal(wide.length, narrow.length, 'the frame keeps its row count');
    for (const line of wide) assert.equal(cells(line), 180, `not 180 cells: "${strip(line)}"`);
    assert.notDeepEqual(wide, narrow, 'the wider pane paints wider rows instead of the cached ones');
  });

  test('a new issue list re-wraps and paints the new titles, never the previous ones', () => {
    const rec = recorder();
    const firstIssue = { number: 1, title: longName(BEGIN, '001'), state: 'open', body: 'body' };
    const nextIssue = { number: 2, title: longName(REPLACED, '002'), state: 'open', body: 'body' };
    const view = makeView({
      recorder: rec,
      issues: [firstIssue],
      // The read answers for the focused row, so the preview follows the list.
      loadIssue: (number) => ({
        ok: true,
        issue: number === 2 ? nextIssue : firstIssue,
        comments: [],
      }),
    });

    const first = view.render(80);
    assert.ok(rec.probes() > 0, 'the first paint wraps the long title');
    assert.ok(first.join('\n').includes(BEGIN), 'the first title is listed');

    rec.reset();
    view.render(80);
    assert.equal(rec.probes(), 0, 'the unchanged list is not wrapped again');

    view.apply({ issues: [nextIssue] });
    rec.reset();
    const changed = view.render(80);
    const text = changed.join('\n');
    assert.ok(rec.probes() > 0, 'the new title is wrapped');
    assert.ok(text.includes(REPLACED), 'the new title is listed');
    assert.ok(!text.includes(BEGIN), 'no stale row from the old title survives');
  });

  test('the ODD tab document body is wrapped once per width, not once per paint', () => {
    const rec = recorder();
    const body = longBody(`${CONTENT} document`);
    const doc = { name: 'long-doc', path: '/repo/w1/odd/tasks/long-doc.md', text: body };
    const view = makeView({
      recorder: rec,
      issues: [],
      loadIssue: () => ({ ok: false, error: 'none' }),
      documents: [doc],
      loadDocument: () => ({ ok: true, text: body }),
    });

    view.handleInput('\t');
    const first = view.render(80);
    rec.reset();
    const second = view.render(80);
    assert.equal(rec.longer(150), 0, 'the cached body is not wrapped again');
    assert.deepEqual(second, first, 'the repaint is byte-identical');
  });
});

describe('odd view (S23)', () => {
  function makeView({ docs, load, rec, rows = 30 }) {
    // `reloadDocs` reads the CURRENT list, so a test can hand a new set over.
    const reload = () => ({ ok: true, docs: current.docs });
    const current = { docs };
    return {
      view: createOddView({
        docs,
        loadDoc: load,
        reloadDocs: reload,
        helpers: rec.helpers,
        theme: plainTheme,
        rowsAvailable: () => rows,
        requestRender: () => {},
        done: () => {},
      }),
      setDocs: (next) => { current.docs = next; },
    };
  }

  const docRow = (name, index) => ({ name, file: `${name}.md`, path: `/checkout/odd/tasks/${index}` });

  test('the second paint of an unchanged document list wraps no name again', () => {
    const rec = recorder();
    const docs = Array.from({ length: 8 }, (_, i) => docRow(longName(BEGIN, String(i).padStart(3, '0')), i));
    const { view } = makeView({ rec, docs, load: () => ({ ok: true, text: 'short body' }) });

    const first = view.render(80);
    assert.ok(rec.probes() > 0, 'the first paint wraps the long names');

    rec.reset();
    const second = view.render(80);
    assert.equal(rec.probes(), 0, 'the unchanged list is not wrapped again');
    assert.deepEqual(second, first, 'the repaint is byte-identical');
  });

  test('a width change wraps the names again and the rows refill the new width', () => {
    const rec = recorder();
    const docs = Array.from({ length: 4 }, (_, i) => docRow(longName(BEGIN, String(i).padStart(3, '0')), i));
    const { view } = makeView({ rec, docs, load: () => ({ ok: true, text: 'short body' }) });

    const narrow = view.render(80);
    assert.ok(rec.probes() > 0);

    rec.reset();
    const wide = view.render(180);
    assert.ok(rec.probes() > 0, 'the wider pane wraps the names again');
    for (const line of wide) assert.equal(cells(line), 180, `not 180 cells: "${strip(line)}"`);
    assert.notDeepEqual(wide, narrow, 'the wider pane paints wider rows');
  });

  test('a reloaded document list wraps the new names and forgets the old rows', () => {
    const rec = recorder();
    const { view, setDocs } = makeView({ rec, docs: [docRow(longName(BEGIN, '001'), 1)], load: () => ({ ok: true, text: 'short body' }) });
    view.render(80);

    setDocs([docRow(longName(REPLACED, '002'), 2)]);
    view.handleInput('r');
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      rec.reset();
      const rows = view.render(80);
      const text = rows.join('\n');
      assert.ok(rec.probes() > 0, 'the new names are wrapped');
      assert.ok(text.includes(REPLACED), 'the new name is listed');
      assert.ok(!text.includes(BEGIN), 'no stale row from the previous list survives');
    });
  });

  test('the document body is wrapped once per width, not once per paint', () => {
    const rec = recorder();
    const body = longBody(`${CONTENT} document`);
    const { view } = makeView({ rec, docs: [docRow('short-doc', 1)], load: () => ({ ok: true, text: body }) });

    const first = view.render(80);
    rec.reset();
    const second = view.render(80);
    assert.equal(rec.longer(150), 0, 'the cached body is not wrapped again');
    assert.deepEqual(second, first, 'the repaint is byte-identical');
  });
});
