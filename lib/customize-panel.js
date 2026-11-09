'use strict';

// The `/herdr-gentle:customize` floating panel, recovered from commit 0e92869
// (odd/tasks/restore-customize-panel.md T1, S1/S2) and shaped like Gentle
// Shell's own customize card (odd/tasks/customize-parity-done-idle.md T1, S1).
//
// One left `CATEGORIES` list, one right pane headed `<Category> · n/m` holding
// the setting rows, one line describing what the focused setting does, and the
// Shell's footer keys. Each switch is ONE row that paints the stored value with
// `●` and the other with `○`, so Enter (or a click on the row) is still the
// whole toggle. The removed worktree / ODD / Issues / Reset sections are gone,
// and the panel reads the current state handed in by the extension instead of a
// cross-extension provider slot.
//
// The host component contract (pi-coding-agent `custom`): the factory receives
// (hostTui, theme, keybindings, done) and returns
// { render(width), handleInput(data), handleMouse(event), invalidate() }.
// Selection keys and pointer hits only move local state and ask the host to
// repaint; Esc finishes with done(null) and Enter (or a row click) with
// done({categoryId, switchId, valueId}). This module never writes, notifies, or
// reloads: the extension's single apply path runs after the overlay resolves.

const ROLE = Object.freeze({
  key: "accent",
  title: "customMessageLabel",
  description: "muted",
  count: "muted",
  label: "dim",
  value: "text",
  border: "border",
  error: "error",
});

// The palette the former card shared with the other readers (then a separate
// module): theme ROLE NAMES only, so a missing, partial or throwing theme
// degrades to plain text instead of breaking a render. Keys and titles are
// emphasized through the theme's own `bold`, which keeps them distinguishable
// in a monochrome terminal.
function textOf(value) {
  if (typeof value === "string") return value;
  return value == null ? "" : String(value);
}

function paint(theme, role, text) {
  const value = textOf(text);
  try {
    if (theme && typeof theme.fg === "function") {
      const painted = theme.fg(role, value);
      if (typeof painted === "string") return painted;
    }
  } catch {
    // Fall through to the plain text.
  }
  return value;
}

function emphasize(theme, text) {
  const value = textOf(text);
  try {
    if (theme && typeof theme.bold === "function") {
      const bold = theme.bold(value);
      if (typeof bold === "string") return bold;
    }
  } catch {
    // Fall through to the plain text.
  }
  return value;
}

function key(theme, text) {
  return emphasize(theme, paint(theme, ROLE.key, text));
}

function title(theme, text) {
  return emphasize(theme, paint(theme, ROLE.title, text));
}

function description(theme, text) {
  return paint(theme, ROLE.description, text);
}

function count(theme, text) {
  return paint(theme, ROLE.count, text);
}

function label(theme, text) {
  return paint(theme, ROLE.label, text);
}

function accent(theme, text) {
  return paint(theme, ROLE.key, text);
}

function value(theme, text) {
  return paint(theme, ROLE.value, text);
}

const LEGEND_SEPARATOR = " · ";

// Which legend entries survive, and which spelling of them: the FULL token
// while it fits, then the compact token, then the same list minus its
// lowest-priority entries until something fits. Display order never changes
// and no token carries a newline, so the legend stays on ONE row.
function legendSelection(entries, width, measure) {
  const list = Array.isArray(entries) ? entries : [];
  const join = (items, field) => items.map((entry) => textOf(entry && entry[field])).join(LEGEND_SEPARATOR);
  const fits = (text) => {
    try {
      return Number(measure(text)) <= width;
    } catch {
      // A hostile measurer never claims a fit.
      return false;
    }
  };
  if (fits(join(list, "text"))) return { entries: list, field: "text" };
  if (fits(join(list, "short"))) return { entries: list, field: "short" };
  const kept = list.slice();
  while (kept.length > 1) {
    let drop = 0;
    for (let at = 1; at < kept.length; at += 1) {
      if (kept[at].priority <= kept[drop].priority) drop = at;
    }
    kept.splice(drop, 1);
    if (fits(join(kept, "short"))) break;
  }
  return { entries: kept, field: "short" };
}

