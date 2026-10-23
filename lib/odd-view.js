'use strict';
// Odd viewer component (odd-viewer S3,S4,S6).
//
// The host component contract Pi asks for (the same shape the customize
// panel uses in extensions/gentle-worktree-tools.ts): the factory returns
// { render(width), handleInput(data), invalidate(), handleMouse(event) }.
// Selection and scroll are LOCAL state: no key writes, notifies or reloads,
// and `esc` finishes through done(null). Nothing here reads or writes
// during render: the document is read once per view and scrolling only
// moves the window.
//
// S10b: the view is read-only with respect to the checkout↔document
// association. The `assigned`, `saveAssignment` and `assignmentEnabled`
// options the existing callers still pass are accepted and ignored — no
// mark, no toggle, no save — and the association lives in the worktree
// detail instead.
//
// The TUI helpers arrive injected (visibleWidth/truncateToWidth/matchesKey/
// isKeyRelease) because @earendil-works/pi-tui is a lazily imported peer of
// this package: the command loads it and passes it down, and the raw-byte
// fallbacks below keep the keys working when a host provides none. Layout
// follows the reference Changes view: a framed two-pane card, list on the
// left, document on the right, the keys on the ONE row above the bottom rule.

const { renderOddMarkdown, stripAnsi } = require('./odd-markdown.js');
const layout = require('./view-layout.js');

const CARD_PADDING = 4;
const LIST_MAX_WIDTH = 34;
const LIST_RATIO = 0.32;
const MIN_WIDTH = 24;
const EMPTY_LIST = 'no odd documents';
const EMPTY_HINT = 'create one under odd/tasks/';
// S2: ONE legend, ONE terminal row — every key rides the same row instead of
// a second footer row. `text` is the full token, `short` the compact form used
// when the full one does not fit, and `priority` decides what a
// still-too-wide legend drops first (lowest first), so `esc close` outlives
// every other hint.
//
// S4 supersedes the earlier split: ALL hints belong to the footer, including
// the search key, so the search row above carries the query alone.
const CONTENT_KEYS = [
  { text: '↑↓ select', short: '↑↓', priority: 60 },
  { text: '←/→ page', short: '←/→', priority: 55 },
  { text: 'ctrl+j/k scroll', short: 'ctrl+j/k', priority: 30 },
  { text: 'T search', short: 'T', priority: 45 },
  { text: 'r reload', short: 'r', priority: 20 },
  { text: 'o open', short: 'o open', priority: 40 },
  { text: 'esc close', short: 'esc close', priority: 70 },
];

// While the filter box holds the keyboard the footer names THAT interaction
// once — enter and esc each keep the filter, Delete clears the whole query and
// Backspace edits one character (S4). Each is a single token so the extra keys
// never inflate the ONE legend row (S2).
const SEARCH_KEYS = [
  { text: 'type to filter', short: 'type', priority: 40 },
  { text: 'del clear', short: 'del', priority: 50 },
  { text: 'bksp edit', short: 'bksp', priority: 20 },
  { text: 'enter/esc keep', short: 'enter/esc', priority: 60 },
];

// S15: ctrl+j/ctrl+k are not delivered by every terminal, so the preview also
// scrolls half a page on the Vim-universal ctrl+d/ctrl+u pair and on the
// shifted letters — `j`/`k` stay the list-selection keys, and `J`/`K` are
// plain printable bytes that need no raw entry of their own (the shifted id
// also matches the terminal's shifted-letter report under the Kitty protocol).
const HALF_PAGE_DOWN = ['ctrl+d', 'J', 'shift+j'];
const HALF_PAGE_UP = ['ctrl+u', 'K', 'shift+k'];
// The shifted letters above are their own keys: a loose case fallback would
// let `J`/`K` answer for the `j`/`k` selection bindings instead, so their
// unshifted twins never match a shifted character. Every other letter keeps
// the case fallback the hosts have always had.
const SHIFTED_TWINS = new Set(HALF_PAGE_DOWN.concat(HALF_PAGE_UP)
  .filter((name) => name.length === 1 && name >= 'A' && name <= 'Z')
  .map((name) => name.toLowerCase()));

