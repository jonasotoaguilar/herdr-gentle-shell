'use strict';
// The floating Customize panel, rebuilt after Gentle Shell's own card
// (odd/tasks/theme-sync-fix.md T4; specs S1, S2, S5, S6, S7).
//
// What these tests pin, through the component's public contract only
// (render(width), handleInput(data), handleMouse(event), the injected apply()
// and the done() result the host receives):
// - the MODEL: categories -> settings -> options, one setting = ONE line with N
//   inline options, the stored option current, an unreadable state marking NO
//   option current, and structural option ids (`none` versus `theme:<name>`) so
//   an installed theme literally named `None` or `Off` stays pinnable;
// - the KEYS exactly as upstream with applyOnMove:false: ←/→ move the option
//   cursor and never apply, ← past the first option returns to the categories,
//   ↑/↓ land on the stored option, Tab switches panes, Enter applies the
//   cursored option and the panel STAYS OPEN, Esc finishes with null, a
//   key-release event changes nothing;
// - the MOUSE: an option click applies, a setting-name click only moves focus, a
//   category click selects, and the legend carries the `Click · ` prefix;
// - the OVERFLOW: sideways window with `‹`/`›` markers and an n/m counter that
//   always contains the cursor option, the compact `‹ value ›` fallback when not
//   even one option fits, tested with 30+ themes at 100/80/60/40 columns;
// - the PREVIEW block (S6): 6/3/1/0 lines by overlay height, inside the card
//   after the content rows, `Preview · <option> · <title>` in the accent role
//   and the sample lines in the muted role; `Preview unavailable` for an
//   unreadable source; no separate `<Category> — <description>` row;
// - the APPLY FLOW: apply({categoryId, settingId, optionId}) awaited behind a
//   busy guard, the returned model replaced with the cursor kept by ids, close
//   only when the result says so;
// - the THEME rows (S7): sync defaults to Off, the theme setting is dim and
//   band-less while the sync is on, and an unreadable store guesses nothing;
// - the narrow (<60 columns) single-pane fallback and the small-height rule that
//   drops the preview.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createCustomizePanel, customizePanelModel } = require('../lib/customize-panel.js');