// One legend entry: its `key` prefix carries the key role (+ bold) and the rest
// of the token the description role. An entry without a `key`, or one whose
// chosen spelling does not start with it, is a description throughout.
function entryCell(theme, entry, field) {
  const spelled = textOf(entry && entry[field]);
  const keys = textOf(entry && entry.key);
  if (keys === "" || !spelled.startsWith(keys)) return description(theme, spelled);
  const rest = spelled.slice(keys.length);
  if (rest === "") return key(theme, keys);
  return `${key(theme, keys)}${description(theme, rest)}`;
}

function legendRow(theme, entries, width, measure) {
  const selection = legendSelection(entries, width, measure);
  const separator = paint(theme, ROLE.border, LEGEND_SEPARATOR);
  return selection.entries.map((entry) => entryCell(theme, entry, selection.field)).join(separator);
}

const palette = { ROLES: ROLE, accent, count, description, key, label, legendRow, paint, title, value };

const CUSTOMIZE_TITLE = "Customize · Herdr Gentle Shell";
const CUSTOMIZE_CARD_PADDING = 4;
const CUSTOMIZE_NARROW_WIDTH = 60;
const CUSTOMIZE_MAX_HEIGHT = 24;
// The Shell's row vocabulary: `●` is the stored value, `○` the other one.
const CUSTOMIZE_PILL_CURRENT = "●";
const CUSTOMIZE_PILL_OTHER = "○";

// The switches this package owns. `id` is the apply target the extension knows
// (the sidebar rows go through the Herdr plugin's own configure step,
// notifications through the `gentle-moshi.json` flag and its Pi settings
// exclusion) and `setting` is the row name the panel paints. `description` is
// the one line the card shows for the focused setting: it says what the switch
// changes, and the notification switch is the Moshi channel, never the agent
// notifications the host owns.
const CUSTOMIZE_SWITCHES = [
  {
    id: "sidebar",
    setting: "Sidebar agent rows",
    description: "Hands the Herdr sidebar to this plugin's managed agent rows.",
  },
  {
    id: "moshi",
    setting: "Notifications",
    description: "Replaces the Moshi hook with this plugin's own notification channel.",
  },
];

// Two categories, one row each. `Herdr Sidebar` owns the managed agent rows the
// plugin publishes and nothing else: the Moshi notification channel lives only
// under `Moshi notifications`, so the sidebar switch can never toggle it.
const CUSTOMIZE_CATEGORIES = [
  {
    id: "sidebar",
    title: "Herdr Sidebar",
    description: "The managed agent rows this plugin hands to the Herdr sidebar.",
    switches: ["sidebar"],
  },
  {
    id: "moshi",
    title: "Moshi notifications",
    description: "The Moshi notification channel this plugin owns.",
    switches: ["moshi"],
  },
];

// One row per switch: it paints the stored value and carries the value Enter
// applies, so a single key press is the whole toggle. `Unknown` keeps the row
// actionable instead of blocking the repair, so an inconclusive check can
// always be re-run from here.
function toggleRow(definition, active) {
  const current = active === "on" || active === "off" ? active : null;
  return {
    id: current === "on" ? "off" : "on",
    switchId: definition.id,
    setting: definition.setting,
    description: definition.description,
    current,
    currentLabel: current === "on" ? "On" : current === "off" ? "Off" : "Unknown",
    otherLabel: current === "on" ? "Off" : "On",
    note: current === null ? "state unknown; Enter re-runs the managed rows" : undefined,
  };
}

