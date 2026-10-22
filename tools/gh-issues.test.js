'use strict';
// P1 (issues-view S2,S9,S10): tests for lib/gh-issues.js — the only place
// that runs `gh`. CommonJS, injectable runner, fixed argv (never a shell
// string), JSON parsed, never throws.
//
// Contract under test: every call returns `{ok:true, ...}` or
// `{ok:false, error}`; the runner seam means tests never invoke the real
// `gh` — injected runners return captured REAL `gh` JSON payloads saved
// under tools/fixtures/ (captured with `gh issue list/view`, `gh label
// list`, `gh api user` and `gh repo view` in this repository).

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ghIssues = require('../lib/gh-issues.js');

const FIXTURES = path.join(__dirname, 'fixtures');
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Recorder: captures (bin, argv) and answers from a script of outcomes.
// An outcome is {status, stdout, stderr, error} like the real runner.
function makeRunner(script) {
  const calls = [];
  const queue = Array.isArray(script) ? script.slice() : [script];
  const runner = (bin, argv, runOpts) => {
    calls.push({ bin, argv: argv.slice(), runOpts: { ...(runOpts || {}) } });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(calls[calls.length - 1]);
    return Promise.resolve({ status: 0, stdout: '', stderr: '', error: null, ...(next || {}) });
  };
  return { runner, calls };
}

function okJson(stdout) {
  return { status: 0, stdout, stderr: '', error: null };
}

beforeEach(() => {
  ghIssues.setGhRunner(null);
});

