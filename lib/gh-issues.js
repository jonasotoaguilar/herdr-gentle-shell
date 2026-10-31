'use strict';
// `gh` client for the issues viewer (issues-view S2,S9,S10).
//
// This module is the ONLY place that runs `gh`. Every spawn uses
// `child_process.execFile` with an argv array and NO shell string, so no
// argument (a search query, a comment body, a label name) can ever be
// interpreted by a shell. Nothing here prints or persists a token and
// nothing writes user config: authentication stays entirely inside `gh`.
//
// Injectable runner seam: `setGhRunner(fn)` replaces the default
// `execFile` runner with `fn(bin, argv, {cwd, timeoutMs})` resolving to
// `{status, stdout, stderr, error}`. Tests inject captured REAL `gh` JSON
// through it and never invoke the real binary. Pass `null` to restore the
// default runner.
//
// Every exported call returns `{ok:true, ...}` or `{ok:false, error}` and
// never throws — including a missing binary (ENOENT), a non-zero exit,
// an empty body and malformed JSON.
//
// Structured data always comes from `gh --json` output. Verified against
// `gh <cmd> --help` in this repository:
// - `gh issue list` supports `--state {open|closed|all}`, `--search`,
//   `--limit` and `--json`, but NO offset/page flag — so `listIssues`
//   fetches up to a bounded limit and pages the result in memory.
// - `gh issue view` accepts `--json` with fields including
//   number,title,state,stateReason,author,labels,createdAt,updatedAt,
//   comments,reactionGroups,url,body, but REJECTS `--comments` together
//   with `--json` (`specify only one of --comments or --json`) — so
//   `getIssue` reads comments from the single `--json` call, which embeds
//   them. `authorAssociation`, `reactions` and `isPullRequest` are NOT
//   valid `--json` fields (gh errors `Unknown JSON field`), so the
//   normalized shapes carry honest defaults for those instead of asking
//   `gh` for fields it cannot return.
// - `gh label list --json name,color,description` and
//   `gh label create <name> [--color … --description …]` as documented.
// - `gh issue edit --add-label/--remove-label`, `gh issue comment --body`,
//   `gh issue close` / `gh issue reopen` as documented.
// - Identity via `gh api user` (JSON with `login`) and the repository via
//   `gh repo view --json nameWithOwner`; `gh auth status` failures surface
//   as unauthenticated errors from the same calls.

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 30000;
const LIST_FETCH_MAX = 500;
const LABEL_FETCH_MAX = 500;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
// `gh issue list` has no offset flag and the SEARCH API caps its own result
// set, so a complete open-issue snapshot is read through the GraphQL
// connection: `first` is the server page size and `after` walks it to the end.
const GRAPHQL_PAGE_SIZE = 100;
// Runaway guard, never a data cutoff: 100 issues per page, so only a
// pathological repository (250k open issues) can reach it. Every page also
// runs under DEFAULT_TIMEOUT_MS, so a hung request cannot hold the loop.
const SNAPSHOT_MAX_PAGES = 2500;
// Search-syntax qualifier: the source asks `gh` for last-update ordering so
// every consumer inherits it (S10).
const LAST_UPDATED_SORT = 'sort:updated-desc';

const ISSUE_LIST_JSON_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'labels',
  'createdAt', 'updatedAt', 'comments', 'reactionGroups', 'url',
].join(',');
// The detail pane needs the issue `body`, so the single-issue fetch keeps
// the full field set; the list never asks for it (getIssue owns bodies).
const ISSUE_DETAIL_JSON_FIELDS = [
  'number', 'title', 'state', 'stateReason', 'author', 'assignees', 'labels',
  'createdAt', 'updatedAt', 'comments', 'reactionGroups', 'url', 'body',
].join(',');
const LABEL_JSON_FIELDS = 'name,color,description';