const strip = (value) => String(value).replace(/\x1b\[[0-9;]*m/g, '');

// The pi-tui shape the panel consumes: measurement and truncation ignore
// escapes (the theme sample is raw SGR by design), key matching and the Kitty
// release classifier are plain strings here.
const stubTui = {
  visibleWidth: (s) => [...strip(s)].length,
  truncateToWidth: (s, width, ellipsis = '…') => {
    const chars = [...strip(s)];
    if (chars.length <= width) return String(s);
    return chars.slice(0, Math.max(0, width - 1)).join('') + ellipsis;
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

const TITLE = 'Customize · Herdr Gentle Shell';
const FOOTER = 'Click · ←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close';

// A theme that answers `bg`, so the focus band is observable as text instead of
// a terminal colour.
const bandTheme = {
  fg: (_role, text) => text,
  bold: (text) => text,
  bg: (_role, text) => `[${text}]`,
};

// Records the roles the panel asks for, without changing a single column.
function roleTheme() {
  const roles = [];
  return {
    roles,
    theme: {
      fg: (role, text) => { roles.push([role, text]); return text; },
      bold: (text) => text,
      bg: (_role, text) => text,
    },
  };
}

function makeHostTui() {
  const paints = [];
  return { paints, tui: { requestRender: () => { paints.push(true); } } };
}

const THEME_OFF = { ok: true, sync: false, theme: null };
const NAMES = ['nord', 'dracula'];
const previewOf = (name) => ({ title: 'source palette', sample: `${name} swatch` });

function modelWith(overrides = {}) {
  return customizePanelModel({
    sidebar: 'on',
    moshi: 'off',
    theme: THEME_OFF,
    themeNames: NAMES,
    themePreview: previewOf,
    ...overrides,
  });
}

function open({ model, apply, host, rowsAvailable, theme = {} } = {}) {
  const hostTui = host || makeHostTui();
  let settled = 'pending';
  const component = createCustomizePanel({
    helpers: stubTui,
    hostTui: hostTui.tui,
    theme,
    rowsAvailable,
    model: model || modelWith(),
    apply,
    done: (result) => { settled = result; },
  });
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.handleInput, 'function');
  assert.equal(typeof component.handleMouse, 'function');
  assert.equal(typeof component.invalidate, 'function');
  return { component, host: hostTui, done: () => settled };
}

// The exact geometry of a 100-column card: the predicates below reproduce the
// card chrome so a row can be asserted whole instead of by substring.
const WIDTH = 100;
const INNER = WIDTH - 4;
// The left column is sized to fit every category title plus the focus prefix.
const LEFT = 24;
const RIGHT = INNER - LEFT - 3;
// A right-pane setting line: the two-column marker, the name padded to the
// widest setting name, then the inline options.
const NAME = 18;
const setting = (marker, name, body, nameWidth = NAME) => `${marker}${name}${' '.repeat(Math.max(0, nameWidth - name.length))}  ${body}`;
const pad = (text, size) => `${strip(String(text))}${' '.repeat(Math.max(0, size - [...strip(String(text))].length))}`;
const card = (content) => `│ ${pad(content, INNER)} │`;
const row = (left, right) => `│ ${pad(left, LEFT)} │ ${pad(right, RIGHT)} │`;
const frame = (component, width = WIDTH) => component.render(width).map(strip);
const lineWith = (component, needle, width = WIDTH) => {
  const line = frame(component, width).find((entry) => entry.includes(needle));
  assert.ok(line, `no rendered line carries ${needle}`);
  return line;
};

// A pointer event on the rendered line that carries `needle`, at the column
// where that needle starts.
function click(component, width, needle, { type = 'click', boxHeight } = {}) {
  const rendered = component.render(width);
  const lines = boxHeight === undefined ? rendered : rendered.slice(0, boxHeight);
  const y = lines.findIndex((line) => strip(line).includes(needle));
  assert.ok(y >= 0, `no rendered line carries ${needle}`);
  const x = strip(lines[y]).indexOf(needle);
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

// An apply() is awaited behind the busy guard; a test waits for it to settle
// instead of assuming a microtask boundary.
async function settle(component) {
  for (let attempt = 0; attempt < 200 && component.state.busy; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(component.state.busy, false, 'the apply settled');
}

describe('customize panel model', () => {
  test('categories carry settings that carry inline options', () => {
    const model = modelWith();
    assert.deepEqual(model.map((category) => category.id), ['sidebar', 'moshi', 'theme']);
    assert.deepEqual(model.map((category) => category.title), ['Herdr Sidebar', 'Moshi notifications', 'Herdr Theme']);
    assert.deepEqual(model[0].settings.map((setting) => setting.id), ['sidebar']);
    assert.deepEqual(model[0].settings[0].options.map((option) => option.label), ['On', 'Off']);
    assert.deepEqual(model[1].settings.map((setting) => setting.id), ['moshi']);
    assert.deepEqual(model[1].settings[0].options.map((option) => option.label), ['On', 'Off']);
    assert.deepEqual(model[2].settings.map((setting) => setting.id), ['theme-sync', 'theme']);
    assert.deepEqual(model[2].settings[0].options.map((option) => option.label), ['Off', 'On']);
    assert.deepEqual(model[2].settings[1].options.map((option) => option.label), ['None', 'nord', 'dracula']);
    // The stored option is the current one, and exactly one is.
    const current = (setting) => setting.options.filter((option) => option.current === true).map((option) => option.label);
    assert.deepEqual(current(model[0].settings[0]), ['On']);
    assert.deepEqual(current(model[1].settings[0]), ['Off']);
    assert.deepEqual(current(model[2].settings[0]), ['Off']);
    assert.deepEqual(current(model[2].settings[1]), ['None']);
  });

  test('every option carries a preview whose title doubles as its description', () => {
    const model = modelWith();
    for (const category of model) {
      for (const setting of category.settings) {
        for (const option of setting.options) {
          assert.equal(typeof option.preview?.title, 'string', `${setting.id}/${option.id} has a preview title`);
          assert.equal(typeof option.preview?.sample, 'string', `${setting.id}/${option.id} has a preview sample`);
        }
      }
    }
    assert.deepEqual(model[2].settings[1].options[1].preview, { title: 'source palette', sample: 'nord swatch' });
    // Sidebar and Moshi samples are the static kind, named like upstream's
    // animation sample.
    assert.match(model[0].settings[0].options[0].preview.title, /static .* sample/);
    assert.match(model[1].settings[0].options[1].preview.title, /static .* sample/);
  });

  test('option ids are structural: a theme named None or Off stays selectable', () => {
    const model = modelWith({ theme: { ok: true, sync: false, theme: 'None' }, themeNames: ['None', 'Off', 'nord'] });
    const setting = model[2].settings[1];
    assert.deepEqual(setting.options.map((option) => option.id), ['none', 'theme:None', 'theme:Off', 'theme:nord']);
    assert.deepEqual(setting.options.map((option) => option.label), ['None', 'None', 'Off', 'nord']);
    assert.deepEqual(setting.options.filter((option) => option.current).map((option) => option.id), ['theme:None']);
  });

  test('an unknown sidebar state marks no option current and says so', () => {
    const model = modelWith({ sidebar: 'unknown' });
    const setting = model[0].settings[0];
    assert.deepEqual(setting.options.map((option) => option.current), [false, false]);
    assert.match(setting.note, /state unknown/);
  });

  test('an unreadable theme store marks no option current and says so', () => {
    const model = modelWith({ theme: { ok: false, sync: false, theme: null, error: 'cannot parse x: bad json' } });
    assert.deepEqual(model[2].settings[0].options.map((option) => option.current), [false, false]);
    assert.match(model[2].settings[0].note, /state unknown/);
    assert.deepEqual(model[2].settings[1].options.map((option) => option.current), [false, false, false]);
    assert.match(model[2].settings[1].note, /state unknown/);
  });

  test('an unreadable theme preview is no preview at all, never the active theme', () => {
    const model = modelWith({
      themePreview: (name) => {
        if (name === 'dracula') throw new Error('Selected theme is unavailable.');
        return { title: 'source palette', sample: `${name} swatch` };
      },
    });
    const options = model[2].settings[1].options;
    assert.deepEqual(options[1].preview, { title: 'source palette', sample: 'nord swatch' });
    assert.equal(options[2].preview, null);
  });

  test('an unavailable theme list is one note and no options', () => {
    const model = customizePanelModel({ sidebar: 'on', moshi: 'off', theme: THEME_OFF, themeNames: null });
    const setting = model[2].settings[1];
    assert.deepEqual(setting.options, []);
    assert.equal(setting.note, 'Themes unavailable; use Pi /settings');
  });

  test('a stored sync On marks the theme setting unavailable while keeping its rows', () => {
    const model = modelWith({ theme: { ok: true, sync: true, theme: 'dracula' } });
    const setting = model[2].settings[1];
    // The model still carries the picker (the Gentle Shell page keeps its
    // mounted rows and hides them with `visible()`, so the picker returns in
    // place); the PANEL is where it is not offered — see the theme gate block.
    assert.equal(setting.disabled, true);
    assert.deepEqual(setting.options.filter((option) => option.current).map((option) => option.id), ['theme:dracula']);
    assert.equal(model[2].settings[0].options.find((option) => option.current).label, 'On');
  });
});

describe('customize panel render', () => {
  test('renders the Gentle Shell card: one line per setting, options inline', () => {
    const { component } = open();
    const lines = frame(component);
    assert.equal(lines[0], `╭${'─'.repeat(INNER + 2)}╮`);
    assert.equal(lines[1], card(`${TITLE}${' '.repeat(INNER - TITLE.length - 3)}esc`));
    assert.equal(lines[2], row('CATEGORIES', 'Herdr Sidebar · 1/1'));
    assert.equal(lines[3], card(''));
    assert.equal(lines[4], row('▸ Herdr Sidebar', '▸ Sidebar agent rows  ● On  ○ Off'));
    assert.equal(lines[23], `╰${'─'.repeat(INNER + 2)}╯`);
    // The fixed `● On  ○ Off` button pair is gone: the line is ONE setting with
    // its options inline, and nothing toggles on navigation.
    for (const gone of ['Plugin tools', 'Worktree tools', 'Reset every option', 'Enter toggle', 'j/k']) {
      assert.equal(lines.join('\n').includes(gone), false, `removed copy still rendered: ${gone}`);
    }
  });

  test('the footer legend carries the Click prefix', () => {
    const { component } = open();
    assert.equal(frame(component)[22], card(FOOTER));
    assert.ok(frame(component)[22].includes('Click · '));
  });

  // Upstream's footerHint names what the keys do right now. Showing the pane
  // legend while an option row owns the focus told the user the arrows switch
  // panes, when they actually move the option cursor and only Enter applies.
  test('the footer names what the keys do now: panes, choose and categories', () => {
    const { component } = open();
    assert.equal(frame(component)[22], card(FOOTER), 'categories pane keeps the pane legend');
    component.handleInput('right');
    assert.equal(
      frame(component)[22],
      card('Click · ←/→ choose · Enter apply · ↑/↓ settings · Tab panes · Esc close'),
      'a focused option row reads choose',
    );
    component.handleInput('tab');
    assert.equal(frame(component)[22], card(FOOTER), 'back on the categories pane the pane legend returns');
  });

  test('a card too narrow to list settings opens categories with the right arrow', () => {
    const { component } = open();
    const narrow = frame(component, 50);
    assert.ok(
      narrow[narrow.length - 2].includes('Click · ↑/↓ categories · → open · Esc close'),
      `narrow footer was: ${narrow[narrow.length - 2]}`,
    );
  });

  test('the category pane carries the focus band and the values pane only when it owns the focus', () => {
    const { component } = open({ theme: bandTheme });
    const opening = frame(component);
    assert.ok(opening[4].includes('[  Herdr Sidebar'), 'the category cursor owns the band first');
    assert.equal(opening[4].includes('[▸ Sidebar agent rows'), false, 'the setting line has no band yet');
    assert.ok(opening[4].includes('▸ Sidebar agent rows'), 'but it still marks the line Enter would use');
    component.handleInput('right');
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('[▸ Sidebar agent rows  ● On  ○ Off'));
    assert.equal(lineWith(component, 'Herdr Sidebar ·').includes('[  Herdr Sidebar'), false, 'the categories gave the band up');
  });

  test('the Herdr Theme category renders both settings with the theme list inline', () => {
    const { component } = open();
    component.handleInput('down');
    component.handleInput('down');
    component.handleInput('right');
    const lines = frame(component);
    assert.equal(lines[2], row('CATEGORIES', 'Herdr Theme · 1/2'));
    assert.equal(
      lineWith(component, 'Theme sync'),
      row('  Herdr Sidebar', setting('▸ ', 'Theme sync', '● Off  ○ On')),
    );
    assert.equal(
      lineWith(component, 'Gentle Shell theme'),
      row('  Moshi notifications', setting('  ', 'Gentle Shell theme', '● None  ○ nord  ○ dracula')),
    );
  });

  test('an unavailable theme list renders its note under the setting', () => {
    const { component } = open({ model: customizePanelModel({ sidebar: 'on', moshi: 'off', theme: THEME_OFF }) });
    component.handleInput('down');
    component.handleInput('down');
    component.handleInput('right');
    component.handleInput('down');
    const seen = frame(component).join('\n');
    assert.ok(seen.includes('Themes unavailable; use Pi /settings'));
  });

  test('a hostile theme degrades to plain text', () => {
    const hostile = {
      fg: () => { throw new Error('no colours'); },
      bg: () => { throw new Error('no background'); },
      bold: () => { throw new Error('no weight'); },
    };
    const { component } = open({ theme: hostile });
    const seen = frame(component).join('\n');
    assert.ok(seen.includes(TITLE));
    assert.ok(seen.includes('Sidebar agent rows  ● On  ○ Off'));
    assert.ok(seen.includes('Moshi notifications'));
  });
});

describe('customize panel focus and keys', () => {
  test('the cursor lands on the stored option when a setting takes the focus', () => {
    const { component } = open();
    component.handleInput('right');
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('● On'));
    // ↓/↓ in the categories reaches the theme category, → opens its settings
    // (landing on Theme sync) and ↓ reaches the theme list.
    component.handleInput('tab');
    component.handleInput('down');
    component.handleInput('down');
    component.handleInput('right');
    assert.ok(lineWith(component, 'Theme sync').includes('● Off'));
    component.handleInput('down');
    assert.ok(lineWith(component, 'Gentle Shell theme').includes('● None'));
  });

  test('←/→ move the cursor inside the setting and never apply', async () => {
    const calls = [];
    const { component, done } = open({ apply: async (request) => { calls.push(request); return {}; } });
    component.handleInput('right');
    component.handleInput('right');
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('● On  › Off'));
    component.handleInput('left');
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('● On  ○ Off'));
    component.handleInput('right');
    component.handleInput('left');
    await settle(component);
    assert.deepEqual(calls, [], 'moving never applies');
    assert.equal(done(), 'pending');
  });

  test('stepping left past the first option returns to the categories', () => {
    const { component } = open();
    component.handleInput('right');
    assert.equal(component.state.pane, 'controls');
    // The cursor is on the first option (the stored On): ← leaves the pane.
    component.handleInput('left');
    assert.equal(component.state.pane, 'categories');
  });

  test('Tab switches panes like ←/→', () => {
    const { component } = open();
    component.handleInput('tab');
    assert.equal(component.state.pane, 'controls');
    component.handleInput('tab');
    assert.equal(component.state.pane, 'categories');
    component.handleInput('right');
    assert.equal(component.state.pane, 'controls');
  });

  test('↓/j moves between settings and wraps, ↑/k backwards', () => {
    const { component } = open();
    component.handleInput('down');
    assert.ok(frame(component).join('\n').includes('▸ Moshi notifications'));
    component.handleInput('j');
    assert.ok(frame(component).join('\n').includes('▸ Herdr Theme'));
    component.handleInput('j');
    assert.ok(frame(component).join('\n').includes('▸ Herdr Sidebar'));
    component.handleInput('k');
    assert.ok(frame(component).join('\n').includes('▸ Herdr Theme'));
  });

  test('Enter applies the cursored option and the panel stays open', async () => {
    const calls = [];
    const next = modelWith({ sidebar: 'off' });
    const { component, done } = open({
      apply: async (request) => { calls.push(request); return { model: next }; },
    });
    component.handleInput('right');
    component.handleInput('right');
    component.handleInput('enter');
    await settle(component);
    assert.deepEqual(calls, [{ categoryId: 'sidebar', settingId: 'sidebar', optionId: 'off' }]);
    assert.equal(done(), 'pending', 'Enter confirms the option, it does not close the overlay');
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('○ On  ● Off'), 'the panel re-read the new state');
  });

  test('Enter in the categories pane opens the controls instead of applying', async () => {
    const calls = [];
    const { component } = open({ apply: async (request) => { calls.push(request); return {}; } });
    component.handleInput('enter');
    assert.equal(component.state.pane, 'controls');
    await settle(component);
    assert.deepEqual(calls, []);
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
    const before = frame(component).join('\n');
    component.handleInput('release');
    assert.equal(host.paints.length, 0);
    assert.equal(frame(component).join('\n'), before);
    assert.equal(done(), 'pending');
  });
});