// The current stored values as the extension read them. A sidebar state of
// `unknown` (unresolvable plugin root or inconclusive `--check`) is never a
// guessed value and never blocks the repair: the row stays selectable and a
// note explains that On re-runs the managed rows. Notifications are always a
// readable local flag.
function customizePanelModel({ sidebar, moshi } = {}) {
  const stored = (value) => (value === "on" || value === "off" ? value : null);
  const current = { sidebar: stored(sidebar), moshi: stored(moshi) === "on" ? "on" : "off" };
  return CUSTOMIZE_CATEGORIES.map((category) => ({
    id: category.id,
    title: category.title,
    description: category.description,
    rows: category.switches.map((switchId) => toggleRow(
      CUSTOMIZE_SWITCHES.find((entry) => entry.id === switchId),
      current[switchId],
    )),
  }));
}

// The key legend is ONE terminal row: the `key` spelling paints as the key
// role and the rest as its description. `short` is the compact form, and
// `priority` is the drop order, so the close key outlives every other hint.
// There is no `p profiles` entry: this plugin owns no profiles concept, and a
// dead key in the footer would be a lie. The pointer needs no entry either:
// every legend token names a key the panel answers to.
const CUSTOMIZE_FOOTER_KEYS = [
  { key: "←/→", text: "←/→ or Tab panes", short: "←/→ panes", priority: 60 },
  { key: "↑/↓", text: "↑/↓ move", short: "↑/↓ move", priority: 70 },
  { key: "Enter", text: "Enter apply", short: "Enter apply", priority: 80 },
  { key: "Esc", text: "Esc close", short: "Esc close", priority: 100 },
];

function customizeStripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;.*?\x07/g, "");
}

function customizeMeasure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === "function") return helpers.visibleWidth(text);
  } catch {
    // Fall through to the codepoint count.
  }
  return [...customizeStripAnsi(text)].length;
}

function customizeFit(helpers, text, width, ellipsis = "…") {
  const clean = String(text).split("\n")[0] ?? "";
  if (customizeMeasure(helpers, clean) <= width) return clean;
  try {
    if (helpers && typeof helpers.truncateToWidth === "function") {
      return helpers.truncateToWidth(clean, width, ellipsis);
    }
  } catch {
    // Fall through to the plain slice.
  }
  const chars = [...clean];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join("") + ellipsis : clean;
}

// Paint one token with a palette KIND (title, key, label, value, count,
// description, border) instead of naming a colour here. An unknown kind is
// plain text.
function customizeKind(theme, kind, text) {
  const painter = palette[kind];
  if (typeof painter === "function") return painter(theme, text);
  const role = palette.ROLES[kind];
  return typeof role === "string" ? palette.paint(theme, role, text) : String(text);
}

// One cell of one kind. The line is fitted and padded FIRST and painted only
// when it survived intact: a truncated line stays unpainted, so a cut never
// lands inside an escape sequence.
function customizePaint(helpers, theme, kind, text, size) {
  const plain = String(text).split("\n")[0] ?? "";
  const clipped = customizeFit(helpers, plain, Math.max(0, size));
  const pad = " ".repeat(Math.max(0, size - customizeMeasure(helpers, clipped)));
  if (clipped === "" || clipped !== plain) return clipped + pad;
  return customizeKind(theme, kind, clipped) + pad;
}

// A composed line of kind-tagged segments (`{ kind, text }`), fitted and
// padded as ONE string and painted only after the fit, for the same reason.
function customizeCompose(helpers, theme, segments, size) {
  const plain = segments.map((segment) => segment.text).join("");
  const clipped = customizeFit(helpers, plain, Math.max(0, size));
  if (clipped !== plain) {
    return clipped + " ".repeat(Math.max(0, size - customizeMeasure(helpers, clipped)));
  }
  const painted = segments.map((segment) => customizeKind(theme, segment.kind, segment.text)).join("");
  return painted + " ".repeat(Math.max(0, size - customizeMeasure(helpers, clipped)));
}

// An ALREADY painted row (the palette legend paints itself): pad it to `size`
// without repainting, measuring visible columns.
function customizePad(helpers, text, size) {
  return text + " ".repeat(Math.max(0, size - customizeMeasure(helpers, text)));
}

