'use strict';

// The `/herdr-gentle:customize` floating panel, rebuilt after Gentle Shell's own
// customize card (odd/tasks/theme-sync-fix.md T4; S1/S2/S5/S6/S7).
//
// One left `CATEGORIES` list and one right pane headed `<Category> · n/m`. Each
// setting is ONE line with its options inline — `●` marks the stored option, `›`
// the cursor option while it is elsewhere, `○` the rest — so moving the cursor
// never applies anything and only Enter confirms (upstream's `applyOnMove:
// false` for every setting here). When a line's options do not fit, the panel
// scrolls sideways: a window that always contains the cursor option, muted `‹`
// and `›` markers where options hide, and an `n/m` counter; if not even one
// option fits, upstream's compact `‹ value ›` form takes over.
//
// Below the panes sits the Shell's Preview block: a headline naming the
// highlighted option and its preview title, then the sample lines, all painted
// with the host theme (the theme swatch keeps its own raw SGR, because it must
// show THAT theme's colours, not the active one).
//
// The host component contract (pi-coding-agent `custom`): the factory receives
// (hostTui, theme, keybindings, done) and returns
// { render(width), handleInput(data), handleMouse(event), invalidate() }.
// Selection keys and pointer hits only move local state and ask the host to
// repaint; Esc finishes with done(null), and Enter (or an option click) awaits
// the injected `apply({ categoryId, settingId, optionId })`. The panel then
// swaps in the model that apply re-read, keeping the cursor by ids, and stays
// open unless apply answered `close: true` (the Moshi reload must not happen
// behind a mounted card). This module never writes, notifies, or reloads.
//
// The model is categories -> settings -> options. Option ids are structural
// (`on`, `none`, `theme:<name>`) and never derived from a label, so an installed
// theme literally named `None` or `Off` stays selectable and pinnable.

// The stored theme value is normalised by lib/theme-projection.js, so the panel
// and the store can never disagree about what "no theme" means.
const { normalizeThemeName } = require('./theme-projection.js');

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

// The palette: theme ROLE NAMES only, so a missing, partial or throwing theme
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
// The Shell's option vocabulary: `●` is the stored option, `›` the cursor while
// it is not the stored one, `○` everything else.
const CUSTOMIZE_MARK_CURRENT = "●";
const CUSTOMIZE_MARK_CURSOR = "›";
const CUSTOMIZE_MARK_OTHER = "○";
const CUSTOMIZE_OPTION_GAP = "  ";
// The pointer hint lives in the footer exactly like upstream's `Click · …`.
const CUSTOMIZE_CLICK_PREFIX = "Click · ";

// The three settings this package owns, with the upstream order of their two
// options and the static preview each option carries. `id` is the apply target
// the extension knows; it is structural, never the label.
const CUSTOMIZE_SIDEBAR_SAMPLE_ON = "● project   gentle   worker";
const CUSTOMIZE_SIDEBAR_SAMPLE_OFF = "native Herdr rows; no managed block";
const CUSTOMIZE_MOSHI_SAMPLE_ON = "ask   finished";
const CUSTOMIZE_MOSHI_SAMPLE_OFF = "silent; no Moshi notification";
const CUSTOMIZE_SYNC_SAMPLE_ON = "Herdr follows the theme active in Pi";
const CUSTOMIZE_SYNC_SAMPLE_OFF = "Herdr keeps its last palette";
const CUSTOMIZE_THEME_NONE_SAMPLE = "no theme pinned; Herdr keeps its last palette";

const CUSTOMIZE_TOGGLES = Object.freeze({
  sidebar: {
    id: "sidebar",
    setting: "Sidebar agent rows",
    order: ["on", "off"],
    // S5: the sample shows what the managed rows add, from the README's own
    // description of the heading cell and the role words.
    preview: (which) => ({
      title: "static sidebar sample",
      sample: which === "on" ? CUSTOMIZE_SIDEBAR_SAMPLE_ON : CUSTOMIZE_SIDEBAR_SAMPLE_OFF,
    }),
    unknownNote: "state unknown; Enter turns the rows on",
  },
  moshi: {
    id: "moshi",
    setting: "Notifications",
    order: ["on", "off"],
    preview: (which) => ({
      title: "static notification sample",
      sample: which === "on" ? CUSTOMIZE_MOSHI_SAMPLE_ON : CUSTOMIZE_MOSHI_SAMPLE_OFF,
    }),
  },
  "theme-sync": {
    id: "theme-sync",
    setting: "Theme sync",
    order: ["off", "on"],
    preview: (which) => ({
      title: "static sync sample",
      sample: which === "on" ? CUSTOMIZE_SYNC_SAMPLE_ON : CUSTOMIZE_SYNC_SAMPLE_OFF,
    }),
    // An unreadable store is repairable with one key press instead of blocking
    // the setting, so the note says what the action does.
    unknownNote: "state unknown; Enter turns the sync on",
  },
});

