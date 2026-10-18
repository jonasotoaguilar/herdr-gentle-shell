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

// Sorted by display name so the list is deterministic across filesystems.
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
  docs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { ok: true, root, docs };
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