describe('customize panel apply flow', () => {
  test('the returned model replaces the current one with the cursor kept by ids', async () => {
    const next = modelWith({ sidebar: 'off', moshi: 'on' });
    const { component } = open({ apply: async () => ({ model: next }) });
    component.handleInput('right');
    component.handleInput('right');
    component.handleInput('enter');
    await settle(component);
    // The cursor stayed on the option it applied (`off`), which is now current.
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('● Off'));
    // And the Moshi category reads the state the new model carries.
    component.handleInput('tab');
    component.handleInput('down');
    component.handleInput('tab');
    assert.ok(lineWith(component, 'Notifications').includes('● On  ○ Off'));
  });

  test('a second Enter while apply is in flight does nothing', async () => {
    const calls = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { component, done } = open({
      apply: (request) => { calls.push(request); return gate; },
    });
    component.handleInput('right');
    component.handleInput('right');
    component.handleInput('enter');
    component.handleInput('enter');
    component.handleInput('enter');
    await Promise.resolve();
    assert.equal(calls.length, 1, 'the busy guard swallowed the repeat presses');
    assert.equal(done(), 'pending');
    release({ model: modelWith({ sidebar: 'off' }) });
    await settle(component);
    assert.equal(calls.length, 1);
  });

  test('a close result finishes the panel with null', async () => {
    const { component, done } = open({ apply: async () => ({ close: true }) });
    component.handleInput('right');
    component.handleInput('enter');
    await settle(component);
    assert.equal(done(), null);
  });

  test('a throwing apply leaves the panel open and the model untouched', async () => {
    const { component, done, host } = open({ apply: async () => { throw new Error('nope'); } });
    component.handleInput('right');
    component.handleInput('enter');
    await settle(component);
    assert.equal(done(), 'pending');
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('● On'));
    assert.ok(host.paints.length >= 1, 'the panel repaints after the failure');
  });

  test('a panel without apply still navigates but never writes', async () => {
    const { component, done } = open();
    component.handleInput('right');
    component.handleInput('enter');
    assert.equal(done(), 'pending');
    assert.ok(lineWith(component, 'Sidebar agent rows').includes('● On'));
  });
});

