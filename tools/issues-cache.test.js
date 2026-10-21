'use strict';
// Tests for lib/issues-cache.js — the open-issue cache shared by the issues
// viewer and the worktree detail (worktree-ui-redesign S10, S7c, S7d).
//
// Contract under test: `prime()` loads every OPEN issue once, `refresh()`
// asks only for the recent margin and merges it, `all()` returns the merged
// open set newest-update-first, `revalidate()` splits a worktree's stored
// association into keep/drop/unknown without ever dropping what the cache
// cannot answer for, and every method returns a result object instead of
// throwing. Both fetchers are injected, so no test spawns `gh` and no test
// touches disk, timers or the network.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createIssuesCache } = require('../lib/issues-cache.js');

function issue(number, updatedAt, extra = {}) {
  return { number, title: `Issue ${number}`, state: 'open', updatedAt, ...extra };
}

// ISO timestamps with a handleable day so ordering assertions read clearly.
function day(n) {
  return `2024-01-${String(n).padStart(2, '0')}T00:00:00Z`;
}

function numbers(list) {
  return list.map((entry) => entry.number);
}

describe('prime()', () => {
  test('seeds every open issue, counts them and sorts newest update first', async () => {
    const allCalls = [];
    const cache = createIssuesCache({
      pageSize: 100,
      now: () => 1234,
      fetchAll: async (arg) => {
        allCalls.push(arg);
        return { ok: true, issues: [issue(1, day(1)), issue(2, day(3)), issue(3, day(2))] };
      },
      fetchRecent: async () => {
        throw new Error('prime() must not use the recent fetch');
      },
    });

    const result = await cache.prime();

    assert.deepEqual(result, { ok: true, count: 3 });
    assert.deepEqual(allCalls, [{ pageSize: 100 }]);
    assert.deepEqual(numbers(cache.all()), [2, 3, 1]);
    assert.deepEqual(cache.stats(), { primed: true, size: 3, lastRefresh: 1234 });
  });

  test('forwards no pageSize when the caller configured none', async () => {
    const allCalls = [];
    const cache = createIssuesCache({
      fetchAll: async (arg) => {
        allCalls.push(arg);
        return { ok: true, issues: [] };
      },
    });

    await cache.prime();

    assert.deepEqual(allCalls, [{ pageSize: undefined }]);
  });

  test('a later full snapshot closes an issue the repository no longer lists', async () => {
    let payload = [issue(1, day(1)), issue(2, day(2)), issue(3, day(3))];
    const cache = createIssuesCache({ fetchAll: async () => ({ ok: true, issues: payload }) });

    await cache.prime();
    payload = [issue(1, day(1)), issue(2, day(2))];
    const result = await cache.prime();

    assert.deepEqual(result, { ok: true, count: 2 });
    assert.equal(cache.isOpen(3), false);
    assert.equal(cache.stateOf(3), 'closed');
    assert.deepEqual(numbers(cache.all()), [2, 1]);
  });
});

