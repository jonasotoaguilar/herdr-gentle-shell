'use strict';
// The floating Customize panel (odd/tasks/restore-customize-panel.md T1,
// S1/S2) after the Shell-layout port (odd/tasks/customize-parity-done-idle.md
// T1/T3, S1/S4).
//
// The panel is the two-pane card reduced to the switches this package owns: the
// managed Herdr sidebar rows and the notification channel, the latter reachable
// from BOTH its own category and the `Herdr Sidebar` category. These tests pin,
// through the component's public contract only (render(width),
// handleInput(data), handleMouse(event) and the done() result the host
// receives):
// - the Shell's layout: left `CATEGORIES` list, right `<Category> · n/m`
//   heading, pill rows (`●` stored / `○` other), no `Preview · …` band and the
//   Shell's footer wording with no invented `p profiles` key;
// - the notification row inside `Herdr Sidebar` reading the same stored value
//   as the `Moshi notifications` category;
// - category and value navigation (↑/↓ or j/k, ←/→ or Tab) without finishing;
// - Enter resolving the focused row and Esc resolving null;
// - mouse hits: a category click selects, a row click applies, a hover only
//   moves the focus, anything outside the panes is ignored and a press alone
//   applies nothing; the hit test reads the frame the panel actually rendered,
//   so a box the host clipped shorter never turns a legal click into a no-op;
// - the one-line description of the focused setting above the legend, which
//   follows the focus and costs no width;
// - a legend that names only keys: `Click` is gone;
// - the key-release guard, the narrow single-pane fallback, the unknown note,
//   short-terminal clipping and a hostile theme degrading to plain text.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createCustomizePanel, customizePanelModel } = require('../lib/customize-panel.js');

