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