describe('happy path over captured real gh JSON', () => {
  test('ghStatus reports the authenticated login', async () => {
    const { runner, calls } = makeRunner([
      okJson(fixture('gh-api-user.json')),
      okJson(fixture('gh-repo-view.json')),
    ]);
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.ghStatus();
    assert.equal(res.ok, true);
    assert.equal(res.login, 'jonasotoaguilar');
    assert.equal(res.nameWithOwner, 'jonasotoaguilar/herdr-gentle-shell');
    assert.equal(calls[0].bin, 'gh');
    assert.deepEqual(calls[0].argv, ['api', 'user']);
  });

  test('repoInfo reports nameWithOwner and viewer', async () => {
    const { runner } = makeRunner([
      okJson(fixture('gh-repo-view.json')),
      okJson(fixture('gh-api-user.json')),
    ]);
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.repoInfo();
    assert.equal(res.ok, true);
    assert.equal(res.nameWithOwner, 'jonasotoaguilar/herdr-gentle-shell');
    assert.equal(res.viewer, 'jonasotoaguilar');
  });

  test('listIssues normalizes the captured list payload', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-issue-list.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: 'author:@me', page: 1, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.equal(res.page, 1);
    assert.equal(res.pageSize, 30);
    assert.ok(res.total >= 1);
    assert.equal(res.issues.length, res.total);
    const issue = res.issues[0];
    assert.equal(issue.number, 76);
    assert.equal(issue.state, 'open');
    assert.equal(issue.author, 'jonasotoaguilar');
    assert.ok(Array.isArray(issue.labels));
    assert.equal(typeof issue.commentsCount, 'number');
    assert.equal(typeof issue.reactions.total, 'number');
    assert.equal(typeof issue.url, 'string');
    assert.equal(typeof issue.body, 'string');
    assert.equal(calls[0].bin, 'gh');
    assert.ok(calls[0].argv.includes('issue'));
    assert.ok(calls[0].argv.includes('list'));
  });

  test('getIssue returns the issue with normalized comments', async () => {
    const { runner, calls } = makeRunner(okJson(fixture('gh-issue-view.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(76);
    assert.equal(res.ok, true);
    assert.equal(res.issue.number, 76);
    assert.equal(res.issue.state, 'open');
    assert.ok(Array.isArray(res.comments));
    assert.deepEqual(calls[0].argv.slice(0, 3), ['issue', 'view', '76']);
    assert.ok(calls[0].argv.includes('--json'));
  });

  test('listLabels normalizes the captured label payload', async () => {
    const { runner } = makeRunner(okJson(fixture('gh-label-list.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listLabels();
    assert.equal(res.ok, true);
    assert.ok(res.labels.length >= 1);
    assert.equal(typeof res.labels[0].name, 'string');
    assert.ok('color' in res.labels[0]);
    assert.ok('description' in res.labels[0]);
  });

  test('createLabel posts name, color and description', async () => {
    const { runner, calls } = makeRunner(okJson('{"name":"triage"}'));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.createLabel({ name: 'triage', color: 'FBCA04', description: 'needs triage' });
    assert.equal(res.ok, true);
    assert.equal(res.label.name, 'triage');
    assert.deepEqual(calls[0].argv.slice(0, 3), ['label', 'create', 'triage']);
    assert.ok(calls[0].argv.includes('--color'));
    assert.ok(calls[0].argv.includes('FBCA04'));
  });

  test('editLabels passes add and remove label flags', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.editLabels(76, { add: ['bug'], remove: ['wontfix'] });
    assert.equal(res.ok, true);
    assert.deepEqual(calls[0].argv.slice(0, 3), ['issue', 'edit', '76']);
    assert.ok(calls[0].argv.includes('--add-label'));
    assert.ok(calls[0].argv.includes('bug'));
    assert.ok(calls[0].argv.includes('--remove-label'));
    assert.ok(calls[0].argv.includes('wontfix'));
  });

  test('commentIssue passes the body as one argv element', async () => {
    const { runner, calls } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.commentIssue(76, 'looks good to me');
    assert.equal(res.ok, true);
    assert.deepEqual(calls[0].argv.slice(0, 3), ['issue', 'comment', '76']);
    assert.ok(calls[0].argv.includes('--body'));
    assert.ok(calls[0].argv.includes('looks good to me'));
  });

  test('setIssueState closes and reopens', async () => {
    const { runner, calls } = makeRunner([okJson(''), okJson('')]);
    ghIssues.setGhRunner(runner);
    const closed = await ghIssues.setIssueState(76, 'closed');
    assert.equal(closed.ok, true);
    assert.deepEqual(calls[0].argv, ['issue', 'close', '76']);
    const opened = await ghIssues.setIssueState(76, 'open');
    assert.equal(opened.ok, true);
    assert.deepEqual(calls[1].argv, ['issue', 'reopen', '76']);
  });
});

describe('failure shapes: nothing throws', () => {
  test('missing gh binary (ENOENT) fails closed on every read call', async () => {
    const { runner } = makeRunner({ status: null, stdout: '', stderr: '', error: 'spawn gh ENOENT' });
    ghIssues.setGhRunner(runner);
    for (const res of [
      await ghIssues.ghStatus(),
      await ghIssues.repoInfo(),
      await ghIssues.listIssues({ page: 1, pageSize: 10 }),
      await ghIssues.getIssue(1),
      await ghIssues.listLabels(),
    ]) {
      assert.equal(res.ok, false);
      assert.match(String(res.error), /ENOENT/i);
    }
  });

  test('unauthenticated gh reports the auth failure', async () => {
    const { runner } = makeRunner({
      status: 1, stdout: '', stderr: 'To authenticate, please run `gh auth login`.', error: null,
    });
    ghIssues.setGhRunner(runner);
    const status = await ghIssues.ghStatus();
    assert.equal(status.ok, false);
    assert.match(String(status.error), /gh auth login/);
    const list = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(list.ok, false);
    assert.match(String(list.error), /gh auth login/);
  });

  test('empty result reads as an empty list, not an error', async () => {
    const { runner } = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(runner);
    const list = await ghIssues.listIssues({ page: 1, pageSize: 30 });
    assert.equal(list.ok, true);
    assert.deepEqual(list.issues, []);
    assert.equal(list.total, 0);
    const labels = await ghIssues.listLabels();
    assert.equal(labels.ok, true);
    assert.deepEqual(labels.labels, []);
  });

  test('malformed JSON fails closed', async () => {
    const { runner } = makeRunner(okJson('this is not json{{{'));
    ghIssues.setGhRunner(runner);
    for (const res of [
      await ghIssues.listIssues({ page: 1, pageSize: 10 }),
      await ghIssues.getIssue(1),
      await ghIssues.listLabels(),
      await ghIssues.ghStatus(),
    ]) {
      assert.equal(res.ok, false);
      assert.ok(String(res.error).length > 0);
    }
  });

  test('empty body fails closed', async () => {
    const { runner } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const list = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(list.ok, false);
    assert.ok(String(list.error).length > 0);
  });

  test('a throwing or rejecting runner still returns {ok:false}', async () => {
    ghIssues.setGhRunner(() => Promise.reject(new Error('boom')));
    const rejected = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.error), /boom/);
    ghIssues.setGhRunner(() => { throw new Error('sync boom'); });
    const thrown = await ghIssues.getIssue(1);
    assert.equal(thrown.ok, false);
    assert.match(String(thrown.error), /sync boom/);
  });

  test('non-zero exit on a write call reports the stderr', async () => {
    const { runner } = makeRunner({ status: 1, stdout: '', stderr: 'Could not resolve to an Issue', error: null });
    ghIssues.setGhRunner(runner);
    const edited = await ghIssues.editLabels(999999, { add: ['bug'], remove: [] });
    assert.equal(edited.ok, false);
    assert.match(String(edited.error), /Could not resolve/);
    const commented = await ghIssues.commentIssue(999999, 'hi');
    assert.equal(commented.ok, false);
    const state = await ghIssues.setIssueState(999999, 'closed');
    assert.equal(state.ok, false);
    const created = await ghIssues.createLabel({ name: 'x' });
    assert.equal(created.ok, false);
  });

  test('invalid inputs fail closed without running gh', async () => {
    const { runner, calls } = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(runner);
    assert.equal((await ghIssues.getIssue('abc')).ok, false);
    assert.equal((await ghIssues.commentIssue(1, '')).ok, false);
    assert.equal((await ghIssues.commentIssue(1, '   ')).ok, false);
    assert.equal((await ghIssues.setIssueState(1, 'bogus')).ok, false);
    assert.equal((await ghIssues.createLabel({ name: '' })).ok, false);
    assert.equal(calls.length, 0);
  });
});

describe('paging', () => {
  function manyIssues(n) {
    const items = [];
    for (let i = 1; i <= n; i += 1) {
      items.push({
        number: i, title: `issue ${i}`, state: 'OPEN', stateReason: '',
        author: { login: 'someone' }, labels: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
        comments: [], reactionGroups: [],
        url: `https://example.test/issues/${i}`, body: '',
      });
    }
    return JSON.stringify(items);
  }

  test('pages slice the in-memory fetch: page 3 of 65 at size 30', async () => {
    const { runner, calls } = makeRunner(okJson(manyIssues(65)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: '', page: 3, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 65);
    assert.equal(res.page, 3);
    assert.equal(res.pageSize, 30);
    assert.equal(res.issues.length, 5);
    assert.equal(res.issues[0].number, 61);
    // The fetch asks gh for a bounded superset, never an offset flag.
    const limitAt = calls[0].argv.indexOf('--limit');
    assert.ok(limitAt >= 0);
    assert.ok(Number(calls[0].argv[limitAt + 1]) >= 65);
    assert.ok(!calls[0].argv.includes('--offset'));
    assert.ok(!calls[0].argv.includes('--page'));
  });

  test('truncated is set exactly when the fetch bound is reached', async () => {
    function manyIssues(n) {
      const items = [];
      for (let i = 1; i <= n; i += 1) {
        items.push({
          number: i, title: `issue ${i}`, state: 'OPEN', stateReason: '',
          author: { login: 'someone' }, labels: [],
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
          comments: [], reactionGroups: [],
          url: `https://example.test/issues/${i}`, body: '',
        });
      }
      return JSON.stringify(items);
    }
    const full = makeRunner(okJson(manyIssues(5)));
    ghIssues.setGhRunner(full.runner);
    const reached = await ghIssues.listIssues({ page: 1, pageSize: 5 }, { fetchMax: 5 });
    assert.equal(reached.ok, true);
    assert.equal(reached.truncated, true, 'fetch count reaching the bound marks truncation');
    const limitAt = full.calls[0].argv.indexOf('--limit');
    assert.equal(full.calls[0].argv[limitAt + 1], '5', 'the injectable bound drives --limit');
    const short = makeRunner(okJson(manyIssues(3)));
    ghIssues.setGhRunner(short.runner);
    const notReached = await ghIssues.listIssues({ page: 1, pageSize: 5 }, { fetchMax: 5 });
    assert.equal(notReached.ok, true);
    assert.ok(!notReached.truncated, 'a short fetch carries no truncation marker');
  });

  test('a page past the end reads as empty, not an error', async () => {
    const { runner } = makeRunner(okJson(manyIssues(10)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: '', page: 4, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.issues, []);
    assert.equal(res.total, 10);
  });
});

describe('listAllOpenIssues: cursor pagination of the whole open set', () => {
  function pageNode(number) {
    return {
      number,
      title: `issue ${number}`,
      state: 'OPEN',
      stateReason: '',
      author: { login: 'octo' },
      labels: { nodes: [] },
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      url: `https://example.test/issues/${number}`,
      comments: { totalCount: 0 },
      reactionGroups: [],
    };
  }

  function page(numbers, { totalCount = numbers.length, hasNextPage = false, endCursor = null } = {}) {
    return okJson(JSON.stringify({
      data: {
        repository: {
          issues: {
            totalCount,
            pageInfo: { hasNextPage, endCursor },
            nodes: numbers.map(pageNode),
          },
        },
      },
    }));
  }

  const repoView = okJson('{"nameWithOwner":"octo/repo"}\n');
  const numbers = (from, to) => {
    const list = [];
    for (let n = from; n <= to; n += 1) list.push(n);
    return list;
  };
  const graphqlCalls = (calls) => calls.filter((call) => call.argv[0] === 'api' && call.argv[1] === 'graphql');
  const variable = (call, name) => call.argv.find((entry) => entry.startsWith(`${name}=`));

  test('250 open issues take three cursor pages, one request each', async () => {
    const { runner, calls } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: 'c1' }),
      page(numbers(101, 200), { totalCount: 250, hasNextPage: true, endCursor: 'c2' }),
      page(numbers(201, 250), { totalCount: 250 }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, true);
    assert.equal(res.issues.length, 250, 'every open issue, from a 250-issue repository');
    assert.equal(res.total, 250);
    assert.equal(res.pages, 3);
    assert.equal(calls.length, 4, 'one repository lookup plus one request per page');
    const pages = graphqlCalls(calls);
    assert.equal(pages.length, 3);
    for (const call of pages) {
      assert.equal(variable(call, 'owner'), 'owner=octo');
      assert.equal(variable(call, 'name'), 'name=repo');
      assert.equal(variable(call, 'first'), 'first=100');
      assert.ok(!call.argv.includes('--search'), 'server pagination, never the search API');
      const queryAt = call.argv.indexOf('-f');
      assert.ok(queryAt >= 0, 'the query travels as a raw -f field');
      const query = call.argv[queryAt + 1];
      assert.match(query, /^query=/);
      assert.match(query, /issues\(states: OPEN/);
      assert.match(query, /after: \$cursor/);
      assert.match(query, /pageInfo/);
      assert.match(query, /totalCount/);
    }
    assert.equal(variable(pages[0], 'cursor'), undefined, 'the first page starts the connection');
    assert.equal(variable(pages[1], 'cursor'), 'cursor=c1');
    assert.equal(variable(pages[2], 'cursor'), 'cursor=c2');
  });

  test('more than 600 open issues page to the end and all of them arrive', async () => {
    const script = [repoView];
    for (let start = 1; start <= 601; start += 100) {
      const end = Math.min(start + 99, 620);
      const hasNextPage = end < 620;
      script.push(page(numbers(start, end), {
        totalCount: 620,
        hasNextPage,
        endCursor: hasNextPage ? `c${end}` : null,
      }));
    }
    const { runner } = makeRunner(script);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, true);
    assert.equal(res.issues.length, 620, 'no fixed issue cap: the whole connection arrives');
    assert.equal(res.total, 620);
    assert.equal(res.pages, 7);
  });

  test('a repeated cursor fails the whole snapshot', async () => {
    const { runner } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: 'stuck' }),
      page(numbers(101, 200), { totalCount: 250, hasNextPage: true, endCursor: 'stuck' }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /repeated the cursor/);
  });

  test('a page carrying GraphQL errors fails the whole snapshot', async () => {
    const { runner } = makeRunner([
      repoView,
      okJson(JSON.stringify({ errors: [{ message: 'API rate limit exceeded' }] })),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /API rate limit exceeded/);
  });

  test('a terminal page short of the reported total fails: no partial snapshot', async () => {
    const { runner } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: 'c1' }),
      page(numbers(101, 200), { totalCount: 250, hasNextPage: false, endCursor: null }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /200 of 250 open issues/);
  });

  test('hasNextPage without a cursor fails instead of looping', async () => {
    const { runner } = makeRunner([
      repoView,
      page(numbers(1, 100), { totalCount: 250, hasNextPage: true, endCursor: null }),
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /without a cursor/);
  });

  test('a malformed connection and an unresolved repository both fail closed', async () => {
    const malformed = makeRunner([repoView, okJson(JSON.stringify({ data: { repository: { issues: {} } } }))]);
    ghIssues.setGhRunner(malformed.runner);
    const bad = await ghIssues.listAllOpenIssues();
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /unexpected shape/);

    const noRepo = makeRunner({ status: 1, stdout: '', stderr: 'no git remotes found', error: null });
    ghIssues.setGhRunner(noRepo.runner);
    const unresolved = await ghIssues.listAllOpenIssues();
    assert.equal(unresolved.ok, false);
    assert.match(String(unresolved.error), /no git remotes found/);
  });

  test('a failing page request reports the transport error', async () => {
    const { runner } = makeRunner([
      repoView,
      { status: null, stdout: '', stderr: '', error: 'gh timed out after 30000ms' },
    ]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, false);
    assert.match(String(res.error), /timed out/);
  });

  test('the row shape matches the list rows the rest of the client returns', async () => {
    const { runner } = makeRunner([repoView, page([7], { totalCount: 1 })]);
    ghIssues.setGhRunner(runner);

    const res = await ghIssues.listAllOpenIssues();

    assert.equal(res.ok, true);
    assert.equal(res.issues[0].number, 7);
    assert.equal(res.issues[0].state, 'open');
    assert.equal(res.issues[0].author, 'octo');
    assert.deepEqual(res.issues[0].labels, []);
    assert.equal(res.issues[0].commentsCount, 0);
    assert.equal(res.issues[0].url, 'https://example.test/issues/7');
    assert.equal(res.issues[0].body, '', 'the snapshot never asks gh for bodies');
  });
});