// The pi-tui shape the panel consumes: measurement, truncation, key matching
// and the Kitty release classifier. Raw inputs are plain strings here.
const stubTui = {
  visibleWidth: (s) => [...String(s)].length,
  truncateToWidth: (s, w) => {
    const chars = [...String(s)];
    return chars.length > w ? chars.slice(0, w).join('') : String(s);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

const FOOTER = '←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close';

// A theme that answers `bg`, so the focus band (the active pane's marker) is
// observable as text instead of a terminal colour.
const bandTheme = {
  fg: (_role, text) => text,
  bold: (text) => text,
  bg: (_role, text) => `[${text}]`,
};

function makeHostTui() {
  const paints = [];
  return { paints, tui: { requestRender: () => { paints.push(true); } } };
}

function open({ model, host, rowsAvailable, theme = {}, helpers = stubTui } = {}) {
  const hostTui = host || makeHostTui();
  let settled = 'pending';
  const component = createCustomizePanel({
    helpers,
    hostTui: hostTui.tui,
    theme,
    rowsAvailable,
    model: model || customizePanelModel({ sidebar: 'on', moshi: 'off' }),
    done: (result) => { settled = result; },
  });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  assert.equal(typeof component.handleMouse, 'function');
  assert.equal(typeof component.invalidate, 'function');
  return { component, host: hostTui, done: () => settled };
}

function seenAt(component, width) {
  return component.render(width).join('\n');
}

// A pointer event on the rendered line that carries `needle`, at the column
// where that needle starts — the way the host reports a local-frame click.
// `boxHeight` reproduces the overlay's own clipping: the host renders the card
// and hands back only the rows that fit its box, so the reported height can be
// shorter than the frame the panel computed for itself.
function click(component, width, needle, { type = 'click', column, boxHeight } = {}) {
  const rendered = component.render(width);
  const lines = boxHeight === undefined ? rendered : rendered.slice(0, boxHeight);
  const y = lines.findIndex((line) => line.includes(needle));
  assert.ok(y >= 0, `no rendered line carries ${needle}`);
  const x = column === undefined ? lines[y].indexOf(needle) : column;
  return component.handleMouse({
    type,
    button: type === 'move' ? 'none' : 'left',
    x,
    y,
    width,
    height: lines.length,
    shift: false,
    alt: false,
    ctrl: false,
  });
}

describe('customize panel model', () => {
  test('carries the two categories and the switches each one shows', () => {
    const model = customizePanelModel({ sidebar: 'off', moshi: 'on' });
    assert.deepEqual(model.map((category) => category.id), ['sidebar', 'moshi']);
    assert.deepEqual(model.map((category) => category.title), ['Herdr Sidebar', 'Moshi notifications']);
    // The notifications row lives under `Herdr Sidebar` as well, and both rows
    // are driven by the one moshi switch.
    assert.deepEqual(model[0].rows.map((row) => row.setting), ['Sidebar agent rows', 'Notifications']);
    assert.deepEqual(model[0].rows.map((row) => row.switchId), ['sidebar', 'moshi']);
    assert.deepEqual(model[1].rows.map((row) => row.setting), ['Notifications']);
    assert.deepEqual(model[1].rows.map((row) => row.switchId), ['moshi']);
    // One toggle row per switch: it paints the stored value and carries the
    // value Enter applies, so a single row is the whole interaction.
    assert.deepEqual(model[0].rows.map((row) => row.id), ['on', 'off'], 'sidebar off toggles back on');
    assert.deepEqual(model[0].rows.map((row) => row.current), ['off', 'on']);
    assert.deepEqual(model[0].rows.map((row) => row.currentLabel), ['Off', 'On']);
  });

  test('both notification rows read the one stored flag', () => {
    const off = customizePanelModel({ sidebar: 'on', moshi: 'off' });
    assert.equal(off[0].rows[1].current, 'off');
    assert.equal(off[1].rows[0].current, 'off');
    assert.equal(off[0].rows[1].id, 'on', 'Off toggles on from either place');
    assert.equal(off[1].rows[0].id, 'on');
    const on = customizePanelModel({ sidebar: 'on', moshi: 'on' });
    assert.equal(on[0].rows[1].current, 'on');
    assert.equal(on[1].rows[0].current, 'on');
    assert.equal(on[0].rows[1].id, 'off', 'On toggles off from either place');
    assert.equal(on[1].rows[0].id, 'off');
  });

  test('an unknown sidebar state carries a note but stays repairable', () => {
    const model = customizePanelModel({ sidebar: 'unknown', moshi: 'off' });
    assert.equal(model[0].rows[0].current, null, 'unknown is not a guessed value');
    assert.equal(model[0].rows[0].currentLabel, 'Unknown');
    assert.equal(model[0].rows[0].id, 'on', 'the repair is still one key away');
    assert.match(model[0].rows[0].note, /state unknown/);
  });
});

describe('customize panel render', () => {
  test('renders the Shell layout: headers, pill rows, footer and no preview band', () => {
    const { component } = open();
    const seen = seenAt(component, 100);
    for (const copy of [
      'Customize · Herdr Gentle Shell',
      'CATEGORIES',
      'Herdr Sidebar · 1/2',
      'Sidebar agent rows',
      'Notifications',
      '● On',
      '○ Off',
      FOOTER,
    ]) {
      assert.ok(seen.includes(copy), `panel copy missing: ${copy}`);
    }
    for (const gone of ['Preview', 'p profiles', 'Enter toggle', 'j/k']) {
      assert.equal(seen.includes(gone), false, `the Shell layout has no ${gone}`);
    }
  });

  test('the notification row is reachable inside the Herdr Sidebar category', () => {
    const { component } = open();
    const lines = component.render(100);
    const heading = lines.find((line) => line.includes('Herdr Sidebar ·'));
    assert.ok(heading, 'the right pane is headed by the category and its row count');
    const sidebarRow = lines.find((line) => line.includes('Sidebar agent rows'));
    const notificationRow = lines.find((line) => line.includes('Notifications'));
    assert.ok(sidebarRow.includes('● On'), 'the first sidebar row paints the stored On');
    assert.ok(notificationRow.includes('● Off'), 'the notifications row paints the stored Off');
    assert.ok(notificationRow.includes('○ On'), 'and the other value as the target');
  });

  test('the Moshi notifications category keeps its own row and heading', () => {
    const { component } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'on' }) });
    component.handleInput('down');
    const seen = seenAt(component, 100);
    assert.ok(seen.includes('Moshi notifications · 1/1'));
    assert.ok(seen.includes('▸ Moshi notifications'), 'the category cursor moved');
  });

  test('offers none of the removed sections', () => {
    const { component } = open();
    const seen = seenAt(component, 100);
    for (const gone of ['Plugin tools', 'Worktree tools', 'ODD command', 'Issues command', 'Reset every option']) {
      assert.equal(seen.includes(gone), false, `removed section still rendered: ${gone}`);
    }
  });

  test('marks the focused category with ▸ and the focused row in the values pane', () => {
    const { component } = open();
    assert.ok(seenAt(component, 100).includes('▸ Herdr Sidebar'), 'focus starts on the first category');
    assert.equal(seenAt(component, 100).includes('▸ Moshi notifications'), false, 'the category list starts focused');
    component.handleInput('right');
    assert.ok(seenAt(component, 100).includes('▸ Sidebar agent rows'), 'the first row takes the focus marker');
  });

  test('a narrow terminal falls back to one navigable pane and keeps the pills', () => {
    const { component } = open();
    const seen = seenAt(component, 50);
    assert.equal(seen.includes('CATEGORIES'), false, 'the left column is gone at 50 columns');
    assert.ok(seen.includes('Categories'));
    assert.ok(seen.includes('Herdr Sidebar'));
    assert.ok(seenAt(component, 50).includes('▸ Herdr Sidebar'), 'the focus marker is visible at 50 columns');
    component.handleInput('down');
    assert.ok(seenAt(component, 50).includes('▸ Moshi notifications'), 'focus moves at 50 columns');
    component.handleInput('right');
    const values = seenAt(component, 50);
    assert.ok(values.includes('● Off'), 'the stored value still renders at 50 columns');
    assert.ok(values.includes('○ On'), 'and the other value stays visible');
    assert.ok(values.includes('Moshi notifications · 1/1'));
  });

  test('at the 60-column breakpoint the two panes are back', () => {
    const seen = seenAt(open().component, 60);
    assert.ok(seen.includes('CATEGORIES'));
    assert.ok(seen.includes('Herdr Sidebar') && seen.includes('Moshi notifications'));
    assert.ok(seen.includes('│'), 'the pane divider is visible at 60 columns');
    assert.ok(seen.includes('● On'), 'the pills fit at 60 columns');
  });

  test('short terminals clip to the rows available', () => {
    const { component } = open({ rowsAvailable: () => 8 });
    const lines = component.render(100);
    assert.ok(lines.length <= 8, `expected at most 8 rows, got ${lines.length}`);
    assert.ok(lines.join('\n').includes('Customize · Herdr Gentle Shell'), 'the title survives');
  });

  test('an unknown sidebar state reads its note and paints Unknown as the stored pill', () => {
    const { component } = open({ model: customizePanelModel({ sidebar: 'unknown', moshi: 'off' }) });
    const seen = seenAt(component, 100);
    assert.ok(seen.includes('state unknown'), 'the note explains the inconclusive state');
    assert.equal(seen.includes('(unavailable in this session)'), false, 'the repair is never blocked');
    assert.ok(seen.includes('● Unknown'), 'an unreadable state is named, never guessed');
    assert.ok(seen.includes('○ On'), 'and On stays the actionable value');
  });

  test('a hostile theme degrades to plain text', () => {
    const hostile = {
      fg: () => { throw new Error('no colours'); },
      bg: () => { throw new Error('no background'); },
      bold: () => { throw new Error('no weight'); },
    };
    const { component } = open({ theme: hostile });
    const seen = seenAt(component, 100);
    assert.ok(seen.includes('Customize · Herdr Gentle Shell'));
    assert.ok(seen.includes('Moshi notifications'));
    assert.ok(seen.includes('● On'));
  });
});

