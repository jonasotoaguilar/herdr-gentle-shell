'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const gh = require('../lib/gh-issues.js');
afterEach(() => gh.setGhRunner(null));
const ok = (doc) => ({ status: 0, stdout: JSON.stringify(doc), stderr: '' });
const field = (argv, name) => argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const node = (number) => ({ number, title: `Issue ${number}`, state: 'OPEN', author: { login: 'author' }, labels: { nodes: [] }, comments: { totalCount: 0 } });
function runner(handler) {
  const calls = [];
  gh.setGhRunner(async (_bin, argv) => {
    calls.push(argv);
    if (argv[0] === 'repo') return ok({ nameWithOwner: 'owner/repo' });
    return handler(argv);
  });
  return calls;
}

test('fresh pages preserve the server query, per-row cursor and requested capacity', async () => {
  let round = 0;
  const calls = runner((argv) => {
    assert.equal(argv[0], 'api');
    assert.match(field(argv, 'search'), /repo:owner\/repo/);
    assert.match(field(argv, 'search'), /assignee:@me/);
    assert.equal(field(argv, 'first'), '7');
    assert.equal(field(argv, 'cursor'), 'previous');
    return ok({ data: { search: { issueCount: 12, pageInfo: { hasNextPage: true, endCursor: 'next' }, edges: [{ cursor: 'next', node: { ...node(4), title: `Fresh ${++round}` } }] } } });
  });
  const params = { query: 'assignee:@me', after: 'previous', first: 7 };
  const first = await gh.getIssuePage(params);
  const second = await gh.getIssuePage(params);
  assert.equal(first.ok, true);
  assert.equal(first.issues[0].cursor, 'next');
  assert.equal(first.total, 12);
  assert.equal(first.hasNextPage, true);
  assert.equal(second.issues[0].title, 'Fresh 2');
  assert.equal(calls.filter((argv) => argv[0] === 'api').length, 2, 'each page request is fresh');
});

test('page budgets larger than one API page are fetched without dropping cursors', async () => {
  const calls = runner((argv) => {
    const after = field(argv, 'cursor');
    const count = Number(field(argv, 'first'));
    const start = after ? 101 : 1;
    return ok({ data: { search: { issueCount: 160, pageInfo: { hasNextPage: start + count <= 160, endCursor: `c${start + count - 1}` }, edges: Array.from({ length: count }, (_, i) => ({ cursor: `c${start + i}`, node: node(start + i) })) } } });
  });
  const result = await gh.getIssuePage({ first: 145 });
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 145);
  assert.equal(result.issues[144].cursor, 'c145');
  assert.deepEqual(calls.filter((argv) => argv[0] === 'api').map((argv) => field(argv, 'first')), ['100', '45']);
});

test('invalid page inputs produce no subprocess calls', async () => {
  const calls = runner(() => ok({}));
  for (const first of [0, -1, 1.5, NaN, 1001]) assert.equal((await gh.getIssuePage({ first })).ok, false);
  for (const params of [null, [], 'bad']) assert.equal((await gh.getIssuePage(params)).ok, false);
  assert.equal(calls.length, 0);
});

test('GraphQL errors and malformed page cursors are failures, never fake empty pages', async () => {
  runner(() => ok({ errors: [{ message: 'Forbidden' }] }));
  assert.equal((await gh.getIssuePage({ first: 5 })).ok, false);
  runner(() => ok({ data: { search: { issueCount: 1, pageInfo: { hasNextPage: true }, edges: [{ node: node(1) }] } } }));
  assert.equal((await gh.getIssuePage({ first: 5 })).ok, false);
});

test('assignable users paginate and deduplicate actual repository candidates', async () => {
  runner((argv) => {
    const after = field(argv, 'cursor');
    return ok({ data: { repository: { assignableUsers: { nodes: after ? [{ login: 'bob', name: 'Bob' }, { login: 'alice' }] : [{ login: 'alice', name: 'Alice' }], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'users-next' } } } } });
  });
  const result = await gh.listAssignableUsers();
  assert.equal(result.ok, true);
  assert.deepEqual(result.users.map((user) => user.login), ['alice', 'bob']);
});