describe('honest totals: one bounded fetch, page sliced in memory', () => {
  function honestIssues(n) {
    const items = [];
    for (let i = 1; i <= n; i += 1) {
      items.push({
        number: i, title: `issue ${i}`, state: 'OPEN', stateReason: '',
        author: { login: 'someone' }, labels: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
        comments: [], reactionGroups: [],
        url: `https://example.test/issues/${i}`, body: `body ${i}`,
      });
    }
    return JSON.stringify(items);
  }

  test('page 1 of a 25-item set reports total 25 with 20 rows, fetched once up to the bound', async () => {
    const { runner, calls } = makeRunner(okJson(honestIssues(25)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: 'involves:@me', page: 1, pageSize: 20 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 25, 'the total is what was fetched, never the page size');
    assert.equal(res.issues.length, 20);
    assert.equal(res.issues[0].number, 1);
    assert.equal(calls.length, 1, 'exactly one fetch for the page');
    const limitAt = calls[0].argv.indexOf('--limit');
    assert.ok(limitAt >= 0);
    assert.equal(calls[0].argv[limitAt + 1], '500', 'one fetch up to the bound, never page * pageSize');
    assert.equal(res.truncated, false);
  });

  test('page 2 of the same 25-item set reports the same total 25 with 5 rows', async () => {
    const { runner } = makeRunner(okJson(honestIssues(25)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: 'involves:@me', page: 2, pageSize: 20 });
    assert.equal(res.ok, true);
    assert.equal(res.total, 25, 'every page of one fetch reports the same total');
    assert.equal(res.issues.length, 5);
    assert.equal(res.issues[0].number, 21);
  });

  test('a bound-reached fetch reports truncated:true while an under-bound one reports false', async () => {
    const full = makeRunner(okJson(honestIssues(25)));
    ghIssues.setGhRunner(full.runner);
    const reached = await ghIssues.listIssues({ page: 1, pageSize: 20 }, { fetchMax: 25 });
    assert.equal(reached.ok, true);
    assert.equal(reached.total, 25);
    assert.equal(reached.truncated, true, 'a fetch that reached the bound is a lower bound');
    const limitAt = full.calls[0].argv.indexOf('--limit');
    assert.equal(full.calls[0].argv[limitAt + 1], '25', 'the injectable bound drives --limit, not the page');
    const short = makeRunner(okJson(honestIssues(24)));
    ghIssues.setGhRunner(short.runner);
    const notReached = await ghIssues.listIssues({ page: 1, pageSize: 20 }, { fetchMax: 25 });
    assert.equal(notReached.ok, true);
    assert.equal(notReached.total, 24);
    assert.equal(notReached.truncated, false, 'a short fetch is exact');
  });

  test('wholeResult returns the one bounded fetch instead of a page of it', async () => {
    const { runner, calls } = makeRunner(okJson(honestIssues(250)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ state: 'open', wholeResult: true }, { fetchMax: 251 });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1, 'one bounded read, never one per logical page');
    assert.equal(res.issues.length, 250, 'the whole fetched result, not a page of it');
    assert.equal(res.total, 250);
    assert.equal(res.truncated, false);
  });

  test('a wholeResult fetch that fills the bound is reported truncated', async () => {
    const { runner } = makeRunner(okJson(honestIssues(45)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ state: 'open', wholeResult: true }, { fetchMax: 45 });
    assert.equal(res.ok, true);
    assert.equal(res.issues.length, 45);
    assert.equal(res.truncated, true, 'a bound that filled proves nothing about the rest');
  });

  test('the list fetch omits body while the detail fetch keeps it', async () => {
    const { runner, calls } = makeRunner(okJson(honestIssues(3)));
    ghIssues.setGhRunner(runner);
    const listed = await ghIssues.listIssues({ page: 1, pageSize: 20 });
    assert.equal(listed.ok, true);
    const jsonAt = calls[0].argv.indexOf('--json');
    assert.ok(jsonAt >= 0);
    assert.ok(!calls[0].argv[jsonAt + 1].split(',').includes('body'), 'the list stays light: no body');
    const view = makeRunner(okJson(fixture('gh-issue-view.json')));
    ghIssues.setGhRunner(view.runner);
    const detail = await ghIssues.getIssue(76);
    assert.equal(detail.ok, true);
    const detailAt = view.calls[0].argv.indexOf('--json');
    assert.ok(view.calls[0].argv[detailAt + 1].split(',').includes('body'), 'the detail pane keeps body');
  });
});