describe('customize panel focused description', () => {
  test('describes the focused category on the line above the legend', () => {
    const { component } = open();
    const lines = component.render(100);
    const legend = lines.findIndex((line) => line.includes('Enter apply'));
    const described = lines.findIndex((line) => line.includes('Sidebar agent rows plus the Moshi notification channel.'));
    assert.ok(legend > 0, 'the legend is rendered');
    assert.ok(described >= 0, 'the focused category is described');
    assert.equal(described, legend - 1, 'the description sits directly above the legend');
    assert.ok(lines[described].includes('Herdr Sidebar'), 'the description names what it describes');
  });

  test('describes the focused setting and follows the focus', () => {
    const { component } = open();
    // The category list owns the focus first, so the card describes that category.
    assert.ok(seenAt(component, 100).includes('Herdr Sidebar — Sidebar agent rows plus the Moshi notification channel.'));
    component.handleInput('down');
    const moshi = seenAt(component, 100);
    assert.ok(moshi.includes('Moshi notifications — The Moshi notification channel this plugin owns.'));
    assert.equal(moshi.includes('Sidebar agent rows plus the Moshi notification channel.'), false);
    // The values pane describes the setting Enter would apply.
    component.handleInput('right');
    assert.ok(seenAt(component, 100).includes('Notifications — Replaces the Moshi hook with this plugin'));
    // And the line follows the focus back to the other category's row.
    component.handleInput('tab');
    component.handleInput('up');
    component.handleInput('tab');
    assert.ok(seenAt(component, 100).includes('Sidebar agent rows — Hands the Herdr sidebar to this plugin'));
  });

  test('the description never widens or grows the card', () => {
    for (const width of [60, 80, 100, 120]) {
      const lines = open().component.render(width);
      for (const line of lines) {
        assert.equal([...line].length, width, `a line of the ${width}-column card is ${[...line].length} wide`);
      }
      assert.ok(lines.length <= 24, `the card stays within 24 rows at ${width} columns`);
    }
    // A description wider than the pane is clipped, never wrapped onto a new row.
    const narrow = open().component.render(62);
    const legend = narrow.findIndex((line) => line.includes('Enter apply'));
    assert.ok(narrow[legend - 1].includes('Herdr Sidebar'), 'the clipped description still names its setting');
  });
});