// The theme list's inert option. `none` is its ID and `None` its label: an
// installed theme called `None` keeps the ID `theme:None`, so the two can never
// collide and both stay selectable.
const CUSTOMIZE_THEME_SETTING_ID = "theme";
const CUSTOMIZE_THEME_NONE_ID = "none";
const CUSTOMIZE_THEME_NONE_LABEL = "None";
const CUSTOMIZE_THEME_OPTION_PREFIX = "theme:";
const CUSTOMIZE_THEME_UNAVAILABLE_NOTE = "Themes unavailable; use Pi /settings";
const CUSTOMIZE_THEME_UNKNOWN_NOTE = "state unknown; Enter pins a theme";

// The key legend is ONE terminal row: the `key` spelling paints as the key
// role and the rest as its description. `short` is the compact form, and
// `priority` is the drop order, so the close key outlives every other hint.
// There is no `p profiles` entry: this plugin owns no profiles concept, and a
// dead key in the footer would be a lie.
//
// Three variants, chosen like upstream's `footerHint` (lib/visual-customize-view.ts
// in gentle-shell): the legend names what the keys do RIGHT NOW. A narrow card
// that only lists categories opens them with `→`; a focused option row reads
// `←/→ choose` (the arrows move the cursor and only Enter applies); the
// categories pane keeps the pane-switching legend.
const CUSTOMIZE_FOOTER_VARIANTS = {
  categories: [
    { key: "↑/↓", text: "↑/↓ categories", short: "↑/↓ move", priority: 70 },
    { key: "→", text: "→ open", short: "→ open", priority: 80 },
    { key: "Esc", text: "Esc close", short: "Esc close", priority: 100 },
  ],
  choose: [
    { key: "←/→", text: "←/→ choose", short: "←/→ choose", priority: 70 },
    { key: "Enter", text: "Enter apply", short: "Enter apply", priority: 90 },
    { key: "↑/↓", text: "↑/↓ settings", short: "↑/↓ move", priority: 60 },
    { key: "Tab", text: "Tab panes", short: "Tab panes", priority: 50 },
    { key: "Esc", text: "Esc close", short: "Esc close", priority: 100 },
  ],
  panes: [
    { key: "←/→", text: "←/→ or Tab panes", short: "←/→ panes", priority: 60 },
    { key: "↑/↓", text: "↑/↓ move", short: "↑/↓ move", priority: 70 },
    { key: "Enter", text: "Enter apply", short: "Enter apply", priority: 80 },
    { key: "Esc", text: "Esc close", short: "Esc close", priority: 100 },
  ],
};

function customizeFooterVariant(navOnly, pane, focusedSetting) {
  if (navOnly) return CUSTOMIZE_FOOTER_VARIANTS.categories;
  const onOptions = pane === "controls" && focusedSetting && Array.isArray(focusedSetting.options) && focusedSetting.options.length > 0;
  return onOptions ? CUSTOMIZE_FOOTER_VARIANTS.choose : CUSTOMIZE_FOOTER_VARIANTS.panes;
}

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

// An ALREADY painted row: pad it to `size` without repainting, measuring
// visible columns.
function customizePad(helpers, text, size) {
  return text + " ".repeat(Math.max(0, size - customizeMeasure(helpers, text)));
}

// The legend stays on ONE row: the compaction (full tokens, then short tokens,
// then dropping the lowest-priority entries; display order never changes) and
// the key/description painting live in the palette above. The `Click · ` prefix
// is part of the row, exactly like upstream's footer, and costs width before
// any entry is dropped. A legend still wider than the card is truncated
// UNPAINTED so a cut never lands inside an escape.
function customizeFooter(helpers, theme, entries, size) {
  const measure = (text) => customizeMeasure(helpers, text);
  const prefixWidth = measure(CUSTOMIZE_CLICK_PREFIX);
  const legendWidth = Math.max(0, size - prefixWidth);
  const plain = `${CUSTOMIZE_CLICK_PREFIX}${palette.legendRow(null, entries, legendWidth, measure)}`;
  if (measure(plain) > size) return customizeFit(helpers, plain, Math.max(0, size));
  return `${palette.description(theme, CUSTOMIZE_CLICK_PREFIX)}${palette.legendRow(theme, entries, legendWidth, measure)}`;
}

