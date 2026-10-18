'use strict';
// Focused-checkout facts for the warp selector (warp-popup W1 — S2, S4, S9).
//
// One call yields everything the selector's footer shows for ONE checkout:
// the branch, the registry's assigned issues and odd documents, when the
// checkout was created, its last activity, its uncommitted-change summary
// (the file count plus the added/deleted LINE counts of the tracked diff and
// of every untracked file, S16), and the commits it is ahead of / behind a
// base branch. Each fact is its
// own envelope — `{available:true, value, reason:null}` or
// `{available:false, value:null, reason}` — because S9 forbids rendering an
// unreadable value as a number. A failing git read, a missing registry row
// or a malformed registry is therefore "unavailable", never zero and never
// an empty list. Facts fail independently: a broken registry leaves the git
// facts intact and vice versa. Two facts carry a `source` beside the
// envelope so a reader can tell where the value came from: `createdAt` is
// the registry row (`source:'registry'`) or, with no row, the directory's
// birth time (`source:'birthtime'`), and `lastActivity` is the winning side
// of `last commit` vs `newest uncommitted file` (S12).
//
// Cost control (S9 again): the expensive reads — `summarizeChanges` spawns
// two git processes, ahead/behind spawns up to two more, the last-commit
// read one — only ever run for the checkout the caller names, and the whole
// per-path result is cached for `ttlMs`, so a selector that repaints per
// keystroke does not re-spawn git. The dirty summary is computed once and
// feeds both `changes` and the dirty side of `lastActivity`; the birth-time
// fallback is only stat'ed when there is no registry row.
// Concurrent callers for the same path share one in-flight read. `facts()`
// is async (the git work is awaited, never spawned inline) and `peek()`
// answers from the cache synchronously at paint time.
//
// Reuse, not duplication: the dirty summary comes from
// lib/worktree-changes.js, the registry rows from lib/worktree-registry.js,
// the branch from `listWorktrees`, and the comparison from
// lib/worktree-git.js's `aheadBehind`. The two synchronous reads (registry
// file, `git worktree list`) are local and network-free; every net-capable
// or heavier read is async.

const path = require('node:path');
const fs = require('node:fs');

const gitLib = require('./worktree-git.js');
const changesLib = require('./worktree-changes.js');
const registryLib = require('./worktree-registry.js');

const DEFAULT_TTL_MS = 5000;

function available(value) {
  return { available: true, value, reason: null };
}

function unavailable(reason) {
  const text = typeof reason === 'string' && reason.length > 0 ? reason : 'unavailable';
  return { available: false, value: null, reason: text };
}

function errorText(err) {
  return (err && err.message) || String(err);
}

// Awaits a seam that may be sync or async and never lets a rejection escape.
async function attempt(fn, label) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: `${label}: ${errorText(err)}` };
  }
}