describe('proof of a missing issue (S7d)', () => {
  test('issue-specific "could not resolve to an Issue" is proof', async () => {
    const { runner } = makeRunner({
      status: 1,
      stdout: '',
      stderr: 'GraphQL: Could not resolve to an Issue with the number of 999. (repository.issue)',
      error: null,
    });
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(999);
    assert.equal(res.ok, false);
    assert.equal(res.notFound, true);
  });

  test('a repository-level "Not Found (HTTP 404)" is not proof', async () => {
    const { runner } = makeRunner({
      status: 1,
      stdout: '',
      stderr: 'HTTP 404: Not Found (https://api.github.com/graphql)',
      error: null,
    });
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(999);
    assert.equal(res.ok, false);
    assert.equal(res.notFound, false, 'an inaccessible repository says nothing about this number');
  });
});

describe('argv shell safety', () => {
  test('a hostile query arrives as ONE argv element, never a command string', async () => {
    const hostile = 'hello; rm -rf / $(evil) `id` | cat /etc/passwd && echo pwned';
    const { runner, calls } = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ query: hostile, page: 1, pageSize: 10 });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    const { bin, argv } = calls[0];
    assert.equal(bin, 'gh');
    assert.ok(Array.isArray(argv));
    assert.ok(argv.every((entry) => typeof entry === 'string'));
    const searchAt = argv.indexOf('--search');
    assert.ok(searchAt >= 0);
    // The whole search string, ordering qualifier included, is still ONE
    // argv element.
    assert.equal(argv[searchAt + 1], `${hostile} sort:updated-desc`);
    // No shell join anywhere: the hostile text is one element, and no
    // element contains shell glue joining it with gh syntax.
    assert.equal(argv.filter((entry) => entry.includes('rm -rf')).length, 1);
  });

  test('a hostile comment body arrives as ONE argv element', async () => {
    const hostile = 'nice $(touch /tmp/pwned); drop it';
    const { runner, calls } = makeRunner(okJson(''));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.commentIssue(7, hostile);
    assert.equal(res.ok, true);
    const bodyAt = calls[0].argv.indexOf('--body');
    assert.ok(bodyAt >= 0);
    assert.equal(calls[0].argv[bodyAt + 1], hostile);
  });

  test('the module source never builds a shell string for gh', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gh-issues.js'), 'utf8');
    assert.ok(!/exec\s*\(/.test(src), 'no child_process.exec with a shell string');
    assert.ok(!/execSync\s*\(/.test(src), 'no child_process.execSync with a shell string');
    assert.ok(!/shell\s*:\s*true/.test(src), 'no shell:true spawn option');
  });
});