describe('customize panel mouse', () => {
  test('a click on an option applies exactly that option', async () => {
    const calls = [];
    const { component, done } = open({ apply: async (request) => { calls.push(request); return {}; } });
    const result = click(component, WIDTH, '○ Off');
    assert.deepEqual(result, { handled: true, render: true, focus: true });
    await settle(component);
    assert.deepEqual(calls, [{ categoryId: 'sidebar', settingId: 'sidebar', optionId: 'off' }]);
    assert.equal(done(), 'pending', 'a click applies without closing');
  });

  test('a click on the setting name only moves the focus', async () => {
    const calls = [];
    const { component, done } = open({ apply: async (request) => { calls.push(request); return {}; } });
    click(component, WIDTH, 'Moshi notifications');
    assert.equal(component.state.pane, 'categories', 'selecting a category does not enter the controls');
    assert.ok(frame(component).join('\n').includes('▸ Moshi notifications'));
    click(component, WIDTH, 'Notifications');
    assert.equal(component.state.pane, 'controls');
    assert.ok(frame(component).join('\n').includes('▸ Notifications'));
    await settle(component);
    assert.deepEqual(calls, []);
    assert.equal(done(), 'pending');
  });

  test('a click on a category selects it', () => {
    const { component, done } = open();
    assert.deepEqual(click(component, WIDTH, 'Moshi notifications'), { handled: true, render: true, focus: true });
    assert.ok(frame(component).join('\n').includes('▸ Moshi notifications'));
    assert.ok(frame(component).join('\n').includes('Moshi notifications · 1/1'));
    assert.equal(done(), 'pending');
  });

  test('a press only captures the gesture; the click applies', async () => {
    const calls = [];
    const { component, done } = open({ apply: async (request) => { calls.push(request); return {}; } });
    assert.deepEqual(click(component, WIDTH, '○ Off', { type: 'press' }), { handled: true, capture: true, render: false });
    await settle(component);
    assert.deepEqual(calls, [], 'a drag that never becomes a click applies nothing');
    click(component, WIDTH, '○ Off');
    await settle(component);
    assert.deepEqual(calls, [{ categoryId: 'sidebar', settingId: 'sidebar', optionId: 'off' }]);
    assert.equal(done(), 'pending');
  });

  test('a click outside the panes is ignored', () => {
    const { component, done } = open();
    const lines = frame(component);
    const base = { button: 'left', width: WIDTH, height: lines.length, shift: false, alt: false, ctrl: false };
    assert.equal(component.handleMouse({ ...base, type: 'click', x: 5, y: 0 }), undefined, 'the top border');
    assert.equal(component.handleMouse({ ...base, type: 'click', x: 5, y: 1 }), undefined, 'the title row');
    assert.equal(component.handleMouse({ ...base, type: 'click', x: 5, y: lines.length - 1 }), undefined, 'the bottom border');
    assert.equal(done(), 'pending');
  });

  test('a click that misses every hit target is ignored', () => {
    const { component } = open();
    const lines = frame(component);
    const y = lines.findIndex((line) => line.includes('Sidebar agent rows'));
    const x = lines[y].indexOf('Sidebar agent rows');
    const base = { x, y, width: WIDTH, height: lines.length, shift: false, alt: false, ctrl: false };
    assert.equal(component.handleMouse({ ...base, type: 'click', button: 'right' }), undefined);
    assert.equal(component.handleMouse({ ...base, type: 'wheel', button: 'left' }), undefined);
  });
});

