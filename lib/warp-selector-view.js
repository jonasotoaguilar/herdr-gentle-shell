'use strict';
// Warp selector, redesigned as ONE popup component with TWO views
// (warp-popup S1,S2,S5,S6,S9): the popup and the extended list. PURE: no
// fs, no git, no registry — every external read arrives as an injected
// option, so the wiring unit only has to hand over data and a `done`.
//
// Host component contract (the shape the customize panel and the pickers
// already use): the factory returns
// `{ render(width), handleInput(data), invalidate(), state }`.
//
// Options
//   checkouts      array of `{ name, path, branch, isPrincipal }`; `name`
//                  defaults to the path's last segment, `branch` may be
//                  omitted, and an entry without a `path` is dropped. An
//                  entry may also carry `lastActivity` — an epoch-ms number
//                  or an ISO string, or the `{available, value, reason}`
//                  envelope `checkout-facts` returns — plus
//                  `lastActivityReason`. Rows are ordered by that value
//                  descending, and a checkout whose value is unreadable
//                  (`null`, missing, `'unavailable'`, unparsable) sorts last
//                  with its reason kept for the facts line (S12).
//   current        `{ name, path }` (or just the path string) of the
//                  checkout this session is in: it is the popup's CURRENT
//                  row and is never listed again under `Choose worktree`.
//   facts(path)    reader for the FOCUSED checkout, called at most once
//                  per checkout until `r`. Resolves (or returns) either
//                  `null`/`undefined` or an object
//                    {
//                      branch:    string,
//                      issues:    array of issue numbers,
//                      odd:       array of odd document names,
//                      changes:   the change size as `{ added, deleted }`
//                                 line counts (S16); a caller that can only
//                                 supply `{ files }` proves a zero when it
//                                 is 0 and renders `unavailable` otherwise,
//                      ahead:     commits ahead of the base (integer),
//                      behind:    commits behind the base (integer),
//                      createdAt:  a timestamp (epoch-ms number or ISO
//                                 string) or the `{available, value, reason}`
//                                 envelope; rendered as `created <age>`,
//                      lastActivity: the last-activity timestamp in the same
//                                 forms; rendered as `modified <age>`,
//                      createdAtReason / lastActivityReason: optional
//                                 strings shown instead of `unavailable`,
//                    }
//                  Each field is independently optional: a missing, `null`
//                  or `'unavailable'` value renders `unavailable` (S9) and
//                  never `0`. `[]` means a readable empty list: issues and
//                  odd render its `0` (S16), while a measured zero for the
//                  change size or for one of `↑`/`↓` disappears from the
//                  line entirely instead of printing `0`. A rejected read
//                  degrades to every fact `unavailable`. The read is
//                  asynchronous and never blocks a frame: a pending read
//                  renders `reading …`.
//   reload()       called on `r`; may return a new checkouts array (or a
//                  promise of one). Every cached fact is dropped either way.
//   onToggle(path) OPTIONAL. When supplied the extended list has a toggle,
//                  so `space` toggles the focused checkout while the filter
//                  is closed (S6). Without it `space` is an ordinary
//                  printable and opens the filter.
//   helpers        `{ visibleWidth, truncateToWidth, matchesKey, isKeyRelease }`.
//   theme          `{ fg(role, text), bg(role, text) }`; a hostile theme
//                  keeps plain text.
//   rowsAvailable  number of rows the host offers (number or function).
//   requestRender  repaint request, called after every state change.
//   done(value)    the ONLY way out, called at most once:
//                    `null`          closed with `esc`/`ctrl+c` (popup)
//                    `{ warp: path }` warp to that checkout (`enter`)
//                    `{ create: true }` open the create panel (`enter` on
//                                    the create row)
//                    `{ edit: path }` edit that checkout (`e` on a checkout
//                                    row; S13)
//                  `View all` / `v` never resolve: they open the extended
//                  list of the same component, and `esc` there steps back
//                  one level to the popup.
//
// Keys, exactly (S5 + docs/keys.md): `↑`/`↓` and `j`/`k` move, `enter`
// chooses (and opens the extended list on `View all`), `e` edits the focused
// checkout (inert on the create/View all rows and on an empty list), `v`
// opens the extended list, `r` reloads, `esc`/`ctrl+c` close from the popup
// or step back from the list. S9 keeps the footer shortcuts and binds no
// `?` help overlay: the footer already names every key. `↑`/`↓` are
// never repurposed for ahead/behind: both numbers ride the facts line. In the
// extended list the filter is always active (S6): `↑`/`↓`, `enter`, `esc`
// and `pgUp`/`pgDn` stay bindings, `T` or `/` open an empty filter, any
// other printable opens it with that character, and once open every
// printable — `space` included — goes to the text. `esc` closes the filter
// keeping the query; the next `esc` steps back to the popup.
//
// S5: a selector row is the checkout NAME alone, taking the width the host
// offers; the branch is not repeated there because the focused checkout's
// facts line already names it. S6: the principal is the first selectable
// checkout whenever it is not the current one. S7: the facts footer carries
// only the issue and odd COUNTS (zero included), never the full lists — the
// edit/detail surface and the stored registry keep every association.
//
// Layout (pinned, the height fills exactly):
//   popup  9 fixed rows — top rule, current, `New worktree`, the create
//          row, the blank separator, `Choose worktree`, the list (as many
//          rows as the height allows, plus a final `View all` row when some
//          checkouts were left out), the focused checkout's facts, the key
//          footer, the bottom rule.
//   list   5 fixed rows — top rule, the filter row (never selectable), a
//          page of every checkout, the page indicator and the key footer,
//          the bottom rule.

