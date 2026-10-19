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
    view.handleInput('ctrl+j');
    const scrolled = strip(view.render(80).join('\n'));
    assert.ok(view.state.scroll > 0, 'ctrl+j scrolls the right pane');
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

describe('createOddView assignment (S7/S8)', () => {
  function makeAssignView({ docs, assigned, checkoutName, saveImpl, rows = 20 } = {}) {
    const calls = [];
    let settled = 'pending';
    const save = (...args) => {
      calls.push(args);
      if (typeof saveImpl === 'function') return saveImpl(...args);
      return { ok: true };
    };
    const view = createOddView({
      docs,
      assigned,
      checkoutName,
      saveAssignment: save,
      loadDoc: (entry) => ({ ok: true, text: `# ${entry.name}\n` }),
      helpers,
      theme: plainTheme,
      rowsAvailable: () => rows,
      requestRender: () => {},
      done: (result) => { settled = result; },
    });
    return { view, calls, done: () => settled };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // List rows carry the row structure `▸|  <mark> <name>`; the title and
  // the document pane may repeat the name, so match the mark explicitly.
  const rowFor = (body, name) => body.split('\n').find((line) =>
    new RegExp(`[▸ ] [✓·✎] ${name}( |$)`).test(line));

  test('stored assignments show ✓, unassigned show ·, and the title names the checkout and the count', async () => {
    const { view } = makeAssignView({
      docs: [doc('alpha'), doc('beta')],
      assigned: ['odd/tasks/alpha.md'],
      checkoutName: 'demo-checkout',
    });
    await tick();
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✓/, 'the stored row carries ✓');
    assert.match(rowFor(body, 'beta'), /·/, 'the unassigned row carries ·');
    assert.match(body, /alpha · \d+-\d+\/\d+ · 1 assigned/, 'the status row names the selected document next to its scroll position and the assigned count');
    assert.ok(!body.includes('demo-checkout'), 'the concise title no longer repeats the checkout name');
    assert.ok(!body.includes('unsaved'), 'nothing is pending, so no unsaved indicator');
    assert.match(body, /space/, 'the footer names the toggle key');
    assert.match(body, /ctrl\+s/, 'the footer names the save key');
  });

  test('space toggles the focused row locally: ✎ appears and nothing is written', async () => {
    const { view, calls } = makeAssignView({
      docs: [doc('alpha'), doc('beta')],
      assigned: ['odd/tasks/alpha.md'],
      checkoutName: 'demo-checkout',
    });
    await tick();
    view.handleInput('space');
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✎/, 'the toggled row carries the unsaved mark');
    assert.match(rowFor(body, 'beta'), /·/, 'the untouched row keeps its mark');
    assert.match(body, /· unsaved/, 'the title gains the unsaved indicator');
    assert.match(body, /0 assigned/, 'the count follows the pending set');
    assert.deepEqual(calls, [], 'toggling alone never calls the save callback');
  });

  test('toggling the same row twice reverts it and clears the unsaved indicator', async () => {
    const { view, calls } = makeAssignView({
      docs: [doc('alpha')],
      assigned: [],
      checkoutName: 'demo-checkout',
    });
    await tick();
    view.handleInput('space');
    assert.match(strip(view.render(80).join('\n')), /✎/);
    view.handleInput('space');
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /·/, 'the row is back to unassigned');
    assert.ok(!body.includes('unsaved'), 'no pending change remains');
    assert.deepEqual(calls, []);
  });

  test('ctrl+s persists the whole pending set and applies the assignment', async () => {
    const { view, calls } = makeAssignView({
      docs: [doc('alpha'), doc('beta')],
      assigned: ['odd/tasks/alpha.md'],
      checkoutName: 'demo-checkout',
    });
    await tick();
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(calls.length, 1, 'one save for the whole set');
    assert.deepEqual(calls[0][0], ['odd/tasks/alpha.md', 'odd/tasks/beta.md']);
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✓/);
    assert.match(rowFor(body, 'beta'), /✓/, 'the saved toggle is now stored');
    const rowLines = body.split('\n').filter((line) => /[▸ ] [✓·✎] (alpha|beta)( |$)/.test(line));
    assert.ok(rowLines.every((line) => !line.includes('✎')), 'no pending mark survives a successful save');
    assert.ok(!body.includes('unsaved'), 'the indicator clears on success');
    assert.match(body, /2 assigned/);
  });

  test('ctrl+s can also remove: untoggling a stored row saves the smaller set', async () => {
    const { view, calls } = makeAssignView({
      docs: [doc('alpha'), doc('beta')],
      assigned: ['odd/tasks/alpha.md', 'odd/tasks/beta.md'],
    });
    await tick();
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(calls[0][0], ['odd/tasks/beta.md']);
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /·/, 'removal applies only after save');
    assert.match(rowFor(body, 'beta'), /✓/);
  });

  test('a failed save keeps the pending marks and shows the error', async () => {
    const { view, calls } = makeAssignView({
      docs: [doc('alpha')],
      assigned: [],
      saveImpl: () => ({ ok: false, error: 'disk full' }),
    });
    await tick();
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(calls.length, 1);
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✎/, 'the pending mark survives the failure');
    assert.match(body, /· unsaved/, 'the indicator survives the failure');
    assert.match(body, /save failed: disk full/, 'the error is shown, never success');
  });

  test('a throwing save is reported as a failure and keeps every pending mark', async () => {
    const { view } = makeAssignView({
      docs: [doc('alpha')],
      assigned: [],
      saveImpl: () => { throw new Error('lock timeout'); },
    });
    await tick();
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /✎/);
    assert.match(body, /save failed: lock timeout/);
  });

  test('esc closes and discards unsaved toggles without writing', async () => {
    const { view, calls, done } = makeAssignView({
      docs: [doc('alpha')],
      assigned: [],
    });
    await tick();
    view.handleInput('space');
    assert.match(strip(view.render(80).join('\n')), /✎/);
    view.handleInput('escape');
    assert.equal(done(), null, 'esc still closes with a null result');
    assert.deepEqual(calls, [], 'closing never saves the pending toggles');
  });

  test('ctrl+s with no pending changes writes nothing', async () => {
    const { view, calls } = makeAssignView({
      docs: [doc('alpha')],
      assigned: ['odd/tasks/alpha.md'],
    });
    await tick();
    view.handleInput('ctrl+s');
    await tick();
    assert.deepEqual(calls, [], 'a clean state saves nothing');
    assert.match(strip(view.render(80).join('\n')), /✓/);
  });

  test('a missing assignment leaves every row unmarked and the view usable', async () => {
    const { view, calls } = makeAssignView({ docs: [doc('alpha'), doc('beta')] });
    await tick();
    const body = strip(view.render(80).join('\n'));
    assert.match(rowFor(body, 'alpha'), /·/);
    assert.match(rowFor(body, 'beta'), /·/);
    assert.ok(!body.includes('✓'), 'nothing is marked when nothing was assigned');
    view.handleInput('down');
    assert.equal(view.state.index, 1, 'navigation still works');
    view.handleInput('space');
    view.handleInput('ctrl+s');
    await tick();
    assert.equal(calls.length, 1, 'toggling then saving still works from an empty start');
    assert.deepEqual(calls[0][0], ['odd/tasks/beta.md']);
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
    const rows = body.split('\n').filter((line) => /[▸ ] [✓·✎] /.test(line));
    assert.ok(rows.every((line) => !line.includes('beta') && !line.includes('gamma')), 'only the match is listed');
    assert.match(body, / › al/, 'the filter is visible while typing');
    view.handleInput('enter');
    const kept = strip(view.render(80).join('\n'));
    assert.match(kept, /› al \(T to edit\)/, 'leaving the box keeps the filter');
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
    assert.match(body, /› gam \(T to edit\)/, 'the / filter is kept like the T filter');
    assert.match(body, /gamma/);
    assert.ok(!body.split('\n').filter((line) => /[▸ ] [✓·✎] /.test(line)).some((line) => line.includes('alpha')), 'alpha is filtered out');
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
    assert.match(body, /T filter/, 'the footer names the filter key');
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
    view.handleInput('\n');            // ctrl+j
    assert.ok(view.state.scroll > 0, 'raw ctrl+j scrolls down');
    view.handleInput('\x0b');          // ctrl+k
    assert.equal(view.state.scroll, 0, 'raw ctrl+k scrolls up');
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
    view.handleInput('\n');     // ctrl+j (a newline, never Enter)
    assert.ok(view.state.scroll > 0, 'ctrl+j scrolls');
    view.handleInput('\x1b[6~'); // PageDown
    const paged = view.state.scroll;
    assert.ok(paged > 1, 'PageDown scrolls a page');
    view.handleInput('\x1b[5~'); // PageUp
    assert.ok(view.state.scroll < paged, 'PageUp scrolls the page back');
    view.handleInput('\x1b[F');  // End
    assert.ok(view.state.scroll > 0, 'End reaches the bottom');
    view.handleInput('\x1b[H');  // Home
    assert.equal(view.state.scroll, 0, 'Home returns to the top');
    view.handleInput('\x0b');    // ctrl+k at the top stays at the top
    assert.equal(view.state.scroll, 0, 'ctrl+k clamps at the top');
    assert.equal(view.state.index, 0, 'no scroll key moved the list selection');
    view.handleInput('\x1b[B');
    assert.equal(view.state.index, 1, 'Down still moves the list selection');
  });

  test('the scroll keys repaint without writing anything', { skip: skipReal }, async () => {
    const calls = [];
    const { view, paints } = build({ saveAssignment: (...args) => { calls.push(args); return { ok: true }; } });
    view.render(80);
    const before = paints.length;
    view.handleInput('\n');
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

  test('the search row sits directly below the title with the query and the visible/total count', () => {
    const { view } = build();
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('l');
    let lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al█ \(enter\/esc keep\) · 1\/2 documents/, 'typing shows the live query and counts on its own row');
    assert.ok(!strip(lines[0]).includes('1/2'), 'the count is not buried in the title');
    view.handleInput('enter');
    lines = strip(view.render(80).join('\n')).split('\n');
    assert.match(strip(lines[1]), /› al \(T to edit\) · 1\/2 documents/, 'leaving the box keeps the query and counts visible');
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
      assert.match(body.split('\n')[1], /› Search \(T\) · 2\/2 documents/, `${width}x${rows}: the query row is visible`);
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
    const filterRows = (text) => text.split('\n').filter((line) => /[▸ ] [✓·✎] (alpha|beta|gamma)( |$)/.test(line));
    const rows = filterRows(body);
    assert.equal(rows.length, 1, 'an uppercase query still matches the lowercase name');
    assert.match(rows[0], /gamma/, 'only the case-insensitive match is listed');
    assert.match(body.split('\n')[1], /1\/3 documents/, 'the visible/total count follows the filter');
    assert.match(body.split('\n')[2], /gamma · /, 'the selected document follows the filtered list');
    view.handleInput('enter');
    view.handleInput('down');
    assert.equal(view.state.index, 0, 'one match has nowhere to move');
    view.handleInput('/');
    view.handleInput('\x7f');
    body = strip(view.render(80).join('\n'));
    assert.match(body.split('\n')[1], /1\/3 documents/, 'Backspace edits the kept query');
    view.handleInput('\x7f');
    view.handleInput('enter');
    body = strip(view.render(80).join('\n'));
    const cleared = filterRows(body);
    assert.equal(cleared.length, 3, 'clearing the query restores every document');
    assert.match(body.split('\n')[1], /3\/3 documents/, 'the counts return with the list');
  });

  test('S29: assignmentEnabled false hides marks/hints/unsaved and refuses Space and ctrl+s bytes', async () => {
    const calls = [];
    const opened = [];
    const { view } = build({
      assigned: ['odd/tasks/alpha.md'],
      assignmentEnabled: false,
      saveAssignment: (...args) => { calls.push(args); return { ok: true }; },
      openExternal: (target) => { opened.push(target); return { ok: true }; },
    });
    view.render(80);
    const body = strip(view.render(80).join('\n'));
    const rows = body.split('\n').filter((line) => /[▸ ] (alpha|beta)( |$)/.test(line));
    assert.equal(rows.length, 2, 'both documents still list');
    assert.ok(rows.every((line) => !/[✓✎·] (alpha|beta)/.test(line)), 'no assignment marks on the rows');
    assert.ok(!body.includes('unsaved'), 'no unsaved indicator');
    assert.ok(!body.includes('space'), 'no space hint');
    assert.ok(!body.includes('ctrl+s'), 'no save hint');
    assert.ok(!/\d+ assigned/.test(body), 'no assigned count');
    assert.match(body, /ctrl\+j\/k scroll/, 'the scroll hint stays');
    assert.match(body, /T filter/, 'the filter hint stays');
    assert.match(body, /o open/, 'the open hint stays');
    assert.match(body, /esc close/, 'the close hint stays');
    view.handleInput(' ');
    view.handleInput('\x13'); // ctrl+s
    await tick();
    assert.deepEqual(calls, [], 'Space and ctrl+s bytes never call the save callback');
    assert.ok(!strip(view.render(80).join('\n')).split('\n').some((line) => /✎ (alpha|beta)/.test(line)), 'no pending mark appears');
    view.handleInput('\n');
    assert.ok(view.state.scroll > 0, 'scrolling still works with assignment disabled');
    view.handleInput('T');
    view.handleInput('a');
    view.handleInput('l');
    view.handleInput('enter');
    assert.match(strip(view.render(80).join('\n')).split('\n')[1], /1\/2 documents/, 'search still works');
    view.handleInput('o');
    await tick();
    assert.equal(opened.length, 1, 'the external open still works');
    view.handleInput('escape');
  });

  test('S29: the default keeps assignment enabled for existing callers', async () => {
    const calls = [];
    const { view } = build({ assigned: [], saveAssignment: (...args) => { calls.push(args); return { ok: true }; } });
    view.render(80);
    view.handleInput(' ');
    assert.match(strip(view.render(80).join('\n')), /✎/, 'the pending mark appears by default');
    view.handleInput('\x13');
    await tick();
    assert.equal(calls.length, 1, 'ctrl+s saves by default');
    assert.deepEqual(calls[0][0], ['odd/tasks/alpha.md']);
    const body = strip(view.render(80).join('\n'));
    assert.match(body, /space toggle/, 'the space hint stays by default');
    assert.match(body, /ctrl\+s/, 'the save hint stays by default');
  });
});
