'use strict';
// T4 (worktree-ui-feedback S4,S12,S15): the worktree CREATION and EDITING
// panel.
//
// CREATE mode ('create', the default) is the TABBED bottom flow a human
// creates with (S7): a live branch/path preview ABOVE, then the change type
// and the change name as the two TABS of one strip (`Type · Name`, with only
// the ACTIVE field's content under it, the same active/inactive idiom the
// editing mode's dataset tabs use). The Type tab holds the change type as an
// inline LIST (there is no native dropdown in this host, and no second
// pop-up surface); the Name tab holds the text field. The preview stays BLANK
// until both fields derive a real branch and path: an incomplete form is not
// an error, so nothing in it is painted red or names a failure, while a
// refused submit still says exactly why. `tab`, `shift+tab`, `←` and `→` move
// between the two tabs; `↑`/`↓` pick the type; `enter` on the name (or
// `ctrl+s` anywhere) creates. There is no Issues or Odd pane here, no step
// counter and no association: a brand-new row is created with no association
// at all, and every part of that machinery below belongs to editing.
//
// EDIT mode ('edit') is the association editor: the type and the name are
// FROZEN and TWO content panes in the miniature shape of the issues/odd
// commands hold the checkout's assigned data — the ACTIVE dataset (Issues
// or Odd) list on the left and that row's read-only preview on the right.
// There `tab`/`←`/`→` switch the dataset instead of meaning "back".
//
// Pure Node, no package imports. The repository's own helpers do the work
// instead of a second implementation of the same convention:
// - lib/worktree-git.js `slugifyBranch` / `validateBranch` /
//   `canonicalWorktreePath` (or `worktreePath`) derive the branch and the
//   target path, exactly as the create path does;
// - lib/warp-create-picker.js `issuePickItems` / `oddPickItems` /
//   `filterIssueItems` / `filterOddItems` / `paginate` shape, filter and
//   page the editing mode's rows;
// - lib/gh-issues.js `listIssues` / `getIssue` read open issues and an
//   issue body;
// - lib/odd-docs.js `listOddDocs` / `readOddDoc` list and read odd
//   documents, which lib/odd-markdown.js `renderOddMarkdown` renders the
//   same way the odd viewer does.
// The editing mode's every seam is injectable (`fetchIssues`, `listOdd`,
// `readIssuePreview`, `readOddPreview`, `renderMarkdown`, `git`), so tests
// never spawn `gh`, never read a real checkout and never depend on a real
// terminal. The create mode has no such source: it reads nothing.
//
// Host component contract (the same seam the customize panel and the
// create pickers use): `createWarpCreatePanel(options)` returns
// `{ render(width), handleInput(data), invalidate(), state }`.
//
// Completion (documented exactly, because it is the module's only output):
//   create  done({ ok: true, type, name })
//   edit    done({ ok: true, mode: 'edit', type, name, issues, odd })
// a creation completes on `enter` in the LAST step (the name) or on
// `ctrl+s` from any field, and `done(null)` on `esc` (cancel). `type` is the
// conventional change-type id (`feat`, `fix`, …) and `name` is the trimmed
// change name as typed. A creation NEVER carries `issues` or `odd`: a new
// row is born without an association (S6). The editing payload keeps both
// association fields, so its caller can persist them. A completion fires
// EXACTLY once. An invalid branch/path refuses creation (nothing is
// emitted) and the reason stays on screen.
//
// EDITING mode (S13) reuses the same surface with ONE extra marker so the
// caller can tell the two modes apart without a second field set:
//   edit    done({ ok: true, mode: 'edit', type, name, issues, odd })
// In editing mode the branch, the path, the type and the name all describe
// the checkout being edited, so they arrive through `branch`/`path` and are
// NEVER re-derived from the create-time convention: an invented branch, or a
// path that does not exist, is exactly the defect this seam removes. A
// conventional `branch` (`<type>/<slug>`) is the display for the frozen type
// and slug; any other branch keeps its type `unavailable` and shows the
// branch the checkout actually has. A value the caller cannot supply renders
// as `unavailable`, never as a derived one, and a checkout whose branch or
// path breaks the create-time convention still opens and saves. `esc`
// completes with `null` and writes nothing.
//
// Options (every one optional; the seams exist so tests own the world):
//   cwd               checkout the panel derives the path from and (in
//                     editing mode) reads issues/odd documents for
//                     (default: process.cwd())
//   mode              `'create'` (default) or `'edit'`; `'edit'` renders
//                     the type and the name FROZEN (visible, no caret, no
//                     type sub-panel, no `←`/`→` cycle, typing and
//                     Backspace inert), adds the two association panes,
//                     takes the branch/path from the options below and
//                     saves instead of creating
//   branch            `'edit'` only: the checkout's OWN branch, rendered
//                     verbatim and split into type/slug for the frozen
//                     fields when it follows `<type>/<slug>`; never derived
//   path              `'edit'` only: the checkout's OWN directory, rendered
//                     verbatim; never derived
//   changeTypes       `[{id,label}]`; default exports CHANGE_TYPES, the
//                     repository's branch-pr convention
//   namePlaceholder   ghost name hint (default NAME_PLACEHOLDER)
//   initialName       pre-filled change name in `'create'`; `'edit'` takes
//                     the name from `branch`
//   initialType       pre-selected change-type id in `'create'`; `'edit'`
//                     takes the type from `branch`
//   initialIssues     `'edit'` only: issue numbers pre-selected in the
//                     Issues pane (default: none); the assigned set
//   initialOdd        `'edit'` only: the ONE odd document currently
//                     associated (default: none), the `path` the listing
//                     uses; a stored relative path or bare name still marks
//                     its document and is echoed back unchanged unless
//                     another one is chosen
//   pageSize          rows per pane page; default: the rendered height
//                     (`'edit'` only)
//   rowsAvailable     the row budget the host offers: the CREATE surface
//                     renders exactly its own content height (clamped by
//                     this), the EDITING surface fills it
//   principalLayout   derive the target with `canonicalWorktreePath`
//                     (default true) instead of `worktreePath`
//   git               lib/worktree-git.js seam
//   fetchIssues       `'edit'` only:
//                     async () => ({ok, issues:[{number,title}]} | {ok:false,error})
//   listOdd           `'edit'` only:
//                     () => ({ok, docs:[{name, path}]} | {ok:false,error})
//   readIssuePreview  `'edit'` only:
//                     async (number) => ({ok, issue, comments} | {ok:false,error})
//   readOddPreview    `'edit'` only: (doc) => ({ok, text} | {ok:false,error})
//   renderMarkdown    `'edit'` only:
//                     (text, {width,paint,emphasis,measure}) => lines
//   helpers/hostTui/theme/rowsAvailable   the host seams the other panels use
//   done              (value) => void, see above
//
// Keys: creating is the tabbed flow — the preview ABOVE (branch, then path),
// then the `Type` and `Name` tabs of one field strip (S7). `tab`/`shift+tab`/
// `←`/`→` move between Type and Name (a horizontal key at either end wraps to
// the other tab), `↑`/`↓` pick the type while Type is active, a printable
// character there starts the name (so nobody types into a list), `enter` on
// Type reaches Name and `enter` on Name creates. The editing mode keeps its
// own map: `↓` from the Name reaches the
// active list, and there
// `↑`/`↓` move the focused row, `↑` on the FIRST row returns to Name (and
// from there to Type), `←` selects the Issues dataset and `→` the Odd one
// without ever focusing the preview, `tab` toggles the same dataset,
// `space` toggles the focused ISSUE and SELECTS the focused odd document
// (S8: one at a time — choosing another replaces it, choosing the active one
// clears it), `pgUp`/`pgDn` and `[`/`]` page, and `T`
// or any printable key opens the focused pane's filter (once open, every
// printable key — `space` included — is text, while `↑`/`↓`, paging, `enter`
// and `esc` keep navigating and `enter`/`esc` leave it keeping the filter).
// `ctrl+s` creates (or saves) from any field, `esc` cancels the innermost
// open layer first (then the whole interaction). There is no `?` key list:
// the footer names every shortcut on ONE row. In `'edit'` mode the type list
// and the field navigation are inert and every edit key is ignored on the
// two frozen fields.
//
// The editing mode's panes never go blank: a loading list, an empty list, a
// filter with no matches and an unavailable `gh` each say so in their own
// pane, and a missing `gh` never blocks the save.