const { stripAnsi } = require('./odd-markdown.js');
// Reused, not re-implemented: the pickers' page clamps and their
// independent-fact row shape are the invariants this view shares.
const { paginate } = require('./warp-create-picker.js');

const MIN_WIDTH = 24;
const POPUP_MIN_HEIGHT = 10;
const LIST_MIN_HEIGHT = 8;
// top rule + current + section title + create row + separator + section
// title + facts + footer + bottom rule.
const POPUP_FIXED_ROWS = 9;
// top rule + filter row + page indicator + footer + bottom rule.
const LIST_FIXED_ROWS = 5;
const UNAVAILABLE = 'unavailable';
const POPUP_KEYS = '↑↓ move · enter choose · e edit · v all · r reload · esc close';
const LIST_KEYS = '↑↓ move · pgUp/pgDn page · enter warp · r reload · esc back';

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
      const bolded = theme.bold(text);
      if (typeof bolded === 'string') return bolded;
    }
  } catch {
    // Fall through to the accent form below.
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

// Raw fallbacks for the keys this view binds, mirroring the sequence the
// installed matcher accepts in legacy mode, so the popup stays drivable
// when the helper module failed to load (a popup that ignores Esc reads as
// frozen).
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  enter: ['\r', '\n'],
  return: ['\r', '\n'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  delete: ['\x1b[3~', '\x7f'],
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
    // A throwing classifier never releases.
  }
  return false;
}

// The single printable codepoint a keystroke carries, or null. Space is
// printable: it only reaches this helper where no toggle claims it.
function printableChar(data) {
  if (typeof data !== 'string' || data.length === 0 || data === 'space') return null;
  const chars = [...data];
  if (chars.length !== 1) return null;
  const code = chars[0].codePointAt(0);
  if (!Number.isFinite(code) || code < 0x20 || code === 0x7f) return null;
  return chars[0];
}

function isSpaceKey(helpers, data) {
  // `space` (the kitty name) and the raw byte both mean space.
  if (data === ' ') return true;
  return keyText(helpers, data, ['space']);
}

function basename(target) {
  const parts = String(target).split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : String(target);
}

// Epoch ms for a timestamp in any of the forms a caller may supply: a finite
// number, a Date, or an ISO string. Null when it is not a readable timestamp
// (S9: an unreadable value is never a zero).
function toTimestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '' || text === UNAVAILABLE) return null;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// The ordering timestamp a checkout entry reports, in the forms the options
// doc names. `at: null` means unreadable, and `reason` keeps what the caller
// said about it so the facts line can show that instead of a fake date.
function lastActivityOf(entry) {
  let value = entry.lastActivity;
  let reason = typeof entry.lastActivityReason === 'string' && entry.lastActivityReason.length > 0
    ? entry.lastActivityReason
    : null;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (value.available === false) {
      return {
        at: null,
        reason: typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : reason,
      };
    }
    if (typeof value.reason === 'string' && value.reason.length > 0) reason = value.reason;
    value = value.value;
  }
  const at = toTimestampMs(value);
  return { at, reason: at === null ? reason : null };
}

