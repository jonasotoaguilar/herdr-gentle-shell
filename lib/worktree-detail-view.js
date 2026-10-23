'use strict';
// Worktree detail view (worktree-ui-redesign T6/T10: S7, S7a, S7b, S7c, S8,
// S11, S12). A PURE full-screen component: one frame that fills the terminal,
// a worktree header, two tabs (Issues / ODD), the list on the left and the
// focused item's preview on the right.
//
// Purity: the only dependency is the existing odd markdown renderer
// (`lib/odd-markdown.js`). This module performs NO filesystem, network or
// registry operation — every read and every write arrives through the
// injected seams below, so the same component serves `/herdr-gentle:worktree`
// (S11) and the warp's `e` (S7) without knowing where the data comes from.
//
// Host contract (identical to lib/issues-view.js): `render(width) -> string[]`,
// `handleInput(data)`, `invalidate()` and the observable `state`.
// `render` returns exactly `rowsAvailable()` rows, each exactly `width` cells.
//
// Options
//   helpers        {visibleWidth, truncateToWidth, matchesKey, isKeyRelease} (all optional)
//   theme          {fg(role, text), bg(role, text), bold(text)} (all optional)
//   rowsAvailable  () => number of terminal rows; defaults to 24
//   requestRender  () => void, called whenever the view wants a repaint
//   done           (result) => void, called ONCE with `null` when `esc` closes
//   worktree       {name, path, branch, changes, ahead, behind, created, modified}
//                  `created`/`modified` are relative age strings supplied by the
//                  caller ('1d', '2hr'); a finite epoch-ms number is also
//                  accepted and rendered as the same short relative form.
//                  Nothing is invented: an absent value is simply not shown.
//   issues         [{number, title, state, ...}] every issue the caller knows;
//                  only `state === 'open'` ones (absent state counts as open)
//                  are listed, and every other field is previewed when present
//   assignedIssues [number] the worktree's current assignment
//   documents      [{name, path, text?}] every ODD document of the checkout;
//                  `path` is the document identity shared with `odd`;
//                  `text` skips `loadDocument` when the caller already has it
//   odd            string|null the ONE associated document (S8), matched
//                  against a document's `path`, then its `name`
//   loadIssue      (number) -> {ok:true, issue} | {ok:false, error} | issue
//   loadDocument   (path) -> {ok:true, text} | {ok:false, error} | string
//   save           ({issues: number[], odd: string|null}) -> {ok:true} | {ok:false, error}
//
// `loadIssue`, `loadDocument` and `save` may return a value or a promise and
// may throw; every outcome (success, failure, thrown, never-settling is the
// caller's concern) is shown honestly and never leaves a fake row behind.
//
// Behaviour
//   - `tab`/`shift+tab` switch tabs; the footer legend is ONE row at every
//     width (it compacts to short tokens, then drops its lowest-priority key,
//     and the spelled `tab Issues/ODD` · `←/→ page` distinction outlives both
//     tiers because those two keys were the reported confusion).
//   - Issues tab: open issues only, assigned first, then descending number
//     (S7c). `space` toggles the focused issue; an assigned issue whose row is
//     closed or missing is dropped from the selection (S7d), never kept.
//   - ODD tab: every document. `space` selects the focused one (pressing it
//     again clears the association) and `enter` selects only; the selection is
//     always ONE value or null, never a list (S8, L11).
//   - Preview scrolls with `ctrl+j`/`ctrl+k`, `pgDn`/`pgUp`, `ctrl+d`/`ctrl+u`
//     and `J`/`K` (S15 variants); lowercase `j`/`k` move the list.
//   - `T` or `/` filters the CURRENT tab (`enter`/`esc` leave the box).
//   - `ctrl+s` saves; the status row reports `saving…`, `● unsaved`, `saved`
//     or `save failed: <reason>`. A failed save changes nothing locally: the
//     selection stays exactly as the reader left it.
//
// Payload of `save`: `issues` is the selection sorted ascending, `odd` is the
// selected document's `path` (or the caller's own association string when no
// document matched it), or `null` when it was cleared.
//
// `state` (observable): `tab` ('issues'|'odd'), `cursor`/`scroll`/`query`
// keyed by tab, `searching`, `issues` (number[]), `odd` (string|null),
// `saving`, `dirty`, `saveError`, `notice`.

const { renderOddMarkdown, stripAnsi } = require('./odd-markdown.js');
const layout = require('./view-layout.js');

const CARD_PADDING = 4;
const LIST_MAX_WIDTH = 34;
// Below FRAMED_MIN_WIDTH even the two border cells do not fit, so the frame is
// dropped rather than overflowing; below TWO_PANE_MIN_WIDTH a right pane would
// be unusable, so the list takes the whole body.
const FRAMED_MIN_WIDTH = 8;
const TWO_PANE_MIN_WIDTH = 24;
const DEFAULT_ROWS = 24;

