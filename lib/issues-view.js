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
// S16/D2: label and assignee editing is a repository capability, never the
// fact that the user authenticated. Issue detail carries
// `permissions: {canEditLabels, canEditAssignees, canCreateLabels}`; anything
// but a literal `true` (missing, unknown, non-boolean) is false, so the footer
// hint is absent AND the key cannot enter the editor. Applying existing labels
// needs `canEditLabels`, creating one needs the distinct WRITE capability
// `canCreateLabels`, and assignees need `canEditAssignees` and save as
// add/remove deltas through `actions.editAssignees`. A rejected save stays
// visible with the local toggles intact; a successful one refetches the detail
// through `loadIssue(number, {refresh:true})` instead of trusting the cache.
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

//
// S3/S5/D1 (this unit): the left list carries the full wrapped title and no
// issue number, and its pane takes the shared half-width rule from
// lib/view-layout.js instead of the old 34/36-column cap. Paging is a
// server-page seam — `loadIssuePage({bucketId, cursor, limit})` answering
// `{ok, issues, total, hasNextPage, error?}`, every issue carrying its server
// `cursor` — where `limit` is the real body-row budget (never a fixed count),
// the next request starts after the LAST SHOWN row and not after rows fetched
// but unused, and each bucket keeps its own page start cursors. Every move
// fetches fresh, a resize drops the recorded boundaries, and a stale answer
// can never paint over a newer navigation. The eager `pages` / `loadPages`
// contracts stay supported as the fallback.
//
// S13/S14/S15 (this unit): a tab that was already read paints its rows and its
// own page again instead of refetching and flashing `loading` — `r` is the
// explicit refresh of the page the reader is on. The buckets end with `All`,
// the whole open repository with no dedup against the other tabs (the caller
// supplies its query; the view never invents one). The page indicator is fixed
// chrome on the search row, so it is always visible and the list spends its
// whole body budget on issues.
//
// S9 (this unit): the search box is a SERVER search on the page seam. Every
// request carries `query`, so the seam searches the complete bucket instead of
// the loaded page, and its rows are never re-filtered locally as literal text
// (GitHub operators such as `label:` are not title words). A new query reads
// from the head, cursors stay bound to the query that produced them, and a
// successful write invalidates the loaded pages it changed. Static and
// `loadPages` callers keep the local filter they always had.
//
// S10/S11 (this unit): every write (labels, assignees, comment, close) records
// and paints its busy state BEFORE the action is invoked and ignores every key
// until it settles, so a second save, a page/tab move or typing can never race
// it; a failure keeps the draft and names the real error. The comment editor
// paints the caret at the actual insertion point.

// S9: a remote search is debounced, so a burst of typing costs ONE server read
// for the query it settles on. The delay is an ordinary short choice; the clock
// itself is injected (`scheduleQuery` / `cancelSchedule`), so a host or a test
// owns it and no expectation depends on wall-clock timing.
const QUERY_DEBOUNCE_MS = 180;

function defaultSchedule(fn, delayMs) {
  return setTimeout(fn, delayMs);
}

function defaultCancel(handle) {
  clearTimeout(handle);
}

const layout = require('./view-layout.js');
const scrollKeys = require('./preview-scroll-keys.js');
// S16: the ONE issue preview. The worktree detail already renders through this
// module, so the Issues pane calls it too instead of keeping a second copy of
// the same fields — a preview that drifts surface by surface is what S16
// reported.
const { issueDetailLines } = require('./issue-preview.js');

const CARD_PADDING = layout.CARD_PADDING;
const MIN_WIDTH = 24;
// The buckets the server seam reads from unless the caller passes its own
// `pages` metadata (ids and labels are then the caller's) — S15 appends `All`,
// the whole open repository, and never deduplicates it against the others.
const DEFAULT_BUCKETS = [
  { id: 'mine', label: 'My issues' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'involved', label: 'Involved' },
  { id: 'all', label: 'All' },
];
// S17: no `? help` — the footer legend is the only key reference. Its contents
// stay fixed (S10b: no assignment key rides it) and S13 keeps it free of
// repetition: every shortcut, the search key included, is named here once and
// the state toggle is gone (S10a). S2: it is ONE terminal row — `text`
// is the full token, `short` the compact form used when the full one does not
// fit, and `priority` decides what a still-too-wide legend drops first (lowest
// first), so `esc close` outlives every other hint.
const FOOTER_KEYS = [
  { text: '↑↓ move', short: '↑↓ move', priority: 90 },
  // D3: tab selects the bucket, the arrows page the list it shows.
  { text: 'tab bucket', short: 'tab', priority: 60 },
  { text: '←/→ page', short: '←/→', priority: 55 },
  // S16: an editor entry carries the capability it needs, and the render
  // drops the whole hint when that capability is not confirmed true.
  { text: 'L labels', short: 'L', priority: 50, requires: 'canEditLabels' },
  { text: 'a assign', short: 'a', priority: 48, requires: 'canEditAssignees' },
  { text: 'c comment', short: 'c', priority: 45 },
  { text: 'x/X close', short: 'x/X', priority: 40 },
  { text: 'o web', short: 'o', priority: 20 },
  // S4: the search key belongs here with every other shortcut, never on the
  // search row above it.
  { text: 'T search', short: 'T', priority: 35 },
  { text: 'esc close', short: 'esc close', priority: 100 },
];

// S13: while the search box holds the keyboard, the footer names THAT
// interaction once — enter and esc each keep the filter — instead of the box
// and the footer both spelling the same keys out. `enter/esc keep` is a single
// token so the two keys never inflate the ONE legend row (S2).
const SEARCH_KEYS = [
  { text: 'type to filter', short: 'type', priority: 30 },
  { text: 'bksp edit', short: 'bksp', priority: 20 },
  // S4: Delete clears the whole query, so its hint is part of the typing
  // interaction and leaves with it.
  { text: 'del clear', short: 'del', priority: 50 },
  { text: 'enter/esc keep', short: 'enter/esc', priority: 60 },
];

// Printable paging keys must not fall through to lowercase list selection.
const SHIFTED_TWINS = new Set(['j', 'k']);

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