// The whole open set as a cursor-paged connection. The row fields are the ones
// `normalizeIssue` reads, in the GraphQL shapes (`labels`/`comments` arrive as
// connections); `graphqlIssueRow` reshapes them.
const OPEN_ISSUES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        state
        stateReason
        url
        createdAt
        updatedAt
        author { login }
        labels(first: 50) { nodes { name color description } }
        comments { totalCount }
        reactionGroups { content users { totalCount } }
      }
    }
  }
}`;

let runnerOverride = null;

// Test seam: inject `fn(bin, argv, runOpts)` (may be sync or async), or
// `null`/`undefined` to restore the default `execFile` runner.
function setGhRunner(fn) {
  if (fn === null || fn === undefined) {
    runnerOverride = null;
    return;
  }
  if (typeof fn !== 'function') throw new TypeError('setGhRunner requires a function or null');
  runnerOverride = fn;
}

function ghBinary(opts = {}) {
  if (typeof opts.ghBin === 'string' && opts.ghBin.length > 0) return opts.ghBin;
  const env = opts.env || process.env;
  const fromEnv = env && env.GH_BIN_PATH;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return 'gh';
}

// Default runner over execFile: argv array, no shell, bounded timeout.
// Always resolves to {status, stdout, stderr, error}; never throws.
function defaultRunner(bin, argv, runOpts = {}) {
  const timeout = Number.isFinite(runOpts.timeoutMs) && runOpts.timeoutMs > 0
    ? Math.floor(runOpts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(bin, argv, {
        cwd: runOpts.cwd,
        timeout,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (!err) {
          resolve({ status: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
          return;
        }
        // ENOENT / spawn failures carry no status: keep the signal text so
        // callers can name the missing binary.
        if (err.code === 'ENOENT' || /ENOENT/i.test(err.message || '')) {
          resolve({
            status: null, stdout: String(stdout || ''), stderr: String(stderr || ''),
            error: `spawn ${bin} ENOENT: gh CLI is not available`,
          });
          return;
        }
        if (err.killed) {
          resolve({
            status: null, stdout: String(stdout || ''), stderr: String(stderr || ''),
            error: `gh timed out after ${timeout}ms`,
          });
          return;
        }
        // Non-zero exit: status plus whatever the command printed.
        const status = typeof err.code === 'number' ? err.code : null;
        resolve({ status, stdout: String(stdout || ''), stderr: String(stderr || ''), error: null });
      });
    } catch (err) {
      resolve({
        status: null, stdout: '', stderr: '',
        error: (err && err.message) || String(err),
      });
      return;
    }
    if (!child) {
      resolve({ status: null, stdout: '', stderr: '', error: 'gh runner produced no child process' });
    }
  });
}

async function runGh(argv, opts = {}) {
  const bin = ghBinary(opts);
  const runOpts = { cwd: opts.cwd, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS };
  const run = runnerOverride || defaultRunner;
  let raw;
  try {
    raw = await run(bin, argv, runOpts);
  } catch (err) {
    return {
      bin, argv, status: null, stdout: '', stderr: '',
      error: (err && err.message) || String(err),
    };
  }
  const outcome = raw && typeof raw === 'object' ? raw : {};
  return {
    bin,
    argv,
    status: typeof outcome.status === 'number' ? outcome.status : null,
    stdout: typeof outcome.stdout === 'string' ? outcome.stdout : '',
    stderr: typeof outcome.stderr === 'string' ? outcome.stderr : '',
    error: outcome.error === null || outcome.error === undefined ? null : String(outcome.error),
  };
}

// Failure text for a non-zero `gh` exit: prefer stderr (where gh explains
// auth and resolution problems), fall back to the bare status.
function exitError(outcome, what) {
  const stderr = (outcome.stderr || '').trim();
  if (stderr) return `${what}: ${stderr.split('\n')[0].slice(0, 500)}`;
  if (outcome.status !== null) return `${what}: gh exited with status ${outcome.status}`;
  return `${what}: gh failed`;
}

function parseJsonBody(stdout, what) {
  const text = (stdout || '').trim();
  if (!text) return { ok: false, error: `${what}: gh returned an empty body` };
  try {
    return { ok: true, doc: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${what}: gh returned unparseable output` };
  }
}

function asLogin(author) {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && typeof author.login === 'string') return author.login;
  return '';
}

// `reactionGroups` (the field gh actually returns) sums to a total with
// the THUMBS_UP share kept as plusOne. Unknown shapes sum to zero rather
// than failing the whole call.
function sumReactions(reactionGroups) {
  let total = 0;
  let plusOne = 0;
  if (!Array.isArray(reactionGroups)) return { total: 0, plusOne: 0 };
  for (const group of reactionGroups) {
    if (!group || typeof group !== 'object') continue;
    const count = group && typeof group === 'object'
      ? (group.users && typeof group.users.totalCount === 'number'
        ? group.users.totalCount
        : (typeof group.reactors === 'object' && group.reactors !== null
          && typeof group.reactors.totalCount === 'number'
          ? group.reactors.totalCount
          : (typeof group.totalCount === 'number' ? group.totalCount : 0)))
      : 0;
    total += count;
    if (group.content === 'THUMBS_UP') plusOne += count;
  }
  return { total, plusOne };
}

function asLabel(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  return {
    name: typeof entry.name === 'string' ? entry.name : '',
    color: typeof entry.color === 'string' ? entry.color : '',
    description: typeof entry.description === 'string' ? entry.description : '',
  };
}

function normalizeIssue(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const comments = Array.isArray(entry.comments) ? entry.comments : [];
  return {
    number: typeof entry.number === 'number' ? entry.number : -1,
    title: typeof entry.title === 'string' ? entry.title : '',
    state: typeof entry.state === 'string' ? entry.state.toLowerCase() : '',
    stateReason: typeof entry.stateReason === 'string' ? entry.stateReason : '',
    author: asLogin(entry.author),
    // `assignees` arrives only on the detail fetch (the list field set
    // omits it, so list rows keep their shape); entries are {login}
    // objects like `author`, normalized through the same helper.
    assignees: Array.isArray(entry.assignees)
      ? entry.assignees.map(asLogin).filter((name) => name !== '')
      : [],
    // `gh issue list/view --json` has no authorAssociation field
    // (verified: `Unknown JSON field`); the honest default is ''.
    authorAssociation: typeof entry.authorAssociation === 'string' ? entry.authorAssociation : '',
    labels: Array.isArray(entry.labels) ? entry.labels.map(asLabel) : [],
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
    commentsCount: Number.isInteger(entry.commentsTotal) && entry.commentsTotal >= 0
      ? entry.commentsTotal
      : comments.length,
    reactions: sumReactions(entry.reactionGroups || entry.reactions),
    url: typeof entry.url === 'string' ? entry.url : '',
    body: typeof entry.body === 'string' ? entry.body : '',
    // `gh` exposes no isPullRequest JSON field for issues; issues listed
    // here are issues, so the honest default is false.
    isPullRequest: entry.isPullRequest === true,
  };
}

