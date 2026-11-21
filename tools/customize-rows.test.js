'use strict';
// The Herdr page of Gentle Shell's own `/gentle:customize` menu
// (odd/tasks/herdr-customize-page.md T1; specs S1 and S3).
//
// The tested surface is the module's public contract only: `customizeRows({ model,
// apply })` returns plain bridge rows, and every assertion observes them the way
// the bridge and the host do — `category` (the page), `choice.setting` (the line
// the host PRINTS as the line's name, `docs/contract.md` §4), `choice.value` (the
// value word it prints next to it), `choice.current()` (the live bullet),
// `label` (a row name the bridge accepts or rejects), `visible()` (the gate),
// `preview()` (the sample block) and `action()` (which must reach `apply` with
// the row's own setting and option and never swallow a refusal).
//
// The model is the one the panel already computes (`customizePanelModel`), built
// here with the real function so these tests exercise the shape the extension
// hands over instead of a hand-written imitation.
//
// What is pinned:
// - S1: exactly the four options — `herd agents`, `moshi`, `theme sync` and
//   `select theme` — in that order, on the `Herdr` page, never on `Keymaps`;
// - S3: one row per value with the model's structural option ids (`on`, `off`,
//   `none`, `theme:<name>`), so each row drives the same apply path the panel
//   (and the removed command) drives;
// - the live reads: `current()` follows a changed model, the theme rows are
//   hidden while the stored sync is on, and a throwing preview factory leaves
//   the row usable;
// - the row-name shape: every label is one to three plain words, marks become
//   word breaks, and the theme's EXACT name survives in its option id;
// - the refusal channel: `action` awaits `apply`, passes it nothing but the
//   choice, and lets a rejection (or a synchronous throw) escape.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { customizePanelModel } = require('../lib/customize-panel.js');
const { customizeRows, CUSTOMIZE_ROWS_CATEGORY } = require('../lib/customize-rows.js');

const PAGE = 'Herdr';
const S1_LINES = ['Herd agents', 'Moshi', 'Theme sync', 'Select theme'];
const UNASSIGN_TEXT = 'Off (no theme assigned)';

// The bridge's row-name rule, restated here as the checker the bridge applies
// (`src/row-names.ts`): one to three plain words, no arrow, colon, dot, pipe,
// slash or bracket. A name that fails is dropped from the menu build.
const ROW_NAME_MARKS = ['→', '←', '↑', '↓', ':', '.', '|', '/', '\\', '[', ']', '(', ')', '{', '}'];
function rowNameProblem(value) {
  assert.equal(typeof value, 'string', 'a row label is a plain string');
  for (const mark of ROW_NAME_MARKS) {
    if (value.includes(mark)) return `it contains ${JSON.stringify(mark)}`;
  }
  const words = value.trim() === '' ? 0 : value.trim().split(/\s+/).length;
  return words >= 1 && words <= 3 ? null : `it has ${words} words`;
}

// A recording apply: the extension supplies the real one, and every test reads
// the choices back from here instead of from a private field of the row.
function recorder(settle = () => Promise.resolve('applied')) {
  const calls = [];
  return {
    calls,
    apply(...args) {
      calls.push(args);
      return settle(args[0]);
    },
    // The choice a single row sends, proving it took no other argument.
    async choiceOf(row) {
      const before = calls.length;
      await row.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });
      assert.equal(calls.length, before + 1, 'one press is one apply');
      assert.equal(calls[before].length, 1, 'apply receives the choice and nothing else');
      return calls[before][0];
    },
  };
}

// The model exactly as the extension builds it (`customizePanelModel(ctx)`).
function modelFor({
  sidebar = 'on',
  moshi = 'off',
  sync = 'off',
  theme = null,
  readable = true,
  themeNames = ['Dark', 'Light'],
  themePreview = (name) => ({ title: `${name} palette`, sample: `sample for ${name}` }),
} = {}) {
  return customizePanelModel({
    sidebar,
    moshi,
    theme: { ok: readable, sync: sync === 'on', theme },
    themeNames,
    themePreview,
  });
}

// The line names in the order the host meets them (consecutive rows share one).
function linesOf(rows) {
  const seen = [];
  for (const row of rows) if (!seen.includes(row.choice.setting)) seen.push(row.choice.setting);
  return seen;
}