describe('refresh()', () => {
  test('asks only for the recent margin and never re-lists the open set', async () => {
    const allCalls = [];
    const recentCalls = [];
    const cache = createIssuesCache({
      fetchAll: async (arg) => {
        allCalls.push(arg);
        return { ok: true, issues: [issue(1, day(1)), issue(2, day(2))] };
      },
      fetchRecent: async (arg) => {
        recentCalls.push(arg);
        return { ok: true, issues: [issue(2, day(2))] };
      },
    });

    await cache.prime();
    await cache.refresh();

    assert.deepEqual(allCalls, [{ pageSize: undefined }]);
    assert.deepEqual(recentCalls, [{ limit: 20 }]);
  });

  test('honours a custom recentLimit', async () => {
    const recentCalls = [];
    const cache = createIssuesCache({
      recentLimit: 10,
      fetchRecent: async (arg) => {
        recentCalls.push(arg);
        return { ok: true, issues: [issue(1, day(1))] };
      },
    });

    await cache.refresh();

    assert.deepEqual(recentCalls, [{ limit: 10 }]);
    // A margin-only load is a partial cache: it never claims to be primed, so
    // everything outside the margin stays unknown instead of guessed.
    assert.deepEqual(cache.stats().primed, false);
    assert.deepEqual(numbers(cache.all()), [1]);
  });

  test('merges the margin into the cache and counts added and updated', async () => {
    let recent = [issue(2, day(5), { title: 'Renamed' }), issue(4, day(4))];
    const cache = createIssuesCache({
      fetchAll: async () => ({ ok: true, issues: [issue(1, day(1)), issue(2, day(2)), issue(3, day(3))] }),
      fetchRecent: async () => ({ ok: true, issues: recent }),
    });

    await cache.prime();
    const result = await cache.refresh();

    assert.deepEqual(result, { ok: true, added: 1, updated: 1, closed: 0 });
    assert.deepEqual(numbers(cache.all()), [2, 4, 3, 1]);
    assert.equal(cache.all()[0].title, 'Renamed');

    recent = [];
    assert.deepEqual(await cache.refresh(), { ok: true, added: 0, updated: 0, closed: 0 });
    assert.deepEqual(numbers(cache.all()), [2, 4, 3, 1]);
  });

  test('a record reported CLOSED leaves the open set and is remembered without a refetch', async () => {
    let recentCalls = 0;
    let recent = [];
    const cache = createIssuesCache({
      fetchAll: async () => ({ ok: true, issues: [issue(1, day(1)), issue(2, day(2))] }),
      fetchRecent: async () => {
        recentCalls += 1;
        return { ok: true, issues: recent };
      },
    });

    await cache.prime();
    recent = [issue(1, day(9), { state: 'CLOSED' })];
    assert.deepEqual(await cache.refresh(), { ok: true, added: 0, updated: 0, closed: 1 });

    assert.equal(recentCalls, 1);
    assert.equal(cache.isOpen(1), false);
    assert.equal(cache.stateOf(1), 'closed');
    assert.deepEqual(numbers(cache.all()), [2]);
    assert.equal(recentCalls, 1, 'answering a state must not fetch again');

    // The closure is only counted the once: a later report finds nothing open
    // to remove and the issue stays closed.
    assert.deepEqual(await cache.refresh(), { ok: true, added: 0, updated: 0, closed: 0 });
    assert.equal(cache.stateOf(1), 'closed');
  });

  test('a stale open record never resurrects a closed issue, a newer one reopens it', async () => {
    let recent = [];
    const cache = createIssuesCache({
      fetchAll: async () => ({ ok: true, issues: [issue(1, day(5))] }),
      fetchRecent: async () => ({ ok: true, issues: recent }),
    });

    await cache.prime();
    recent = [issue(1, day(6), { state: 'closed' })];
    await cache.refresh();

    recent = [issue(1, day(5))];
    assert.deepEqual(await cache.refresh(), { ok: true, added: 0, updated: 0, closed: 0 });
    assert.equal(cache.isOpen(1), false, 'a record older than the closure must not reopen it');

    recent = [issue(1, day(7))];
    assert.deepEqual(await cache.refresh(), { ok: true, added: 1, updated: 0, closed: 0 });
    assert.equal(cache.isOpen(1), true);
    assert.equal(cache.stateOf(1), 'open');
  });
});

