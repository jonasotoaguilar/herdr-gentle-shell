'use strict';
// Odd viewer component (odd-viewer S3,S4,S6 plus the S7/S8 assignment
// field: per-row assignment marks, `space` to toggle locally, `ctrl+s` to
// persist through the injected saveAssignment callback, `esc` to discard).
//
// The host component contract Pi asks for (the same shape the customize
// panel uses in extensions/gentle-worktree-tools.ts): the factory returns
// { render(width), handleInput(data), invalidate() }. Selection and scroll
// are LOCAL state: no key writes, notifies or reloads, and `esc` finishes
// through done(null). The assignment is LOCAL too until `ctrl+s`: `space`
// only flips the pending set, and the stored marks change only after the
// save callback reports {ok:true} — a failed save keeps every pending
// mark and surfaces the error instead.
//
// The host component contract Pi asks for (the same shape the customize
// panel uses in extensions/gentle-worktree-tools.ts): the factory returns
// { render(width), handleInput(data), invalidate() }. Selection and scroll
// are LOCAL state: no key writes, notifies or reloads, and `esc` finishes
// through done(null). The host repaints when requestRender() is called.
//
// The TUI helpers arrive injected (visibleWidth/truncateToWidth/matchesKey/
// isKeyRelease) because @earendil-works/pi-tui is a lazily imported peer of
// this package: the command loads it and passes it down, and the fallbacks
// below keep the view rendering when a host provides none. Layout follows
// the reference Changes view: a framed two-pane card, list on the left,
// document on the right, keys on the last content row.

const { renderOddMarkdown, stripAnsi } = require('./odd-markdown.js');