function rowsFor(rows, line) {
  return rows.filter((row) => row.choice.setting === line);
}

describe('customizeRows — the Herdr page (S1)', () => {
  test('serves the four S1 options in order, on the Herdr page and never Keymaps', async () => {
    const rec = recorder();
    const rows = customizeRows({ model: modelFor(), apply: rec.apply });

    assert.equal(CUSTOMIZE_ROWS_CATEGORY, PAGE);
    assert.ok(rows.length > 0, 'the page is not empty');
    for (const row of rows) {
      assert.equal(row.category, PAGE);
      assert.notEqual(String(row.category).trim().toLowerCase(), 'keymaps');
      assert.equal(typeof row.action, 'function', 'every row carries an action');
      assert.equal(typeof row.label, 'string', 'every row carries a label');
      assert.equal(typeof row.choice.current, 'function', 'every value reads its bullet live');
    }
    assert.deepEqual(linesOf(rows), S1_LINES);

    // The apply path each line drives is the panel's own setting id, which is
    // never a row name: `sidebar  ● On  ○ Off` would not read as a name.
    const settings = [];
    for (const row of rows) settings.push((await rec.choiceOf(row)).settingId);
    assert.deepEqual([...new Set(settings)], ['sidebar', 'moshi', 'theme-sync', 'theme']);
  });

  test('one row per value, carrying the model option ids and their value words', async () => {
    const rec = recorder();
    const rows = customizeRows({
      model: modelFor({ sidebar: 'on', moshi: 'on', sync: 'off', theme: 'Dark', themeNames: ['Dark', 'Light'] }),
      apply: rec.apply,
    });

    const ids = (line) => rowsFor(rows, line).map((row) => row.choice.value);
    assert.deepEqual(ids('Herd agents'), ['On', 'Off']);
    assert.deepEqual(ids('Moshi'), ['On', 'Off']);
    // The panel's own order for this switch, unchanged: Off first.
    assert.deepEqual(ids('Theme sync'), ['Off', 'On']);
    assert.deepEqual(ids('Select theme'), [UNASSIGN_TEXT, 'Dark', 'Light']);

    const optionIds = async (line) => {
      const out = [];
      for (const row of rowsFor(rows, line)) out.push((await rec.choiceOf(row)).optionId);
      return out;
    };
    assert.deepEqual(await optionIds('Herd agents'), ['on', 'off']);
    assert.deepEqual(await optionIds('Moshi'), ['on', 'off']);
    assert.deepEqual(await optionIds('Theme sync'), ['off', 'on']);
    assert.deepEqual(await optionIds('Select theme'), ['none', 'theme:Dark', 'theme:Light']);

    // Consecutive rows share one line: nothing is spliced between the values.
    assert.deepEqual(rows.map((row) => row.choice.setting), [
      'Herd agents', 'Herd agents',
      'Moshi', 'Moshi',
      'Theme sync', 'Theme sync',
      'Select theme', 'Select theme', 'Select theme',
    ]);
  });

  test('every label is a row name the bridge accepts', () => {
    const rec = recorder();
    const rows = customizeRows({
      model: modelFor({ sync: 'off', theme: 'Dark', themeNames: ['Dark', 'Light'] }),
      apply: rec.apply,
    });
    for (const row of rows) {
      assert.equal(rowNameProblem(row.label), null, `label ${JSON.stringify(row.label)} is a row name`);
    }
  });
});

