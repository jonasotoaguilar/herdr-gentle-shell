'use strict';
// Open-issue cache shared by the issues viewer and the worktree detail
// (worktree-ui-redesign S10, S7c, S7d).
//
// Why a cache at all: at session start every OPEN issue is loaded once, then
// each `/issues` open (and each entry into a worktree detail) only asks `gh`
// for the newest margin and merges it, so checking whether an assignment is
// still open stops re-listing the whole repository on every render.
//
// `createIssuesCache({ fetchAll, fetchRecent, pageSize, recentLimit, now })`
// keeps this module pure: no disk, no timers, no shell, no spawn. Both
// fetchers are injected and are called as `fn({...})`:
// - `fetchAll({ pageSize })` must resolve to EVERY open issue of the
//   repository — the complete snapshot, which is what lets an issue absent
//   from a later snapshot be recognised as no longer open. A fetcher that
//   cannot prove completeness (a bounded read that filled its bound, a
//   partial page) must resolve `{ ok: false }` instead of a short list:
//   `prime()` treats absence as evidence, so a samples-as-success answer
//   would tombstone stored associations;
// - `fetchRecent({ limit })` must resolve to at most the `limit` most
//   recently updated issues, and it MAY include closed ones (that is how a
//   closure is reported, next to a record whose `state` says `closed`).
// A fetcher resolves to `{ ok, issues, error }`; anything else — a thrown
// error, `null`, a non-list `issues`, a result without `ok: true` — is a
// reported failure, never a silent empty list. `recentLimit` defaults to 20
// (S10 names a 10-20 margin) and `now` defaults to `Date.now`.
//
// Contract:
// - `prime()` loads the full open set, seeds the cache and returns
//   `{ ok, count, error }`.
// - `refresh()` loads only the recent margin, merges it and returns
//   `{ ok, added, updated, closed, error }`, where `added` counts issues that
//   were not open before, `updated` those whose record was replaced and
//   `closed` those that LEFT the open set.
// - `all()` returns the merged open issues, newest `updatedAt` first (newest
//   number first on a tie), as copies.
// - `isOpen(n)` / `stateOf(n)` answer from the cache alone; a number no fetch
//   has ever reported is `'unknown'`, never assumed open.
// - `revalidate(numbers)` splits a worktree's stored association into
//   `{ keep, drop, unknown }`, preserving the caller's order: `keep` is known
//   open, `drop` is known closed (closed, deleted or absent from the
//   repository), and `unknown` holds every number the cache cannot answer
//   for — reported so the caller fetches precisely those instead of dropping
//   them silently.
// - `reset()` forgets everything; `stats()` reports `{ primed, size,
//   lastRefresh }`, where `lastRefresh` is the last successful load (prime or
//   refresh) as `now()` returned it, or null.
//
// Merge rules: keyed by issue number, a later record replaces the earlier
// one, and a record the fetch reports as CLOSED leaves the open set and is
// remembered as closed, so `isOpen` answers without a refetch. A closed issue
// is only reopened by evidence NEWER than the closure's own `updatedAt`, so a
// stale cache entry can never resurrect it.
//
// Nothing here throws, and a failed fetch never mutates the cache.

const DEFAULT_RECENT_LIMIT = 20;

function parseTime(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

// Only a positive integer is an issue number; a string, a zero or a fraction
// is not something the cache can answer about.
function issueNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

// A record is evidence only when it names a number and a state we understand.
// An absent state means open: both fetchers are open-scoped unless they say
// otherwise, and `closed` is the only state a fetch has to spell out.
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const number = issueNumber(raw.number);
  if (number === 0) return null;
  const rawState = typeof raw.state === 'string' ? raw.state.trim().toLowerCase() : '';
  let state = '';
  if (rawState === '' || rawState === 'open') state = 'open';
  else if (rawState === 'closed') state = 'closed';
  else return null;
  return { ...raw, number, state };
}

// A closure with a known timestamp is overturned only by strictly newer
// evidence; when the recorded closure carries no timestamp there is nothing
// to compare, so the later arrival wins (the base merge rule).
function beatsClosure(incoming, closure) {
  const incomingTime = parseTime(incoming.updatedAt);
  const closureTime = closure ? parseTime(closure.updatedAt) : null;
  if (closureTime === null) return true;
  if (incomingTime === null) return false;
  return incomingTime > closureTime;
}

function compareRecords(left, right) {
  const a = parseTime(left.updatedAt);
  const b = parseTime(right.updatedAt);
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  }
  return right.number - left.number;
}