// Build a facts provider for one repository.
//
// Options (every seam is injectable so tests and hosts can substitute it):
//   repoRoot        repository whose registry and worktree listing are read
//   readRegistry    (repoRoot) -> {ok, worktrees, error}
//   listWorktrees   (repoRoot) -> [{path, branch, detached}]
//   summarize       (checkoutPath) -> Promise<summary> (worktree-changes shape)
//   aheadBehind     (checkoutPath) -> Promise<{ok, ahead, behind, base}>
//   lastCommit      (checkoutPath) -> Promise<{ok, timestampMs}> (git log -1)
//   fs              fs seam for the createdAt birth-time fallback (statSync)
//   runAsync        git runner forwarded to the default git seams
//   ttlMs           cache lifetime in ms (default 5000)
//   now             clock in ms (default Date.now)
function createCheckoutFacts(opts = {}) {
  const repoRoot = typeof opts.repoRoot === 'string' && opts.repoRoot.length > 0 ? opts.repoRoot : null;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const runAsync = typeof opts.runAsync === 'function' ? opts.runAsync : null;
  const fsImpl = opts.fs && typeof opts.fs.statSync === 'function' ? opts.fs : fs;

  const readRegistry = typeof opts.readRegistry === 'function'
    ? opts.readRegistry
    : (root) => registryLib.readRegistry(root);
  const listWorktrees = typeof opts.listWorktrees === 'function'
    ? opts.listWorktrees
    : (root) => gitLib.listWorktrees(root);
  const summarize = typeof opts.summarize === 'function'
    ? opts.summarize
    : (checkout) => changesLib.summarizeChanges(checkout, runAsync ? { runAsync } : {});
  const aheadBehind = typeof opts.aheadBehind === 'function'
    ? opts.aheadBehind
    : (checkout) => gitLib.aheadBehind(checkout, runAsync ? { runAsync } : {});
  const lastCommit = typeof opts.lastCommit === 'function'
    ? opts.lastCommit
    : (checkout) => gitLib.lastCommitTime(checkout, runAsync ? { runAsync } : {});

  const cache = new Map(); // absolute checkout path -> {at, facts}
  const inFlight = new Map(); // absolute checkout path -> Promise<facts>

  // Absolute spelling used as the cache key and reported back to the
  // caller; an unusable input stays as the caller wrote it.
  function keyOf(checkoutPath) {
    if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) return null;
    return path.resolve(checkoutPath);
  }

  // The listing entry for exactly this checkout (resolve-equality, the
  // same rule the registry's findByPath uses). Unavailable when the
  // listing fails or the path is not a checkout git knows about.
  async function branchFact(checkout) {
    const listed = await attempt(() => listWorktrees(repoRoot || checkout), 'git worktree list');
    if (!listed.ok) return unavailable(listed.error);
    const entries = Array.isArray(listed.value) ? listed.value : [];
    const entry = entries.find((candidate) => candidate && typeof candidate.path === 'string'
      && path.isAbsolute(candidate.path)
      && path.resolve(candidate.path) === checkout);
    if (!entry) return unavailable(`not a known checkout: ${checkout}`);
    // A detached HEAD has no branch name; saying "detached" is honest,
    // inventing a name is not.
    return { ...available(entry.branch), detached: entry.detached === true };
  }

  // Registry row for this checkout. `ok:false` (malformed/unreadable
  // registry) and "no row" are different reasons but the same verdict:
  // the registry facts are unavailable.
  function registryRow(checkout) {
    let read;
    try {
      read = readRegistry(repoRoot || checkout);
    } catch (err) {
      return { row: null, reason: `registry: ${errorText(err)}` };
    }
    if (!read || read.ok !== true) {
      const reason = (read && read.error) || 'cannot read registry';
      return { row: null, reason };
    }
    const rows = Array.isArray(read.worktrees) ? read.worktrees : [];
    const row = rows.find((candidate) => candidate && typeof candidate.path === 'string'
      && path.isAbsolute(candidate.path)
      && path.resolve(candidate.path) === checkout);
    if (!row) return { row: null, reason: 'no registry entry for this checkout' };
    return { row, reason: null };
  }

  function registryFacts(checkout) {
    const { row, reason } = registryRow(checkout);
    if (!row) {
      return {
        row: null,
        reason,
        issues: unavailable(reason),
        odd: unavailable(reason),
      };
    }
    const issues = Array.isArray(row.issues) ? available(row.issues.slice()) : unavailable('registry entry has no issues list');
    const odd = Array.isArray(row.odd) ? available(row.odd.slice()) : unavailable('registry entry has no odd documents list');
    return { row, reason: null, issues, odd };
  }

  // When the checkout was recorded (S12): the registry row first, the
  // directory's birth time otherwise. `source` names which one answered, so
  // a recorded registration is distinguishable from a filesystem birth
  // time; with neither readable the fact stays unavailable.
  function birthTimeMs(checkout) {
    try {
      const ms = Number(fsImpl.statSync(checkout).birthtimeMs);
      if (Number.isFinite(ms) && ms > 0) return ms;
    } catch {
      // A checkout that cannot be stat'ed has no birth time to report.
    }
    return null;
  }

  function createdAtFact(checkout, row, registryReason) {
    if (row && typeof row.createdAt === 'string' && row.createdAt.length > 0) {
      return { ...available(row.createdAt), source: 'registry' };
    }
    const birth = birthTimeMs(checkout);
    if (birth === null) {
      return { ...unavailable(registryReason || 'no registry entry and no readable birth time'), source: null };
    }
    return { ...available(new Date(birth).toISOString()), source: 'birthtime' };
  }

  // The mtime of the most recently modified uncommitted file in the summary,
  // or null when nothing still exists. Reads the SAME summary the `changes`
  // fact already computed, so last activity never spawns git a second time
  // for the dirty side.
  function latestDirtyMtime(entries) {
    let latest = null;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      let ms;
      try {
        ms = Number(fsImpl.statSync(entry.path).mtimeMs);
      } catch {
        continue; // Deleted since the summary; it contributes nothing.
      }
      if (Number.isFinite(ms) && ms > 0 && (latest === null || ms > latest)) latest = ms;
    }
    return latest;
  }

  // The shared summary measures each untracked file from disk and reports an
  // UNREADABLE one as zero added lines — indistinguishable from an empty
  // file. S16 forbids counting that as a zero, so the untracked entries the
  // summary measured as zero lines are re-opened here: a file that still
  // exists but cannot be read makes the whole fact unavailable, naming the
  // path, instead of a fake zero. Binary files are labelled, not counted, and
  // a file gone since the summary contributes nothing.
  function unreadableUntracked(entries, fsImpl) {
    if (typeof fsImpl.readFileSync !== 'function') return null;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.untracked !== true || typeof entry.path !== 'string') continue;
      if (Number(entry.added) !== 0 || entry.binary === true) continue;
      try {
        fsImpl.readFileSync(entry.path);
      } catch {
        try {
          fsImpl.statSync(entry.path);
        } catch {
          continue; // Gone since the summary; it contributes nothing.
        }
        return entry.rel || entry.path;
      }
    }
    return null;
  }

  async function changesRead(checkout) {
    const summary = await attempt(() => summarize(checkout), 'uncommitted changes');
    if (!summary.ok) return { fact: unavailable(summary.error), latestMtimeMs: null };
    const value = summary.value;
    if (!value || value.ok !== true) {
      return {
        fact: unavailable(`uncommitted changes: ${(value && value.error) || 'unreadable summary'}`),
        latestMtimeMs: null,
      };
    }
    const unreadable = unreadableUntracked(value.entries, fsImpl);
    if (unreadable !== null) {
      return {
        fact: unavailable(`uncommitted changes: cannot read untracked file ${JSON.stringify(unreadable)}`),
        latestMtimeMs: null,
      };
    }
    return {
      fact: available({
        files: value.files,
        added: value.added,
        deleted: value.deleted,
        binaryCount: value.binaryCount || 0,
        text: changesLib.formatChangeSummary(value),
      }),
      latestMtimeMs: latestDirtyMtime(value.entries),
    };
  }

  // The last commit timestamp as an internal `{ok, ms, reason}` so the
  // activity fact can merge it with the dirty mtimes behind one read.
  async function commitRead(checkout) {
    const read = await attempt(() => lastCommit(checkout), 'last commit');
    if (!read.ok) return { ok: false, reason: read.error };
    const value = read.value;
    if (!value || value.ok !== true) {
      return { ok: false, reason: `last commit: ${(value && value.error) || 'unreadable commit'}` };
    }
    const ms = Number(value.timestampMs);
    if (!Number.isFinite(ms) || ms < 0) return { ok: false, reason: 'last commit: unreadable timestamp' };
    return { ok: true, ms };
  }

  // Last activity (S12): the greater of the last commit timestamp and the
  // mtime of the most recently modified uncommitted file. `source` records
  // which side won; with neither readable the fact is unavailable, never a
  // zero time.
  function activityFact(commit, dirtyMs) {
    const candidates = [];
    if (commit.ok) candidates.push({ ms: commit.ms, source: 'commit' });
    if (Number.isFinite(dirtyMs)) candidates.push({ ms: dirtyMs, source: 'dirty' });
    if (candidates.length === 0) {
      return unavailable(commit.reason || 'no commit and no uncommitted file to read');
    }
    let winner = candidates[0];
    for (const candidate of candidates) {
      if (candidate.ms > winner.ms) winner = candidate;
    }
    return { ...available(new Date(winner.ms).toISOString()), source: winner.source };
  }

  async function aheadBehindFact(checkout) {
    const compared = await attempt(() => aheadBehind(checkout), 'commits ahead/behind');
    if (!compared.ok) return unavailable(compared.error);
    const value = compared.value;
    if (!value || value.ok !== true) {
      return unavailable(`commits ahead/behind: ${(value && value.error) || 'unreadable comparison'}`);
    }
    return available({
      ahead: value.ahead, behind: value.behind, base: value.base, baseSource: value.baseSource,
    });
  }

  async function read(checkout) {
    const startedAt = now();
    // The expensive git reads run together but only for THIS checkout; the
    // cheap registry/listing reads run alongside them. The dirty summary is
    // computed once and feeds both `changes` and the dirty side of
    // `lastActivity`.
    const [branch, registry, changes, compared, commit] = await Promise.all([
      branchFact(checkout),
      Promise.resolve(registryFacts(checkout)),
      changesRead(checkout),
      aheadBehindFact(checkout),
      commitRead(checkout),
    ]);
    return {
      checkout,
      fetchedAt: startedAt,
      cached: false,
      branch,
      issues: registry.issues,
      odd: registry.odd,
      createdAt: createdAtFact(checkout, registry.row, registry.reason),
      lastActivity: activityFact(commit, changes.latestMtimeMs),
      changes: changes.fact,
      aheadBehind: compared,
    };
  }

  function fresh(entry) {
    return entry !== null && now() - entry.at < ttlMs;
  }

  function clone(entry, extra) {
    return { ...entry.facts, cached: true, ...extra };
  }

  // Resolve the facts for one checkout: cached within the TTL, the shared
  // in-flight read while one is running, otherwise a fresh read.
  async function facts(checkoutPath) {
    const checkout = keyOf(checkoutPath);
    if (checkout === null) {
      return {
        checkout: checkoutPath === undefined ? null : checkoutPath,
        fetchedAt: now(),
        cached: false,
        branch: unavailable('checkout path is empty'),
        issues: unavailable('checkout path is empty'),
        odd: unavailable('checkout path is empty'),
        createdAt: unavailable('checkout path is empty'),
        lastActivity: unavailable('checkout path is empty'),
        changes: unavailable('checkout path is empty'),
        aheadBehind: unavailable('checkout path is empty'),
      };
    }
    const entry = cache.get(checkout);
    if (entry && fresh(entry)) return clone(entry);
    const pending = inFlight.get(checkout);
    if (pending) return clone({ facts: await pending });
    const promise = read(checkout);
    inFlight.set(checkout, promise);
    try {
      const values = await promise;
      cache.set(checkout, { at: now(), facts: values });
      return values;
    } finally {
      inFlight.delete(checkout);
    }
  }

  // Synchronous paint-time read of the cache: null when nothing was read
  // yet, `stale:true` when the entry is past its TTL (the caller may show
  // it and refresh in the background, but is told it is old).
  function peek(checkoutPath) {
    const checkout = keyOf(checkoutPath);
    if (checkout === null) return null;
    const entry = cache.get(checkout);
    if (!entry) return null;
    return clone(entry, { stale: !fresh(entry) });
  }

  // Drop one checkout's cached facts, or all of them (after a create, a
  // registry edit or a commit the selector itself performed).
  function invalidate(checkoutPath) {
    const checkout = keyOf(checkoutPath);
    if (checkout === null) {
      cache.clear();
      return;
    }
    cache.delete(checkout);
  }

  return { facts, peek, invalidate, ttlMs };
}

module.exports = { createCheckoutFacts, DEFAULT_TTL_MS };
