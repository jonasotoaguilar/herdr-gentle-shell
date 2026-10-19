'use strict';
// T2 (odd-viewer S5) tests: lib/odd-markdown.js — the pure markdown ->
// styled-lines renderer for the document pane.
//
// Contract under test (observable output only): headings of every level
// this repo's odd documents use (`#`, `##`, `###`) get a heading mark and
// keep their text; list items, GitHub task rows (checked and unchecked),
// ordered items and table rows are recognised; fenced code and blockquotes
// are recognised; nothing is dropped — every source line's words reach the
// output — and no rendered line exceeds the requested width, so a long
// paragraph wraps instead of being truncated.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { renderOddMarkdown } = require('../lib/odd-markdown.js');

// The injected paint seam: roles are tagged so tests can assert styling
// without depending on a theme implementation.
const tag = (role, text) => `<${role}>${text}</${role}>`;
const opts = (width) => ({ width, paint: tag, measure: (s) => [...strip(s)].length });
function strip(value) {
  return String(value).replace(/<\/?[a-z][a-zA-Z]*>/g, '');
}
function plain(lines) {
  return lines.map(strip).join('\n');
}

describe('renderOddMarkdown', () => {
  test('renders the document heading and each section heading with its level mark', () => {
    const source = [
      '# Odd viewer: read the documents',
      '',
      '## Specs',
      'S1. one line.',
      '',
      '### Deep section',
      'detail.',
    ].join('\n');
    const lines = renderOddMarkdown(source, opts(60));
    const body = plain(lines);
    assert.ok(body.includes('Odd viewer: read the documents'), 'the document title keeps its text');
    assert.ok(!body.includes('# Odd viewer'), 'the raw # marker is replaced by the heading mark');
    assert.ok(body.includes('Specs'), 'the section heading keeps its text');
    assert.ok(body.includes('Deep section'), 'the nested heading keeps its text');
    assert.ok(lines.some((line) => line.startsWith('<mdHeading>')), 'headings use the mdHeading role');
    const specLine = lines.findIndex((line) => strip(line).includes('Specs'));
    const deepLine = lines.findIndex((line) => strip(line).includes('Deep section'));
    assert.ok(specLine >= 0 && deepLine > specLine, 'headings stay in source order');
  });

  test('renders list items, task rows and table rows', () => {
    const source = [
      '## Tasks',
      'T1 | S1 | done | a task row.',
      '- a plain bullet',
      '- [ ] an open task',
      '- [x] a done task',
      '1. an ordered item',
      '',
      '| ID | Spec | Route |',
      '| --- | --- | --- |',
      '| T2 | S5 | implement |',
    ].join('\n');
    const lines = renderOddMarkdown(source, opts(60));
    const body = plain(lines);
    for (const copy of [
      'T1 | S1 | done | a task row.',
      'a plain bullet',
      'an open task',
      'a done task',
      'an ordered item',
      'T2 | S5 | implement',
    ]) {
      assert.ok(body.includes(copy), `lost content: ${copy}`);
    }
    assert.ok(/•\s+a plain bullet/.test(body), 'bullets carry a • mark');
    assert.ok(/☐\s+an open task/.test(body), 'an open task row carries an unchecked box');
    assert.ok(/☑\s+a done task/.test(body), 'a done task row carries a checked box');
    assert.ok(/1\.\s+an ordered item/.test(body), 'an ordered item keeps its number');
  });

  test('renders fenced code and blockquotes without their markers leaking', () => {
    const source = [
      'text before',
      '',
      '> a quoted line',
      '',
      '```sh',
      'git worktree list',
      '```',
      '',
      'text after',
    ].join('\n');
    const lines = renderOddMarkdown(source, opts(60));
    const body = plain(lines);
    assert.ok(body.includes('git worktree list'), 'the code body survives');
    assert.ok(body.includes('a quoted line'), 'the quote text survives');
    assert.ok(!body.includes('```'), 'the fence marker is not rendered as text');
    assert.ok(!/^>/m.test(body), 'the quote marker is not rendered as text');
  });

  test('wraps a long paragraph to the width instead of cutting it', () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    const lines = renderOddMarkdown(words, opts(24));
    assert.ok(lines.length > 1, 'a long paragraph occupies several lines');
    for (const line of lines) {
      assert.ok(strip(line).length <= 24, `line exceeds the width: ${strip(line)}`);
    }
    const joined = plain(lines).replace(/\n/g, ' ');
    for (const word of words.split(' ')) {
      assert.ok(joined.includes(word), `wrapped output lost ${word}`);
    }
  });

  test('honours an inline emphasis and code span without breaking the width budget', () => {
    const lines = renderOddMarkdown('a **bold** value and `inline code` here', opts(80));
    const body = plain(lines);
    assert.ok(body.includes('bold'), 'bold text survives');
    assert.ok(body.includes('inline code'), 'inline code survives');
    for (const line of lines) assert.ok(strip(line).length <= 80);
  });

  test('an empty document renders nothing', () => {
    assert.deepEqual(renderOddMarkdown('', opts(40)), []);
    assert.deepEqual(renderOddMarkdown('   \n\n', opts(40)), []);
  });

  test('keeps punctuation glued to inline spans attached', () => {
    const source = 'see `/x/y`, and **bold**, done.';
    for (const width of [80, 20]) {
      const lines = renderOddMarkdown(source, opts(width));
      const body = plain(lines);
      assert.ok(body.includes('/x/y,'), `width ${width}: code span keeps its glued comma: ${JSON.stringify(body)}`);
      assert.ok(body.includes('bold,'), `width ${width}: bold span keeps its glued comma: ${JSON.stringify(body)}`);
      assert.ok(!body.includes('/x/y ,'), `width ${width}: no space before the code comma: ${JSON.stringify(body)}`);
      assert.ok(!body.includes('bold ,'), `width ${width}: no space before the bold comma: ${JSON.stringify(body)}`);
    }
  });
});