// Raw terminal bytes per key id, mirroring the installed pi-tui keys.js
// legacy sequences — the same convention lib/warp-create-picker.js uses.
// Bounded to the keys this view binds, so the preview stays drivable when
// the host helper module is absent (a scroll key that reads as frozen is
// worse than a redundant fallback).
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  backspace: ['\x7f', '\b'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
  'ctrl+j': ['\n', '\x1b[106;5u'],
  'ctrl+k': ['\x0b', '\x1b[107;5u'],
  'ctrl+d': ['\x04', '\x1b[100;5u'],
  'ctrl+u': ['\x15', '\x1b[117;5u'],
  pageup: ['\x1b[5~', '\x1b[57421u'],
  pagedown: ['\x1b[6~', '\x1b[57422u'],
  left: ['\x1b[D', '\x1bOD'],
  right: ['\x1b[C', '\x1bOC'],
  delete: ['\x1b[3~', '\x1b[57427u'],
  home: ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[57423u'],
  end: ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[57424u'],
};

// Mouse wheel as SGR / legacy X10 bytes: some hosts deliver the wheel through
// handleMouse, older ones through the input stream. Both are parsed here so a
// wheel notch scrolls the preview either way. Button bit 64 flags the wheel;
// bits 0-1 are the direction (0 = up, 1 = down).
const WHEEL_SGR = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;
const WHEEL_LEGACY = /^\x1b\[M([\s\S]{3})$/;

function wheelDeltaFromInput(data) {
  if (typeof data !== 'string' || data.length < 6 || data[0] !== '\x1b') return undefined;
  let button;
  const sgr = WHEEL_SGR.exec(data);
  if (sgr) {
    button = Number.parseInt(sgr[1], 10);
  } else {
    const legacy = WHEEL_LEGACY.exec(data);
    if (!legacy) return undefined;
    button = legacy[1].charCodeAt(0) - 32;
  }
  if (!Number.isFinite(button) || (button & 64) === 0) return undefined;
  const direction = button & 3;
  if (direction !== 0 && direction !== 1) return undefined;
  return direction === 0 ? -1 : 1;
}

function measure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') {
      const size = Number(helpers.visibleWidth(text));
      if (Number.isFinite(size)) return size;
    }
  } catch {
    // Fall through to the ANSI-stripped codepoint count.
  }
  return [...stripAnsi(text)].length;
}

function fit(helpers, text, width) {
  const clean = String(text).split('\n')[0] ?? '';
  if (measure(helpers, clean) <= width) return clean;
  try {
    if (helpers && typeof helpers.truncateToWidth === 'function') {
      const cut = helpers.truncateToWidth(clean, width, '…');
      if (typeof cut === 'string') return cut;
    }
  } catch {
    // Fall through to the plain slice.
  }
  const chars = [...clean];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : clean;
}

function pad(helpers, text, width) {
  const clipped = fit(helpers, text, width);
  return clipped + ' '.repeat(Math.max(0, width - measure(helpers, clipped)));
}

// A row that carries its main text on the left and a value on the right edge
// (S13: the scroll position shares the search row). The value is dropped
// rather than allowed to crowd the left text out when the row is too narrow.
function withRight(helpers, left, right, width) {
  if (right === '') return pad(helpers, left, width);
  const room = width - measure(helpers, right) - 2;
  if (room < 8) return pad(helpers, left, width);
  const head = fit(helpers, left, room);
  const gap = Math.max(1, width - measure(helpers, head) - measure(helpers, right));
  return `${head}${' '.repeat(gap)}${right}`;
}