// S15: ctrl+j/ctrl+k are not delivered by every terminal, so the preview also
// scrolls half a page on ctrl+d/ctrl+u and on the shifted letters. `j`/`k`
// stay the list-selection keys: the shifted ids are their own bindings, so a
// loose case fallback must never let `J`/`K` answer for them.
const HALF_PAGE_DOWN = ['ctrl+d', 'J', 'shift+j'];
const HALF_PAGE_UP = ['ctrl+u', 'K', 'shift+k'];
const SHIFTED_TWINS = new Set(HALF_PAGE_DOWN.concat(HALF_PAGE_UP)
  .filter((name) => name.length === 1 && name >= 'A' && name <= 'Z')
  .map((name) => name.toLowerCase()));

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

// S2: a legend stays on ONE row. The full text is used while it fits, then the
// short tokens, then the lowest-priority keys are dropped (display order never
// changes and no token carries a newline), so the footer never wraps.
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

// Raw fallbacks for the keys this view binds, mirroring the bytes a legacy
// terminal sends, so the detail stays drivable when the host helper module
// failed to resolve (a full-screen surface that ignores Esc reads as frozen —
// the same rule lib/odd-view.js and lib/warp-selector-view.js follow).
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  tab: ['\t'],
  'shift+tab': ['\x1b[Z'],
  enter: ['\r', '\n'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  'ctrl+s': ['\x13'],
  'ctrl+j': ['\n'],
  'ctrl+k': ['\x0b'],
  'ctrl+d': ['\x04'],
  'ctrl+u': ['\x15'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
  pageup: ['\x1b[5~'],
  pagedown: ['\x1b[6~'],
};

function keyMatches(helpers, data, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
    } catch {
      // A throwing matcher never matches; the string fallback decides below.
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    for (const name of names) {
      const raw = RAW_KEY_BYTES[String(name).toLowerCase()];
      if (raw && raw.includes(data)) return true;
    }
  }
  const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  return names.some((name) => sameKeyName(text, name));
}

// Key ids are loose about case because hosts spell them differently; only a
// shifted letter whose unshifted twin is a live binding stays case-sensitive.
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

// S15: a compact preview shows a short value or nothing — never the reason a
// value is missing. A caller that hands over an explanation gets the brief
// unavailable marker instead of the sentence.
const CONCISE_MAX = 12;
function ageText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    return [...trimmed].length > CONCISE_MAX ? '—' : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return relativeAge(value);
  return null;
}

function relativeAge(epochMs) {
  const delta = Date.now() - epochMs;
  if (!Number.isFinite(delta) || delta < 0) return 'now';
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}hr`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}m`;
  return `${Math.floor(days / 365)}y`;
}

function changesText(changes) {
  const count = Number(changes);
  if (!Number.isFinite(count)) return null;
  return `${count} ${count === 1 ? 'change' : 'changes'}`;
}

function issueNumberOf(row) {
  const number = Number(row && row.number);
  return Number.isFinite(number) ? number : NaN;
}

// `gh`'s absent state means open; the detail lists nothing else (S7c).
function issueIsOpen(row) {
  return String((row && row.state) || 'open') === 'open';
}

function docId(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (typeof doc.path === 'string' && doc.path.length > 0) return doc.path;
  if (typeof doc.name === 'string' && doc.name.length > 0) return doc.name;
  return null;
}

function docName(doc) {
  if (doc && typeof doc.name === 'string' && doc.name.length > 0) return doc.name;
  const id = docId(doc);
  return id ? id.split(/[\\/]/).pop().replace(/\.md$/i, '') : '(document)';
}

// The association is ONE value matched against a document's `path` first and
// its `name` second, so a caller may pass either spelling (S8).
function sameDoc(association, doc) {
  if (typeof association !== 'string' || association.length === 0) return false;
  const id = docId(doc);
  if (id && association === id) return true;
  const name = doc && typeof doc.name === 'string' ? doc.name : null;
  if (name && association === name) return true;
  const base = id ? id.split(/[\\/]/).pop() : null;
  if (base && association === base) return true;
  if (name && `${name}.md` === association.split(/[\\/]/).pop()) return true;
  return false;
}

function matchesQuery(values, query) {
  const tokens = String(query || '').split(/\s+/).map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = values.filter((value) => value != null).join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

// Seams may answer synchronously or with a promise (and may throw); a sync
// answer settles immediately so the first paint already shows it, and only a
// real thenable waits for a microtask.
function settleSeam(pending, onValue, onError) {
  if (pending && typeof pending.then === 'function') {
    pending.then(onValue).catch((err) => onError((err && err.message) || 'failed'));
    return;
  }
  onValue(pending);
}

function normalizeIssueResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'issue unreadable' };
  if (result.ok === false) return { ok: false, error: String(result.error || 'issue unreadable') };
  if (result.ok === true) {
    if (result.issue && typeof result.issue === 'object') return { ok: true, issue: result.issue };
    return { ok: false, error: 'issue unreadable' };
  }
  // A bare issue object is accepted as its own preview.
  if (Number.isFinite(issueNumberOf(result)) || typeof result.title === 'string') {
    return { ok: true, issue: result };
  }
  return { ok: false, error: 'issue unreadable' };
}

