'use strict';
// T2/T5 (worktree-ui-feedback S3, S5, D1, D3) and round-3 T3 (S5, S8, S17)
// tests: lib/view-layout.js — the ONE width, wrapping and pagination rule the
// full-screen readers share.
//
// Contract under test, as observable output only: the preview pane takes the
// larger 60% share and the list the smaller 40% one, with no fixed column cap
// (S5); a list label wraps over as many rows as its text needs instead of
// being truncated, and it prefers a hyphen boundary over a mid-word cut
// (S17); and the page boundaries are derived from the wrapped row heights
// against the real body-row budget, so capacity follows the terminal and
// never a fixed item count (S8, D3). Nothing here touches the filesystem or
// the network.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const layout = require('../lib/view-layout.js');

const helpers = {
  visibleWidth: (text) => [...String(text).replace(/\x1b\[[0-9;]*m/g, '')].length,
};

describe('paneWidths (S5)', () => {
  test('the preview takes the larger 60% share and the list the 40% one at every normal size', () => {
    for (const width of [80, 120, 200]) {
      const inner = layout.innerWidth(width);
      const { left, right, divider } = layout.paneWidths(inner);
      assert.ok(right > left, `${width}: the preview is wider than the list (${left}/${right})`);
      assert.ok(Math.abs(left / (left + right) - 0.4) < 0.02, `${width}: the list takes 40% (${left}/${right})`);
      assert.ok(Math.abs(right / (left + right) - 0.6) < 0.02, `${width}: the preview takes 60% (${left}/${right})`);
      assert.ok(right >= 24, `${width}: the preview keeps a readable minimum, got ${right}`);
      assert.equal(left + right + divider, inner, `${width}: the two panes and the divider fill the inner width`);
    }
  });

  test('there is no old 34/36-column cap on a normal terminal', () => {
    for (const width of [100, 120, 160, 200]) {
      const { left } = layout.paneWidths(layout.innerWidth(width));
      assert.ok(left > 36, `${width}: the left pane is wider than the removed cap, got ${left}`);
    }
  });

  test('a narrow terminal keeps both panes usable instead of overflowing', () => {
    for (const width of [40, 50, 60]) {
      const inner = layout.innerWidth(width);
      const { left, right } = layout.paneWidths(inner);
      assert.ok(left >= 8, `${width}: the list keeps a floor, got ${left}`);
      assert.ok(right >= 1, `${width}: the preview keeps at least one cell, got ${right}`);
      assert.equal(left + right + 3, inner, `${width}: the panes fill the inner width`);
    }
  });

  test('an inner width of zero or one never returns a negative pane', () => {
    for (const inner of [0, 1, 2, 6]) {
      const { left, right } = layout.paneWidths(inner);
      assert.ok(left >= 1 && right >= 1, `inner ${inner}: both panes positive (${left}/${right})`);
    }
  });
});

describe('wrapLabel (S3, S17)', () => {
  test('a short label stays on one row and keeps the focus marker', () => {
    assert.deepEqual(layout.wrapLabel(helpers, 'tiny title', 20, { first: '▸ ' }), ['▸ tiny title']);
  });

  test('a long title wraps over as many rows as it needs, never truncated', () => {
    const title = 'a very long issue title that cannot fit one row of the list pane';
    const rows = layout.wrapLabel(helpers, title, 24, { first: '▸ ', rest: '  ' });
    assert.ok(rows.length > 1, `the title wraps: ${JSON.stringify(rows)}`);
    for (const row of rows) assert.ok(helpers.visibleWidth(row) <= 24, `row too wide: ${row}`);
    const text = rows.map((row) => row.replace(/^[▸ ]{2}/, '')).join(' ').replace(/\s+/g, ' ').trim();
    assert.equal(text, title, 'every word survives the wrap');
  });

  test('a word wider than the pane is hard-broken instead of overflowing', () => {
    const rows = layout.wrapLabel(helpers, 'X'.repeat(60), 10, { first: '▸ ' });
    for (const row of rows) assert.ok(helpers.visibleWidth(row) <= 10, `row too wide: ${row}`);
    assert.equal(rows.map((row) => row.replace(/^[▸ ]{2}/, '')).join(''), 'X'.repeat(60));
  });

  test('an empty label still renders one row so the item stays selectable', () => {
    assert.deepEqual(layout.wrapLabel(helpers, '', 10, { first: '▸ ' }), ['▸ ']);
  });

  test('a hyphenated label breaks after its own hyphens, never inside a segment', () => {
    assert.deepEqual(
      layout.wrapLabel(helpers, 'alpha-beta-gamma-delta', 14, { first: '', rest: '' }),
      ['alpha-beta-', 'gamma-delta'],
      'each row ends on a hyphen boundary instead of splitting a segment',
    );
  });

  test('every character of a hyphenated label survives the wrap', () => {
    const label = 'a-document-name-that-is-far-wider-than-the-list-pane';
    const rows = layout.wrapLabel(helpers, label, 30, { first: '▸ ', rest: '  ' });
    assert.ok(rows.length > 1, `the label wraps: ${JSON.stringify(rows)}`);
    for (const row of rows) assert.ok(helpers.visibleWidth(row) <= 30, `row too wide: ${row}`);
    assert.equal(rows.map((row) => row.slice(2)).join(''), label, 'no character is lost or duplicated');
  });

  test('only a segment wider than the pane is hard-cut, and the rest continues', () => {
    const label = 'short-supercalifragilisticexpialidocious-tail';
    const rows = layout.wrapLabel(helpers, label, 12, { first: '', rest: '' });
    assert.equal(rows[0], 'short-', 'the segment that fits keeps its own row');
    for (const row of rows) assert.ok(helpers.visibleWidth(row) <= 12, `row too wide: ${row}`);
    assert.equal(rows.join(''), label, 'the long segment is cut, never dropped');
  });

  test('a hyphen and a space are both break opportunities in one label', () => {
    const rows = layout.wrapLabel(helpers, 'alpha-beta gamma-delta', 13, { first: '', rest: '' });
    assert.deepEqual(rows, ['alpha-beta', 'gamma-delta'], 'the space break drops the space, the hyphen stays');
  });
});

describe('paginate (S5, D3)', () => {
  test('page count follows the body budget, not a fixed item count', () => {
    const rows = Array.from({ length: 20 }, () => 1);
    assert.equal(layout.paginate(rows, 10).length, 2, '20 single-row items in a 10-row body need 2 pages');
    assert.equal(layout.paginate(rows, 7).length, 3, 'the same list in a 7-row body needs 3 pages');
    assert.equal(layout.paginate(rows, 25).length, 1, 'a body taller than the list needs one page');
  });

  test('wrapped items spend their real row cost, so fewer tall items fit', () => {
    // three titles of three rows each in a 6-row body: two fit per page.
    const bounds = layout.paginate([3, 3, 3], 6);
    assert.equal(bounds.length, 2);
    assert.deepEqual(bounds.map((page) => [page.start, page.end]), [[0, 2], [2, 3]]);
  });

  test('no item is skipped and no page is empty', () => {
    const rows = [1, 4, 2, 3, 1, 5, 2];
    const bounds = layout.paginate(rows, 5);
    assert.equal(bounds[0].start, 0, 'pages start at the first item');
    assert.equal(bounds.at(-1).end, rows.length, 'pages end at the last item');
    for (let at = 1; at < bounds.length; at += 1) {
      assert.equal(bounds[at].start, bounds[at - 1].end, 'pages are contiguous');
    }
    for (const page of bounds) assert.ok(page.end > page.start, 'no page is empty');
  });

  test('an item taller than the whole body still gets its own page', () => {
    const bounds = layout.paginate([1, 9, 1], 4);
    assert.deepEqual(bounds.map((page) => [page.start, page.end]), [[0, 1], [1, 2], [2, 3]]);
  });

  test('an empty list still reports one page so the position reads 1/1', () => {
    assert.deepEqual(layout.paginate([], 10), [{ start: 0, end: 0, rows: 0 }]);
  });

  test('pageOf caps the wanted page instead of rendering an empty pane', () => {
    const rows = Array.from({ length: 9 }, () => 1);
    const page = layout.pageOf(rows, { budget: 4, page: 99 });
    assert.equal(page.page, 3, 'the last page is the cap');
    assert.equal(page.pageCount, 3);
    assert.deepEqual([page.start, page.end], [8, 9]);
  });

  test('pageForIndex finds the page that holds an item, so navigation never skips one', () => {
    const rows = [1, 1, 1, 1, 1];
    const bounds = layout.paginate(rows, 2);
    assert.equal(layout.pageForIndex(bounds, 0).page, 1);
    assert.equal(layout.pageForIndex(bounds, 2).page, 2);
    assert.equal(layout.pageForIndex(bounds, 4).page, 3);
    assert.equal(layout.pageForIndex(bounds, 99).page, 3, 'an out-of-range index clamps to the last page');
  });
});

describe('rowCost (S3, D3)', () => {
  test('counts the wrapped rows a title costs at the pane width', () => {
    assert.equal(layout.rowCost(helpers, 'short', 20), 1);
    assert.equal(layout.rowCost(helpers, 'a title that needs more than one row here', 30), 2);
    assert.equal(layout.rowCost(helpers, 'a title that needs more than one row here', 20), 3);
  });
});