describe('customizeRows — live reads (S3)', () => {
  test('current() follows a changed model instead of a captured value', () => {
    let model = modelFor({ sidebar: 'off', moshi: 'on', sync: 'off', theme: 'Dark' });
    const rows = customizeRows({ model: () => model, apply: recorder().apply });
    const on = rowsFor(rows, 'Herd agents').find((row) => row.choice.value === 'On');
    const off = rowsFor(rows, 'Herd agents').find((row) => row.choice.value === 'Off');
    assert.equal(on.choice.current(), false);
    assert.equal(off.choice.current(), true);

    // A new model: the same rows now read the other bullet.
    model = modelFor({ sidebar: 'on', moshi: 'on', sync: 'off', theme: 'Dark' });
    assert.equal(on.choice.current(), true);
    assert.equal(off.choice.current(), false);

    // An edit landed in the SAME array is read too, so nothing was captured.
    const shared = modelFor({ sidebar: 'off', theme: 'Dark' });
    const staticRows = customizeRows({ model: shared, apply: recorder().apply });
    const staticOn = rowsFor(staticRows, 'Herd agents').find((row) => row.choice.value === 'On');
    assert.equal(staticOn.choice.current(), false);
    const sidebar = shared[0].settings[0].options;
    for (const option of sidebar) option.current = option.id === 'on';
    assert.equal(staticOn.choice.current(), true);
  });

  test('the theme rows are hidden while the stored sync is on and present while it is off', () => {
    let model = modelFor({ sync: 'on', themeNames: ['Dark'] });
    const rows = customizeRows({ model: () => model, apply: recorder().apply });
    const themeRows = rowsFor(rows, 'Select theme');
    assert.equal(themeRows.length, 2, 'the unassign entry plus the host theme');
    for (const row of themeRows) assert.equal(row.visible(), false);

    model = modelFor({ sync: 'off', themeNames: ['Dark'] });
    for (const row of themeRows) assert.equal(row.visible(), true);

    // An unreadable store is not "sync on": the picker stays reachable.
    model = modelFor({ readable: false, sync: 'on', themeNames: ['Dark'] });
    for (const row of themeRows) assert.equal(row.visible(), true, 'an unknown sync hides nothing');

    // Only the theme setting is gated; the three switches are always there.
    for (const line of ['Herd agents', 'Moshi', 'Theme sync']) {
      for (const row of rowsFor(rows, line)) assert.equal(row.visible, undefined);
    }
  });

  test('a throwing preview factory leaves the row usable', async () => {
    const rec = recorder();
    const rows = customizeRows({
      model: modelFor({ themeNames: ['Dark'], themePreview: () => { throw new Error('theme unreadable'); } }),
      apply: rec.apply,
    });
    const dark = rowsFor(rows, 'Select theme').find((row) => row.choice.value === 'Dark');
    assert.equal(dark.preview(), undefined, 'no preview instead of a broken row');
    assert.deepEqual(await rec.choiceOf(dark), { settingId: 'theme', optionId: 'theme:Dark' });

    // The model may also carry a preview FACTORY per option; a throw there is
    // just as harmless.
    const factoryModel = modelFor({ themeNames: ['Dark'] });
    const themeSetting = factoryModel
      .flatMap((category) => category.settings)
      .find((setting) => setting.id === 'theme');
    const darkOption = themeSetting.options.find((option) => option.id === 'theme:Dark');
    darkOption.preview = () => { throw new Error('theme unreadable'); };
    const factoryRows = customizeRows({ model: factoryModel, apply: rec.apply });
    const factoryRow = rowsFor(factoryRows, 'Select theme').find((row) => row.choice.value === 'Dark');
    assert.equal(factoryRow.preview(), undefined);

    // A readable source still paints the model's own sample.
    const readableRows = customizeRows({ model: modelFor({ themeNames: ['Dark'] }), apply: rec.apply });
    const readable = rowsFor(readableRows, 'Select theme').find((row) => row.choice.value === 'Dark');
    assert.deepEqual(readable.preview(), { title: 'Dark palette', sample: 'sample for Dark' });
  });
});

