'use strict';
// Issues viewer component (issues-view S2-S5,S8,S17-S19): a framed
// full-screen three-bucket overlay (My issues / Assigned / Involved) with a
// live search box, a paginated list, and a scrolling issue pane (labels,
// state, author, dates, reactions, separated comments).
//
// PURE: no `gh`, no registry, no files. Listing rows arrive either eagerly
// as `pages` / `issues` (unchanged legacy path) or lazily through
// `loadPages({state})`, the detail arrives through `loadIssue(number)`, repo
// labels through `loadLabels()` on the editor's first use, and writes go
// through `actions.{editLabels,postComment,setState}` — every failure is
// shown and keeps the local state unchanged. Same host contract as
// lib/odd-view.js: { render(width), handleInput(data), invalidate() } plus
// `state`.
//
// S10b: the view is read-only with respect to the checkout↔issue
// association. The `assigned`, `saveAssignment` and `assignmentEnabled`
// options the existing callers still pass are accepted and ignored — no
// mark, no toggle, no save — and the association lives in the worktree
// detail instead.
//
// S19: the loader seam is what lets a host open this view immediately and
// paint an honest loading state instead of awaiting every network read. The
// S18 corrections live here too, and S10a narrows them: the view lists OPEN
// issues only, so every read asks for `open` — there is no closed state, no
// toggle and no combined view — and each tab names the count of open issues
// it actually lists.

const CARD_PADDING = 4;
const LIST_MAX_WIDTH = 36;
const LIST_RATIO = 0.34;
const MIN_WIDTH = 24;
const DEFAULT_PAGE_SIZE = 8;
// S17: no `? help` — the footer legend is the only key reference. Its contents
// stay fixed (S10b: no assignment key rides it) and S13 keeps it free of
// repetition: the search key lives on the search row and the state toggle is
// gone (S10a), so neither is named twice. S2: it is ONE terminal row — `text`
// is the full token, `short` the compact form used when the full one does not
// fit, and `priority` decides what a still-too-wide legend drops first (lowest
// first), so `esc close` outlives every other hint.
const FOOTER_KEYS = [
  { text: '↑↓ move', short: '↑↓ move', priority: 90 },
  { text: 'tab page', short: 'tab', priority: 60 },
  { text: 'L labels', short: 'L', priority: 50 },
  { text: 'c comment', short: 'c', priority: 45 },
  { text: 'x/X close', short: 'x/X', priority: 40 },
  { text: 'o web', short: 'o', priority: 20 },
  { text: 'y/Y copy', short: 'y/Y', priority: 30 },
  { text: 'esc close', short: 'esc close', priority: 100 },
];

// S13: while the search box holds the keyboard, the footer names THAT
// interaction once — enter and esc each keep the filter — instead of the box
// and the footer both spelling the same keys out. `enter/esc keep` is a single
// token so the two keys never inflate the ONE legend row (S2).
const SEARCH_KEYS = [
  { text: 'type to filter', short: 'type', priority: 30 },
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

// One page entry, whatever the source: eagerly supplied `pages` and every
// `loadPages`/`reload` result pass through here so both paths share one shape.
function mapPage(page, at) {
  return {
    id: page && page.id != null ? String(page.id) : `p${at}`,
    label: page && page.label ? String(page.label) : `Page ${at + 1}`,
    issues: Array.isArray(page && page.issues) ? page.issues.slice() : null,
    total: page && Number.isFinite(Number(page.total)) ? Number(page.total) : null,
    truncated: !!(page && page.truncated),
  };
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

function measure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') {
      const size = Number(helpers.visibleWidth(text));
      if (Number.isFinite(size)) return size;
    }
  } catch {
    // Fall through to the plain count.
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

// S2: a key legend stays on ONE row. The full text is used while it fits;
// otherwise the legend compacts to its short tokens and then drops its
// lowest-priority keys (display order never changes, and no token carries a
// newline), so it never wraps onto a second row. The caller still pads, which
// keeps the row cell-exact if a single token is wider than the card.
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
      // A throwing matcher never matches; the string fallback decides below.
    }
  }
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

function labelName(label) {
  if (typeof label === 'string') return label;
  if (label && typeof label.name === 'string') return label.name;
  return '';
}

function assigneeName(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry.login === 'string') return entry.login;
  return '';
}

function relativeTime(iso) {
  const when = Date.parse(iso);
  if (!Number.isFinite(when)) return 'unknown time';
  const diff = Date.now() - when;
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  // Past a month the reference's spirit wins over the old ISO fallback:
  // whole months, then whole years, keeping the existing `ago` suffix.
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function wrapText(text, width) {
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph.trim() === '') {
      out.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      if (line === '') {
        line = word.length > width ? word.slice(0, width) : word;
      } else if ((line + ' ' + word).length <= width) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word.length > width ? word.slice(0, width) : word;
      }
    }
    out.push(line);
  }
  return out.length === 0 ? [''] : out;
}