function normalizeComment(raw, fallbackId) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = typeof entry.id === 'string' || typeof entry.id === 'number'
    ? entry.id
    : (typeof entry.databaseId === 'number' ? entry.databaseId : fallbackId);
  return {
    id,
    author: asLogin(entry.author),
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    body: typeof entry.body === 'string' ? entry.body : '',
    reactions: sumReactions(entry.reactionGroups || entry.reactions),
  };
}

function normalizeStateFilter(state) {
  if (state === undefined || state === null || state === '') return 'open';
  const lowered = String(state).toLowerCase();
  if (lowered === 'open' || lowered === 'closed' || lowered === 'all') return lowered;
  return null;
}

function normalizePaging(page, pageSize) {
  let p = Number(page);
  if (!Number.isFinite(p) || p < 1) p = 1;
  p = Math.floor(p);
  let s = Number(pageSize);
  if (!Number.isFinite(s) || s < 1) s = DEFAULT_PAGE_SIZE;
  s = Math.min(Math.floor(s), MAX_PAGE_SIZE);
  return { page: p, pageSize: s };
}

// Authenticated identity plus the repository in scope.
// `{ok:true, login, nameWithOwner}`; a repository that cannot be resolved
// still reports the login with `nameWithOwner: null`.
async function ghStatus(opts = {}) {
  const user = await runGh(['api', 'user'], opts);
  if (user.error) return { ok: false, error: user.error };
  if (user.status !== 0) return { ok: false, error: exitError(user, 'gh is not authenticated (run `gh auth login`)') };
  const parsedUser = parseJsonBody(user.stdout, 'gh api user');
  if (!parsedUser.ok) return parsedUser;
  const login = parsedUser.doc && typeof parsedUser.doc.login === 'string' ? parsedUser.doc.login : '';
  if (!login) return { ok: false, error: 'gh api user returned an unexpected shape' };
  const repo = await runGh(['repo', 'view', '--json', 'nameWithOwner'], opts);
  if (repo.error || repo.status !== 0) return { ok: true, login, nameWithOwner: null };
  const parsedRepo = parseJsonBody(repo.stdout, 'gh repo view');
  if (!parsedRepo.ok) return { ok: true, login, nameWithOwner: null };
  const nameWithOwner = parsedRepo.doc && typeof parsedRepo.doc.nameWithOwner === 'string'
    ? parsedRepo.doc.nameWithOwner
    : null;
  return { ok: true, login, nameWithOwner };
}

async function repoInfo(opts = {}) {
  const resolved = await repoNameWithOwner(opts);
  if (!resolved.ok) return resolved;
  const user = await runGh(['api', 'user'], opts);
  let viewer = null;
  if (!user.error && user.status === 0) {
    const parsedUser = parseJsonBody(user.stdout, 'gh api user');
    if (parsedUser.ok && parsedUser.doc && typeof parsedUser.doc.login === 'string') {
      viewer = parsedUser.doc.login;
    }
  }
  return { ok: true, nameWithOwner: resolved.nameWithOwner, viewer };
}

// The repository in scope, in one call. Split out of `repoInfo` so a GraphQL
// read does not also pay for the identity lookup.
async function repoNameWithOwner(opts = {}) {
  const repo = await runGh(['repo', 'view', '--json', 'nameWithOwner'], opts);
  if (repo.error) return { ok: false, error: repo.error };
  if (repo.status !== 0) return { ok: false, error: exitError(repo, 'cannot resolve the repository') };
  const parsedRepo = parseJsonBody(repo.stdout, 'gh repo view');
  if (!parsedRepo.ok) return parsedRepo;
  const nameWithOwner = parsedRepo.doc && typeof parsedRepo.doc.nameWithOwner === 'string'
    ? parsedRepo.doc.nameWithOwner
    : '';
  if (!nameWithOwner) return { ok: false, error: 'gh repo view returned an unexpected shape' };
  return { ok: true, nameWithOwner };
}

// The list order belongs to the QUERY, never to a JavaScript re-sort
// (S10): `gh issue list --search` takes the search syntax, so the
// most-recently-updated ordering is one qualifier on the caller's query.
// A caller that already passed an explicit `sort:` keeps it — a second
// qualifier would be ambiguous, so theirs wins.
function withLastUpdatedSort(search) {
  if (/\bsort:/i.test(search)) return search;
  return search ? `${search} ${LAST_UPDATED_SORT}` : LAST_UPDATED_SORT;
}