describe('list ordering: the query carries it (S10)', () => {
  // Payload rows whose updatedAt rises with the number, so a JavaScript
  // re-sort by updatedAt desc would visibly change the order.
  function rowsInOrder(numbers) {
    return JSON.stringify(numbers.map((n) => ({
      number: n, title: `issue ${n}`, state: 'OPEN', stateReason: '',
      author: { login: 'someone' }, labels: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: `2026-01-0${n}T00:00:00Z`,
      comments: [], reactionGroups: [],
      url: `https://example.test/issues/${n}`, body: '',
    })));
  }

  test('asks gh for last-update ordering through the search query', async () => {
    const bare = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(bare.runner);
    await ghIssues.listIssues({ page: 1, pageSize: 10 });
    const bareAt = bare.calls[0].argv.indexOf('--search');
    assert.ok(bareAt >= 0, 'the ordering travels in the search query, not in a JS sort');
    assert.equal(bare.calls[0].argv[bareAt + 1], 'sort:updated-desc');

    const withQuery = makeRunner(okJson('[]'));
    ghIssues.setGhRunner(withQuery.runner);
    await ghIssues.listIssues({ query: 'author:@me', page: 1, pageSize: 10 });
    const queryAt = withQuery.calls[0].argv.indexOf('--search');
    assert.equal(withQuery.calls[0].argv[queryAt + 1], 'author:@me sort:updated-desc');
  });

  test('an explicit caller sort is respected, never doubled', async () => {
    for (const query of ['sort:created-asc', 'author:@me sort:created-asc']) {
      const { runner, calls } = makeRunner(okJson('[]'));
      ghIssues.setGhRunner(runner);
      await ghIssues.listIssues({ query, page: 1, pageSize: 10 });
      const searchAt = calls[0].argv.indexOf('--search');
      const search = calls[0].argv[searchAt + 1];
      assert.equal(search, query, 'the caller sort survives verbatim');
      assert.equal((search.match(/sort:/gi) || []).length, 1, 'exactly one sort qualifier');
    }
  });

  test('rows keep the order the runner returned: no re-sort in JavaScript', async () => {
    const { runner } = makeRunner(okJson(rowsInOrder([3, 1, 2])));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ page: 1, pageSize: 10 });
    assert.equal(res.ok, true);
    assert.deepEqual(res.issues.map((issue) => issue.number), [3, 1, 2]);
  });
});

