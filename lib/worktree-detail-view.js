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
// `handleInput(data)`, `invalidate()`, the post-mount `apply(partial)` seam and
// the observable `state`.
// `render` returns exactly `rowsAvailable()` rows, each exactly `width` cells.
//
// Options
//   helpers        {visibleWidth, truncateToWidth, matchesKey, parseKey,
//                  isKeyRelease, isKittyProtocolActive} (all optional)
//   theme          {fg(role, text), bg(role, text), bold(text)} (all optional)
//   rowsAvailable  () => number of terminal rows; defaults to 24
//   requestRender  () => void, called whenever the view wants a repaint
//   done           (result) => void, called AT MOST ONCE with `null` when `esc`
//                  closes. After it fires the view is closed for good: input,
//                  `apply`, late reads and saves are refused, nothing repaints
//                  and `done` is never called again (S18).
//   worktree       {name, path, branch, changes, ahead, behind, created, modified}
//                  `created`/`modified` are relative age strings supplied by the
//                  caller ('1d', '2hr'); a finite epoch-ms number is also
//                  accepted and rendered as the same short relative form.
//                  Nothing is invented: an absent value is simply not shown.
//   issues         array of issue rows, or `null` while the list is still being
//                  read; only `state === 'open'` ones (absent state counts as
//                  open) are listed, and every other field is previewed when
//                  present. An ARRAY is a known list (`[]` = known empty).
//   issuesError    string — the read failed; never rendered as an empty list
//   assignedIssues [number] the worktree's current assignment, or `null` while
//                  it is still being verified (a save is refused meanwhile)
//   assignedError  string — the assignment read failed
//   documents      [{name, path, text?}] every ODD document of the checkout, or
//                  `null` while it is still being read; `path` is the document
//                  identity shared with `odd`; `text` skips `loadDocument` when
//                  the caller already has it
//   documentsError string — the ODD list read failed
//   odd            string|null the ONE associated document (S8), matched
//                  against a document's `path`, then its `name`; the header
//                  renders its NAME, never the path (S6) and does so from the
//                  stored value alone, so it appears before any read completes
//   loadIssue      (number, options?) -> {ok:true, issue, comments} |
//                  {issue, comments} | issue | {ok:false, error}
//                  `comments` is the issue's comment list (S16); the preview
//                  is the SAME formatter Issues uses, so assignees, projects,
//                  linked PRs and every comment appear here too
//   loadDocument   (path) -> {ok:true, text} | {ok:false, error} | string
//   save           ({issues: number[], odd: string|null}) -> {ok:true} | {ok:false, error}
//
// `loadIssue`, `loadDocument` and `save` may return a value or a promise and
// may throw; every outcome (success, failure, thrown, never-settling is the
// caller's concern) is shown honestly and never leaves a fake row behind.
//
// Post-mount data (`apply(partial)`, S18): the parent may mount this view
// before the worktree facts, the issue list, the assignment and the ODD list
// are known, then hand each read over as it lands, on the SAME instance:
//   apply({ worktree, issues, issuesError, documents, documentsError,
//           assignedIssues, assignedError, odd })
//   - every key is optional; an absent key leaves that dataset untouched;
//   - `null` data means "still reading" (the rows already on screen stay, the
//     status row names the pending read, the tab count shows `…` and a save is
//     refused), an ARRAY is a known list (`[]` = known empty) and `*Error` is a
//     failed read (tab count `?`, list pane names the failure, never "empty");
//   - assignedIssues/odd are IGNORED while the reader has unsaved changes or a
//     save is in flight: the unsaved selection AND its saved baseline survive;
//   - the focused issue number / document path is preserved across the update
//     when it still exists, otherwise the cursor, page and scroll are clamped;
//   - an issue read started against the previous rows is dropped, so its late
//     answer can never paint over the new row, and one fresh read starts;
//   - returns `false` only when the view is closed or the payload is not an
//     object (an empty payload is a no-op and returns `true`);
//   - performs no I/O and touches no module-level state.
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
//   - Preview paging is the ONE shared binding of lib/preview-scroll-keys.js
//     (S1): `ctrl+shift+j/k` when the terminal confirms the extended protocol,
//     printable `Shift+J/K` as the fallback, `PgDn`/`PgUp` always, and
//     `ctrl+d`/`ctrl+u` for a half page. Lowercase `j`/`k` move the list, and
//     no bare LF/CtrlJ/CtrlK alias pages the preview.
//   - `T` or `/` filters the CURRENT tab (`enter`/`esc` leave the box); while
//     the box is open the footer names the search's own keys, `delete`
//     empties the whole query and `backspace` edits one character (S14).
//   - The header has THREE logical rows in the order the reader asked for
//     (S6): the worktree details, then `issues: #76, #77`, then `odd: name`.
//     A missing association renders `-` in its own row; the ODD row never
//     repeats the document path.
//   - The page indicator is ALWAYS beside Search, even for a one-page list
//     (S14), so every full-screen reader shows it in the same place.
//   - `ctrl+s` saves; the status row reports `saving…`, `● unsaved`, `saved`
//     or `save failed: <reason>`. A failed save changes nothing locally: the
//     selection stays exactly as the reader left it. While the issue list or
//     the assignment is still loading, a save is refused with `save waits for
//     the <dataset>` and the `save` seam is never called (S18).
//
// Payload of `save`: `issues` is the selection sorted ascending, `odd` is the
// selected document's `path` (or the caller's own association string when no
// document matched it), or `null` when it was cleared.
//
// `state` (observable): `tab` ('issues'|'odd'), `cursor`/`scroll`/`query`
// keyed by tab, `searching`, `issues` (number[]), `odd` (string|null),
// `saving`, `dirty`, `saveError`, `notice`, `saveBlocked` ('issues'|
// 'assigned'|null) and `dataState` — `{worktree, issues, issuesError,
// assigned, assignedError, documents, documentsError}` where each dataset is
// `'loading'|'ready'|'error'`.