describe('customize panel overflow', () => {
  // 32 installed themes, from a short-name family: the point of this block is
  // the sideways window, not the width of a real theme name.
  const MANY = Array.from({ length: 32 }, (_, index) => String(index).padStart(2, '0'));
  const manyModel = () => modelWith({ themeNames: MANY });

  function focusThemeSetting(component) {
    component.handleInput('down');
    component.handleInput('down');
    component.handleInput('right');
    component.handleInput('down');
  }

  // The cursor option is visible when the line prints it whole (window or plain
  // form) or, in the compact form, when the value between its arrows is an
  // ellipsized prefix of that same option. It is never another option's value.
  function cursorVisible(line, label) {
    if (line.includes(`› ${label}`) || line.includes(`● ${label}`)) return true;
    const at = line.indexOf('‹ ');
    if (at < 0) return false;
    const start = at + 2;
    const end = line.indexOf(' ›', start);
    if (end < 0) return false;
    const shown = line.slice(start, end);
    if (shown === '') return false;
    // A card this narrow may cut the counter off the tail of the line; the value
    // between the arrows is still the cursor option's own value.
    const prefix = shown.replace(/…$/, '');
    return prefix !== '' && label.startsWith(prefix);
  }

  for (const width of [100, 80, 60, 40]) {
    test(`the window always contains the cursor option at ${width} columns`, () => {
      const { component } = open({ model: manyModel() });
      focusThemeSetting(component);
      let cursor = 0;
      for (let step = 0; step <= MANY.length; step += 1) {
        const line = lineWith(component, 'Gentle Shell theme', width);
        const label = cursor === 0 ? 'None' : MANY[cursor - 1];
        assert.ok(
          cursorVisible(line, label),
          `cursor option ${label} is what the card shows at ${width} columns (cursor ${cursor}): ${line}`,
        );
        assert.equal([...line].length, width, `the line is exactly ${width} columns`);
        component.handleInput('right');
        if (step < MANY.length) cursor += 1;
      }
    });
  }

  test('a window hidden on both sides shows muted arrows and the n/m counter', () => {
    const { component } = open({ model: manyModel() });
    focusThemeSetting(component);
    // The cursor starts on `None` with everything hidden to its right.
    const first = lineWith(component, 'Gentle Shell theme');
    assert.ok(first.includes('● None'));
    assert.equal(first.includes('‹'), false, 'nothing is hidden on the left yet');
    assert.ok(first.includes('›'), 'an arrow marks the hidden options on the right');
    assert.ok(first.includes('1/33'));
    // Walk into the middle: both sides are hidden.
    for (let step = 0; step < 10; step += 1) component.handleInput('right');
    const middle = lineWith(component, 'Gentle Shell theme');
    assert.ok(middle.includes('‹'), 'the left side is hidden');
    assert.ok(middle.includes('›'), 'the right side is hidden');
    assert.ok(middle.includes('11/33'));
  });

  test('options too wide for even one window fall back to the compact form', () => {
    const LONG = 'a'.repeat(39);
    const model = modelWith({ themeNames: [LONG, 'b'.repeat(39)] });
    const { component } = open({ model });
    focusThemeSetting(component);
    component.handleInput('right');
    const line = lineWith(component, 'Gentle Shell theme');
    assert.ok(line.includes(`‹ ${LONG} ›`), 'the upstream compact form');
    assert.ok(line.includes('2/3'));
    assert.equal(line.includes(`› ${LONG}`), false, 'the window marker form is gone');
  });

  test('a partial option value is never printed: a still-too-wide value is ellipsized inside its arrows', () => {
    const HUGE = 'z'.repeat(200);
    const model = modelWith({ themeNames: [HUGE] });
    const { component } = open({ model });
    focusThemeSetting(component);
    component.handleInput('right');
    const line = lineWith(component, 'Gentle Shell theme', 40);
    assert.ok(line.includes('‹ z'), 'the compact form still names the cursor option');
    assert.ok(line.includes('…'), 'the cut value ends in an ellipsis');
    assert.ok(line.includes('›'));
    assert.ok(line.includes('2/2'));
    assert.equal([...line].length, 40);
  });
});