const gitLib = require('./worktree-git.js');
const picker = require('./warp-create-picker.js');

// The Conventional Commit change types of the repository's branch-pr
// convention (`<type>/<slug>`), with its human labels and in its order —
// the SAME set the wizard's type step publishes. `CHANGE_TYPES` is the
// panel's default; tests pin it against the extension's own list so a
// drift can never leave two conventions in the repository.
const CHANGE_TYPES = Object.freeze([
  { id: 'feat', label: 'Feature' },
  { id: 'fix', label: 'Bug fix' },
  { id: 'chore', label: 'Chore' },
  { id: 'docs', label: 'Docs' },
  { id: 'style', label: 'Style' },
  { id: 'refactor', label: 'Refactor' },
  { id: 'perf', label: 'Performance' },
  { id: 'test', label: 'Test' },
  { id: 'build', label: 'Build' },
  { id: 'ci', label: 'CI' },
  { id: 'revert', label: 'Revert' },
].map((type) => Object.freeze(type)));

// The name placeholder the wizard shows, rendered as GHOST text (dim,
// never a value: creating from a placeholder is refused).
const NAME_PLACEHOLDER = 'name-change';

const PANEL_HEIGHT_MAX = 40;

// S12: the create surface's own fixed rows — top rule, title, branch preview,
// path preview, the `Type · Name` tab strip, the active field's own row, the
// one-row legend, the bottom rule. The inline type list (which belongs to the
// Type tab alone) takes whatever the host budget leaves.
const CREATE_FIXED_ROWS = 8;

// S7: the placeholder an underivable preview shows. `-` is the same
// missing-value mark the viewers use, so a form that is not filled in yet
// reads as empty instead of broken — the reason for a failure belongs to the
// refused submit, never to the live preview.
const PREVIEW_EMPTY = '-';

// Raw terminal bytes per key id, mirroring pi-tui's legacy sequences so
// the panel stays drivable when the injected matcher is absent (a panel
// that ignores Esc/Enter reads as frozen).
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  'ctrl+s': ['\x13'],
  enter: ['\r', '\n'],
  return: ['\r', '\n'],
  tab: ['\t'],
  'shift+tab': ['\x1b[Z'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  delete: ['\x1b[3~', '\x7f'],
  '\x7f': ['\x7f'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
  right: ['\x1b[C'],
  left: ['\x1b[D'],
  pageup: ['\x1b[5~'],
  pagedown: ['\x1b[6~'],
};

function keyText(helpers, data, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
    } catch {
      // A throwing matcher never matches; the fallbacks below decide.
    }
  }
  if (typeof data === 'string' && data.length > 0) {
    for (const name of names) {
      const raw = RAW_KEY_BYTES[String(name).toLowerCase()];
      if (raw && raw.includes(data)) return true;
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
    // A throwing classifier never releases; fall through.
  }
  return false;
}

// One printable character, or '' for a control byte, an escape sequence
// or a key object. The filter rule (S6) needs exactly this distinction.
function printableChar(data) {
  const raw = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  if (typeof raw !== 'string') return '';
  const chars = [...raw];
  if (chars.length !== 1) return '';
  const char = chars[0];
  if (char < ' ' || char === '\x7f') return '';
  return char;
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b_[^\x07\x1b]*\x07/g, '');
}