const { renderOddMarkdown, stripAnsi } = require('./odd-markdown.js');
const layout = require('./view-layout.js');
// S16: the preview is the Issues preview. Sharing the formatter is what keeps
// the worktree detail from drifting into a smaller copy of it again.
const { issueDetailLines } = require('./issue-preview.js');
// S1: one shared decision for the preview paging keys and for which of them
// this terminal can actually deliver, so the handler and the footer cannot
// disagree (the reported "always says ctrl+j/k" defect).
const scrollKeys = require('./preview-scroll-keys.js');

const CARD_PADDING = 4;
const LIST_MAX_WIDTH = 34;
// S6: an association the worktree does not have is `-`, never `0` and never a
// silently missing row.
const EMPTY_ASSOCIATION = '-';
// Below FRAMED_MIN_WIDTH even the two border cells do not fit, so the frame is
// dropped rather than overflowing; below TWO_PANE_MIN_WIDTH a right pane would
// be unusable, so the list takes the whole body.
const FRAMED_MIN_WIDTH = 8;
const TWO_PANE_MIN_WIDTH = 24;
const DEFAULT_ROWS = 24;

// S1: `j`/`k` stay the list-selection keys, so a loose case fallback must never
// let a shifted `J`/`K` answer for them. The paging keys themselves are
// resolved by lib/preview-scroll-keys.js before this table is consulted.
const SHIFTED_TWINS = new Set(['j', 'k']);