function createIssuesCache(options = {}) {
  const config = options && typeof options === 'object' ? options : {};
  const fetchAll = config.fetchAll;
  const fetchRecent = config.fetchRecent;
  const pageSize = config.pageSize;
  const recentLimit = issueNumber(config.recentLimit) || DEFAULT_RECENT_LIMIT;
  const now = typeof config.now === 'function' ? config.now : () => Date.now();

  // `open` holds the merged open set; `closed` remembers known-closed numbers
  // together with the record that proved it, which is what makes a stale
  // record unable to reopen one.
  let open = new Map();
  let closed = new Map();
  let primed = false;
  let lastRefresh = null;

  async function callFetch(fetcher, arg) {
    if (typeof fetcher !== 'function') return { ok: false, error: 'no fetch function was injected' };
    let result = null;
    try {
      result = await fetcher(arg);
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
    if (!result || typeof result !== 'object') return { ok: false, error: 'the fetch returned no result' };
    if (result.ok !== true) {
      return { ok: false, error: typeof result.error === 'string' && result.error ? result.error : 'the fetch failed' };
    }
    if (!Array.isArray(result.issues)) return { ok: false, error: 'the fetch returned no issue list' };
    return { ok: true, issues: result.issues };
  }

  function mergeRecord(record, counters) {
    const { number } = record;
    if (record.state === 'closed') {
      if (open.has(number)) {
        open.delete(number);
        counters.closed += 1;
      }
      closed.set(number, record);
      return;
    }
    if (closed.has(number)) {
      if (!beatsClosure(record, closed.get(number))) return;
      closed.delete(number);
    }
    if (open.has(number)) counters.updated += 1;
    else counters.added += 1;
    open.set(number, record);
  }

  // Returns the numbers the payload mentioned at all, so an unparseable
  // record can never be mistaken for an issue that stopped existing.
  function mergePayload(issues, counters) {
    const seen = new Set();
    for (const raw of issues) {
      const named = raw && typeof raw === 'object' ? issueNumber(raw.number) : 0;
      if (named !== 0) seen.add(named);
      const record = normalizeRecord(raw);
      if (record) mergeRecord(record, counters);
    }
    return seen;
  }

  function markLoaded() {
    primed = true;
    lastRefresh = now();
  }

  async function prime() {
    const loaded = await callFetch(fetchAll, { pageSize });
    if (!loaded.ok) return { ok: false, count: open.size, error: loaded.error };
    const seen = mergePayload(loaded.issues, { added: 0, updated: 0, closed: 0 });
    // A full snapshot is the one moment absence is evidence: anything the
    // cache held open that the repository no longer lists was closed or
    // deleted while the session ran (S7d), so it must not stay assigned.
    // The fetcher's contract is what makes this sound: it fails instead of
    // answering with a bounded or sampled list.
    for (const [number, record] of open) {
      if (seen.has(number)) continue;
      open.delete(number);
      closed.set(number, { ...record, state: 'closed' });
    }
    markLoaded();
    return { ok: true, count: open.size };
  }

  async function refresh() {
    const counters = { added: 0, updated: 0, closed: 0 };
    const loaded = await callFetch(fetchRecent, { limit: recentLimit });
    if (!loaded.ok) return { ok: false, ...counters, error: loaded.error };
    mergePayload(loaded.issues, counters);
    // `primed` only turns true after a full snapshot; a refresh over an
    // unprimed cache is a partial merge, which is why `revalidate` reports
    // the rest as unknown instead of guessing.
    lastRefresh = now();
    return { ok: true, ...counters };
  }

  function all() {
    return [...open.values()].sort(compareRecords).map((record) => ({ ...record }));
  }

  function stateOf(number) {
    const key = issueNumber(number);
    if (key === 0) return 'unknown';
    if (open.has(key)) return 'open';
    if (closed.has(key)) return 'closed';
    return 'unknown';
  }

  function isOpen(number) {
    return stateOf(number) === 'open';
  }

  function revalidate(numbers) {
    const result = { keep: [], drop: [], unknown: [] };
    if (!Array.isArray(numbers)) return result;
    for (const entry of numbers) {
      const state = stateOf(entry);
      if (state === 'open') result.keep.push(entry);
      else if (state === 'closed') result.drop.push(entry);
      else result.unknown.push(entry);
    }
    return result;
  }

  function reset() {
    open = new Map();
    closed = new Map();
    primed = false;
    lastRefresh = null;
    return { ok: true };
  }

  function stats() {
    return { primed, size: open.size, lastRefresh };
  }

  return { prime, refresh, all, isOpen, stateOf, revalidate, reset, stats };
}

module.exports = { createIssuesCache, DEFAULT_RECENT_LIMIT };