function normalizeCheckouts(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : basename(entry.path);
    const branch = typeof entry.branch === 'string' && entry.branch.length > 0 ? entry.branch : null;
    const activity = lastActivityOf(entry);
    out.push({
      name,
      path: entry.path,
      branch,
      isPrincipal: entry.isPrincipal === true,
      lastActivity: activity.at,
      lastActivityReason: activity.reason,
    });
  }
  // S6: the principal leads whenever it is present and not the current
  // checkout, whatever its activity: the comparator below puts a principal
  // row ahead of every other row regardless of timestamps. Every other row
  // follows most-recent-first; an unreadable value sorts last, and a stable
  // sort keeps the caller's order among equals (S12).
  out.sort((a, b) => {
    if (a.isPrincipal !== b.isPrincipal) return a.isPrincipal ? -1 : 1;
    if (a.lastActivity === null && b.lastActivity === null) return 0;
    if (a.lastActivity === null) return 1;
    if (b.lastActivity === null) return -1;
    return b.lastActivity - a.lastActivity;
  });
  return out;
}

function normalizeCurrent(current, checkouts) {
  if (typeof current === 'string' && current.length > 0) {
    const hit = checkouts.find((entry) => entry.path === current);
    return hit ? { name: hit.name, path: hit.path } : { name: basename(current), path: current };
  }
  if (current && typeof current === 'object' && typeof current.path === 'string' && current.path.length > 0) {
    const name = typeof current.name === 'string' && current.name.length > 0 ? current.name : basename(current.path);
    return { name, path: current.path };
  }
  return null;
}

function missing(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && (value.trim() === '' || value.trim() === UNAVAILABLE);
}

function textFact(value) {
  return missing(value) ? UNAVAILABLE : String(value);
}

// S7: the footer carries the COUNT of associations (zero included), never
// the full list — the edit/detail surface shows which ones those are.
function countFact(value) {
  if (missing(value) || !Array.isArray(value)) return UNAVAILABLE;
  return String(value.length);
}

// Line counts for the change size (S16). `{ added, deleted }` is the fact's
// own shape; a caller that supplies only a file count can prove cleanliness
// (`files: 0` means no changed file could add or delete a line) but never a
// size, which stays unreadable rather than being faked or rendered as the
// retired file count.
function changeCounts(value) {
  if (value && typeof value === 'object') {
    const added = Number.isInteger(value.added) && value.added >= 0 ? value.added : null;
    const deleted = Number.isInteger(value.deleted) && value.deleted >= 0 ? value.deleted : null;
    if (added !== null && deleted !== null) return { added, deleted };
    if (Number.isInteger(value.files) && value.files >= 0) {
      return value.files === 0 ? { added: 0, deleted: 0 } : null;
    }
    return null;
  }
  if (Number.isInteger(value) && value >= 0) return value === 0 ? { added: 0, deleted: 0 } : null;
  return null;
}

// The rendered change size, or `null` when it is a measured zero and the
// field must not appear at all (S16). `unavailable` is NOT a zero and stays.
function changesFact(value) {
  if (missing(value)) return UNAVAILABLE;
  const counts = changeCounts(value);
  if (counts === null) return UNAVAILABLE;
  if (counts.added === 0 && counts.deleted === 0) return null;
  return `+${counts.added} −${counts.deleted}`;
}

// One direction of ahead/behind (S16): a measured zero is omitted (`null`),
// while an unreadable value is not a zero and stays with its glyph.
function arrowFact(glyph, value) {
  if (missing(value)) return `${glyph}${UNAVAILABLE}`;
  const count = Number.isInteger(value) && value >= 0 ? value : null;
  if (count === null) return `${glyph}${UNAVAILABLE}`;
  if (count === 0) return null;
  return `${glyph}${count}`;
}

