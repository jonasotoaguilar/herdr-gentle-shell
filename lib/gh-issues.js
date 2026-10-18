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
    commentsCount: comments.length,
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
  const repo = await runGh(['repo', 'view', '--json', 'nameWithOwner'], opts);
  if (repo.error) return { ok: false, error: repo.error };
  if (repo.status !== 0) return { ok: false, error: exitError(repo, 'cannot resolve the repository') };
  const parsedRepo = parseJsonBody(repo.stdout, 'gh repo view');
  if (!parsedRepo.ok) return parsedRepo;
  const nameWithOwner = parsedRepo.doc && typeof parsedRepo.doc.nameWithOwner === 'string'
    ? parsedRepo.doc.nameWithOwner
    : '';
  if (!nameWithOwner) return { ok: false, error: 'gh repo view returned an unexpected shape' };
  const user = await runGh(['api', 'user'], opts);
  let viewer = null;
  if (!user.error && user.status === 0) {
    const parsedUser = parseJsonBody(user.stdout, 'gh api user');
    if (parsedUser.ok && parsedUser.doc && typeof parsedUser.doc.login === 'string') {
      viewer = parsedUser.doc.login;
    }
  }
  return { ok: true, nameWithOwner, viewer };
}

// Paged listing. `gh issue list` has no offset flag, so the call fetches
// ONCE up to the bound and slices the requested page in memory; `total`
// is the fetched count and `truncated` is true exactly when it reached
// the bound (a lower bound, never the exact total). `opts.fetchMax`
// overrides the bound (default LIST_FETCH_MAX) so tests can exercise
// truncation without 500 fixtures. The list fetch omits `body` (the
// detail pane reads it through `getIssue`); every other row field the
// view's list uses still arrives, so list rows render unchanged.
async function listIssues({ query = '', state = 'open', page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}, opts = {}) {
  const stateFilter = normalizeStateFilter(state);
  if (stateFilter === null) return { ok: false, error: `invalid state ${JSON.stringify(state)}: want open, closed or all` };
  const paging = normalizePaging(page, pageSize);
  const search = typeof query === 'string' ? query.trim() : '';
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
  const start = (paging.page - 1) * paging.pageSize;
  return {
    ok: true,
    issues: normalized.slice(start, start + paging.pageSize),
    total,
    truncated: total >= bound,
    page: paging.page,
    pageSize: paging.pageSize,
  };
}

async function getIssue(number, opts = {}) {
  if (!Number.isInteger(number)) return { ok: false, error: `invalid issue number ${JSON.stringify(number)}: want an integer` };
  const res = await runGh(['issue', 'view', String(number), '--json', ISSUE_DETAIL_JSON_FIELDS], opts);
  if (res.error) return { ok: false, error: res.error };
  if (res.status !== 0) return { ok: false, error: exitError(res, `cannot view issue #${number}`) };
  const parsed = parseJsonBody(res.stdout, `gh issue view ${number}`);
  if (!parsed.ok) return parsed;
  if (!parsed.doc || typeof parsed.doc !== 'object' || typeof parsed.doc.number !== 'number') {
    return { ok: false, error: `gh issue view ${number} returned an unexpected shape` };
  }
  const rawComments = Array.isArray(parsed.doc.comments) ? parsed.doc.comments : [];
  return {
    ok: true,
    issue: normalizeIssue(parsed.doc),
    comments: rawComments.map((entry, index) => normalizeComment(entry, index)),
  };
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
  getIssue,
  listLabels,
  createLabel,
  editLabels,
  commentIssue,
  setIssueState,
};