// S2: a key legend stays on ONE row. The full text is used while it fits;
// otherwise the legend compacts to its short tokens and then drops its
// lowest-priority keys (display order never changes, and no token carries a
// newline), so it never wraps onto a second row. The caller still pads, which
// keeps the row cell-exact if a single token is wider than the pane.
function legendText(helpers, entries, width) {
  const join = (list, field) => list.map((entry) => entry[field]).join(' · ');
  const fits = (text) => measure(helpers, text) <= width;
  if (fits(join(entries, 'text'))) return join(entries, 'text');
  if (fits(join(entries, 'short'))) return join(entries, 'short');
  const kept = entries.slice();
  while (kept.length > 1) {
    let drop = 0;
    for (let at = 1; at < kept.length; at += 1) {
      if (kept[at].priority <= kept[drop].priority) drop = at;
    }
    kept.splice(drop, 1);
    if (fits(join(kept, 'short'))) break;
  }
  return join(kept, 'short');
}

function paint(theme, role, text) {
  try {
    if (theme && typeof theme.fg === 'function') {
      const painted = theme.fg(role, text);
      if (typeof painted === 'string') return painted;
    }
  } catch {
    // A hostile theme never breaks the view.
  }
  return text;
}

function emphasize(theme, text) {
  try {
    if (theme && typeof theme.bold === 'function') {
      const bold = theme.bold(text);
      if (typeof bold === 'string') return bold;
    }
  } catch {
    // Fall through to plain text.
  }
  return text;
}

function highlight(theme, text, focused) {
  if (!focused) return text;
  try {
    if (theme && typeof theme.bg === 'function') {
      const painted = theme.bg('selectedBg', text);
      if (typeof painted === 'string') return painted;
    }
  } catch {
    // Fall through to the accent form below.
  }
  return paint(theme, 'accent', text);
}

function keyMatches(helpers, data, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
    } catch {
      // A throwing matcher never matches; the raw fallback below decides.
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    for (const name of names) {
      const raw = RAW_KEY_BYTES[String(name).toLowerCase()];
      if (raw && raw.includes(data)) return true;
    }
  }
  // A host that classifies the raw bytes can still resolve the same name
  // through its public parser: ctrl+j arrives as a newline, which the
  // installed parser reads as `ctrl+j` while its legacy Enter alias stays a
  // separate binding.
  let parsed = null;
  try {
    if (helpers && typeof helpers.parseKey === 'function') parsed = helpers.parseKey(data);
  } catch {
    // A throwing parser falls through to the plain comparison.
  }
  if (typeof parsed === 'string' && parsed.length > 0
    && names.some((name) => sameKeyName(parsed, name))) return true;
  const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  return names.some((name) => sameKeyName(text, name));
}

// Key ids are loose about case because hosts spell them differently
// (`pageDown` vs `pagedown`); only a shifted letter whose unshifted twin is a
// live binding (`J` next to `j`) stays case-sensitive.
function sameKeyName(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return true;
  const shiftedLetter = (text) => text.length === 1 && text >= 'A' && text <= 'Z';
  if (shiftedLetter(a) && !shiftedLetter(b) && SHIFTED_TWINS.has(b.toLowerCase())) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function isKeyRelease(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === 'function') return helpers.isKeyRelease(data) === true;
  } catch {
    // A throwing classifier never releases; normal handling follows.
  }
  return false;
}

function normalizeLoad(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'document unreadable' };
  if (result.ok === true && typeof result.text === 'string') return { ok: true, text: result.text };
  if (result.ok === false) return { ok: false, error: String(result.error || 'document unreadable') };
  return { ok: false, error: 'document unreadable' };
}

