'use strict';
// T3 (odd-viewer S2,S6) tests: lib/odd-docs.js — discovery and reading of
// the current checkout's odd documents.
//
// Contract under test: only `odd/tasks/*.md` of the given root, recursive
// never, ordered most-recently-modified first with the display name as the
// deterministic tie-break (S10) — an unreadable timestamp is kept and
// ordered by name after the readable ones — each entry carrying the display
// name WITHOUT the extension and path; a root whose `odd/tasks` directory is
// missing reads as an empty list (not an error); a missing or non-directory
// root fails closed; reading returns the file text and an unreadable path
// reports an error instead of empty content.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listOddDocs, readOddDoc } = require('../lib/odd-docs.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-docs-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

// Explicit stamps keep the ordering assertions independent of how fast the
// fixture happens to be written (S10).
function setMtime(root, relative, iso) {
  const when = new Date(iso);
  fs.utimesSync(path.join(root, relative), when, when);
}

describe('listOddDocs', () => {
  test('lists odd/tasks markdown with the display name, file and absolute path, without the extension or path', () => {
    const root = fixture({
      'odd/tasks/beta.md': '# beta\n',
      'odd/tasks/alpha.md': '# alpha\n',
      'odd/notes.md': '# notes\n',
      'odd/tasks/nested/deep.md': '# deep\n',
      'README.md': '# readme\n',
      'odd/tasks/ignored.txt': 'no\n',
    });
    // This test pins membership and row shape, not order: give both
    // documents explicit stamps so the assertion cannot depend on which
    // file the fixture wrote first.
    setMtime(root, 'odd/tasks/beta.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/alpha.md', '2026-02-01T00:00:00Z');
    const result = listOddDocs(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.docs.map((doc) => doc.name), ['alpha', 'beta']);
    assert.deepEqual(result.docs.map((doc) => doc.file), ['alpha.md', 'beta.md']);
    assert.deepEqual(Object.keys(result.docs[0]), ['name', 'file', 'path'], 'ordering changes nothing in the row shape');
    for (const doc of result.docs) {
      assert.ok(path.isAbsolute(doc.path), 'each entry carries an absolute path');
      assert.ok(doc.path.endsWith(path.join('odd', 'tasks', doc.file)));
    }
  });

  test('orders documents by modification time, newest first (S10)', () => {
    const root = fixture({ 'odd/tasks/alpha.md': '# alpha\n', 'odd/tasks/beta.md': '# beta\n' });
    setMtime(root, 'odd/tasks/alpha.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/beta.md', '2026-02-01T00:00:00Z');
    assert.deepEqual(listOddDocs(root).docs.map((doc) => doc.name), ['beta', 'alpha']);
    // Reversing the stamps must reverse the order: the rule is the
    // timestamp, never the directory order or the name.
    setMtime(root, 'odd/tasks/alpha.md', '2026-03-01T00:00:00Z');
    assert.deepEqual(listOddDocs(root).docs.map((doc) => doc.name), ['alpha', 'beta']);
  });

  test('equal modification times fall back to the display name (S10)', () => {
    const root = fixture({
      'odd/tasks/alpha.md': '# alpha\n',
      'odd/tasks/beta.md': '# beta\n',
      'odd/tasks/gamma.md': '# gamma\n',
    });
    setMtime(root, 'odd/tasks/alpha.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/beta.md', '2026-02-01T00:00:00Z');
    setMtime(root, 'odd/tasks/gamma.md', '2026-02-01T00:00:00Z');
    assert.deepEqual(
      listOddDocs(root).docs.map((doc) => doc.name),
      ['beta', 'gamma', 'alpha'],
      'the tied pair keeps name order and still outranks the older document',
    );
  });

  test('a document whose timestamp cannot be read is kept, by name after the readable ones (S10)', () => {
    const root = fixture({
      'odd/tasks/aaa.md': '# aaa\n',
      'odd/tasks/mmm.md': '# mmm\n',
      'odd/tasks/bbb.md': '# bbb\n',
      'odd/tasks/zzz.md': '# zzz\n',
    });
    setMtime(root, 'odd/tasks/aaa.md', '2026-01-01T00:00:00Z');
    setMtime(root, 'odd/tasks/mmm.md', '2026-02-01T00:00:00Z');
    // Deliberately the two newest stamps: an unreadable timestamp must not
    // rank the entry and must never drop it from the list.
    setMtime(root, 'odd/tasks/bbb.md', '2026-03-01T00:00:00Z');
    setMtime(root, 'odd/tasks/zzz.md', '2026-04-01T00:00:00Z');
    const realStat = fs.statSync;
    fs.statSync = (target, ...rest) => {
      if (/[\\/](bbb|zzz)\.md$/.test(String(target))) throw new Error('EACCES: timestamp unreadable');
      return realStat.call(fs, target, ...rest);
    };
    try {
      const docs = listOddDocs(root).docs;
      assert.equal(docs.length, 4, 'no document is dropped for an unreadable timestamp');
      assert.deepEqual(docs.map((doc) => doc.name), ['mmm', 'aaa', 'bbb', 'zzz']);
    } finally {
      fs.statSync = realStat;
    }
  });

  test('a checkout without odd/tasks is an empty list, not an error', () => {
    const root = fixture({ 'README.md': '# readme\n' });
    const result = listOddDocs(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.docs, []);
  });

  test('a missing root fails closed', () => {
    const missing = path.join(os.tmpdir(), `odd-docs-missing-${process.pid}-${Date.now()}`);
    assert.equal(listOddDocs(missing).ok, false);
    assert.equal(listOddDocs('').ok, false);
    assert.equal(listOddDocs(null).ok, false);
  });
});

describe('readOddDoc', () => {
  test('returns the file bytes as text', () => {
    const root = fixture({ 'odd/tasks/alpha.md': '# alpha\n\n## Specs\nS1. text\n' });
    const [doc] = listOddDocs(root).docs;
    const read = readOddDoc(doc);
    assert.equal(read.ok, true);
    assert.match(read.text, /## Specs/);
  });

  test('an unreadable path reports an error instead of empty content', () => {
    const root = fixture({ 'odd/tasks/alpha.md': '# alpha\n' });
    const [doc] = listOddDocs(root).docs;
    fs.rmSync(doc.path);
    const read = readOddDoc(doc);
    assert.equal(read.ok, false);
    assert.equal(typeof read.error, 'string');
    assert.ok(read.error.length > 0);
    assert.equal(read.oddTitle, undefined);
  });
});