describe('customize panel preview', () => {
  test('the preview block sits after the content rows at the upstream height', () => {
    const tall = frame(open({ rowsAvailable: () => 24 }).component);
    assert.equal(tall[15], card(''));
    assert.equal(tall[16], card('Preview · On · static sidebar sample'));
    assert.equal(tall[17], card('● project   gentle   worker'));

    const medium = frame(open({ rowsAvailable: () => 12 }).component);
    assert.ok(medium.join('\n').includes('Preview · On · static sidebar sample'));
    // 12 rows: 3 preview lines = spacer, headline and one sample.
    assert.equal(medium[medium.length - 2], card(FOOTER));

    const small = frame(open({ rowsAvailable: () => 9 }).component);
    assert.ok(small.join('\n').includes('Preview omitted · enlarge terminal'));

    const tiny = open({ rowsAvailable: () => 7 });
    assert.equal(frame(tiny.component).join('\n').includes('Preview'), false, 'no preview under the small-height rule');
  });

  test('the headline names the option and its preview title, the sample follows the cursor', () => {
    const { component } = open();
    component.handleInput('down');
    component.handleInput('down');
    component.handleInput('right');
    component.handleInput('down');
    assert.ok(lineWith(component, 'Preview · None · static unassigned sample'));
    component.handleInput('right');
    assert.ok(lineWith(component, 'Preview · nord · source palette'));
    assert.ok(lineWith(component, 'nord swatch'));
    component.handleInput('right');
    assert.ok(lineWith(component, 'Preview · dracula · source palette'));
    assert.ok(lineWith(component, 'dracula swatch'));
  });

  test('the headline paints the accent role and the sample the muted role', () => {
    const recorder = roleTheme();
    const { component } = open({ theme: recorder.theme });
    frame(component);
    const headline = recorder.roles.find(([, text]) => text === 'Preview · On · static sidebar sample');
    assert.deepEqual(headline, ['accent', 'Preview · On · static sidebar sample']);
    const sample = recorder.roles.find(([, text]) => text === '● project   gentle   worker');
    assert.deepEqual(sample, ['muted', '● project   gentle   worker']);
  });

  test('an unreadable preview reads Preview unavailable, never the active theme', () => {
    const { component } = open({
      model: modelWith({
        themePreview: () => { throw new Error('Selected theme is unavailable.'); },
      }),
    });
    component.handleInput('down');
    component.handleInput('down');
    component.handleInput('right');
    component.handleInput('down');
    component.handleInput('right');
    assert.ok(lineWith(component, 'Preview unavailable'));
  });

  test('no separate Category — description row is rendered', () => {
    const { component } = open();
    const seen = frame(component).join('\n');
    for (const gone of ['The managed agent rows this plugin hands', 'Herdr Sidebar —', 'Notifications —']) {
      assert.equal(seen.includes(gone), false, `the removed description row is still rendered: ${gone}`);
    }
  });
});