// S14: while the search box is open the footer names the keys that actually
// act on it — type, one-character delete, whole-query clear, and how to keep
// the query and leave. The browsing keys are not live then, so they are not
// advertised (the Issues footer makes the same promise).
const SEARCH_KEYS = [
  { text: 'type to filter', short: 'type', priority: 30 },
  { text: 'backspace del char', short: '⌫ char', priority: 60 },
  { text: 'delete clear', short: 'del clear', priority: 70 },
  { text: 'enter/esc keep filter', short: '↵/esc keep', priority: 100 },
];

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
  'backspace': ['\x7f', '\b'],
  delete: ['\x1b[3~'],
  'ctrl+s': ['\x13'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
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
  const comments = Array.isArray(result.comments) ? result.comments : [];
  if (result.ok === true) {
    if (result.issue && typeof result.issue === 'object') return { ok: true, issue: result.issue, comments };
    return { ok: false, error: 'issue unreadable' };
  }
  // S16: a `{issue, comments}` envelope without an `ok` flag is a successful
  // read — the caller already has the issue and its comments together.
  if (result.issue && typeof result.issue === 'object') return { ok: true, issue: result.issue, comments };
  // A bare issue object is accepted as its own preview.
  if (Number.isFinite(issueNumberOf(result)) || typeof result.title === 'string') {
    return { ok: true, issue: result, comments };
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

function normalizeDocuments(list) {
  return (Array.isArray(list) ? list : []).filter((doc) => doc && typeof doc === 'object' && docId(doc));
}

// S7c/S7d: one open row per issue number, so a closed or deleted issue can
// never be listed — and therefore never stay assigned. Rebuilt from scratch
// whenever `apply` replaces the list, so a stale index can never outlive it.
function buildIssueIndex(rows) {
  const list = [];
  const byNumber = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const number = issueNumberOf(row);
    if (!Number.isFinite(number) || !issueIsOpen(row) || byNumber.has(number)) continue;
    byNumber.set(number, row);
    list.push(row);
  }
  return { list, byNumber };
}

// The three truths of a dataset are DIFFERENT and must never collapse into
// each other: pending (`null`, still reading), failed (a named error) and a
// known list (empty included). S18 keeps "nothing yet" from reading as "none".
// `explicit` is the caller's own status, used when the rows are already known
// but not yet VERIFIED (the stored assignment paints while a save is still
// refused).
function datasetStatus(value, error, explicit) {
  if (explicit === 'loading' || explicit === 'ready' || explicit === 'error') return explicit;
  if (typeof error === 'string' && error.length > 0) return 'error';
  if (value === null) return 'loading';
  return 'ready';
}

function datasetError(error) {
  return typeof error === 'string' && error.length > 0 ? error : null;
}

function has(partial, key) {
  return Object.prototype.hasOwnProperty.call(partial, key);
}

// An assignment is only ever DROPPED against a list that is known to be
// complete: while the list is pending or failed it cannot prove that a stored
// issue is closed, so the stored number survives instead of being lost.
function baselineNumbers(entries, byNumber, listStatus) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const number = Number(entry);
    if (!Number.isFinite(number) || out.includes(number)) continue;
    if (listStatus === 'ready' && !byNumber.has(number)) continue;
    out.push(number);
  }
  return out.sort((left, right) => left - right);
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

  let worktree = options.worktree && typeof options.worktree === 'object' ? options.worktree : {};
  let documents = normalizeDocuments(options.documents);
  let issueIndex = buildIssueIndex(options.issues);
  let openIssues = issueIndex.list;
  let openByNumber = issueIndex.byNumber;

  // The associated document normalizes to the document identity the caller can
  // save; an association no document matches is kept verbatim instead of being
  // silently dropped (S8b). With no documents yet, the stored association is
  // still the value the header names, so it shows before any read completes.
  function resolveOdd(value) {
    const doc = documents.find((entry) => sameDoc(value, entry)) || null;
    if (doc) return docId(doc);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  // S7d drops a stored number only against a list that is known complete AND
  // an assignment the caller already verified. A stored baseline that the
  // caller is still verifying paints exactly as stored (S18/L6): an id the
  // snapshot has not loaded yet is not evidence of a closed issue.
  const mountAssignedStatus = datasetStatus(options.assignedIssues, options.assignedError, options.assignedState);
  const initialIssues = baselineNumbers(
    Array.isArray(options.assignedIssues) ? options.assignedIssues : [],
    openByNumber,
    mountAssignedStatus === 'ready'
      ? datasetStatus(options.issues, options.issuesError, options.issuesState)
      : 'unverified',
  );
  let savedIssues = initialIssues.slice();
  const initialOdd = resolveOdd(options.odd);
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
    // S18: which dataset is still being read, and why one failed. A pending
    // read is NOT a failure and a failure is NOT an empty list.
    dataState: {
      worktree: 'ready',
      issues: datasetStatus(options.issues, options.issuesError, options.issuesState),
      issuesError: datasetError(options.issuesError),
      assigned: datasetStatus(options.assignedIssues, options.assignedError, options.assignedState),
      assignedError: datasetError(options.assignedError),
      documents: datasetStatus(options.documents, options.documentsError, options.documentsState),
      documentsError: datasetError(options.documentsError),
    },
    // `issues`/`assigned` while that data is pending: a save would persist
    // from an incomplete list, so it is refused and named instead.
    saveBlocked: null,
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
  // S18: ONE lifetime flag. Once `done` has fired the view is closed for good:
  // input, `apply`, late reads and writes are all refused, and nothing is
  // painted again — `done` can never resolve the host twice.
  let closed = false;

  const activeTab = () => state.tab;

  function tabStatus(tab) {
    return state.dataState[tab === 'issues' ? 'issues' : 'documents'];
  }

  function tabError(tab) {
    return state.dataState[tab === 'issues' ? 'issuesError' : 'documentsError'];
  }

  // The LIST pane's own words for "there is no row to show". A pending read, a
  // failed read and a genuinely empty list are three different sentences (S18),
  // and a search's "no match" is a fourth.
  function emptyNote(tab) {
    const status = tabStatus(tab);
    if (status === 'loading') return tab === 'issues' ? 'loading issues…' : 'loading odd documents…';
    if (status === 'error') {
      const error = tabError(tab) || 'unreadable';
      return tab === 'issues' ? `issue list unreadable: ${error}` : `odd list unreadable: ${error}`;
    }
    const query = state.query[tab];
    if (tab === 'issues') return query ? 'no issues match this search' : 'no open issues';
    return query ? 'no documents match this search' : 'no odd documents';
  }

  // S18: a save from an unverified list or assignment would persist an
  // association set nobody proved, so it is refused and NAMED instead of
  // written. A FAILED read blocks it too: it is not evidence of "nothing".
  function saveBlockedDataset() {
    if (state.dataState.issues === 'loading' || state.dataState.issues === 'error') return 'issues';
    if (state.dataState.assigned === 'loading' || state.dataState.assigned === 'error') return 'assigned';
    return null;
  }

  function syncSaveBlocked() {
    state.saveBlocked = saveBlockedDataset();
  }

  function saveBlockedText(dataset) {
    if (dataset === 'issues') {
      return state.dataState.issues === 'error'
        ? 'save waits for a readable issue list'
        : 'save waits for the issue list';
    }
    return state.dataState.assigned === 'error'
      ? 'save waits for the assignment to be verified'
      : 'save waits for the assignment';
  }

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
    if (closed) return;
    try {
      if (typeof requestRender === 'function') requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function close() {
    if (closed) return;
    closed = true;
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

  // S16: the cache entry carries the issue's comments beside the issue, so the
  // preview can render the same detail Issues does. The entry object is the
  // generation guard: an answer that arrives after a newer read replaced this
  // entry settles into nothing, so a slow read can never overwrite fresher data
  // or paint into a row the reader has already left.
  function ensureIssue(row, options = {}) {
    const number = issueNumberOf(row);
    if (!Number.isFinite(number)) return { status: 'ready', issue: row, comments: [], error: null };
    let entry = issueCache.get(number);
    if (entry && options.refresh !== true) return entry;
    entry = {
      status: typeof loadIssue === 'function' ? 'loading' : 'ready',
      issue: row,
      comments: (entry && Array.isArray(entry.comments)) ? entry.comments : [],
      error: null,
    };
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
      // S18: after `done` a late answer writes nothing and paints nothing.
      if (closed) return;
      if (issueCache.get(number) !== entry) return;
      const normalized = normalizeIssueResult(result);
      if (normalized.ok) {
        entry.status = 'ready';
        entry.issue = normalized.issue;
        entry.comments = normalized.comments;
        entry.error = null;
      } else {
        // A failed read shows its own failure: the previous issue/comments stay
        // out of the pane instead of passing for the failed one.
        entry.status = 'error';
        entry.comments = [];
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
      // Identity guard, same as the issue cache: an answer for a read that a
      // newer one already replaced is dropped instead of overwriting it.
      if (closed) return;
      if (docCache.get(id) !== entry) return;
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

  // S16: the preview IS the Issues preview — `lib/issue-preview.js` renders
  // assignees, projects, linked PRs, the body and every comment here exactly
  // as it does there. While the richer read is in flight the row's own facts
  // still paint, so the pane never looks empty or claims a body it has not
  // read yet.
  function issuePreviewLines(row, width) {
    const entry = ensureIssue(row);
    if (entry.status === 'error') return [paint(theme, 'error', `unreadable: ${entry.error}`)];
    const detail = entry.issue || row;
    const number = issueNumberOf(detail);
    return issueDetailLines(Number.isFinite(number) ? detail : row, entry.status === 'ready' ? entry.comments : [], {
      width,
      paint: (role, text) => paint(theme, role, text),
      emphasis: (text) => emphasize(theme, text),
      note: state.issues.includes(number) ? 'assigned to this worktree' : 'not assigned',
      pending: entry.status !== 'ready',
    });
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
    const entry = currentEntry();
    if (!entry) return [paint(theme, 'muted', emptyNote(tab))];
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

  // S6: a list row is the checkbox, the `#`-prefixed number and the title, so
  // the number a reader sees there is the number they can act on. The wrapped
  // title still owns every remaining cell of the wider pane.
  function listLabel(tab, entry) {
    if (tab === 'issues') {
      const number = issueNumberOf(entry);
      const assigned = state.issues.includes(number) ? '[x]' : '[ ]';
      return `${assigned} #${number} ${String(entry.title || '')}`;
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

  // S18: a count is only printed when it is known. A pending dataset shows
  // `…` and a failed one `?`, so a tab never claims `0` it did not verify.
  function tabCount(tab) {
    const status = tabStatus(tab);
    if (status === 'loading') return '…';
    if (status === 'error') return '?';
    return String(tab === 'issues' ? openIssues.length : documents.length);
  }

  function tabsText() {
    const entries = [
      { id: 'issues', label: `Issues (${tabCount('issues')})` },
      { id: 'odd', label: `ODD (${tabCount('odd')})` },
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

  // S11/S6: the header separates three logical data rows — the worktree
  // details, the assigned issue numbers, and the ONE associated ODD — in that
  // order, and each expands to as many terminal rows as it needs instead of
  // being truncated. Every row is always present: an association the worktree
  // does not have renders `-` rather than vanishing, so the reader can tell
  // "nothing assigned" from "nothing drawn".
  //
  // S6: the ODD row is the document's NAME alone (never its path), and the
  // numbers carry `#` exactly as the list rows and the Issues viewer do.
  function associationName(association) {
    if (typeof association !== 'string' || association.length === 0) return null;
    const doc = documents.find((entry) => sameDoc(association, entry)) || null;
    if (doc) return docName(doc);
    const base = association.split(/[\\/]/).pop() || association;
    return base.replace(/\.md$/i, '');
  }

  function oddSummary() {
    return `odd: ${associationName(state.odd) || EMPTY_ASSOCIATION}`;
  }

  function numbersSummary() {
    const numbers = state.issues.slice().sort((left, right) => left - right);
    const ids = numbers.map((number) => `#${number}`).join(', ');
    return `issues: ${ids === '' ? EMPTY_ASSOCIATION : ids}`;
  }

  function headerLines(width) {
    const rows = [];
    for (const text of [factsText(), numbersSummary(), oddSummary()]) {
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
    syncSaveBlocked();
    if (state.dirty) notes.push(paint(theme, 'accent', '● unsaved'));
    if (state.saveError) notes.push(paint(theme, 'error', `save failed: ${state.saveError}`));
    else if (state.saving) notes.push(paint(theme, 'muted', 'saving…'));
    else if (state.saveBlocked) {
      notes.push(paint(theme, 'muted', saveBlockedText(state.saveBlocked)));
    } else if (state.notice) notes.push(paint(theme, 'accent', state.notice));
    if (state.refreshError) notes.push(paint(theme, 'error', `refresh failed: ${state.refreshError}`));
    else if (state.refreshing) notes.push(paint(theme, 'muted', 'refreshing…'));
    // S18: what is still being read is named here, not implied by a hollow row.
    if (state.dataState.issues === 'loading') notes.push(paint(theme, 'muted', 'loading issues…'));
    else if (state.dataState.assigned === 'loading') notes.push(paint(theme, 'muted', 'loading assignment…'));
    else if (state.dataState.issues === 'error') notes.push(paint(theme, 'error', `issues unreadable: ${state.dataState.issuesError || 'unknown'}`));
    if (state.dataState.documents === 'loading') notes.push(paint(theme, 'muted', 'loading odd documents…'));
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
    // S14: an open search box replaces the browsing legend with the keys that
    // act on it, so no row ever advertises a key that would type a character
    // or do nothing.
    if (state.searching) return SEARCH_KEYS.slice();
    return [
      { text: '↑↓ move', short: '↑↓', priority: 80 },
      { text: 'tab Issues/ODD', short: 'tab Issues/ODD', priority: 105 },
      { text: '←/→ page', short: '←/→ page', priority: 110 },
      { text: activeTab() === 'issues' ? 'space assign' : 'space select', short: 'space', priority: 90 },
      // S1: the shared legend names the pair this terminal confirmed, never a
      // guessed OS default and never a stale `ctrl+j/k`.
      ...scrollKeys.previewScrollKeys(helpers),
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
    // S18: a closed view paints nothing and starts no read.
    if (closed) return [];
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

    // S11/S6: the three logical header rows in the order the reader asked for
    // — details, issues, ODD — each wrapping to the rows it needs.
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
    // S14: the marker is fixed beside Search in every reader, so it is drawn
    // even for a one-page list instead of appearing only once there are more.
    const pageMark = `page ${state.page[tab]}/${Math.max(1, paged.pageCount)}`;

    if (plan.tabs) lines.push(cell(tabsText()));
    if (plan.status) lines.push(cell(statusText(pageMark)));

    if (bodyRows > 0) {
      const leftLines = [];
      if (paged.page.start >= paged.page.end) {
        // S18: the list pane states its own case instead of staying blank —
        // pending, failed and empty are different sentences.
        for (const row of layout.wrapLabel(helpers, emptyNote(tab), listWidth, { first: '', rest: '' })) {
          leftLines.push(paint(theme, 'muted', pad(helpers, row, listWidth)));
        }
      }
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

  // The identity of the focused row, so new data keeps the reader on the item
  // they were reading instead of on whatever slid into that index.
  function focusedIdentity(tab) {
    const list = tab === 'issues' ? issueList() : documentList();
    const entry = list[state.cursor[tab]] || null;
    if (!entry) return null;
    if (tab === 'issues') {
      const number = issueNumberOf(entry);
      return Number.isFinite(number) ? number : null;
    }
    return docId(entry);
  }

  function restoreFocus(tab, identity) {
    const list = tab === 'issues' ? issueList() : documentList();
    if (identity !== null) {
      const at = list.findIndex((entry) => (tab === 'issues' ? issueNumberOf(entry) : docId(entry)) === identity);
      if (at >= 0) {
        state.cursor[tab] = at;
        return;
      }
    }
    state.cursor[tab] = Math.min(Math.max(0, state.cursor[tab]), Math.max(0, list.length - 1));
    state.scroll[tab] = 0;
  }

  function applyIssues(partial) {
    if (has(partial, 'issues')) {
      const value = partial.issues;
      // `null` means "still reading": the rows on screen stay, and only the
      // status says the data is not verified yet.
      if (value !== null) {
        const next = buildIssueIndex(value);
        openIssues = next.list;
        openByNumber = next.byNumber;
        // A read started against the previous rows can never describe the new
        // ones: dropping the in-flight entry makes its late answer a no-op and
        // lets the next frame start ONE read against the new row.
        for (const [number, entry] of issueCache) {
          if (entry.status === 'loading') issueCache.delete(number);
        }
        // No baseline is filtered here: a delivered list may be a partial
        // snapshot, and an id it does not carry is not evidence of a closed
        // issue (S18/L6). Dropping is the caller's verified verdict, arriving
        // through `assignedIssues`.
      }
      state.dataState.issues = datasetStatus(value, null);
      state.dataState.issuesError = null;
    }
    if (has(partial, 'issuesError')) {
      const error = datasetError(partial.issuesError);
      state.dataState.issuesError = error;
      if (error) state.dataState.issues = 'error';
      else if (!has(partial, 'issues') && state.dataState.issues === 'error') state.dataState.issues = 'ready';
    }
    // The caller may know the rows while still not trusting them (S18): the
    // explicit status wins over what the data alone implies.
    if (has(partial, 'issuesState')) {
      state.dataState.issues = datasetStatus(partial.issues ?? [], null, partial.issuesState);
    }
  }

  function applyDocuments(partial) {
    if (has(partial, 'documents')) {
      if (partial.documents !== null) {
        documents = normalizeDocuments(partial.documents);
        const ids = new Set(documents.map((doc) => docId(doc)));
        for (const id of [...docCache.keys()]) {
          if (!ids.has(id)) docCache.delete(id);
        }
      }
      state.dataState.documents = datasetStatus(partial.documents, null);
      state.dataState.documentsError = null;
    }
    if (has(partial, 'documentsError')) {
      const error = datasetError(partial.documentsError);
      state.dataState.documentsError = error;
      if (error) state.dataState.documents = 'error';
      else if (!has(partial, 'documents') && state.dataState.documents === 'error') state.dataState.documents = 'ready';
    }
    if (has(partial, 'documentsState')) {
      state.dataState.documents = datasetStatus(partial.documents ?? [], null, partial.documentsState);
    }
  }

  function applyBaseline(partial) {
    if (has(partial, 'assignedIssues')) {
      state.dataState.assigned = datasetStatus(partial.assignedIssues, null);
      state.dataState.assignedError = null;
      // S18: the delayed verify may only fill in a baseline the reader has not
      // overridden. An unsaved selection and a write in flight both outrank it,
      // and so does the saved baseline those two depend on.
      if (partial.assignedIssues !== null && !state.dirty && !state.saving) {
        // The caller's verdict is the evidence: `keep` already carries the
        // unverifiable ids, and an id missing from a still-partial list is not
        // proof of closure, so nothing here is filtered away.
        const next = baselineNumbers(partial.assignedIssues, openByNumber, 'unverified');
        state.issues = next;
        savedIssues = next.slice();
      }
    }
    if (has(partial, 'assignedError')) {
      const error = datasetError(partial.assignedError);
      state.dataState.assignedError = error;
      if (error) state.dataState.assigned = 'error';
      else if (!has(partial, 'assignedIssues') && state.dataState.assigned === 'error') state.dataState.assigned = 'ready';
    }
    if (has(partial, 'assignedState')) {
      state.dataState.assigned = datasetStatus(partial.assignedIssues ?? [], null, partial.assignedState);
    }
    // S8b/S18: the stored association is already on screen from mount; later
    // reads replace it only while the reader has nothing unsaved.
    if (has(partial, 'odd') && !state.dirty && !state.saving) {
      state.odd = resolveOdd(partial.odd);
      savedOdd = state.odd;
    }
  }

  /**
   * S18: the post-mount data seam. The parent mounts this view immediately and
   * hands each read over as it lands, on the SAME instance.
   *
   * @param {object} partial any of
   *   `worktree`          replaces the header facts
   *   `issues`            an array (known list, `[]` included) or `null`
   *                       (still reading — the rows on screen stay)
   *   `issuesError`       a string (failed read) or `null` (clear it)
   *   `documents`         an array or `null`
   *   `documentsError`    a string or `null`
   *   `assignedIssues`    an array or `null`; IGNORED while the reader has
   *                       unsaved changes or a save is in flight
   *   `assignedError`     a string or `null`
   *   `issuesState` / `assignedState` / `documentsState`
   *                        `'loading'|'ready'|'error'`: the caller's own
   *                        status, for rows it can paint but not yet trust
   *                        (S18: a stored assignment is displayed while the
   *                        save stays refused)
   *   `odd`               the stored association (path or name) or `null`
   * @returns {boolean} false only when the view is closed or the payload is not
   *   an object; an empty payload is a no-op that reports true.
   */
  function apply(partial) {
    if (closed || !partial || typeof partial !== 'object' || Array.isArray(partial)) return false;
    const focus = { issues: focusedIdentity('issues'), odd: focusedIdentity('odd') };
    let touched = false;
    if (has(partial, 'worktree')) {
      worktree = partial.worktree && typeof partial.worktree === 'object' ? partial.worktree : {};
      touched = true;
    }
    // Lists first: the assignment is filtered against the list that arrives with
    // it, and the ODD association is resolved against the documents.
    if (has(partial, 'issues') || has(partial, 'issuesError') || has(partial, 'issuesState')) {
      applyIssues(partial);
      touched = true;
    }
    if (has(partial, 'documents') || has(partial, 'documentsError') || has(partial, 'documentsState')) {
      applyDocuments(partial);
      touched = true;
    }
    if (has(partial, 'assignedIssues') || has(partial, 'assignedError') || has(partial, 'assignedState') || has(partial, 'odd')) {
      applyBaseline(partial);
      touched = true;
    }
    if (!touched) return true;
    restoreFocus('issues', focus.issues);
    restoreFocus('odd', focus.odd);
    syncDirty();
    syncSaveBlocked();
    repaint();
    return true;
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
      const cached = {
        status: 'loading',
        issue: entry,
        comments: (issueCache.get(number) || {}).comments || [],
        error: null,
      };
      issueCache.set(number, cached);
      repaint();
      let pending;
      try {
        pending = loadIssue(number, { refresh: true });
      } catch (err) {
        cached.status = 'error';
        cached.comments = [];
        cached.error = (err && err.message) || 'issue unreadable';
        settleFailure(cached.error);
        return;
      }
      const settle = (result) => {
        if (closed) return;
        if (issueCache.get(number) !== cached) return;
        const normalized = normalizeIssueResult(result);
        if (normalized.ok) {
          cached.status = 'ready';
          cached.issue = normalized.issue;
          cached.comments = normalized.comments;
          cached.error = null;
          settleSuccess();
          return;
        }
        cached.status = 'error';
        cached.comments = [];
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
      if (closed) return;
      if (docCache.get(id) !== cached) return;
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
    // S18: a save from a list that has not arrived would persist an assignment
    // nobody verified. It is refused, named in the status row, and `save` is
    // never called.
    syncSaveBlocked();
    if (state.saveBlocked) {
      state.notice = null;
      state.saveError = null;
      repaint();
      return;
    }
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
      if (closed) return;
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
    // S14: the footer promises a whole-query clear, so `delete` provides it.
    // It is a text key while the box is open, never a selection binding.
    if (keyMatches(helpers, data, ['delete'])) {
      state.query[tab] = '';
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
    // S18: a closed view never answers, so `done` can fire at most once.
    if (closed) return;
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
    // S1: the preview paging keys are resolved BEFORE the list selection and
    // before the `enter` alias, because the shared helper protects the
    // case-folding trap (`J` must never be `j`) and because a host matcher can
    // report the same byte as both `ctrl+j` and `enter`. A bare LF is not a
    // scroll key any more, so it falls through and keeps its Enter meaning.
    const scrollAction = scrollKeys.resolveScrollAction(helpers, data);
    if (scrollAction) {
      const page = Math.max(1, bodyRows - 1);
      const half = scrollAction === scrollKeys.ACTIONS.HALF_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_UP;
      const down = scrollAction === scrollKeys.ACTIONS.PAGE_DOWN || scrollAction === scrollKeys.ACTIONS.HALF_DOWN;
      const step = half ? Math.max(1, Math.floor(page / 2)) : page;
      scrollBy(down ? step : -step);
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

  return { render, handleInput, invalidate, apply, state };
}

module.exports = { createWorktreeDetailView };