// Relative age in this package's style, the same one the issues view uses
// (including its `ago` suffix) so two surfaces never describe the same clock
// two different ways: just now, minutes, hours, days, months, years.
function relativeAge(ms, nowMs) {
  const diff = nowMs - ms;
  if (!Number.isFinite(diff) || diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// One age fact: a timestamp in any accepted form, or the checkout-facts
// envelope. Unreadable stays `unavailable` — or the reason the caller
// supplied, so an unreadable row explains itself instead of faking a date.
function ageFact(raw, reason, nowMs) {
  let value = raw;
  let note = typeof reason === 'string' && reason.length > 0 ? reason : null;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if (value.available === false) {
      return typeof value.reason === 'string' && value.reason.length > 0 ? value.reason : (note || UNAVAILABLE);
    }
    if (typeof value.reason === 'string' && value.reason.length > 0) note = value.reason;
    value = value.value;
  }
  const at = toTimestampMs(value);
  if (at === null) return note || UNAVAILABLE;
  return relativeAge(at, nowMs);
}

// The popup's facts line: every fact of the focused checkout, one line, each
// independently honest (S9). S16 renders the change size as line counts and
// DROPS a measured zero for the change size and for each of `↑`/`↓`, while
// issues and odd keep their `0` and `unavailable` (with its reason where one
// was supplied) always stays. Exported so the wiring unit and its tests
// format exactly what the popup renders. `opts.now` pins the clock both ages
// use; `opts.lastActivityReason` is the focused row's own reason, shown when
// its facts carry none.
function formatFactsLine(facts, opts) {
  const value = facts && typeof facts === 'object' ? facts : {};
  const settings = opts && typeof opts === 'object' ? opts : {};
  const nowMs = Number.isFinite(settings.now) ? settings.now : Date.now();
  const activityReason = value.lastActivityReason || settings.lastActivityReason;
  const parts = [
    `branch ${textFact(value.branch)}`,
    `issues ${countFact(value.issues)}`,
    `odd ${countFact(value.odd)}`,
  ];
  const changes = changesFact(value.changes);
  if (changes !== null) parts.push(`changes ${changes}`);
  const arrows = [arrowFact('↑', value.ahead), arrowFact('↓', value.behind)]
    .filter((part) => part !== null)
    .join(' ');
  if (arrows.length > 0) parts.push(arrows);
  parts.push(
    `created ${ageFact(value.createdAt, value.createdAtReason, nowMs)}`,
    `modified ${ageFact(value.lastActivity, activityReason, nowMs)}`,
  );
  return parts.join(' · ');
}

function filterCheckouts(checkouts, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle === '') return checkouts.slice();
  return checkouts.filter((entry) => [entry.name, entry.branch || '', entry.path]
    .some((field) => String(field).toLowerCase().includes(needle)));
}