// S14: the last cells of a query that fit `room`, prefixed with an ellipsis when
// something was dropped. Only the DISPLAY is shortened — the stored query keeps
// every character — and keeping the tail means the caret (where typing lands)
// stays on screen.
function tailOf(helpers, text, room) {
  const chars = [...String(text ?? '')];
  if (room <= 0) return '';
  if (measure(helpers, chars.join('')) <= room) return chars.join('');
  let cut = '';
  for (let at = chars.length - 1; at >= 0; at -= 1) {
    const next = chars[at] + cut;
    if (measure(helpers, `…${next}`) > room) break;
    cut = next;
  }
  return cut === '' ? '…' : `…${cut}`;
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

// S16: one capability contract for both editors. Only a literal `true`
// confirms a permission, so a missing field, an unknown string or a truthy
// non-boolean all read as "not permitted" (GitHub stays the final authority).
const NO_PERMISSIONS = { canEditLabels: false, canEditAssignees: false, canCreateLabels: false };

function issuePermissions(issue) {
  const raw = issue && typeof issue === 'object' ? issue.permissions : null;
  const confirmed = (name) => Boolean(raw && typeof raw === 'object' && raw[name] === true);
  return {
    canEditLabels: confirmed('canEditLabels'),
    canEditAssignees: confirmed('canEditAssignees'),
    canCreateLabels: confirmed('canCreateLabels'),
  };
}

// One assignable user as the editor lists it: a login plus the display name
// GitHub may or may not carry.
function assigneeOption(user) {
  if (typeof user === 'string') return user === '' ? null : { login: user, name: '' };
  const login = user && typeof user.login === 'string' ? user.login : '';
  if (login === '') return null;
  return { login, name: user && typeof user.name === 'string' ? user.name : '' };
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
    loadIssuePage = null,
    loadLabels = null,
    loadAssignees = null,
    actions = {},
    // S9: the remote-search debounce clock. Hosts and tests inject it; the
    // defaults are the ordinary timers.
    scheduleQuery = null,
    cancelSchedule = null,
  } = options;

  // S25: the header repeats neither the branch nor the worktree ("solo data
  // relevante y lo mas abreviada posible"); `options.checkoutName` is still
  // accepted for compatibility and deliberately never rendered.

  // Loader mode: the caller fetches issues for the filter the viewer asks
  // for. Eager mode keeps the previous contract intact for callers that
  // already hand over `pages`.
  const loadPageFn = typeof loadPages === 'function' ? loadPages : null;
  // S5/D1: the server-page seam is the preferred reader; the older
  // `loadPages` contract is only the fallback when it is absent.
  const pageLoaderFn = typeof loadIssuePage === 'function' ? loadIssuePage : null;
  const serverMode = pageLoaderFn !== null;
  const loaderMode = loadPageFn !== null && !serverMode;
  const scheduleFn = typeof scheduleQuery === 'function' ? scheduleQuery : defaultSchedule;
  const cancelFn = typeof cancelSchedule === 'function' ? cancelSchedule : defaultCancel;

  // S10b: `options.assigned`, `options.saveAssignment` and
  // `options.assignmentEnabled` are deliberately not read: the association
  // belongs to the worktree detail, and this view stays read-only.

  let pages = Array.isArray(options.pages) && options.pages.length > 0
    ? options.pages.map(mapPage)
    : (serverMode
      ? DEFAULT_BUCKETS.map((bucket, at) => mapPage({ id: bucket.id, label: bucket.label, issues: null }, at))
      : (loaderMode ? [] : [{ id: 'mine', label: 'My issues', issues: null, total: null }]));
  let fallbackIssues = Array.isArray(options.issues) ? options.issues.slice() : [];
  let repoLabels = Array.isArray(options.labels)
    ? options.labels.map((label) => ({ name: labelName(label) })).filter((label) => label.name)
    : [];

  const state = {
    page: 0,
    index: 0,
    listPage: 1,
    scroll: 0,
    query: '',
    searching: false,
    mode: 'list',
    loading: loaderMode || serverMode,
    loadError: null,
    labelIndex: 0,
    labelCreating: false,
    createName: '',
    assigneeIndex: 0,
    commentText: '',
    confirm: null,
    discardAsk: false,
    // S10: the write in flight, if any. While it is set the view owns the
    // keyboard and every key is ignored.
    saving: null,
    // S9: a remote search read is scheduled but not yet issued. The query is
    // already applied; only its server read is waiting for the debounce.
    searchPending: false,
  };
  let bodyRows = 1;
  // The rows the last paint actually showed. Capacity is derived on every
  // render from the wrapped titles and the body budget, so it is never a
  // stored fixed page size.
  let shownCapacity = 0;

  const details = new Map();
  let actionError = null;
  // Only the newest page request may apply its result (S18/S19: a slow answer
  // must never overwrite a newer one), and a closed view repaints nothing.
  let active = true;
  let pagesSeq = 0;
  // Every server page request carries a monotonic generation, so only the
  // newest answer for a bucket may paint (D1) and a resize throws away the
  // geometry the recorded page starts were derived from.
  let pageSeq = 0;
  let lastLayout = null;
  let listWidthCache = 20;
  // S9: the ONE scheduled remote read. Replacing it cancels the previous one,
  // so query changes never accumulate timers or late answers.
  let scheduledQuery = null;
  let labelsLoaded = false;
  let labelsLoading = false;
  let labelsError = null;
  // S16: assignable users load on the assignee editor's FIRST use, like repo
  // labels, and a failed load stays retryable on the next open.
  let assigneeUsers = [];
  let assigneesLoaded = false;
  let assigneesLoading = false;
  let assigneesError = null;

  const numOf = (row) => (row && row.number != null ? Number(row.number) : NaN);

  // A one-shot result line for an action that finished (S6: a posted
  // comment). It is dropped by the next key and never outlives the view.
  let notice = null;

  function baseIssues() {
    const current = pages[state.page];
    if (current && Array.isArray(current.issues)) return current.issues;
    return fallbackIssues;
  }

  function filteredIssues() {
    // S10a: open issues only. The row's own state decides, so a page that
    // arrives with a closed row never lists it, whatever the fetch claimed.
    const open = baseIssues().filter((row) => rowState(row) === 'open');
    // S9: on the server seam the query WAS the request, so the answer is the
    // complete result for it and re-filtering it as literal title text would
    // drop every row GitHub matched for an operator (`label:`, `is:`, ...).
    if (serverMode) return open;
    return open.filter((row) => matchesQuery(row, state.query));
  }

  function clampSelection() {
    const total = filteredIssues().length;
    if (state.index >= total) state.index = Math.max(0, total - 1);
    if (state.index < 0) state.index = 0;
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
  // fetch that lands later cannot paint into a closed view — and a scheduled
  // remote read is dropped instead of firing into a dead component.
  function close() {
    active = false;
    cancelScheduledQuery();
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

  // ---- server pages (S5/D1) -----------------------------------------------

  // The item budget of the left list: every body row the frame leaves, because
  // the page indicator lives on the search row (S14) and the list keeps no
  // marker of its own. Wrapped titles can only reduce how many issues fit, so a
  // request asks for at most this many rows and the next page starts after the
  // last row that was actually shown.
  function listBodyRows() {
    return Math.max(1, availableRows() - 6);
  }

  // S14: the page indicator is fixed chrome — it rides the search row instead
  // of taking a list row, and it is present even for a single page. A server
  // page can only name its own number, so a further page is marked `+` once the
  // answer confirmed one, never guessed.
  function searchIndicator() {
    if (serverMode) {
      const bucket = pages[state.page];
      if (!bucket) return '';
      const rt = bucketState(bucket);
      const page = Math.max(1, Math.floor(Number(rt.page) || 1));
      return `page ${page}${rt.loaded && rt.hasMore ? '+' : ''}`;
    }
    // S14: the indicator is fixed chrome, so an EMPTY result and a single page
    // both name their position — only the very first, still-unanswered loader
    // frame has none to name (a pending fetch must not advertise a page count
    // it never read).
    const list = filteredIssues();
    const answered = state.loading === false || pages.some((page) => Array.isArray(page.issues));
    if (!answered) return '';
    const bounds = layout.paginate(list.map((row) => listRowCost(row, listWidthCache)), Math.max(1, bodyRows));
    const page = Math.min(Math.max(1, layout.pageForIndex(bounds, state.index).page), bounds.length);
    return `page ${page}/${bounds.length}`;
  }

  // S14: the search widget for a given cell budget. The page indicator's cells
  // are reserved before this is called, so only the query display is clipped.
  function searchWidget(room) {
    if (room <= 0) return '';
    const prefix = '› ';
    if (state.searching) {
      const tail = tailOf(helpers, state.query, Math.max(0, room - measure(helpers, `${prefix}█`)));
      return paint(theme, 'accent', `${prefix}${tail}█`);
    }
    if (state.query === '') return '› Search';
    return fit(helpers, `${prefix}${state.query}`, room);
  }

  function cursorOf(row) {
    return row && row.cursor != null && String(row.cursor) !== '' ? String(row.cursor) : null;
  }

  // One bucket's page state: the page it shows, the start cursor recorded for
  // each page it has visited (which is what makes `previous` a real request),
  // and the generation its newest answer belongs to.
  function bucketState(page) {
    if (!page.rt) {
      page.rt = {
        page: 1, starts: [null], hasMore: true, loading: false, loaded: false,
        seq: 0, error: null, shownLastCursor: null, shownPage: null,
      };
    }
    return page.rt;
  }

  function normalizePageResult(result) {
    if (!result || typeof result !== 'object') return { ok: false, error: 'issues could not be loaded' };
    if (result.ok === false) {
      return { ok: false, error: String(result.error || result.loadError || 'issues could not be loaded') };
    }
    if (!Array.isArray(result.issues)) return { ok: false, error: 'issues could not be loaded: unexpected result' };
    const total = Number.isFinite(Number(result.total)) ? Number(result.total) : null;
    return { ok: true, issues: result.issues.slice(), total, hasNextPage: result.hasNextPage === true };
  }

  function requestBucketPage(bucketIndex, pageNumber, cursor, requestOptions = {}) {
    const bucket = pages[bucketIndex];
    if (!bucket || !pageLoaderFn) return null;
    const keepSelection = Boolean(requestOptions) && requestOptions.keepSelection === true;
    const query = String(state.query || '');
    const rt = bucketState(bucket);
    // S9: cursors belong to the query that produced them, so a new query starts
    // at the head of its own result set and never reuses another query's page
    // boundary.
    let targetPage = pageNumber;
    let targetCursor = cursor;
    if (rt.query !== query) {
      rt.query = query;
      rt.starts = [null];
      rt.hasMore = true;
      rt.shownLastCursor = null;
      rt.shownPage = null;
      targetPage = 1;
      targetCursor = null;
    }
    const seq = ++pageSeq;
    rt.seq = seq;
    rt.page = targetPage;
    rt.starts[targetPage - 1] = targetCursor == null ? null : targetCursor;
    rt.starts.length = targetPage;
    rt.loading = true;
    rt.error = null;
    state.listPage = targetPage;
    if (bucketIndex === state.page) state.loading = true;
    repaint();
    const request = {
      bucketId: bucket.id,
      cursor: targetCursor == null ? null : targetCursor,
      limit: listBodyRows(),
      query,
    };
    let pending = null;
    try {
      pending = pageLoaderFn(request);
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'issues could not be loaded' };
    }
    const settle = (result) => {
      // S5/D1: only the newest request for this bucket may paint, so an earlier
      // slow answer never overwrites the page the reader is on now.
      if (!active || rt.seq !== seq) return;
      rt.loading = false;
      const normalized = normalizePageResult(result);
      if (!normalized.ok) {
        rt.error = normalized.error;
        if (bucketIndex === state.page) {
          state.loading = false;
          state.loadError = normalized.error;
        }
        repaint();
        return;
      }
      bucket.issues = normalized.issues;
      bucket.total = normalized.total;
      bucket.truncated = normalized.hasNextPage;
      rt.hasMore = normalized.hasNextPage;
      rt.loaded = true;
      rt.error = null;
      if (bucketIndex === state.page) {
        state.loading = false;
        state.loadError = null;
        // S10: a refresh re-reads the page the reader is on, so the focused
        // row (and the preview beside it) survives; paging starts at its top.
        if (keepSelection) clampSelection();
        else {
          state.index = 0;
          state.scroll = 0;
        }
        state.listPage = pageNumber;
        actionError = null;
        // The detail is read again even when the page answer repeats the same
        // rows, because comments live only in the detail.
        ensureDetail(selected(), keepSelection ? { refresh: true } : undefined);
      }
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'issues could not be loaded' });
    });
    return request;
  }

  // A resize invalidates every recorded start cursor, so the reader returns to
  // the first page of the bucket it is on and reads it again. The generation is
  // bumped for EVERY bucket, not only the one being read: an inactive bucket's
  // slow page was requested for the old viewport, so it must not paint into the
  // boundaries this reset has just recorded.
  function resetServerPages() {
    pages.forEach((page) => {
      const rt = bucketState(page);
      pageSeq += 1;
      rt.seq = pageSeq;
      rt.page = 1;
      rt.starts = [null];
      rt.hasMore = true;
      // The rows were read for the old viewport, so the bucket is unread again:
      // returning to it re-reads the page instead of reusing stale geometry.
      // Any answer still in flight was requested for that same old viewport, so
      // it is dropped and cannot keep the bucket marked as loading.
      rt.loaded = false;
      rt.loading = false;
      rt.shownLastCursor = null;
      rt.shownPage = null;
    });
    state.listPage = 1;
    state.index = 0;
    state.scroll = 0;
    // A resize re-reads page one of the current query itself, so a scheduled
    // read for that same query would only duplicate it.
    cancelScheduledQuery();
    requestBucketPage(state.page, 1, null);
  }

  // S9: a successful write changes the repository, so every bucket's loaded
  // page is stale. The rows stay painted (no blank frame, no lost selection),
  // but the next visit to a bucket reads its page again instead of reusing the
  // pre-write list.
  function invalidateLoadedPages() {
    if (!serverMode) return;
    pages.forEach((page) => {
      bucketState(page).loaded = false;
    });
  }

  // S3: the left row is the title alone — the number lives in the preview — so
  // the wrapped title owns the whole wider pane.
  function listTitle(row) {
    return String((row && row.title) || '');
  }

  function listRowCost(row, width) {
    return layout.rowCost(helpers, listTitle(row), width, { first: '▸ ' });
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

  function ensureDetail(row, detailOptions = {}) {
    const refresh = Boolean(detailOptions) && detailOptions.refresh === true;
    if (!row || !Number.isFinite(numOf(row))) return null;
    const number = numOf(row);
    let entry = details.get(number);
    if (entry && !refresh) return entry;
    const previous = entry && entry.issue ? entry.issue : row;
    entry = { status: 'loading', issue: previous, comments: entry ? entry.comments : [], lines: [], error: null };
    details.set(number, entry);
    if (typeof loadIssue !== 'function') {
      entry.status = 'ready';
      entry.issue = row;
      return entry;
    }
    let pending = null;
    try {
      pending = refresh ? loadIssue(number, { refresh: true }) : loadIssue(number);
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

  // S16: a save that GitHub accepted invalidates the cached detail and reads
  // it again, so the preview shows the saved truth instead of the pre-save
  // copy. A failure never reaches here: the cache is left untouched.
  function refetchDetail(number) {
    const row = filteredIssues().find((candidate) => numOf(candidate) === number)
      || (numOf(selected()) === number ? selected() : null);
    if (!row) {
      details.delete(number);
      repaint();
      return;
    }
    ensureDetail(row, { refresh: true });
    repaint();
  }

  // S16: the preview IS `lib/issue-preview.js` — assignees, projects, linked
  // PRs, the body and every comment render exactly as they do in the worktree
  // detail. Only the status lines for "no selection", a failed read and an
  // in-flight read stay here, because those describe THIS view's own state.
  function detailLines(row, width) {
    const entry = ensureDetail(row);
    if (!entry) return [paint(theme, 'muted', '(no issue selected)')];
    if (entry.status === 'error') return [paint(theme, 'error', `unreadable: ${entry.error}`)];
    if (entry.status !== 'ready') return [paint(theme, 'muted', 'loading…')];
    return issueDetailLines(entry.issue || row, entry.comments, {
      width,
      paint: (role, text) => paint(theme, role, text),
      emphasis: (text) => emphasize(theme, text),
    });
  }

  function clampScroll(total) {
    const max = Math.max(0, total - Math.max(1, bodyRows));
    if (state.scroll > max) state.scroll = max;
    if (state.scroll < 0) state.scroll = 0;
  }

  // S16: permissions come from the issue detail once it is established. While
  // it loads, and whenever no detail seam exists to confirm them, nothing is
  // confirmed. This lookup never starts a fetch, so painting the footer
  // cannot change what is in flight.
  function permissionsFor(row) {
    if (!row) return NO_PERMISSIONS;
    const number = numOf(row);
    const entry = Number.isFinite(number) ? details.get(number) : null;
    if (entry && entry.status === 'ready') return issuePermissions(entry.issue || row);
    if (typeof loadIssue !== 'function') return issuePermissions(row);
    return NO_PERMISSIONS;
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
    // S3: the left pane takes the shared half-width rule from view-layout, so
    // this widened panel and its wrapped titles follow the same allocation as
    // the worktree detail and ODD readers — no 34/36-column cap survives.
    const panes = layout.paneWidths(inner);
    const listWidth = panes.left;
    const rightWidth = panes.right;
    listWidthCache = listWidth;
    bodyRows = Math.max(1, height - 6);
    // S5/D1: boundaries recorded for another viewport are stale, so a resize
    // resets them before anything is paged or fetched.
    if (serverMode && lastLayout && (lastLayout.width !== w || lastLayout.height !== height)) {
      resetServerPages();
    }
    lastLayout = { width: w, height };
    const border = (text) => paint(theme, 'border', text);
    const divider = border('│');
    // S13: the legend names the interaction the keyboard is in — the search
    // keys while the box is open, the reading keys otherwise — on this ONE
    // row, and no hint is repeated on the row that already owns it. S16: an
    // editor whose capability is not confirmed true has no hint at all.
    const permissions = permissionsFor(selected());
    const footerKeys = state.searching
      ? SEARCH_KEYS
      : [FOOTER_KEYS[0], ...scrollKeys.previewScrollKeys(helpers), ...FOOTER_KEYS.slice(1)]
        .filter((entry) => !entry.requires || permissions[entry.requires] === true);
    const footerCell = () => `${border('│')} ${paint(theme, 'muted', pad(helpers, legendText(helpers, footerKeys, inner), inner))} ${border('│')}`;
    const lines = [];
    const topLeft = `${border('╭─')} ${paint(theme, 'accent', title)} `;
    // S27: no top-right `esc` text (the /changes frame has none) — the corner
    // and the right border stay in the terminal's last cell.
    const topRight = border('─╮');
    lines.push(`${topLeft}${border('─'.repeat(Math.max(0, w - measure(helpers, topLeft) - measure(helpers, topRight))))}${topRight}`);
    // S26/S13: the search/filter widget owns the row directly below the title
    // and carries the query only — it is the single place `T` is named, and
    // the keys that leave the box are named once, by the footer. S14: the page
    // indicator rides this same row, right-aligned and always present, so it
    // never moves and never takes a list row. Its cells are reserved FIRST, so
    // a long query is what gets clipped — never the page position.
    const searchLine = () => {
      const indicator = searchIndicator();
      const mark = indicator === '' ? '' : paint(theme, 'muted', indicator);
      const reserved = indicator === '' ? 0 : measure(helpers, indicator) + 1;
      const room = Math.max(0, inner - reserved);
      const widget = searchWidget(room);
      const row = indicator === '' ? widget : `${pad(helpers, widget, room)} ${mark}`;
      return `${border('│')} ${pad(helpers, row, inner)} ${border('│')}`;
    };

    // The gh-unavailable and load-error states replace the panes, never with fake rows.
    const loadError = state.loadError || (options.loadError ? String(options.loadError) : null);
    if (options.ghAvailable === false) {
      lines.push(searchLine());
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'error', 'gh unavailable: install gh and authenticate to use /issues'), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }
    if (loadError && !state.loading && filteredIssues().length === 0) {
      lines.push(searchLine());
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'error', `failed to load issues: ${loadError}`), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }
    // First paint with the loader: name the wait instead of claiming 0 issues.
    const activeBucket = pages[state.page] || null;
    const bucketLoaded = Boolean(activeBucket && Array.isArray(activeBucket.issues));
    if (state.loading && (pages.length === 0 || (serverMode && !bucketLoaded))) {
      lines.push(searchLine());
      lines.push(`${border('│')} ${pad(helpers, paint(theme, 'muted', 'loading issues…'), inner)} ${border('│')}`);
      while (lines.length < height - 2) lines.push(`${border('│')} ${pad(helpers, '', inner)} ${border('│')}`);
      lines.push(footerCell());
      lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
      return lines.map((line) => pad(helpers, line, w));
    }

    lines.push(searchLine());
    const tabs = pages.map((page, at) => {
      const label = `${at === state.page ? '▸ ' : ''}${page.label} (${tabCount(page)})`;
      return at === state.page ? emphasize(theme, label) : paint(theme, 'muted', label);
    }).join(paint(theme, 'border', ' │ '));
    lines.push(`${border('│')} ${pad(helpers, tabs, inner)} ${border('│')}`);

    // S26/S13: failures and notices share this visible row, so typing a query
    // never hides one — and it carries no state indicator and no repeated
    // count (S10a/S13). S10: a write in flight owns the row until it settles,
    // so the reader never has to guess whether the save landed.
    const savingNote = state.saving ? paint(theme, 'accent', saveLabel(state.saving)) : '';
    const errorNote = savingNote || (actionError ? paint(theme, 'error', actionError)
      : (loadError ? paint(theme, 'error', String(loadError)) : ''));
    // S9: a scheduled remote search names itself instead of looking frozen.
    const note = errorNote || (notice ? paint(theme, 'accent', notice) : '')
      || (state.searchPending ? paint(theme, 'muted', 'searching…') : '')
      || (state.loading ? paint(theme, 'muted', 'loading…') : '');
    lines.push(`${border('│')} ${pad(helpers, note, inner)} ${border('│')}`);

    const list = filteredIssues();
    const focused = selected();
    if (focused) ensureDetail(focused);
    // S5/D1: capacity follows the wrapped row heights against the real body
    // budget, never a fixed item count, and a server page is an upper bound —
    // only the rows that fit are shown. S14: the freed marker row belongs to the
    // list now, so the whole body budget holds issues.
    const bounds = layout.paginate(list.map((row) => listRowCost(row, listWidth)), Math.max(1, bodyRows));
    let shownStart = 0;
    let shownEnd = 0;
    if (serverMode) {
      shownEnd = Math.min(bounds[0].end, list.length);
      const rt = activeBucket ? bucketState(activeBucket) : null;
      if (rt) {
        // The next request starts after the LAST SHOWN row, never after rows
        // that were fetched but did not fit (D1).
        rt.shownLastCursor = shownEnd > 0 ? cursorOf(list[shownEnd - 1]) : null;
        rt.shownPage = rt.page;
      }
      if (state.index >= shownEnd) state.index = Math.max(0, shownEnd - 1);
      state.listPage = rt ? rt.page : 1;
    } else {
      const found = layout.pageForIndex(bounds, state.index);
      shownStart = found.bounds.start;
      shownEnd = found.bounds.end;
      state.listPage = found.page;
    }
    shownCapacity = Math.max(0, shownEnd - shownStart);
    const leftLines = [];
    for (let at = shownStart; at < shownEnd; at += 1) {
      const isFocused = at === state.index;
      const rows = layout.wrapLabel(helpers, listTitle(list[at]), listWidth, { first: isFocused ? '▸ ' : '  ' });
      for (const row of rows) leftLines.push(highlight(theme, pad(helpers, row, listWidth), isFocused));
    }

    let rightSource;
    if (state.mode === 'labels') {
      rightSource = labelEditorLines(rightWidth);
    } else if (state.mode === 'assignees') {
      rightSource = assigneeEditorLines(rightWidth);
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

  // The issue an editor starts from: the established detail when it is ready,
  // because the list row may not carry labels or assignees the detail has;
  // otherwise the row itself. Never starts a fetch of its own.
  function currentIssue(row) {
    if (!row) return null;
    const number = numOf(row);
    const entry = Number.isFinite(number) ? details.get(number) : null;
    if (entry && entry.status === 'ready' && entry.issue) return entry.issue;
    return row;
  }

  function currentLabelState() {
    const issue = currentIssue(selected());
    const names = new Set((issue && Array.isArray(issue.labels) ? issue.labels : []).map(labelName).filter(Boolean));
    return names;
  }

  // Label editor local state: toggles start from the row's labels; created
  // names are pending until ctrl+s applies them through editLabels.
  let labelDraft = null;
  function openLabelEditor() {
    const row = selected();
    if (!row) return;
    const permissions = permissionsFor(row);
    if (!permissions.canEditLabels) {
      // S16: the key is refused outright — no editor, no loader, no write —
      // and the refusal names what is missing instead of guessing.
      actionError = 'labels cannot be edited: this repository permission is missing';
      repaint();
      return;
    }
    labelDraft = {
      number: numOf(row),
      selected: new Set(currentLabelState()),
      created: [],
      original: new Set(currentLabelState()),
      // S16: creating a label is a WRITE capability, distinct from the triage
      // permission that only applies labels that already exist.
      createAllowed: permissions.canCreateLabels,
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
    const names = repoLabels.map((l) => l.name);
    // S16: without canCreateLabels the list ends at the existing labels —
    // there is no create row to reach.
    const rows = labelDraft.createAllowed ? [...names, '+ create new…'] : names.slice();
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
    // S11: the caret sits at the real insertion point — after the last typed
    // character, on the line typing would continue on — so the editor shows
    // where the text goes instead of a marker detached from it.
    const lines = wrapText(state.commentText, width);
    const caret = paint(theme, 'accent', '█');
    const last = lines.at(-1) ?? '';
    if (state.commentText === '' || state.commentText.endsWith('\n') || measure(helpers, last) >= width) {
      lines.push(caret);
    } else {
      lines.splice(-1, 1, `${last}${caret}`);
    }
    out.push(...lines);
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
    // A row fetched but not shown is never selected: the next page re-reads it
    // from its own cursor, so the selection stays inside the visible rows.
    const span = serverMode && shownCapacity > 0 ? Math.min(total, shownCapacity) : total;
    state.index = (Math.min(state.index, span - 1) + step + span) % span;
    state.scroll = 0;
    actionError = null;
    ensureDetail(selected());
    repaint();
  }

  // D3: tab selects the bucket. S13: a bucket that already answered for the
  // current query paints again — its rows and its own page, no request and no
  // loading flash — while a bucket that was never read (or whose page a write
  // invalidated) is read once. `r` stays the explicit refresh.
  function switchPage(step) {
    if (pages.length === 0) return;
    state.page = (state.page + step + pages.length) % pages.length;
    state.index = 0;
    state.listPage = 1;
    state.scroll = 0;
    state.searching = false;
    actionError = null;
    if (serverMode) {
      const rt = bucketState(pages[state.page]);
      state.listPage = rt.page;
      state.loadError = null;
      if (rt.query === String(state.query || '') && (rt.loaded || rt.loading)) {
        state.loading = false;
        ensureDetail(selected());
        repaint();
        return;
      }
      requestBucketPage(state.page, rt.page, rt.starts[rt.page - 1] ?? null);
      return;
    }
    ensureDetail(selected());
    repaint();
  }

  // D3: the arrows page the ACTIVE list only. A server page is fetched fresh
  // from the start cursor recorded for the target page; the static fallback
  // moves its own derived boundary.
  function pageList(step) {
    if (serverMode) {
      const bucket = pages[state.page];
      if (!bucket) return;
      const rt = bucketState(bucket);
      const target = Math.max(1, rt.page + step);
      if (target === rt.page) return;
      let cursor = null;
      if (target > 1) {
        if (!rt.hasMore) return;
        const recorded = rt.starts[target - 1];
        // Only the page that was actually painted knows which of its rows was
        // the last shown one, so a forward move never borrows another page's
        // cursor (D1).
        const candidate = recorded === undefined
          ? (rt.shownPage === rt.page ? rt.shownLastCursor : undefined)
          : recorded;
        // Without the LAST SHOWN row's cursor there is no honest page to ask
        // for, so the move is refused instead of guessing one.
        if (candidate === undefined || candidate === null) return;
        cursor = candidate;
      }
      requestBucketPage(state.page, target, cursor);
      return;
    }
    const list = filteredIssues();
    const bounds = layout.paginate(list.map((row) => listRowCost(row, listWidthCache)), Math.max(1, bodyRows));
    const found = layout.pageForIndex(bounds, state.index);
    const target = Math.max(1, Math.min(bounds.length, found.page + step));
    if (target === found.page) return;
    state.listPage = target;
    state.index = bounds[target - 1].start;
    state.scroll = 0;
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

  // S10: the one-line description of the write in flight.
  const SAVE_LABELS = {
    labels: 'saving labels…',
    assignees: 'saving assignees…',
    comment: 'posting comment…',
    close: 'closing issue…',
  };

  function saveLabel(kind) {
    return SAVE_LABELS[kind] || 'saving…';
  }

  // S10: a write owns the view from its key until its answer. The state is
  // recorded and painted BEFORE the injected action is invoked, so the very
  // first frame after the key already says what is in flight, and `handleInput`
  // ignores every key meanwhile — a second save, a navigation or typing can
  // never race it.
  function beginSave(kind) {
    state.saving = kind;
    actionError = null;
    notice = null;
    repaint();
  }

  function settleSave(pending, onOk, onFail) {
    const finish = (result) => {
      if (!active) return;
      state.saving = null;
      if (result && result.ok === true) onOk(result);
      else onFail((result && result.error) || 'action failed');
    };
    Promise.resolve(pending).then(finish).catch((err) => {
      finish({ ok: false, error: (err && err.message) || 'action failed' });
    });
  }

  function applyLabels() {
    if (!labelDraft || state.saving !== null) return;
    const edit = actions && typeof actions.editLabels === 'function' ? actions.editLabels : null;
    if (typeof edit !== 'function') {
      actionError = 'label editing is unavailable';
      repaint();
      return;
    }
    const add = [...labelDraft.selected].filter((name) => !labelDraft.original.has(name));
    const remove = [...labelDraft.original].filter((name) => !labelDraft.selected.has(name));
    const number = labelDraft.number;
    beginSave('labels');
    let result = null;
    try {
      result = edit(number, add, remove, labelDraft.created.slice());
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleSave(result, () => {
      const row = filteredIssues().find((candidate) => numOf(candidate) === number);
      // The list row keeps the saved labels for its own display; the DETAIL
      // cache is dropped, never patched, so the preview reads GitHub again.
      if (row) row.labels = [...labelDraft.selected].map((name) => ({ name }));
      labelDraft = null;
      state.mode = 'list';
      actionError = null;
      invalidateLoadedPages();
      refetchDetail(number);
      repaint();
    }, (error) => {
      actionError = error;
      repaint();
    });
  }

  // S16: assignees are a toggle list too — the draft starts from the issue's
  // current assignees, so applying it sends only the add/remove delta.
  let assigneeDraft = null;

  function currentAssigneeState() {
    const issue = currentIssue(selected());
    return new Set((issue && Array.isArray(issue.assignees) ? issue.assignees : []).map(assigneeName).filter(Boolean));
  }

  function requestAssignees() {
    if (typeof loadAssignees !== 'function' || assigneesLoaded || assigneesLoading) return;
    assigneesLoading = true;
    assigneesError = null;
    repaint();
    let pending = null;
    try {
      pending = loadAssignees();
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'assignees unreadable' };
    }
    const settle = (result) => {
      assigneesLoading = false;
      if (result && result.ok === true && Array.isArray(result.users)) {
        assigneeUsers = result.users.map(assigneeOption).filter(Boolean);
        assigneesLoaded = true;
        assigneesError = null;
      } else {
        assigneesError = (result && (result.error || result.loadError)) || 'assignees unreadable';
      }
      repaint();
    };
    Promise.resolve(pending).then(settle).catch((err) => {
      settle({ ok: false, error: (err && err.message) || 'assignees unreadable' });
    });
  }

  function openAssigneeEditor() {
    const row = selected();
    if (!row) return;
    if (!permissionsFor(row).canEditAssignees) {
      actionError = 'assignees cannot be edited: this repository permission is missing';
      repaint();
      return;
    }
    assigneeDraft = { number: numOf(row), selected: currentAssigneeState(), original: currentAssigneeState() };
    state.mode = 'assignees';
    state.assigneeIndex = 0;
    actionError = null;
    state.scroll = 0;
    requestAssignees();
    repaint();
  }

  // The editor rows: every assignable user, plus any current assignee the user
  // list does not carry, so an unexpected name can still be removed.
  function assigneeRows() {
    const logins = assigneeUsers.map((user) => user.login);
    for (const login of (assigneeDraft ? assigneeDraft.original : [])) {
      if (!logins.includes(login)) logins.push(login);
    }
    return logins;
  }

  function assigneeEditorLines(width) {
    const out = [emphasize(theme, 'Assignees (space toggle · ctrl+s apply · esc back)')];
    if (!assigneeDraft) return out;
    if (assigneesLoading) {
      out.push(paint(theme, 'muted', 'loading assignees…'));
      return out;
    }
    if (assigneesError) out.push(paint(theme, 'error', `assignees unreadable: ${assigneesError}`));
    const logins = assigneeRows();
    logins.forEach((login, at) => {
      const on = assigneeDraft.selected.has(login);
      const user = assigneeUsers.find((candidate) => candidate.login === login);
      const cursor = at === state.assigneeIndex ? '▸ ' : '  ';
      const label = user && user.name && user.name !== login ? `${login} (${user.name})` : login;
      out.push(...wrapText(`${cursor}[${on ? 'x' : ' '}] ${label}`, width));
    });
    if (logins.length === 0) out.push(paint(theme, 'muted', 'no assignable users'));
    if (actionError) out.push(paint(theme, 'error', actionError));
    return out;
  }

  function applyAssignees() {
    if (!assigneeDraft || state.saving !== null) return;
    const edit = actions && typeof actions.editAssignees === 'function' ? actions.editAssignees : null;
    if (typeof edit !== 'function') {
      actionError = 'assignee editing is unavailable';
      repaint();
      return;
    }
    const add = [...assigneeDraft.selected].filter((login) => !assigneeDraft.original.has(login));
    const remove = [...assigneeDraft.original].filter((login) => !assigneeDraft.selected.has(login));
    const number = assigneeDraft.number;
    beginSave('assignees');
    let result = null;
    try {
      result = edit(number, { add, remove });
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleSave(result, () => {
      const row = filteredIssues().find((candidate) => numOf(candidate) === number);
      if (row) row.assignees = [...assigneeDraft.selected].map((login) => ({ login }));
      assigneeDraft = null;
      state.mode = 'list';
      actionError = null;
      invalidateLoadedPages();
      refetchDetail(number);
      repaint();
    }, (error) => {
      // S16: a rejected save keeps the draft — and therefore every local
      // toggle — exactly as it was, and shows why the server refused.
      actionError = error;
      repaint();
    });
  }

  function handleAssigneeInput(data) {
    // While the users are in flight only the exit works: toggling against an
    // unknown list would guess.
    if (assigneesLoading) {
      if (keyMatches(helpers, data, ['escape'])) {
        state.mode = 'list';
        assigneeDraft = null;
        actionError = null;
        repaint();
      }
      return true;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      applyAssignees();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.mode = 'list';
      assigneeDraft = null;
      actionError = null;
      repaint();
      return true;
    }
    const logins = assigneeRows();
    if (logins.length === 0) return true;
    if (state.assigneeIndex >= logins.length) state.assigneeIndex = logins.length - 1;
    if (keyMatches(helpers, data, ['up', 'k'])) {
      state.assigneeIndex = (state.assigneeIndex - 1 + logins.length) % logins.length;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      state.assigneeIndex = (state.assigneeIndex + 1) % logins.length;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['space', ' ', 'enter'])) {
      const login = logins[state.assigneeIndex];
      if (login) {
        if (assigneeDraft.selected.has(login)) assigneeDraft.selected.delete(login);
        else assigneeDraft.selected.add(login);
      }
      repaint();
      return true;
    }
    return true;
  }

  function postComment() {
    const post = actions && typeof actions.postComment === 'function' ? actions.postComment : null;
    const row = selected();
    if (typeof post !== 'function' || !row) {
      actionError = 'commenting is unavailable';
      repaint();
      return;
    }
    if (state.saving !== null) return;
    const text = state.commentText;
    const number = numOf(row);
    beginSave('comment');
    let result = null;
    try {
      result = post(number, text);
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleSave(result, () => {
      state.mode = 'list';
      state.commentText = '';
      state.discardAsk = false;
      actionError = null;
      // S6: the posted comment is only visible once the detail is read again —
      // page rows carry no comments. A failed refresh paints its own error, so
      // the result is never presented as updated data.
      notice = 'comment posted';
      invalidateLoadedPages();
      refetchDetail(number);
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
    if (state.saving !== null) return;
    const number = numOf(row);
    beginSave('close');
    let result = null;
    try {
      result = setState(number, 'closed');
    } catch (err) {
      result = { ok: false, error: (err && err.message) || 'action failed' };
    }
    settleSave(result, () => {
      // S10a: the list is open-only, so a closed issue leaves it at once. The
      // row keeps its new state where it is stored, and the open-only filter
      // and every count follow it.
      row.state = 'closed';
      const cached = details.get(number);
      if (cached && cached.issue) cached.issue = { ...cached.issue, state: 'closed' };
      state.mode = 'list';
      state.confirm = null;
      actionError = null;
      invalidateLoadedPages();
      clampSelection();
      repaint();
    }, (error) => {
      actionError = error;
      repaint();
    });
  }

  // S9: the remote search read is scheduled, not issued. One live callback at
  // a time: scheduling a new query cancels the previous one, so a burst of
  // typing never accumulates timers, and the read that finally goes out asks
  // for page one of the query that survived.
  function scheduleQueryRead(query) {
    cancelScheduledQuery();
    state.searchPending = true;
    const entry = { query, handle: null, fired: false };
    scheduledQuery = entry;
    const run = () => {
      if (entry.fired || scheduledQuery !== entry) return;
      entry.fired = true;
      scheduledQuery = null;
      state.searchPending = false;
      if (!active || query !== String(state.query || '')) return;
      requestBucketPage(state.page, 1, null);
    };
    let handle = null;
    try {
      handle = scheduleFn(run, QUERY_DEBOUNCE_MS);
    } catch {
      // A scheduler that cannot schedule degrades to the immediate read.
      run();
      return;
    }
    entry.handle = handle;
    repaint();
  }

  function cancelScheduledQuery() {
    if (scheduledQuery === null) return false;
    const { handle } = scheduledQuery;
    scheduledQuery = null;
    state.searchPending = false;
    try {
      cancelFn(handle);
    } catch {
      // A hostile scheduler never breaks the view.
    }
    return true;
  }

  // The scheduled read, issued now. Leaving the box, refreshing or paging under
  // a query nobody has read yet must not wait for a timer the reader can no
  // longer see, and must not fire it a second time afterwards: page one of the
  // current query is the only honest page, and the flushed call IS that read.
  function flushScheduledQuery() {
    if (scheduledQuery === null) return false;
    const { query } = scheduledQuery;
    cancelScheduledQuery();
    if (!active || !serverMode) return false;
    if (query !== String(state.query || '')) return false;
    requestBucketPage(state.page, 1, null);
    return true;
  }

  // S9: a query edit is a new dataset read on the server seam — the request
  // carries `query`, so it searches the COMPLETE bucket rather than the loaded
  // page. The query and the caret apply at once; the read is debounced. Static
  // and `loadPages` callers keep filtering the rows they already hold, at once.
  function setQuery(next) {
    state.query = next;
    state.index = 0;
    state.listPage = 1;
    state.scroll = 0;
    if (serverMode) {
      const bucket = pages[state.page];
      if (bucket) {
        const rt = bucketState(bucket);
        // The rows on screen belong to the previous query and any answer for it
        // is already stale: invalidate both NOW, so a slow earlier answer can
        // never paint while this query is still inside its debounce window.
        rt.loaded = false;
        rt.loading = false;
        rt.seq = ++pageSeq;
        state.loading = false;
        scheduleQueryRead(state.query);
        return;
      }
    }
    repaint();
  }

  function handleSearchInput(data) {
    if (keyMatches(helpers, data, ['enter'])) {
      state.searching = false;
      state.index = 0;
      state.listPage = 1;
      state.scroll = 0;
      // S9: leaving the box applies the filter NOW instead of waiting for a
      // debounce the reader can no longer see.
      if (!flushScheduledQuery()) repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['escape'])) {
      state.searching = false;
      state.index = 0;
      state.listPage = 1;
      if (!flushScheduledQuery()) repaint();
      return true;
    }
    // S4: Delete clears the WHOLE query; Backspace stays character deletion.
    if (keyMatches(helpers, data, ['delete'])) {
      setQuery('');
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      setQuery(state.query.slice(0, -1));
      return true;
    }
    if (typeof data === 'string' && data.length === 1) {
      setQuery(state.query + data);
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
    const createAllowed = Boolean(labelDraft && labelDraft.createAllowed);
    const rows = createAllowed ? names.length + 1 : names.length;
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
      if (createAllowed && state.labelIndex === rows - 1) {
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
      if (!createAllowed) return true;
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
    // S10: a pending write owns the keyboard. No second save, no page or tab
    // move, no typing and no close until the server answers, so the visible
    // busy state is always the truth about what is happening.
    if (state.saving !== null) return;
    // A finished action's notice lives until the next key.
    notice = null;
    if (state.searching) {
      if (handleSearchInput(data)) return;
      return;
    }
    if (state.mode === 'labels') {
      if (handleLabelInput(data)) return;
      return;
    }
    if (state.mode === 'assignees') {
      handleAssigneeInput(data);
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
    // D3: tab selects the bucket; the arrows page the list it shows. S9: a
    // query still inside its debounce window is settled by the operation the
    // reader asked for — the new bucket is read with that query, and a page
    // move can only page the query that was actually read, so it flushes that
    // read instead of firing an old-cursor request later.
    if (keyMatches(helpers, data, ['tab'])) {
      cancelScheduledQuery();
      switchPage(1);
      return;
    }
    if (keyMatches(helpers, data, ['shift+tab'])) {
      cancelScheduledQuery();
      switchPage(-1);
      return;
    }
    if (keyMatches(helpers, data, ['right', ']'])) {
      if (!flushScheduledQuery()) pageList(1);
      return;
    }
    if (keyMatches(helpers, data, ['left', '['])) {
      if (!flushScheduledQuery()) pageList(-1);
      return;
    }
    // Resolve printable paging before a host's case-folding list matcher.
    const scrollAction = scrollKeys.resolveScrollAction(helpers, data);
    if (scrollAction) {
      const page = Math.max(1, bodyRows - 1);
      const half = scrollAction === scrollKeys.ACTIONS.HALF_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_UP;
      const down = scrollAction === scrollKeys.ACTIONS.PAGE_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_DOWN;
      state.scroll = Math.max(0, state.scroll + (down ? 1 : -1) * (half ? Math.max(1, Math.floor(page / 2)) : page));
      repaint();
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
    if (keyMatches(helpers, data, ['end'])) {
      // S8 assigns home/end to first/last issue in the list: the same
      // behaviour as moving the selection (reset the new issue to its top).
      // Preview paging is independent from selecting the first/last issue.
      const total = filteredIssues().length;
      if (total > 0) {
        const span = serverMode && shownCapacity > 0 ? Math.min(total, shownCapacity) : total;
        state.index = span - 1;
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
    if (keyMatches(helpers, data, ['T', '/'])) {
      state.searching = true;
      repaint();
      return;
    }
    if (keyMatches(helpers, data, ['L'])) {
      openLabelEditor();
      return;
    }
    // S16: `a` opens the assignee toggle editor. Both the key and its footer
    // hint require canEditAssignees, so an unpermitted viewer has neither.
    if (keyMatches(helpers, data, ['a'])) {
      openAssigneeEditor();
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
    // S7: Copy is gone, so `y`/`Y` are inert here. The comment discard ask and
    // the close confirmation keep their own `y` inside their own modes.
    if (keyMatches(helpers, data, ['r'])) {
      const reload = actions && typeof actions.reload === 'function' ? actions.reload : null;
      if (serverMode) {
        // S5/S10: refresh re-reads the CURRENT page freshly, and the preview
        // with it, so an edit or comment can never hide behind a cached page —
        // even when the fresh page carries the same rows. S9: a query nobody has
        // read yet IS this refresh — flushing it reads page one of that query
        // once, and never a second time from the cancelled timer.
        if (flushScheduledQuery()) return;
        const bucket = pages[state.page];
        if (!bucket) return;
        const rt = bucketState(bucket);
        requestBucketPage(state.page, rt.page, rt.starts[rt.page - 1] ?? null, { keepSelection: true });
        return;
      }
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
  else if (serverMode) requestBucketPage(state.page, 1, null);

  return { render, handleInput, invalidate, state };
}

module.exports = { createIssuesView, FOOTER_KEYS, SEARCH_KEYS };