function normalizeDocumentResult(result) {
  if (typeof result === 'string') return { ok: true, text: result };
  if (!result || typeof result !== 'object') return { ok: false, error: 'document unreadable' };
  if (result.ok === false) return { ok: false, error: String(result.error || 'document unreadable') };
  if (result.ok === true && typeof result.text === 'string') return { ok: true, text: result.text };
  if (typeof result.text === 'string') return { ok: true, text: result.text };
  return { ok: false, error: 'document unreadable' };
}

function createWorktreeDetailView(options = {}) {
  const {
    helpers = null,
    theme = null,
    rowsAvailable = null,
    requestRender = null,
    done = null,
    loadIssue = null,
    loadDocument = null,
    save = null,
  } = options;

  const worktree = options.worktree && typeof options.worktree === 'object' ? options.worktree : {};
  const documents = (Array.isArray(options.documents) ? options.documents : [])
    .filter((doc) => doc && typeof doc === 'object' && docId(doc));
  // S7c/S7d: one open row per issue number, so a closed or deleted issue can
  // never be listed — and therefore never stay assigned.
  const openIssues = [];
  const openByNumber = new Map();
  for (const row of Array.isArray(options.issues) ? options.issues : []) {
    const number = issueNumberOf(row);
    if (!Number.isFinite(number) || !issueIsOpen(row) || openByNumber.has(number)) continue;
    openByNumber.set(number, row);
    openIssues.push(row);
  }

  // The associated document normalizes to the document identity the caller can
  // save; an association no document matches is kept verbatim instead of being
  // silently dropped (S8b).
  const initialOddDoc = documents.find((doc) => sameDoc(options.odd, doc)) || null;
  const initialOdd = initialOddDoc ? docId(initialOddDoc) : (typeof options.odd === 'string' && options.odd.length > 0 ? options.odd : null);

  const initialIssues = [];
  for (const entry of Array.isArray(options.assignedIssues) ? options.assignedIssues : []) {
    const number = Number(entry);
    if (Number.isFinite(number) && openByNumber.has(number) && !initialIssues.includes(number)) {
      initialIssues.push(number);
    }
  }
  initialIssues.sort((left, right) => left - right);

  let savedIssues = initialIssues.slice();
  let savedOdd = initialOdd;

  const state = {
    tab: 'issues',
    cursor: { issues: 0, odd: 0 },
    scroll: { issues: 0, odd: 0 },
    page: { issues: 1, odd: 1 },
    query: { issues: '', odd: '' },
    searching: false,
    issues: initialIssues.slice(),
    odd: initialOdd,
    saving: false,
    dirty: false,
    saveError: null,
    refreshing: false,
    refreshError: null,
    notice: null,
  };

  const issueCache = new Map();
  const docCache = new Map();
  let bodyRows = 1;
  // Preview length of the last frame per tab, so a scroll key can clamp before
  // the next repaint instead of leaving an out-of-range offset in `state`.
  const previewRows = { issues: 0, odd: 0 };
  // The list pane width of the last frame, so a key press pages against the
  // layout the reader is looking at.
  let listWidthCache = LIST_MAX_WIDTH;
  // A closed view repaints nothing, and a late loader answer never paints.
  let active = true;

  const activeTab = () => state.tab;

  function isDirty() {
    if (state.odd !== savedOdd) return true;
    if (state.issues.length !== savedIssues.length) return true;
    return state.issues.some((number, at) => number !== savedIssues[at]);
  }

  function syncDirty() {
    state.dirty = isDirty();
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
    return DEFAULT_ROWS;
  }

  function repaint() {
    if (!active) return;
    try {
      if (typeof requestRender === 'function') requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function close() {
    active = false;
    if (typeof done === 'function') done(null);
  }

  // Ascending order is what `save` reports, so the payload is stable no matter
  // the order the reader toggled the issues in.
  function sortIssues() {
    state.issues.sort((left, right) => left - right);
  }

  function issueList() {
    const query = state.query.issues;
    const rows = openIssues.filter((row) => matchesQuery([`#${issueNumberOf(row)}`, row.title], query));
    return rows.slice().sort((left, right) => {
      const leftNumber = issueNumberOf(left);
      const rightNumber = issueNumberOf(right);
      const leftAssigned = state.issues.includes(leftNumber) ? 1 : 0;
      const rightAssigned = state.issues.includes(rightNumber) ? 1 : 0;
      if (leftAssigned !== rightAssigned) return rightAssigned - leftAssigned;
      return rightNumber - leftNumber;
    });
  }

  function documentList() {
    const query = state.query.odd;
    return documents.filter((doc) => matchesQuery([docName(doc), docId(doc)], query));
  }

  function currentList() {
    return activeTab() === 'issues' ? issueList() : documentList();
  }

  function currentEntry() {
    const list = currentList();
    const cursor = state.cursor[activeTab()];
    return list[cursor] || null;
  }

  function ensureIssue(row, options = {}) {
    const number = issueNumberOf(row);
    if (!Number.isFinite(number)) return { status: 'ready', issue: row, error: null };
    let entry = issueCache.get(number);
    if (entry && options.refresh !== true) return entry;
    entry = { status: typeof loadIssue === 'function' ? 'loading' : 'ready', issue: row, error: null };
    issueCache.set(number, entry);
    if (typeof loadIssue !== 'function') return entry;
    let pending;
    try {
      pending = loadIssue(number, options.refresh === true ? { refresh: true } : undefined);
    } catch (err) {
      entry.status = 'error';
      entry.error = (err && err.message) || 'issue unreadable';
      return entry;
    }
    const settle = (result) => {
      const normalized = normalizeIssueResult(result);
      if (normalized.ok) {
        entry.status = 'ready';
        entry.issue = normalized.issue;
        entry.error = null;
      } else {
        entry.status = 'error';
        entry.error = normalized.error;
      }
      repaint();
    };
    settleSeam(pending, settle, (error) => settle({ ok: false, error }));
    return entry;
  }

  function ensureDocument(doc, options = {}) {
    const id = docId(doc);
    let entry = docCache.get(id);
    if (entry && options.refresh !== true) return entry;
    if (typeof doc.text === 'string') {
      entry = { status: 'ready', text: doc.text, error: null };
      docCache.set(id, entry);
      return entry;
    }
    if (typeof loadDocument !== 'function') {
      entry = { status: 'error', text: '', error: 'document text is unavailable' };
      docCache.set(id, entry);
      return entry;
    }
    entry = { status: 'loading', text: '', error: null };
    docCache.set(id, entry);
    let pending;
    try {
      pending = loadDocument(id, options.refresh === true ? { refresh: true } : undefined);
    } catch (err) {
      entry.status = 'error';
      entry.error = (err && err.message) || 'document unreadable';
      return entry;
    }
    const settle = (result) => {
      const normalized = normalizeDocumentResult(result);
      if (normalized.ok) {
        entry.status = 'ready';
        entry.text = normalized.text;
        entry.error = null;
        entry.lines = null;
      } else {
        entry.status = 'error';
        entry.error = normalized.error;
      }
      repaint();
    };
    settleSeam(pending, settle, (error) => settle({ ok: false, error }));
    return entry;
  }

  function issuePreviewLines(row, width) {
    const entry = ensureIssue(row);
    if (entry.status === 'error') return [paint(theme, 'error', `unreadable: ${entry.error}`)];
    if (entry.status !== 'ready') return [paint(theme, 'muted', 'loading…')];
    const detail = entry.issue || row;
    const number = issueNumberOf(detail);
    const lines = [emphasize(theme, `#${number} ${detail.title || '(no title)'}`)];
    const flags = [paint(theme, detail.state === 'closed' ? 'muted' : 'accent', `[${detail.state || 'open'}]`)];
    flags.push(paint(theme, 'muted', state.issues.includes(number) ? 'assigned to this worktree' : 'not assigned'));
    lines.push(flags.join(' · '));
    const labels = (Array.isArray(detail.labels) ? detail.labels : [])
      .map((label) => (typeof label === 'string' ? label : label && label.name))
      .filter(Boolean);
    if (labels.length > 0) lines.push(`labels: ${labels.join(', ')}`);
    if (detail.author) lines.push(`by ${detail.author}`);
    lines.push('');
    const out = [];
    for (const line of lines) out.push(...wrapText(line, width));
    out.push(...wrapText(detail.body || '(no description)', width));
    return out;
  }

  function documentPreviewLines(doc, width) {
    const entry = ensureDocument(doc);
    if (entry.status === 'error') return [paint(theme, 'error', `unreadable: ${entry.error}`)];
    if (entry.status !== 'ready') return [paint(theme, 'muted', 'loading…')];
    if (entry.lines && entry.linesWidth === width) return entry.lines;
    const rendered = renderOddMarkdown(entry.text, {
      width,
      paint: (role, value) => paint(theme, role, value),
      emphasis: (value) => emphasize(theme, value),
      measure: (value) => measure(helpers, value),
    });
    entry.lines = rendered.length > 0 ? rendered : [paint(theme, 'muted', '(empty document)')];
    entry.linesWidth = width;
    return entry.lines;
  }

  function previewLines(width) {
    const tab = activeTab();
    const query = state.query[tab];
    const emptyNote = tab === 'issues'
      ? (query ? 'no issues match this search' : 'no open issues')
      : (query ? 'no documents match this search' : 'no odd documents');
    const entry = currentEntry();
    if (!entry) return [paint(theme, 'muted', emptyNote)];
    return tab === 'issues' ? issuePreviewLines(entry, width) : documentPreviewLines(entry, width);
  }

  function clampCursor(tab, total) {
    let cursor = state.cursor[tab];
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
    if (cursor >= total) cursor = Math.max(0, total - 1);
    state.cursor[tab] = cursor;
  }

  function clampScroll(tab, total) {
    const max = Math.max(0, total - Math.max(1, bodyRows));
    if (state.scroll[tab] > max) state.scroll[tab] = max;
    if (state.scroll[tab] < 0) state.scroll[tab] = 0;
  }

  // S3: the list row carries the title alone — the number lives in the preview
  // and the assigned numbers live in the header — so the wrapped title has
  // every cell of the expanded panel.
  function listLabel(tab, entry) {
    if (tab === 'issues') {
      const number = issueNumberOf(entry);
      const assigned = state.issues.includes(number) ? '[x]' : '[ ]';
      return `${assigned} ${String(entry.title || '')}`;
    }
    const associated = sameDoc(state.odd, entry) ? '●' : '○';
    return `${associated} ${docName(entry)}`;
  }

  // S5/D3: the list pages by the rows its wrapped titles actually need against
  // the body budget, so capacity follows the terminal instead of a fixed count.
  function listPages(tab, width) {
    const list = currentList();
    clampCursor(tab, list.length);
    const costs = list.map((entry) => layout.rowCost(helpers, listLabel(tab, entry), width, { first: '▸ ' }));
    return { list, pages: layout.paginate(costs, bodyRows) };
  }

  function syncListPage(tab, width) {
    const { list, pages } = listPages(tab, width);
    const found = layout.pageForIndex(pages, state.cursor[tab]);
    state.page[tab] = found.page;
    return { list, pages, page: found.bounds, pageCount: pages.length };
  }

  // D3: left/right page the ACTIVE list only; the tab keys own the dataset.
  function pageList(step) {
    const tab = activeTab();
    const { pages } = listPages(tab, listWidthCache);
    const page = Math.max(1, Math.min(pages.length, (state.page[tab] || 1) + step));
    const bounds = pages[page - 1];
    if (!bounds || bounds.end <= bounds.start) return;
    if (page === state.page[tab]) return;
    state.page[tab] = page;
    state.cursor[tab] = bounds.start;
    state.scroll[tab] = 0;
    repaint();
  }

  function tabsText() {
    const entries = [
      { id: 'issues', label: `Issues (${openIssues.length})` },
      { id: 'odd', label: `ODD (${documents.length})` },
    ];
    return entries.map((entry) => {
      const label = entry.id === activeTab() ? `▸ ${entry.label}` : entry.label;
      return entry.id === activeTab() ? emphasize(theme, label) : paint(theme, 'muted', label);
    }).join(paint(theme, 'border', ' │ '));
  }

  function factsText() {
    const parts = [];
    const branch = typeof worktree.branch === 'string' && worktree.branch.length > 0 ? worktree.branch : null;
    if (branch) parts.push(`branch ${branch}`);
    const changes = changesText(worktree.changes);
    if (changes) parts.push(changes);
    const ahead = Number(worktree.ahead);
    const behind = Number(worktree.behind);
    const moves = [];
    if (Number.isFinite(ahead)) moves.push(`↑${ahead}`);
    if (Number.isFinite(behind)) moves.push(`↓${behind}`);
    if (moves.length > 0) moves.push('commits');
    if (moves.length > 1) parts.push(moves.join(' '));
    const created = ageText(worktree.created);
    if (created) parts.push(`created ${created}`);
    const modified = ageText(worktree.modified);
    if (modified) parts.push(`modified ${modified}`);
    return parts.length > 0 ? parts.join(' · ') : 'no worktree data supplied';
  }

  // S11: the header separates three logical data rows — the worktree details,
  // the ONE assigned ODD document (name and path) and the assigned issue
  // numbers (comma-separated, wrapping when there are many) — and each expands
  // to as many terminal rows as it needs instead of being truncated.
  function oddSummary() {
    if (typeof state.odd !== 'string' || state.odd.length === 0) return '';
    const doc = documents.find((entry) => sameDoc(state.odd, entry)) || null;
    const where = doc ? docId(doc) : state.odd;
    const name = doc ? docName(doc) : String(where).split(/[\\/]/).pop().replace(/\.md$/i, '');
    return where && where !== name ? `odd ${name} ─ ${where}` : `odd ${name}`;
  }

  function numbersSummary() {
    const numbers = state.issues.slice().sort((left, right) => left - right);
    return numbers.length === 0 ? '' : `issues ${numbers.join(', ')}`;
  }

  function headerLines(width) {
    const rows = [];
    for (const text of [factsText(), oddSummary(), numbersSummary()]) {
      if (!text) continue;
      rows.push(...layout.wrapLabel(helpers, text, width, { first: '', rest: '' }));
    }
    return rows;
  }

  function statusText(pageMark) {
    const query = state.query[activeTab()];
    const search = state.searching
      ? `› ${query}█`
      : (query ? `› ${query}` : '› Search');
    const notes = [];
    syncDirty();
    if (state.dirty) notes.push(paint(theme, 'accent', '● unsaved'));
    if (state.saveError) notes.push(paint(theme, 'error', `save failed: ${state.saveError}`));
    else if (state.saving) notes.push(paint(theme, 'muted', 'saving…'));
    else if (state.notice) notes.push(paint(theme, 'accent', state.notice));
    if (state.refreshError) notes.push(paint(theme, 'error', `refresh failed: ${state.refreshError}`));
    else if (state.refreshing) notes.push(paint(theme, 'muted', 'refreshing…'));
    if (pageMark) notes.push(paint(theme, 'muted', pageMark));
    const text = notes.length > 0 ? `${search} · ${notes.join(' · ')}` : search;
    return state.searching ? paint(theme, 'accent', text) : text;
  }

  // One footer row per tab: the hint says what `space` does HERE, and no other
  // row repeats a key hint or a count (S13). S11: Tab and the paging arrows are
  // spelled apart in BOTH tiers — a bare `tab`/`←/→` token would hide which key
  // switches datasets and which one pages — and they outrank every other hint so
  // compaction never eats the distinction the reader was confused about.
  function footerKeys() {
    return [
      { text: '↑↓ move', short: '↑↓', priority: 80 },
      { text: 'tab Issues/ODD', short: 'tab Issues/ODD', priority: 105 },
      { text: '←/→ page', short: '←/→ page', priority: 110 },
      { text: activeTab() === 'issues' ? 'space assign' : 'space select', short: 'space', priority: 90 },
      { text: 'ctrl+j/k scroll', short: '⌃j/k', priority: 50 },
      { text: 'T search', short: 'T', priority: 70 },
      { text: 'r refresh', short: 'r', priority: 60 },
      { text: 'ctrl+s save', short: 'ctrl+s', priority: 95 },
      { text: 'esc', short: 'esc', priority: 120 },
    ];
  }

  // Rows that are always present: the top border and the body. Everything else
  // appears only when the terminal has room, so a tiny height still returns
  // exactly the rows it was given. The header is the flexible row set: it takes
  // what it needs while at least one body row survives (S11).
  function rowPlan(height, headerCount) {
    const plan = {
      tabs: height >= 6,
      status: height >= 5,
      footer: height >= 4,
      bottom: height >= 2,
    };
    const chrome = 1
      + (plan.tabs ? 1 : 0)
      + (plan.status ? 1 : 0)
      + (plan.footer ? 1 : 0)
      + (plan.bottom ? 1 : 0);
    const room = Math.max(0, height - chrome);
    plan.header = Math.max(0, Math.min(headerCount, room > 0 ? room - 1 : 0));
    plan.body = Math.max(0, room - plan.header);
    return plan;
  }

  function render(width) {
    const w = Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    syncDirty();

    const framed = w >= FRAMED_MIN_WIDTH;
    const twoPane = framed && w >= TWO_PANE_MIN_WIDTH;
    const inner = framed ? Math.max(1, w - CARD_PADDING) : w;
    const border = (text) => paint(theme, 'border', text);
    const divider = border('│');
    const cell = (content) => (framed ? `${divider} ${pad(helpers, content, inner)} ${divider}` : pad(helpers, content, inner));

    // S11: three logical header rows, each wrapping to the rows it needs.
    const header = headerLines(inner);
    const plan = rowPlan(height, header.length);
    bodyRows = plan.body;

    const lines = [];
    const name = typeof worktree.name === 'string' && worktree.name.length > 0 ? worktree.name : 'worktree';
    const pathText = typeof worktree.path === 'string' && worktree.path.length > 0 ? worktree.path : '';
    const title = `◈ ${name}${pathText ? ` ─ ${pathText}` : ''}`;
    if (framed) {
      const shown = fit(helpers, title, Math.max(1, w - 5));
      const head = `${border('╭─')} ${paint(theme, 'accent', shown)} `;
      const fill = Math.max(0, w - measure(helpers, head) - 1);
      lines.push(`${head}${border('─'.repeat(fill))}${border('╮')}`);
    } else {
      lines.push(pad(helpers, paint(theme, 'accent', title), inner));
    }

    for (let at = 0; at < plan.header; at += 1) lines.push(cell(paint(theme, 'muted', header[at])));

    // The list geometry is resolved before the status row so its page mark can
    // report the page the reader is on.
    const tab = activeTab();
    const panes = twoPane ? layout.paneWidths(inner) : { left: inner, right: 0 };
    const listWidth = panes.left;
    listWidthCache = listWidth;
    const paged = bodyRows > 0 ? syncListPage(tab, listWidth) : { list: currentList(), page: { start: 0, end: 0 }, pageCount: 1 };
    const pageMark = paged.pageCount > 1 ? `page ${state.page[tab]}/${paged.pageCount}` : '';

    if (plan.tabs) lines.push(cell(tabsText()));
    if (plan.status) lines.push(cell(statusText(pageMark)));

    if (bodyRows > 0) {
      const leftLines = [];
      for (let at = paged.page.start; at < paged.page.end; at += 1) {
        const focused = at === state.cursor[tab];
        const rows = layout.wrapLabel(helpers, listLabel(tab, paged.list[at]), listWidth, { first: focused ? '▸ ' : '  ' });
        for (const row of rows) leftLines.push(highlight(theme, pad(helpers, row, listWidth), focused));
      }
      const rightSource = twoPane ? previewLines(panes.right) : [];
      previewRows[tab] = twoPane ? rightSource.length : 0;
      if (twoPane) clampScroll(tab, rightSource.length);
      const visible = twoPane ? rightSource.slice(state.scroll[tab], state.scroll[tab] + bodyRows) : [];
      for (let row = 0; row < bodyRows; row += 1) {
        const left = pad(helpers, leftLines[row] ?? '', listWidth);
        if (!twoPane) {
          lines.push(cell(left));
          continue;
        }
        lines.push(cell(`${left} ${divider} ${pad(helpers, visible[row] ?? '', panes.right)}`));
      }
    }

    if (plan.footer) lines.push(cell(paint(theme, 'muted', legendText(helpers, footerKeys(), inner))));
    if (plan.bottom) lines.push(border(`╰${'─'.repeat(Math.max(0, w - 2))}╯`));
    return lines.map((line) => pad(helpers, line, w));
  }

  function resetForFilter(tab) {
    state.cursor[tab] = 0;
    state.scroll[tab] = 0;
    state.page[tab] = 1;
  }

  function move(step) {
    const tab = activeTab();
    const total = currentList().length;
    if (total === 0) return;
    const cursor = state.cursor[tab];
    state.cursor[tab] = (cursor + step + total) % total;
    state.scroll[tab] = 0;
    repaint();
  }

  function switchTab() {
    // Two tabs: `tab` and `shift+tab` both move to the other one.
    state.tab = state.tab === 'issues' ? 'odd' : 'issues';
    state.searching = false;
    repaint();
  }

  function toggleIssue(number) {
    const set = new Set(state.issues);
    if (set.has(number)) set.delete(number);
    else set.add(number);
    state.issues = [...set];
    sortIssues();
    // The list re-sorts, so the cursor follows the issue it was on.
    const at = issueList().findIndex((row) => issueNumberOf(row) === number);
    if (at >= 0) state.cursor.issues = at;
    state.scroll.issues = 0;
    state.notice = null;
    syncDirty();
    repaint();
  }

  function selectDocument(doc, clearIfSame) {
    const id = docId(doc);
    if (!id) return;
    const associated = sameDoc(state.odd, doc);
    state.odd = clearIfSame && associated ? null : id;
    state.notice = null;
    syncDirty();
    repaint();
  }

  function activateFocused(clearIfSame) {
    const entry = currentEntry();
    if (!entry) return;
    if (activeTab() === 'issues') toggleIssue(issueNumberOf(entry));
    else selectDocument(entry, clearIfSame);
  }

  // The offset is clamped in the same turn as the key: `state.scroll` may be
  // observed (and repainted) before the next frame, so a negative or past-the-
  // end value would be a lie the reader can see.
  function scrollBy(step) {
    const tab = activeTab();
    const total = previewRows[tab];
    let next = state.scroll[tab] + step;
    if (!Number.isFinite(next) || next < 0) next = 0;
    if (total > 0) {
      const max = Math.max(0, total - Math.max(1, bodyRows));
      if (next > max) next = max;
    }
    state.scroll[tab] = next;
    repaint();
  }

  // S10: `r` re-reads the focused item from its source and replaces the cached
  // promise, so the preview can never keep showing a stale read as if it were
  // refreshed. A failure is named in the status row AND in the pane.
  function refreshNow() {
    const tab = activeTab();
    const entry = currentEntry();
    if (!entry) return;
    state.refreshing = true;
    state.refreshError = null;
    const settleFailure = (error) => {
      state.refreshing = false;
      state.refreshError = error;
      repaint();
    };
    const settleSuccess = () => {
      state.refreshing = false;
      state.refreshError = null;
      repaint();
    };
    if (tab === 'issues') {
      if (typeof loadIssue !== 'function') {
        settleFailure('issue refresh is unavailable');
        return;
      }
      const number = issueNumberOf(entry);
      if (!Number.isFinite(number)) return;
      const cached = { status: 'loading', issue: entry, error: null };
      issueCache.set(number, cached);
      repaint();
      let pending;
      try {
        pending = loadIssue(number, { refresh: true });
      } catch (err) {
        cached.status = 'error';
        cached.error = (err && err.message) || 'issue unreadable';
        settleFailure(cached.error);
        return;
      }
      const settle = (result) => {
        const normalized = normalizeIssueResult(result);
        if (normalized.ok) {
          cached.status = 'ready';
          cached.issue = normalized.issue;
          cached.error = null;
          settleSuccess();
          return;
        }
        cached.status = 'error';
        cached.error = normalized.error;
        settleFailure(normalized.error);
      };
      settleSeam(pending, settle, (error) => settle({ ok: false, error }));
      return;
    }
    if (typeof loadDocument !== 'function') {
      settleFailure('document refresh is unavailable');
      return;
    }
    const id = docId(entry);
    if (!id) return;
    const cached = { status: 'loading', text: '', error: null };
    docCache.set(id, cached);
    repaint();
    let pending;
    try {
      pending = loadDocument(id, { refresh: true });
    } catch (err) {
      cached.status = 'error';
      cached.error = (err && err.message) || 'document unreadable';
      settleFailure(cached.error);
      return;
    }
    const settle = (result) => {
      const normalized = normalizeDocumentResult(result);
      if (normalized.ok) {
        cached.status = 'ready';
        cached.text = normalized.text;
        cached.error = null;
        cached.lines = null;
        settleSuccess();
        return;
      }
      cached.status = 'error';
      cached.error = normalized.error;
      settleFailure(normalized.error);
    };
    settleSeam(pending, settle, (error) => settle({ ok: false, error }));
  }

  function saveNow() {
    // One write at a time: a second ctrl+s while the first is in flight would
    // duplicate it instead of making the result truer.
    if (state.saving) return;
    if (typeof save !== 'function') {
      state.saveError = 'saving is unavailable';
      state.notice = null;
      syncDirty();
      repaint();
      return;
    }
    const payload = { issues: state.issues.slice(), odd: state.odd };
    state.saving = true;
    state.saveError = null;
    state.notice = null;
    repaint();
    const settle = (result) => {
      state.saving = false;
      if (result && result.ok === true) {
        savedIssues = payload.issues.slice();
        savedOdd = payload.odd;
        state.notice = 'saved';
        state.saveError = null;
      } else {
        // The reader's selection stays exactly as it was: a failed write must
        // not silently discard or apply anything.
        state.notice = null;
        state.saveError = (result && result.error) ? String(result.error) : 'save failed';
      }
      syncDirty();
      repaint();
    };
    let pending;
    try {
      pending = save({ issues: payload.issues.slice(), odd: payload.odd });
    } catch (err) {
      pending = { ok: false, error: (err && err.message) || 'save failed' };
    }
    settleSeam(pending, settle, (error) => settle({ ok: false, error }));
  }

  function handleSearchInput(data) {
    const tab = activeTab();
    if (keyMatches(helpers, data, ['enter', 'escape'])) {
      state.searching = false;
      repaint();
      return true;
    }
    if (keyMatches(helpers, data, ['backspace'])) {
      state.query[tab] = state.query[tab].slice(0, -1);
      resetForFilter(tab);
      repaint();
      return true;
    }
    if (typeof data === 'string' && data.length === 1 && data >= ' ') {
      state.query[tab] += data;
      resetForFilter(tab);
      repaint();
      return true;
    }
    return false;
  }

  function handleInput(data) {
    if (isKeyRelease(helpers, data)) return;
    if (state.searching) {
      if (handleSearchInput(data)) return;
      return;
    }
    state.notice = null;
    if (keyMatches(helpers, data, ['escape', 'ctrl+c'])) {
      close();
      return;
    }
    if (keyMatches(helpers, data, ['tab'])) {
      switchTab();
      return;
    }
    if (keyMatches(helpers, data, ['shift+tab'])) {
      switchTab();
      return;
    }
    if (keyMatches(helpers, data, ['ctrl+s'])) {
      saveNow();
      return;
    }
    if (keyMatches(helpers, data, ['down', 'j'])) {
      move(1);
      return;
    }
    if (keyMatches(helpers, data, ['up', 'k'])) {
      move(-1);
      return;
    }
    // D3: left/right page the ACTIVE list and never switch tabs.
    if (keyMatches(helpers, data, ['right'])) {
      pageList(1);
      return;
    }
    if (keyMatches(helpers, data, ['left'])) {
      pageList(-1);
      return;
    }
    // S1: the scroll keys are resolved BEFORE the `enter` alias. The installed
    // host matcher reports the same 0x0a byte as both `ctrl+j` and `enter`
    // while the Kitty protocol is inactive (the terminal the user reported),
    // so an earlier `enter` branch made ctrl+j unreachable and the preview
    // looked frozen. `\r` still matches enter alone, so a real Enter keeps
    // selecting.
    const page = Math.max(1, bodyRows - 1);
    if (keyMatches(helpers, data, ['ctrl+j', 'pagedown'])) {
      scrollBy(page);
      return;
    }
    if (keyMatches(helpers, data, ['ctrl+k', 'pageup'])) {
      scrollBy(-page);
      return;
    }
    const half = Math.max(1, Math.floor(page / 2));
    if (keyMatches(helpers, data, HALF_PAGE_DOWN)) {
      scrollBy(half);
      return;
    }
    if (keyMatches(helpers, data, HALF_PAGE_UP)) {
      scrollBy(-half);
      return;
    }
    if (keyMatches(helpers, data, ['space', ' '])) {
      activateFocused(true);
      return;
    }
    if (keyMatches(helpers, data, ['enter'])) {
      if (activeTab() === 'odd') activateFocused(false);
      return;
    }
    // S10: `r` refreshes the preview of the focused item from its source.
    if (keyMatches(helpers, data, ['r'])) {
      refreshNow();
      return;
    }
    if (keyMatches(helpers, data, ['T', '/'])) {
      state.searching = true;
      repaint();
    }
  }

  function invalidate() {}

  syncDirty();

  return { render, handleInput, invalidate, state };
}

module.exports = { createWorktreeDetailView };
