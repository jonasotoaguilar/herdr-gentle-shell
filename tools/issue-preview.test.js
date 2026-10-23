'use strict';
// T6 S16: lib/issue-preview.js — the ONE issue-preview formatter the worktree
// detail/edit pane and the Issues viewer share. These tests pin the formatter's
// own contract (field order, omitted empties, pending read, injected clock) so
// a later wiring change in either surface renders the same thing.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { issueDetailLines, relativeTime, wrapText } = require('../lib/issue-preview.js');

const plain = (_role, text) => String(text);
const bold = (text) => String(text);
const NOW = Date.parse('2026-03-01T00:00:00.000Z');

function render(detail, comments, options = {}) {
  return issueDetailLines(detail, comments, {
    width: 80,
    paint: plain,
    emphasis: bold,
    now: NOW,
    ...options,
  }).join('\n');
}

const FULL = {
  number: 77,
  title: 'parity title',
  state: 'open',
  author: 'octo',
  labels: [{ name: 'bug' }, 'docs'],
  assignees: [{ login: 'ana' }, 'beto'],
  createdAt: '2026-02-25T00:00:00.000Z',
  updatedAt: '2026-02-26T00:00:00.000Z',
  commentsCount: 2,
  reactions: { plusOne: 3 },
  projects: [{ title: 'Roadmap' }],
  linkedPullRequestCount: 2,
  body: 'the body',
};

describe('issue preview formatter (S16)', () => {
  test('renders every present field and every comment', () => {
    const text = render(FULL, [
      { author: 'ana', body: 'first comment', createdAt: '2026-02-27T00:00:00.000Z' },
      { author: 'beto', body: 'second comment', createdAt: '2026-02-28T00:00:00.000Z' },
    ]);
    assert.match(text, /^#77 parity title/);
    assert.match(text, /\[open\]/);
    assert.match(text, /labels: bug, docs/);
    assert.match(text, /assignees: ana, beto/);
    assert.match(text, /by octo · created 4d ago · updated 3d ago/);
    assert.match(text, /👍 3 · 2 comments/);
    assert.match(text, /projects: Roadmap/);
    assert.match(text, /linked PRs: 2/);
    assert.match(text, /the body/);
    assert.match(text, /─ ana · 2d ago ─/);
    assert.match(text, /first comment/);
    assert.match(text, /second comment/);
    assert.equal((text.match(/\(end of issue\)/g) || []).length, 1, 'the end marker closes the last comment');
  });

  test('omits empty optional metadata instead of printing a zero or "none"', () => {
    const text = render(
      { ...FULL, assignees: [], projects: [], linkedPullRequestCount: 0, commentsCount: 0, reactions: { plusOne: 0 } },
      [],
    );
    assert.doesNotMatch(text, /assignees:/);
    assert.doesNotMatch(text, /projects:/);
    assert.doesNotMatch(text, /linked PRs:/);
    assert.match(text, /👍 0 · 0 comments/, 'the reaction/comment counter is one honest line');
    assert.match(text, /\(end of issue\)/, 'an uncommented issue still ends');
  });

  test('a pending read paints the known fields and names the read', () => {
    const text = render({ number: 12, title: 'issue title 12', labels: [{ name: 'bug' }] }, [], { pending: true });
    assert.match(text, /#12 issue title 12/);
    assert.match(text, /labels: bug/);
    assert.match(text, /loading…/);
    assert.doesNotMatch(text, /the body|no description|\(end of issue\)/);
  });

  test('the caller note rides the state row and never replaces a fact', () => {
    const text = render(FULL, [], { note: 'assigned to this worktree' });
    assert.match(text, /\[open\] · assigned to this worktree/);
    assert.match(text, /labels: bug, docs/);
  });

  test('ages come from the injected clock, so no assertion depends on the host time', () => {
    assert.equal(relativeTime('2026-02-28T23:59:30.000Z', NOW), 'just now');
    assert.equal(relativeTime('2026-02-28T23:00:00.000Z', NOW), '1h ago');
    assert.equal(relativeTime('2026-02-01T00:00:00.000Z', NOW), '28d ago');
    assert.equal(relativeTime('2025-01-01T00:00:00.000Z', NOW), '1y ago');
    assert.equal(relativeTime('not a date', NOW), 'unknown time');
  });

  test('a narrow pane wraps every field instead of dropping it', () => {
    const lines = issueDetailLines({ ...FULL, body: 'alpha beta gamma delta' }, [], {
      width: 12,
      paint: plain,
      emphasis: bold,
      now: NOW,
    });
    // The two chrome markers (the comment rule and `(end of issue)`) are single
    // tokens the caller's own padding clips; every content line is wrapped.
    const chrome = (line) => /^─ /.test(line) || line === '(end of issue)';
    for (const line of lines.filter((entry) => !chrome(entry))) {
      assert.ok([...line].length <= 12, `"${line}" fits 12 cells`);
    }
    assert.match(lines.join('\n'), /assignees:/);
    assert.match(lines.join('\n'), /ana, beto/);
    assert.match(lines.join('\n'), /delta/);
    assert.equal(wrapText('', 20).length, 1, 'an empty body is one blank row, not zero rows');
  });

  test('a comment without an author still names itself honestly', () => {
    const text = render({ number: 5, title: 't' }, [{ body: 'orphan' }]);
    assert.match(text, /─ unknown · unknown time ─/);
    assert.match(text, /orphan/);
  });

  test('a long comment retains its complete body beyond 2000 characters', () => {
    const body = `${'complete comment '.repeat(180)}TAIL_AFTER_2000`;
    const text = render({ number: 5, title: 't' }, [{ body }]);
    assert.ok(text.includes('TAIL_AFTER_2000'), 'sharing the formatter must not truncate a comment');
    const flattened = text.replace(/\s+/g, ' ');
    assert.ok(flattened.includes(body), 'every word survives, not just the final marker');
  });

  test('wrapping a token wider than the preview preserves all its characters', () => {
    const token = 'https://example.test/' + 'x'.repeat(180);
    const lines = wrapText(token, 12);
    assert.equal(lines.join(''), token, 'long tokens wrap rather than losing their suffix');
    assert.ok(lines.every((line) => line.length <= 12));
  });
});