function createWarpSelectorView(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  let checkouts = normalizeCheckouts(opts.checkouts);
  const current = normalizeCurrent(opts.current, checkouts);
  const currentPath = current ? current.path : null;
  const factsReader = typeof opts.facts === 'function' ? opts.facts : null;
  const reloader = typeof opts.reload === 'function' ? opts.reload : null;
  const toggler = typeof opts.onToggle === 'function' ? opts.onToggle : null;
  const helpers = opts.helpers || null;
  const theme = opts.theme || null;
  const requestRender = typeof opts.requestRender === 'function' ? opts.requestRender : null;
  const rawFinish = typeof opts.done === 'function' ? opts.done : () => {};
  const nowOption = opts.now;
  const nowFn = typeof nowOption === 'function'
    ? () => {
        const value = nowOption();
        return Number.isFinite(value) ? value : Date.now();
      }
    : (Number.isFinite(nowOption) ? () => nowOption : () => Date.now());
  let settled = false;

  // The state is exposed for the wiring unit and for its tests: `view` is
  // 'popup' | 'list', `cursor` indexes the popup's selectable rows, and
  // `listCursor` the filtered extended list; `filter`/`filterOpen` are the
  // always-active filter, `page` the visible page, `help` the overlay, and
  // `checkouts`/`facts` the last data the component was given.
  const state = {
    view: 'popup',
    cursor: 0,
    listCursor: 0,
    filter: '',
    filterOpen: false,
    page: 0,
    checkouts,
    facts: { path: null, status: 'idle' },
  };
  // path -> { status: 'pending'|'ready'|'error', value }; S9 caches so a
  // frame never re-reads and a move back is instant.
  const factCache = new Map();

  function finish(value) {
    if (settled) return;
    settled = true;
    rawFinish(value);
  }

  function requestPaint() {
    if (!requestRender) return;
    try {
      requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  function availableRows() {
    let raw;
    try {
      raw = typeof opts.rowsAvailable === 'function' ? opts.rowsAvailable() : opts.rowsAvailable;
    } catch {
      return 0;
    }
    const rows = Math.floor(Number(raw));
    return Number.isFinite(rows) && rows > 0 ? rows : 0;
  }

  function startFacts(path) {
    if (typeof path !== 'string' || path.length === 0) return;
    if (factCache.has(path)) return;
    if (!factsReader) {
      factCache.set(path, { status: 'error', value: null });
      return;
    }
    factCache.set(path, { status: 'pending', value: null });
    state.facts = { path, status: 'pending' };
    let answer;
    try {
      answer = factsReader(path);
    } catch {
      factCache.set(path, { status: 'error', value: null });
      state.facts = { path, status: 'error' };
      return;
    }
    Promise.resolve(answer).then(
      (value) => {
        factCache.set(path, { status: 'ready', value });
        if (state.facts.path === path) state.facts = { path, status: 'ready' };
        if (state.view === 'popup' && focusedPopupPath() === path) requestPaint();
      },
      () => {
        factCache.set(path, { status: 'error', value: null });
        if (state.facts.path === path) state.facts = { path, status: 'error' };
        if (state.view === 'popup' && focusedPopupPath() === path) requestPaint();
      },
    );
  }

  function others() {
    return checkouts.filter((entry) => entry.path !== currentPath);
  }

  function allCheckouts() {
    return checkouts.slice();
  }

  function describe(entry, inList) {
    const parts = [];
    // S5: the branch is never a row suffix — the focused checkout's facts
    // footer is the one place it reads.
    if (entry.isPrincipal) parts.push('use the local project');
    if (inList && entry.path === currentPath) parts.push('current');
    return parts.length > 0 ? parts.join(' · ') : null;
  }

  // S5: a row is the name alone. `describe` appends only the non-branch
  // role markers (principal, current), so the row never repeats the branch.
  function rowText(entry, inList, marker) {
    const desc = describe(entry, inList);
    return `${marker}${entry.name}${desc ? ` · ${desc}` : ''}`;
  }

  function popupPlan(height) {
    const list = others();
    const listRows = Math.max(0, height - POPUP_FIXED_ROWS);
    if (listRows <= 0) return { list, shown: [], listRows, viewAll: false, hidden: list.length };
    if (list.length <= listRows) return { list, shown: list, listRows, viewAll: false, hidden: 0 };
    const shown = list.slice(0, Math.max(0, listRows - 1));
    return { list, shown, listRows, viewAll: true, hidden: list.length - shown.length };
  }

  function popupItems(plan) {
    const items = [{ kind: 'create' }];
    for (const entry of plan.shown) items.push({ kind: 'checkout', checkout: entry });
    if (plan.viewAll) items.push({ kind: 'viewall' });
    return items;
  }

  function popupItemsNow() {
    const height = availableRows();
    return height > 0 ? popupItems(popupPlan(height)) : [{ kind: 'create' }];
  }

  function focusedPopupItem() {
    const items = popupItemsNow();
    return items[Math.min(Math.max(0, state.cursor), items.length - 1)] || null;
  }

  function focusedPopupPath() {
    const item = focusedPopupItem();
    return item && item.kind === 'checkout' ? item.checkout.path : null;
  }

  function factsRowText() {
    const item = focusedPopupItem();
    if (!item || item.kind === 'create') return 'creates a worktree in one panel';
    if (item.kind === 'viewall') return 'every worktree, searchable';
    const nowMs = nowFn();
    const entryReason = item.checkout.lastActivityReason;
    const line = (value) => formatFactsLine(value, { now: nowMs, lastActivityReason: entryReason });
    const entry = factCache.get(item.checkout.path);
    if (!entry) return factsReader ? 'reading …' : line(null);
    if (entry.status === 'ready') return line(entry.value);
    if (entry.status === 'pending') return 'reading …';
    return line(null);
  }

  function listPlan(height) {
    const rows = filterCheckouts(allCheckouts(), state.filter);
    const pageSize = Math.max(1, height - LIST_FIXED_ROWS);
    const requested = rows.length === 0 ? 0 : Math.floor(Math.max(0, state.listCursor) / pageSize);
    const page = paginate(rows, requested, pageSize);
    const start = page.page * pageSize;
    const end = Math.min(rows.length, start + page.items.length);
    if (rows.length === 0) state.listCursor = 0;
    else state.listCursor = Math.min(Math.max(start, state.listCursor), end - 1);
    state.page = page.page;
    return { rows, page: page.page, pageCount: page.pageCount, pageSize, items: page.items, cursor: state.listCursor };
  }

  function focusedListCheckout() {
    const height = availableRows();
    if (!height) return null;
    const plan = listPlan(height);
    return plan.items[plan.cursor - plan.page * plan.pageSize] || null;
  }

  function movePopup(delta) {
    const height = availableRows();
    if (!height) return;
    const items = popupItems(popupPlan(height));
    if (items.length === 0) return;
    state.cursor = Math.min(items.length - 1, Math.max(0, state.cursor + delta));
    // S1: a move is what starts the focused checkout's read. render() itself
    // never performs I/O.
    if (state.view === 'popup') startFacts(focusedPopupPath());
    requestPaint();
  }

  function moveList(delta) {
    const height = availableRows();
    if (!height) return;
    const plan = listPlan(height);
    if (plan.rows.length === 0) return;
    state.listCursor = Math.min(plan.rows.length - 1, Math.max(0, plan.cursor + delta));
    requestPaint();
  }

  function pageList(direction) {
    const height = availableRows();
    if (!height) return;
    const plan = listPlan(height);
    if (plan.rows.length === 0) return;
    const next = direction > 0
      ? Math.min(plan.page + 1, plan.pageCount - 1)
      : Math.max(0, plan.page - 1);
    state.listCursor = Math.min(plan.rows.length - 1, next * plan.pageSize);
    requestPaint();
  }

  function openList() {
    state.view = 'list';
    state.listCursor = 0;
    const focused = focusedPopupItem();
    if (focused && focused.kind === 'checkout') {
      const rows = filterCheckouts(allCheckouts(), state.filter);
      const at = rows.findIndex((entry) => entry.path === focused.checkout.path);
      if (at >= 0) state.listCursor = at;
    }
    requestPaint();
  }

  function openFilter(seed) {
    state.filterOpen = true;
    if (typeof seed === 'string' && seed.length > 0) state.filter += seed;
    state.listCursor = 0;
    requestPaint();
  }

  function closeFilter() {
    state.filterOpen = false;
    requestPaint();
  }

  function appendFilter(text) {
    state.filter += text;
    state.listCursor = 0;
    requestPaint();
  }

  function backspaceFilter() {
    const chars = [...state.filter];
    if (chars.length === 0) return;
    chars.pop();
    state.filter = chars.join('');
    state.listCursor = 0;
    requestPaint();
  }

  function reload() {
    factCache.clear();
    state.facts = { path: null, status: 'idle' };
    let next;
    try {
      next = reloader ? reloader() : null;
    } catch {
      next = null;
    }
    const settle = (value) => { if (Array.isArray(value)) apply(value); };
    if (next && typeof next.then === 'function') Promise.resolve(next).then(settle, () => {});
    else settle(next);
    requestPaint();
    if (state.view === 'popup') startFacts(focusedPopupPath());
  }

  // S1: apply enrichment that arrived AFTER the mount (activity ages, newly
  // readable facts). The rows re-sort, but the focused checkout keeps its
  // identity across the reorder instead of the cursor silently landing on a
  // different row. A settled component ignores late work (only still-alive
  // components repaint).
  function apply(list) {
    if (settled || !Array.isArray(list)) return;
    const focusPath = state.view === 'list'
      ? ((focusedListCheckout() || {}).path || null)
      : focusedPopupPath();
    checkouts = normalizeCheckouts(list);
    state.checkouts = checkouts;
    refocus(focusPath);
    requestPaint();
    if (state.view === 'popup') startFacts(focusedPopupPath());
  }

  function refocus(path) {
    if (typeof path !== 'string' || path.length === 0) return;
    if (state.view === 'list') {
      const rows = filterCheckouts(allCheckouts(), state.filter);
      const at = rows.findIndex((entry) => entry.path === path);
      if (at >= 0) state.listCursor = at;
      else state.listCursor = Math.min(state.listCursor, Math.max(0, rows.length - 1));
      return;
    }
    const items = popupItemsNow();
    const at = items.findIndex((item) => item.kind === 'checkout' && item.checkout.path === path);
    if (at >= 0) state.cursor = at;
    else state.cursor = Math.min(state.cursor, Math.max(0, items.length - 1));
  }

  function choosePopup() {
    const item = focusedPopupItem();
    if (!item) return;
    if (item.kind === 'create') {
      finish({ create: true });
      return;
    }
    if (item.kind === 'viewall') {
      openList();
      return;
    }
    finish({ warp: item.checkout.path });
  }

  function chooseList() {
    const entry = focusedListCheckout();
    if (!entry) return;
    finish({ warp: entry.path });
  }

  function handlePopupInput(data) {
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      finish(null);
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      choosePopup();
      return;
    }
    if (keyText(helpers, data, ['up', 'k'])) {
      movePopup(-1);
      return;
    }
    if (keyText(helpers, data, ['down', 'j'])) {
      movePopup(1);
      return;
    }
    if (keyText(helpers, data, ['e'])) {
      // Edit only ever applies to a checkout row: the create row, the
      // View all row and an empty list stay inert (S13).
      const item = focusedPopupItem();
      if (item && item.kind === 'checkout') finish({ edit: item.checkout.path });
      return;
    }
    if (keyText(helpers, data, ['v'])) {
      openList();
      return;
    }
    if (keyText(helpers, data, ['r'])) {
      reload();
    }
  }

  function handleListInput(data) {
    const open = state.filterOpen;
    // Navigation and confirmation stay bindings while the filter is open (S6).
    if (keyText(helpers, data, ['up'])) {
      moveList(-1);
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveList(1);
      return;
    }
    if (keyText(helpers, data, ['pageup'])) {
      pageList(-1);
      return;
    }
    if (keyText(helpers, data, ['pagedown'])) {
      pageList(1);
      return;
    }
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      if (open) closeFilter();
      else {
        state.view = 'popup';
        // S1: stepping back into the popup may focus a checkout that has not
        // been read yet; start its read now, never inside render().
        startFacts(focusedPopupPath());
        requestPaint();
      }
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      chooseList();
      return;
    }
    if (!open && keyText(helpers, data, ['k'])) {
      moveList(-1);
      return;
    }
    if (!open && keyText(helpers, data, ['j'])) {
      moveList(1);
      return;
    }
    if (!open && keyText(helpers, data, ['r'])) {
      reload();
      return;
    }
    if (isSpaceKey(helpers, data)) {
      if (open) {
        appendFilter(' ');
        return;
      }
      if (toggler) {
        const entry = focusedListCheckout();
        if (!entry) return;
        try {
          toggler(entry.path);
        } catch {
          // A hostile toggle never breaks navigation.
        }
        requestPaint();
        return;
      }
      openFilter(' ');
      return;
    }
    if (keyText(helpers, data, ['backspace', 'delete'])) {
      if (open) backspaceFilter();
      return;
    }
    const typed = printableChar(data);
    if (!open && (typed === 'T' || typed === '/')) {
      // The explicit openers start a NEW search, so a stale query never
      // silently hides the rows the user is about to browse.
      state.filter = '';
      openFilter('');
      return;
    }
    if (typed) {
      if (open) appendFilter(typed);
      else openFilter(typed);
    }
  }

  function frameTop(width, title) {
    const shownTitle = fit(helpers, title, Math.max(1, width - 11));
    const left = `${paint(theme, 'border', '╭─')} ${paint(theme, 'accent', emphasize(theme, shownTitle))} `;
    const right = ` ${paint(theme, 'muted', 'esc')} ${paint(theme, 'border', '─╮')}`;
    const fill = Math.max(0, width - measure(helpers, left) - measure(helpers, right));
    return `${left}${paint(theme, 'border', '─'.repeat(fill))}${right}`;
  }

  function frameBottom(width) {
    return paint(theme, 'border', `╰${'─'.repeat(Math.max(0, width - 2))}╯`);
  }

  function frameRow(width, text, role, focused) {
    const inner = Math.max(1, width - 4);
    const padded = pad(helpers, text, inner);
    const body = focused ? highlight(theme, padded, true) : (role ? paint(theme, role, padded) : padded);
    return `${paint(theme, 'border', '│')} ${body} ${paint(theme, 'border', '│')}`;
  }

  function renderPopup(width, height) {
    const plan = popupPlan(height);
    const items = popupItems(plan);
    if (state.cursor > items.length - 1) state.cursor = Math.max(0, items.length - 1);
    if (state.cursor < 0) state.cursor = 0;
    const focused = items[state.cursor];

    const listRows = [];
    if (plan.list.length === 0) {
      listRows.push({ text: '(no other worktrees)', role: 'muted' });
    } else {
      for (const entry of plan.shown) {
        const isFocused = !!(focused && focused.kind === 'checkout' && focused.checkout.path === entry.path);
        listRows.push({
          text: rowText(entry, false, isFocused ? '▸ ' : '  '),
          focused: isFocused,
        });
      }
      if (plan.viewAll) {
        listRows.push({
          text: `${focused && focused.kind === 'viewall' ? '▸ ' : '  '}View all  ${plan.hidden} more`,
          focused: !!(focused && focused.kind === 'viewall'),
        });
      }
    }

    const lines = [frameTop(width, 'Warp')];
    lines.push(frameRow(width, `current: ${current ? current.name : '(unknown checkout)'}  ${current ? current.path : ''}`, 'muted'));
    lines.push(frameRow(width, 'New worktree', 'accent'));
    lines.push(frameRow(width, `${focused && focused.kind === 'create' ? '▸ ' : '  '}create a worktree`, null, !!(focused && focused.kind === 'create')));
    lines.push(frameRow(width, ''));
    lines.push(frameRow(width, 'Choose worktree', 'accent'));
    for (let row = 0; row < plan.listRows; row += 1) {
      const entry = listRows[row];
      lines.push(entry ? frameRow(width, entry.text, entry.role, entry.focused) : frameRow(width, ''));
    }
    lines.push(frameRow(width, factsRowText(), 'muted'));
    lines.push(frameRow(width, POPUP_KEYS, 'muted'));
    lines.push(frameBottom(width));
    return lines;
  }

  function renderList(width, height) {
    const plan = listPlan(height);
    const rowTexts = [];
    if (plan.items.length === 0) {
      const needle = state.filter.trim();
      rowTexts.push({ text: needle === '' ? '(no checkouts)' : `(no matches for "${needle}")`, role: 'muted' });
    } else {
      const pageStart = plan.page * plan.pageSize;
      plan.items.forEach((entry, offset) => {
        const isFocused = pageStart + offset === plan.cursor;
        rowTexts.push({
          text: rowText(entry, true, isFocused ? '▸ ' : '  '),
          focused: isFocused,
        });
      });
    }
    const filterText = state.filterOpen
      ? `filter: ${state.filter}▏`
      : `filter: ${state.filter === '' ? 'type to search' : state.filter}`;
    const lines = [frameTop(width, 'Warp · all worktrees')];
    lines.push(frameRow(width, filterText, state.filterOpen ? null : 'muted', state.filterOpen));
    for (let row = 0; row < plan.pageSize; row += 1) {
      const entry = rowTexts[row];
      lines.push(entry ? frameRow(width, entry.text, entry.role, entry.focused) : frameRow(width, ''));
    }
    const total = plan.rows.length;
    lines.push(frameRow(width, `page ${plan.page + 1}/${plan.pageCount} · ${total} ${total === 1 ? 'worktree' : 'worktrees'}`, 'muted'));
    lines.push(frameRow(width, LIST_KEYS, 'muted'));
    lines.push(frameBottom(width));
    return lines;
  }

  function render(width) {
    const w = Math.floor(Number(width));
    if (!Number.isFinite(w) || w <= 0) return [];
    const height = availableRows();
    const minimum = state.view === 'list' ? LIST_MIN_HEIGHT : POPUP_MIN_HEIGHT;
    if (w < MIN_WIDTH || height < minimum) {
      return [pad(helpers, fit(helpers, 'Warp — enlarge the terminal', w), w)];
    }
    return state.view === 'list' ? renderList(w, height) : renderPopup(w, height);
  }

  function handleInput(data) {
    if (settled) return;
    if (isKeyRelease(helpers, data)) return;
    if (state.view === 'list') {
      handleListInput(data);
      return;
    }
    handlePopupInput(data);
  }

  function invalidate() {}

  return { render, handleInput, invalidate, apply, state };
}

module.exports = {
  createWarpSelectorView,
  formatFactsLine,
  MIN_WIDTH,
  POPUP_MIN_HEIGHT,
  LIST_MIN_HEIGHT,
  POPUP_FIXED_ROWS,
  LIST_FIXED_ROWS,
};
