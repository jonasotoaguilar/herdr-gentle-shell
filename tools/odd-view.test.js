'use strict';
// T3/T4 (odd-viewer S3,S4,S6) tests: lib/odd-view.js — the two-pane odd
// viewer component (list on the left, styled document on the right).
//
// Contract under test, as observable output only: the component renders
// exactly the requested rows at the requested width; the left pane lists the
// display names without extension or path; moving the selection swaps the
// right pane and resets its scroll; the right pane scrolls to the last line
// of a long document; an empty checkout, an unreadable document and an empty
// document each render their own state instead of fake content; `esc` closes
// with a null result and mutates nothing; `r` re-lists.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createOddView } = require('../lib/odd-view.js');
const layout = require('../lib/view-layout.js');

function strip(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

const helpers = {
  visibleWidth: (text) => [...strip(text)].length,
  truncateToWidth: (text, width) => {
    const chars = [...String(text)];
    return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : String(text);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

// Optional real host helpers: the extension injects the pi-tui module
// namespace. CI installs no dependencies, so the byte-level assertions run
// only when it resolves; every raw-byte assertion works without it.
let realTui = null;
try {
  realTui = require('@earendil-works/pi-tui');
} catch {
  realTui = null;
}
const cellWidth = (line) => (realTui && typeof realTui.visibleWidth === 'function'
  ? realTui.visibleWidth(line)
  : [...strip(line)].length);

const plainTheme = { fg: (_role, text) => String(text), bg: (_role, text) => String(text) };

function doc(name) {
  return { name, file: `${name}.md`, path: `/checkout/odd/tasks/${name}.md` };
}

function makeView({ docs, load, reloadDocs, rows = 20 } = {}) {
  const paints = [];
  let settled = 'pending';
  const view = createOddView({
    docs,
    loadDoc: load,
    reloadDocs,
    helpers,
    theme: plainTheme,
    rowsAvailable: () => rows,
    requestRender: () => { paints.push(true); },
    done: (result) => { settled = result; },
  });
  return { view, done: () => settled, paints };
}

const longDoc = (lines) => Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n');

describe('createOddView rendering', () => {
  test('renders a framed two-pane view at the requested size with the document names on the left', async () => {
    const { view } = makeView({
      docs: [doc('alpha'), doc('beta')],
      load: () => ({ ok: true, text: '# alpha\n\n## Specs\nS1. first rule\n' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lines = view.render(80);
    assert.equal(lines.length, 20, 'the view fills the available rows');
    for (const line of lines) assert.equal(helpers.visibleWidth(line), 80, `not 80 wide: "${strip(line)}"`);
    const body = strip(lines.join('\n'));
    assert.match(body, /✎ Odd · 2 documents/, 'the title carries the document count');
    assert.match(body, /alpha/, 'the selected document name is listed');
    assert.match(body, /beta/, 'the other document name is listed');
    assert.ok(!body.includes('alpha.md'), 'the extension is not shown in the list');
    assert.ok(!body.includes('/checkout/odd/tasks'), 'no path is shown in the list');
    assert.match(body, /S1\. first rule/, 'the right pane shows the selected document content');
    assert.match(body, /esc close/, 'the footer names the close key');
  });

  test('moving the selection swaps the document and resets its scroll', async () => {
    const contents = { alpha: `# alpha\n${longDoc(80)}`, beta: '# beta\n\nonly beta body\n' };
    const { view } = makeView({
      docs: [doc('alpha'), doc('beta')],
      load: (entry) => ({ ok: true, text: contents[entry.name] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.handleInput('J');
    const scrolled = strip(view.render(80).join('\n'));
    assert.ok(view.state.scroll > 0, 'shift+j scrolls the right pane');
    assert.match(scrolled, /line 1\b/, 'the first line is still on screen right after scrolling one row');
    view.handleInput('down');
    const swapped = strip(view.render(80).join('\n'));
    assert.equal(view.state.index, 1, 'down selects the next document');
    assert.equal(view.state.scroll, 0, 'the scroll resets on the new document');
    assert.match(swapped, /only beta body/, 'the right pane shows the newly selected document');
  });

  test('scrolls to the last line of a long document and back to the top', async () => {
    const total = 120;
    const { view } = makeView({
      docs: [doc('alpha')],
      load: () => ({ ok: true, text: longDoc(total) }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.handleInput('end');
    const bottom = strip(view.render(80).join('\n'));
    assert.match(bottom, /line 120/, 'the last source line is reachable');
    view.handleInput('home');
    assert.equal(view.state.scroll, 0, 'home returns to the top');
    assert.match(strip(view.render(80).join('\n')), /line 1\b/);
  });
});

describe('createOddView states', () => {
  test('a checkout without documents renders its empty state, not an empty frame', async () => {
    const { view } = makeView({ docs: [], load: () => ({ ok: true, text: '' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /✎ Odd · 0 documents/);
    assert.match(body, /no odd documents/i);
    assert.match(body, /odd\/tasks/);
  });

  test('an unreadable document renders its error instead of empty content', async () => {
    const { view } = makeView({
      docs: [doc('alpha')],
      load: () => ({ ok: false, error: 'EACCES: permission denied' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /EACCES: permission denied/);
  });

  test('esc closes with a null result and mutates nothing', async () => {
    const { view, done } = makeView({ docs: [doc('alpha')], load: () => ({ ok: true, text: '# alpha\n' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(done(), 'pending');
    view.handleInput('escape');
    assert.equal(done(), null);
    assert.equal(view.state.index, 0);
    assert.equal(view.state.scroll, 0);
  });

  test('r re-lists through reloadDocs, so a document written while open appears', async () => {
    let current = [doc('alpha')];
    const { view } = makeView({
      docs: current,
      load: (entry) => ({ ok: true, text: `# ${entry.name}\n` }),
      reloadDocs: () => ({ ok: true, docs: current }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(strip(view.render(80).join('\n')), /1 documents/);
    current = [doc('alpha'), doc('gamma')];
    view.handleInput('r');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /2 documents/);
    assert.match(body, /gamma/);
  });
});

// S10b: the odd viewer is read-only with respect to the checkout↔document
// association. The options the existing callers still pass (`assigned`,
// `saveAssignment`, `assignmentEnabled`) are accepted and ignored: no mark,
// no toggle, no save, no unsaved claim — and no key that writes.
describe('createOddView read-only association (S10b)', () => {
  function makeInertView({ docs, rows = 20, ...rest } = {}) {
    const calls = [];
    let settled = 'pending';
    const view = createOddView({
      docs,
      loadDoc: (entry) => ({ ok: true, text: `# ${entry.name}\n` }),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: (result) => { settled = result; },
      ...rest,
      saveAssignment: (...args) => { calls.push(args); return { ok: true }; },
    });
    return { view, calls, done: () => settled };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const ASSIGNED = ['odd/tasks/alpha.md'];
  // The list rows are the cells between the left border and the divider; the
  // title icon (`✎`) and the legend separators (`·`) live outside them.
  const listRows = (body) => body.split('\n').filter((line) => /│ [▸ ] (alpha|beta)( |$)/.test(line));

  test('no association mark renders and the status row carries no assigned or unsaved fact', async () => {
    const { view } = makeInertView({
      docs: [doc('alpha'), doc('beta')],
      assigned: ASSIGNED,
      assignmentEnabled: true,
      checkoutName: 'demo-checkout',
    });
    await tick();
    const body = strip(view.render(80).join('\n'));
    const rows = listRows(body);
    assert.equal(rows.length, 2, 'both documents still list');
    assert.ok(rows.every((line) => !/[✓✎]/.test(line)), 'no association mark on any row');
    assert.match(rows[0], /▸ alpha/, 'the focused row renders unmarked');
    assert.ok(!body.includes('assigned'), 'no assigned count is claimed');
    assert.ok(!body.includes('unsaved'), 'no unsaved indicator exists');
    assert.ok(!body.includes('space toggle'), 'the space toggle leaves the legend');
    assert.ok(!body.includes('ctrl+s'), 'the save key leaves the legend');
    assert.match(body, /shift\+j\/k( scroll)?/, 'the reading keys stay in the legend, naming a usable pair');
    assert.match(body, /esc close/, 'the close key stays in the legend');
  });

  test('space and ctrl+s change nothing: no save call, no state change, no repaint difference', async () => {
    const { view, calls } = makeInertView({ docs: [doc('alpha'), doc('beta')], assigned: ASSIGNED });
    await tick();
    const snapshot = JSON.stringify(view.state);
    const rendered = view.render(80).join('\n');
    for (const key of ['space', ' ', 'ctrl+s', '\x13', 'space', 'ctrl+s']) view.handleInput(key);
    await tick();
    assert.deepEqual(calls, [], 'the injected save callback is never reached');
    assert.equal(JSON.stringify(view.state), snapshot, 'no state changed');
    assert.equal(view.render(80).join('\n'), rendered, 'nothing repainted differently');
  });

  test('the association options are inert: the frame is identical with, without and with the gate off', async () => {
    const docs = [doc('alpha'), doc('beta')];
    const plain = makeInertView({ docs });
    const passed = makeInertView({ docs, assigned: ASSIGNED, assignmentEnabled: true, checkoutName: 'demo-checkout' });
    const gatedOff = makeInertView({ docs, assigned: ASSIGNED, assignmentEnabled: false });
    await tick();
    const expected = plain.view.render(80).join('\n');
    assert.equal(passed.view.render(80).join('\n'), expected, 'assigned/saveAssignment/assignmentEnabled change no cell');
    assert.equal(gatedOff.view.render(80).join('\n'), expected, 'assignmentEnabled false changes no cell either');
  });

  test('the viewer still opens, navigates, filters, scrolls, reloads and closes with the options passed', async () => {
    const long = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n');
    let current = [doc('alpha'), doc('beta')];
    const { view, done } = makeInertView({
      docs: current,
      assigned: ASSIGNED,
      assignmentEnabled: false,
      loadDoc: () => ({ ok: true, text: long }),
      reloadDocs: () => ({ ok: true, docs: current }),
    });
    await tick();
    view.handleInput('down');
    assert.equal(view.state.index, 1, 'navigation still works');
    view.handleInput('up');
    assert.equal(view.state.index, 0, 'navigation still works both ways');
    view.handleInput('T');
    view.handleInput('b');
    view.handleInput('enter');
    const narrowed = strip(view.render(80).join('\n')).split('\n');
    assert.ok(!narrowed.some((line) => /│ [▸ ] alpha *│/.test(line)), 'the filter still narrows the list');
    view.handleInput('/');
    view.handleInput('\x7f');
    view.handleInput('enter');
    const cleared = strip(view.render(80).join('\n')).split('\n');
    assert.ok(cleared.some((line) => /│ [▸ ] alpha *│/.test(line)), 'the filter still clears');
    view.handleInput('J');
    assert.ok(view.state.scroll > 0, 'the preview still scrolls');
    current = [doc('alpha'), doc('beta'), doc('gamma')];
    view.handleInput('r');
    await tick();
    assert.match(strip(view.render(80).join('\n')), /3 documents/, 'reload still re-lists');
    view.handleInput('escape');
    assert.equal(done(), null, 'esc still closes with a null result');
  });

});

describe('createOddView key consistency (K3)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function makeKeyView({ docs, openImpl } = {}) {
    const opened = [];
    let settled = 'pending';
    const open = (...args) => {
      opened.push(args);
      if (typeof openImpl === 'function') return openImpl(...args);
      return { ok: true };
    };
    const view = createOddView({
      docs: docs || [doc('alpha'), doc('beta'), doc('gamma')],
      loadDoc: (entry) => ({ ok: true, text: `# ${entry.name}\n` }),
      openExternal: open,
      helpers,
      theme: plainTheme,
      rowsAvailable: () => 20,
      requestRender: () => {},
      done: (result) => { settled = result; },
    });
    return { view, opened, done: () => settled };
  }

  test('? is inert: no key-help overlay, and esc closes the view directly', async () => {
    const { view, done } = makeKeyView();
    await tick();
    assert.ok(!strip(view.render(80).join('\n')).includes('Keys'), 'no help before ?');
    view.handleInput('?');
    const body = strip(view.render(80).join('\n'));
    assert.ok(!body.includes('Keys'), '? does not open a help overlay');
    assert.ok(!body.includes('? help'), 'the footer does not hint a help key');
    view.handleInput('escape');
    assert.equal(done(), null, 'esc with no overlay closes the view');
  });

  test('T filters the document list by name, live as you type, and leaving the box keeps the filter', async () => {
    const { view } = makeKeyView();
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('l');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /alpha/, 'the matching document stays');
    assert.ok(!body.includes('beta') || body.includes('filter'), 'non-matching rows leave the list');
    const rows = body.split('\n').filter((line) => /│ [▸ ] /.test(line));
    assert.ok(rows.every((line) => !line.includes('beta') && !line.includes('gamma')), 'only the match is listed');
    assert.match(body, / › al/, 'the filter is visible while typing');
    view.handleInput('enter');
    const kept = strip(view.render(80).join('\n'));
    assert.match(kept, /› al( |$)/m, 'leaving the box keeps the filter');
    assert.match(kept, /alpha/);
    const keptRows = kept.split('\n').filter((line) => /[▸ ] [✓·✎] /.test(line));
    assert.ok(keptRows.every((line) => !line.includes('beta') && !line.includes('gamma')), 'the filter still applies after leaving the box');
  });

  test('/ also opens the filter box', async () => {
    const { view } = makeKeyView();
    await tick();
    view.handleInput('/');
    view.handleInput('g');
    view.handleInput('a');
    view.handleInput('m');
    view.handleInput('enter');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /› gam( |$)/m, 'the / filter is kept like the T filter');
    assert.match(body, /gamma/);
    assert.ok(!body.split('\n').filter((line) => /│ [▸ ] /.test(line)).some((line) => line.includes('alpha')), 'alpha is filtered out');
  });

  test('a filter matching nothing renders its empty state instead of a blank frame', async () => {
    const { view } = makeKeyView();
    await tick();
    view.handleInput('T');
    view.handleInput('z');
    view.handleInput('z');
    view.handleInput('z');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /no matches/, 'the empty filter names itself');
    assert.match(body, /› zzz/, 'the query stays visible');
  });

  test('o opens the focused document through the injected opener', async () => {
    const { view, opened } = makeKeyView();
    await tick();
    view.handleInput('down');
    view.handleInput('o');
    await tick();
    assert.equal(opened.length, 1, 'one external open for one o');
    assert.equal(opened[0][0], '/checkout/odd/tasks/beta.md', 'the opener receives the focused absolute path');
    const body = strip(view.render(80).join('\n'));
    assert.ok(!body.includes('open failed'), 'a successful open shows no error');
    assert.equal(view.state.index, 1, 'the selection is untouched');
  });

  test('a failing opener reports the error honestly and keeps the selection', async () => {
    const { view, opened } = makeKeyView({ openImpl: () => ({ ok: false, error: 'spawn ed ENOENT' }) });
    await tick();
    view.handleInput('o');
    await tick();
    assert.equal(opened.length, 1);
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /open failed: spawn ed ENOENT/, 'the failure is shown, never silent');
    assert.equal(view.state.index, 0, 'the selection is untouched');
  });

  test('o with an empty document list does nothing', async () => {
    const { view, opened } = makeKeyView({ docs: [] });
    await tick();
    view.handleInput('o');
    await tick();
    assert.deepEqual(opened, [], 'nothing to open, nothing called');
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /no odd documents/, 'the empty state survives');
  });

  test('the footer names every key the view gained', async () => {
    const { view } = makeKeyView();
    await tick();
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /› Search/, 'the search row is the search widget');
    assert.match(body, /T/, 'the footer names the filter key (S4)');
    assert.match(body, /o open/, 'the footer names the external-open key');
    assert.ok(!body.includes('? help'), 'the footer no longer hints the removed help key');
  });
});

// ---------------------------------------------------------------------------
// warp-usability T4: S13 (scroll), S14 (no help), S23-S27 (search row,
// concise title, frame cells, no top-right esc) and S29 (assignment gate).
// These feed the public render/handleInput/handleMouse surface with the raw
// terminal bytes and wheel events the host emits.
// ---------------------------------------------------------------------------
describe('createOddView warp usability (S13,S14,S23-S27,S29)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const skipReal = realTui ? false : 'requires @earendil-works/pi-tui';
  const body200 = longDoc(200);

  function build({ docs = [doc('alpha'), doc('beta')], rows = 20, load, ...rest } = {}) {
    const paints = [];
    let settled = 'pending';
    const view = createOddView({
      docs,
      loadDoc: load || (() => ({ ok: true, text: body200 })),
      helpers: realTui || helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => { paints.push(true); },
      done: (result) => { settled = result; },
      ...rest,
    });
    return { view, paints, done: () => settled };
  }

  test('the mouse wheel scrolls the preview without touching the selection', { skip: skipReal }, async () => {
    const { view } = build();
    view.render(80);
    assert.equal(typeof view.handleMouse, 'function', 'the view accepts host mouse events');
    assert.equal(view.state.scroll, 0);
    view.handleMouse({ type: 'wheel', button: 'none', x: 60, y: 10, screenX: 60, screenY: 10, width: 80, height: 20, shift: false, alt: false, ctrl: false, wheelDelta: 4 });
    assert.equal(view.state.scroll, 4, 'a down wheel moves the preview down');
    assert.equal(view.state.index, 0, 'the wheel never moves the list selection');
    view.handleMouse({ type: 'wheel', wheelDelta: -2 });
    assert.equal(view.state.scroll, 2, 'an up wheel moves the preview back up');
    view.handleMouse({ type: 'wheel', wheelDelta: -50 });
    assert.equal(view.state.scroll, 0, 'the top bound clamps');
    view.handleMouse({ type: 'wheel', wheelDelta: 1e6 });
    const bottom = view.state.scroll;
    assert.ok(bottom > 0, 'a huge down wheel reaches the bottom page');
    view.handleMouse({ type: 'wheel', wheelDelta: 1e6 });
    assert.equal(view.state.scroll, bottom, 'the bottom bound clamps');
    view.handleMouse({ type: 'wheel', wheelDelta: -1 });
    assert.equal(view.state.scroll, bottom - 1, 'the preview scrolls back from the bottom');
  });

  test('SGR wheel bytes scroll the preview through handleInput', () => {
    const { view } = build();
    view.render(80);
    view.handleInput('\x1b[<65;60;10M');
    assert.equal(view.state.scroll, 1, 'SGR wheel down scrolls the preview');
    view.handleInput('\x1b[<65;60;10M');
    assert.equal(view.state.scroll, 2);
    view.handleInput('\x1b[<64;60;10M');
    assert.equal(view.state.scroll, 1, 'SGR wheel up scrolls back');
    assert.equal(view.state.index, 0, 'wheel bytes never move the list selection');
  });

  test('raw scroll bytes drive the preview with no helpers (never a dead preview)', () => {
    const { view } = build({ helpers: null });
    view.render(80);
    view.handleInput('\n');            // Enter, and the legacy ctrl+j byte
    assert.equal(view.state.scroll, 0, 'bare LF never scrolls: it is Enter');
    view.handleInput('\x0b');          // legacy ctrl+k byte
    assert.equal(view.state.scroll, 0, 'the old ctrl+k byte no longer scrolls');
    view.handleInput('\x1b[106;6u');   // CSI-u ctrl+shift+j
    assert.ok(view.state.scroll > 0, 'raw ctrl+shift+j scrolls down');
    const pressed = view.state.scroll;
    view.handleInput('\x1b[106;6:3u'); // the release of the same key
    assert.equal(view.state.scroll, pressed, 'a key release never scrolls');
    view.handleInput('\x1b[107;6u');   // CSI-u ctrl+shift+k
    assert.equal(view.state.scroll, 0, 'raw ctrl+shift+k scrolls back up');
    view.handleInput('\x1b[6~');       // PageDown
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'raw PageDown scrolls a page');
    view.handleInput('\x1b[5~');       // PageUp
    assert.equal(view.state.scroll, 0, 'raw PageUp scrolls the page back');
    view.handleInput('\x1b[F');        // End
    assert.ok(view.state.scroll > 0, 'raw End reaches the bottom');
    view.handleInput('\x1b[H');        // Home
    assert.equal(view.state.scroll, 0, 'raw Home returns to the top');
    assert.equal(view.state.index, 0, 'scroll keys never move the list selection');
    view.handleInput('\x1b[B');        // Down moves the list, not the preview
    assert.equal(view.state.index, 1, 'raw Down moves the selection');
    assert.equal(view.state.scroll, 0, 'the scroll resets on the new document');
  });

  test('the real host keyboard bytes scroll the preview and keep the selection separate', { skip: skipReal }, () => {
    const { view } = build();
    view.render(80);
    view.handleInput('\n');     // a newline: Enter, and the legacy ctrl+j byte
    assert.equal(view.state.scroll, 0, 'the host calls this byte enter, so it never scrolls');
    view.handleInput('\x0b');   // the legacy ctrl+k byte
    assert.equal(view.state.scroll, 0, 'the host calls this byte ctrl+k, not a scroll key');
    view.handleInput('\x1b[106;6u'); // Kitty ctrl+shift+j
    assert.ok(view.state.scroll > 0, 'ctrl+shift+j scrolls through the real matcher');
    view.handleInput('\x1b[6~'); // PageDown
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'PageDown scrolls a page');
    view.handleInput('\x1b[5~'); // PageUp
    assert.ok(view.state.scroll < paged, 'PageUp scrolls the page back');
    view.handleInput('\x1b[F');  // End
    assert.ok(view.state.scroll > 0, 'End reaches the bottom');
    view.handleInput('\x1b[H');  // Home
    assert.equal(view.state.scroll, 0, 'Home returns to the top');
    assert.equal(view.state.index, 0, 'no scroll key moved the list selection');
    view.handleInput('\x1b[B');
    assert.equal(view.state.index, 1, 'Down still moves the list selection');
  });

  // S1: the full-page pair is the shifted one the user asked for — ctrl+shift+
  // j/k through the extended protocol, and the printable J/K fallback on a
  // legacy terminal — while ctrl+d/ctrl+u stay the distinct half-page shortcut.
  test('S1: ctrl+shift+j/k and shifted J/K page the preview, j/k still move the list', { skip: skipReal }, () => {
    const { view } = build();
    view.render(80);
    view.handleInput('\x1b[6~');            // PageDown: the full-page step
    const paged = view.state.scroll;
    view.handleInput('\x1b[H');
    assert.equal(view.state.scroll, 0, 'home returns to the top first');
    view.handleInput('\x04');               // ctrl+d
    const half = view.state.scroll;
    assert.ok(half > 0, 'raw ctrl+d scrolls the preview down');
    assert.ok(half < paged, 'ctrl+d moves half a page, less than PageDown');
    assert.equal(view.state.index, 0, 'ctrl+d never moves the list selection');
    view.handleInput('\x15');               // ctrl+u
    assert.equal(view.state.scroll, 0, 'raw ctrl+u scrolls the preview back up');
    view.handleInput('\x1b[100;5u');        // Kitty ctrl+d
    assert.ok(view.state.scroll > 0, 'Kitty ctrl+d scrolls the preview down');
    view.handleInput('\x1b[117;5u');        // Kitty ctrl+u
    assert.equal(view.state.scroll, 0, 'Kitty ctrl+u scrolls the preview back up');
    view.handleInput('K');                  // shifted K pages up
    view.handleInput('\x04');
    view.handleInput('K');
    assert.equal(view.state.scroll, 0, 'K pages the preview back up');
    view.handleInput('J');                  // shifted J pages down
    assert.equal(view.state.scroll, paged, 'J pages exactly what PageDown pages');
    assert.equal(view.state.index, 0, 'J never moves the list selection');
    view.handleInput('\x1b[H');
    view.handleInput('\x1b[106;6u');        // Kitty ctrl+shift+j
    assert.equal(view.state.scroll, paged, 'ctrl+shift+j pages exactly what PageDown pages');
    view.handleInput('\x1b[107;6u');        // Kitty ctrl+shift+k
    assert.equal(view.state.scroll, 0, 'ctrl+shift+k pages back up');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'j still moves the list selection');
    assert.equal(view.state.scroll, 0, 'j never scrolls the preview');
    view.handleInput('k');
    assert.equal(view.state.index, 0, 'k still moves the list selection');
    view.handleInput('\x1b[6~');
    assert.equal(view.state.scroll, paged, 'PageDown still scrolls a full page');
    view.handleInput('\x1b[5~');
    assert.equal(view.state.scroll, 0, 'PageUp still scrolls the page back');
  });

  test('S15: the half-page and fallback keys also work with no helpers injected', () => {
    const { view } = build({ helpers: null });
    view.render(80);
    view.handleInput('\x04');
    const half = view.state.scroll;
    assert.ok(half > 0, 'raw ctrl+d scrolls with no helpers');
    view.handleInput('\x15');
    assert.equal(view.state.scroll, 0, 'raw ctrl+u scrolls back with no helpers');
    view.handleInput('\x04');
    view.handleInput('K');
    assert.equal(view.state.scroll, 0, 'K pages back up with no helpers');
    view.handleInput('J');
    assert.ok(view.state.scroll > half, 'J pages a full page with no helpers, more than ctrl+d');
    assert.equal(view.state.index, 0, 'J never moves the list selection without helpers');
    view.handleInput('\x1b[100;5u');        // Kitty ctrl+d
    const kittyDown = view.state.scroll;
    assert.ok(kittyDown > half, 'Kitty ctrl+d scrolls further down with no helpers');
    view.handleInput('\x1b[117;5u');        // Kitty ctrl+u
    assert.ok(view.state.scroll < kittyDown, 'Kitty ctrl+u scrolls back with no helpers');
    view.handleInput('\x1b[H');
    view.handleInput('j');
    assert.equal(view.state.index, 1, 'j still moves the list selection without helpers');
  });

  test('the scroll keys repaint without writing anything', { skip: skipReal }, async () => {
    const calls = [];
    const { view, paints } = build({ saveAssignment: (...args) => { calls.push(args); return { ok: true }; } });
    view.render(80);
    const before = paints.length;
    view.handleInput('\x1b[6~');
    assert.ok(paints.length > before, 'scrolling requests a repaint');
    assert.deepEqual(calls, [], 'scrolling never calls the save callback');
  });

  test('? no longer opens a key-help overlay and the footer never hints it', () => {
    const { view } = build();
    view.handleInput('?');
    const body = strip(view.render(80).join('\n'));
    assert.ok(!body.includes('Keys'), 'no help overlay');
    assert.ok(!body.includes('? help'), 'no ? hint in the footer');
    assert.ok(!/\?/.test(body), 'no bare ? anywhere in the frame');
  });

  test('the title carries only the viewer name and the document count', () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta')], checkoutName: 'demo-checkout' });
    const lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[0]), /✎ Odd · 2 documents/);
    assert.ok(!lines[0].includes('demo-checkout'), 'no checkout/worktree name in the title');
    assert.ok(!lines[0].includes('alpha'), 'no selected document in the title');
    assert.ok(!lines[0].includes('esc'), 'no top-right esc in the frame');
    assert.ok(!strip(lines.join('\n')).includes('demo-checkout'), 'the checkout name is gone from the whole frame');
  });

  test('the search row sits directly below the title and carries the query and the position marks', () => {
    const { view } = build();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('l');
    let lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al█/, 'typing shows the live query on its own row');
    assert.ok(!strip(lines[0]).includes('1/2'), 'the count is not buried in the title');
    view.handleInput('enter');
    lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al( |$)/m, 'leaving the box keeps the query visible');
    view.handleInput('/');
    lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al█/, '/ edits the same row');
  });

  test('the frame fills every cell with aligned corners and no top-right esc at 80x24 and 160x40', () => {
    for (const [width, rows] of [[80, 24], [160, 40]]) {
      const { view } = build({ rows });
      const lines = view.render(width);
      assert.equal(lines.length, rows, `${width}x${rows}: the view fills the rows`);
      lines.forEach((line, at) => {
        assert.equal(cellWidth(line), width, `${width}x${rows} row ${at} is ${width} cells: "${line}"`);
      });
      const plain = strip(lines.join('\n')).split('\n');
      assert.equal(plain[0][0], '╭', 'top-left corner');
      assert.equal(plain[0][width - 1], '╮', 'top-right corner in the last cell');
      assert.equal(plain[rows - 1][0], '╰', 'bottom-left corner');
      assert.equal(plain[rows - 1][width - 1], '╯', 'bottom-right corner in the last cell');
      for (let at = 1; at < rows - 1; at += 1) {
        assert.equal(plain[at][0], '│', `row ${at} left border`);
        assert.equal(plain[at][width - 1], '│', `row ${at} right border in the last cell`);
      }
      assert.ok(!plain.slice(0, 4).join('').includes('esc'), 'no top-right esc text');
    }
  });

  test('the preview shows the start, a middle page and the end at 80x24 and 160x40 with the query row visible', () => {
    for (const [width, rows] of [[80, 24], [160, 40]]) {
      const { view } = build({ rows });
      let body = strip(view.render(width).join('\n'));
      assert.equal(view.state.scroll, 0, `${width}x${rows}: the start is the top`);
      assert.match(body, /line 1\b/, `${width}x${rows}: the first source line is visible at the start`);
      assert.match(body.split('\n')[1], /› Search/, `${width}x${rows}: the query row is visible`);
      view.handleInput('\x1b[6~');
      body = strip(view.render(width).join('\n'));
      assert.ok(view.state.scroll > 0, `${width}x${rows}: PageDown reaches a middle window`);
      assert.ok(!/\bline 1\b/.test(body), `${width}x${rows}: the start left the middle window`);
      assert.ok(!/\bline 200\b/.test(body), `${width}x${rows}: the end is not yet visible in the middle window`);
      view.handleInput('\x1b[F');
      body = strip(view.render(width).join('\n'));
      assert.match(body, /\bline 200\b/, `${width}x${rows}: End reaches the last source line`);
      assert.ok(!/\bline 1\b/.test(body), `${width}x${rows}: the start left the end window`);
      view.handleInput('\x1b[H');
      body = strip(view.render(width).join('\n'));
      assert.equal(view.state.scroll, 0, `${width}x${rows}: Home returns to the top`);
      assert.match(body, /line 1\b/, `${width}x${rows}: the start is visible again`);
    }
  });

  test('the inherited name filter stays case-insensitive and keeps the selection inside the visible list', () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta'), doc('gamma')] });
    view.handleInput('T');
    view.handleInput('G');
    view.handleInput('a');
    let body = strip(view.render(80).join('\n'));
    const filterRows = (text) => text.split('\n').filter((line) => /│ [▸ ] (alpha|beta|gamma)( |$)/.test(line));
    const rows = filterRows(body);
    assert.equal(rows.length, 1, 'an uppercase query still matches the lowercase name');
    assert.match(rows[0], /gamma/, 'only the case-insensitive match is listed');
    assert.ok(!body.split('\n').some((line) => /│ [▸ ] (alpha|beta) *│/.test(line)), 'the filter hides the other rows');
    assert.ok(body.split('\n').some((line) => /│ ▸ gamma *│/.test(line)), 'the only match stays focused');
    view.handleInput('enter');
    view.handleInput('down');
    assert.equal(view.state.index, 0, 'one match has nowhere to move');
    view.handleInput('/');
    view.handleInput('\x7f');
    body = strip(view.render(80).join('\n'));
    assert.equal(filterRows(body).length, 1, 'Backspace edits the kept query');
    view.handleInput('\x7f');
    view.handleInput('enter');
    body = strip(view.render(80).join('\n'));
    const cleared = filterRows(body);
    assert.equal(cleared.length, 3, 'clearing the query restores every document');
  });

  test('the raw DEL byte edits the kept query even with no host helpers injected', () => {
    const { view } = build({ helpers: null, docs: [doc('alpha'), doc('beta'), doc('gamma')] });
    view.handleInput('T');
    view.handleInput('G');
    view.handleInput('a');
    view.handleInput('enter');
    view.handleInput('down');
    view.handleInput('/');
    const narrowedRows = (text) => text.split('\n').filter((line) => /│ [▸ ] (alpha|beta|gamma) *│/.test(line));
    let body = strip(view.render(80).join('\n'));
    assert.equal(narrowedRows(body).length, 1, 'the kept query still filters to the single match');
    view.handleInput('\x7f');
    body = strip(view.render(80).join('\n'));
    assert.equal(narrowedRows(body).length, 1, 'DEL edits the kept query without host helpers');
    assert.ok(!/\x7f/i.test(body), 'the raw DEL byte never becomes visible query text');
    view.handleInput('\x7f');
    view.handleInput('\x7f');
    body = strip(view.render(80).join('\n'));
    assert.equal(narrowedRows(body).length, 3, 'emptying the query restores every document');
  });

  test('S10b: the association options are inert in the rendered frame', async () => {
    const calls = [];
    const opened = [];
    const plain = build();
    const gatedOff = build({
      assigned: ['odd/tasks/alpha.md'],
      assignmentEnabled: false,
      saveAssignment: (...args) => { calls.push(args); return { ok: true }; },
      openExternal: (target) => { opened.push(target); return { ok: true }; },
    });
    const expected = plain.view.render(80).join('\n');
    gatedOff.view.render(80);
    assert.equal(gatedOff.view.render(80).join('\n'), expected, 'no cell differs when the options are passed');
    const body = strip(gatedOff.view.render(80).join('\n'));
    const rows = body.split('\n').filter((line) => /│ [▸ ] (alpha|beta)( |$)/.test(line));
    assert.equal(rows.length, 2, 'both documents still list');
    assert.ok(rows.every((line) => !/[✓✎]/.test(line)), 'no assignment marks on the rows');
    assert.ok(!body.includes('unsaved'), 'no unsaved indicator');
    assert.ok(!body.includes('space'), 'no space hint');
    assert.ok(!body.includes('ctrl+s'), 'no save hint');
    assert.ok(!body.includes('assigned'), 'no assigned count');
    assert.match(body, /shift\+j\/k/, 'the scroll hint stays, naming a usable pair');
    assert.match(body, /› Search/, 'the search row stays, without naming its key');
    assert.match(body, /o open/, 'the open hint stays');
    assert.match(body, /esc close/, 'the close hint stays');
    gatedOff.view.handleInput(' ');
    gatedOff.view.handleInput('\x13'); // ctrl+s
    await tick();
    assert.deepEqual(calls, [], 'Space and ctrl+s bytes never call the save callback');
    assert.ok(!strip(gatedOff.view.render(80).join('\n')).split('\n').some((line) => /✎ (alpha|beta)/.test(line)), 'no pending mark appears');
    gatedOff.view.handleInput('J');
    assert.ok(gatedOff.view.state.scroll > 0, 'scrolling still works with the options passed');
    gatedOff.view.handleInput('T');
    gatedOff.view.handleInput('a');
    gatedOff.view.handleInput('l');
    gatedOff.view.handleInput('enter');
    assert.match(strip(gatedOff.view.render(80).join('\n')).split('\n')[1], /› al( |$)/m, 'search still works');
    gatedOff.view.handleInput('o');
    await tick();
    assert.equal(opened.length, 1, 'the external open still works');
    gatedOff.view.handleInput('escape');
  });
});

// S2: the key legend is ONE terminal row — the keys the view gained (`T`
// filter, `o` open) ride the same row as the rest instead of a second one.
describe('S2: one-row key legends', () => {
  const WIDTHS = [40, 60, 80, 120];
  const tickOnce = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('the footer legend owns exactly one row at every width', async () => {
    for (const width of WIDTHS) {
      const { view } = makeView({
        docs: [doc('alpha'), doc('beta')],
        load: () => ({ ok: true, text: '# alpha\n\nbody of alpha\n' }),
      });
      await tickOnce();
      const lines = view.render(width).map(strip);
      assert.equal(lines.length, 20, `width ${width}: the frame fills the available rows`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `width ${width}: row is not ${width} wide`);
      const legend = lines.filter((line) => /esc close|o open/.test(line));
      assert.equal(legend.length, 1, `width ${width}: exactly one legend row, got ${legend.length}`);
      assert.ok(!legend[0].includes('…'), `width ${width}: compacted, never ellipsis-clipped: ${legend[0]}`);
      assert.match(legend[0], /↑↓/, `width ${width}: the movement keys survive`);
      assert.match(legend[0], /esc close/, `width ${width}: the close key survives`);
    }
  });
});

// S13: the frame says each thing once. The document total lives in the title
// only, no chrome row repeats the focused document, the search key is named by
// the search row alone, and the escape hint belongs to the interaction the
// keyboard is in — while the box is open the footer names its keys once
// instead of the box and the footer both naming them.
describe('S13: the odd frame repeats nothing', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const footerOf = (lines) => lines[lines.length - 2];
  const tokensOf = (footer) => footer.split('·').map((token) => token.trim());

  function quietView({ docs = [doc('alpha'), doc('beta')], text = 'body line\n', rows = 20 } = {}) {
    return makeView({ docs, load: () => ({ ok: true, text }), rows }).view;
  }

  test('the document total renders once and no chrome row repeats the focused name', async () => {
    const view = quietView();
    await tick();
    const lines = strip(view.render(80).join('\n')).split('\n');
    const body = lines.join('\n');
    assert.equal((body.match(/documents?\b/g) || []).length, 1, `the total renders once: ${body}`);
    assert.equal((body.match(/alpha/g) || []).length, 1, 'the focused name appears in the list row only');
    assert.match(lines[0], /✎ Odd · 2 documents/, 'the title carries the one total');
  });

  test('the search key is named by the footer alone (S4 supersedes the earlier split)', async () => {
    const view = quietView();
    await tick();
    const lines = strip(view.render(120).join('\n')).split('\n');
    const footer = footerOf(lines);
    assert.match(lines[1], /› Search/, 'the search row carries the query only');
    assert.ok(!lines[1].includes('(T)'), 'no parenthetical key above the footer');
    assert.ok(tokensOf(footer).some((token) => /^T/.test(token)), `the footer names T: ${footer}`);
  });

  test('while searching the footer names the search keys once and the input carries only the query', async () => {
    const view = quietView();
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    const lines = strip(view.render(80).join('\n')).split('\n');
    const body = lines.join('\n');
    assert.match(lines[1], /› a█/, 'the input row carries the live query');
    assert.ok(!lines[1].includes('enter'), 'the input row repeats no key hint');
    assert.ok(!lines[1].includes('esc'), 'the input row names no escape key');
    const footer = footerOf(lines);
    assert.match(footer, /enter\/esc keep/, 'the footer names the search keys of this interaction');
    assert.ok(!footer.includes('esc close'), 'the close hint belongs to the reading interaction only');
    assert.ok(!footer.includes('ctrl+j/k'), 'the removed binding is never printed');
    assert.ok(!footer.includes('shift+j/k') && !footer.includes('ctrl+shift'), 'the scroll hints leave the footer while typing');
    assert.equal((body.match(/esc/g) || []).length, 1, `one escape hint for the current interaction: ${body}`);
    assert.equal((body.match(/enter/g) || []).length, 1, 'one enter hint for the current interaction');
  });

  test('leaving the box swaps the footer back and keeps a single escape hint', async () => {
    const view = quietView();
    await tick();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('enter');
    const lines = strip(view.render(80).join('\n')).split('\n');
    const footer = footerOf(lines);
    assert.match(footer, /esc close/, 'the reading legend returns');
    assert.ok(!footer.includes('enter/esc keep'), 'the search keys leave with the box');
    assert.equal((lines.join('\n').match(/esc/g) || []).length, 1, 'still one escape hint');
  });

  test('the scroll position shares the search row instead of owning a second chrome row', async () => {
    const view = quietView({ docs: [doc('alpha')], text: longDoc(200) });
    await tick();
    view.handleInput('J');
    const lines = strip(view.render(80).join('\n')).split('\n');
    assert.equal(lines.length, 20, 'the frame still fills every row');
    assert.match(lines[1], /› Search · page 1\/1/, 'the page marker rides the search row');
    assert.match(lines[1], / \d+-\d+\/\d+/, 'the reading position keeps the right edge');
    assert.equal(lines.length - 3, 20 - 3, 'the panes keep the rows the status row used to take');
  });
});

// ---------------------------------------------------------------------------
// worktree-ui-feedback T2/T5: S1 (real host input), S3/D3 (wrapped names and
// viewport-driven rows), S4 (every hint on the footer, Delete clears), S5
// ("para odd igual, si son muchas igual se pagina").
// ---------------------------------------------------------------------------
describe('createOddView feedback round (S1,S3,S4,S5,D3)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function build(opts = {}) {
    const paints = [];
    const view = createOddView({
      docs: opts.docs || [doc('alpha'), doc('beta')],
      loadDoc: opts.loadDoc || (() => ({ ok: true, text: longDoc(200) })),
      helpers: opts.helpers === undefined ? (realTui || helpers) : opts.helpers,
      theme: plainTheme,
      rowsAvailable: () => (opts.rows === undefined ? 20 : opts.rows),
      requestRender: () => { paints.push(true); },
      done: () => {},
      ...opts.rest,
    });
    return { view, paints };
  }

  const footerOf = (lines) => strip(lines[lines.length - 2]);
  const searchRowOf = (lines) => strip(lines[1]);
  const leftRows = (lines) => lines
    .slice(2, -2)
    .map((line) => strip(line).split('│')[1] || '');

  test('S1: ctrl+shift+j/k scrolls the preview and the legacy ctrl+j byte does not', { skip: realTui ? false : 'requires @earendil-works/pi-tui' }, () => {
    // The installed 1.4 matcher reports the same 0x0a as BOTH `ctrl+j` and
    // `enter` while the Kitty protocol is inactive, which is the terminal the
    // user reported. That byte must stay Enter, and the page pair the user
    // asked for is the SHIFTED one the extended protocol reports.
    assert.equal(realTui.matchesKey('\n', 'ctrl+j'), true, 'the host byte is ctrl+j');
    assert.equal(realTui.matchesKey('\n', 'enter'), true, 'and the host also calls it enter');
    assert.equal(realTui.matchesKey('j', 'J'), true, 'the host matcher folds letter case, so the helper never asks it about a bare letter');
    const { view } = build();
    view.render(80);
    view.handleInput('\n');
    assert.equal(view.state.scroll, 0, 'the legacy ctrl+j byte never scrolls');
    view.handleInput('\x1b[106;6u'); // Kitty ctrl+shift+j press
    assert.ok(view.state.scroll > 0, 'ctrl+shift+j scrolls the preview through the real matcher');
    view.handleInput('\x1b[107;6u'); // Kitty ctrl+shift+k press
    assert.equal(view.state.scroll, 0, 'ctrl+shift+k scrolls back');
    view.handleInput('\x0b');
    assert.equal(view.state.scroll, 0, 'the legacy control byte never scrolls');
    view.handleInput('\x1b[106;6:2u'); // Kitty ctrl+shift+j repeat
    assert.ok(view.state.scroll > 0, 'a Kitty key repeat also scrolls');
    view.handleInput('\x1b[106;6:3u'); // and its release does not
    const repeated = view.state.scroll;
    view.handleInput('\x1b[106;6:3u');
    assert.equal(view.state.scroll, repeated, 'a release never scrolls');
    assert.equal(view.state.index, 0, 'no scroll key moved the list selection');
  });

  test('S5: a long document list paginates by the body budget, and ←/→ page it', async () => {
    const docs = Array.from({ length: 14 }, (_, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    let lines = view.render(80);
    // rows 12 -> top rule + search row + footer + bottom rule = 8 body rows
    const firstPage = leftRows(lines).filter((row) => row.trim() !== '');
    assert.equal(firstPage.length, 8, 'every body row carries a document, no fixed page size');
    assert.match(searchRowOf(lines), /1\/2/, 'the page position rides the search row');
    assert.match(firstPage[0], /document-01/);

    view.handleInput('right');
    lines = view.render(80);
    const secondPage = leftRows(lines).filter((row) => row.trim() !== '');
    assert.equal(secondPage.length, 6, 'the last page carries the remaining documents');
    assert.match(secondPage[0], /document-09/, 'the second page starts where the first ended');
    assert.match(searchRowOf(lines), /2\/2/, 'the page position follows');
    assert.equal(view.state.index, 8, 'the selection moves to the first document of the new page');

    view.handleInput('left');
    assert.equal(view.state.index, 0, '← returns to the first document of the previous page');
    view.handleInput('right');
    view.handleInput('right');
    assert.equal(view.state.index, 8, '→ never pages past the last page');
    view.handleInput('left');
    view.handleInput('left');
    assert.equal(view.state.index, 0, '← never pages before the first page');
  });

  test('S5: ↓ walks every document across page boundaries, skipping none', async () => {
    const docs = Array.from({ length: 14 }, (_, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    const seen = [];
    const pages = [];
    for (let step = 0; step < docs.length; step += 1) {
      const rendered = view.render(80);
      const rows = leftRows(rendered);
      const focused = rows.find((row) => row.includes('▸')) || '';
      seen.push((focused.match(/document-\d+/) || [''])[0]);
      pages.push((searchRowOf(rendered).match(/(\d+)\/2/) || [])[1]);
      view.handleInput('down');
    }
    assert.deepEqual(seen, docs.map((entry) => entry.name.replace(/\.md$/, '')), 'every document is reachable in order');
    assert.deepEqual([...new Set(pages)], ['1', '2'], 'the page followed the selection across the boundary');
  });

  test('S3: a long document name wraps over the rows it needs instead of truncating', async () => {
    const name = 'a-document-name-that-is-far-wider-than-the-list-pane';
    const { view } = build({ docs: [doc(name), doc('beta')], rows: 20, loadDoc: () => ({ ok: true, text: 'body\n' }) });
    await tick();
    const rows = leftRows(view.render(80)).map((row) => row.trim());
    const rendered = rows.join(' ');
    assert.ok(!rendered.includes('…'), `no ellipsis truncation: ${rendered}`);
    assert.ok(rendered.includes('wider'), 'the middle of the name is visible');
    assert.ok(rendered.includes('pane'), 'the end of the name is visible');
    assert.match(searchRowOf(view.render(80)), /› Search\b/, 'the search row still reads as the search widget');
  });

  test('S4: T is named by the footer only, never above it', async () => {
    const { view } = build();
    await tick();
    const lines = view.render(120);
    assert.equal(searchRowOf(lines).includes('(T)'), false, 'the search row names no key');
    assert.ok(!searchRowOf(lines).includes('T to edit'), 'leaving the box never re-adds the parenthetical key');
    assert.match(footerOf(lines), /T search/, 'the footer names the search key');
    view.handleInput('T');
    view.handleInput('a');
    const typing = view.render(80);
    assert.match(searchRowOf(typing), /› a█/, 'the input row carries the query only');
    assert.match(footerOf(typing), /del clear/, 'the footer advertises Delete while the box is open');
    assert.match(footerOf(typing), /bksp/, 'and Backspace for one character');
  });

  test('S4: Delete clears the whole query, Backspace deletes one character', async () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta'), doc('gamma')] });
    await tick();
    view.handleInput('T');
    for (const char of 'gam') view.handleInput(char);
    assert.equal(view.state.query, 'gam');
    view.handleInput('\x7f');
    assert.equal(view.state.query, 'ga', 'Backspace removes exactly one character');
    for (const char of 'mma') view.handleInput(char);
    assert.equal(leftRows(view.render(80)).filter((row) => row.includes('gamma')).length, 1, 'the query filters');
    view.handleInput('\x1b[3~'); // Delete
    assert.equal(view.state.query, '', 'Delete clears the entire query');
    assert.equal(view.state.searching, true, 'and leaves the box open for a new query');
    assert.equal(leftRows(view.render(80)).filter((row) => /document|alpha|beta|gamma/.test(row)).length, 3, 'every document lists again');
    for (const char of 'beta') view.handleInput(char);
    view.handleInput('delete'); // the host name for the same key
    assert.equal(view.state.query, '', 'the host key name clears it too');
  });

  test('D3: Tab stays out of the list; only ←/→ page and ↑↓/j/k select', async () => {
    const docs = Array.from({ length: 10 }, (_, at) => doc(`document-${at + 1}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    view.handleInput('tab');
    assert.equal(view.state.index, 0, 'Tab changes no selection in a single-dataset reader');
    assert.equal(view.state.scroll, 0);
    view.handleInput('down');
    assert.equal(view.state.index, 1, 'bare ↓ still moves the selection');
    view.handleInput('j');
    assert.equal(view.state.index, 2, 'bare j still moves the selection');
  });
});

// ---------------------------------------------------------------------------
// ui-consistency-round3 T3: S5 (shared 40/60 geometry, full titles), S8 (page
// capacity from the real rendered body and the wrapped row cost), S14 (page
// marker fixed next to Search on every page count) and S17 (hyphen-aware
// label wrapping). Every case drives the public render/handleInput surface
// only: no internal state is read except the documented `view.state` index.
// ---------------------------------------------------------------------------
describe('createOddView round-3 geometry, capacity and page marker (S5,S8,S14,S17)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const inner = (width) => layout.innerWidth(width);
  const panes = (width) => layout.paneWidths(inner(width));
  const searchRowOf = (lines) => strip(lines[1]);
  const listCells = (lines) => lines.slice(2, -2).map((line) => strip(line).split('│')[1] || '');
  const filled = (lines) => listCells(lines).filter((row) => row.trim() !== '');

  function build({ docs, rows = 20, load } = {}) {
    const view = createOddView({
      docs,
      loadDoc: load || (() => ({ ok: true, text: 'body\n' })),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: () => {},
    });
    return { view };
  }

  const manyShort = (count) => Array.from({ length: count }, (_unused, at) => doc(`doc-${String(at + 1).padStart(2, '0')}`));
  const manyLong = (count) => Array.from({ length: count }, (_unused, at) => doc(`long-wrapped-document-name-number-${String(at + 1).padStart(2, '0')}`));

  test('S5: the two panes take the shared 40/60 geometry at 200 and 80 columns', async () => {
    const { view } = build({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    for (const width of [200, 80]) {
      const lines = view.render(width);
      const shared = panes(width);
      assert.ok(shared.right > shared.left, `${width}: the preview is wider than the list`);
      assert.equal(shared.left + shared.right + 3, inner(width), `${width}: the panes fill the inner width`);
      const row = strip(lines[2]);
      assert.equal([...row].indexOf('│', 2), 3 + shared.left, `${width}: the divider sits where the shared rule puts it`);
      for (const line of lines) assert.equal(helpers.visibleWidth(line), width, `${width}: the frame fills the terminal`);
    }
  });

  test('S5: a full document name is reconstructible from its wrapped rows at 200 columns', async () => {
    const name = 'document-name-that-is-long-enough-to-need-several-wrapped-rows-in-the-list-pane';
    const { view } = build({ docs: [doc(name), doc('beta')] });
    await tick();
    const lines = view.render(200);
    const cost = layout.rowCost(helpers, name, panes(200).left, { first: '▸ ' });
    assert.equal(cost, 2, 'the name needs two rows in the widened list');
    const rows = listCells(lines).slice(0, cost).map((row) => row.slice(1).replace(/^[▸ ]{2}/, '').replace(/\s+$/, ''));
    assert.equal(rows.join(''), name, 'every character of the title survives the wrap');
  });

  test('S8: capacity is the real body rows divided by the rows each name needs, at 200 columns', async () => {
    const { view } = build({ docs: manyShort(30), rows: 20 });
    await tick();
    const first = view.render(200);
    assert.equal(listCells(first).length, 16, 'the body keeps every row the fixed chrome leaves');
    assert.equal(filled(first).length, 16, '16 one-row names fill the page at 200 columns');
    assert.match(searchRowOf(first), /page 1\/2/, '30 names in a 16-row body are two pages');
    assert.match(filled(first)[0], /doc-01/);
    view.handleInput('right');
    const second = view.render(200);
    assert.equal(filled(second).length, 14, 'the last page carries exactly the remaining names');
    assert.match(searchRowOf(second), /page 2\/2/);
    assert.match(filled(second)[0], /doc-17/, 'no name is skipped between pages');
  });

  test('S8: taller wrapped names spend more of the same body budget', async () => {
    const docs = manyLong(12);
    const { view } = build({ docs, rows: 20 });
    await tick();
    const lines = view.render(64);
    const cost = layout.rowCost(helpers, docs[0].name, panes(64).left, { first: '▸ ' });
    assert.equal(cost, 2, 'each name needs two rows at this width');
    assert.equal(listCells(lines).length, 16, 'the body row budget does not depend on the wrap');
    assert.equal(filled(lines).length, 16, 'a full page of wrapped names spends every body row');
    assert.equal(filled(lines).length / cost, 8, 'the page carries 8 two-row names, not a fixed 20');
    assert.match(searchRowOf(lines), /page 1\/2/);
  });

  test('S8: walking every page covers each label once, mixed one-row and two-row names included', async () => {
    const docs = Array.from({ length: 18 }, (_unused, at) => (at % 2 === 0
      ? doc(`short-name-${String(at + 1).padStart(2, '0')}`)
      : doc(`long-wrapped-document-name-number-${String(at + 1).padStart(2, '0')}`)));
    const { view } = build({ docs, rows: 20 });
    await tick();
    const pageMarker = () => (searchRowOf(view.render(64)).match(/page (\d+)\/(\d+)/) || []);
    const walked = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const before = pageMarker();
      assert.ok(before[1], `page ${guard + 1}: the marker is always on the search row`);
      const rows = filled(view.render(64));
      assert.ok(rows.length <= 16, `page ${before[1]}: never more rows than the body holds`);
      walked.push(...rows.join(' ').match(/name-(?:number-)?\d\d/g).map((token) => token.replace(/^name-(?:number-)?/, '')));
      view.handleInput('right');
      if (pageMarker()[1] === before[1]) break;
    }
    assert.deepEqual(
      walked,
      Array.from({ length: 18 }, (_unused, at) => String(at + 1).padStart(2, '0')),
      'every document appears once, in order, across the page transitions',
    );
    assert.equal(pageMarker()[2], String(pageMarker()[1]), 'the walk ends on the last page');
  });

  test('S8: resizing re-pages around the selection and keeps it visible', async () => {
    const { view } = build({ docs: manyLong(40), rows: 20 });
    await tick();
    for (let step = 0; step < 20; step += 1) view.handleInput('down');
    assert.equal(view.state.index, 20);
    const wide = view.render(200);
    assert.match(searchRowOf(wide), /page 2\/3/, 'one-row names at 200 columns page by 16');
    assert.match(strip(filled(wide).find((row) => row.includes('▸'))), /number-21/, 'the selection is on the wide page');
    const narrow = view.render(64);
    assert.match(searchRowOf(narrow), /page 3\/5/, 'two-row names at 64 columns page by 8');
    const focused = filled(narrow).find((row) => row.includes('▸'));
    assert.ok(focused, 'the selection stays on the rendered page after the resize');
    assert.match(strip(focused), /long-wrapped-document-/, 'the focused name starts on the focused row');
    assert.ok(filled(narrow).join(' ').replace(/\s+/g, '').includes('name-number-21'), 'the focused document renders');
  });

  test('S8: a search that narrows the list keeps the focused row on the visible page', async () => {
    const { view } = build({ docs: manyShort(30), rows: 12 });
    await tick();
    for (let step = 0; step < 19; step += 1) view.handleInput('down');
    view.handleInput('T');
    view.handleInput('2');
    view.handleInput('enter');
    const lines = view.render(80);
    assert.match(searchRowOf(lines), /› 2 · page 1\/2/, 'the narrowed list re-pages truthfully');
    assert.match(strip(filled(lines).find((row) => row.includes('▸'))), /doc-02/, 'the selection restarts on the visible page');
  });

  test('S14: the page marker sits next to Search on one-page lists and empty states too', async () => {
    const single = build({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    assert.match(searchRowOf(single.view.render(120)), /› Search · page 1\/1/, 'a one-page list still reports its page');
    const empty = build({ docs: [] });
    await tick();
    assert.match(searchRowOf(empty.view.render(120)), /› Search · page 1\/1/, 'the empty list says 1/1 instead of hiding the marker');
    const noMatch = build({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    noMatch.view.handleInput('T');
    noMatch.view.handleInput('z');
    assert.match(searchRowOf(noMatch.view.render(120)), /› z█ · page 1\/1/, 'a no-match query keeps the marker truthful');
    const narrow = build({ docs: [doc('alpha'), doc('beta')], rows: 12 });
    await tick();
    assert.match(searchRowOf(narrow.view.render(24)), /page 1\/1/, 'even the narrowest frame keeps the page marker');
  });

  test('S14: the page marker renders once, in the chrome, never in the list content', async () => {
    const docs = Array.from({ length: 14 }, (_unused, at) => doc(`document-${String(at + 1).padStart(2, '0')}`));
    const { view } = build({ docs, rows: 12 });
    await tick();
    const body = strip(view.render(80).join('\n'));
    assert.equal((body.match(/page \d+\/\d+/g) || []).length, 1, 'the marker renders once in the whole frame');
    assert.match(searchRowOf(view.render(80)), /page 1\/2/);
    view.handleInput('right');
    assert.match(searchRowOf(view.render(80)), /page 2\/2/, 'the same cell follows the page');
    assert.ok(!listCells(view.render(80)).some((row) => /page \d/.test(row)), 'the list content carries no page marker');
  });

  test('S17: the list breaks a hyphenated name at its hyphens, never inside a segment', async () => {
    const name = 'a-document-name-that-is-far-wider-than-the-list-pane';
    const { view } = build({ docs: [doc(name), doc('beta')] });
    await tick();
    const lines = view.render(80);
    const width = panes(80).left;
    const expected = layout.wrapLabel(helpers, name, width, { first: '▸ ', rest: '  ' });
    assert.ok(expected.length > 1, 'the name wraps over several rows');
    for (const row of expected) assert.ok(helpers.visibleWidth(row) <= width, `row too wide: ${row}`);
    assert.deepEqual(
      listCells(lines).slice(0, expected.length).map((row) => row.slice(1).replace(/\s+$/, '')),
      expected.map((row) => row.replace(/\s+$/, '')),
      'the rendered rows are the hyphen-aware wrap',
    );
    assert.ok(expected.some((row) => row.trimEnd().endsWith('-')), 'a break lands on a hyphen');
    assert.equal(expected.map((row) => row.replace(/^[▸ ]{2}/, '')).join(''), name, 'every character survives');
  });
});

// ---------------------------------------------------------------------------
// round-3 T3 S1: the preview scroll bindings ODD shares through
// lib/preview-scroll-keys.js. The user asked for ctrl+shift+j/k and for a
// footer that names the usable pair instead of always printing ctrl+j/k; the
// native Pi full-screen default is PgUp/PgDn, and ctrl+shift+j/k only exists
// once the terminal negotiates an extended keyboard protocol.
// ---------------------------------------------------------------------------
describe('createOddView preview scroll bindings (S1)', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const body200 = longDoc(200);
  const searchRowOf = (lines) => strip(lines[1]);
  const footerOf = (lines) => strip(lines[lines.length - 2]);

  // A host whose matcher/parser is a table of the payloads these tests send, so
  // each case states what the terminal reported instead of what the installed
  // module happens to decode.
  const TABLE = {
    '\x1b[6~': 'pageDown',
    '\x1b[5~': 'pageUp',
    '\x1b[106;6u': 'shift+ctrl+j',
    '\x1b[107;6u': 'shift+ctrl+k',
    '\x1b[27;6;106~': 'shift+ctrl+j',
    '\x1b[106;5u': 'ctrl+j',
    '\x1b[27;5;106~': 'ctrl+j',
    J: 'J',
    K: 'K',
    j: 'j',
    k: 'k',
    '\n': 'enter',
    '\x0b': 'ctrl+k',
    '\x04': 'ctrl+d',
  };
  const namesOf = (data) => (TABLE[data] ? [TABLE[data]] : []);
  const sameName = (a, b) => (a.length === 1 || b.length === 1 ? a === b : a.toLowerCase() === b.toLowerCase());
  function host({ kitty = false, partial = false } = {}) {
    const helpers = partial
      ? { matchesKey: (data, name) => namesOf(data).some((entry) => sameName(entry, name)) }
      : {
        isKittyProtocolActive: () => kitty,
        matchesKey: (data, name) => namesOf(data).some((entry) => sameName(entry, name)),
        parseKey: (data) => namesOf(data)[0] ?? null,
        isKeyRelease: (data) => /:3u$/.test(String(data)),
      };
    return helpers;
  }

  function build(kitchen = {}) {
    const paints = [];
    const view = createOddView({
      docs: [doc('alpha'), doc('beta')],
      loadDoc: () => ({ ok: true, text: body200 }),
      helpers: kitchen.helpers === undefined ? host() : kitchen.helpers,
      theme: plainTheme,
      rowsAvailable: () => 20,
      requestRender: () => { paints.push(true); },
      done: () => {},
    });
    return { view, paints };
  }

  test('the footer names ctrl+shift+j/k only when the host confirms the extended protocol', async () => {
    const confirmed = build({ helpers: host({ kitty: true }) });
    await tick();
    const extendedFooter = footerOf(confirmed.view.render(120));
    assert.match(extendedFooter, /ctrl\+shift\+j\/k/, `the confirmed pair is named: ${extendedFooter}`);
    assert.ok(!extendedFooter.includes('ctrl+j/k'), 'the removed binding is never printed');

    const cases = [
      ['inactive', host({ kitty: false })],
      ['unknown namespace', {}],
      ['no helpers', null],
      ['throwing getter', { isKittyProtocolActive: () => { throw new Error('no tty'); } }],
    ];
    for (const [label, helpers] of cases) {
      const { view } = build({ helpers });
      await tick();
      const footer = footerOf(view.render(120));
      assert.match(footer, /(^|· )shift\+j\/k/, `${label}: the printable fallback is named: ${footer}`);
      assert.ok(!footer.includes('ctrl+shift'), `${label}: no fabricated extended support: ${footer}`);
      assert.ok(!footer.includes('ctrl+j/k'), `${label}: the removed binding is never printed: ${footer}`);
    }
  });

  test('PgUp/PgDn are named as the always-available pair in both tiers', async () => {
    for (const kitty of [true, false]) {
      const { view } = build({ helpers: host({ kitty }) });
      await tick();
      const footer = footerOf(view.render(120));
      assert.match(footer, /(PgUp\/PgDn|PgUp\/Dn)/, `kitty ${kitty}: the page keys are named: ${footer}`);
    }
  });

  test('ctrl+shift+j/k page the preview, and ctrl+j never does', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[106;6u');
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'ctrl+shift+j pages the preview');
    view.handleInput('\x1b[107;6u');
    assert.equal(view.state.scroll, 0, 'ctrl+shift+k pages back up');
    for (const data of ['\x1b[106;5u', '\x1b[27;5;106~', '\n', '\x0b']) {
      view.render(80);
      view.handleInput(data);
      assert.equal(view.state.scroll, 0, `${JSON.stringify(data)}: the old ctrl+j/ctrl+k contract is gone`);
      assert.equal(view.state.index, 0, `${JSON.stringify(data)}: no selection movement either`);
    }
    assert.equal(view.state.index, 0);
  });

  test('the xterm modifyOtherKeys sequence pages and its release is ignored', async () => {
    const { view, paints } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[27;6;106~');
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'the xterm ctrl+shift+j sequence pages the preview');
    const before = paints.length;
    view.handleInput('\x1b[27;6;106;3~');
    assert.equal(view.state.scroll, paged, 'the release suffix never pages');
    assert.equal(paints.length, before, 'a release does not even repaint');
  });

  test('a repeat pages, a release never does', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[106;6:2u');
    const repeated = view.state.scroll;
    assert.ok(repeated > 1, 'a key repeat pages the preview');
    view.handleInput('\x1b[106;6:3u');
    assert.equal(view.state.scroll, repeated, 'the release of that key is ignored');
  });

  test('Enter and the LF byte keep their meaning in content mode', async () => {
    const { view, paints } = build();
    await tick();
    view.render(80);
    const before = paints.length;
    for (const data of ['\n', '\r', 'enter']) {
      view.handleInput(data);
      assert.equal(view.state.scroll, 0, `${JSON.stringify(data)}: Enter never scrolls`);
      assert.equal(view.state.index, 0, `${JSON.stringify(data)}: Enter never moves the selection`);
    }
    assert.equal(paints.length, before, 'Enter requests no repaint: nothing changed');
  });

  test('a search session keeps the scroll keys out of the preview', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    view.handleInput('T');
    view.handleInput('J');
    view.handleInput('\x1b[106;6u');
    assert.equal(view.state.query, 'J', 'the printable byte types into the query, it does not page');
    assert.equal(view.state.scroll, 0, 'no preview scroll while the box holds the keyboard');
    const lines = view.render(120);
    assert.match(searchRowOf(lines), /› J█/, 'the query row carries the typed letter');
    assert.match(footerOf(lines), /enter\/esc keep/, 'the footer names the search keys of this interaction');
    assert.ok(!footerOf(lines).includes('ctrl+shift'), 'the scroll hint leaves the footer while typing');
    view.handleInput('enter');
    assert.equal(view.state.query, 'J', 'leaving the box keeps the query');
    assert.equal(view.state.scroll, 0, 'still no scroll');
  });

  test('a partial helper namespace still pages through the shared fallback', async () => {
    const { view } = build({ helpers: host({ partial: true }) });
    await tick();
    view.render(80);
    view.handleInput('\x1b[6~');
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'PageDown works with a matcher-only host');
    view.handleInput('K');
    assert.equal(view.state.scroll, 0, 'the printable shift fallback works with a matcher-only host');
    view.handleInput('J');
    assert.equal(view.state.scroll, paged, 'and pages exactly what PageDown pages');
    view.handleInput('\x1b[106;6u');
    assert.ok(view.state.scroll > paged, 'the extended pair still resolves through the matcher');
  });

  test('the mouse wheel and the frame geometry are untouched by the binding change', async () => {
    const { view } = build({ helpers: host({ kitty: true }) });
    await tick();
    const geometry = layout.paneWidths(layout.innerWidth(120));
    const lines = view.render(120);
    assert.equal(layout.paneWidths(layout.innerWidth(120)).left, geometry.left, 'the 40/60 rule still owns the panes');
    assert.equal([...strip(lines[2])].indexOf('│', 2), 3 + geometry.left, 'the divider still sits at the shared column');
    view.handleMouse({ type: 'wheel', wheelDelta: 2 });
    assert.equal(view.state.scroll, 2, 'the wheel still scrolls the preview');
    assert.equal(view.state.index, 0, 'the wheel never moves the selection');
  });
});
