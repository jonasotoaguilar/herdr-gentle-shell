'use strict';
// The restored floating Customize panel (odd/tasks/restore-customize-panel.md
// T1, S1/S2).
//
// The panel is the former two-pane card recovered from commit 0e92869, reduced
// to the two switches this package still owns: the managed Herdr sidebar rows
// and the Moshi notification channel. These tests pin, through the component's
// public contract only (render(width) and handleInput(data) plus the done()
// result the host receives):
// - the restored copy, geometry and footer legend, with none of the removed
//   worktree / ODD / Issues / Reset sections;
// - the active value's → marker and the focus ▸ marker;
// - category and value navigation (↑/↓ or j/k, ←/→ or Tab) without finishing;
// - Enter resolving the focused row and Esc resolving null;
// - the key-release guard, the narrow single-pane fallback, the unavailable
//   note and short-terminal clipping;
// - a hostile theme degrading to plain text instead of breaking the render.

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
  assert.equal(typeof component.invalidate, 'function');
  return { component, host: hostTui, done: () => settled };
}

function seenAt(component, width) {
  return component.render(width).join('\n');
}

describe('customize panel model', () => {
  test('carries only the two surviving switches with their stored values', () => {
    const model = customizePanelModel({ sidebar: 'off', moshi: 'on' });
    assert.deepEqual(model.map((category) => category.id), ['sidebar', 'moshi']);
    assert.deepEqual(model.map((category) => category.title), ['Herdr Sidebar', 'Moshi notifications']);
    assert.deepEqual(model.map((category) => category.active), ['off', 'on']);
    assert.deepEqual(model.map((category) => category.note), [undefined, undefined], 'a stored value needs no note');
    // One toggle row per switch: it shows the stored state and carries the
    // value Enter applies, so a single row is the whole interaction.
    assert.deepEqual(model[0].rows.map((row) => row.id), ['on'], 'sidebar off toggles back on');
    assert.deepEqual(model[0].rows.map((row) => row.label), ['Off']);
    assert.deepEqual(model[1].rows.map((row) => row.id), ['off'], 'moshi on toggles off');
    assert.deepEqual(model[1].rows.map((row) => row.label), ['On']);
  });

  test('an unknown sidebar state carries a note but stays repairable', () => {
    const model = customizePanelModel({ sidebar: 'unknown', moshi: 'off' });
    assert.equal(model[0].active, null, 'unknown is not a guessed value');
    assert.match(model[0].note, /state unknown/);
    assert.equal(model[1].active, 'off');
  });
});

describe('customize panel render', () => {
  test('renders the restored two-pane card and the footer legend', () => {
    const { component } = open();
    const seen = seenAt(component, 100);
    for (const copy of [
      'Customize · Herdr Gentle Shell',
      'CATEGORIES',
      'Herdr Sidebar',
      'Moshi notifications',
      '→ On',
      'Preview · On',
      '←/→ or Tab panes · ↑/↓ or j/k move · Enter toggle · Esc close',
    ]) {
      assert.ok(seen.includes(copy), `panel copy missing: ${copy}`);
    }
  });

  test('offers none of the removed sections', () => {
    const { component } = open();
    const seen = seenAt(component, 100);
    for (const gone of ['Plugin tools', 'Worktree tools', 'ODD command', 'Issues command', 'Reset every option']) {
      assert.equal(seen.includes(gone), false, `removed section still rendered: ${gone}`);
    }
  });

  test('marks the stored value with → and the focused category with ▸', () => {
    const { component } = open();
    const seen = seenAt(component, 100);
    assert.ok(seen.includes('▸ Herdr Sidebar'), 'focus starts on the first category');
    assert.equal(seen.includes('▸ Moshi notifications'), false);
    assert.ok(seen.includes('→ On'), 'the active sidebar row carries the → mark');
  });

  test('paints the stored Moshi state when its category is focused', () => {
    const { component } = open({ model: customizePanelModel({ sidebar: 'off', moshi: 'on' }) });
    component.handleInput('down');
    const seen = seenAt(component, 100);
    assert.ok(seen.includes('▸ Moshi notifications'));
    assert.ok(seen.includes('→ On'));
    assert.ok(seen.includes('Preview · On'));
  });

  test('a narrow terminal falls back to one navigable pane', () => {
    const { component } = open();
    const seen = seenAt(component, 50);
    assert.equal(seen.includes('CATEGORIES'), false, 'the left column is gone at 50 columns');
    assert.ok(seen.includes('Categories'));
    assert.ok(seen.includes('Herdr Sidebar'));
  });

  test('at 50 columns the categories stay visible and keep their focus', () => {
    const { component } = open();
    assert.ok(seenAt(component, 50).includes('▸ Herdr Sidebar'), 'the focus marker is visible at 50 columns');
    component.handleInput('down');
    assert.ok(seenAt(component, 50).includes('▸ Moshi notifications'), 'focus moves at 50 columns');
  });

  test('at the 60-column breakpoint the two panes are back', () => {
    const seen = seenAt(open().component, 60);
    assert.ok(seen.includes('CATEGORIES'));
    assert.ok(seen.includes('Herdr Sidebar') && seen.includes('Moshi notifications'));
    assert.ok(seen.includes('│'), 'the pane divider is visible at 60 columns');
  });

  test('short terminals clip to the rows available', () => {
    const { component } = open({ rowsAvailable: () => 8 });
    const lines = component.render(100);
    assert.ok(lines.length <= 8, `expected at most 8 rows, got ${lines.length}`);
    assert.ok(lines.join('\n').includes('Customize · Herdr Gentle Shell'), 'the title survives');
  });

  test('an unknown sidebar state reads its note and keeps the row actionable', () => {
    const { component } = open({ model: customizePanelModel({ sidebar: 'unknown', moshi: 'off' }) });
    const seen = seenAt(component, 100);
    assert.ok(seen.includes('state unknown'), 'the note explains the inconclusive state');
    assert.equal(seen.includes('(unavailable in this session)'), false, 'the repair is never blocked');
    assert.ok(seen.includes('→ Unknown'), 'an unreadable state is named, never guessed');
    assert.equal(seen.includes('→ Off'), false);
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
  });
});

describe('customize panel navigation', () => {
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
    component.handleInput('down');
    const seen = seenAt(component, 100);
    assert.match(seen, /▸\s+→ On/, 'the single toggle row keeps focus');
    component.handleInput('tab');
    component.handleInput('k');
    assert.equal(done(), 'pending');
  });

  test('Enter toggles the focused switch and closes the overlay', () => {
    const first = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    first.component.handleInput('enter');
    assert.deepEqual(first.done(), { categoryId: 'sidebar', valueId: 'off' }, 'On toggles off');

    const second = open({ model: customizePanelModel({ sidebar: 'off', moshi: 'off' }) });
    second.component.handleInput('enter');
    assert.deepEqual(second.done(), { categoryId: 'sidebar', valueId: 'on' }, 'Off toggles on');
  });

  test('Enter in the values pane resolves that pane row', () => {
    const { component, done } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off' }) });
    component.handleInput('down');
    component.handleInput('right');
    component.handleInput('up');
    component.handleInput('enter');
    assert.deepEqual(done(), { categoryId: 'moshi', valueId: 'on' }, 'a stored Off toggles on');
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
