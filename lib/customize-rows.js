'use strict';

// The Herdr page of Gentle Shell's own `/gentle:customize` menu
// (odd/tasks/herdr-customize-page.md T1; specs S1, S3).
//
// This module is a PURE TRANSLATION: it reads the customize model the panel
// already computes (`customizePanelModel` in lib/customize-panel.js) and answers
// bridge rows for exactly the four options of S1 — `herd agents`, `moshi`,
// `theme sync`, `select theme` — in that order. It owns no state, reads no file,
// notifies nobody and reloads nothing: the extension injects `apply`, which is
// the same choice shape `applyCustomizePanel` accepts, so a row drives the very
// write path (and therefore the very refusal) the panel and the removed command
// drive.
//
// Two facts about the host decide the shape below, and both were verified against
// the bridge's own code rather than assumed:
//
// 1. The line a user reads is `choice.setting`, NOT `label`: the renderer draws
//    `entry.setting` as the line's name and `choice.value` as each value word
//    (gentle-shell `lib/visual-customize-view.ts:396-404,594`; `docs/contract.md`
//    §4, and the bridge's own toggle rows say so in `src/sections-rows.ts:66-72`
//    — "the id is not a label and never appears here"). So every row of a
//    setting shares the S1 NAME as its `choice.setting`, while the apply path's
//    own setting id (`sidebar`, `moshi`, `theme-sync`, `theme`) rides in the
//    row's closure and is what `apply` receives.
// 2. The bridge refuses a row whose `label` is not a row name — one to three
//    plain words with no arrow, colon, dot, pipe, slash or bracket
//    (`src/row-names.ts`), and it refuses rather than rewrites. Every label here
//    therefore goes through `rowName()` below, because a host theme name is user
//    data and may freely carry any of those marks.
//
// A hidden row is still a row: `visible()` is handed to the host untouched, so
// the theme rows exist while the sync is on and simply do not show — the honest
// answer the contract asks for instead of an in-panel refusal.

// The page is a row `category`, never `registerSection`: a section adds a
// sidebar card, a category is the menu's own page. `Keymaps` is the one
// reserved category (`src/row-names.ts`) and is never used here.
const CUSTOMIZE_ROWS_CATEGORY = "Herdr";

// The four S1 options, in the order S1 names them, and the panel's own setting
// ids from the model (`lib/customize-panel.js` `customizePanelModel`). The
// theme-sync setting lives beside the theme picker in the panel's own category,
// but S1 puts it third on this page, so the order is stated here instead of
// inherited from the model's category nesting.
const SETTINGS = Object.freeze([
  { id: "sidebar", line: "Herd agents" },
  { id: "moshi", line: "Moshi" },
  { id: "theme-sync", line: "Theme sync" },
]);
const THEME_SETTING = Object.freeze({ id: "theme", line: "Select theme" });

// The theme picker's structural ids, the same ones lib/customize-panel.js and
// the extension use: `none` is the "no theme assigned" choice and `theme:<name>`
// a real theme, so an installed theme literally called `None` or `Off` keeps its
// own option and stays pinnable.
const THEME_NONE_OPTION_ID = "none";
const THEME_OPTION_PREFIX = "theme:";

// The unassign entry's text and row name. The text is the extension's documented
// sentinel and deliberately NOT `Off`: `Off` is what the panel paints for a
// stored `null`, and a Pi theme may legitimately be named `Off`, so reusing that
// spelling as the sentinel would make such a theme unpinnable. Its row name is
// its own too (the sentinel text carries a bracket and four words, so it can
// never be a row name, and clamping it would keep the `Off` spelling).
const THEME_UNASSIGN_TEXT = "Off (no theme assigned)";
const THEME_UNASSIGN_LABEL = "No theme assigned";

// The bridge's row-name shape (`src/row-names.ts`): at most three words, and
// none of the marks that make a name read as a path, a key or a breadcrumb.
const ROW_NAME_MAX_WORDS = 3;
const ROW_NAME_MARKS = Object.freeze([
  "\u2192", "\u2190", "\u2191", "\u2193", ":", ".", "|", "/", "\\", "[", "]", "(", ")", "{", "}",
]);

// THE label rule. `text` is the thing the row names (a value's word, a theme's
// name); the answer is a name the bridge accepts, or `null` when nothing usable
// survived. Every mark becomes a word break, along with any other punctuation
// (`-` and `_` are word characters and stay, so `one-dark` is one word), runs of
// space collapse, and the first three words are kept. The exact string is never
// rewritten in a name: a theme's real name rides in its option id
// (`theme:<name>`) and in the value the host prints, so a row still applies —
// and shows — precisely the theme it names.
function rowName(text) {
  if (typeof text !== "string") return null;
  const broken = text.split("").map((char) => (ROW_NAME_MARKS.includes(char) ? " " : char)).join("");
  const words = broken.replace(/[^\p{L}\p{N}_-]+/gu, " ").trim().split(/\s+/).filter((word) => word.length > 0);
  return words.length > 0 ? words.slice(0, ROW_NAME_MAX_WORDS).join(" ") : null;
}

