'use strict';
// Odd document discovery (odd-viewer S2,S6).
//
// Scope is the CHECKOUT the session runs in: `<root>/odd/tasks/*.md`, not
// recursive, never the principal checkout when the session sits in a
// worktree. The caller resolves the root (the command uses the session cwd
// resolved to its Git root); this module only reads what it is given, so it
// stays testable on plain fixture directories and never touches Git.
//
// Every failure mode is explicit and read-only: a missing or non-directory
// root fails closed, an absent `odd/tasks` directory is an empty list (a
// checkout simply without documents), and an unreadable document reports an
// error rather than rendering empty content.

const fs = require('node:fs');
const path = require('node:path');

const TASKS_DIR = path.join('odd', 'tasks');

// Ordered most-recently-modified first (S10), with the display name as the
// deterministic tie-break: every consumer inherits the order from here
// instead of re-sorting its own view. A document whose timestamp cannot be
// read is kept and placed after the readable ones (ordered by name) — the
// list never hides a document over a stat failure.
function listOddDocs(root) {
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) {
    return { ok: false, reason: 'no-checkout', docs: [] };
  }
  let stats = null;
  try {
    stats = fs.statSync(root);
  } catch {
    return { ok: false, reason: 'no-checkout', docs: [] };
  }
  if (!stats.isDirectory()) return { ok: false, reason: 'no-checkout', docs: [] };
  const dir = path.join(root, TASKS_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    // No odd/tasks directory (or an unreadable one): an empty list, not a
    // failure — the view renders its own empty state.
    return { ok: true, root, docs: [] };
  }
  const docs = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    try {
      // A directory named `x.md` is not a document; neither is a symlink to
      // one, so a broken or circular link can never enter the list.
      const entry = fs.lstatSync(full);
      if (!entry.isFile()) continue;
    } catch {
      continue;
    }
    docs.push({ name: name.replace(/\.md$/i, ''), file: name, path: full });
  }
  // The ordering key stays OUT of the row shape; only the sequence changes.
  const keyed = docs.map((doc) => ({ doc, mtime: readMtime(doc.path) }));
  keyed.sort(compareByRecency);
  return { ok: true, root, docs: keyed.map((entry) => entry.doc) };
}

// Modification time in ms, or null when it cannot be read.
function readMtime(target) {
  try {
    const stats = fs.statSync(target);
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

function compareByRecency(left, right) {
  const a = left.mtime;
  const b = right.mtime;
  if (a !== null && b !== null && a !== b) return b - a;
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  return left.doc.name < right.doc.name ? -1 : left.doc.name > right.doc.name ? 1 : 0;
}

function readOddDoc(doc) {
  const target = doc && typeof doc.path === 'string' ? doc.path : null;
  if (!target) return { ok: false, error: 'no document selected' };
  try {
    const text = fs.readFileSync(target, 'utf8');
    return { ok: true, text };
  } catch (err) {
    const detail = err && err.message ? err.message : 'unreadable';
    return { ok: false, error: detail };
  }
}

module.exports = { listOddDocs, readOddDoc, TASKS_DIR };