const CARD_PADDING = 4;
const LIST_MAX_WIDTH = 34;
const LIST_RATIO = 0.32;
const MIN_WIDTH = 24;
const EMPTY_LIST = 'no odd documents';
const EMPTY_HINT = 'create one under odd/tasks/';
const CONTENT_KEYS = '↑↓ select · space toggle · ctrl+j/k scroll · r reload · ctrl+s · esc close';

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
      // A throwing matcher never matches; the string fallback decides below.
    }
  }
  const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  const lower = String(text).toLowerCase();
  return names.some((name) => lower === String(name).toLowerCase());
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
    saveAssignment = null,
    checkoutName = '',
  } = options;
  let docs = Array.isArray(options.docs) ? options.docs.slice() : [];
  const entries = new Map();
  const state = { index: 0, scroll: 0 };
  let bodyRows = 1;

  // Assignment state (S8): the registry stores `odd[]` names shaped
  // `odd/tasks/<file>`; each listed document maps to exactly one such
  // key. `storedSet` is what the checkout has saved, `desiredSet` is
  // what the rows currently show — they differ only while toggles are
  // pending. A non-array assignment (unreadable registry) fails soft to
  // nothing stored, never to a broken view.
  function oddKeyOf(docEntry) {
    const file = docEntry && typeof docEntry.file === 'string' && docEntry.file.length > 0
      ? docEntry.file
      : `${(docEntry && docEntry.name) || ''}.md`;
    return `odd/tasks/${file}`;
  }

  function storedKeysFor(list, listed) {
    const names = Array.isArray(list) ? list.filter((name) => typeof name === 'string') : [];
    const exact = new Set(names);
    const keys = new Set();
    for (const docEntry of listed) {
      const key = oddKeyOf(docEntry);
      if (exact.has(key)) {
        keys.add(key);
        continue;
      }
      const base = docEntry && docEntry.file;
      for (const name of names) {
        if (String(name).split('/').pop() === base) {
          keys.add(key);
          break;
        }
      }
    }
    return keys;
  }

  let storedSet = storedKeysFor(options.assigned, docs);
  let desiredSet = new Set(storedSet);
  let saveError = null;

  function hasPendingAssignment() {
    if (storedSet.size !== desiredSet.size) return true;
    for (const key of desiredSet) {
      if (!storedSet.has(key)) return true;
    }
    return false;
  }

  // S8 marks: ✓ stored, · not assigned, ✎ unsaved change on that row.
  function markFor(docEntry) {
    const key = oddKeyOf(docEntry);
    const wanted = desiredSet.has(key);
    const stored = storedSet.has(key);
    if (wanted !== stored) return '✎';
    return stored ? '✓' : '·';
  }

  function titleText() {
    const checkout = typeof checkoutName === 'string' && checkoutName.length > 0 ? checkoutName : '';
    let title = `✎ Odd · ${docs.length} documents`;
    if (checkout) title += ` · ${checkout}`;
    title += ` · ${desiredSet.size} assigned`;
    if (hasPendingAssignment()) title += ' · unsaved';
    return title;
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
    return docs[state.index] || null;
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

  function render(width) {
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    const title = titleText();
    if (w < MIN_WIDTH || height < 4) {
      return [pad(helpers, fit(helpers, `${title} — enlarge the terminal`, w), w)].slice(0, Math.max(1, Math.min(height, 1)));
    }
    if (state.index >= docs.length) state.index = Math.max(0, docs.length - 1);
    const inner = Math.max(1, w - CARD_PADDING - 2);
    const listWidth = Math.min(LIST_MAX_WIDTH, Math.max(12, Math.floor(inner * LIST_RATIO)));
    const rightWidth = Math.max(1, inner - listWidth - 3);
    bodyRows = Math.max(1, height - 3);
    const docEntry = current();
    const entry = docEntry ? ensureEntry(docEntry) : null;
    // The document reflows to the pane width: a resize re-renders it rather
    // than clipping an earlier, wider layout.
    if (entry && entry.status === 'ready' && entry.width !== rightWidth) {
      renderLines(entry, entry.text, rightWidth);
    }
    clampScroll();
    const total = entry && entry.status === 'ready' ? entry.lines.length : 0;
    const position = total === 0 ? '' : ` · ${Math.min(state.scroll + 1, total)}-${Math.min(total, state.scroll + bodyRows)}/${total}`;
    const header = `${title}${docEntry ? ` · ${docEntry.name}` : ''}${position}`;
    const border = (text) => paint(theme, 'border', text);
    const divider = border('│');
    const topLeft = `${border('╭─')} ${paint(theme, 'accent', header)} `;
    const topRight = `${paint(theme, 'muted', 'esc')} ${border('─╮')}`;
    const fill = Math.max(0, w - measure(helpers, topLeft) - measure(helpers, topRight));
    const lines = [`${topLeft}${border('─'.repeat(fill))}${topRight}`];
    const listLines = [];
    if (docs.length === 0) {
      listLines.push(paint(theme, 'muted', EMPTY_LIST));
      listLines.push(paint(theme, 'dim', EMPTY_HINT));
    } else {
      for (let at = 0; at < docs.length; at += 1) {
        const focused = at === state.index;
        listLines.push(highlight(theme, pad(helpers, `${focused ? '▸ ' : '  '}${markFor(docs[at])} ${docs[at].name}`, listWidth), focused));
      }
    }
    const contentLines = [];
    if (!docEntry) {
      contentLines.push(paint(theme, 'muted', EMPTY_LIST));
      contentLines.push(paint(theme, 'dim', EMPTY_HINT));
    } else if (entry.status === 'error') {
      contentLines.push(paint(theme, 'error', `unreadable: ${entry.error}`));
    } else if (entry.status === 'ready' && entry.lines.length === 0) {
      contentLines.push(paint(theme, 'muted', '(empty document)'));
    } else if (entry.status === 'ready') {
      contentLines.push(...entry.lines.slice(state.scroll, state.scroll + bodyRows));
    } else {
      contentLines.push(paint(theme, 'muted', 'loading…'));
    }
    // A failed save is shown, never claimed as success: the error rides
    // above the document so the pending ✎ marks it explains stay visible.
    if (saveError) {
      contentLines.unshift(paint(theme, 'error', `save failed: ${saveError}`));
    }
    for (let row = 0; row < bodyRows; row += 1) {
      const left = pad(helpers, listLines[row] ?? '', listWidth);
      const right = pad(helpers, contentLines[row] ?? '', rightWidth);
      lines.push(`${border('│')} ${left} ${divider} ${right} ${border('│')}`);
    }
    lines.push(`${border('│')} ${paint(theme, 'muted', pad(helpers, CONTENT_KEYS, inner))} ${border('│')}`);
    lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
    return lines.map((line) => pad(helpers, line, w));
  }

  function selectNext(step) {
    if (docs.length === 0) return;
    state.index = (state.index + step + docs.length) % docs.length;
    state.scroll = 0;
    ensureEntry(current());
    repaint();
  }

  function handleInput(data) {
    if (isKeyRelease(helpers, data)) return;
    if (keyMatches(helpers, data, ['escape', 'ctrl+c', 'q'])) {
      // Discard: the pending toggles die with the view, nothing is saved.
      if (typeof done === 'function') done(null);
      return;
    }
    // `space` toggles locally only — the registry is untouched until
    // `ctrl+s` below.
    if (keyMatches(helpers, data, ['space', ' '])) {
      const focused = current();
      if (!focused) return;
      const key = oddKeyOf(focused);
      if (desiredSet.has(key)) desiredSet.delete(key);
      else desiredSet.add(key);
      repaint();
      return;
    }
    // `ctrl+s` persists the whole pending set through the registry: the
    // stored marks change only when the callback reports {ok:true}, so a
    // refusal keeps every ✎ and shows its error instead.
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      if (typeof saveAssignment !== 'function') return;
      if (!hasPendingAssignment()) return;
      const names = [...desiredSet].sort();
      let result = null;
      try {
        result = saveAssignment(names);
      } catch (err) {
        result = { ok: false, error: (err && err.message) || 'save failed' };
      }
      Promise.resolve(result).then((settled) => {
        if (settled && settled.ok === true) {
          storedSet = new Set(desiredSet);
          saveError = null;
        } else {
          saveError = (settled && settled.error) || 'save failed';
        }
        repaint();
      }).catch((err) => {
        saveError = (err && err.message) || 'save failed';
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
        if (state.index >= docs.length) state.index = Math.max(0, docs.length - 1);
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

  return { render, handleInput, invalidate, state };
}

module.exports = { createOddView, CONTENT_KEYS, EMPTY_LIST, EMPTY_HINT };