describe('revalidate()', () => {
  test('splits keep/drop/unknown in the caller order and never fetches', async () => {
    const calls = [];
    const recent = [issue(2, day(9), { state: 'closed' })];
    const cache = createIssuesCache({
      fetchAll: async () => {
        calls.push('all');
        return { ok: true, issues: [issue(1, day(1)), issue(2, day(2)), issue(3, day(3))] };
      },
      fetchRecent: async () => {
        calls.push('recent');
        return { ok: true, issues: recent };
      },
    });

    await cache.prime();
    await cache.refresh();
    calls.length = 0;

    assert.deepEqual(cache.revalidate([9, 2, 1, 3]), { keep: [1, 3], drop: [2], unknown: [9] });
    assert.deepEqual(cache.revalidate([3, 10]), { keep: [3], drop: [], unknown: [10] });
    assert.deepEqual(calls, [], 'revalidate() must answer from the cache alone');
  });

  test('reports malformed entries as unknown instead of dropping them', async () => {
    const cache = createIssuesCache({
      fetchAll: async () => ({ ok: true, issues: [issue(1, day(1))] }),
    });

    await cache.prime();

    assert.deepEqual(cache.revalidate([0, '2', null, 1, 1.5]), {
      keep: [1],
      drop: [],
      unknown: [0, '2', null, 1.5],
    });
  });

  test('returns empty arrays for empty and malformed input instead of throwing', () => {
    const cache = createIssuesCache({ fetchAll: async () => ({ ok: true, issues: [] }) });

    assert.deepEqual(cache.revalidate([]), { keep: [], drop: [], unknown: [] });
    assert.deepEqual(cache.revalidate(null), { keep: [], drop: [], unknown: [] });
    assert.deepEqual(cache.revalidate(undefined), { keep: [], drop: [], unknown: [] });
  });
});

describe('failure handling', () => {
  test('a failed full load reports the error and leaves the cache empty', async () => {
    const cache = createIssuesCache({
      fetchAll: async () => ({ ok: false, error: 'gh is not authenticated' }),
    });

    assert.deepEqual(await cache.prime(), { ok: false, count: 0, error: 'gh is not authenticated' });
    assert.deepEqual(cache.all(), []);
    assert.deepEqual(cache.stats(), { primed: false, size: 0, lastRefresh: null });
  });

  test('a failed refresh leaves every stored issue and the timestamp untouched', async () => {
    const clock = [111, 222, 333];
    let recent = { ok: true, issues: [issue(2, day(2))] };
    const cache = createIssuesCache({
      now: () => clock.shift(),
      fetchAll: async () => ({ ok: true, issues: [issue(1, day(1)), issue(2, day(2))] }),
      fetchRecent: async () => recent,
    });

    await cache.prime();
    assert.deepEqual(cache.stats(), { primed: true, size: 2, lastRefresh: 111 });
    await cache.refresh();
    assert.deepEqual(cache.stats(), { primed: true, size: 2, lastRefresh: 222 }, 'a successful margin load stamps the clock');

    recent = { ok: false, error: 'network is unreachable' };
    assert.deepEqual(await cache.refresh(), {
      ok: false,
      added: 0,
      updated: 0,
      closed: 0,
      error: 'network is unreachable',
    });
    assert.deepEqual(numbers(cache.all()), [2, 1]);
    assert.deepEqual(cache.stats(), { primed: true, size: 2, lastRefresh: 222 });
    assert.deepEqual(clock, [333], 'a failed load must not consume the clock');
  });

  test('a throwing fetch is caught and reported', async () => {
    const cache = createIssuesCache({
      fetchAll: async () => {
        throw new Error('spawn gh ENOENT');
      },
      fetchRecent: async () => {
        throw new Error('spawn gh ENOENT');
      },
    });

    assert.deepEqual(await cache.prime(), { ok: false, count: 0, error: 'spawn gh ENOENT' });
    assert.deepEqual(await cache.refresh(), { ok: false, added: 0, updated: 0, closed: 0, error: 'spawn gh ENOENT' });
  });

  test('a missing fetch function is reported, never thrown', async () => {
    const cache = createIssuesCache({});

    assert.deepEqual(await cache.prime(), {
      ok: false,
      count: 0,
      error: 'no fetch function was injected',
    });
    assert.deepEqual(await cache.refresh(), {
      ok: false,
      added: 0,
      updated: 0,
      closed: 0,
      error: 'no fetch function was injected',
    });
  });
});