describe('customize panel legend', () => {
  test('names the keys and never mentions Click', () => {
    const { component } = open();
    const lines = component.render(100);
    const legend = lines.find((line) => line.includes('Enter apply'));
    assert.ok(legend, 'the legend is rendered');
    assert.equal(legend.slice(2, -2).trim(), FOOTER);
    assert.equal(seenAt(component, 100).includes('Click'), false, 'the pointer needs no legend entry');
  });

  test('no width keeps a Click entry in the compact legend', () => {
    for (const width of [40, 50, 62, 80, 100]) {
      const { component } = open();
      assert.equal(seenAt(component, width).includes('Click'), false, `Click survives at ${width} columns`);
      assert.ok(seenAt(component, width).includes('Esc close'), `the close key survives at ${width} columns`);
    }
  });
});

describe('customize panel navigation', () => {
  test('the row Enter applies is marked before any key is pressed', () => {
    const { component, done } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    const first = seenAt(component, 100);
    assert.ok(first.includes('▸ Herdr Sidebar'), 'the category list owns the focus first');
    assert.ok(first.includes('▸ Sidebar agent rows'), 'and the row Enter would apply is visible');
    assert.equal(first.includes('▸ Notifications'), false, 'only the focused row carries the marker');
    component.handleInput('enter');
    assert.deepEqual(done(), { categoryId: 'sidebar', switchId: 'sidebar', valueId: 'off' }, 'On toggles off');
  });

  test('arrows and Tab move the focus band between panes from the opening state', () => {
    const { component, done } = open({ theme: bandTheme });
    const opening = seenAt(component, 100);
    assert.ok(opening.includes('[  Herdr Sidebar'), 'the category pane opens with the band on its cursor');
    assert.equal(opening.includes('[  Sidebar agent rows'), false, 'the values pane is not active yet');
    // ↓ moves inside the active pane: the category cursor, not a setting row.
    component.handleInput('down');
    assert.ok(seenAt(component, 100).includes('[  Moshi notifications'), 'the band follows the category cursor');
    assert.equal(done(), 'pending');
    // → hands the band to the values pane; ↑/↓ then move the setting row.
    component.handleInput('right');
    assert.equal(seenAt(component, 100).includes('[  Moshi notifications'), false, 'the category list gave the band up');
    assert.ok(seenAt(component, 100).includes('[▸ Notifications'), 'the focused row carries the band');
    component.handleInput('tab');
    assert.ok(seenAt(component, 100).includes('[  Moshi notifications'), 'Tab returns to the categories');
    component.handleInput('tab');
    assert.ok(seenAt(component, 100).includes('[▸ Notifications'), 'Tab returns to the values');
    component.handleInput('enter');
    assert.deepEqual(done(), { categoryId: 'moshi', switchId: 'moshi', valueId: 'on' }, 'a stored Off toggles on');
  });
  test('↓/j moves the category cursor and repaints without finishing', () => {
    const { component, host, done } = open();
    component.handleInput('down');
    assert.equal(host.paints.length, 1, 'a selection change requests a repaint');
    assert.ok(seenAt(component, 100).includes('▸ Moshi notifications'));
    component.handleInput('j');
    assert.ok(seenAt(component, 100).includes('▸ Herdr Sidebar'), 'the cursor wraps');
    assert.equal(done(), 'pending', 'movement never finishes the overlay');
  });

  test('←/→ or Tab switches panes and ↑/↓ moves within the values', () => {
    const { component, done } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    component.handleInput('right');
    assert.ok(seenAt(component, 100).includes('▸ Sidebar agent rows'));
    component.handleInput('down');
    assert.ok(seenAt(component, 100).includes('▸ Notifications'), 'the second sidebar row takes the focus');
    component.handleInput('tab');
    component.handleInput('k');
    assert.equal(done(), 'pending');
  });

  test('Enter applies the focused switch and closes the overlay', () => {
    const first = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    first.component.handleInput('enter');
    assert.deepEqual(first.done(), { categoryId: 'sidebar', switchId: 'sidebar', valueId: 'off' }, 'On toggles off');

    const second = open({ model: customizePanelModel({ sidebar: 'off', moshi: 'off' }) });
    second.component.handleInput('enter');
    assert.deepEqual(second.done(), { categoryId: 'sidebar', switchId: 'sidebar', valueId: 'on' }, 'Off toggles on');
  });

  test('Enter on the notifications row applies the moshi switch from the sidebar category', () => {
    const { component, done } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    component.handleInput('right');
    component.handleInput('down');
    assert.ok(seenAt(component, 100).includes('▸ Notifications'), 'the sidebar category holds the notifications row');
    component.handleInput('enter');
    assert.deepEqual(done(), { categoryId: 'sidebar', switchId: 'moshi', valueId: 'on' });
  });

  test('Enter in the Moshi notifications category still resolves that pane row', () => {
    const { component, done } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    component.handleInput('down');
    component.handleInput('right');
    component.handleInput('up');
    component.handleInput('enter');
    assert.deepEqual(done(), { categoryId: 'moshi', switchId: 'moshi', valueId: 'on' }, 'a stored Off toggles on');
  });

  test('Esc and ctrl+c close with null', () => {
    const escape = open();
    escape.component.handleInput('escape');
    assert.equal(escape.done(), null);

    const ctrlC = open();
    ctrlC.component.handleInput('ctrl+c');
    assert.equal(ctrlC.done(), null);
  });

  test('a key-release event changes nothing', () => {
    const { component, host, done } = open();
    const before = seenAt(component, 100);
    component.handleInput('release');
    assert.equal(host.paints.length, 0);
    assert.equal(seenAt(component, 100), before);
    assert.equal(done(), 'pending');
  });
});

