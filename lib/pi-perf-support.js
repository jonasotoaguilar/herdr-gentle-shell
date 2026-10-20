#!/usr/bin/env node
'use strict';

// Does the installed Pi build actually declare each performance setting this
// package writes?
//
// The customize panel can only promise what this package can observe. On a Pi
// build that never reads `heightIndex`, `evictOffscreenLines`,
// `expandRecentToolOutput` or `incrementalSearchCorpus`, a row that says ON is
// an effect the package cannot deliver, so the panel and the trace need a
// per-key answer from the shipped package itself. The checkable half is
// "does any shipped file mention the key" — not "does the optimisation work",
// because a minified bundle could rename a setting internally while still
// reading it.
//
// Three states, and the distinction between the last two is the point:
//   declared — a shipped file mentions the key;
//   absent   — the whole package was inspected and nothing mentions it;
//   unknown  — the scan could not look (no package, unparsable metadata, file
//              or byte budget exhausted). A partial scan is NEVER 'absent'.
//
// Which package: the Pi that is executing this code, because a verdict about a
// package the user is not running is worse than 'unknown'. Resolution order is
// the running entry script's tree, then the highest release under
// PI_MANAGED_INSTALL_ROOT, then plain require resolution as a last resort.
//
// Bounded by design: no shell, no child process, no writes, a fixed walk order,
// a file and byte budget, `node_modules` and binary-looking files skipped.

const fs = require('node:fs');
const path = require('node:path');

// The single authority for the four key names: the settings writer's array, so
// the panel, the writer and this scanner can never drift apart.
const { PERF_KEYS } = require('./pi-perf-settings.js');

const PACKAGE_NAME = '@earendil-works/pi-coding-agent';
// How far above the entry script the package may sit:
// <release>/node_modules/@earendil-works/pi-coding-agent = 3 levels, plus slack
// for a launcher that runs from deeper inside (dist/bundle/cli.js).
const ENTRY_WALK_DEPTH = 8;
// Sized to inspect the whole shipped package on current Pi releases (about
// 760 text files / 14 MiB) so 'absent' is a real verdict; anything larger stops
// as 'unknown' instead of silently sampling.
const DEFAULT_MAX_FILES = 1500;
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const SNIFF_BYTES = 4096;
const CACHE_LIMIT = 8;
const SKIPPED_DIRS = new Set(['node_modules', '.git']);
// Extension-only skips are pure economy: the sniff below catches the rest.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.wasm', '.node', '.so', '.dylib', '.dll', '.exe', '.bin', '.dat',
  '.gz', '.tgz', '.zip', '.tar', '.bz2', '.xz', '.7z',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.mp3', '.mp4', '.webm', '.mov', '.sqlite', '.db', '.pyc', '.class',
]);

