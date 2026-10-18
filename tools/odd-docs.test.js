'use strict';
// T3 (odd-viewer S2,S6) tests: lib/odd-docs.js — discovery and reading of
// the current checkout's odd documents.
//
// Contract under test: only `odd/tasks/*.md` of the given root, recursive
// never, sorted by name, each entry carrying the display name WITHOUT the
// extension and path; a root whose `odd/tasks` directory is missing reads
// as an empty list (not an error); a missing or non-directory root fails
// closed; reading returns the file text and an unreadable path reports an
// error instead of empty content.

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

describe('listOddDocs', () => {
  test('lists odd/tasks markdown by display name, without the extension or path', () => {
    const root = fixture({
      'odd/tasks/beta.md': '# beta\n',
      'odd/tasks/alpha.md': '# alpha\n',
      'odd/notes.md': '# notes\n',
      'odd/tasks/nested/deep.md': '# deep\n',
      'README.md': '# readme\n',
      'odd/tasks/ignored.txt': 'no\n',
    });
    const result = listOddDocs(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.docs.map((doc) => doc.name), ['alpha', 'beta']);
    assert.deepEqual(result.docs.map((doc) => doc.file), ['alpha.md', 'beta.md']);
    for (const doc of result.docs) {
      assert.ok(path.isAbsolute(doc.path), 'each entry carries an absolute path');
      assert.ok(doc.path.endsWith(path.join('odd', 'tasks', doc.file)));
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