describe('customize panel mouse', () => {
  test('clicking a category selects it without finishing', () => {
    const { component, done } = open();
    const result = click(component, 100, 'Moshi notifications');
    assert.deepEqual(result, { handled: true, render: true, focus: true });
    assert.ok(seenAt(component, 100).includes('▸ Moshi notifications'));
    assert.ok(seenAt(component, 100).includes('Moshi notifications · 1/1'));
    assert.equal(done(), 'pending', 'selecting a category is not applying a row');
  });

  test('clicking a row applies it, including the notifications row under Herdr Sidebar', () => {
    const sidebar = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    click(sidebar.component, 100, 'Sidebar agent rows');
    assert.deepEqual(sidebar.done(), { categoryId: 'sidebar', switchId: 'sidebar', valueId: 'off' });

    const notifications = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    click(notifications.component, 100, 'Notifications');
    assert.deepEqual(notifications.done(), { categoryId: 'sidebar', switchId: 'moshi', valueId: 'on' });
  });

  test('a box the host clipped shorter never turns a legal click into a no-op', () => {
    // The overlay is capped at 85% of the terminal while the panel budgets rows
    // from the terminal height, so the host hands back a box shorter than the
    // frame the panel computed for itself. The click must still land.
    const row = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }), rowsAvailable: () => 20 });
    assert.equal(row.component.render(100).length, 20, 'the panel fills the rows it was given');
    const result = click(row.component, 100, 'Sidebar agent rows', { boxHeight: 17 });
    assert.equal(result.handled, true, 'the click is handled');
    assert.deepEqual(row.done(), { categoryId: 'sidebar', switchId: 'sidebar', valueId: 'off' });

    const category = open({ rowsAvailable: () => 20 });
    const selected = click(category.component, 100, 'Moshi notifications', { boxHeight: 17 });
    assert.equal(selected.handled, true);
    assert.ok(seenAt(category.component, 100).includes('▸ Moshi notifications'));
    assert.equal(category.done(), 'pending', 'selecting a category is not applying a row');
  });

  test('an activating click hands the panel keyboard focus', () => {
    const row = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    assert.equal(click(row.component, 100, 'Sidebar agent rows').focus, true);
    const category = open();
    assert.equal(click(category.component, 100, 'Moshi notifications').focus, true);
  });

  test('a hover moves the focus without applying anything', () => {
    const { component, done } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    const moved = click(component, 100, 'Notifications', { type: 'move' });
    assert.deepEqual(moved, { handled: true, render: true });
    assert.ok(seenAt(component, 100).includes('▸ Notifications'), 'the hovered row takes the focus');
    assert.ok(seenAt(component, 100).includes('Herdr Sidebar · 2/2'), 'and the heading follows the focus');
    assert.equal(done(), 'pending', 'a hover never applies a switch');
    // Hovering the row that already has the focus repaints nothing.
    assert.deepEqual(click(component, 100, 'Notifications', { type: 'move' }), { handled: true, render: false });
  });

  test('a click outside the panes is ignored', () => {
    const { component, done } = open();
    const lines = component.render(100);
    const height = lines.length;
    const base = { button: 'left', width: 100, height, shift: false, alt: false, ctrl: false };
    // The card border row.
    assert.equal(component.handleMouse({ ...base, type: 'click', x: 5, y: 0 }), undefined);
    // The title row.
    assert.equal(component.handleMouse({ ...base, type: 'click', x: 5, y: 1 }), undefined);
    // The footer row.
    assert.equal(component.handleMouse({ ...base, type: 'click', x: 5, y: height - 2 }), undefined);
    // The pane divider between the two panes.
    const divider = lines.find((line) => line.includes('│'));
    assert.equal(
      component.handleMouse({ ...base, type: 'click', x: divider.indexOf('│'), y: lines.indexOf(divider) }),
      undefined,
    );
    assert.equal(done(), 'pending');
  });

  test('a press only captures the gesture; the click applies', () => {
    const { component, done } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    assert.deepEqual(click(component, 100, 'Notifications', { type: 'press' }), {
      handled: true,
      capture: true,
      render: false,
    });
    assert.equal(done(), 'pending', 'a drag that never becomes a click applies nothing');
    click(component, 100, 'Notifications');
    assert.deepEqual(done(), { categoryId: 'sidebar', switchId: 'moshi', valueId: 'on' });
  });

  test('a click that misses every hit target is ignored', () => {
    const { component, done } = open();
    const lines = component.render(100);
    const y = lines.findIndex((line) => line.includes('Sidebar agent rows'));
    const x = lines[y].indexOf('Sidebar agent rows');
    const base = { type: 'click', x, y, width: 100, height: lines.length, shift: false, alt: false, ctrl: false };
    assert.equal(component.handleMouse({ ...base, button: 'right' }), undefined, 'only the left button acts');
    assert.equal(component.handleMouse({ ...base, button: 'left', type: 'wheel' }), undefined, 'a wheel never applies');
    assert.equal(done(), 'pending');
  });
});