// Paged listing. `gh issue list` has no offset flag, so the call fetches
// ONCE up to the bound and slices the requested page in memory; `total`
// is the fetched count and `truncated` is true exactly when it reached
// the bound (a lower bound, never the exact total). `opts.fetchMax`
// overrides the bound (default LIST_FETCH_MAX) so tests can exercise
// truncation without 500 fixtures. `wholeResult` returns the ENTIRE fetched
// set instead of one page, for a caller whose bound is its own completeness
// proof (the viewer's buckets, bounded by the open snapshot's count):
// slicing a page there would throw away rows already downloaded. The list
// fetch omits `body` (the detail pane reads it through `getIssue`); every
// other row field the view's list uses still arrives, so list rows render
// unchanged. A caller that needs the whole open set uses `listAllOpenIssues`
// instead: a page sliced from one bounded fetch is not every page.
async function listIssues({ query = '', state = 'open', page = 1, pageSize = DEFAULT_PAGE_SIZE, wholeResult = false } = {}, opts = {}) {
  const stateFilter = normalizeStateFilter(state);
  if (stateFilter === null) return { ok: false, error: `invalid state ${JSON.stringify(state)}: want open, closed or all` };
  const paging = normalizePaging(page, pageSize);
  const search = withLastUpdatedSort(typeof query === 'string' ? query.trim() : '');
  const rawMax = opts && opts.fetchMax != null ? Number(opts.fetchMax) : LIST_FETCH_MAX;
  const bound = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : LIST_FETCH_MAX;
  const fetchLimit = bound;
  const argv = ['issue', 'list', '--state', stateFilter, '--limit', String(fetchLimit), '--json', ISSUE_LIST_JSON_FIELDS];
  if (search) argv.splice(4, 0, '--search', search);
  const res = await runGh(argv, opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, 'gh issue list failed') };
  const parsed = parseJsonBody(res.stdout, 'gh issue list');
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.doc)) return { ok: false, error: 'gh issue list returned an unexpected shape' };
  const normalized = parsed.doc.map(normalizeIssue);
  // The list never asked for `assignees`: drop the normalized default so
  // list rows keep their exact shape (only getIssue carries assignees).
  for (const item of normalized) delete item.assignees;
  const total = normalized.length;
  const truncated = total >= bound;
  if (wholeResult === true) {
    return { ok: true, issues: normalized, total, truncated, page: paging.page, pageSize: paging.pageSize };
  }
  const start = (paging.page - 1) * paging.pageSize;
  return {
    ok: true,
    issues: normalized.slice(start, start + paging.pageSize),
    total,
    truncated,
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

// The GraphQL connection carries the same row facts in different shapes:
// `labels` and `comments` are connections. Reshape them into the payload
// `normalizeIssue` understands, handing the comment count over as a number so
// the snapshot never materializes comment arrays it does not need.
function graphqlIssueRow(node) {
  const entry = node && typeof node === 'object' ? node : {};
  const labelNodes = entry.labels && typeof entry.labels === 'object' && Array.isArray(entry.labels.nodes)
    ? entry.labels.nodes
    : [];
  const commentsTotal = entry.comments && typeof entry.comments === 'object'
    && Number.isInteger(entry.comments.totalCount)
    ? entry.comments.totalCount
    : 0;
  return { ...entry, labels: labelNodes, comments: [], commentsTotal };
}

// EVERY open issue of the repository, read through the GraphQL connection.
// Each page is validated before it is trusted: GraphQL errors fail the whole
// snapshot, `hasNextPage` must come with a non-empty cursor this loop has not
// used yet, and the terminal page must have delivered exactly `totalCount`
// distinct issues. Anything short of that is a failed snapshot — never a
// partial set a caller could read as "these issues are gone". `opts` reaches
// `runGh`, so each page also runs under its bounded timeout.
async function listAllOpenIssues(opts = {}) {
  const resolved = await repoNameWithOwner(opts);
  if (!resolved.ok) return resolved;
  const slash = resolved.nameWithOwner.indexOf('/');
  if (slash <= 0 || slash === resolved.nameWithOwner.length - 1) {
    return { ok: false, error: `gh repo view returned an unexpected shape: ${JSON.stringify(resolved.nameWithOwner)}` };
  }
  const owner = resolved.nameWithOwner.slice(0, slash);
  const name = resolved.nameWithOwner.slice(slash + 1);
  const issues = [];
  const seen = new Set();
  const cursors = new Set();
  let cursor = null;
  for (let page = 1; page <= SNAPSHOT_MAX_PAGES; page += 1) {
    const argv = [
      'api', 'graphql',
      '-f', `query=${OPEN_ISSUES_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `first=${GRAPHQL_PAGE_SIZE}`,
    ];
    if (cursor !== null) argv.push('-F', `cursor=${cursor}`);
    const res = await runGh(argv, opts);
    if (res.error) return { ok: false, error: res.error };
    if (res.status !== 0) return { ok: false, error: exitError(res, 'gh api graphql failed') };
    const parsed = parseJsonBody(res.stdout, 'gh api graphql');
    if (!parsed.ok) return parsed;
    const doc = parsed.doc;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, error: 'gh api graphql returned an unexpected shape' };
    }
    if (Array.isArray(doc.errors) && doc.errors.length > 0) {
      const message = doc.errors[0] && typeof doc.errors[0].message === 'string'
        ? doc.errors[0].message
        : 'unknown GraphQL error';
      return { ok: false, error: `gh api graphql failed: ${message}` };
    }
    const repository = doc.data && typeof doc.data === 'object' ? doc.data.repository : null;
    const connection = repository && typeof repository === 'object' ? repository.issues : null;
    if (!connection || typeof connection !== 'object' || !Array.isArray(connection.nodes)) {
      return { ok: false, error: 'gh api graphql returned an unexpected shape' };
    }
    const total = connection.totalCount;
    if (!Number.isInteger(total) || total < 0) {
      return { ok: false, error: 'gh api graphql returned no open-issue total' };
    }
    for (const node of connection.nodes) {
      const row = graphqlIssueRow(node);
      if (!Number.isInteger(row.number) || row.number <= 0) {
        return { ok: false, error: 'gh api graphql returned an issue without a number' };
      }
      // A duplicate adds nothing and would make the terminal count a lie; the
      // count check below catches the shortfall it causes.
      if (seen.has(row.number)) continue;
      seen.add(row.number);
      issues.push(normalizeIssue(row));
    }
    const pageInfo = connection.pageInfo && typeof connection.pageInfo === 'object' ? connection.pageInfo : {};
    if (pageInfo.hasNextPage !== true) {
      if (issues.length !== total) {
        return { ok: false, error: `gh api graphql returned ${issues.length} of ${total} open issues; the snapshot is incomplete` };
      }
      return { ok: true, issues, total, pages: page };
    }
    const endCursor = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : '';
    if (endCursor === '') return { ok: false, error: 'gh api graphql reported another page without a cursor' };
    if (cursors.has(endCursor)) {
      return { ok: false, error: `gh api graphql repeated the cursor ${endCursor}; the snapshot cannot advance` };
    }
    cursors.add(endCursor);
    cursor = endCursor;
  }
  return { ok: false, error: `could not page through every open issue: stopped after ${SNAPSHOT_MAX_PAGES} pages` };
}

// A non-zero `gh` exit caused by the issue NOT EXISTING is the one failure a
// caller may act on destructively (drop a stored association); every other
// failure leaves the question open. Authentication, permission and transport
// wording always wins over the not-found patterns, because a private
// repository answers 404 for an issue the reader merely cannot see. Only
// ISSUE-specific wording is proof: a repository-level `Not Found (HTTP 404)`
// names no issue and is the answer for an inaccessible or renamed repository,
// so it never justifies dropping a stored number.
const NOT_FOUND_PATTERN = /could not resolve to an? (?:issue|pull request)|no (?:such|matching) issue/i;
const UNVERIFIABLE_PATTERN = /401|403|bad credentials|authenticat|permission|forbidden|saml|enoent|timed out|timeout|dial tcp|no such host|connection refused|network/i;

function issueViewFailure(res, number) {
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  const notFound = typeof res.status === 'number' && res.status !== 0
    && !UNVERIFIABLE_PATTERN.test(text)
    && NOT_FOUND_PATTERN.test(text);
  return {
    ok: false,
    error: exitError(res, `cannot view issue #${number}`),
    status: res.status,
    notFound,
  };
}

async function getIssue(number, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer`, status: null, notFound: false };
  const res = await runGh(['issue', 'view', String(number), '--json', ISSUE_DETAIL_JSON_FIELDS], opts);
  if (res.error) return { ok: false, error: res.error, status: null, notFound: false };
  if (res.status !== 0) return issueViewFailure(res, number);
  const parsed = parseJsonBody(res.stdout, `gh issue view ${number}`);
  if (!parsed.ok) return parsed;
  if (!parsed.doc || typeof parsed.doc !== 'object' || typeof parsed.doc.number !== 'number') {
    return { ok: false, error: `gh issue view ${number} returned an unexpected shape` };
  }
  const rawComments = Array.isArray(parsed.doc.comments) ? parsed.doc.comments : [];
  const issue = normalizeIssue(parsed.doc);
  if (opts.includeMetadata === true) {
    const metadata = await getIssueMetadata(number, opts);
    if (metadata.ok) {
      const { ok: _ok, ...fields } = metadata;
      Object.assign(issue, fields);
    } else {
      issue.permissions = repositoryEditPermissions(null);
      issue.metadataError = metadata.error;
    }
  }
  return {
    ok: true,
    issue,
    comments: rawComments.map((entry, index) => normalizeComment(entry, index)),
  };
}


// These page helpers retain server search semantics instead of inferring
// author/assignee/involvement buckets from incomplete local metadata.
const PAGE_ISSUE_FIELDS = `number title state stateReason url createdAt updatedAt
  author { login } labels(first: 50) { nodes { name color description } }
  comments { totalCount } reactionGroups { content users { totalCount } }`;
const ISSUE_PAGE_QUERY = `query($search: String!, $first: Int!, $cursor: String) {
  search(query: $search, type: ISSUE, first: $first, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor }
    edges { cursor node { ... on Issue { ${PAGE_ISSUE_FIELDS} } } }
  }
}`;

async function feedbackGraphql(query, fields, opts) {
  const argv = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) argv.push('-F', `${name}=${value}`);
  }
  const result = await runGh(argv, opts);
  if (result.error) return { ok: false, error: result.error };
  if (result.status !== 0) return { ok: false, error: exitError(result, 'GitHub query failed') };
  const parsed = parseJsonBody(result.stdout, 'GitHub query');
  if (!parsed.ok) return parsed;
  if (Array.isArray(parsed.doc?.errors) && parsed.doc.errors.length > 0) {
    return { ok: false, error: parsed.doc.errors[0]?.message || 'GitHub query failed' };
  }
  if (!parsed.doc?.data || typeof parsed.doc.data !== 'object') {
    return { ok: false, error: 'GitHub query returned no data' };
  }
  return { ok: true, data: parsed.doc.data };
}

async function feedbackRepository(opts) {
  const repo = await repoNameWithOwner(opts);
  if (!repo.ok) return repo;
  const parts = repo.nameWithOwner.split('/');
  if (parts.length !== 2 || !parts.every((part) => part && !/\s/.test(part))) {
    return { ok: false, error: 'GitHub returned an invalid repository name' };
  }
  return { ok: true, owner: parts[0], name: parts[1], fullName: repo.nameWithOwner };
}

async function getIssuePage(params = {}, opts = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid issue page' };
  const { query = '', after = null, first = DEFAULT_PAGE_SIZE } = params;
  if (!Number.isInteger(first) || first < 1 || first > 1000
    || typeof query !== 'string' || (after !== null && (typeof after !== 'string' || !after))) {
    return { ok: false, error: 'invalid issue page: first must be 1..1000 and cursor must be a non-empty string or null' };
  }
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const search = withLastUpdatedSort(`repo:${repo.fullName} is:issue is:open ${query}`.trim());
  const issues = [];
  const seen = new Set();
  const rowCursors = new Set(after === null ? [] : [after]);
  const cursors = new Set(after === null ? [] : [after]);
  let cursor = after;
  let total = 0;
  let hasNextPage = false;
  while (issues.length < first) {
    const count = Math.min(MAX_PAGE_SIZE, first - issues.length);
    const res = await feedbackGraphql(ISSUE_PAGE_QUERY, { search, first: count, cursor }, opts);
    if (!res.ok) return res;
    const page = res.data.search;
    if (!Array.isArray(page?.edges) || !Number.isInteger(page.issueCount) || page.issueCount < 0
      || typeof page.pageInfo?.hasNextPage !== 'boolean') {
      return { ok: false, error: 'GitHub returned an invalid issue page' };
    }
    // GitHub search cannot page beyond 1000 matches. Never advertise a full
    // result set when its server-side limit makes that impossible.
    if (page.issueCount > 1000) return { ok: false, error: 'GitHub issue search exceeds 1000 matches; narrow the filter', truncated: true };
    total = page.issueCount;
    if (page.edges.length > count) return { ok: false, error: 'GitHub exceeded the requested issue page size' };
    for (const edge of page.edges) {
      if (typeof edge?.cursor !== 'string' || !edge.cursor || !Number.isInteger(edge.node?.number)
        || edge.node.number < 1 || seen.has(edge.node.number) || rowCursors.has(edge.cursor)) {
        return { ok: false, error: 'GitHub returned an invalid issue cursor or duplicate issue' };
      }
      seen.add(edge.node.number);
      rowCursors.add(edge.cursor);
      if (String(edge.node.state).toLowerCase() === 'open') {
        issues.push({ ...normalizeIssue(graphqlIssueRow(edge.node)), cursor: edge.cursor });
      }
    }
    hasNextPage = page.pageInfo.hasNextPage;
    if (!hasNextPage) break;
    const next = page.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || cursors.has(next) || page.edges.length === 0) {
      return { ok: false, error: 'GitHub issue pagination did not advance' };
    }
    cursors.add(next);
    // A short server page is still a valid page. Its cursor belongs to the
    // caller; filling it by issuing another request would skip that boundary.
    if (page.edges.length < count) break;
    cursor = next;
  }
  return { ok: true, issues, total, hasNextPage };
}

// T2 (S2): the unfiltered `All` bucket reads the repository's own issue
// CONNECTION instead of the search API. GitHub refuses to page a SEARCH result
// set past 1000 matches, while `repository.issues` is cursor-paged to its end,
// reports the exact `totalCount` and gives every edge its own `cursor`. The
// ordering is part of the query (`UPDATED_AT DESC`), so no caller re-sorts, and
// the state filter is an explicit literal: a `closed` read asks for CLOSED and
// is never widened back to OPEN. The literal comes from this fixed whitelist,
// never from caller text.
const CONNECTION_STATE_LITERALS = {
  open: 'states: [OPEN]',
  closed: 'states: [CLOSED]',
  all: 'states: [OPEN, CLOSED]',
};

function issueConnectionQuery(states) {
  return `query($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(${states}, first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { cursor node { ${PAGE_ISSUE_FIELDS} } }
    }
  }
}`;
}

// One cursor page of the UNFILTERED issue connection, in exactly the shape the
// viewer's page loader consumes (`{ok, issues, total, hasNextPage}` with a
// per-row `cursor`), so a bucket can switch source without changing its reader.
//
// `state` is explicit — `open` (default, the viewer's own scope), `closed` or
// `all` — and maps to a fixed GraphQL `states` literal. There is no search text
// here: `repository.issues` cannot take one, so a non-blank `query` is refused
// rather than silently listed unfiltered; typed searches stay on
// `getIssuePage`, whose 1000-match search cap is real.
//
// `first` is the caller's row budget (1..1000) and is filled by as many 100-row
// server pages as it needs, keeping every row's own cursor. Pages are validated
// before they are trusted: GraphQL errors fail the call, a cursor or issue
// repeated inside one call is an error (a silent drop would make the totals
// lie), and a non-advancing or cursorless `hasNextPage` fails instead of
// looping. A failed continuation page is a FAILURE, never a short page a caller
// could read as the end of the list. `total` is the server's exact `totalCount`
// at request time; the rows are a cursor walk, not a snapshot, so concurrent
// updates can shift what the walk sees.
async function getIssueConnectionPage(params = {}, opts = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid issue page' };
  const { after = null, first = DEFAULT_PAGE_SIZE } = params;
  if (!Number.isInteger(first) || first < 1 || first > 1000
    || (after !== null && (typeof after !== 'string' || !after))) {
    return { ok: false, error: 'invalid issue page: first must be 1..1000 and cursor must be a non-empty string or null' };
  }
  const state = params.state === undefined || params.state === null || params.state === ''
    ? 'open'
    : String(params.state).toLowerCase();
  const states = CONNECTION_STATE_LITERALS[state];
  if (!states) {
    return { ok: false, error: `invalid issue state ${JSON.stringify(params.state)}: want open, closed or all` };
  }
  if (typeof params.query === 'string' && params.query.trim() !== '') {
    return { ok: false, error: 'the issue connection has no search text: pass no query and use getIssuePage for a search' };
  }
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const query = issueConnectionQuery(states);
  const issues = [];
  const seen = new Set();
  const rowCursors = new Set(after === null ? [] : [after]);
  const cursors = new Set(after === null ? [] : [after]);
  let cursor = after;
  let total = 0;
  let hasNextPage = false;
  while (issues.length < first) {
    const count = Math.min(MAX_PAGE_SIZE, first - issues.length);
    const res = await feedbackGraphql(query, { owner: repo.owner, name: repo.name, first: count, cursor }, opts);
    if (!res.ok) return res;
    const connection = res.data.repository && typeof res.data.repository === 'object'
      ? res.data.repository.issues
      : null;
    if (!Array.isArray(connection?.edges) || !Number.isInteger(connection.totalCount)
      || connection.totalCount < 0 || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      return { ok: false, error: 'GitHub returned an invalid issue page' };
    }
    total = connection.totalCount;
    if (connection.edges.length > count) return { ok: false, error: 'GitHub exceeded the requested issue page size' };
    for (const edge of connection.edges) {
      if (typeof edge?.cursor !== 'string' || !edge.cursor || !Number.isInteger(edge.node?.number)
        || edge.node.number < 1 || seen.has(edge.node.number) || rowCursors.has(edge.cursor)) {
        return { ok: false, error: 'GitHub returned an invalid issue cursor or duplicate issue' };
      }
      seen.add(edge.node.number);
      rowCursors.add(edge.cursor);
      issues.push({ ...normalizeIssue(graphqlIssueRow(edge.node)), cursor: edge.cursor });
    }
    hasNextPage = connection.pageInfo.hasNextPage;
    if (!hasNextPage) break;
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || cursors.has(next) || connection.edges.length === 0) {
      return { ok: false, error: 'GitHub issue pagination did not advance' };
    }
    cursors.add(next);
    // A short server page is still a valid page. Its cursor belongs to the
    // caller; filling it by issuing another request would skip that boundary.
    if (connection.edges.length < count) break;
    cursor = next;
  }
  return { ok: true, issues, total, hasNextPage };
}

function repositoryEditPermissions(role) {
  const edits = ['TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN'].includes(role);
  return {
    canEditLabels: edits,
    canEditAssignees: edits,
    canCreateLabels: ['WRITE', 'MAINTAIN', 'ADMIN'].includes(role),
  };
}

async function getIssueMetadata(number, opts = {}) {
  if (!Number.isInteger(number) || number < 1) return { ok: false, error: 'invalid issue number' };
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      viewerPermission
      issue(number: $number) {
        assignees(first: 100) { nodes { login } pageInfo { hasNextPage } }
        closedByPullRequestsReferences(first: 1, includeClosedPrs: true) { totalCount }
      }
    }
  }`;
  const res = await feedbackGraphql(query, { owner: repo.owner, name: repo.name, number }, opts);
  if (!res.ok) return res;
  const repository = res.data.repository;
  if (!repository?.issue) return { ok: false, error: 'Issue metadata is unavailable' };
  const issue = repository.issue;
  if (!Array.isArray(issue.assignees?.nodes) || issue.assignees.pageInfo?.hasNextPage) {
    return { ok: false, error: 'Issue assignees are unavailable or incomplete' };
  }
  const metadata = {
    ok: true,
    permissions: repositoryEditPermissions(repository.viewerPermission),
    assignees: issue.assignees.nodes.map(asLogin).filter(Boolean),
  };
  const count = issue.closedByPullRequestsReferences?.totalCount;
  if (Number.isInteger(count) && count > 0) metadata.linkedPullRequestCount = count;
  if (!Number.isInteger(count) || count < 0) metadata.metadataError = 'Linked PR metadata is unavailable';
  // Project visibility/scopes are independent of issue triage permissions.
  // A private or unsupported project relation must not disable known rights.
  const relations = await feedbackGraphql(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        projectItems(first: 100) { nodes { project { title url } } pageInfo { hasNextPage } }
      }
    }
  }`, { owner: repo.owner, name: repo.name, number }, opts);
  const related = relations.ok ? relations.data.repository?.issue : null;
  if (!Array.isArray(related?.projectItems?.nodes) || related.projectItems.pageInfo?.hasNextPage) {
    metadata.metadataError = relations.error || 'Project metadata is unavailable or incomplete';
    return metadata;
  }
  const projects = related.projectItems.nodes.map((item) => item?.project)
    .filter((project) => typeof project?.title === 'string' && project.title);
  if (projects.length > 0) metadata.projects = projects.map(({ title, url }) => ({ title, url }));
  return metadata;
}

async function listAssignableUsers(opts = {}) {
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const query = `query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      assignableUsers(first: 100, after: $cursor) {
        nodes { login name } pageInfo { hasNextPage endCursor }
      }
    }
  }`;
  const users = [];
  const logins = new Set();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < SNAPSHOT_MAX_PAGES; page += 1) {
    const res = await feedbackGraphql(query, { owner: repo.owner, name: repo.name, cursor }, opts);
    if (!res.ok) return res;
    const connection = res.data.repository?.assignableUsers;
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      return { ok: false, error: 'GitHub returned an invalid assignable-user page' };
    }
    for (const user of connection.nodes) {
      if (typeof user?.login !== 'string' || !user.login) return { ok: false, error: 'GitHub returned an invalid assignable user' };
      const id = user.login.toLowerCase();
      if (!logins.has(id)) {
        logins.add(id);
        users.push({ login: user.login, name: typeof user.name === 'string' ? user.name : '' });
      }
    }
    if (!connection.pageInfo.hasNextPage) return { ok: true, users };
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || cursors.has(next)) return { ok: false, error: 'Assignable-user pagination did not advance' };
    cursors.add(next);
    cursor = next;
  }
  return { ok: false, error: 'Assignable-user pagination exceeded its safety budget' };
}

async function editAssignees(number, changes = {}, opts = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { ok: false, error: 'invalid assignee changes' };
  const { add = [], remove = [] } = changes;
  const valid = (values) => Array.isArray(values) && values.every((value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value));
  if (!Number.isInteger(number) || number < 1 || !valid(add) || !valid(remove)
    || add.some((name) => remove.some((other) => name.toLowerCase() === other.toLowerCase()))) {
    return { ok: false, error: 'invalid assignee changes: supply distinct GitHub logins to add or remove' };
  }
  if (add.length === 0 && remove.length === 0) return { ok: true, changed: false };
  const repo = await feedbackRepository(opts);
  if (!repo.ok) return repo;
  const access = await feedbackGraphql('query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { viewerPermission } }', { owner: repo.owner, name: repo.name }, opts);
  if (!access.ok) return access;
  if (!repositoryEditPermissions(access.data.repository?.viewerPermission).canEditAssignees) {
    return { ok: false, error: 'Repository permission does not allow changing issue assignees' };
  }
  const argv = ['issue', 'edit', String(number)];
  for (const name of new Set(add)) argv.push('--add-assignee', name);
  for (const name of new Set(remove)) argv.push('--remove-assignee', name);
  const result = await runGh(argv, opts);
  if (result.error) return { ok: false, error: result.error };
  if (result.status !== 0) return { ok: false, error: exitError(result, 'Cannot edit issue assignees') };
  return { ok: true, changed: true };
}

async function listLabels(opts = {}) {
  const res = await runGh(['label', 'list', '--limit', String(LABEL_FETCH_MAX), '--json', LABEL_JSON_FIELDS], opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, 'gh label list failed') };
  const parsed = parseJsonBody(res.stdout, 'gh label list');
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.doc)) return { ok: false, error: 'gh label list returned an unexpected shape' };
  return { ok: true, labels: parsed.doc.map(asLabel) };
}

async function createLabel({ name, color, description } = {}, opts = {}) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'label name must be a non-empty string' };
  }
  const argv = ['label', 'create', name];
  if (typeof color === 'string' && color !== '') argv.push('--color', color);
  if (typeof description === 'string' && description !== '') argv.push('--description', description);
  const res = await runGh(argv, opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot create label ${name}`) };
  return { ok: true, label: { name, color: color || '', description: description || '' } };
}