describe('detail assignees (adopted reference idea 1)', () => {
  test('getIssue exposes assignees from the detail payload', async () => {
    const doc = JSON.parse(fixture('gh-issue-view.json'));
    doc.assignees = [{ login: 'alice' }, { login: 'bob' }];
    const { runner, calls } = makeRunner(okJson(JSON.stringify(doc)));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(76);
    assert.equal(res.ok, true);
    assert.deepEqual(res.issue.assignees, ['alice', 'bob']);
    const jsonAt = calls[0].argv.indexOf('--json');
    assert.ok(jsonAt >= 0);
    assert.ok(calls[0].argv[jsonAt + 1].split(',').includes('assignees'), 'the detail fetch asks gh for assignees');
  });

  test('getIssue defaults assignees to [] when gh omits them', async () => {
    const { runner } = makeRunner(okJson(fixture('gh-issue-view.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.getIssue(76);
    assert.equal(res.ok, true);
    assert.deepEqual(res.issue.assignees, []);
  });

  test('listIssues rows keep their shape: no assignees key', async () => {
    const { runner } = makeRunner(okJson(fixture('gh-issue-list.json')));
    ghIssues.setGhRunner(runner);
    const res = await ghIssues.listIssues({ page: 1, pageSize: 30 });
    assert.equal(res.ok, true);
    assert.ok(res.issues.length >= 1);
    assert.ok(!('assignees' in res.issues[0]), 'the list row shape is unchanged');
  });
});