describe('customizeRows — the apply path and its refusal (S3)', () => {
  test("action awaits apply with the row's own setting and option and nothing else", async () => {
    const rec = recorder();
    const rows = customizeRows({ model: modelFor({ themeNames: ['Dark', 'Light'] }), apply: rec.apply });

    const sidebarOff = rowsFor(rows, 'Herd agents').find((row) => row.choice.value === 'Off');
    assert.deepEqual(await rec.choiceOf(sidebarOff), { settingId: 'sidebar', optionId: 'off' });

    const moshiOn = rowsFor(rows, 'Moshi').find((row) => row.choice.value === 'On');
    assert.deepEqual(await rec.choiceOf(moshiOn), { settingId: 'moshi', optionId: 'on' });

    const syncOn = rowsFor(rows, 'Theme sync').find((row) => row.choice.value === 'On');
    assert.deepEqual(await rec.choiceOf(syncOn), { settingId: 'theme-sync', optionId: 'on' });

    const light = rowsFor(rows, 'Select theme').find((row) => row.choice.value === 'Light');
    assert.deepEqual(await rec.choiceOf(light), { settingId: 'theme', optionId: 'theme:Light' });

    // The action's promise settles only once apply has settled: the host
    // repaints after it, and a refusal must reach the bridge before that.
    let settle;
    const gate = new Promise((resolve) => { settle = resolve; });
    const gated = customizeRows({ model: modelFor(), apply: () => gate });
    const pending = gated[0].action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });
    let finished = false;
    void pending.then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false, 'the action is still awaiting apply');
    settle();
    await pending;
  });

  test('a refusal propagates out of action instead of being swallowed', async () => {
    const refusal = new Error('Turn Theme sync off to pick a specific theme.');
    const rejected = customizeRows({ model: modelFor(), apply: () => Promise.reject(refusal) });
    await assert.rejects(
      () => rejected[0].action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined }),
      (error) => error === refusal,
    );

    const throwing = customizeRows({ model: modelFor(), apply: () => { throw refusal; } });
    await assert.rejects(
      () => throwing[0].action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined }),
      (error) => error === refusal,
    );
  });
});

describe('customizeRows — the theme list and its sentinel (S3)', () => {
  test('the unassign entry keeps its own text and the structural none id', async () => {
    const rec = recorder();
    const rows = customizeRows({ model: modelFor({ theme: null, themeNames: ['Off', 'Dark'] }), apply: rec.apply });
    const themeRows = rowsFor(rows, 'Select theme');
    assert.deepEqual(themeRows.map((row) => row.choice.value), [UNASSIGN_TEXT, 'Off', 'Dark']);

    const unassign = themeRows[0];
    assert.notEqual(unassign.choice.value, 'Off', 'the sentinel is its own text, never the Off spelling');
    assert.notEqual(unassign.label, 'Off', 'and it has its own row name');
    assert.equal(unassign.choice.current(), true, 'no pinned theme is the current choice');
    assert.deepEqual(await rec.choiceOf(unassign), { settingId: 'theme', optionId: 'none' });

    // A theme literally named `Off` keeps its own row, its own id and stays
    // pinnable: the sentinel never shadows it.
    const offTheme = themeRows.find((row) => row.choice.value === 'Off');
    assert.ok(offTheme, 'the theme named Off is still listed');
    assert.deepEqual(await rec.choiceOf(offTheme), { settingId: 'theme', optionId: 'theme:Off' });
  });

  test('a theme name that breaks the row-name shape keeps a legal label and its own option id', async () => {
    const rec = recorder();
    const names = ['one-dark.v2', 'Solarized [light]', 'A B C D E', '···'];
    const rows = customizeRows({ model: modelFor({ theme: 'one-dark.v2', themeNames: names }), apply: rec.apply });
    const themeRows = rowsFor(rows, 'Select theme');
    assert.equal(themeRows.length, names.length + 1);

    const labels = new Set();
    for (let at = 0; at < names.length; at += 1) {
      const row = themeRows[at + 1];
      assert.equal(rowNameProblem(row.label), null, `label ${JSON.stringify(row.label)} is a row name`);
      labels.add(row.label);
      // The exact name is never rewritten: it rides in the option id (and in the
      // value the host prints), so the row applies precisely the theme it names.
      assert.equal(row.choice.value, names[at]);
      assert.deepEqual(await rec.choiceOf(row), { settingId: 'theme', optionId: `theme:${names[at]}` });
    }
    assert.equal(labels.size, names.length, 'each theme keeps a distinguishable name');
    assert.equal(themeRows[1].label, 'one-dark v2');
    assert.equal(themeRows[2].label, 'Solarized light');
    assert.equal(themeRows[3].label, 'A B C');
  });
});

describe('customizeRows — no model, no rows', () => {
  test('a missing or unreadable model yields an empty page instead of throwing', () => {
    assert.deepEqual(customizeRows(), []);
    assert.deepEqual(customizeRows({ model: null, apply: () => undefined }), []);
    assert.deepEqual(customizeRows({ model: () => { throw new Error('unreadable'); }, apply: () => undefined }), []);
  });
});