// The model is read through this resolver so `current()`, `visible()` and
// `preview()` see the state as it is WHEN THEY RUN (the host evaluates them on
// every build and after every repaint), never a copy taken at build time. A
// function is accepted because the extension's natural source is
// `() => customizePanelModel(ctx)`. A missing or unreadable model answers no
// rows instead of throwing.
function readModel(model) {
  let value = model;
  if (typeof model === "function") {
    try {
      value = model();
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function findSetting(model, settingId) {
  for (const category of readModel(model)) {
    const settings = category && Array.isArray(category.settings) ? category.settings : [];
    for (const setting of settings) {
      if (setting && setting.id === settingId) return setting;
    }
  }
  return null;
}

function findOption(model, settingId, optionId) {
  const setting = findSetting(model, settingId);
  const options = setting && Array.isArray(setting.options) ? setting.options : [];
  for (const option of options) {
    if (option && option.id === optionId) return option;
  }
  return null;
}

// The option ids in the model's own order: this is what makes one row per value,
// with the structural ids the panel and the fallback menu already apply.
function optionIds(model, settingId) {
  const setting = findSetting(model, settingId);
  const options = setting && Array.isArray(setting.options) ? setting.options : [];
  return options
    .filter((option) => option && typeof option.id === "string")
    .map((option) => option.id);
}

// The stored value, read live. An option the model no longer lists (or a state
// the model could not read, which marks NO option current) is never a guess.
function isCurrent(model, settingId, optionId) {
  const option = findOption(model, settingId, optionId);
  return option !== null && option.current === true;
}

// S3: the picker is only available while the stored sync is off. A store the
// model could not read is not "sync on", so it hides nothing.
function themeSyncOn(model) {
  return isCurrent(model, "theme-sync", "on");
}

// The word the host prints for one value. The model's own label is reused
// (`On`, `Off`, the theme's name); the unassign entry keeps the extension's
// sentinel text instead of the panel's short `None`, because the bridge page has
// no note line to explain it.
function valueText(option, optionId) {
  if (option && typeof option.label === "string" && option.label.length > 0) return option.label;
  if (optionId.startsWith(THEME_OPTION_PREFIX)) return optionId.slice(THEME_OPTION_PREFIX.length);
  return optionId;
}

// S6's swatch, resolved from the model's optional preview source: the model may
// carry the read-only `{ title, sample }` pair or the factory that produces it.
// Anything unreadable — a throw, a missing source, a pair of the wrong shape —
// answers `undefined`, which the host paints as `Preview unavailable` instead of
// the row ever breaking.
function optionPreview(model, settingId, optionId) {
  const option = findOption(model, settingId, optionId);
  if (!option) return undefined;
  let value = option.preview;
  if (typeof value === "function") {
    try {
      value = value();
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const { title, sample } = value;
  if (typeof title !== "string" || typeof sample !== "string") return undefined;
  return { title, sample };
}

// The one write a row can cause. `apply` is the extension's injected async
// function (the `{ settingId, optionId }` shape `applyCustomizePanel` accepts)
// and it is awaited with the row's own setting and option and NOTHING else: the
// inline helpers the host hands to `action` are not forwarded, so a row cannot
// open a dialog the apply path does not own. A rejection is never caught here —
// the bridge turns a throw into the user-visible refusal and records it, so
// swallowing it (or notifying) would hide the only channel the user has.
async function dispatch(apply, settingId, optionId) {
  await apply({ settingId, optionId });
}

function toggleRow(model, apply, setting, optionId) {
  const option = findOption(model, setting.id, optionId);
  const text = valueText(option, optionId);
  return {
    category: CUSTOMIZE_ROWS_CATEGORY,
    // A row name, never the value word it happens to sit beside.
    label: rowName(text) ?? setting.line,
    choice: {
      // The line's NAME, shared by every value of this setting, so the host
      // draws one line and ←/→ walks its values (Enter applies: the bridge
      // stages `applyOnMove: false` on every row it contributes).
      setting: setting.line,
      value: text,
      current: () => isCurrent(model, setting.id, optionId),
    },
    action: () => dispatch(apply, setting.id, optionId),
  };
}

function themeRow(model, apply, optionId, index) {
  const option = findOption(model, THEME_SETTING.id, optionId);
  const isNone = optionId === THEME_NONE_OPTION_ID;
  const text = isNone ? THEME_UNASSIGN_TEXT : valueText(option, optionId);
  return {
    category: CUSTOMIZE_ROWS_CATEGORY,
    // The unassign entry's name is its own; a theme is named after itself (its
    // marks already turned into word breaks), and a name that survives as no
    // word at all still gets a legal, distinguishable one — the exact theme is
    // in the option id either way.
    label: isNone ? THEME_UNASSIGN_LABEL : (rowName(text) ?? `Theme ${index + 1}`),
    choice: {
      setting: THEME_SETTING.line,
      value: text,
      current: () => isCurrent(model, THEME_SETTING.id, optionId),
    },
    // The theme's own swatch, read from the model's preview source.
    preview: () => optionPreview(model, THEME_SETTING.id, optionId),
    // Present while the sync is off, hidden while it is on.
    visible: () => !themeSyncOn(model),
    action: () => dispatch(apply, THEME_SETTING.id, optionId),
  };
}

// The page's rows: the three switches in S1 order, then the theme picker.
function customizeRows({ model, apply } = {}) {
  const rows = [];
  for (const setting of SETTINGS) {
    for (const optionId of optionIds(model, setting.id)) {
      rows.push(toggleRow(model, apply, setting, optionId));
    }
  }
  optionIds(model, THEME_SETTING.id).forEach((optionId, index) => {
    rows.push(themeRow(model, apply, optionId, index));
  });
  return rows;
}

module.exports = {
  CUSTOMIZE_ROWS_CATEGORY,
  customizeRows,
};