describe('malformed payloads', () => {
  test('junk entries are ignored and a non-list payload fails without touching the cache', async () => {
    let payload = {
      ok: true,
      issues: [
        null,
        7,
        'nope',
        { number: '4' },
        { number: 0 },
        { number: 5.5 },
        { number: 6, state: 'reopened' },
        issue(8, day(8)),
        { number: 9, state: 'CLOSED', updatedAt: day(9) },
        { number: 10, updatedAt: day(10), title: 'no state field' },
        { number: 11, updatedAt: 42 },
      ],
    };
    const cache = createIssuesCache({
      fetchAll: async () => payload,
    });

    assert.deepEqual(await cache.prime(), { ok: true, count: 3 });
    // An unparseable `updatedAt` sorts last instead of throwing.
    assert.deepEqual(numbers(cache.all()), [10, 8, 11]);
    assert.equal(cache.stateOf(9), 'closed');
    assert.equal(cache.stateOf(4), 'unknown');
    assert.equal(cache.stateOf(6), 'unknown');

    // A payload that is not a list is a failed fetch, not an empty one: it
    // must never be read as "the repository has no open issues".
    const before = numbers(cache.all());
    payload = { ok: true, issues: 'not a list' };
    assert.deepEqual(await cache.prime(), {
      ok: false,
      count: 3,
      error: 'the fetch returned no issue list',
    });
    assert.deepEqual(numbers(cache.all()), before);

    const failing = createIssuesCache({ fetchRecent: async () => ({ ok: true, issues: 'not a list' }) });
    assert.deepEqual(await failing.refresh(), {
      ok: false,
      added: 0,
      updated: 0,
      closed: 0,
      error: 'the fetch returned no issue list',
    });
    assert.deepEqual(failing.all(), []);
  });

  test('a fetch resolving to nothing is a reported failure', async () => {
    const cache = createIssuesCache({ fetchAll: async () => null, fetchRecent: async () => undefined });

    assert.deepEqual(await cache.prime(), { ok: false, count: 0, error: 'the fetch returned no result' });
    assert.deepEqual(await cache.refresh(), {
      ok: false,
      added: 0,
      updated: 0,
      closed: 0,
      error: 'the fetch returned no result',
    });
  });

  test('a fetch result without ok reports the failure instead of assuming success', async () => {
    const cache = createIssuesCache({
      fetchAll: async () => ({ issues: [issue(1, day(1))] }),
      fetchRecent: async () => ({ issues: [] }),
    });

    assert.deepEqual(await cache.prime(), { ok: false, count: 0, error: 'the fetch failed' });
    assert.deepEqual(await cache.refresh(), { ok: false, added: 0, updated: 0, closed: 0, error: 'the fetch failed' });
  });
});

describe('reset() and stats()', () => {
  test('starts empty, unknown-answering and unprimed', () => {
    const cache = createIssuesCache({});

    assert.deepEqual(cache.all(), []);
    assert.deepEqual(cache.stats(), { primed: false, size: 0, lastRefresh: null });
    assert.equal(cache.isOpen(1), false);
    assert.equal(cache.stateOf(1), 'unknown');
  });

  test('reset() forgets every issue, the primed flag and the timestamp', async () => {
    const cache = createIssuesCache({
      now: () => 999,
      fetchAll: async () => ({ ok: true, issues: [issue(1, day(1)), issue(2, day(2), { state: 'closed' })] }),
    });

    await cache.prime();
    assert.equal(cache.stateOf(2), 'closed');

    assert.deepEqual(cache.reset(), { ok: true });
    assert.deepEqual(cache.stats(), { primed: false, size: 0, lastRefresh: null });
    assert.deepEqual(cache.all(), []);
    assert.equal(cache.stateOf(1), 'unknown');
    assert.equal(cache.stateOf(2), 'unknown');
    assert.deepEqual(cache.revalidate([1, 2]), { keep: [], drop: [], unknown: [1, 2] });
  });
});
