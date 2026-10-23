'use strict';
// Shared layout for the full-screen readers (issues-view, odd-view,
// worktree-detail-view). One place decides how wide the left list is and how
// many of its wrapped rows fit the real body budget, so the three surfaces
// cannot drift apart the way they did when each kept its own 34/36-column cap
// and its own fixed page size (S3, S5, D3).
//
// Everything here is pure and injected: width measurement arrives through the
// caller's TUI helpers, and no module-level state exists.
//
// Widths are counted in terminal cells, so a wide character costs what the
// host says it costs, never a codepoint count.

// The frame's own cells: `│ ` on the left and ` │` on the right.
const CARD_PADDING = 4;
// The divider between the two panes: ` │ `.
const DIVIDER = 3;
// The preview keeps at least this many cells on a terminal that can afford
// it, and shrinks first on one that cannot.
const PREVIEW_MIN = 24;
// The left pane never drops below this while the terminal has room for it.
const LIST_MIN = 8;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampInt(value, min, max) {
  const low = Math.ceil(num(min));
  const high = Math.floor(num(max));
  const wanted = Math.round(num(value));
  if (high <= low) return Math.max(1, Math.min(low, high));
  return Math.max(low, Math.min(high, wanted));
}

function measure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') {
      const size = Number(helpers.visibleWidth(text));
      if (Number.isFinite(size)) return size;
    }
  } catch {
    // Fall through to the plain codepoint count.
  }
  return [...String(text).replace(/\x1b\[[0-9;]*m/g, '')].length;
}

/** Inner card width: the outer width minus the frame's own cells. */
function innerWidth(width) {
  return Math.max(1, Math.floor(num(width)) - CARD_PADDING);
}

/**
 * The two pane widths for one inner width.
 *
 * The list takes about half — the user asked for the same expanded panel in
 * the issues viewer, the worktree detail and `/herdr-gentle:worktree`, and
 * for the old 34/36-column cap to disappear — while the preview keeps a
 * readable minimum and the divider fits between them.
 *
 * @returns {{left: number, right: number, divider: number}}
 */
function paneWidths(inner) {
  const usable = Math.max(2, Math.floor(num(inner)));
  const listFloor = Math.min(LIST_MIN, Math.max(1, usable - 4));
  let left = Math.round(usable / 2);
  if (left < listFloor) left = listFloor;
  const previewFloor = Math.min(PREVIEW_MIN, Math.max(1, Math.floor(usable / 3)));
  const maxLeft = usable - previewFloor - DIVIDER;
  if (left > maxLeft) left = Math.max(listFloor, maxLeft);
  left = clampInt(left, 1, Math.max(1, usable - DIVIDER - 1));
  const right = Math.max(1, usable - left - DIVIDER);
  return { left, right, divider: DIVIDER };
}

/**
 * ONE list label wrapped to the pane width.
 *
 * `first` prefixes the first row (the focus marker) and `rest` every
 * continuation row, both measured out of the available text width so the
 * first row never loses a cell to the marker. A word wider than the pane is
 * hard-broken: a title is never truncated to fit a row budget (S3).
 */
function wrapLabel(helpers, text, width, options = {}) {
  const first = String(options.first ?? '  ');
  const rest = String(options.rest ?? '  ');
  const total = Math.max(1, Math.floor(num(width)));
  const firstRoom = Math.max(1, total - measure(helpers, first));
  const restRoom = Math.max(1, total - measure(helpers, rest));
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const rows = [];
  let room = firstRoom;
  let line = '';
  const push = (value, prefixRoom) => {
    rows.push(value);
    room = prefixRoom;
    line = '';
  };
  for (const word of words) {
    if (line === '') {
      let rest2 = word;
      while (measure(helpers, rest2) > room) {
        const cut = hardCut(helpers, rest2, room);
        if (cut === '') break;
        push(cut, restRoom);
        rest2 = rest2.slice(cut.length);
      }
      line = rest2;
      continue;
    }
    if (measure(helpers, `${line} ${word}`) <= room) {
      line = `${line} ${word}`;
      continue;
    }
    push(line, restRoom);
    let tail = word;
    while (measure(helpers, tail) > room) {
      const cut = hardCut(helpers, tail, room);
      if (cut === '') break;
      push(cut, restRoom);
      tail = tail.slice(cut.length);
    }
    line = tail;
  }
  if (line !== '' || rows.length === 0) rows.push(line);
  return rows.map((row, at) => `${at === 0 ? first : rest}${row}`);
}

// The longest prefix of `text` that fits `room` cells, at least one character
// so a pane narrower than a single glyph still advances.
function hardCut(helpers, text, room) {
  const chars = [...text];
  let cut = '';
  for (const char of chars) {
    if (measure(helpers, cut + char) > room) break;
    cut += char;
  }
  return cut === '' ? chars[0] ?? '' : cut;
}

/** How many screen rows one wrapped label costs at `width`. */
function rowCost(helpers, text, width, options = {}) {
  return wrapLabel(helpers, text, width, options).length;
}

/**
 * Page bounds for a list whose items cost `rowCosts[i]` screen rows.
 *
 * A page holds as many whole items as fit `budget` rows; an item is never
 * split across pages, an item taller than the budget still gets its own page,
 * and every item lands on exactly one page (S5: capacity follows the wrapped
 * titles and the real body height, never a fixed item count).
 *
 * @returns {Array<{start: number, end: number, rows: number}>}
 */
function paginate(rowCosts, budget) {
  const list = Array.isArray(rowCosts) ? rowCosts : [];
  const size = Math.max(1, Math.floor(num(budget)));
  const pages = [];
  let start = 0;
  while (start < list.length) {
    let end = start;
    let rows = 0;
    while (end < list.length) {
      const cost = Math.max(1, Math.ceil(num(list[end])));
      if (end > start && rows + cost > size) break;
      rows += cost;
      end += 1;
    }
    pages.push({ start, end, rows });
    start = end;
  }
  if (pages.length === 0) pages.push({ start: 0, end: 0, rows: 0 });
  return pages;
}

/** The (clamped) page that holds `index`, 1-based like the footer reads it. */
function pageForIndex(pages, index) {
  const bounds = Array.isArray(pages) && pages.length > 0 ? pages : [{ start: 0, end: 0, rows: 0 }];
  const wanted = Math.max(0, Math.floor(num(index)));
  for (let at = 0; at < bounds.length; at += 1) {
    if (wanted >= bounds[at].start && wanted < bounds[at].end) {
      return { page: at + 1, bounds: bounds[at] };
    }
  }
  const last = bounds.length - 1;
  return { page: last + 1, bounds: bounds[last] };
}

/** The requested (clamped) page with its 1-based number and total count. */
function pageOf(rowCosts, options = {}) {
  const pages = paginate(rowCosts, options.budget);
  const wanted = Math.max(1, Math.floor(num(options.page)) || 1);
  const page = Math.min(wanted, pages.length);
  return { page, pageCount: pages.length, start: pages[page - 1].start, end: pages[page - 1].end };
}

module.exports = {
  CARD_PADDING,
  DIVIDER,
  PREVIEW_MIN,
  LIST_MIN,
  innerWidth,
  measure,
  paneWidths,
  wrapLabel,
  rowCost,
  paginate,
  pageForIndex,
  pageOf,
};