describe('customize panel narrow and small terminals', () => {
  test('a narrow card shows one pane and reaches every setting', () => {
    const { component } = open();
    const opening = frame(component, 50);
    assert.equal(opening.join('\n').includes('CATEGORIES'), false, 'the left column is gone at 50 columns');
    assert.ok(opening.join('\n').includes('Categories'));
    assert.ok(opening[4].includes('▸ Herdr Sidebar'), 'the focus marker is visible at 50 columns');
    component.handleInput('down');
    assert.ok(frame(component, 50).join('\n').includes('▸ Moshi notifications'));
    component.handleInput('right');
    assert.ok(lineWith(component, 'Notifications', 50).includes('○ On  ● Off'));
    for (const line of frame(component, 50)) assert.equal([...line].length, 50);
  });

  test('the preview disappears on a short card and the card never overflows', () => {
    for (const rows of [4, 5, 6, 7]) {
      const { component } = open({ rowsAvailable: () => rows });
      const lines = frame(component);
      assert.ok(lines.length <= rows, `expected at most ${rows} rows, got ${lines.length}`);
      assert.equal(lines.join('\n').includes('Preview'), false, `no preview at ${rows} rows`);
      assert.ok(lines.join('\n').includes(TITLE), 'the title survives');
    }
  });

  test('at the 60-column breakpoint the two panes are back and the options scroll', () => {
    const seen = frame(open().component, 60).join('\n');
    assert.ok(seen.includes('CATEGORIES'));
    assert.ok(seen.includes('│'), 'the pane divider is visible at 60 columns');
    // At 60 columns the right pane is too narrow for both options on one line,
    // so the stored one stays visible and the hidden one becomes an arrow.
    assert.ok(seen.includes('● On'));
    assert.ok(seen.includes('› 1/2'));
  });
});

describe('customize panel preserved rows', () => {
  // PRESERVE (S10): the sidebar and Moshi rows keep their exact shape while the
  // theme rows gain the inline option list, the preview and the sideways scroll.
  test('the sidebar and Moshi rows render exactly as one line of options', () => {
    const sidebar = open();
    assert.equal(
      lineWith(sidebar.component, 'Sidebar agent rows'),
      row('▸ Herdr Sidebar', setting('▸ ', 'Sidebar agent rows', '● On  ○ Off')),
    );
    const moshi = open({ model: modelWith({ moshi: 'on' }) });
    moshi.component.handleInput('down');
    moshi.component.handleInput('right');
    assert.equal(
      lineWith(moshi.component, 'Notifications'),
      row('  Herdr Sidebar', setting('▸ ', 'Notifications', '● On  ○ Off', 13)),
    );
    const unknown = open({ model: modelWith({ sidebar: 'unknown' }) });
    unknown.component.handleInput('right');
    assert.equal(
      lineWith(unknown.component, 'Sidebar agent rows'),
      row('  Herdr Sidebar', setting('▸ ', 'Sidebar agent rows', '› On  ○ Off')),
    );
  });

  test('a setting the model marks unavailable is never offered, dim or not', () => {
    const model = modelWith({ theme: { ok: true, sync: true, theme: null } });
    const { component } = open({ model, theme: bandTheme });
    component.handleInput('down');
    component.handleInput('down');
    component.handleInput('right');
    const seen = frame(component).join('\n');
    assert.equal(seen.includes('Gentle Shell theme'), false, 'no line, no dim role, no note: simply absent');
    const sync = lineWith(component, 'Theme sync');
    assert.ok(sync.includes('[▸ Theme sync'), 'the actionable setting keeps the band');
  });
});