function createOddView(options = {}) {
  const {
    helpers = null,
    theme = null,
    rowsAvailable = null,
    requestRender = null,
    done = null,
    loadDoc = null,
    reloadDocs = null,
    openExternal = null,
  } = options;
  // S10b: `options.assigned`, `options.saveAssignment` and
  // `options.assignmentEnabled` are deliberately not read: the association
  // belongs to the worktree detail, and this view stays read-only.
  let docs = Array.isArray(options.docs) ? options.docs.slice() : [];
  const entries = new Map();
  const state = { index: 0, scroll: 0, query: '', searching: false, listPage: 1 };
  let openError = null;
  let bodyRows = 1;
  // The list pane width of the last frame, so a key press pages against the
  // layout the reader is actually looking at.
  let listWidthCache = LIST_MAX_WIDTH;

  // S24/S25: the title is the viewer and the count, nothing more. The
  // checkout/branch identity is not repeated here (it is the session's own
  // checkout) and neither is the selected document — that rides the status
  // row next to the preview. `checkoutName` stays accepted for the existing
  // callers but is deliberately not rendered.
  function titleText() {
    return `✎ Odd · ${docs.length} documents`;
  }

  // The visible list: the filter narrows by document name
  // (case-insensitive substring), exactly like the issues viewer keeps its
  // query after leaving the box — selection indexes into this list.
  function shown() {
    const q = state.query.trim().toLowerCase();
    if (q === '') return docs;
    return docs.filter((docEntry) => String((docEntry && docEntry.name) || '').toLowerCase().includes(q));
  }

  function availableRows() {
    try {
      if (typeof rowsAvailable === 'function') {
        const value = Math.floor(rowsAvailable());
        if (Number.isFinite(value) && value > 0) return value;
      }
    } catch {
      // A hostile rows source never breaks the view.
    }
    return 24;
  }

  function repaint() {
    try {
      if (typeof requestRender === 'function') requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function current() {
    const list = shown();
    return list[state.index] || null;
  }

  function renderLines(entry, text, width) {
    entry.lines = renderOddMarkdown(text, {
      width,
      paint: (role, value) => paint(theme, role, value),
      emphasis: (value) => emphasize(theme, value),
      measure: (value) => measure(helpers, value),
    });
    entry.text = text;
    entry.width = width;
  }

  // One read per document per view: the entry keeps its text and rendered
  // lines, so re-selecting a document never re-reads or blocks a frame.
  function ensureEntry(docEntry) {
    if (!docEntry) return null;
    const key = docEntry.path || docEntry.name;
    let entry = entries.get(key);
    if (entry) return entry;
    entry = { status: 'loading', lines: [], text: '', width: 0 };
    entries.set(key, entry);
    if (typeof loadDoc !== 'function') {
      entry.status = 'error';
      entry.error = 'document unreadable';
      return entry;
    }
    let pending = null;
    try {
      pending = loadDoc(docEntry, key);
    } catch (err) {
      entry.status = 'error';
      entry.error = (err && err.message) || 'document unreadable';
      return entry;
    }
    const settle = (result) => {
      const normalized = normalizeLoad(result);
      if (normalized.ok) {
        entry.status = 'ready';
        renderLines(entry, normalized.text, entry.width || MIN_WIDTH);
      } else {
        entry.status = 'error';
        entry.error = normalized.error;
      }
      repaint();
    };
    // A synchronous reader (this package reads a local file) settles before
    // the next frame, so selecting a document never shows a placeholder for
    // a read that already finished.
    if (pending && typeof pending.then === 'function') {
      pending.then(settle).catch((err) => {
        entry.status = 'error';
        entry.error = (err && err.message) || 'document unreadable';
        repaint();
      });
    } else {
      settle(pending);
    }
    return entry;
  }

  function clampScroll() {
    const entry = current() ? ensureEntry(current()) : null;
    const total = entry && entry.status === 'ready' ? entry.lines.length : 0;
    const max = Math.max(0, total - Math.max(1, bodyRows));
    if (state.scroll > max) state.scroll = max;
    if (state.scroll < 0) state.scroll = 0;
  }

  // One place moves the document window, so every input path (keyboard,
  // wheel event, wheel bytes) clamps and repaints identically and none of
  // them writes or reads outside the view.
  function scrollBy(delta) {
    if (!Number.isFinite(delta) || delta === 0) return;
    state.scroll += delta;
    clampScroll();
    repaint();
  }

  // The host delivers a wheel notch as a TuiMouseEvent (type `wheel`, a
  // signed `wheelDelta`). The preview is the reading surface, so the wheel
  // moves it from anywhere in the frame and never touches the list
  // selection. Only the wheel is consumed; other events stay unhandled so
  // the host keeps its own mouse behavior.
  function handleMouse(event) {
    if (!event || event.type !== 'wheel') return undefined;
    const delta = Number(event.wheelDelta);
    if (!Number.isFinite(delta) || delta === 0) return undefined;
    scrollBy(delta);
    return { handled: true, render: true };
  }

  // S5: "para odd igual, si son muchas igual se pagina". The document list is
  // paged by the rows each wrapped name actually needs against the body budget
  // the terminal leaves, never by a fixed document count (D3).
  function listBounds() {
    const costs = shown().map((docEntry) => layout.rowCost(helpers, String((docEntry && docEntry.name) || ''), listWidthCache, { first: '▸ ' }));
    return layout.paginate(costs, bodyRows);
  }

  function listPageState() {
    const bounds = listBounds();
    const found = layout.pageForIndex(bounds, state.index);
    state.listPage = found.page;
    return { bounds, pageCount: bounds.length, current: found.bounds };
  }

  // One place moves the list window: the focused document is always on the
  // page the footer names, so paging never hides the selection.
  function pageList(step) {
    const bounds = listBounds();
    const target = Math.max(1, Math.min(bounds.length, state.listPage + step));
    const page = bounds[target - 1];
    if (!page || page.end <= page.start || target === state.listPage) return;
    state.listPage = target;
    state.index = page.start;
    state.scroll = 0;
    ensureEntry(current());
    repaint();
  }

  function render(width) {
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    const title = titleText();
    if (w < MIN_WIDTH || height < 4) {
      return [pad(helpers, fit(helpers, `${title} — enlarge the terminal`, w), w)].slice(0, Math.max(1, Math.min(height, 1)));
    }
    const list = shown();
    if (state.index >= list.length) state.index = Math.max(0, list.length - 1);
    // CARD_PADDING covers the frame's own `│ ` and ` │` cells, so this inner
    // width fills the terminal exactly: the right border belongs in the last
    // cell (S24/S27 — no trailing slack, corners and edges stay aligned).
    const inner = Math.max(1, w - CARD_PADDING);
    const listWidth = Math.min(LIST_MAX_WIDTH, Math.max(12, Math.floor(inner * LIST_RATIO)));
    listWidthCache = listWidth;
    const rightWidth = Math.max(1, inner - listWidth - 3);
    // top rule + search row + the ONE footer legend + bottom rule: the legend
    // owns a single row (S2), so the panes get every remaining row.
    bodyRows = Math.max(1, height - 4);
    const docEntry = current();
    const entry = docEntry ? ensureEntry(docEntry) : null;
    // The document reflows to the pane width: a resize re-renders it rather
    // than clipping an earlier, wider layout.
    if (entry && entry.status === 'ready' && entry.width !== rightWidth) {
      renderLines(entry, entry.text, rightWidth);
    }
    clampScroll();
    const totalLines = entry && entry.status === 'ready' ? entry.lines.length : 0;
    const border = (text) => paint(theme, 'border', text);
    const divider = border('│');
    const lines = [];
    const topLeft = `${border('╭─')} ${paint(theme, 'accent', title)} `;
    // S27: no top-right `esc` text (the /changes frame has none) — the corner
    // and the right border stay in the terminal's last cell.
    const topRight = border('─╮');
    lines.push(`${topLeft}${border('─'.repeat(Math.max(0, w - measure(helpers, topLeft) - measure(helpers, topRight))))}${topRight}`);

    // S13/S26: one row carries the search widget and nothing else — the query
    // plus the scroll position at its right edge. S4: the key that opens the
    // box lives in the footer now, never in this row.
    const searchText = state.searching
      ? `› ${state.query}█`
      : (state.query ? `› ${state.query}` : '› Search');
    const listState = listPageState();
    // The right edge reports where the reader is: the list page when the list
    // needs more than one page, and the reading position of an open document.
    const marks = [];
    if (listState.pageCount > 1) marks.push(`${state.listPage}/${listState.pageCount}`);
    if (totalLines > 0) {
      marks.push(`${Math.min(state.scroll + 1, totalLines)}-${Math.min(totalLines, state.scroll + bodyRows)}/${totalLines}`);
    }
    const searchCell = withRight(helpers, searchText, marks.join(' · '), inner);
    lines.push(`${border('│')} ${pad(helpers, state.searching ? paint(theme, 'accent', searchCell) : searchCell, inner)} ${border('│')}`);

    const listLines = [];
    if (docs.length === 0) {
      listLines.push(paint(theme, 'muted', EMPTY_LIST));
      listLines.push(paint(theme, 'dim', EMPTY_HINT));
    } else if (list.length === 0) {
      listLines.push(paint(theme, 'muted', '(no matches)'));
    } else {
      // S3/S5: each name wraps over the rows it needs and the page carries the
      // documents whose wrapped rows fit the body budget.
      const page = listState.current;
      for (let at = page.start; at < page.end; at += 1) {
        const focused = at === state.index;
        const rows = layout.wrapLabel(helpers, String((list[at] && list[at].name) || ''), listWidth, { first: focused ? '▸ ' : '  ' });
        for (const row of rows) {
          listLines.push(highlight(theme, pad(helpers, row, listWidth), focused));
        }
      }
    }
    const contentLines = [];
    if (!docEntry) {
      if (docs.length === 0) {
        contentLines.push(paint(theme, 'muted', EMPTY_LIST));
        contentLines.push(paint(theme, 'dim', EMPTY_HINT));
      } else {
        contentLines.push(paint(theme, 'muted', `(no matches for filter "${state.query}")`));
      }
    } else if (entry.status === 'error') {
      contentLines.push(paint(theme, 'error', `unreadable: ${entry.error}`));
    } else if (entry.status === 'ready' && entry.lines.length === 0) {
      contentLines.push(paint(theme, 'muted', '(empty document)'));
    } else if (entry.status === 'ready') {
      contentLines.push(...entry.lines.slice(state.scroll, state.scroll + bodyRows));
    } else {
      contentLines.push(paint(theme, 'muted', 'loading…'));
    }
    // A failed open is shown, never claimed as success: the error rides
    // above the document so the untouched selection it explains stays visible.
    if (openError) {
      contentLines.unshift(paint(theme, 'error', `open failed: ${openError}`));
    }
    for (let row = 0; row < bodyRows; row += 1) {
      const left = pad(helpers, listLines[row] ?? '', listWidth);
      const right = pad(helpers, contentLines[row] ?? '', rightWidth);
      lines.push(`${border('│')} ${left} ${divider} ${right} ${border('│')}`);
    }
    lines.push(`${border('│')} ${paint(theme, 'muted', pad(helpers, legendText(helpers, state.searching ? SEARCH_KEYS : CONTENT_KEYS, inner), inner))} ${border('│')}`);
    lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
    return lines.map((line) => pad(helpers, line, w));
  }

  function selectNext(step) {
    const list = shown();
    if (list.length === 0) return;
    state.index = (state.index + step + list.length) % list.length;
    state.scroll = 0;
    ensureEntry(current());
    repaint();
  }

  // The `T`/`/` name filter (key-consistency K3/S5, same behaviour as
  // the wizard's search box and the issues viewer): typing narrows the
  // list live, Backspace edits, Enter/Esc leaves the box with the filter
  // kept. Anything else is ignored while filtering.
  function handleSearchInput(data) {
    if (keyMatches(helpers, data, ['enter', 'return'])) {
      state.searching = false;
      state.index = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.searching = false;
      state.index = 0;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      state.query = state.query.slice(0, -1);
      state.index = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    // S4: Delete clears the WHOLE query while the search input is active;
    // Backspace above keeps deleting one character. The box stays open so a
    // new query needs no extra keypress.
    if (keyMatches(helpers, data, ['delete'])) {
      state.query = '';
      state.index = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    const typed = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
    if (typeof typed === 'string' && [...typed].length === 1) {
      state.query += typed;
      state.index = 0;
      state.scroll = 0;
      repaint();
      return true;
    }
    return false;
  }

  function handleInput(data) {
    if (isKeyRelease(helpers, data)) return;
    // The wheel can also arrive as raw SGR/X10 bytes on hosts that do not
    // dispatch mouse events: both paths scroll the preview, never the list.
    const wheel = wheelDeltaFromInput(data);
    if (wheel !== undefined) {
      scrollBy(wheel);
      return;
    }
    // While filtering, only the search keys answer: Enter/Esc leaves the
    // box with the filter kept, typing narrows live. Everything else —
    // arrows, toggles, `o` — is ignored until the box is left.
    if (state.searching) {
      if (handleSearchInput(data)) return;
      return;
    }
    if (keyMatches(helpers, data, ['escape', 'ctrl+c', 'q'])) {
      if (typeof done === 'function') done(null);
      return;
    }
    // `T` or `/` opens the name filter on the current query, for editing.
    if (keyMatches(helpers, data, ['T', '/'])) {
      state.searching = true;
      repaint();
      return;
    }
    // `o` opens the focused document outside Pi through $VISUAL/$EDITOR:
    // the injected opener reports honestly, so a missing editor or a
    // failed spawn shows its error instead of failing silently.
    if (keyMatches(helpers, data, ['o'])) {
      const focused = current();
      if (!focused) return;
      if (typeof openExternal !== 'function') {
        openError = 'the viewer has no external opener';
        repaint();
        return;
      }
      const target = (typeof focused.path === 'string' && focused.path.length > 0)
        ? focused.path
        : focused.name;
      let result = null;
      try {
        result = openExternal(target);
      } catch (err) {
        result = { ok: false, error: (err && err.message) || 'open failed' };
      }
      Promise.resolve(result).then((settled) => {
        if (settled && settled.ok === true) openError = null;
        else openError = (settled && settled.error) || 'open failed';
        repaint();
      }).catch((err) => {
        openError = (err && err.message) || 'open failed';
        repaint();
      });
      return;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      selectNext(1);
      return;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      selectNext(-1);
      return;
    }
    // D3: left/right page the ACTIVE list and nothing else; Tab never pages a
    // single-dataset reader.
    if (keyMatches(helpers, data, ['right', ']'])) {
      pageList(1);
      return;
    }
    if (keyMatches(helpers, data, ['left', '['])) {
      pageList(-1);
      return;
    }
    const page = Math.max(1, bodyRows - 1);
    if (keyMatches(helpers, data, ['ctrl+j', 'pagedown'])) {
      state.scroll += page;
      clampScroll();
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['ctrl+k', 'pageup'])) {
      state.scroll -= page;
      clampScroll();
      repaint();
      return;
    }
    const halfPage = Math.max(1, Math.floor(page / 2));
    if (keyMatches(helpers, data, HALF_PAGE_DOWN)) {
      scrollBy(halfPage);
      return;
    }
    if (keyMatches(helpers, data, HALF_PAGE_UP)) {
      scrollBy(-halfPage);
      return;
    }
    if (keyMatches(helpers, data, ['end'])) {
      state.scroll = Number.MAX_SAFE_INTEGER;
      clampScroll();
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['home'])) {
      state.scroll = 0;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['r'])) {
      if (typeof reloadDocs !== 'function') return;
      let result = null;
      try {
        result = reloadDocs();
      } catch {
        return;
      }
      Promise.resolve(result).then((next) => {
        if (!next || next.ok !== true || !Array.isArray(next.docs)) return;
        docs = next.docs.slice();
        entries.clear();
        // The filter survives a reload: clamp the selection into the
        // still-visible list, exactly like the issues viewer keeps its query.
        if (state.index >= shown().length) state.index = Math.max(0, shown().length - 1);
        state.scroll = 0;
        ensureEntry(current());
        repaint();
      }).catch(() => {});
    }
  }

  function invalidate() {}

  // The selected document starts loading as soon as the view exists, so the
  // first frame the host paints already carries content instead of a
  // placeholder.
  ensureEntry(current());

  return { render, handleInput, invalidate, handleMouse, state };
}

module.exports = { createOddView, CONTENT_KEYS, SEARCH_KEYS, EMPTY_LIST, EMPTY_HINT };
