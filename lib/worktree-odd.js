'use strict';
// Odd-document helpers for the worktree tools (customize-command S25-S28,
// S30-S31, worktree-ui-redesign S8).
//
// The registry stores ONE odd document per worktree entry as `odd` (an
// `odd/<rel>` name, as the tool-pipeline capture records it, or `null`).
// This module adds the two read paths the tools share:
// - detection: the `.md` documents inside a checkout's own `odd/`
//   directory, scanned boundedly, returned as `odd/<rel>` names — a LISTING
//   of what the checkout holds, which is not the single association;
// - validation: the OPTIONAL `odd` parameter of `worktree_upsert`, checked
//   for existence exactly like supplied `issues` are (an omitted field
//   means "leave untouched", a supplied value — `null` included — replaces
//   the stored value). It accepts ONE path and refuses a list, because a
//   worktree carries at most one odd document (S8a).
//
// Pure Node, no subprocesses, never throws on unreadable directories:
// an absent `odd/` simply contributes no documents.

const fs = require('node:fs');
const path = require('node:path');

const ODD_DIR_NAME = 'odd';
const ODD_SCAN_MAX_FILES = 500;
const ODD_SCAN_MAX_DEPTH = 10;
const ODD_SCAN_MAX_ENTRIES = 5000;

// Bounded (`.md` only) listing of a checkout's own `odd/` directory,
// returned as `odd/<rel>` names sorted in scan order. Never throws:
// any unreadable directory contributes nothing.
function detectOddDocs(worktreePath) {
  const rels = [];
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return rels;
  const oddDir = path.join(worktreePath, ODD_DIR_NAME);
  const visited = new Set();
  let entriesSeen = 0;
  const stack = [{ dir: oddDir, depth: 0, prefix: '' }];
  while (stack.length > 0
    && rels.length < ODD_SCAN_MAX_FILES
    && entriesSeen < ODD_SCAN_MAX_ENTRIES) {
    const frame = stack.pop();
    const dir = frame.dir;
    const depth = frame.depth;
    const prefix = frame.prefix;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (rels.length >= ODD_SCAN_MAX_FILES || entriesSeen >= ODD_SCAN_MAX_ENTRIES) break;
      entriesSeen += 1;
      const name = entry.name;
      if (!name || name === '.' || name === '..') continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      let isDir = false;
      let isFile = false;
      try {
        isDir = entry.isDirectory();
        isFile = entry.isFile();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth + 1 <= ODD_SCAN_MAX_DEPTH) {
          stack.push({ dir: path.join(dir, name), depth: depth + 1, prefix: rel });
        }
      } else if (isFile && name.endsWith('.md')) {
        rels.push(`odd/${rel}`);
      }
    }
  }
  return rels;
}

// The checkout's own odd documents: the ONE associated document first, then
// everything `odd/` currently holds. This is a LISTING (what a checkout
// offers), never the entity's field — the entity holds one document (S8).
//
// Boundary: `storedOdd` is the row's ALREADY NORMALIZED value — one document
// path string or `null` — as `lib/worktree-registry.js` returns it. A raw
// legacy `odd[]` array is not expected here, but it is tolerated by taking
// its first entry, exactly the migration rule the registry applies, so a
// caller handing an unmigrated row forward loses no association instead of
// silently dropping it. Never throws.
function oddDocsForCheckout(storedOdd, worktreePath) {
  const seen = new Set();
  const out = [];
  const storedDoc = Array.isArray(storedOdd) ? storedOdd[0] : storedOdd;
  const stored = typeof storedDoc === 'string' && storedDoc.length > 0 ? [storedDoc] : [];
  for (const name of stored) {
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  let detected = [];
  try {
    detected = detectOddDocs(worktreePath);
  } catch {
    detected = [];
  }
  for (const name of detected) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Validate the OPTIONAL `odd` parameter of `worktree_upsert`, mirroring the
// supplied-`issues` contract: an omitted field (undefined) leaves the stored
// value untouched; a supplied value — ONE path string, or `null`/`''` for
// "no association" — replaces it. A LIST of documents is refused with a
// clear error instead of silently taking one (S8a), because a worktree
// carries at most one odd document (S8). The single non-empty value must
// name an existing file, resolved against `cwd` when relative (absolute
// inputs resolve directly, never against the process cwd beyond that).
// Returns `{ok:true, omitted:true}` when the caller said nothing,
// `{ok:true, omitted:false, odd}` with the name normalized to `odd/<rel>`
// when it lives under an `odd/` root and to a resolved absolute path
// otherwise (`null` when it clears the association), or `{ok:false, reason}`
// — and validation never writes anything.
function validateOddParam(odd, cwd, opts = {}) {
  if (odd === undefined) return { ok: true, omitted: true, odd: null };
  if (Array.isArray(odd)) {
    return { ok: false, reason: `odd accepts ONE document, not a list: pass the single odd .md file to associate (got ${odd.length} entr${odd.length === 1 ? 'y' : 'ies'})` };
  }
  if (odd === null || odd === '') return { ok: true, omitted: false, odd: null };
  if (typeof odd !== 'string' || odd.length === 0) {
    return { ok: false, reason: `invalid odd document path ${JSON.stringify(odd)}: pass the path of an existing odd .md file` };
  }
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  if (odd.endsWith('.md') === false) {
    return { ok: false, reason: `invalid odd document path ${JSON.stringify(odd)}: pass the path of an existing odd .md file` };
  }
  let absolute;
  try {
    absolute = path.isAbsolute(odd) ? path.resolve(odd) : path.resolve(base, odd);
  } catch {
    return { ok: false, reason: `invalid odd document path ${JSON.stringify(odd)}: pass the path of an existing odd .md file` };
  }
  let isFile = false;
  try {
    isFile = fs.statSync(absolute).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return { ok: false, reason: `odd document not found at ${odd}: pass the path of an existing odd .md file` };
  }
  return { ok: true, omitted: false, odd: normalizeOddName(absolute, opts) };
}

// Display name for one validated odd file: `odd/<rel>` when it lives
// under a known `odd/` root (the worktree's or the principal's, when the
// caller names them), else the resolved absolute path.
function normalizeOddName(absolutePath, opts = {}) {
  const roots = [];
  if (opts && typeof opts.worktreePath === 'string' && opts.worktreePath.length > 0) {
    roots.push(path.resolve(path.join(opts.worktreePath, ODD_DIR_NAME)));
  }
  if (opts && typeof opts.principalRoot === 'string' && opts.principalRoot.length > 0) {
    roots.push(path.resolve(path.join(opts.principalRoot, ODD_DIR_NAME)));
  }
  for (const base of roots) {
    if (absolutePath === base) continue;
    if (absolutePath.startsWith(base + path.sep)) {
      const rel = path.relative(base, absolutePath).split(path.sep).join('/');
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `odd/${rel}`;
    }
  }
  return absolutePath;
}

module.exports = {
  ODD_DIR_NAME,
  detectOddDocs,
  oddDocsForCheckout,
  validateOddParam,
  normalizeOddName,
};
