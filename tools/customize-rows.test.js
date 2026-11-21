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
// - the live reads: one model run per synchronous burst, with a cache that is
//   dropped when an `apply` settles — so the SAME row objects the host repaints
//   report the applied state without a rebuild — and a TTL that bounds a repaint
//   arriving while nothing was applied; the theme rows are hidden while the
//   stored sync is on, and a throwing preview factory leaves the row usable;
// - the unassign entry never collides with an installed theme's value word, and
//   every row still applies its own option id;
// - the row-name shape: every label is one to three plain words, marks become
//   word breaks, and the theme's EXACT name survives in its option id;
// - the refusal channel: `action` awaits `apply`, passes it nothing but the
//   choice, and lets a rejection (or a synchronous throw) escape.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCustomizePanel, customizePanelModel } = require('../lib/customize-panel.js');
const {
  customizeRows,
  CUSTOMIZE_ROWS_CATEGORY,
  MODEL_CACHE_TTL_MS,
} = require('../lib/customize-rows.js');

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

// The panel's own geometry helpers, mirrored here so the panel can be rendered
// and read back: the point of these tests is what the USER sees on the panel,
// never a private field of the model.
const stripAnsi = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');
const stubTui = {
  visibleWidth: (text) => [...stripAnsi(text)].length,
  truncateToWidth: (text, width, ellipsis = '…') => {
    const chars = [...stripAnsi(text)];
    if (chars.length <= width) return String(text);
    return chars.slice(0, Math.max(0, width - 1)).join('') + ellipsis;
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};
const PANEL_WIDTH = 100;
const TALL = () => 24;

// The { title, sample } the PANEL paints for one value of one setting: the
// rendered `Preview · <value> · <title>` headline and the first sample line
// below it, with the card border and its padding removed. This is the parity
// oracle — the page must answer exactly this pair, from the panel's own copy.
function panelPaintedPreview(model, settingId, optionId) {
  const categoryAt = model.findIndex((category) => (category.settings || []).some((setting) => setting.id === settingId));
  assert.ok(categoryAt >= 0, `the panel lists the ${settingId} setting`);
  const settings = model[categoryAt].settings;
  const settingAt = settings.findIndex((setting) => setting.id === settingId);
  const setting = settings[settingAt];
  const at = setting.options.findIndex((option) => option.id === optionId);
  assert.ok(at >= 0, `the panel lists ${settingId}/${optionId}`);

  const component = createCustomizePanel({
    helpers: stubTui,
    hostTui: { requestRender: () => {} },
    theme: {},
    rowsAvailable: TALL,
    model,
    apply: async () => ({ model }),
    done: () => {},
  });
  for (let step = 0; step < categoryAt; step += 1) component.handleInput('down');
  component.handleInput('right');
  for (let step = 0; step < settingAt; step += 1) component.handleInput('down');
  const landed = setting.options.findIndex((option) => option.current === true);
  const from = landed < 0 ? 0 : landed;
  if (at > from) for (let step = from; step < at; step += 1) component.handleInput('right');
  if (at < from) for (let step = at; step < from; step += 1) component.handleInput('left');

  const lines = component.render(PANEL_WIDTH).map(stripAnsi);
  const headlineAt = lines.findIndex((line) => line.includes('Preview · '));
  assert.ok(headlineAt >= 0, `the panel paints a preview for ${settingId}/${optionId}`);
  const inner = (line) => line.slice(2, -2).trimEnd();
  const headline = inner(lines[headlineAt]);
  const prefix = `Preview · ${setting.options[at].label} · `;
  assert.ok(headline.startsWith(prefix), `the panel names the highlighted value: ${headline}`);
  return { title: headline.slice(prefix.length), sample: inner(lines[headlineAt + 1] || '') };
}

// The cache's TTL is measured with `Date.now()`, so the test drives that real
// clock instead of sleeping: the module reads exactly this and nothing else.
function withClock(start = 1_000_000) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    advance(ms) { now += ms; },
    restore() { Date.now = real; },
  };
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
  // The host does NOT rebuild the row objects after an action: Gentle Shell's
  // VisualCustomizeView repaints the rows it already holds and calls
  // `choice.current()` / the visibility gate again on the SAME objects
  // (`lib/visual-customize-view.ts:224-231`, `:391-392`). So the live read is a
  // cache with explicit invalidation, not a copy taken at build time: these tests
  // are shaped the way the host behaves — one build, kept rows, then an action.
  test('after an action settles, the SAME rows report the new state (no rebuild)', async () => {
    const state = { sync: false };
    const apply = async (choice) => {
      if (choice.settingId === 'theme-sync') state.sync = choice.optionId === 'on';
    };
    // The real model shape: the stored sync decides both the bullet and whether
    // the theme picker exists at all.
    let reads = 0;
    const model = () => {
      reads += 1;
      return modelFor({ sync: state.sync ? 'on' : 'off', theme: 'Dark', themeNames: ['Dark', 'Light'] });
    };
    const rows = customizeRows({ model, apply });
    const syncOff = rowsFor(rows, 'Theme sync').find((row) => row.choice.value === 'Off');
    const syncOn = rowsFor(rows, 'Theme sync').find((row) => row.choice.value === 'On');
    const themeRows = rowsFor(rows, 'Select theme');
    assert.equal(reads, 1);
    assert.equal(syncOff.choice.current(), true);
    assert.equal(syncOn.choice.current(), false);
    for (const row of themeRows) assert.equal(row.visible(), true);

    // Enter on `On`: the apply really flips the stored state...
    await syncOn.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });
    assert.equal(state.sync, true, 'the apply reached the store');

    // ...and the SAME objects — never a rebuilt row set — paint it, which is the
    // reported symptom: `● On` and no picker without closing and reopening.
    assert.equal(syncOn.choice.current(), true, 'the bullet moves to On in place');
    assert.equal(syncOff.choice.current(), false);
    for (const row of themeRows) assert.equal(row.visible(), false, 'the picker disappears in place');
    void reads;
  });

  test('the theme picker reappears in place when the sync is turned off again', async () => {
    const state = { sync: true };
    const apply = async (choice) => {
      if (choice.settingId === 'theme-sync') state.sync = choice.optionId === 'on';
    };
    const rows = customizeRows({ model: () => modelFor({ sync: state.sync ? 'on' : 'off', theme: 'Dark', themeNames: ['Dark'] }), apply });
    const themeRows = rowsFor(rows, 'Select theme');
    // Rows exist while hidden; only `visible()` answers.
    for (const row of themeRows) assert.equal(row.visible(), false);

    await rowsFor(rows, 'Theme sync').find((row) => row.choice.value === 'Off')
      .action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });

    for (const row of themeRows) assert.equal(row.visible(), true, 'the picker is back on the same objects');
  });

  // The model runs a synchronous `configure.js --check` subprocess, so a read per
  // callback is unbounded work while the menu opens (the verifier measured 41
  // checks for the build plus 68 for the values, ~2.6 s with 30 themes). A
  // synchronous paint burst is one model run; only an apply or the TTL re-reads.
  test('one model run per burst, in place, with the TTL bounding the next', () => {
    const clock = withClock();
    try {
      let reads = 0;
      const model = () => {
        reads += 1;
        return modelFor({
          sync: 'off',
          theme: 'Dark',
          themeNames: Array.from({ length: 30 }, (_, at) => `Theme ${at + 1}`),
        });
      };
      const rows = customizeRows({ model, apply: recorder().apply });
      assert.equal(reads, 1, 'the build is one model run');
      assert.ok(rows.length > 30, 'the page is built from it');

      // Every value bullet, gate and swatch of all four lines, synchronously.
      for (const row of rows) {
        assert.equal(typeof row.choice.current(), 'boolean');
        if (typeof row.visible === 'function') assert.equal(typeof row.visible(), 'boolean');
        if (typeof row.preview === 'function') row.preview();
      }
      assert.equal(reads, 1, 'a synchronous paint burst never re-runs the model');

      // An arrow-key repaint arrives inside the TTL: still free.
      clock.advance(MODEL_CACHE_TTL_MS - 1);
      rows[0].choice.current();
      rows.at(-1).visible?.();
      assert.equal(reads, 1, 'a keystroke repaint inside the TTL is free');

      // Past the TTL the cache is dropped: one re-read, then cached again.
      clock.advance(2);
      rows[0].choice.current();
      assert.equal(reads, 2, 'a repaint after the TTL re-reads exactly once');
      rows.at(-1).visible?.();
      assert.equal(reads, 2, 'and that new snapshot serves the rest of its own burst');
    } finally {
      clock.restore();
    }
  });

  test('a refusal re-reads too, and an apply is the only thing that must invalidate', async () => {
    let reads = 0;
    const rows = customizeRows({
      model: () => {
        reads += 1;
        return modelFor({ sync: 'off', theme: 'Dark', themeNames: ['Dark'] });
      },
      apply: () => Promise.reject(new Error('refused')),
    });
    assert.equal(reads, 1);
    rows[0].choice.current();
    assert.equal(reads, 1);
    await assert.rejects(() => rows[0].action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined }));
    rows[0].choice.current();
    assert.equal(reads, 2, 'a settled apply drops the cache, even when it refused');
  });

  test('a second build is a fresh read that sees the changed model', () => {
    let reads = 0;
    let sidebar = 'off';
    const model = () => {
      reads += 1;
      return modelFor({ sidebar, moshi: 'on', sync: 'off', theme: 'Dark', themeNames: ['Dark', 'Light'] });
    };

    const first = customizeRows({ model, apply: recorder().apply });
    assert.equal(reads, 1);
    assert.equal(rowsFor(first, 'Herd agents').find((row) => row.choice.value === 'On').choice.current(), false);

    // The stored state changes behind the page: the host's next build — after an
    // action, or when the menu is opened again — is a new read and shows it.
    sidebar = 'on';
    const rebuilt = customizeRows({ model, apply: recorder().apply });
    assert.equal(reads, 2, 'one model run per build');
    assert.equal(rowsFor(rebuilt, 'Herd agents').find((row) => row.choice.value === 'On').choice.current(), true);
    assert.equal(rowsFor(rebuilt, 'Herd agents').find((row) => row.choice.value === 'Off').choice.current(), false);

    // An edit landing in the SAME option object is read, because the snapshot is
    // the model's own array and not a copy of it.
    const shared = modelFor({ sidebar: 'off', theme: 'Dark' });
    const staticRows = customizeRows({ model: shared, apply: recorder().apply });
    const staticOn = rowsFor(staticRows, 'Herd agents').find((row) => row.choice.value === 'On');
    assert.equal(staticOn.choice.current(), false);
    for (const option of shared[0].settings[0].options) option.current = option.id === 'on';
    assert.equal(staticOn.choice.current(), true);
  });

  test('the theme rows are hidden while the stored sync is on and present while it is off', () => {
    // One build per model state: the gate is read from the snapshot of that
    // build (see the one-read test above), and the host rebuilds after an apply.
    const build = (state) => rowsFor(customizeRows({ model: modelFor(state), apply: recorder().apply }), 'Select theme');
    const themeRows = build({ sync: 'on', themeNames: ['Dark'] });
    assert.equal(themeRows.length, 2, 'the unassign entry plus the host theme');
    for (const row of themeRows) assert.equal(row.visible(), false);

    for (const row of build({ sync: 'off', themeNames: ['Dark'] })) assert.equal(row.visible(), true);

    // An unreadable store is not "sync on": the picker stays reachable.
    for (const row of build({ readable: false, sync: 'on', themeNames: ['Dark'] })) {
      assert.equal(row.visible(), true, 'an unknown sync hides nothing');
    }

    // Only the theme setting is gated; the three switches are always there.
    const rows = customizeRows({ model: modelFor({ sync: 'on', themeNames: ['Dark'] }), apply: recorder().apply });
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
  // An installed theme may be named anything, including the sentinel's own text.
  // Two rows whose value word is identical are indistinguishable on the page
  // while their option ids differ — one pins that theme, the other clears the
  // pin — so the baseline picker's rule (`themeSelectionOptions` in
  // extensions/gentle-herdr-state.ts: the UNASSIGN entry moves, the theme keeps
  // the name it is) is reproduced for the rows.
  test('an installed theme named like the unassign entry never shares its value word', async () => {
    const rec = recorder();
    const rows = customizeRows({ model: modelFor({ theme: null, themeNames: [UNASSIGN_TEXT, 'Dark'] }), apply: rec.apply });
    const themeRows = rowsFor(rows, 'Select theme');
    const values = themeRows.map((row) => row.choice.value);
    assert.equal(values.length, 3);
    assert.equal(new Set(values).size, values.length, 'no two rows print the same value word');
    assert.deepEqual(values, [`${UNASSIGN_TEXT} 2`, UNASSIGN_TEXT, 'Dark']);

    // The ids are untouched: the unassign row still clears the pin, and the row
    // that shows the theme's own name still pins exactly that theme.
    assert.deepEqual(await rec.choiceOf(themeRows[0]), { settingId: 'theme', optionId: 'none' });
    const colliding = themeRows.find((row) => row.choice.value === UNASSIGN_TEXT);
    assert.deepEqual(await rec.choiceOf(colliding), { settingId: 'theme', optionId: `theme:${UNASSIGN_TEXT}` });
  });

  test('a chain of colliding names keeps every value word distinct', () => {
    const names = [UNASSIGN_TEXT, `${UNASSIGN_TEXT} 2`, 'Dark'];
    const rows = customizeRows({ model: modelFor({ theme: names[1], themeNames: names }), apply: recorder().apply });
    const values = rowsFor(rows, 'Select theme').map((row) => row.choice.value);
    assert.deepEqual(values, [`${UNASSIGN_TEXT} 3`, ...names]);
    assert.equal(new Set(values).size, values.length);
  });

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

// Defect 1 (parity regression found by using the shipped page): every row of the
// four S1 settings answers the very title and sample the floating panel paints
// for that setting and value. The texts are NOT copied here — the page reads them
// from the model the panel builds (`customizePanelModel`), which owns them — and
// these tests prove it by rendering the panel and reading its Preview block back.
describe('customizeRows — the panel\'s own previews on every row (S1/S3)', () => {
  // One model carries every value of all four settings: `sidebar`/`moshi` both
  // list On and Off, `theme-sync` both Off and On, and the theme picker lists
  // the unassign entry plus every installed theme.
  const ALL_VALUES = () => modelFor({
    sidebar: 'on',
    moshi: 'on',
    sync: 'off',
    theme: 'Dark',
    themeNames: ['Dark', 'Light'],
  });

  test('every value of every setting paints the panel\'s own title and sample', () => {
    const model = ALL_VALUES();
    const rows = customizeRows({ model, apply: recorder().apply });
    const settings = model.flatMap((category) => category.settings);
    // The page's own line names (S1) for the model's setting ids; the values are
    // in the model's order, one page row each.
    const PAGE_LINE = { sidebar: 'Herd agents', moshi: 'Moshi', 'theme-sync': 'Theme sync', theme: 'Select theme' };

    let checked = 0;
    for (const setting of settings) {
      const pageRows = rowsFor(rows, PAGE_LINE[setting.id]);
      assert.equal(pageRows.length, setting.options.length, `one page row per ${setting.id} value`);
      for (let at = 0; at < setting.options.length; at += 1) {
        const option = setting.options[at];
        const row = pageRows[at];
        assert.equal(typeof row.preview, 'function', `${setting.id}/${option.id} answers a preview`);
        const preview = row.preview();
        assert.deepEqual(
          preview,
          panelPaintedPreview(model, setting.id, option.id),
          `${setting.id}/${option.id}: the page paints what the panel paints`,
        );
        assert.ok(preview.title.length > 0, 'the title is never empty');
        assert.ok(preview.sample.length > 0, 'the sample is never empty');
        checked += 1;
      }
    }
    // The four settings, every value: 2 sidebar + 2 moshi + 2 sync + 3 themes.
    assert.equal(checked, 9, 'all four settings were checked, on every value');
  });

  test('the sample follows a changed state without a rebuild', () => {
    const model = ALL_VALUES();
    const rows = customizeRows({ model, apply: recorder().apply });
    const moshiOff = rowsFor(rows, 'Moshi').find((row) => row.choice.value === 'Off');
    assert.equal(moshiOff.preview().sample, 'silent; no Moshi notification');

    // The state changes underneath the mounted rows (the model the page was built
    // from is edited in place, exactly like the host's live model): the SAME row
    // answers the new sample without any rebuild.
    const moshiSetting = model.flatMap((category) => category.settings).find((setting) => setting.id === 'moshi');
    moshiSetting.options.find((option) => option.id === 'off').preview = {
      title: 'static notification sample',
      sample: 'changed sample',
    };
    assert.equal(moshiOff.preview().sample, 'changed sample', 'the mounted row re-reads the live model');
  });

  test('the page carries no copy of the panel\'s samples: one source of truth', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'customize-rows.js'), 'utf8');
    for (const sample of [
      '● project   gentle   worker',
      'native Herdr rows; no managed block',
      'ask   finished',
      'silent; no Moshi notification',
      'Herdr follows the theme active in Pi',
      'Herdr keeps its last palette',
      'no theme pinned; Herdr keeps its last palette',
      'static sidebar sample',
      'static notification sample',
      'static sync sample',
      'static unassigned sample',
      'source palette',
    ]) {
      assert.equal(source.includes(sample), false, `lib/customize-rows.js must not copy ${JSON.stringify(sample)}`);
    }
    // And the samples really come from the panel module: its own model is the
    // only place those strings live.
    const panel = fs.readFileSync(path.join(__dirname, '..', 'lib', 'customize-panel.js'), 'utf8');
    for (const sample of ['● project   gentle   worker', 'ask   finished', 'Herdr keeps its last palette']) {
      assert.equal(panel.includes(sample), true, `lib/customize-panel.js owns ${JSON.stringify(sample)}`);
    }
  });

  test('the panel\'s per-setting note is the row\'s hint, and only when it has one', () => {
    // An unreadable sidebar state is the panel's own note line; the page says the
    // same thing through `choice.hint` instead of inventing a second wording.
    const unknown = modelFor({ sidebar: 'unknown', moshi: 'on', sync: 'off', theme: null, themeNames: ['Dark'] });
    const sidebarNote = unknown.flatMap((category) => category.settings)
      .find((setting) => setting.id === 'sidebar').note;
    assert.equal(sidebarNote, 'state unknown; Enter turns the rows on', 'the panel owns the sentence');

    const rows = customizeRows({ model: unknown, apply: recorder().apply });
    for (const row of rowsFor(rows, 'Herd agents')) assert.equal(row.choice.hint, sidebarNote);

    // The theme picker's own unknown note rides on its rows too.
    const unreadableTheme = modelFor({ theme: null, readable: false, themeNames: ['Dark'] });
    const themeNote = unreadableTheme.flatMap((category) => category.settings)
      .find((setting) => setting.id === 'theme').note;
    assert.match(themeNote, /state unknown/);
    for (const row of rowsFor(customizeRows({ model: unreadableTheme, apply: recorder().apply }), 'Select theme')) {
      assert.equal(row.choice.hint, themeNote);
    }

    // A state the panel can read carries NO note, so no row carries a hint: a
    // hint would replace the host's `Preview · …` headline with a needless line.
    const healthy = customizeRows({ model: ALL_VALUES(), apply: recorder().apply });
    for (const row of healthy) assert.equal(row.choice.hint, undefined, 'no hint without a panel note');
  });
});