test('assignee toggles add and remove using fixed argv with confirmed triage rights', async () => {
  const calls = runner((argv) => {
    if (argv[0] === 'api') return ok({ data: { repository: { viewerPermission: 'TRIAGE' } } });
    return { status: 0, stdout: '', stderr: '' };
  });
  const result = await gh.editAssignees(3, { add: ['alice', 'bob'], remove: ['charlie'] });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((argv) => argv[0] === 'issue'), ['issue', 'edit', '3', '--add-assignee', 'alice', '--add-assignee', 'bob', '--remove-assignee', 'charlie']);
});

test('denied and unknown repository roles cannot issue an assignee mutation', async () => {
  for (const role of ['READ', null, 'UNKNOWN_ROLE']) {
    const calls = runner(() => ok({ data: { repository: { viewerPermission: role } } }));
    const result = await gh.editAssignees(3, { add: ['alice'], remove: [] });
    assert.equal(result.ok, false);
    assert.equal(calls.some((argv) => argv[0] === 'issue'), false);
  }
});

test('malformed assignee changes are rejected before any read or write', async () => {
  const calls = runner(() => ok({}));
  for (const args of [null, [], 'bad', { add: ['--help'] }, { remove: ['bad,user'] }, { add: 'alice' }, { add: ['alice'], remove: ['alice'] }]) {
    assert.equal((await gh.editAssignees(3, args)).ok, false);
  }
  assert.equal((await gh.editAssignees(0, { add: ['alice'] })).ok, false);
  assert.equal(calls.length, 0);
});

test('permission and relation metadata is explicit and omits absent project/PR data', async () => {
  runner(() => ok({ data: { repository: { viewerPermission: 'TRIAGE', issue: { assignees: { nodes: [{ login: 'alice' }, { login: 'bob' }] }, projectItems: { nodes: [{ project: { title: 'Roadmap', url: 'https://example.invalid/project' } }] }, closedByPullRequestsReferences: { totalCount: 2 } } } } }));
  const result = await gh.getIssueMetadata(3);
  assert.equal(result.ok, true);
  assert.deepEqual(result.permissions, { canEditLabels: true, canEditAssignees: true, canCreateLabels: false });
  assert.deepEqual(result.assignees, ['alice', 'bob']);
  assert.equal(result.projects[0].title, 'Roadmap');
  assert.equal(result.linkedPullRequestCount, 2);
  runner(() => ok({ data: { repository: { viewerPermission: 'READ', issue: { assignees: { nodes: [] }, projectItems: { nodes: [] }, closedByPullRequestsReferences: { totalCount: 0 } } } } }));
  const empty = await gh.getIssueMetadata(3);
  assert.equal(empty.permissions.canEditLabels, false);
  assert.equal('projects' in empty, false);
  assert.equal('linkedPullRequestCount' in empty, false);
});

test('project scope failures preserve confirmed triage rights, assignees and linked PRs', async () => {
  runner((argv) => {
    if (field(argv, 'query').includes('projectItems')) return ok({ errors: [{ message: 'read:project scope required' }] });
    return ok({ data: { repository: { viewerPermission: 'WRITE', issue: { assignees: { nodes: [{ login: 'alice' }] }, closedByPullRequestsReferences: { totalCount: 2 } } } } });
  });
  const result = await gh.getIssueMetadata(3);
  assert.equal(result.ok, true);
  assert.equal(result.permissions.canEditAssignees, true);
  assert.equal(result.permissions.canCreateLabels, true);
  assert.deepEqual(result.assignees, ['alice']);
  assert.equal(result.linkedPullRequestCount, 2);
  assert.equal('projects' in result, false);
  assert.match(result.metadataError, /read:project/);
});

test('assignee mutation failures are not converted to success', async () => {
  runner((argv) => argv[0] === 'api' ? ok({ data: { repository: { viewerPermission: 'WRITE' } } }) : { status: 1, stdout: '', stderr: 'Forbidden' });
  const result = await gh.editAssignees(3, { add: ['alice'], remove: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /Forbidden/);
});