function matchesQuery(row, query) {
  const tokens = String(query || '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return true;
  const title = String(row.title || '').toLowerCase();
  const author = String(row.author || '').toLowerCase();
  const number = String(row.number ?? '');
  return tokens.every((token) => {
    if (token.startsWith('@')) {
      const want = token.slice(1).toLowerCase();
      return want === '' || author.includes(want);
    }
    if (token.startsWith('#')) {
      const want = token.slice(1);
      return want === '' || number.includes(want);
    }
    return title.includes(token.toLowerCase());
  });
}

function normalizeDetail(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'issue unreadable' };
  if (result.ok === true && result.issue && typeof result.issue === 'object') {
    return { ok: true, issue: result.issue, comments: Array.isArray(result.comments) ? result.comments : [] };
  }
  if (result.ok === false) return { ok: false, error: String(result.error || 'issue unreadable') };
  return { ok: false, error: 'issue unreadable' };
}

function createIssuesView(options = {}) {
  const {
    helpers = null,
    theme = null,
    rowsAvailable = null,
    requestRender = null,
    done = null,
    loadIssue = null,
    loadPages = null,
    loadLabels = null,
    actions = {},
  } = options;

  // S25: the header repeats neither the branch nor the worktree ("solo data
  // relevante y lo mas abreviada posible"); `options.checkoutName` is still
  // accepted for compatibility and deliberately never rendered.

  // Loader mode: the caller fetches issues for the filter the viewer asks
  // for. Eager mode keeps the previous contract intact for callers that
  // already hand over `pages`.
  const loadPageFn = typeof loadPages === 'function' ? loadPages : null;
  const loaderMode = loadPageFn !== null;

  // S10b: `options.assigned`, `options.saveAssignment` and
  // `options.assignmentEnabled` are deliberately not read: the association
  // belongs to the worktree detail, and this view stays read-only.

  let pages = Array.isArray(options.pages) && options.pages.length > 0
    ? options.pages.map(mapPage)
    : (loaderMode ? [] : [{ id: 'mine', label: 'My issues', issues: null, total: null }]);
  let fallbackIssues = Array.isArray(options.issues) ? options.issues.slice() : [];
  let repoLabels = Array.isArray(options.labels)
    ? options.labels.map((label) => ({ name: labelName(label) })).filter((label) => label.name)
    : [];

  const state = {
    page: 0,
    index: 0,
    listPage: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    scroll: 0,
    query: '',
    searching: false,
    mode: 'list',
    loading: loaderMode,
    loadError: null,
    labelIndex: 0,
    labelCreating: false,
    createName: '',
    commentText: '',
    confirm: null,
    discardAsk: false,
  };
  let bodyRows = 1;

  const details = new Map();
  let actionError = null;
  // Only the newest page request may apply its result (S18/S19: a slow answer
  // must never overwrite a newer one), and a closed view repaints nothing.
  let active = true;
  let pagesSeq = 0;
  let labelsLoaded = false;
  let labelsLoading = false;
  let labelsError = null;

  const numOf = (row) => (row && row.number != null ? Number(row.number) : NaN);

  // Copy feedback: a success notice or an honest miss. The writer resolves
  // from an injected seam (options, then actions) with lib/clipboard.js as
  // the default, so the shipped path needs no extra wiring.
  let notice = null;
  function defaultCopyText(text) {
    try {
      const clipboard = require('./clipboard.js');
      if (clipboard && typeof clipboard.writeText === 'function') return clipboard.writeText(text);
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'clipboard unavailable' };
    }
    return { ok: false, error: 'clipboard unavailable' };
  }
  const copyText = typeof options.copyText === 'function'
    ? options.copyText
    : (actions && typeof actions.copyText === 'function' ? actions.copyText : defaultCopyText);

  // `y`/`Y` copy (S6/K4): the number as bare digits (the reference copies
  // `fmt.Sprint(number)`), the URL from the already-loaded issue — never
  // a new fetch. Success and miss both say so in the open.
  function doCopy(kind) {
    const row = selected();
    if (!row) return;
    const number = numOf(row);
    if (!Number.isFinite(number)) return;
    const entry = ensureDetail(row);
    const detail = (entry && entry.status === 'ready' && entry.issue) || row;
    const text = kind === 'url' ? String(detail.url || row.url || '') : String(number);
    if (text === '') {
      actionError = kind === 'url' ? 'nothing to copy: this issue has no URL' : 'nothing to copy';
      notice = null;
      repaint();
      return;
    }
    let result = null;
    try {
      result = copyText(text);
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'copy failed' };
    }
    settleAsync(result, () => {
      notice = `Copied ${text} to clipboard`;
      actionError = null;
      repaint();
    }, (error) => {
      notice = null;
      actionError = `clipboard unavailable \u2014 nothing copied (${error})`;
      repaint();
    });
  }

  function baseIssues() {
    const current = pages[state.page];
    if (current && Array.isArray(current.issues)) return current.issues;
    return fallbackIssues;
  }

  function filteredIssues() {
    // S10a: open issues only. The row's own state decides, so a page that
    // arrives with a closed row never lists it, whatever the fetch claimed.
    return baseIssues().filter((row) => rowState(row) === 'open' && matchesQuery(row, state.query));
  }

  function pageCount() {
    const total = filteredIssues().length;
    return Math.max(1, Math.ceil(total / Math.max(1, state.pageSize)));
  }

  function clampSelection() {
    const total = filteredIssues().length;
    if (state.index >= total) state.index = Math.max(0, total - 1);
    if (state.index < 0) state.index = 0;
    const want = total === 0 ? 1 : Math.floor(state.index / Math.max(1, state.pageSize)) + 1;
    state.listPage = Math.min(Math.max(1, state.listPage), pageCount());
    if (total > 0) state.listPage = Math.min(Math.max(1, want), pageCount());
  }

  function selected() {
    const list = filteredIssues();
    return list[state.index] || null;
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
    if (!active) return;
    try {
      if (typeof requestRender === 'function') requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  // `done` ends the overlay; nothing repaints after it, so an in-flight
  // fetch that lands later cannot paint into a closed view.
  function close() {
    active = false;
    if (typeof done === 'function') done(null);
  }

  // The state `gh` is asked for: always open (S10a). Exactly one state, never
  // a combined all.
  const PAGE_STATE = 'open';

  // The state of one row, with `gh`'s absent state read as open.
  function rowState(row) {
    return String((row && row.state) || 'open');
  }

  function normalizePagesResult(result) {
    if (!result || typeof result !== 'object') return { ok: false, error: 'issues could not be loaded' };
    if (result.ok === false) {
      return { ok: false, error: String(result.error || result.loadError || 'issues could not be loaded') };
    }
    const partial = typeof result.loadError === 'string' && result.loadError !== '' ? result.loadError : null;
    if (Array.isArray(result.pages)) return { ok: true, pages: result.pages, loadError: partial };
    if (Array.isArray(result.issues)) {
      return { ok: true, issues: result.issues, total: result.total, truncated: result.truncated, loadError: partial };
    }
    return { ok: false, error: 'issues could not be loaded: unexpected result' };
  }

  function applyLoadedPages(settled) {
    if (Array.isArray(settled.issues)) {
      fallbackIssues = settled.issues.slice();
      const current = pages[state.page];
      if (current) {
        current.issues = settled.issues.slice();
        if (settled.total != null && Number.isFinite(Number(settled.total))) current.total = Number(settled.total);
        if (settled.truncated != null) current.truncated = settled.truncated === true;
      }
    }
    if (Array.isArray(settled.pages)) pages = settled.pages.map(mapPage);
    if (state.page >= pages.length) state.page = Math.max(0, pages.length - 1);
    details.clear();
    state.index = 0;
    state.listPage = 1;
    state.scroll = 0;
    actionError = null;
    ensureDetail(selected());
  }

  // One page request through the given seam. The loader is called with
  // `{state}`; its stale answer is dropped, not rendered.
  function requestPages(source) {
    if (typeof source !== 'function') return;
    const seq = ++pagesSeq;
    state.loading = true;
    repaint();
    let pending = null;
    try {
      pending = source({ state: PAGE_STATE });
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'issues could not be loaded' };
    }
    const settle = (result) => {
      if (seq !== pagesSeq || !active) return;
      state.loading = false;
      const normalized = normalizePagesResult(result);
      if (!normalized.ok) {
        state.loadError = normalized.error;
        repaint();
        return;
      }
      state.loadError = normalized.loadError;
      applyLoadedPages(normalized);
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'issues could not be loaded' });
    });
  }

  // Repo labels load on the label editor's FIRST use (S19): opening the
  // view never waits on them. A failure stays retryable on the next open.
  function requestLabels() {
    if (typeof loadLabels !== 'function' || labelsLoaded || labelsLoading) return;
    labelsLoading = true;
    labelsError = null;
    repaint();
    let pending = null;
    try {
      pending = loadLabels();
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'labels unreadable' };
    }
    const settle = (result) => {
      labelsLoading = false;
      if (result && result.ok === true && Array.isArray(result.labels)) {
        repoLabels = result.labels.map((label) => ({ name: labelName(label) })).filter((label) => label.name);
        labelsLoaded = true;
        labelsError = null;
      } else {
        labelsError = (result && (result.error || result.loadError)) || 'labels unreadable';
      }
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'labels unreadable' });
    });
  }

  // S10a: a tab names the OPEN issues it lists. A page's own reported total
  // describes the list exactly while every row it carries is open — a closed
  // row means that total counts issues this view never shows, so the count
  // falls back to the open rows actually listed.
  function tabCount(page) {
    const rows = Array.isArray(page.issues) ? page.issues : null;
    const open = rows ? rows.filter((row) => rowState(row) === 'open') : null;
    const honorsState = !rows || open.length === rows.length;
    if (page.total != null && honorsState) return `${page.total}${page.truncated ? '+' : ''}`;
    const count = open ? open.length : fallbackIssues.filter((row) => rowState(row) === 'open').length;
    return `${count}${page.truncated ? '+' : ''}`;
  }

  function titleText() {
    // S13: the surface alone. The active bucket is named by its own tab right
    // below, so the header never repeats it — and it names no checkout either.
    return '◈ Issues';
  }

  function ensureDetail(row) {
    if (!row || !Number.isFinite(numOf(row))) return null;
    const number = numOf(row);
    let entry = details.get(number);
    if (entry) return entry;
    entry = { status: 'loading', issue: row, comments: [], lines: [], error: null };
    details.set(number, entry);
    if (typeof loadIssue !== 'function') {
      entry.status = 'ready';
      entry.issue = row;
      return entry;
    }
    let pending = null;
    try {
      pending = loadIssue(number);
    } catch (err) {
      entry.status = 'error';
      entry.error = (err && err.message) || 'issue unreadable';
      return entry;
    }
    const settle = (result) => {
      const normalized = normalizeDetail(result);
      if (normalized.ok) {
        entry.status = 'ready';
        entry.issue = normalized.issue;
        entry.comments = normalized.comments;
      } else {
        entry.status = 'error';
        entry.error = normalized.error;
      }
      repaint();
    };
    if (pending && typeof pending.then === 'function') {
      pending.then(settle).catch((err) => {
        entry.status = 'error';
        entry.error = (err && err.message) || 'issue unreadable';
        repaint();
      });
    } else {
      settle(pending);
    }
    return entry;
  }

  function detailLines(row, width) {
    const entry = ensureDetail(row);
    if (!entry) return [paint(theme, 'muted', '(no issue selected)')];
    if (entry.status === 'error') return [paint(theme, 'error', `unreadable: ${entry.error}`)];
    if (entry.status !== 'ready') return [paint(theme, 'muted', 'loading…')];
    const detail = entry.issue || row;
    const comments = entry.status === 'ready' ? entry.comments : [];
    const lines = [];
    lines.push(emphasize(theme, `#${detail.number} ${detail.title || '(no title)'}`));
    lines.push(paint(theme, detail.state === 'closed' ? 'muted' : 'accent', `[${detail.state || 'open'}]`));
    const names = (Array.isArray(detail.labels) ? detail.labels : []).map(labelName).filter(Boolean);
    lines.push(names.length > 0 ? `labels: ${names.join(', ')}` : paint(theme, 'muted', '(no labels)'));
    // Assignees render as one row, only when non-empty; the list rows
    // never carry them, so this changes no list shape.
    const assigneeNames = (Array.isArray(detail.assignees) ? detail.assignees : []).map(assigneeName).filter(Boolean);
    if (assigneeNames.length > 0) lines.push(`assignees: ${assigneeNames.join(', ')}`);
    lines.push(`by ${detail.author || 'unknown'} · created ${relativeTime(detail.createdAt)} · updated ${relativeTime(detail.updatedAt)}`);
    const plusOne = detail.reactions && Number.isFinite(Number(detail.reactions.plusOne)) ? Number(detail.reactions.plusOne) : 0;
    const stored = Number.isFinite(Number(detail.commentsCount)) ? Number(detail.commentsCount) : 0;
    const count = Math.max(stored, comments.length);
    lines.push(`👍 ${plusOne} · ${count} comments`);
    lines.push('');
    const out = [];
    for (const line of lines) out.push(...wrapText(line, width));
    out.push(...wrapText(detail.body || '(no description)', width));
    comments.forEach((comment, at) => {
      out.push('');
      out.push(paint(theme, 'border', `─ ${comment.author || 'unknown'} · ${relativeTime(comment.createdAt)} ─`));
      out.push(...wrapText(comment.body || '', width));
      if (at === comments.length - 1) out.push(paint(theme, 'dim', '(end of issue)'));
    });
    if (comments.length === 0) {
      out.push('');
      out.push(paint(theme, 'dim', '(end of issue)'));
    }
    return out;
  }

  function clampScroll(total) {
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
      return [pad(helpers, fit(helpers, `${title} — enlarge the terminal`, w), w)];
    }
    if (state.page >= pages.length) state.page = 0;
    clampSelection();
    // CARD_PADDING covers the frame's own `│ ` and ` │` cells, so this inner
    // width fills the terminal exactly: the right border belongs in the last
    // cell (S27 — no trailing slack, corners and edges stay aligned).
    const inner = Math.max(1, w - CARD_PADDING);
    const listWidth = Math.min(LIST_MAX_WIDTH, Math.max(14, Math.floor(inner * LIST_RATIO)));
    const rightWidth = Math.max(1, inner - listWidth - 3);
    bodyRows = Math.max(1, height - 6);
    const border = (text) => paint(theme, 'border', text);
    const divider = border('│');
    // S13: the legend names the interaction the keyboard is in — the search
    // keys while the box is open, the reading keys otherwise — on this ONE
    // row, and no hint is repeated on the row that already owns it.
    const footerCell = () => `${border('│')} ${paint(theme, 'muted', pad(helpers, legendText(helpers, state.searching ? SEARCH_KEYS : FOOTER_KEYS, inner), inner))} ${border('│')}`;
    const lines = [];
    const topLeft = `${border('╭─')} ${paint(theme, 'accent', title)} `;
    // S27: no top-right `esc` text (the /changes frame has none) — the corner
    // and the right border stay in the terminal's last cell.
    const topRight = border('─╮');
    lines.push(`${topLeft}${border('─'.repeat(Math.max(0, w - measure(helpers, topLeft) - measure(helpers, topRight))))}${topRight}`);
    // S26/S13: the search/filter widget owns the row directly below the title
    // and carries the query only — it is the single place `T` is named, and
    // the keys that leave the box are named once, by the footer.
    const searchText = state.searching
      ? `› ${state.query}█`
      : (state.query ? `› ${state.query} (T to edit)` : '› Search (T)');
    const searchRow = state.searching ? paint(theme, 'accent', searchText) : searchText;
    const searchLine = `${border('│')} ${pad(helpers, searchRow, inner)} ${border('│')}`;

    // The gh-unavailable and load-error states replace the panes, never with fake rows.
    const loadError = state.loadError || (options.loadError ? String(options.loadError) : null);
    if (options.ghAvailable === false) {
      lines.push(searchLine);
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'error', 'gh unavailable: install gh and authenticate to use /issues'), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }
    if (loadError && !state.loading && filteredIssues().length === 0) {
      lines.push(searchLine);
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'error', `failed to load issues: ${loadError}`), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }
    // First paint with the loader: name the wait instead of claiming 0 issues.
    if (state.loading && pages.length === 0) {
      lines.push(searchLine);
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'muted', 'loading issues…'), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }

    lines.push(searchLine);
    const tabs = pages.map((page, at) => {
      const label = `${at === state.page ? '▸ ' : ''}${page.label} (${tabCount(page)})`;
      return at === state.page ? emphasize(theme, label) : paint(theme, 'muted', label);
    }).join(paint(theme, 'border', ' │ '));
    lines.push(`${border('│')} ${pad(helpers, tabs, inner)} ${border('│')}`);

    // S26/S13: failures and notices share this visible row, so typing a query
    // never hides one — and it carries no state indicator and no repeated
    // count (S10a/S13).
    const errorNote = actionError ? paint(theme, 'error', actionError)
      : (loadError ? paint(theme, 'error', String(loadError)) : '');
    const note = errorNote || (notice ? paint(theme, 'accent', notice) : '')
      || (state.loading ? paint(theme, 'muted', 'loading…') : '');
    lines.push(`${border('│')} ${pad(helpers, note, inner)} ${border('│')}`);

    const list = filteredIssues();
    const focused = selected();
    if (focused) ensureDetail(focused);
    const size = Math.max(1, state.pageSize);
    const pagesTotal = pageCount();
    const start = (state.listPage - 1) * size;
    const slice = list.slice(start, start + size);
    const leftLines = slice.map((row) => {
      const at = list.indexOf(row);
      const isFocused = at === state.index;
      return highlight(theme, pad(helpers, `${isFocused ? '▸ ' : '  '}#${row.number} ${row.title || ''}`, listWidth), isFocused);
    });
    // S13: the tab above already names the issue total, so the list footer
    // names only the page position it moves through.
    leftLines.push(paint(theme, 'muted', `page ${state.listPage}/${pagesTotal}`));

    let rightSource;
    if (state.mode === 'labels') {
      rightSource = labelEditorLines(rightWidth);
    } else if (state.mode === 'comment') {
      rightSource = commentLines(rightWidth);
    } else if (state.mode === 'confirm') {
      rightSource = confirmLines(rightWidth);
    } else if (list.length === 0) {
      rightSource = state.query
        ? [paint(theme, 'muted', 'no issues match this filter')]
        : [paint(theme, 'muted', 'no issues'), paint(theme, 'dim', 'nothing to show on this page')];
    } else {
      rightSource = detailLines(focused, rightWidth);
    }
    clampScroll(rightSource.length);
    const visible = rightSource.slice(state.scroll, state.scroll + bodyRows);
    // Empty left rows (short last page) still paint full-width blank cells.
    for (let row = 0; row < bodyRows; row += 1) {
      const left = pad(helpers, leftLines[row] ?? '', listWidth);
      const right = pad(helpers, visible[row] ?? '', rightWidth);
      lines.push(`${border('│')} ${left} ${divider} ${right} ${border('│')}`);
    }
    lines.push(footerCell());
    lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
    return lines.map((line) => pad(helpers, line, w));
  }

  function currentLabelState() {
    const row = selected();
    const names = new Set((row && Array.isArray(row.labels) ? row.labels : []).map(labelName).filter(Boolean));
    return names;
  }

  // Label editor local state: toggles start from the row's labels; created
  // names are pending until ctrl+s applies them through editLabels.
  let labelDraft = null;
  function openLabelEditor() {
    const row = selected();
    if (!row) return;
    labelDraft = {
      number: numOf(row),
      selected: new Set(currentLabelState()),
      created: [],
      original: new Set(currentLabelState()),
    };
    state.mode = 'labels';
    state.labelIndex = 0;
    state.labelCreating = false;
    state.createName = '';
    actionError = null;
    state.scroll = 0;
    requestLabels();
    repaint();
  }

  function labelEditorLines(width) {
    const out = [emphasize(theme, 'Labels (space toggle · n new · ctrl+s apply · esc back)')];
    if (!labelDraft) return out;
    if (labelsLoading) {
      out.push(paint(theme, 'muted', 'loading labels…'));
      return out;
    }
    if (labelsError) out.push(paint(theme, 'error', `labels unreadable: ${labelsError}`));
    const rows = [...repoLabels.map((l) => l.name), '+ create new…'];
    rows.forEach((name, at) => {
      const isCreate = at === rows.length - 1;
      const on = !isCreate && labelDraft.selected.has(name);
      const cursor = at === state.labelIndex ? '▸ ' : '  ';
      if (isCreate && state.labelCreating) {
        out.push(...wrapText(`${cursor}new: ${state.createName}█ (enter add · esc cancel)`, width));
      } else {
        out.push(...wrapText(`${cursor}[${on ? 'x' : ' '}] ${name}`, width));
      }
    });
    if (labelDraft.created.length > 0) out.push(...wrapText(`new labels: ${labelDraft.created.join(', ')}`, width));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  function commentLines(width) {
    const out = [emphasize(theme, 'Leave a comment… (enter newline · ctrl+s post · esc discard)')];
    // The discard ask names what is at stake; the draft stays visible
    // below it until `y` throws it away.
    if (state.discardAsk) out.push(paint(theme, 'error', 'Discard this draft? (y discard · n/esc keep editing)'));
    out.push(...wrapText(state.commentText === '' ? '…' : state.commentText, width));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  function confirmLines(width) {
    const row = selected();
    const out = [emphasize(theme, `Confirm close #${row ? row.number : ''} (enter confirm · esc cancel)`)];
    out.push(...wrapText('This will close the issue on GitHub.', width));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  function moveSelection(step) {
    const total = filteredIssues().length;
    if (total === 0) return;
    state.index = (state.index + step + total) % total;
    state.scroll = 0;
    actionError = null;
    ensureDetail(selected());
    repaint();
  }

  function switchPage(step) {
    if (pages.length === 0) return;
    state.page = (state.page + step + pages.length) % pages.length;
    state.index = 0;
    state.listPage = 1;
    state.scroll = 0;
    state.searching = false;
    actionError = null;
    ensureDetail(selected());
    repaint();
  }

  function settleAsync(promise, onOk, onFail) {
    Promise.resolve(promise).then((result) => {
      if (result && result.ok === true) onOk(result);
      else onFail((result && result.error) || 'action failed');
    }).catch((err) => {
      onFail((err && err.message) || 'action failed');
    });
  }

  function applyLabels() {
    if (!labelDraft) return;
    const edit = actions && typeof actions.editLabels === 'function' ? actions.editLabels : null;
    if (typeof edit !== 'function') {
      actionError = 'label editing is unavailable';
      repaint();
      return;
    }
    const add = [...labelDraft.selected].filter((name) => !labelDraft.original.has(name));
    const remove = [...labelDraft.original].filter((name) => !labelDraft.selected.has(name));
    let result = null;
    try {
      result = edit(labelDraft.number, add, remove, labelDraft.created.slice());
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleAsync(result, () => {
      const row = selected();
      if (row) row.labels = [...labelDraft.selected].map((name) => ({ name }));
      const cached = details.get(labelDraft.number);
      if (cached && cached.issue) cached.issue = { ...cached.issue, labels: [...labelDraft.selected].map((name) => ({ name })) };
      labelDraft = null;
      state.mode = 'list';
      actionError = null;
      repaint();
    }, (error) => {
      actionError = error;
      repaint();
    });
  }

  function postComment() {
    const post = actions && typeof actions.postComment === 'function' ? actions.postComment : null;
    const row = selected();
    if (typeof post !== 'function' || !row) {
      actionError = 'commenting is unavailable';
      repaint();
      return;
    }
    const text = state.commentText;
    let result = null;
    try {
      result = post(numOf(row), text);
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleAsync(result, () => {
      state.mode = 'list';
      state.commentText = '';
      state.discardAsk = false;
      actionError = null;
      repaint();
    }, (error) => {
      actionError = error;
      repaint();
    });
  }

  function confirmState() {
    const setState = actions && typeof actions.setState === 'function' ? actions.setState : null;
    const row = selected();
    if (typeof setState !== 'function' || !row || state.confirm !== 'closed') {
      actionError = 'state change is unavailable';
      repaint();
      return;
    }
    let result = null;
    try {
      result = setState(numOf(row), 'closed');
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleAsync(result, () => {
      // S10a: the list is open-only, so a closed issue leaves it at once. The
      // row keeps its new state where it is stored, and the open-only filter
      // and every count follow it.
      row.state = 'closed';
      const cached = details.get(numOf(row));
      if (cached && cached.issue) cached.issue = { ...cached.issue, state: 'closed' };
      state.mode = 'list';
      state.confirm = null;
      actionError = null;
      clampSelection();
      repaint();
    }, (error) => {
      actionError = error;
      repaint();
    });
  }

  function handleSearchInput(data) {
    if (keyMatches(helpers, data, ['enter'])) {
      state.searching = false;
      state.index = 0;
      state.listPage = 1;
      state.scroll = 0;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.searching = false;
      state.index = 0;
      state.listPage = 1;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      state.query = state.query.slice(0, -1);
      state.index = 0;
      state.listPage = 1;
      repaint();
      return true;
    }
    if (typeof data === 'string' && data.length === 1) {
      state.query += data;
      state.index = 0;
      state.listPage = 1;
      repaint();
      return true;
    }
    return false;
  }

  function handleLabelInput(data) {
    // While the labels are in flight only the exit works: toggling against an
    // unknown list would guess.
    if (labelsLoading) {
      if (keyMatches(helpers, data, ['escape'])) {
        state.mode = 'list';
        labelDraft = null;
        actionError = null;
        repaint();
      }
      return true;
    }
    const names = repoLabels.map((l) => l.name);
    const rows = names.length + 1;
    if (state.labelCreating) {
      if (keyMatches(helpers, data, ['enter'])) {
        const name = state.createName.trim();
        if (name) {
          if (!names.includes(name) && !labelDraft.created.includes(name)) labelDraft.created.push(name);
          labelDraft.selected.add(name);
        }
        state.labelCreating = false;
        state.createName = '';
        repaint();
        return true;
      }
      if (keyMatches(helpers, data, ['escape'])) {
        state.labelCreating = false;
        state.createName = '';
        repaint();
        return true;
      }
      if (keyMatches(helpers, data, ['backspace'])) {
        state.createName = state.createName.slice(0, -1);
        repaint();
        return true;
      }
      if (typeof data === 'string' && data.length === 1) {
        state.createName += data;
        repaint();
        return true;
      }
      return true;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      applyLabels();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.mode = 'list';
      labelDraft = null;
      actionError = null;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      state.labelIndex = (state.labelIndex - 1 + rows) % rows;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      state.labelIndex = (state.labelIndex + 1) % rows;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['space', ' ', 'enter'])) {
      if (state.labelIndex === rows - 1) {
        state.labelCreating = true;
        state.createName = '';
      } else {
        const name = names[state.labelIndex];
        if (name) {
          if (labelDraft.selected.has(name)) labelDraft.selected.delete(name);
          else labelDraft.selected.add(name);
        }
      }
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['n'])) {
      state.labelCreating = true;
      state.createName = '';
      state.labelIndex = rows - 1;
      repaint();
      return true;
    }
    return false;
  }

  function handleCommentInput(data) {
    // Discarding a NON-EMPTY draft asks once: `y` throws it away,
    // `n`/`esc` return to editing with the text intact, `ctrl+s` still
    // posts. Any other key waits out the ask instead of guessing.
    if (state.discardAsk) {
      if (keyMatches(helpers, data, ['ctrl+s'])) {
        state.discardAsk = false;
        postComment();
        return true;
      }
      if (data === 'y' || (typeof data !== 'string' && keyMatches(helpers, data, ['y']))) {
        state.mode = 'list';
        state.commentText = '';
        state.discardAsk = false;
        actionError = null;
        repaint();
        return true;
      }
      if (keyMatches(helpers, data, ['n', 'escape'])) {
        state.discardAsk = false;
        repaint();
        return true;
      }
      return true;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      postComment();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      if (state.commentText !== '') {
        state.discardAsk = true;
        repaint();
        return true;
      }
      state.mode = 'list';
      state.commentText = '';
      actionError = null;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['enter'])) {
      state.commentText += '\n';
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      state.commentText = state.commentText.slice(0, -1);
      repaint();
      return true;
    }
    if (typeof data === 'string' && data.length === 1) {
      state.commentText += data;
      repaint();
      return true;
    }
    return false;
  }

  function handleInput(data) {
    if (isKeyRelease(helpers, data)) return;
    // A copy notice lives until the next non-copy key; y/Y refresh it.
    if (data !== 'y' && data !== 'Y') notice = null;
    if (state.searching) {
      if (handleSearchInput(data)) return;
      return;
    }
    if (state.mode === 'labels') {
      if (handleLabelInput(data)) return;
      return;
    }
    if (state.mode === 'comment') {
      if (handleCommentInput(data)) return;
      return;
    }
    if (state.mode === 'confirm') {
      if (keyMatches(helpers, data, ['enter', 'y'])) {
        confirmState();
        return;
      }
      if (keyMatches(helpers, data, ['escape', 'n', 'q'])) {
        state.mode = 'list';
        state.confirm = null;
        actionError = null;
        repaint();
        return;
      }
      return;
    }
    if (keyMatches(helpers, data, ['escape', 'ctrl+c', 'q'])) {
      close();
      return;
    }
    if (keyMatches(helpers, data, ['tab', 'right'])) {
      switchPage(1);
      return;
    }
    if (keyMatches(helpers, data, ['shift+tab', 'left'])) {
      switchPage(-1);
      return;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      moveSelection(1);
      return;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      moveSelection(-1);
      return;
    }
    const page = Math.max(1, bodyRows - 1);
    if (keyMatches(helpers, data, ['ctrl+j', 'pagedown'])) {
      state.scroll += page;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['ctrl+k', 'pageup'])) {
      state.scroll -= page;
      repaint();
      return;
    }
    const halfPage = Math.max(1, Math.floor(page / 2));
    if (keyMatches(helpers, data, HALF_PAGE_DOWN)) {
      state.scroll += halfPage;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, HALF_PAGE_UP)) {
      state.scroll -= halfPage;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['end'])) {
      // S8 assigns home/end to first/last issue in the list: the same
      // behaviour as moving the selection (reset the new issue to its top).
      // Detail scrolling belongs to ctrl+j/ctrl+k/pgUp/pgDn only.
      const total = filteredIssues().length;
      if (total > 0) {
        state.index = total - 1;
        state.scroll = 0;
        ensureDetail(selected());
      }
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['home'])) {
      const total = filteredIssues().length;
      if (total > 0) {
        state.index = 0;
        state.listPage = 1;
        ensureDetail(selected());
      }
      state.scroll = 0;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['['])) {
      if (state.listPage > 1) {
        state.listPage -= 1;
        state.index = (state.listPage - 1) * Math.max(1, state.pageSize);
        state.scroll = 0;
        ensureDetail(selected());
      }
      repaint();
      return;
    }
    if (keyMatches(helpers, data, [']'])) {
      if (state.listPage < pageCount()) {
        state.listPage += 1;
        state.index = (state.listPage - 1) * Math.max(1, state.pageSize);
        state.scroll = 0;
        ensureDetail(selected());
      }
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['T', '/'])) {
      state.searching = true;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['L'])) {
      openLabelEditor();
      return;
    }
    if (keyMatches(helpers, data, ['c'])) {
      if (!selected()) return;
      state.mode = 'comment';
      state.commentText = '';
      state.discardAsk = false;
      actionError = null;
      repaint();
      return;
    }
    // x/X both close the issue (S10a: the list is open-only, so there is no
    // reopen path), each after the host's own confirm.
    if (keyMatches(helpers, data, ['x', 'X'])) {
      if (!selected()) return;
      state.mode = 'confirm';
      state.confirm = 'closed';
      actionError = null;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['o'])) {
      const open = actions && typeof actions.openBrowser === 'function' ? actions.openBrowser : null;
      const row = selected();
      if (typeof open === 'function' && row) {
        try {
          open(numOf(row));
        } catch {
          // Opening the browser never mutates view state.
        }
      }
      return;
    }
    // y/Y are case-sensitive (keyMatches lowercases, so match raw first).
    if (data === 'y' || (typeof data !== 'string' && keyMatches(helpers, data, ['y']))) {
      doCopy('number');
      return;
    }
    if (data === 'Y' || (typeof data !== 'string' && keyMatches(helpers, data, ['Y']))) {
      doCopy('url');
      return;
    }
    if (keyMatches(helpers, data, ['r'])) {
      const reload = actions && typeof actions.reload === 'function' ? actions.reload : null;
      if (loaderMode) {
        requestPages(reload || loadPageFn);
        return;
      }
      if (typeof reload !== 'function') return;
      let result = null;
      try {
        result = reload();
      } catch {
        return;
      }
      settleAsync(result, (settled) => {
        applyLoadedPages(settled);
        repaint();
      }, (error) => {
        actionError = error;
        repaint();
      });
    }
  }

  function invalidate() {}

  ensureDetail(selected());
  if (loaderMode) requestPages(loadPageFn);

  return { render, handleInput, invalidate, state };
}

module.exports = { createIssuesView, FOOTER_KEYS, SEARCH_KEYS };