// The legend stays on ONE row: the compaction (full tokens, then short tokens,
// then dropping the lowest-priority entries; display order never changes) and
// the key/description painting live in the palette above. A legend still wider
// than the card is truncated UNPAINTED so a cut never lands inside an escape.
function customizeFooter(helpers, theme, entries, size) {
  const measure = (text) => customizeMeasure(helpers, text);
  const plain = palette.legendRow(null, entries, size, measure);
  if (measure(plain) > size) return customizeFit(helpers, plain, Math.max(0, size));
  return palette.legendRow(theme, entries, size, measure);
}

// Focused-row selection: a full-width band when the injected theme paints
// backgrounds, else an accent ▸ marker — never a hardcoded escape, so focus
// stays readable on a theme that answers neither.
function customizeSelect(helpers, theme, label, size, focused) {
  const safe = String(label).split("\n")[0] ?? "";
  if (focused && theme && typeof theme.bg === "function") {
    try {
      const row = customizeFit(helpers, `  ${safe}`, Math.max(0, size));
      const band = theme.bg("selectedBg", row + " ".repeat(Math.max(0, size - customizeMeasure(helpers, row))));
      if (typeof band === "string") return band;
    } catch {
      // Fall through to the marker form below.
    }
  }
  const prefix = focused ? palette.paint(theme, "accent", "▸ ") : "  ";
  return prefix + customizeKind(theme, "value", customizeFit(helpers, safe, Math.max(0, size - 2)));
}

function customizeCard(helpers, theme, lines, width) {
  const innerWidth = Math.max(1, width - CUSTOMIZE_CARD_PADDING);
  const border = (text) => palette.paint(theme, "border", text);
  const horizontal = "─".repeat(innerWidth + 2);
  return [
    border(`╭${horizontal}╮`),
    ...lines.map((content) => {
      const wide = customizeMeasure(helpers, content);
      const fitted = wide > innerWidth
        ? customizeFit(helpers, content, innerWidth)
        : content + " ".repeat(innerWidth - wide);
      return `${border("│")} ${fitted} ${border("│")}`;
    }),
    border(`╰${horizontal}╯`),
  ];
}

function customizeKeyMatches(helpers, key, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === "function" && helpers.matchesKey(key, name)) return true;
    } catch {
      // A throwing matcher never matches; the string fallback below decides.
    }
  }
  const text = typeof key === "string" ? key : (key && (key.name || key.key)) || "";
  const lower = String(text).toLowerCase();
  return names.some((name) => lower === String(name).toLowerCase());
}

// Kitty key-release guard: an event the helper module classifies as a key
// release must change nothing. Without the helper there is nothing to guard.
function customizeIsKeyRelease(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === "function") return helpers.isKeyRelease(data) === true;
  } catch {
    // A throwing classifier never releases; fall through to normal handling.
  }
  return false;
}

// One setting line: the name column, then the Shell's pill pair — `●` on the
// stored value and `○` on the other. A pair wider than the pane falls back to
// the stored pill alone, so the narrow width keeps showing the real state.
// `focused` marks the row Enter would apply (visible in either pane, so the
// keyboard always shows its target) and `active` adds the band, which only the
// pane that owns the focus paints.
function customizeSettingLine(helpers, theme, row, nameWidth, size, focused, active) {
  const name = String(row.setting);
  const namePad = " ".repeat(Math.max(0, nameWidth - customizeMeasure(helpers, name)));
  const prefix = focused ? "▸ " : "  ";
  const lead = `${prefix}${name}${namePad}  `;
  const stored = `${CUSTOMIZE_PILL_CURRENT} ${row.currentLabel}`;
  const other = `${CUSTOMIZE_PILL_OTHER} ${row.otherLabel}`;
  const pair = `${stored}  ${other}`;
  const showPair = customizeMeasure(helpers, `${lead}${pair}`) <= size;
  const body = showPair ? pair : stored;
  if (active && theme && typeof theme.bg === "function") {
    try {
      const plain = customizeFit(helpers, `${lead}${body}`, Math.max(0, size));
      const band = theme.bg("selectedBg", plain + " ".repeat(Math.max(0, size - customizeMeasure(helpers, plain))));
      if (typeof band === "string") return band;
    } catch {
      // Fall through to the composed form below.
    }
  }
  const segments = [
    { kind: focused ? "key" : "label", text: prefix },
    { kind: focused ? "value" : "description", text: `${name}${namePad}  ` },
    { kind: row.current === null ? "error" : "accent", text: stored },
  ];
  if (showPair) segments.push({ kind: "description", text: `  ${other}` });
  return customizeCompose(helpers, theme, segments, size);
}