async function editLabels(number, { add = [], remove = [] } = {}, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer` };
  const additions = Array.isArray(add) ? add.filter((entry) => typeof entry === 'string' && entry !== '') : [];
  const removals = Array.isArray(remove) ? remove.filter((entry) => typeof entry === 'string' && entry !== '') : [];
  if (additions.length === 0 && removals.length === 0) return { ok: true };
  const argv = ['issue', 'edit', String(number)];
  for (const name of additions) argv.push('--add-label', name);
  for (const name of removals) argv.push('--remove-label', name);
  const res = await runGh(argv, opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot edit labels on issue #${number}`) };
  return { ok: true };
}

async function commentIssue(number, body, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer` };
  if (typeof body !== 'string' || body.trim() === '') {
    return { ok: false, error: 'comment body must be a non-empty string' };
  }
  const res = await runGh(['issue', 'comment', String(number), '--body', body], opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot comment on issue #${number}`) };
  return { ok: true };
}

async function setIssueState(number, state, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer` };
  const verb = state === 'closed' ? 'close' : (state === 'open' ? 'reopen' : null);
  if (verb === null) return { ok: false, error: `invalid state ${JSON.stringify(state)}: want open or closed` };
  const res = await runGh(['issue', verb, String(number)], opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot ${verb} issue #${number}`) };
  return { ok: true };
}

module.exports = {
  setGhRunner,
  ghBinary,
  ghStatus,
  repoInfo,
  listIssues,
  listAllOpenIssues,
  getIssue,
  getIssuePage,
  getIssueConnectionPage,
  getIssueMetadata,
  listAssignableUsers,
  editAssignees,
  listLabels,
  createLabel,
  editLabels,
  commentIssue,
  setIssueState,
};