// Word wrap for the pane state messages: a narrow list column must still
// say WHY it is empty instead of clipping the explanation away.
function wrapText(text, width) {
  const limit = Math.max(1, width);
  const words = String(text).split(/\s+/).filter((word) => word !== '');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
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
  const chars = [...stripAnsi(clean)];
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
// keeps the row cell-exact if a single token is wider than the panel.
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

// S2: the panel spent two rows on one legend before; each state now names its
// keys on a single row (`text` full, `short` compact, `priority` the drop
// order — lowest goes first, so the cancel key outlives the rest).
// S12: creating is TWO fields, so the legend names the field keys (tab/←/→),
// the type-list keys and the ONE confirm key — never a pane or association key
// and never a second key that does the same thing (`ctrl+s` created too, which
// the user reported as a duplicate of `enter`).
const CREATE_KEYS = [
  { text: 'tab/←/→ fields', short: 'tab fields', priority: 70 },
  { text: '↑/↓ type', short: '↑/↓ type', priority: 60 },
  { text: 'Enter confirm', short: '↵ confirm', priority: 90 },
  { text: 'Esc cancel', short: 'Esc cancel', priority: 100 },
];
const EDIT_KEYS = [
  { text: '↑/↓ fields & rows', short: '↑/↓ fields', priority: 95 },
  { text: '←/→ dataset', short: '←/→ dataset', priority: 60 },
  { text: 'Space select', short: 'Space select', priority: 65 },
  { text: 'Tab dataset', short: 'Tab dataset', priority: 50 },
  { text: 'Enter save', short: 'Enter save', priority: 90 },
  { text: 'Ctrl+S save', short: 'Ctrl+S save', priority: 85 },
  { text: 'Esc cancel', short: 'Esc cancel', priority: 100 },
];
const FILTER_KEYS = [
  { text: 'filter: type to narrow', short: 'type to narrow', priority: 80 },
  { text: '↑/↓ move', short: '↑/↓', priority: 70 },
  { text: '[ ] or pgUp/pgDn page', short: '[ ] pgUp/Dn', priority: 60 },
  { text: 'Enter/Esc keep', short: '↵/esc keep', priority: 100 },
];

function shortError(err) {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err.split('\n')[0];
  if (err.code === 'ENOENT' || /ENOENT/i.test(String((err && err.message) || err))) return 'not available';
  return String((err && err.message) || err).split('\n')[0];
}

// Two content panes (S11, S20): the ACTIVE dataset's list on the left, its
// matching preview on the right — the same hierarchy the issues and odd
// commands use, in miniature. The widths always sum to exactly `width`: the
// list stays narrow while the preview keeps the room to be readable, and on
// a very narrow terminal the preview gives way instead of overflowing.
const LIST_RATIO = 0.34;
const LIST_MAX_WIDTH = 34;
const LIST_MIN_WIDTH = 12;

function columns(width) {
  if (width < LIST_MIN_WIDTH) return { list: Math.max(0, width), preview: 0, gap: 0 };
  const gap = width >= 40 ? 2 : 1;
  const avail = width - gap;
  if (avail < 2) return { list: Math.max(0, width), preview: 0, gap: 0 };
  let list = Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.floor(avail * LIST_RATIO)));
  list = Math.min(list, avail - 1);
  return { list, preview: avail - list, gap };
}

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultFetchIssues(cwd) {
  const gh = require('./gh-issues.js');
  return async () => {
    const rows = [];
    // `gh issue list` has no offset flag: lib/gh-issues.js pages one
    // bounded fetch in memory, so walk its pages instead of asking for a
    // second implementation of the fetch.
    for (let page = 1; page <= 10; page += 1) {
      const result = await gh.listIssues({ state: 'open', page, pageSize: 100 }, { cwd });
      if (!result || result.ok !== true) {
        return { ok: false, error: (result && result.error) || 'cannot list open issues' };
      }
      const batch = Array.isArray(result.issues) ? result.issues : [];
      rows.push(...batch);
      const total = Number.isFinite(result.total) ? result.total : rows.length;
      if (batch.length === 0 || rows.length >= total) break;
    }
    return { ok: true, issues: rows.map((issue) => ({ number: issue.number, title: issue.title })) };
  };
}

function defaultListOdd(cwd) {
  const odd = require('./odd-docs.js');
  return () => {
    const listed = odd.listOddDocs(cwd);
    if (!listed || listed.ok !== true) {
      return { ok: false, error: (listed && listed.reason) || 'cannot list odd documents' };
    }
    return { ok: true, docs: listed.docs.map((doc) => ({ name: doc.name, path: doc.path })) };
  };
}

function defaultReadIssuePreview(cwd) {
  const gh = require('./gh-issues.js');
  return (number) => gh.getIssue(number, { cwd });
}

function defaultReadOddPreview() {
  const odd = require('./odd-docs.js');
  return (doc) => odd.readOddDoc({ path: doc && doc.path });
}

function defaultRenderMarkdown() {
  const markdown = require('./odd-markdown.js');
  return (text, options) => markdown.renderOddMarkdown(text, options);
}