// Focused-row selection: a full-width band when the injected theme paints
// backgrounds, else an accent ▸ marker — never a hardcoded escape, so focus
// stays readable on a theme that answers neither.
function customizeSelect(helpers, theme, text, size, focused) {
  const safe = String(text).split("\n")[0] ?? "";
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

/* ------------------------------------------------------------------- model */

// A preview is either the upstream `{ title, sample }` pair or nothing at all:
// an unreadable source says so instead of falling back to the active theme.
function customizePreviewValue(themePreview, name) {
  if (typeof themePreview !== "function") return null;
  let preview;
  try {
    preview = themePreview(name);
  } catch {
    return null;
  }
  if (!preview || typeof preview !== "object") return null;
  if (typeof preview.title !== "string" || typeof preview.sample !== "string") return null;
  return { title: preview.title, sample: preview.sample };
}

function customizeOption(id, optionLabel, current, preview) {
  return { id, label: optionLabel, current: current === true, preview: preview ?? null };
}

// One boolean setting. `value` is the stored option ("on"/"off") or null when
// the state could not be read: an unreadable state marks NO option current and
// carries a note instead of guessing.
function customizeToggleSetting(definition, stored) {
  const current = stored === "on" || stored === "off" ? stored : null;
  return {
    id: definition.id,
    setting: definition.setting,
    ...(current === null ? { note: definition.unknownNote ?? "state unknown" } : {}),
    options: definition.order.map((which) => customizeOption(
      which,
      which === "on" ? "On" : "Off",
      current === which,
      definition.preview(which),
    )),
  };
}

// The one setting that is not a boolean: `None` plus one option per installed
// theme, in Pi's own order. While the stored sync is on the setting is marked
// `disabled`, which is how the model says the pinned theme is not available; the
// PANEL never offers such a setting at all (see `customizeOfferedSettings`), so
// there is nothing to explain there, while the Gentle Shell page keeps its
// mounted rows and hides them with `visible()` so the picker returns in place
// when the sync is turned off. An unavailable theme list shows one note with no
// options at all instead of an empty list that looks pickable.
function customizeThemeSetting(themeState, themeNames, themePreview) {
  const readable = themeState.ok !== false;
  const syncOn = readable && themeState.sync === true;
  const assigned = readable ? normalizeThemeName(themeState.theme) : null;
  const listed = Array.isArray(themeNames);
  const options = listed
    ? [
      customizeOption(
        CUSTOMIZE_THEME_NONE_ID,
        CUSTOMIZE_THEME_NONE_LABEL,
        readable && assigned === null,
        { title: "static unassigned sample", sample: CUSTOMIZE_THEME_NONE_SAMPLE },
      ),
      ...themeNames.map((name) => customizeOption(
        `${CUSTOMIZE_THEME_OPTION_PREFIX}${name}`,
        name,
        readable && assigned === name,
        customizePreviewValue(themePreview, name),
      )),
    ]
    : [];
  const notes = [];
  if (!readable) notes.push(CUSTOMIZE_THEME_UNKNOWN_NOTE);
  if (!listed) notes.push(CUSTOMIZE_THEME_UNAVAILABLE_NOTE);
  return {
    id: CUSTOMIZE_THEME_SETTING_ID,
    setting: "Gentle Shell theme",
    ...(syncOn ? { disabled: true } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
    options,
  };
}

// The current stored values as the extension read them. A sidebar state of
// `unknown` (unresolvable plugin root or inconclusive `--check`) and an
// unreadable theme store are never guessed values. `themeNames` is the host's
// theme list (`null` when the host exposes none) and `themePreview(name)` the
// per-theme swatch.
function customizePanelModel({ sidebar, moshi, theme, themeNames, themePreview } = {}) {
  const stored = (value) => (value === "on" || value === "off" ? value : null);
  const themeState = theme && typeof theme === "object"
    ? theme
    : { ok: false, sync: false, theme: null };
  const themeSync = themeState.ok === false ? null : stored(themeState.sync === true ? "on" : "off");
  const current = {
    sidebar: stored(sidebar),
    moshi: stored(moshi) === "on" ? "on" : "off",
  };
  return [
    {
      id: "sidebar",
      title: "Herdr Sidebar",
      settings: [customizeToggleSetting(CUSTOMIZE_TOGGLES.sidebar, current.sidebar)],
    },
    {
      id: "moshi",
      title: "Moshi notifications",
      settings: [customizeToggleSetting(CUSTOMIZE_TOGGLES.moshi, current.moshi)],
    },
    {
      id: "theme",
      title: "Herdr Theme",
      settings: [
        customizeToggleSetting(CUSTOMIZE_TOGGLES["theme-sync"], themeSync),
        customizeThemeSetting(themeState, themeNames, themePreview),
      ],
    },
  ];
}

// The settings a surface OFFERS: a setting the model marks `disabled` is absent,
// not dim and not refusing, because the honest answer to "the pinned theme is
// only available while the sync is off" is to not offer the picker at all — the
// Gentle Shell page already hides its theme rows that way (`lib/customize-rows.js`
// `visible()`), and the panel must not offer what the page hides. The model keeps
// the setting (the page's mounted rows need it to come back in place), so the
// gate is applied HERE, on every read: the same panel answers a new model after an
// apply settles, which is how the setting returns without closing and reopening.
function customizeOfferedSettings(settings) {
  const list = Array.isArray(settings) ? settings : [];
  return list.filter((setting) => !(setting && setting.disabled === true));
}

/* ---------------------------------------------------------- setting line */

// One setting line: the name column, then every option inline. `●` is the
// stored option, `›` the cursor while it is not the stored one, `○` the rest.
//
// A body wider than the pane becomes a sideways window that always contains the
// cursor option: muted `‹`/`›` mark hidden options on either side and an `n/m`
// counter names the cursor. Not even one option fitting falls back to upstream's
// compact `‹ value ›` form. The line is then fitted with an ellipsis, so a
// still-too-wide value is visibly cut instead of reading like a complete one.
//
// `focused` marks the line the keys act on (visible in either pane, so the
// keyboard always shows its target); `active` adds the band, which only the
// controls pane paints. A DISABLED setting is painted in the dim role and is
// never offered the band, because the band is this card's promise that Enter
// applies it.
function customizeSettingLine(helpers, theme, setting, cursorAt, nameWidth, size, focused, active) {
  const name = String(setting.setting);
  const namePad = " ".repeat(Math.max(0, nameWidth - customizeMeasure(helpers, name)));
  const prefix = focused ? "▸ " : "  ";
  const lead = `${name}${namePad}${CUSTOMIZE_OPTION_GAP}`;
  const bodyStart = 2 + customizeMeasure(helpers, lead);
  const budget = Math.max(0, size - bodyStart);
  const disabled = setting.disabled === true;
  const options = Array.isArray(setting.options) ? setting.options : [];
  const cursor = Math.min(Math.max(0, cursorAt), Math.max(0, options.length - 1));
  const kinds = (option, index) => {
    if (disabled) return "label";
    const current = option.current === true;
    const atCursor = focused && index === cursor;
    return current || (atCursor && !current) ? "accent" : "description";
  };
  const marks = options.map((option, index) => ({
    index,
    text: `${option.current === true
      ? CUSTOMIZE_MARK_CURRENT
      : (focused && index === cursor ? CUSTOMIZE_MARK_CURSOR : CUSTOMIZE_MARK_OTHER)} ${option.label}`,
    kind: kinds(option, index),
  }));
  // Every option joined: the plain form when it fits, the window or the compact
  // form otherwise.
  const body = [];
  const joined = marks.map((mark) => mark.text).join(CUSTOMIZE_OPTION_GAP);
  if (customizeMeasure(helpers, joined) <= budget) {
    marks.forEach((mark, index) => {
      if (index > 0) body.push({ text: CUSTOMIZE_OPTION_GAP });
      body.push({ text: mark.text, kind: mark.kind, option: mark.index });
    });
  } else if (marks.length) {
    const counter = `${cursor + 1}/${options.length}`;
    const windowAt = (first, last) => {
      const segments = [];
      if (first > 0) segments.push({ kind: "description", text: "‹ " });
      for (let index = first; index <= last; index += 1) {
        if (index > first) segments.push({ text: CUSTOMIZE_OPTION_GAP });
        segments.push({ text: marks[index].text, kind: marks[index].kind, option: index });
      }
      if (last < marks.length - 1) segments.push({ kind: "description", text: " ›" });
      segments.push({ kind: "description", text: ` ${counter}` });
      return segments;
    };
    const widthOf = (segments) => customizeMeasure(helpers, segments.map((segment) => segment.text).join(""));
    let first = cursor;
    let last = cursor;
    if (widthOf(windowAt(first, last)) <= budget) {
      // Grow to the right first (what comes next), then to the left, so the
      // window is stable and the cursor stays on screen in every frame.
      for (;;) {
        if (last + 1 < marks.length && widthOf(windowAt(first, last + 1)) <= budget) {
          last += 1;
          continue;
        }
        if (first - 1 >= 0 && widthOf(windowAt(first - 1, last)) <= budget) {
          first -= 1;
          continue;
        }
        break;
      }
      body.push(...windowAt(first, last));
    } else {
      // Upstream's compact fallback: one value between arrows plus the counter.
      // The value keeps the ellipsis INSIDE the arrows (upstream truncates the
      // whole line), so the card still names exactly the cursored option instead
      // of showing a neighbouring value cut in half. A card too narrow for both
      // keeps the value and drops the counter: naming the cursor wins.
      let counterText = ` ${counter}`;
      const arrows = 4;
      let labelRoom = budget - arrows - customizeMeasure(helpers, counterText);
      if (labelRoom < 2 && budget - arrows > labelRoom) {
        counterText = "";
        labelRoom = budget - arrows;
      }
      const shownLabel = labelRoom >= 1
        ? customizeFit(helpers, options[cursor].label, labelRoom)
        : options[cursor].label;
      body.push({ kind: disabled ? "label" : "accent", text: `‹ ${shownLabel} ›`, option: cursor });
      if (counterText) body.push({ kind: "description", text: counterText });
    }
  }
  const spans = [];
  let column = bodyStart;
  for (const segment of body) {
    const width = customizeMeasure(helpers, segment.text);
    if (typeof segment.option === "number") spans.push({ index: segment.option, start: column, end: column + width });
    column += width;
  }
  const plain = `${prefix}${lead}${body.map((segment) => segment.text).join("")}`;
  const nameEnd = Math.min(size, 2 + customizeMeasure(helpers, name));
  if (active && !disabled && theme && typeof theme.bg === "function") {
    try {
      // The band is a full-width background, so it is only painted when nothing
      // had to be cut: a band around a truncated line would hide the cut.
      if (customizeFit(helpers, plain, Math.max(0, size)) === plain) {
        const band = theme.bg("selectedBg", plain + " ".repeat(Math.max(0, size - customizeMeasure(helpers, plain))));
        if (typeof band === "string") return { text: band, nameEnd, spans };
      }
    } catch {
      // Fall through to the composed form below.
    }
  }
  const segments = [
    { kind: disabled ? "label" : (focused ? "key" : "label"), text: prefix },
    { kind: disabled ? "label" : (focused ? "value" : "description"), text: lead },
    ...body,
  ];
  return { text: customizeCompose(helpers, theme, segments, size), nameEnd, spans };
}

/* -------------------------------------------------------------- component */

function createCustomizePanel({ helpers, hostTui, theme, rowsAvailable, model: initialModel, apply, done }) {
  const state = {
    pane: "categories",
    model: Array.isArray(initialModel) ? initialModel : [],
    cat: 0,
    settingId: initialModel && initialModel[0] && initialModel[0].settings[0] ? initialModel[0].settings[0].id : null,
    cursors: new Map(),
    frame: null,
    busy: false,
  };
  function settings() {
    const category = state.model[state.cat];
    return customizeOfferedSettings(category && category.settings);
  }
  function settingIndex() {
    const at = settings().findIndex((entry) => entry.id === state.settingId);
    return at < 0 ? 0 : at;
  }
  function focusedSetting() {
    return settings()[settingIndex()] || null;
  }
  // A setting is entered on its stored option (upstream `landOn`); an unknown
  // state has no stored option, so it enters on the first one.
  function landOn(setting) {
    const at = setting && Array.isArray(setting.options) ? setting.options.findIndex((option) => option.current === true) : -1;
    return at < 0 ? 0 : at;
  }
  function cursorIndex(setting) {
    if (!setting || !Array.isArray(setting.options)) return 0;
    const stored = state.cursors.get(setting.id);
    const at = setting.options.findIndex((option) => option.id === stored);
    return at < 0 ? landOn(setting) : at;
  }
  function setCursor(setting, index) {
    const option = setting && Array.isArray(setting.options) ? setting.options[index] : null;
    if (option) state.cursors.set(setting.id, option.id);
  }
  // Every setting starts on its stored option, so a fresh frame never shows a
  // cursor on a value nobody chose.
  for (const category of state.model) {
    for (const setting of category.settings || []) setCursor(setting, landOn(setting));
  }
  // The cursor survives a model swap by ID, which is why option ids are
  // structural: after applying `off` the cursor stays on `off`, and only an
  // option that no longer exists re-lands on the stored one.
  function replaceModel(next) {
    if (!Array.isArray(next) || next.length === 0) return;
    const previousId = state.model[state.cat] ? state.model[state.cat].id : null;
    const at = next.findIndex((category) => category.id === previousId);
    state.model = next;
    state.cat = at < 0 ? Math.min(state.cat, next.length - 1) : at;
    const seen = new Set();
    for (const category of next) {
      for (const setting of category.settings || []) {
        seen.add(setting.id);
        const stored = state.cursors.get(setting.id);
        const keep = stored !== undefined && Array.isArray(setting.options)
          && setting.options.some((option) => option.id === stored);
        if (!keep) {
          const landed = setting.options ? setting.options[landOn(setting)] : null;
          if (landed) state.cursors.set(setting.id, landed.id);
          else state.cursors.delete(setting.id);
        }
      }
    }
    for (const id of [...state.cursors.keys()]) if (!seen.has(id)) state.cursors.delete(id);
    if (!settings().some((setting) => setting.id === state.settingId)) {
      state.settingId = settings()[0] ? settings()[0].id : null;
    }
  }
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
  function render(width) {
    const w = typeof width === "number" && Number.isFinite(width) ? Math.floor(width) : 0;
    state.frame = null;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    // A card needs two border rows. At extreme dimensions keep a read-only
    // heading rather than activatable invisible controls.
    if (w < CUSTOMIZE_CARD_PADDING + 1 || height < 4) {
      return [CUSTOMIZE_TITLE, "Enlarge terminal"].slice(0, Math.min(height, 2))
        .map((line) => customizeFit(helpers, line, w, ""));
    }
    const inner = w - CUSTOMIZE_CARD_PADDING;
    const narrow = w < CUSTOMIZE_NARROW_WIDTH;
    const navOnly = narrow && state.pane === "categories" && state.model.length > 1;
    // The left column fits every category title plus the focus prefix:
    // truncating a category name is never acceptable, the right pane may clip.
    const leftNeed = state.model.reduce(
      (need, entry) => Math.max(need, 2 + customizeMeasure(helpers, entry.title)),
      0,
    );
    const leftWidth = narrow ? 0 : Math.min(24, Math.max(leftNeed, Math.max(14, Math.floor(inner * 0.28))));
    const rightWidth = inner - leftWidth - (leftWidth ? 3 : 0);
    // Upstream's preview height rule: 6 / 3 / 1 / 0 lines by overlay height,
    // deducted from the content height inside the same card.
    const previewLines = height >= 18 ? 6 : height >= 11 ? 3 : height >= 8 ? 1 : 0;
    const showHeading = height >= 6;
    const showTopGap = height >= 12;
    const showBottomGap = height >= 9;
    const chrome = 1 + (showHeading ? 2 : 0) + (showTopGap ? 1 : 0) + (showBottomGap ? 1 : 0);
    const contentHeight = Math.max(1, height - 2 - chrome - previewLines);
    const category = state.model[state.cat] || { id: null, title: "Settings", settings: [] };
    const entries = customizeOfferedSettings(category.settings);
    const focusedAt = settingIndex();
    // Right pane rows: one line per setting plus, when the state cannot name a
    // value, one muted note under it.
    const rightLines = [];
    entries.forEach((setting, index) => {
      rightLines.push({ kind: "setting", index, setting });
      if (setting.note) rightLines.push({ kind: "note", text: setting.note });
    });
    const focusedLine = rightLines.findIndex((line) => line.kind === "setting" && line.index === focusedAt);
    const position = navOnly ? state.cat : Math.max(0, focusedLine);
    const listLength = navOnly ? state.model.length : rightLines.length;
    const start = Math.min(Math.max(0, position - contentHeight + 1), Math.max(0, listLength - contentHeight));
    const navStart = Math.min(Math.max(0, state.cat - contentHeight + 1), Math.max(0, state.model.length - contentHeight));
    // The label column is sized from the category's FULL setting set, offered or
    // not (D2): a setting the theme gate withholds must not move the values of
    // the settings that remain. The column is a property of the category, not of
    // what happens to be offered in this frame — with the sync off the widest
    // label is `Gentle Shell theme`, and the same width is kept when it is gone.
    const allSettings = Array.isArray(category.settings) ? category.settings : [];
    const nameWidth = Math.min(
      20,
      allSettings.reduce((need, setting) => Math.max(need, customizeMeasure(helpers, setting.setting)), 0),
    );
    const paintCell = (text, size, kind) => customizePaint(helpers, theme, kind, text, size);
    const compose = (segments, size) => customizeCompose(helpers, theme, segments, size);
    const divider = palette.paint(theme, "border", "│");
    const join = (left, right) => (leftWidth
      ? `${left}${" ".repeat(Math.max(0, leftWidth - customizeMeasure(helpers, left)))} ${divider} ${right}`
      : right);
    const lines = [];
    const hits = [];
    const titleRow = CUSTOMIZE_TITLE;
    const escGap = Math.max(1, inner - customizeMeasure(helpers, titleRow) - 3);
    lines.push(compose([
      { kind: "title", text: titleRow },
      { text: " ".repeat(escGap) },
      { kind: "key", text: "esc" },
    ], inner));
    if (showHeading) {
      const heading = navOnly
        ? [{ kind: "title", text: "Categories" }, { kind: "label", text: " · choose a category →" }]
        : [
          { kind: "title", text: category.title },
          { kind: "label", text: " · " },
          { kind: "count", text: entries.length ? `${focusedAt + 1}/${entries.length}` : "empty" },
        ];
      lines.push(join(
        leftWidth ? paintCell("CATEGORIES", leftWidth, "key") : "",
        compose(heading, rightWidth),
      ));
    }
    if (showTopGap) lines.push("");
    for (let i = 0; i < contentHeight; i += 1) {
      const navIndex = navStart + i;
      const nav = state.model[navIndex];
      const at = start + i;
      const item = navOnly ? (state.model[at] || null) : (rightLines[at] || null);
      // The card paints the top border above content line 0, so a content row's
      // rendered row is its index + 1.
      const y = lines.length + 1;
      const rightStart = 2 + (leftWidth ? leftWidth + 3 : 0);
      const left = nav
        ? customizeSelect(helpers, theme, nav.title, leftWidth, navOnly ? at === state.cat : navIndex === state.cat && state.pane === "categories")
        : "";
      let right = "";
      if (navOnly) {
        right = item ? customizeSelect(helpers, theme, item.title, rightWidth, at === state.cat) : "";
        if (item) hits.push({ kind: "category", index: at, y, x: rightStart + 2, end: rightStart + rightWidth });
      } else if (item && item.kind === "setting") {
        const rendered = customizeSettingLine(
          helpers,
          theme,
          item.setting,
          cursorIndex(item.setting),
          nameWidth,
          rightWidth,
          at === position,
          at === position && state.pane === "controls",
        );
        right = rendered.text;
        // A click on the name only moves the focus; a click on an option applies
        // exactly that option.
        if (rendered.nameEnd > 2) {
          hits.push({ kind: "setting", index: item.index, y, x: rightStart + 2, end: rightStart + rendered.nameEnd });
        }
        for (const span of rendered.spans) {
          hits.push({ kind: "option", index: item.index, option: span.index, y, x: rightStart + span.start, end: rightStart + span.end });
        }
      } else if (item && item.kind === "note") {
        right = paintCell(item.text, rightWidth, "description");
      } else if (rightLines.length === 0) {
        right = paintCell("No settings available", rightWidth, "description");
      }
      lines.push(join(left, right));
      // Pointer hits cover the pane text only: a click on a border, the title,
      // the heading or the footer hits nothing and is ignored.
      if (leftWidth && nav) hits.push({ kind: "category", index: navIndex, y, x: 2, end: 2 + leftWidth });
    }
    // The Preview block: a spacer, the accent headline naming the highlighted
    // option and its preview title, then the muted sample lines — the upstream
    // placement, height and roles. No separate `<Category> — <description>` row
    // exists any more: the preview title IS the description.
    if (previewLines >= 3) {
      const setting = entries[focusedAt] || null;
      const option = !navOnly && setting && Array.isArray(setting.options) ? setting.options[cursorIndex(setting)] : null;
      const preview = option ? option.preview : null;
      lines.push("");
      const headline = navOnly
        ? "→ controls · Esc close"
        : preview && option
          ? `Preview · ${option.label} · ${preview.title}`
          : "Preview unavailable";
      lines.push(paintCell(headline, inner, "accent"));
      const sample = navOnly
        ? [""]
        : preview
          ? preview.sample.split("\n")
          : ["No read-only sample for this choice"];
      for (let i = 0; i < previewLines - 2; i += 1) lines.push(paintCell(sample[i] ?? "", inner, "description"));
    } else if (previewLines === 1) {
      lines.push(paintCell(navOnly ? "→ controls · Esc close" : "Preview omitted · enlarge terminal", inner, "description"));
    }
    if (showBottomGap) lines.push("");
    if (showHeading) {
      const footerEntries = customizeFooterVariant(navOnly, state.pane, entries[focusedAt] || null);
      lines.push(customizePad(helpers, customizeFooter(helpers, theme, footerEntries, inner), inner));
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
  // The one action that can write: it runs behind a busy guard (a second Enter
  // while the first apply is in flight does nothing), swaps in the model apply
  // read back, and closes only when the extension asked for it — the Moshi
  // reload must never run behind a mounted card.
  function runApply(setting, option) {
    if (state.busy || !setting || !option) return;
    state.busy = true;
    let pending;
    try {
      pending = typeof apply === "function"
        ? apply({ categoryId: state.model[state.cat] ? state.model[state.cat].id : null, settingId: setting.id, optionId: option.id })
        : Promise.resolve(null);
    } catch {
      state.busy = false;
      requestPaint();
      return;
    }
    Promise.resolve(pending).then((result) => {
      state.busy = false;
      if (result && result.model) replaceModel(result.model);
      if (result && result.close === true) {
        done(null);
        return;
      }
      requestPaint();
    }, () => {
      state.busy = false;
      requestPaint();
    });
  }
  function enterControls() {
    state.pane = "controls";
    const setting = focusedSetting();
    if (setting) setCursor(setting, landOn(setting));
  }
  function handleInput(data) {
    if (customizeIsKeyRelease(helpers, data)) return;
    if (customizeKeyMatches(helpers, data, ["escape", "ctrl+c"])) {
      done(null);
      return;
    }
    if (state.busy) return;
    const length = state.pane === "categories" ? state.model.length : settings().length;
    if (!length) return;
    const setting = focusedSetting();
    const step = state.pane === "controls" && setting && Array.isArray(setting.options) && setting.options.length
      ? (customizeKeyMatches(helpers, data, ["left"]) ? -1 : customizeKeyMatches(helpers, data, ["right"]) ? 1 : 0)
      : 0;
    if (step === -1 && cursorIndex(setting) === 0) {
      // Left past the first option leaves the controls, exactly like upstream.
      state.pane = "categories";
    } else if (step) {
      const next = cursorIndex(setting) + step;
      // Every setting defers to Enter (`applyOnMove: false`): a step that would
      // leave the option range changes nothing and writes nothing.
      if (next >= 0 && next < setting.options.length) setCursor(setting, next);
    } else if (customizeKeyMatches(helpers, data, ["left"]) || (customizeKeyMatches(helpers, data, ["tab"]) && state.pane === "controls")) {
      state.pane = "categories";
    } else if (customizeKeyMatches(helpers, data, ["right"]) || (customizeKeyMatches(helpers, data, ["tab"]) && state.pane === "categories")) {
      enterControls();
    } else if (customizeKeyMatches(helpers, data, ["up", "k"])) {
      if (state.pane === "categories") state.cat = (state.cat + state.model.length - 1) % state.model.length;
      else {
        const list = settings();
        const at = (settingIndex() + list.length - 1) % list.length;
        state.settingId = list[at].id;
        setCursor(list[at], landOn(list[at]));
      }
    } else if (customizeKeyMatches(helpers, data, ["down", "j"])) {
      if (state.pane === "categories") state.cat = (state.cat + 1) % state.model.length;
      else {
        const list = settings();
        const at = (settingIndex() + 1) % list.length;
        state.settingId = list[at].id;
        setCursor(list[at], landOn(list[at]));
      }
    } else if (customizeKeyMatches(helpers, data, ["enter", "return", "space"]) && state.pane === "categories") {
      enterControls();
    } else if (customizeKeyMatches(helpers, data, ["enter", "return", "space"])) {
      runApply(setting, setting && Array.isArray(setting.options) ? setting.options[cursorIndex(setting)] : null);
    }
    requestPaint();
  }
  // Pointer contract: x/y are local to this component's rendered frame, the card
  // border included. A press only captures the gesture; the click that follows
  // activates the hit, so a drag never applies an option by accident, and a move
  // only carries the focus. Anything outside a pane's text is ignored.
  function focusHit(hit) {
    if (hit.kind === "category") {
      if (state.pane === "categories" && state.cat === hit.index) return false;
      state.cat = hit.index;
      state.pane = "categories";
      state.settingId = settings()[0] ? settings()[0].id : null;
      return true;
    }
    const list = settings();
    const setting = list[hit.index];
    if (!setting) return false;
    const changed = state.pane !== "controls" || state.settingId !== setting.id || hit.kind === "option";
    state.pane = "controls";
    state.settingId = setting.id;
    if (hit.kind === "option") setCursor(setting, hit.option);
    return changed;
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
    if (state.busy) return { handled: true, render: false };
    if (hit.kind === "category") {
      state.cat = hit.index;
      state.pane = "categories";
      state.settingId = settings()[0] ? settings()[0].id : null;
      // A narrow card has no category column: selecting one opens its settings.
      if (frame.width < CUSTOMIZE_NARROW_WIDTH) enterControls();
      return { handled: true, render: true, focus: true };
    }
    const setting = settings()[hit.index];
    if (!setting) return undefined;
    focusHit(hit);
    if (hit.kind === "option") {
      runApply(setting, setting.options ? setting.options[hit.option] : null);
    }
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
