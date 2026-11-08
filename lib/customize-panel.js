'use strict';

// The `/herdr-gentle:customize` floating panel, recovered from commit 0e92869
// (odd/tasks/restore-customize-panel.md T1, S1/S2).
//
// It is the former two-pane card with the same layout, palette, keyboard
// semantics and overlay behaviour, reduced to the two switches this package
// still owns: the managed Herdr sidebar rows and the Moshi notification
// channel. The removed worktree / ODD / Issues / Reset sections are gone, and
// the panel reads the current state handed in by the extension instead of a
// cross-extension provider slot.
//
// The host component contract (pi-coding-agent `custom`): the factory receives
// (hostTui, theme, keybindings, done) and returns
// { render(width), handleInput(data), invalidate() }. Selection keys only move
// local state and ask the host to repaint through hostTui.requestRender(); Esc
// finishes with done(null) and Enter with done({categoryId, valueId}). This
// module never writes, notifies, or reloads: the extension's single apply path
// runs after the overlay resolves.

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

const palette = { ROLES: ROLE, count, description, key, label, legendRow, paint, title, value };

const CUSTOMIZE_TITLE = "Customize · Herdr Gentle Shell";
const CUSTOMIZE_CARD_PADDING = 4;
const CUSTOMIZE_NARROW_WIDTH = 60;
const CUSTOMIZE_MAX_HEIGHT = 24;

// The two surviving switches. `id` is the value the extension applies: the
// sidebar rows go through the Herdr plugin's own configure step, Moshi through
// its flag file and Pi settings exclusion. Each switch is ONE row: it reads the
// stored state and the row's id is the opposite value, so Enter is the toggle.
const CUSTOMIZE_CATEGORIES = [
  {
    id: "sidebar",
    title: "Herdr Sidebar",
    onDetail: "adds the managed agent rows to Herdr's plugin config",
    offDetail: "removes the managed rows and hands the pane back to Herdr",
    unknownDetail: "state unreadable; On re-runs the managed rows and reports the result",
  },
  {
    id: "moshi",
    title: "Moshi notifications",
    onDetail: "notifies ask and finish episodes through Moshi",
    offDetail: "leaves notifications to the host",
    unknownDetail: "state unreadable; On runs the moshi-hook check and reports the result",
  },
];

// One row per switch: it shows the CURRENT state and carries the value Enter
// applies. `Unknown` keeps the row actionable instead of blocking the repair,
// so an inconclusive check can always be re-run from here.
function toggleRow(category, active) {
  const label = active === "on" ? "On" : active === "off" ? "Off" : "Unknown";
  const detail =
    active === "on" ? category.onDetail : active === "off" ? category.offDetail : category.unknownDetail;
  return { id: active === "on" ? "off" : "on", label, detail, mark: "→ " };
}

// The current stored values as the extension read them. A sidebar state of
// `unknown` (unresolvable plugin root or inconclusive `--check`) is never a
// guessed value and never blocks the repair: the row stays selectable and a
// note explains that On re-runs the managed rows. Moshi is always a readable
// local flag.
function customizePanelModel({ sidebar, moshi } = {}) {
  const stored = (value) => (value === "on" || value === "off" ? value : null);
  const byId = (id) => CUSTOMIZE_CATEGORIES.find((entry) => entry.id === id);
  const sidebarActive = stored(sidebar);
  const moshiActive = stored(moshi) === "on" ? "on" : "off";
  const sidebarCategory = byId("sidebar");
  const moshiCategory = byId("moshi");
  return [
    {
      ...sidebarCategory,
      active: sidebarActive,
      note: sidebarActive === null ? "state unknown; Enter re-runs the managed rows" : undefined,
      rows: [toggleRow(sidebarCategory, sidebarActive)],
    },
    { ...moshiCategory, active: moshiActive, rows: [toggleRow(moshiCategory, moshiActive)] },
  ];
}

