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
    assert.match(body, /demo-checkout/, 'the title names the checkout');
    assert.match(body, /1 assigned/, 'the title carries the assigned count');
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