function createWarpCreatePanel(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : process.cwd();
  const helpers = opts.helpers || null;
  const hostTui = opts.hostTui || null;
  const theme = opts.theme || null;
  const git = opts.git && typeof opts.git === 'object' ? opts.git : gitLib;
  const principalLayout = opts.principalLayout !== false;
  // S13: the same panel as an EDITING surface. The checkout already exists,
  // so the type and the name are frozen and only the two panes' selections
  // can change. In create mode the panes do not exist at all (S6): the whole
  // association machinery below — sources, selections, previews — is built
  // only for the editing surface.
  const editing = opts.mode === 'edit';
  // S13 defect fix: in editing mode the branch and the path are FACTS about
  // the checkout being edited, handed in by the caller and rendered
  // verbatim. The panel never re-derives them from the frozen type and name,
  // because an invented branch or a non-existent path is blocking here.
  const providedBranch = typeof opts.branch === 'string' && opts.branch.trim() !== '' ? opts.branch : null;
  const providedPath = typeof opts.path === 'string' && opts.path.trim() !== '' ? opts.path : null;
  const initialIssues = editing && Array.isArray(opts.initialIssues)
    ? opts.initialIssues.filter((number) => Number.isInteger(number))
    : [];
  // S8: at most ONE odd document. A caller that still passes a list is
  // collapsed to its first value, so the panel cannot hold two.
  const initialOddValue = editing && Array.isArray(opts.initialOdd) ? opts.initialOdd[0] : opts.initialOdd;
  const initialOdd = editing && typeof initialOddValue === 'string' && initialOddValue !== ''
    ? initialOddValue
    : null;
  const changeTypes = Array.isArray(opts.changeTypes) && opts.changeTypes.length > 0
    ? opts.changeTypes.filter((type) => type && typeof type.id === 'string' && type.id !== '')
    : CHANGE_TYPES.slice();
  const namePlaceholder = typeof opts.namePlaceholder === 'string' && opts.namePlaceholder !== ''
    ? opts.namePlaceholder
    : NAME_PLACEHOLDER;
  const pageSizeOption = Number.isInteger(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : null;
  // A creation asks for two fields and nothing else, so it never builds a
  // source and never reads one (S6).
  const fetchIssues = editing
    ? (typeof opts.fetchIssues === 'function' ? opts.fetchIssues : defaultFetchIssues(cwd))
    : null;
  const listOdd = editing
    ? (typeof opts.listOdd === 'function' ? opts.listOdd : defaultListOdd(cwd))
    : null;
  const readIssuePreview = editing
    ? (typeof opts.readIssuePreview === 'function' ? opts.readIssuePreview : defaultReadIssuePreview(cwd))
    : null;
  const readOddPreview = editing
    ? (typeof opts.readOddPreview === 'function' ? opts.readOddPreview : defaultReadOddPreview())
    : null;
  const renderMarkdown = editing
    ? (typeof opts.renderMarkdown === 'function' ? opts.renderMarkdown : defaultRenderMarkdown())
    : null;
  const rawFinish = typeof opts.done === 'function' ? opts.done : () => {};

  // The branch format is the repository's own: `<type-of-the-list>/<slug>`,
  // derived from the SAME type list the field offers (never a second list).
  const branchFormat = new RegExp(`^(${changeTypes.map((type) => escapeRe(type.id)).join('|')})/[a-z0-9._-]+$`);

  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    rawFinish(value);
  };

  const state = {
    // S12: the type is picked from the inline list, so `typeIndex` IS the
    // selection (there is no second cursor to keep in sync).
    typeIndex: 0,
    name: typeof opts.initialName === 'string' ? opts.initialName : '',
    focus: 'type',
    message: '',
  };
  // S6: the association panes, their datasets, their cursors, their filters
  // and their selections exist ONLY while editing an existing checkout; a
  // creation carries none of that state.
  if (editing) {
    Object.assign(state, {
      // The pane whose list currently owns focus; the preview column follows
      // it even while the top fields are focused.
      pane: 'issues',
      filterOpen: false,
      queries: { issues: '', odd: '' },
      cursor: { issues: 0, odd: 0 },
      selectedIssues: initialIssues.slice(),
      selectedOdd: initialOdd,
      issues: { status: 'loading', error: null, rows: [] },
      odd: { status: 'loading', error: null, rows: [] },
    });
  }
  if (typeof opts.initialType === 'string') {
    const at = changeTypes.findIndex((type) => type.id === opts.initialType);
    if (at >= 0) state.typeIndex = at;
  }

  // One read per row, ever: the preview cache is keyed by the row id and
  // stores the raw read; the rendered lines are cached per width so a
  // re-render never re-reads and a resize never re-reads either.
  const previews = new Map();
  const rendered = new Map();
  let deriveCache = { key: null, value: null };

  let cursorMarker = '';
  try {
    if (helpers && typeof helpers.CURSOR_MARKER === 'string') cursorMarker = helpers.CURSOR_MARKER;
  } catch {
    cursorMarker = '';
  }
  if (cursorMarker === '') {
    try {
      const tui = require('@earendil-works/pi-tui');
      if (tui && typeof tui.CURSOR_MARKER === 'string') cursorMarker = tui.CURSOR_MARKER;
    } catch {
      cursorMarker = '';
    }
  }

  function availableRows() {
    try {
      if (typeof opts.rowsAvailable === 'function') {
        const size = Math.floor(opts.rowsAvailable());
        if (Number.isFinite(size) && size > 0) return Math.min(PANEL_HEIGHT_MAX, size);
      }
    } catch {
      // A hostile rows source never breaks the panel.
    }
    return 24;
  }

  function requestPaint() {
    try {
      if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function paintRole(role, text) {
    try {
      if (theme && typeof theme.fg === 'function') {
        const painted = theme.fg(role, text);
        if (typeof painted === 'string') return painted;
      }
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function accent(text) {
    try {
      const bolded = theme && typeof theme.bold === 'function' ? theme.bold(text) : text;
      if (theme && typeof theme.fg === 'function') return theme.fg('accent', bolded);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function dim(text) {
    return paintRole('dim', text);
  }

  function muted(text) {
    return paintRole('muted', text);
  }

  function errorText(text) {
    return paintRole('error', text);
  }

  function currentType() {
    return changeTypes[state.typeIndex] || changeTypes[0];
  }

  // The editing mode's frozen type and name are a DISPLAY read of the
  // checkout's own branch, never a re-derivation from the create-time
  // convention: a conventional `<type>/<slug>` splits into its two halves,
  // while any other branch (a detached HEAD, an unrelated name) leaves the
  // type unavailable and shows the branch the checkout actually has. With no
  // branch at all both stay unavailable.
  function checkoutFields() {
    if (providedBranch === null) return { type: null, name: null };
    const match = branchFormat.exec(providedBranch);
    if (!match) return { type: null, name: providedBranch };
    const known = changeTypes.find((type) => type.id === match[1]);
    return {
      type: { id: match[1], label: (known && known.label) || match[1] },
      name: providedBranch.slice(match[1].length + 1),
    };
  }

  // The live derivation, memoized: one `git check-ref-format` per distinct
  // (type, name) instead of one per keystroke.
  function derive() {
    const type = currentType();
    const name = state.name.trim();
    const key = `${type.id}\u0000${name}`;
    if (deriveCache.key === key) return deriveCache.value;
    let value;
    if (name === '') {
      value = { ok: false, branch: null, branchOk: false, path: null, pathOk: false, reason: 'name is empty' };
    } else if (!/[a-z0-9]/i.test(name)) {
      value = { ok: false, branch: null, branchOk: false, path: null, pathOk: false, reason: 'name has no letters or digits' };
    } else {
      let slug = '';
      try {
        slug = String(typeof git.slugifyBranch === 'function' ? git.slugifyBranch(name) : '');
      } catch {
        slug = '';
      }
      const branch = slug === '' ? '' : `${type.id}/${slug}`;
      if (branch === '' || !branchFormat.test(branch)) {
        value = {
          ok: false,
          branch: branch === '' ? null : branch,
          branchOk: false,
          path: null,
          pathOk: false,
          reason: `invalid branch name: ${branch === '' ? name : branch}`,
        };
      } else {
        let checked = { ok: true, reason: null };
        try {
          if (typeof git.validateBranch === 'function') checked = git.validateBranch(branch);
        } catch (err) {
          checked = { ok: false, reason: shortError(err) };
        }
        if (!checked || checked.ok !== true) {
          value = {
            ok: false,
            branch,
            branchOk: false,
            path: null,
            pathOk: false,
            reason: (checked && checked.reason) || `invalid branch name: ${branch}`,
          };
        } else {
          let target = null;
          let failure = null;
          try {
            target = principalLayout && typeof git.canonicalWorktreePath === 'function'
              ? git.canonicalWorktreePath(cwd, branch)
              : git.worktreePath(cwd, branch);
          } catch (err) {
            failure = shortError(err);
          }
          value = typeof target === 'string' && target !== '' && !failure
            ? { ok: true, branch, branchOk: true, path: target, pathOk: true, reason: null }
            : {
              ok: false,
              branch,
              branchOk: true,
              path: null,
              pathOk: false,
              reason: `cannot resolve the worktree path: ${failure || 'unknown error'}`,
            };
        }
      }
    }
    deriveCache = { key, value };
    return value;
  }

  function fieldMark(field) {
    return state.focus === field ? accent('❯ ') : '  ';
  }

  // The editing mode's frozen fields: no caret, no text-input focus, and the
  // label says why the edit keys do nothing here. The two values are the
  // checkout's own.
  function editFieldLines() {
    const fields = checkoutFields();
    const typeText = fields.type ? `${fields.type.label} (${fields.type.id})` : dim('unavailable');
    const nameText = fields.name === null || fields.name === '' ? dim('unavailable') : fields.name;
    const lock = dim(' [frozen]');
    return [
      `${fieldMark('type')}Type: ${typeText}${lock}`,
      `${fieldMark('name')}Name: ${nameText}${lock}`,
    ];
  }

  // S12: the create surface's single name line. The placeholder is ghost
  // text, never a value. S7: this row renders only under the FOCUSED Name tab,
  // so the caret is the typing position exactly when it is on screen.
  function nameLine() {
    const caret = `${cursorMarker}▊`;
    const value = state.name === '' ? `${caret}${dim(namePlaceholder)}` : `${state.name}${caret}`;
    return `Name: ${value}`;
  }

  // S7: the two fields are TABS, not two stacked rows — one strip with the
  // active label accented and the other dimmed, the same idiom the editing
  // mode's dataset tabs use, so "where am I" reads the same everywhere.
  function createTabs() {
    const label = (field, title) => (state.focus === field ? accent(title) : dim(title));
    return `${label('type', 'Type')} · ${label('name', 'Name')}`;
  }

  // S20: the editing header's preview summary pairs the frozen checkout with
  // the SELECTED association counts. Counts are always facts about the
  // current selection.
  function countsLine() {
    const issues = state.selectedIssues.length;
    const odd = state.selectedOdd === null ? 0 : 1;
    return `selected: ${issues} ${issues === 1 ? 'issue' : 'issues'} · ${odd} odd`;
  }

  function rule(width) {
    return accent('─'.repeat(Math.max(0, width)));
  }

  function paneData(pane) {
    if (pane === 'odd') {
      return {
        status: state.odd.status,
        error: state.odd.error,
        all: state.odd.rows,
        query: state.queries.odd,
        filtered: (() => {
          try {
            return picker.filterOddItems(state.odd.rows, state.queries.odd);
          } catch {
            return state.odd.rows.slice();
          }
        })(),
      };
    }
    return {
      status: state.issues.status,
      error: state.issues.error,
      all: state.issues.rows,
      query: state.queries.issues,
      filtered: (() => {
        try {
          return picker.filterIssueItems(state.issues.rows, state.queries.issues);
        } catch {
          return state.issues.rows.slice();
        }
      })(),
    };
  }

  function contentRows() {
    const height = availableRows();
    // Editing header lines: rule, title, Search, type, name, branch, path,
    // selected counts, dataset tabs (+1 for a refusal message).
    const fixed = 9 + (state.message ? 1 : 0);
    // The tail is four lines: the counts, the key legend, the closing rule and
    // the one spare row this surface has always reserved (S12 leaves the edit
    // rows exactly as they are).
    return Math.max(1, height - fixed - 4);
  }

  function pageRows() {
    return pageSizeOption || contentRows();
  }

  function paneView(pane) {
    const data = paneData(pane);
    const size = pageRows();
    const cursor = data.filtered.length === 0
      ? 0
      : Math.min(Math.max(0, state.cursor[pane]), data.filtered.length - 1);
    let page;
    try {
      page = picker.paginate(data.filtered, Math.floor(cursor / size), size);
    } catch {
      page = { items: data.filtered.slice(), page: 0, pageCount: 1, total: data.filtered.length };
    }
    return { ...data, size, cursor, page: page.page, pageCount: page.pageCount, items: page.items };
  }

  function activePane() {
    return state.focus === 'issues' || state.focus === 'odd' ? state.focus : state.pane;
  }

  function rowKey(pane, row) {
    return `${pane}:${row.id}`;
  }

  function setPreview(pane, row, result) {
    const key = rowKey(pane, row);
    const entry = previews.get(key);
    if (!entry) return;
    if (!result || result.ok !== true) {
      entry.status = 'error';
      entry.error = (result && result.error) || 'cannot read the preview';
    } else if (pane === 'issues') {
      const issue = result.issue && typeof result.issue === 'object' ? result.issue : null;
      if (!issue) {
        entry.status = 'error';
        entry.error = 'the issue preview came back empty';
      } else {
        const comments = Array.isArray(result.comments) ? result.comments.length : 0;
        const meta = [issue.state || 'open'];
        if (issue.author) meta.push(`by ${issue.author}`);
        if (comments > 0) meta.push(`${comments} comment${comments === 1 ? '' : 's'}`);
        entry.status = 'ready';
        entry.header = [`#${issue.number} ${issue.title}`, meta.join(' · '), ''];
        entry.text = typeof issue.body === 'string' ? issue.body : '';
        if (entry.text.trim() === '') entry.header = [...entry.header, dim('(no description)')];
      }
    } else if (typeof result.text === 'string') {
      entry.status = 'ready';
      entry.header = [];
      entry.text = result.text;
    } else {
      entry.status = 'error';
      entry.error = 'the odd preview came back empty';
    }
    rendered.clear();
    requestPaint();
  }

  // Read the focused row's preview the moment it gains focus — and only
  // then. A row already in the cache is never read again.
  function ensurePreview() {
    const pane = activePane();
    state.pane = pane;
    const view = paneView(pane);
    const row = view.filtered[view.cursor];
    if (!row) return;
    const key = rowKey(pane, row);
    if (previews.has(key)) return;
    const entry = { status: 'loading', error: null, header: [], text: '' };
    previews.set(key, entry);
    let pending;
    try {
      pending = pane === 'issues'
        ? readIssuePreview(row.number)
        : readOddPreview({ name: row.name, path: row.abs });
    } catch (err) {
      entry.status = 'error';
      entry.error = shortError(err);
      return;
    }
    if (pending && typeof pending.then === 'function') {
      pending.then(
        (value) => setPreview(pane, row, value),
        (err) => setPreview(pane, row, { ok: false, error: shortError(err) }),
      );
    } else {
      setPreview(pane, row, pending);
    }
  }

  function setFocus(focus) {
    state.focus = focus;
    if (focus === 'issues' || focus === 'odd') state.pane = focus;
    if (editing) ensurePreview();
    requestPaint();
  }

  function applyIssues(result) {
    if (!result || result.ok !== true) {
      state.issues = {
        status: 'unavailable',
        error: (result && result.error) || 'cannot list open issues',
        rows: [],
      };
    } else {
      const rows = Array.isArray(result.issues) ? result.issues : [];
      state.issues = {
        status: rows.length > 0 ? 'ready' : 'empty',
        error: null,
        rows: picker.issuePickItems(rows),
      };
    }
    state.cursor.issues = 0;
    requestPaint();
    ensurePreview();
  }

  function applyOdd(result) {
    if (!result || result.ok !== true) {
      state.odd = {
        status: 'unavailable',
        error: (result && result.error) || 'cannot list odd documents',
        rows: [],
      };
    } else {
      const docs = Array.isArray(result.docs) ? result.docs : [];
      // `oddPickItems` keys a document row by its absolute path. The list is
      // rendered in the SOURCE order lib/odd-docs.js produced — already
      // most-recently-modified first with a name tie-break (S15) — so the
      // pane never re-sorts, re-ranks or drops a row the source handed it.
      const rows = picker.oddPickItems(docs.map((doc) => ({ name: doc.name, abs: doc.path })));
      state.odd = { status: rows.length > 0 ? 'ready' : 'empty', error: null, rows };
    }
    state.cursor.odd = 0;
    requestPaint();
    ensurePreview();
  }

  function settle(loader, apply) {
    let pending;
    try {
      pending = loader();
    } catch (err) {
      apply({ ok: false, error: shortError(err) });
      return;
    }
    if (pending && typeof pending.then === 'function') {
      pending.then(
        (value) => apply(value),
        (err) => apply({ ok: false, error: shortError(err) }),
      );
      return;
    }
    apply(pending);
  }

  function previewLines(pane, row, width) {
    const entry = previews.get(rowKey(pane, row));
    if (!entry) return [];
    if (entry.status === 'loading') return [muted('reading…')];
    if (entry.status === 'error') return [errorText(`cannot read: ${entry.error}`)];
    const key = `${rowKey(pane, row)}@${width}`;
    const cached = rendered.get(key);
    if (cached) return cached;
    let body;
    try {
      body = renderMarkdown(entry.text, {
        width,
        paint: (role, text) => paintRole(role, text),
        emphasis: (text) => (theme && typeof theme.bold === 'function' ? theme.bold(text) : text),
        measure: (text) => measure(helpers, text),
      });
      if (!Array.isArray(body)) body = [];
    } catch {
      body = String(entry.text).split('\n');
    }
    const lines = [...entry.header, ...body];
    rendered.set(key, lines);
    return lines;
  }

  function paneMessage(pane, view) {
    if (view.status === 'loading') {
      return { paint: 'dim', text: pane === 'issues' ? 'loading open issues…' : 'loading odd documents…' };
    }
    if (view.status === 'unavailable') {
      return {
        paint: 'error',
        text: pane === 'issues' ? `gh unavailable: ${view.error}` : `cannot list odd documents: ${view.error}`,
      };
    }
    if (view.all.length === 0) {
      return {
        paint: 'dim',
        text: pane === 'issues' ? 'no open issues' : 'no odd documents in this checkout',
      };
    }
    if (view.filtered.length === 0) return { paint: 'dim', text: 'no matches' };
    return null;
  }

  function paintByKind(kind, text) {
    if (kind === 'error') return errorText(text);
    if (kind === 'dim') return muted(text);
    return text;
  }

  // Whether a row is selected. Exact ids are the rule for the issues list;
  // an odd assignment stored as a relative path (`odd/tasks/x.md`) or a bare
  // name still marks its row — the same base-name rule lib/odd-view.js
  // applies when it loads the registry's association.
  function isSelected(pane, row) {
    if (pane === 'issues') return state.selectedIssues.includes(row.id);
    if (state.selectedOdd === null) return false;
    if (state.selectedOdd === row.id) return true;
    const file = `${row.label}.md`;
    return state.selectedOdd === row.name || state.selectedOdd.split('/').pop() === file;
  }

  function listCell(pane, view, index, width) {
    const message = paneMessage(pane, view);
    if (view.filtered.length === 0) {
      if (!message) return '';
      const lines = wrapText(message.text, width);
      const line = lines[index];
      return line === undefined ? '' : paintByKind(message.paint, line);
    }
    const item = view.items[index];
    if (!item) return '';
    const absolute = view.page * view.size + index;
    const focused = activePane() === pane && absolute === view.cursor;
    const selected = isSelected(pane, item);
    return `${focused ? accent('❯ ') : '  '}[${selected ? 'x' : ' '}] ${item.label}`;
  }

  function previewCell(pane, view, index, width) {
    if (width <= 0) return '';
    const row = view.filtered[view.cursor];
    if (!row) return index === 0 ? muted('nothing to preview') : '';
    const lines = previewLines(pane, row, width);
    return lines[index] ?? '';
  }

  function columnRow(cols, width, left, right) {
    if (cols.preview === 0) return pad(helpers, left ?? '', width);
    return `${pad(helpers, left ?? '', cols.list)}${' '.repeat(cols.gap)}${pad(helpers, right ?? '', cols.preview)}`;
  }

  // The two dataset tabs (S11): the active dataset owns the left pane and
  // its preview the right one. Both names stay visible so the toggle is
  // discoverable without a key list.
  function paneTabs(issueView, oddView) {
    const active = activePane();
    const label = (pane, view) => {
      const title = pane === 'issues' ? 'Issues' : 'Odd';
      const count = view.filtered.length === view.all.length
        ? String(view.all.length)
        : `${view.filtered.length}/${view.all.length}`;
      const text = `${title} ${count}`;
      return pane === active ? accent(text) : dim(text);
    };
    return `${label('issues', issueView)} · ${label('odd', oddView)}`;
  }

  // S26: the filter is a dedicated `Search` row directly under the title
  // (the Commands-palette shape), never buried in a dataset heading or the
  // footer. It always names the ACTIVE dataset because the two datasets keep
  // independent queries, and it shows the query with the same caret the name
  // field uses while the filter is open. The row is a display of the existing
  // rule (`T` or any printable key opens the filter): no extra key, no new
  // focus target.
  function searchRow() {
    const label = activePane() === 'issues' ? 'Search Issues:' : 'Search Odd:';
    const query = state.queries[activePane()];
    const caret = `${cursorMarker}${state.filterOpen ? '▊' : ''}`;
    if (query === '') return `${label} ${caret === '' ? dim('type to filter') : caret}`;
    return `${label} ${query}${caret}`;
  }

  function paneLines(width, rows) {
    const cols = columns(width);
    const pane = activePane();
    const view = paneView(pane);
    const out = [];
    for (let index = 0; index < rows; index += 1) {
      out.push(columnRow(
        cols,
        width,
        listCell(pane, view, index, cols.list),
        previewCell(pane, view, index, cols.preview),
      ));
    }
    return out;
  }

  // S12: the inline change-type list. The SELECTED type (and therefore the
  // preview) follows the cursor, and the list is windowed around it when the
  // host offers fewer rows than the convention has types. The `❯` marker is
  // the same one the fields use, so "where am I" reads the same everywhere.
  function typeListWindow(room) {
    const count = changeTypes.length;
    const size = Math.min(count, Math.max(0, room));
    if (size === 0) return { start: 0, size: 0 };
    const centred = state.typeIndex - Math.floor(size / 2);
    return { start: Math.min(Math.max(0, centred), count - size), size };
  }

  function typeListLines(width, room) {
    const { start, size } = typeListWindow(room);
    const out = [];
    for (let offset = 0; offset < size; offset += 1) {
      const at = start + offset;
      const type = changeTypes[at];
      const text = `${at === state.typeIndex ? '❯ ' : '  '}${type.label} (${type.id})`;
      out.push(fit(helpers, at === state.typeIndex ? accent(text) : text, width));
    }
    return out;
  }

  // S12: the create surface is COMPACT — it renders exactly its own content
  // and never pads out to the host's row budget, so the host can mount it at
  // the bottom of the terminal without slack rows above or below it. S7: the
  // preview sits ABOVE the tab strip, only the ACTIVE tab's field renders
  // under it (the type list belongs to the Type tab), and an underivable
  // preview stays blank instead of red.
  function renderCreate(w, maxRows) {
    const messageRows = state.message ? 1 : 0;
    if (maxRows < CREATE_FIXED_ROWS + messageRows) {
      return [pad(helpers, dim('New worktree — enlarge the terminal'), w)];
    }
    const derived = derive();
    const branchLine = `preview branch: ${derived.branchOk ? derived.branch : dim(PREVIEW_EMPTY)}`;
    const pathLine = `preview path: ${derived.pathOk ? derived.path : dim(PREVIEW_EMPTY)}`;
    const room = Math.max(0, maxRows - CREATE_FIXED_ROWS - messageRows);
    const lines = [
      rule(w),
      accent('New worktree'),
      fit(helpers, branchLine, w),
      fit(helpers, pathLine, w),
      fit(helpers, createTabs(), w),
    ];
    if (state.focus === 'type') {
      const type = currentType();
      lines.push(fit(helpers, `Type: ${type.label} (${type.id})`, w));
      lines.push(...typeListLines(w, room));
    } else {
      lines.push(fit(helpers, nameLine(), w));
    }
    if (state.message) lines.push(fit(helpers, errorText(`cannot create: ${state.message}`), w));
    lines.push(fit(helpers, dim(legendText(helpers, CREATE_KEYS, w)), w));
    lines.push(rule(w));
    return lines.map((line) => pad(helpers, line, w));
  }

  function render(width) {
    const w = Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    if (!editing) return renderCreate(w, height);

    // The checkout's OWN branch and path, verbatim. The caller hands them
    // in and the panel never derives them from the conventional format; a
    // value it does not have is shown as unavailable.
    const branchLine = providedBranch !== null
      ? `checkout branch: ${providedBranch}`
      : dim('checkout branch: unavailable');
    const pathLine = providedPath !== null
      ? `checkout path: ${providedPath}`
      : dim('checkout path: unavailable');

    const head = [];
    head.push(rule(w));
    head.push(accent('Edit worktree'));
    head.push(fit(helpers, searchRow(), w));
    for (const line of editFieldLines()) head.push(fit(helpers, line, w));
    head.push(fit(helpers, branchLine, w));
    head.push(fit(helpers, pathLine, w));
    head.push(fit(helpers, countsLine(), w));
    if (state.message) head.push(fit(helpers, errorText(`cannot save: ${state.message}`), w));
    head.push(columnRow(columns(w), w, paneTabs(paneView('issues'), paneView('odd')), accent('Preview')));

    const tail = [];
    const issueView = paneView('issues');
    const oddView = paneView('odd');
    const issuePage = `${issueView.page + 1}/${issueView.pageCount}`;
    const oddPage = `${oddView.page + 1}/${oddView.pageCount}`;
    const oddSelected = state.selectedOdd === null ? 0 : 1;
    tail.push(dim(`Issues ${issueView.all.length} open · ${state.selectedIssues.length} selected · page ${issuePage}   Odd ${oddView.all.length} docs · ${oddSelected} selected · page ${oddPage}`));
    if (state.filterOpen && (state.focus === 'issues' || state.focus === 'odd')) {
      tail.push(dim(legendText(helpers, FILTER_KEYS, w)));
    } else {
      tail.push(dim(legendText(helpers, EDIT_KEYS, w)));
    }
    tail.push(rule(w));

    const rows = Math.max(0, height - head.length - tail.length);
    const out = [...head, ...paneLines(w, rows), ...tail].slice(0, height);
    while (out.length < height) out.push('');
    return out.map((line) => pad(helpers, line, w));
  }

  function moveCursor(delta) {
    const pane = state.focus === 'issues' || state.focus === 'odd' ? state.focus : state.pane;
    const view = paneView(pane);
    const max = Math.max(0, view.filtered.length - 1);
    state.cursor[pane] = Math.min(Math.max(0, view.cursor + delta), max);
    ensurePreview();
    requestPaint();
  }

  function turnPage(delta) {
    const pane = state.focus === 'issues' || state.focus === 'odd' ? state.focus : state.pane;
    const view = paneView(pane);
    const size = view.size;
    const page = Math.min(Math.max(0, view.page + delta), view.pageCount - 1);
    state.cursor[pane] = view.filtered.length === 0 ? 0 : Math.min(page * size, view.filtered.length - 1);
    ensurePreview();
    requestPaint();
  }

  // S8a: the Odd control is a SELECT, not a multi-toggle — choosing another
  // document replaces the active one, and choosing the active one clears the
  // association. The issues list keeps its toggle.
  function toggleFocused() {
    const pane = state.focus === 'issues' || state.focus === 'odd' ? state.focus : state.pane;
    const view = paneView(pane);
    const row = view.filtered[view.cursor];
    if (!row) return;
    if (pane === 'odd') {
      state.selectedOdd = isSelected('odd', row) ? null : row.id;
    } else {
      const at = state.selectedIssues.indexOf(row.id);
      if (at >= 0) state.selectedIssues.splice(at, 1);
      else state.selectedIssues.push(row.id);
    }
    requestPaint();
  }

  function openFilter() {
    const pane = state.focus === 'issues' || state.focus === 'odd' ? state.focus : state.pane;
    state.filterOpen = true;
    state.pane = pane;
    requestPaint();
  }

  function editQuery(mutator) {
    const pane = state.focus === 'issues' || state.focus === 'odd' ? state.focus : state.pane;
    state.queries[pane] = mutator(state.queries[pane]);
    state.cursor[pane] = 0;
    ensurePreview();
    requestPaint();
  }

  function selectedPayload() {
    return {
      issues: state.selectedIssues.slice().sort((left, right) => left - right),
      odd: state.selectedOdd,
    };
  }

  function create() {
    if (editing) {
      // S13: the checkout already exists, so validation is not this mode's
      // job. The create-time convention must never refuse to open or save an
      // existing checkout whose branch or path differ from it.
      const fields = checkoutFields();
      const selected = selectedPayload();
      finish({
        ok: true,
        mode: 'edit',
        type: fields.type ? fields.type.id : null,
        name: fields.name,
        issues: selected.issues,
        odd: selected.odd,
      });
      return;
    }
    const derived = derive();
    if (!derived.ok) {
      state.message = derived.reason;
      requestPaint();
      return;
    }
    // S6: a creation carries the two things it asked for and nothing else.
    // No `issues`, no `odd`: a brand-new row is born without an association.
    finish({
      ok: true,
      type: currentType().id,
      name: state.name.trim(),
    });
  }

  function handleFilter(data) {
    if (keyText(helpers, data, ['up'])) {
      moveCursor(-1);
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveCursor(1);
      return;
    }
    if (keyText(helpers, data, ['pageup']) || keyText(helpers, data, ['['])) {
      turnPage(-1);
      return;
    }
    if (keyText(helpers, data, ['pagedown']) || keyText(helpers, data, [']'])) {
      turnPage(1);
      return;
    }
    if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
      if (state.focus === 'issues' || state.focus === 'odd') {
        if (state.queries[state.focus] !== '') {
          editQuery((query) => [...query].slice(0, -1).join(''));
        }
      }
      return;
    }
    const char = printableChar(data);
    if (char !== '') editQuery((query) => query + char);
  }

  // S12: the create surface's Type field is a LIST, not a text field. `↑`/`↓`
  // pick the type in place (the preview follows live), `enter` reaches the
  // name, and any printable character starts the name instead of being
  // swallowed — nobody should type into a list and see nothing happen.
  function handleCreateTypeField(data) {
    if (keyText(helpers, data, ['up'])) {
      moveType(-1);
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveType(1);
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      setFocus('name');
      return;
    }
    const char = printableChar(data);
    if (char !== '') {
      state.focus = 'name';
      state.name += char;
      state.message = '';
      requestPaint();
    }
  }

  function moveType(delta) {
    const last = Math.max(0, changeTypes.length - 1);
    state.typeIndex = Math.min(last, Math.max(0, state.typeIndex + delta));
    state.message = '';
    requestPaint();
  }

  // S12: only two fields exist while creating, so `tab`, `shift+tab` and both
  // horizontal arrows move between their tabs; a horizontal key at either end
  // wraps to the other tab instead of dying.
  function toggleCreateField() {
    state.focus = state.focus === 'type' ? 'name' : 'type';
    requestPaint();
  }

  function handleNameField(data) {
    if (keyText(helpers, data, ['enter', 'return'])) {
      // S12: the name is the SECOND and LAST field of a creation, so `enter`
      // there creates. In editing mode `enter` reaches the association panes.
      if (editing) setFocus(state.pane);
      else create();
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      // In editing mode `↓` from the name reaches the active list (`↑` on the
      // first list row is the way back). While creating, nothing sits below
      // the name — the surface is two fields — so `↓` stays put.
      if (editing) setFocus(state.pane);
      return;
    }
    if (keyText(helpers, data, ['up'])) {
      setFocus('type');
      return;
    }
    // S13: navigation stays, but a frozen name accepts no text edits.
    if (editing) return;
    if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
      if (state.name !== '') {
        state.name = [...state.name].slice(0, -1).join('');
        state.message = '';
        requestPaint();
      }
      return;
    }
    if (keyText(helpers, data, ['pageup', 'pagedown'])) return;
    const char = printableChar(data);
    if (char !== '') {
      state.name += char;
      state.message = '';
      requestPaint();
    }
  }

  function handlePane(data) {
    const pane = state.focus === 'issues' || state.focus === 'odd' ? state.focus : state.pane;
    if (keyText(helpers, data, ['up'])) {
      // S21: `↑` on the FIRST row leaves the list for the Name field (and a
      // further `↑` reaches Type); anywhere else it moves the row, so the
      // header is reachable without a hidden shortcut and the position is
      // kept where the user left it.
      if (paneView(pane).cursor === 0) {
        setFocus('name');
        return;
      }
      moveCursor(-1);
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveCursor(1);
      return;
    }
    if (keyText(helpers, data, ['pageup']) || keyText(helpers, data, ['['])) {
      turnPage(-1);
      return;
    }
    if (keyText(helpers, data, ['pagedown']) || keyText(helpers, data, [']'])) {
      turnPage(1);
      return;
    }
    if (keyText(helpers, data, ['space'])) {
      toggleFocused();
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      // Enter confirms the focused field: Issues -> Odd, and the Odd pane
      // is the LAST field, so Enter there creates.
      if (pane === 'issues') setFocus('odd');
      else create();
      return;
    }
    // S21: the list's `←`/`→` select the Issues and Odd datasets (the same
    // behaviour as the tabs). They never move focus to a lateral field and
    // the preview is read-only, never focused.
    if (keyText(helpers, data, ['left'])) {
      setFocus('issues');
      return;
    }
    if (keyText(helpers, data, ['right'])) {
      setFocus('odd');
      return;
    }
    // S6's rule: a printable key that is not a binding opens the filter.
    const char = printableChar(data);
    if (char !== '') {
      openFilter();
      return;
    }
  }

  function handleInput(data) {
    if (settled) return;
    if (isKeyRelease(helpers, data)) return;
    // Ctrl+S saves the assignment panes in EDITING mode only. Creating has ONE
    // confirm key (`enter` on the name); a second way to do the same thing is a
    // duplicate the user reported, so the key is inert while creating.
    if (editing && keyText(helpers, data, ['ctrl+s'])) {
      create();
      return;
    }
    // Esc unwinds the innermost layer first, then cancels the interaction.
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      if (editing && state.filterOpen) {
        state.filterOpen = false;
        requestPaint();
        return;
      }
      finish(null);
      return;
    }
    if (state.filterOpen && (state.focus === 'issues' || state.focus === 'odd')) {
      if (keyText(helpers, data, ['enter', 'return'])) {
        state.filterOpen = false;
        requestPaint();
        return;
      }
      handleFilter(data);
      return;
    }
    // `tab` belongs to the EDITING mode's dataset toggle. On the create
    // surface it moves between the two fields, as do the horizontal arrows,
    // which is what the reported flow asked for (S12).
    if (editing && keyText(helpers, data, ['tab'])) {
      setFocus(state.focus === 'issues' ? 'odd' : 'issues');
      return;
    }
    if (!editing && keyText(helpers, data, ['tab', 'shift+tab', 'left', 'right'])) {
      toggleCreateField();
      return;
    }
    if (state.focus === 'name') {
      handleNameField(data);
      return;
    }
    if (state.focus === 'issues' || state.focus === 'odd') {
      handlePane(data);
      return;
    }
    if (editing) {
      // Frozen: the type list is not a picker here; `↓` still reaches the name.
      if (keyText(helpers, data, ['down'])) setFocus('name');
      return;
    }
    handleCreateTypeField(data);
  }

  function invalidate() {
    rendered.clear();
  }

  // S6: only the editing mode owns datasets, so only it ever reads one.
  if (editing) {
    settle(fetchIssues, applyIssues);
    settle(listOdd, applyOdd);
  }
  return { render, handleInput, invalidate, state };
}

module.exports = {
  CHANGE_TYPES,
  NAME_PLACEHOLDER,
  createWarpCreatePanel,
};