// The key legend is ONE terminal row: the `key` spelling paints as the key
// role and the rest as its description. `short` is the compact form, and
// `priority` is the drop order, so the close key outlives every other hint.
const CUSTOMIZE_FOOTER_KEYS = [
  { key: "←/→", text: "←/→ or Tab panes", short: "←/→ panes", priority: 60 },
  { key: "↑/↓", text: "↑/↓ or j/k move", short: "↑/↓ move", priority: 70 },
  { key: "Enter", text: "Enter toggle", short: "Enter toggle", priority: 80 },
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

function createCustomizePanel({ helpers, hostTui, theme, rowsAvailable, model, done }) {
  const state = {
    pane: "categories",
    cat: 0,
    row: model.map((category) => {
      const at = category.rows.findIndex((row) => row.id === category.active);
      return at >= 0 ? at : 0;
    }),
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
  function render(width) {
    const w = typeof width === "number" && Number.isFinite(width) ? Math.floor(width) : 0;
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
    const previewLines = height >= 11 ? 3 : height >= 8 ? 1 : 0;
    const showHeading = height >= 6;
    // Right pane: LABELS ONLY. Each choice's detail lives exactly once in the
    // preview block below, never under the rows.
    const rightLines = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const focusedValue = !navOnly && state.pane === "values" && index === state.row[state.cat];
      const mark = typeof row.mark === "string" ? row.mark : (row.id === category.active ? "→ " : "  ");
      rightLines.push({ label: `${mark}${row.label}`, focused: focusedValue });
    }
    if (category.note) {
      rightLines.push({ label: category.note, mark: "    ", focused: false, muted: true });
    }
    const contentHeight = Math.max(1, height - 2 - 1 - (showHeading ? 1 : 0) - previewLines - (showHeading ? 1 : 0));
    const position = navOnly ? state.cat : state.row[state.cat];
    const listLength = navOnly ? model.length : rightLines.length;
    const start = Math.min(Math.max(0, position - contentHeight + 1), Math.max(0, listLength - contentHeight));
    const navStart = Math.min(Math.max(0, state.cat - contentHeight + 1), Math.max(0, model.length - contentHeight));
    const paint = (text, size, kind) => customizePaint(helpers, theme, kind, text, size);
    const compose = (segments, size) => customizeCompose(helpers, theme, segments, size);
    const divider = palette.paint(theme, "border", "│");
    const join = (left, right) => leftWidth
      ? `${left}${" ".repeat(Math.max(0, leftWidth - customizeMeasure(helpers, left)))} ${divider} ${right}`
      : right;
    const lines = [];
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
        leftWidth ? paint("CATEGORIES", leftWidth, "label") : "",
        compose(heading, rightWidth),
      ));
    }
    const current = focused();
    for (let i = 0; i < contentHeight; i += 1) {
      const nav = model[navStart + i];
      const left = nav
        ? customizeSelect(helpers, theme, nav.title, leftWidth, navOnly || (navStart + i === state.cat && state.pane === "categories"))
        : "";
      const item = navOnly ? (model[start + i] || null) : (rightLines[start + i] || null);
      let right = "";
      if (item) {
        // Labels sit under a 4-column mark gutter (▸/→): the stored label
        // carries its → mark, focus adds ▸ in front and the rest pad two
        // spaces.
        if (navOnly) {
          right = customizeSelect(helpers, theme, item.title, rightWidth, start + i === position);
        } else if (item.muted) {
          right = paint(`    ${item.label}`, rightWidth, "description");
        } else if (item.focused) {
          right = customizeSelect(helpers, theme, item.label, rightWidth, true);
        } else {
          right = paint(`  ${item.label}`, rightWidth, "value");
        }
      } else if (!navOnly && rightLines.length === 0) {
        right = paint("No settings available", rightWidth, "description");
      }
      lines.push(join(left, right));
    }
    // Bottom block: the FOCUSED choice's label in the preview title plus its
    // description on the next line — exactly once.
    const previewLabel = current.row
      ? (typeof current.row.preview === "string" ? current.row.preview : current.row.label)
      : current.category.title;
    const previewTitle = `Preview · ${previewLabel}`;
    const previewSample = current.row ? current.row.detail : "unavailable";
    if (previewLines === 3) {
      lines.push("");
      lines.push(compose([
        { kind: "label", text: "Preview" },
        { kind: "label", text: " · " },
        { kind: "value", text: previewLabel },
      ], inner));
      lines.push(paint(previewSample, inner, "description"));
    } else if (previewLines === 1) {
      lines.push(paint(previewTitle, inner, "description"));
    }
    if (showHeading) {
      lines.push(customizePad(helpers, customizeFooter(helpers, theme, CUSTOMIZE_FOOTER_KEYS, inner), inner));
    }
    return customizeCard(helpers, theme, lines.slice(0, Math.max(0, height - 2)), w);
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
      done({ categoryId: current.category.id, valueId: current.row ? current.row.id : null });
    }
  }
  function invalidate() {}
  return { render, handleInput, invalidate, state };
}

module.exports = {
  CUSTOMIZE_TITLE,
  createCustomizePanel,
  customizePanelModel,
};