// Defect 2 (found by using the shipped command): `/herdr-gentle:customize` always
// offered the theme picker while the sync was on, while the Gentle Shell page
// hides it — the pinned theme is only available when the sync is off. The panel
// now behaves the same way: the setting is ABSENT (not dim, not refusing, not a
// note), and it is back the moment the sync is turned off from the panel that is
// already open. Everything else about the card is untouched, which the rest of
// this file guards.
describe('customize panel theme gate (S3, S7)', () => {
  const syncState = (sync, theme = 'dracula') => ({ ok: true, sync, theme });

  test('the theme setting is absent while the stored sync is on, and returns without reopening', async () => {
    const calls = [];
    const apply = async (request) => {
      calls.push(request);
      return { model: modelWith({ theme: syncState(request.optionId === 'on') }) };
    };
    const { component, done } = open({ model: modelWith({ theme: syncState(true) }), apply });
    component.handleInput('down');
    component.handleInput('down');

    let seen = frame(component).join('\n');
    assert.equal(seen.includes('Gentle Shell theme'), false, 'the picker is not offered at all');
    assert.equal(seen.includes('Turn Theme sync off'), false, 'and it is not explained either: it is absent');
    assert.ok(seen.includes('Herdr Theme · 1/1'), 'the category holds only the sync switch');
    assert.equal(frame(component)[1], card(`${TITLE}${' '.repeat(INNER - TITLE.length - 3)}esc`), 'the card chrome is unchanged');

    // Turn the sync off from inside the same panel: the cursor landed on the
    // stored On, so ← reaches Off and Enter applies it.
    component.handleInput('right');
    component.handleInput('left');
    component.handleInput('enter');
    await settle(component);
    assert.deepEqual(calls, [{ categoryId: 'theme', settingId: 'theme-sync', optionId: 'off' }]);

    seen = frame(component).join('\n');
    assert.ok(seen.includes('Gentle Shell theme'), 'the picker is back without closing and reopening');
    assert.ok(seen.includes('Herdr Theme · 1/2'), 'and the category counts it again');
    assert.ok(seen.includes('● dracula'), 'with the pin the store kept');
    assert.equal(done(), 'pending', 'the panel never closed');
  });

  test('turning the sync back on removes the setting from the panel that is open', async () => {
    const calls = [];
    const apply = async (request) => {
      calls.push(request);
      return { model: modelWith({ theme: syncState(request.optionId === 'on') }) };
    };
    const { component, done } = open({ model: modelWith({ theme: syncState(false) }), apply });
    component.handleInput('down');
    component.handleInput('down');
    assert.ok(frame(component).join('\n').includes('Gentle Shell theme'), 'the picker starts offered');

    // Theme sync is the category's first setting and the cursor landed on the
    // stored Off, so → moves to On and Enter applies it.
    component.handleInput('right');
    component.handleInput('right');
    component.handleInput('enter');
    await settle(component);
    assert.deepEqual(calls, [{ categoryId: 'theme', settingId: 'theme-sync', optionId: 'on' }]);

    const seen = frame(component).join('\n');
    assert.equal(seen.includes('Gentle Shell theme'), false, 'the picker is gone from the same panel');
    assert.equal(seen.includes('Turn Theme sync off to pick a specific theme.'), false, 'nothing explains an absent setting');
    assert.ok(seen.includes('Herdr Theme · 1/1'));
    assert.equal(done(), 'pending');
  });
});

// D2 (independent verification on the real host): withholding the theme setting
// removed the widest label from the column computation, so `Off`/`On` jumped
// eight columns left on the panel that was already open. The column comes from
// the category's FULL setting set now — offered or not — so it never moves.
describe('customize panel theme gate — the value column (D2)', () => {
  test('hiding the picker does not move the Theme sync value column', () => {
    const columnOf = (lines) => lines.find((line) => line.includes('▸ Theme sync')).indexOf('Off');
    const linesFor = (sync) => {
      const { component } = open({ model: modelWith({ theme: { ...THEME_OFF, sync } }) });
      for (const key of ['down', 'down', 'right']) component.handleInput(key);
      return component.render(100);
    };
    const off = linesFor(false);
    const on = linesFor(true);
    assert.ok(off.some((line) => line.includes('Gentle Shell theme')), 'the picker is offered with the sync off');
    assert.ok(on.every((line) => !line.includes('Gentle Shell theme')), 'and withheld with the sync on');
    assert.equal(columnOf(on), columnOf(off), 'the sync values keep their column whether the picker is there or not');
  });
});

// S2 (independent verification): the column fix must be durable, not a one-frame
// coincidence. ONE mounted panel, Theme sync cycled Off→On→Off three times, at
// four card widths: the `Off`/`On` columns of the `Theme sync` line are identical
// on every cycle whether the picker is offered or withheld, the picker is absent
// while the sync is on, and it returns when the sync is off. The pinned pairs are
// the verifier's own measurements of this geometry (zero-based), so a future
// column change is a deliberate one.
describe('customize panel theme gate — the column is durable (S2)', () => {
  test('the Theme sync columns never move across three cycles at four widths', async () => {
    const SANITY = { 52: [26, 33], 72: [50, 57], 82: [50, 57], 104: [53, 60] };
    const WIDTHS = Object.keys(SANITY).map(Number);

    let sync = false;
    const apply = async (request) => {
      if (request.settingId === 'theme-sync') sync = request.optionId === 'on';
      return { model: modelWith({ theme: { ...THEME_OFF, sync } }) };
    };
    // ONE panel, mounted once: every navigation below happens on this component.
    const { component } = open({ model: modelWith({ theme: { ...THEME_OFF, sync: false } }), apply });
    for (const key of ['down', 'down', 'right']) component.handleInput(key);

    const seen = {};
    const assertOffered = (width, offered) => {
      const lines = frame(component, width);
      const hasPicker = lines.some((line) => line.includes('Gentle Shell theme'));
      assert.equal(hasPicker, offered, `${width}: the picker is ${offered ? 'offered' : 'withheld'}`);
      const line = lineWith(component, 'Theme sync', width);
      const columns = [line.indexOf('Off'), line.indexOf('On')];
      assert.deepEqual(columns, SANITY[width], `${width}: the measured geometry`);
      if (seen[width]) assert.deepEqual(columns, seen[width], `${width}: the values did not move`);
      seen[width] = columns;
    };

    // The mount starts with the sync off, so the picker is offered.
    for (const width of WIDTHS) assertOffered(width, true);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Cursor landed on the stored Off: → reaches On, Enter turns the sync on.
      component.handleInput('right');
      component.handleInput('enter');
      await settle(component);
      for (const width of WIDTHS) assertOffered(width, false);
      // The cursor stayed on On: ← reaches Off, Enter turns the sync off again.
      component.handleInput('left');
      component.handleInput('enter');
      await settle(component);
      for (const width of WIDTHS) assertOffered(width, true);
    }
    assert.deepEqual(Object.keys(seen).map(Number).sort((left, right) => left - right), WIDTHS, 'every width was checked');
  });
});