function createCustomizePanel({ helpers, hostTui, theme, rowsAvailable, model, done }) {
  const state = {
    pane: "categories",
    cat: 0,
    row: model.map(() => 0),
    frame: null,
  };
  function availableRows() {
    try {
      if (typeof rowsAvailable === "function") {
        const rows = Math.floor(rowsAvailable());
        if (Number.isFinite(rows) && rows > 0) return Math.min(CUSTOMIZE_MAX_HEIGHT, rows);
      }
    } catch {
      // A hostile rows source never breaks the panel.
    }
    return CUSTOMIZE_MAX_HEIGHT;
  }
  function focused() {
    const category = model[state.cat];
    return { category, row: category.rows[state.row[state.cat]] || null };
  }
  // What the card describes on its own row: the setting the values pane holds
  // the focus on, or the category while the left list owns it.
  function focusedDescription() {
    const category = model[state.cat];
    const row = state.pane === "values" ? focused().row : null;
    return row
      ? { title: row.setting, description: row.description }
      : { title: category.title, description: category.description };
  }
  function render(width) {
    const w = typeof width === "number" && Number.isFinite(width) ? Math.floor(width) : 0;
    state.frame = null;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    const title = CUSTOMIZE_TITLE;
    // A card needs two border rows. At extreme dimensions keep a read-only
    // heading rather than activatable invisible controls.
    if (w < CUSTOMIZE_CARD_PADDING + 1 || height < 4) {
      return [title, "Enlarge terminal"].slice(0, Math.min(height, 2))
        .map((line) => customizeFit(helpers, line, w, ""));
    }
    const inner = w - CUSTOMIZE_CARD_PADDING;
    const narrow = w < CUSTOMIZE_NARROW_WIDTH;
    const navOnly = narrow && state.pane === "categories" && model.length > 1;
    // The left column fits every category title plus the focus prefix:
    // truncating a category name is never acceptable, the right pane may clip.
    const leftNeed = model.reduce(
      (need, entry) => Math.max(need, 2 + customizeMeasure(helpers, entry.title)),
      0,
    );
    const leftWidth = narrow ? 0 : Math.min(24, Math.max(leftNeed, Math.floor(inner * 0.28)));
    const rightWidth = inner - leftWidth - (leftWidth ? 3 : 0);
    const category = model[state.cat];
    const rows = category.rows;
    const showHeading = height >= 6;
    // The description rides directly above the legend, so it needs one more row
    // than the heading and the legend alone; a 6-row card keeps the keys and
    // drops the prose instead of the other way round.
    const showDescription = height >= 7;
    // Right pane: one line per setting (name column plus the pill pair) and,
    // when the stored state is unreadable, one muted note under it.
    const rightLines = rows.map((row, index) => ({ kind: "row", index, row }));
    for (const row of rows) if (row.note) rightLines.push({ kind: "note", text: row.note });
    // Title, then heading + description + legend when they fit, above two borders.
    const chrome = 1 + (showHeading ? 2 : 0) + (showDescription ? 1 : 0);
    const contentHeight = Math.max(1, height - 2 - chrome);
    const position = navOnly ? state.cat : state.row[state.cat];
    const listLength = navOnly ? model.length : rightLines.length;
    const start = Math.min(Math.max(0, position - contentHeight + 1), Math.max(0, listLength - contentHeight));
    const navStart = Math.min(Math.max(0, state.cat - contentHeight + 1), Math.max(0, model.length - contentHeight));
    const nameWidth = rows.reduce(
      (need, row) => Math.max(need, customizeMeasure(helpers, row.setting)),
      0,
    );
    const paint = (text, size, kind) => customizePaint(helpers, theme, kind, text, size);
    const compose = (segments, size) => customizeCompose(helpers, theme, segments, size);
    const divider = palette.paint(theme, "border", "│");
    const join = (left, right) => leftWidth
      ? `${left}${" ".repeat(Math.max(0, leftWidth - customizeMeasure(helpers, left)))} ${divider} ${right}`
      : right;
    const lines = [];
    const hits = [];
    // Title row doubles as the esc hint: same row, right-aligned.
    const escGap = Math.max(1, inner - customizeMeasure(helpers, title) - 3);
    lines.push(compose([
      { kind: "title", text: title },
      { text: " ".repeat(escGap) },
      { kind: "key", text: "esc" },
    ], inner));
    if (showHeading) {
      const heading = navOnly
        ? [{ kind: "title", text: "Categories" }, { kind: "label", text: " · choose a category →" }]
        : [
          { kind: "title", text: category.title },
          { kind: "label", text: " · " },
          { kind: "count", text: rows.length ? `${state.row[state.cat] + 1}/${rows.length}` : "empty" },
        ];
      lines.push(join(
        leftWidth ? paint("CATEGORIES", leftWidth, "key") : "",
        compose(heading, rightWidth),
      ));
    }
    for (let i = 0; i < contentHeight; i += 1) {
      const navIndex = navStart + i;
      const nav = model[navIndex];
      const at = start + i;
      const item = navOnly ? (model[at] || null) : (rightLines[at] || null);
      // The card paints the top border above content line 0, so a content row's
      // rendered row is its index + 1.
      const y = lines.length + 1;
      const left = nav
        ? customizeSelect(helpers, theme, nav.title, leftWidth, navOnly ? at === state.cat : navIndex === state.cat && state.pane === "categories")
        : "";
      let right = "";
      if (navOnly) {
        right = item ? customizeSelect(helpers, theme, item.title, rightWidth, at === state.cat) : "";
      } else if (item && item.kind === "row") {
        right = customizeSettingLine(
          helpers,
          theme,
          item.row,
          nameWidth,
          rightWidth,
          at === state.row[state.cat],
          at === state.row[state.cat] && state.pane === "values",
        );
      } else if (item && item.kind === "note") {
        right = paint(item.text, rightWidth, "description");
      } else if (rightLines.length === 0) {
        right = paint("No settings available", rightWidth, "description");
      }
      lines.push(join(left, right));
      // Pointer hits cover the pane text only: a click on a border, the title,
      // the heading or the footer hits nothing and is ignored.
      const rightStart = 2 + (leftWidth ? leftWidth + 3 : 0);
      if (leftWidth && nav) hits.push({ kind: "category", index: navIndex, y, x: 2, end: 2 + leftWidth });
      if (navOnly && item) hits.push({ kind: "category", index: at, y, x: rightStart + 2, end: rightStart + rightWidth });
      else if (item && item.kind === "row") hits.push({ kind: "row", index: item.index, y, x: rightStart + 2, end: rightStart + rightWidth });
    }
    if (showDescription) {
      const described = focusedDescription();
      lines.push(compose([
        { kind: "value", text: `${described.title} — ` },
        { kind: "description", text: described.description },
      ], inner));
    }
    if (showHeading) {
      lines.push(customizePad(helpers, customizeFooter(helpers, theme, CUSTOMIZE_FOOTER_KEYS, inner), inner));
    }
    const shown = lines.slice(0, Math.max(0, height - 2));
    state.frame = { width: w, height: shown.length + 2, hits: hits.filter((hit) => hit.y <= shown.length) };
    return customizeCard(helpers, theme, shown, w);
  }
  function requestPaint() {
    try {
      if (hostTui && typeof hostTui.requestRender === "function") hostTui.requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }
  function handleInput(data) {
    if (customizeIsKeyRelease(helpers, data)) return;
    if (customizeKeyMatches(helpers, data, ["escape", "ctrl+c"])) {
      done(null);
      return;
    }
    if (customizeKeyMatches(helpers, data, ["left", "right", "tab"])) {
      state.pane = state.pane === "categories" ? "values" : "categories";
      requestPaint();
      return;
    }
    if (customizeKeyMatches(helpers, data, ["up", "k"])) {
      if (state.pane === "categories") state.cat = (state.cat + model.length - 1) % model.length;
      else {
        const count = model[state.cat].rows.length;
        state.row[state.cat] = (state.row[state.cat] + count - 1) % count;
      }
      requestPaint();
      return;
    }
    if (customizeKeyMatches(helpers, data, ["down", "j"])) {
      if (state.pane === "categories") state.cat = (state.cat + 1) % model.length;
      else {
        const count = model[state.cat].rows.length;
        state.row[state.cat] = (state.row[state.cat] + 1) % count;
      }
      requestPaint();
      return;
    }
    if (customizeKeyMatches(helpers, data, ["enter", "return"])) {
      const current = focused();
      done({
        categoryId: current.category.id,
        switchId: current.row ? current.row.switchId : current.category.id,
        valueId: current.row ? current.row.id : null,
      });
    }
  }
  // Pointer contract: x/y are local to this component's rendered frame, the
  // card border included. A press only captures the gesture; the click that
  // follows activates the hit, so a drag never applies a row by accident, and
  // a move only carries the focus. Anything outside a pane's text is ignored,
  // which is also the answer for a click on a border, the title, the heading
  // or the footer.
  //
  // The reported `width`/`height` are the box the host rendered, which the
  // overlay may have clipped shorter than the rows this panel budgeted. The hit
  // test therefore reads the frame it rendered and only clamps the row into it:
  // a geometry comparison the user cannot see must never swallow a real click.
  function focusHit(hit) {
    if (hit.kind === "category") {
      if (state.pane === "categories" && state.cat === hit.index) return false;
      state.cat = hit.index;
      state.pane = "categories";
      return true;
    }
    const target = model[state.cat];
    if (!target || !target.rows[hit.index]) return false;
    if (state.pane === "values" && state.row[state.cat] === hit.index) return false;
    state.pane = "values";
    state.row[state.cat] = hit.index;
    return true;
  }
  function handleMouse(event) {
    if (!event) return undefined;
    const moving = event.type === "move";
    if (!moving && (event.button !== "left" || (event.type !== "press" && event.type !== "click"))) return undefined;
    const frame = state.frame;
    if (!frame) return undefined;
    if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return undefined;
    const y = Math.min(Math.max(0, Math.floor(event.y)), Math.max(0, frame.height - 1));
    const hit = frame.hits.find((entry) => entry.y === y && event.x >= entry.x && event.x < entry.end);
    if (!hit) return undefined;
    if (moving) return { handled: true, render: focusHit(hit) };
    if (event.type === "press") return { handled: true, capture: true, render: false };
    const target = model[state.cat];
    if (hit.kind === "category") {
      state.cat = hit.index;
      state.pane = "categories";
      return { handled: true, render: true, focus: true };
    }
    const row = target ? target.rows[hit.index] : null;
    if (!row) return undefined;
    state.pane = "values";
    state.row[state.cat] = hit.index;
    done({ categoryId: target.id, switchId: row.switchId, valueId: row.id });
    return { handled: true, render: true, focus: true };
  }
  function invalidate() {}
  return { render, handleInput, handleMouse, invalidate, state };
}

module.exports = {
  CUSTOMIZE_TITLE,
  createCustomizePanel,
  customizePanelModel,
};