const cache = new Map();

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function byteLimit(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// Does this directory hold the package's metadata? The single check every
// resolution strategy below agrees on.
function shipsPackage(candidate) {
  try {
    return fs.statSync(path.join(candidate, 'package.json')).isFile();
  } catch {
    return false;
  }
}

function packageCandidate(parent) {
  return path.join(parent, 'node_modules', ...PACKAGE_NAME.split('/'));
}

// The Pi that is executing this code is the only answer that describes what the
// user runs: the module graph may load this package from a dev dependency or a
// source checkout, but the entry script sits inside the running release.
function runningPiRoot(argv1) {
  if (typeof argv1 !== 'string' || argv1.length === 0) return null;
  let start;
  try {
    const real = fs.realpathSync(argv1);
    start = fs.statSync(real).isDirectory() ? real : path.dirname(real);
  } catch {
    return null;
  }
  let dir = start;
  for (let depth = 0; depth <= ENTRY_WALK_DEPTH; depth += 1) {
    const candidate = packageCandidate(dir);
    if (shipsPackage(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Releases are version-named directories, so ordering them as strings would put
// 0.9.0 above 1.10.0. Numeric per dot segment, descending; a segment that is not
// a plain number (a prerelease tail) ranks below the numeric release.
function compareVersionsDesc(left, right) {
  const a = left.split('.');
  const b = right.split('.');
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] === undefined ? '0' : a[i];
    const y = b[i] === undefined ? '0' : b[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(y) - Number(x);
      if (diff !== 0) return diff;
      continue;
    }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? 1 : -1;
  }
  return 0;
}

// The managed pi wrapper exports PI_MANAGED_INSTALL_ROOT (= <agent-dir>/install)
// and keeps every release under <root>/releases/<version>/. The highest release
// that actually ships the package is the installed one, even when several
// versions are still on disk.
function managedInstallRoot(env) {
  const configured = env && typeof env === 'object' ? env.PI_MANAGED_INSTALL_ROOT : undefined;
  if (typeof configured !== 'string' || configured.trim().length === 0) return null;
  const releasesDir = path.join(configured.trim(), 'releases');
  let entries;
  try {
    entries = fs.readdirSync(releasesDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareVersionsDesc);
  for (const version of versions) {
    const candidate = packageCandidate(path.join(releasesDir, version));
    if (shipsPackage(candidate)) return candidate;
  }
  return null;
}

// Last resort only: the same Node resolution the package already relies on for
// its peers, which in a checkout or a plugin host answers for whatever package
// happens to be reachable — not necessarily the one that is running.
function resolveInstalledRoot() {
  let bases = [];
  try {
    bases = require.resolve.paths(PACKAGE_NAME) || [];
  } catch {
    return null;
  }
  for (const base of bases) {
    const candidate = path.join(base, ...PACKAGE_NAME.split('/'));
    if (shipsPackage(candidate)) return candidate;
  }
  return null;
}

// Resolves the root and its version. Any failure here is a failed scan, never
// an absent key: nothing was inspected.
function locate(options) {
  const explicit = options.piRoot;
  let root = null;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== 'string' || explicit.length === 0) {
      return { ok: false, error: 'piRoot must be a non-empty directory path' };
    }
    root = explicit;
  } else {
    root = runningPiRoot(options.argv1) || managedInstallRoot(options.env) || resolveInstalledRoot();
    if (!root) return { ok: false, error: `cannot resolve the installed ${PACKAGE_NAME}` };
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (err) {
    return { ok: false, error: `cannot resolve ${root}: ${err.message}` };
  }
  let raw;
  try {
    raw = fs.readFileSync(path.join(realRoot, 'package.json'), 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read ${path.join(realRoot, 'package.json')}: ${err.message}` };
  }
  let pkg;
  try {
    pkg = JSON.parse(stripBom(raw));
  } catch (err) {
    return { ok: false, error: `cannot parse ${path.join(realRoot, 'package.json')}: ${err.message}` };
  }
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
    return { ok: false, error: `cannot parse ${path.join(realRoot, 'package.json')}: top-level JSON must be an object` };
  }
  const version = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(realRoot).mtimeMs;
  } catch (err) {
    return { ok: false, error: `cannot stat ${realRoot}: ${err.message}` };
  }
  return { ok: true, root: realRoot, version, mtimeMs };
}

function isBinary(name, buffer) {
  if (BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
  const limit = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function countOccurrences(text, needle) {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

function sortedEntries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Walks the shipped files in a deterministic order. Returns one count per key,
// the first file that mentions it, and which budget (if any) stopped the walk.
function scanTree(root, keys, maxFiles, maxBytes) {
  const found = new Map();
  let files = 0;
  let bytes = 0;
  let budget = null;
  const pending = [root];

  while (pending.length > 0 && budget === null) {
    const dir = pending.pop();
    let entries;
    try {
      entries = sortedEntries(dir);
    } catch {
      // An unreadable subdirectory leaves the scan incomplete, so the answer
      // for a key that is still missing must be 'unknown'.
      budget = 'unreadable';
      break;
    }
    const subdirs = [];
    for (const entry of entries) {
      // Symlinks leave the package boundary or duplicate content already seen.
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) subdirs.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      if (files >= maxFiles) {
        budget = 'file';
        break;
      }
      files += 1;
      const relative = path.relative(root, abs).split(path.sep).join('/');
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      let buffer;
      try {
        const size = fs.statSync(abs).size;
        if (bytes + size > maxBytes) {
          budget = 'byte';
          break;
        }
        buffer = fs.readFileSync(abs);
      } catch {
        budget = 'unreadable';
        break;
      }
      bytes += buffer.length;
      if (isBinary(entry.name, buffer)) continue;
      const text = buffer.toString('utf8');
      for (const key of keys) {
        const count = countOccurrences(text, key);
        if (count === 0) continue;
        const existing = found.get(key);
        if (existing) existing.total += count;
        else found.set(key, { file: relative, matches: count, total: count });
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i -= 1) pending.push(subdirs[i]);
  }

  return { found, files, bytes, budget };
}

function budgetEvidence(budget, scan, maxFiles, maxBytes) {
  if (budget === 'file') return `file budget exhausted after ${scan.files} files (maxFiles=${maxFiles})`;
  if (budget === 'byte') return `byte budget exhausted after ${scan.bytes} bytes (maxBytes=${maxBytes})`;
  return 'scan stopped on an unreadable path';
}

function verdicts(keys, scan, maxFiles, maxBytes) {
  const out = {};
  for (const key of keys) {
    const hit = scan.found.get(key);
    if (hit) {
      out[key] = Object.freeze({
        state: 'declared',
        evidence: `${hit.file} (${hit.matches} ${hit.matches === 1 ? 'match' : 'matches'})`,
      });
    } else if (scan.budget) {
      out[key] = Object.freeze({ state: 'unknown', evidence: budgetEvidence(scan.budget, scan, maxFiles, maxBytes) });
    } else {
      out[key] = Object.freeze({ state: 'absent', evidence: `no match in ${scan.files} scanned files` });
    }
  }
  return out;
}

function unknownKeys(reason) {
  const out = {};
  for (const key of PERF_KEYS) out[key] = Object.freeze({ state: 'unknown', evidence: `scan failed: ${reason}` });
  return out;
}

function failure(reason) {
  return { ok: false, error: reason, keys: unknownKeys(reason) };
}

// Cache key: a rescanned package can only differ if its root moved, its version
// changed or its top-level directory changed. Editing a file in place does not
// touch the directory mtime, which is why the reset hook exists for tests.
function cacheKey(root, version, mtimeMs) {
  return `${root}\u0000${version}\u0000${mtimeMs}`;
}

function remember(key, result) {
  cache.set(key, result);
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return result;
}

function resetSupportCacheForTests() {
  cache.clear();
}

function scanSupport(options) {
  let opts;
  if (options === undefined || options === null) opts = {};
  else if (typeof options === 'object' && !Array.isArray(options)) opts = options;
  else return failure('scanSupport expects an options object');
  const keys = opts.keys === undefined ? PERF_KEYS : opts.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return failure(`keys must be a non-empty array of performance settings; known keys: ${PERF_KEYS.join(', ')}`);
  }
  for (const key of keys) {
    if (!PERF_KEYS.includes(key)) {
      return failure(`unknown performance setting ${key}; known keys: ${PERF_KEYS.join(', ')}`);
    }
  }
  const maxFiles = byteLimit(opts.maxFiles, DEFAULT_MAX_FILES);
  const maxBytes = byteLimit(opts.maxBytes, DEFAULT_MAX_BYTES);

  try {
    const located = locate({
      piRoot: opts.piRoot,
      argv1: opts.argv1 === undefined ? process.argv[1] : opts.argv1,
      env: opts.env === undefined ? process.env : opts.env,
    });
    if (!located.ok) return failure(located.error);

    const key = cacheKey(located.root, located.version, located.mtimeMs);
    // The cache holds every key so a caller asking for a subset reuses the same
    // scan, and the requested subset is projected out of it per call.
    let cached = cache.get(key);
    if (!cached) {
      const scan = scanTree(located.root, PERF_KEYS, maxFiles, maxBytes);
      cached = remember(key, {
        ok: true,
        piVersion: located.version,
        root: located.root,
        keys: Object.freeze(verdicts(PERF_KEYS, scan, maxFiles, maxBytes)),
      });
    }
    const selected = {};
    for (const name of keys) selected[name] = cached.keys[name];
    return { ok: true, piVersion: cached.piVersion, root: cached.root, keys: Object.freeze(selected) };
  } catch (err) {
    // Nothing here may throw into a rendering path.
    return failure(`scan failed: ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { PERF_KEYS, scanSupport, resetSupportCacheForTests };
