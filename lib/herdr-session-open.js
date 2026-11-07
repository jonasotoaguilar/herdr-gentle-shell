'use strict';
// Helpers for `worktree_session_open`, the one worktree tool this package
// keeps (odd/tasks/split-odd-worktree.md S6/T5): it opens a Pi session inside
// a registered agent worktree through Herdr.
//
// Recovered from the pre-split extensions/gentle-worktree-tools.ts and
// lib/worktree-git.js, so the registry gate, the herdr argv allowlist, the
// binary trust rules and the reply parsers are the same code paths the
// removed tools used. The create/close/warp surfaces and the Customize mode
// gate are deliberately absent.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REGISTRY_NAME = 'pi-worktrees.json';
const DEFAULT_TIMEOUT_MS = 120000;
const KILL_GRACE_MS = 2000;

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

// Run a binary with a fixed argument vector — never a shell string, so a
// branch name, path or agent name cannot inject a command. Resolves to
// `{status, stdout, stderr, error}` and never rejects: a refusal to spawn is
// an `error` string, exactly like a non-zero exit.
//
// On timeout the owned child is SIGTERMed, given KILL_GRACE_MS, then
// SIGKILLed, so awaiting one herdr call can never hang a session. On POSIX
// the child gets its own process group and the signals go to that group, so
// its own children die with it; win32 has no negative-pid signals, so only
// the owned handle is signalled there.
function runArgvAsync(bin, args, opts = {}) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    return Promise.reject(new TypeError('runArgvAsync requires an array of string arguments'));
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const spawnOpts = { cwd: opts.cwd, windowsHide: true };
  if (process.platform !== 'win32') spawnOpts.detached = true;
  let child;
  try {
    child = spawn(bin, args, spawnOpts);
  } catch (err) {
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
  }
  if (!child || typeof child.on !== 'function') {
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: 'spawn returned nothing usable' });
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let grace = null;
    const signal = (sig) => {
      if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // No group (already gone, or no group support): signal the child.
        }
      }
      try {
        child.kill(sig);
      } catch {
        // A dead child is not a failure.
      }
    };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      resolve({ status: payload.status, stdout, stderr, error: payload.error || null });
    };
    try {
      if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; });
      if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => finish({ status: null, error: (err && err.message) || String(err) }));
      child.on('close', (code) => finish({ status: code }));
    } catch (err) {
      finish({ status: null, error: (err && err.message) || String(err) });
      return;
    }
    timer = setTimeout(() => {
      signal('SIGTERM');
      grace = setTimeout(() => {
        signal('SIGKILL');
        finish({ status: null, error: `timed out after ${timeoutMs}ms` });
      }, KILL_GRACE_MS);
      if (grace && typeof grace.unref === 'function') grace.unref();
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function runnerFor(opts) {
  if (opts && typeof opts.runAsync === 'function') return opts.runAsync;
  return (bin, args, cwd) => runArgvAsync(bin, args, { cwd });
}

// ---------------------------------------------------------------------------
// Repository reads
// ---------------------------------------------------------------------------

// Identify the repository containing repoRoot: `{root, commonDir, repoName,
// parentDir}`. The common dir is resolved against the realpath of the
// invoking directory, so a `../.git` seen through a symlink still names the
// principal checkout's git directory, which is where the registry lives.
async function repoIdentity(repoRoot, opts = {}) {
  const runAsync = runnerFor(opts);
  const top = await runAsync('git', ['rev-parse', '--show-toplevel'], repoRoot);
  if (!top || top.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const root = path.resolve(String(top.stdout || '').trim());
  const common = await runAsync('git', ['rev-parse', '--git-common-dir'], repoRoot);
  if (!common || common.status !== 0) throw new Error(`cannot resolve git common dir: ${repoRoot}`);
  const rawCommon = String(common.stdout || '').trim();
  let base = repoRoot;
  try {
    base = fs.realpathSync(repoRoot);
  } catch {
    // git already ran, so an unreadable cwd keeps the lexical base.
  }
  const commonDir = path.isAbsolute(rawCommon) ? path.normalize(rawCommon) : path.resolve(base, rawCommon);
  return { root, commonDir, repoName: path.basename(root), parentDir: path.dirname(root) };
}

// List every checkout from `git worktree list --porcelain -z`:
// `[{path, branch, head, detached, bare}]`, branch null when detached.
async function listWorktrees(repoRoot, opts = {}) {
  const runAsync = runnerFor(opts);
  const listed = await runAsync('git', ['worktree', 'list', '--porcelain', '-z'], repoRoot);
  if (!listed || listed.status !== 0) {
    const stderr = listed && typeof listed.stderr === 'string' ? listed.stderr : '';
    throw new Error(`git worktree list failed: ${stderr.trim()}`);
  }
  return parseWorktreeList(listed.stdout);
}

function parseWorktreeList(stdout) {
  const tokens = String(stdout || '').split('\0');
  const entries = [];
  let current = null;
  const flush = () => {
    if (current && current.path) entries.push(current);
    current = null;
  };
  for (const token of tokens) {
    if (token === '') {
      flush();
      continue;
    }
    if (token.startsWith('worktree ')) {
      flush();
      current = { path: token.slice('worktree '.length), branch: null, head: null, detached: false, bare: false };
    } else if (current && token.startsWith('HEAD ')) {
      current.head = token.slice('HEAD '.length);
    } else if (current && token.startsWith('branch ')) {
      const ref = token.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (current && token === 'detached') {
      current.detached = true;
    } else if (current && token === 'bare') {
      current.bare = true;
    }
    // `locked` / `prunable` tokens carry no identity and are ignored.
  }
  flush();
  return entries;
}

// The name the worktree listing prints and `worktree_session_open` accepts:
// lowercase, runs of non-alphanumerics collapse to one `-`, edges trimmed.
function slugifyBranch(branch) {
  const slug = String(branch).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'worktree' : slug;
}

// ---------------------------------------------------------------------------
// Worktree registry
// ---------------------------------------------------------------------------

// The registry this package reads is the one the odd-worktree package writes:
// `{version, worktrees: [{branch, path, ...}]}` beside the git common dir.
// A missing file is an empty registry; anything unreadable or malformed is a
// refusal the caller reports, never an empty registry that would silently
// unregister every worktree.
function registryPath(commonDir) {
  return path.join(commonDir, REGISTRY_NAME);
}

function readRegistry(commonDir) {
  const file = registryPath(commonDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, worktrees: [], error: null };
    return { ok: false, worktrees: [], error: `cannot read registry: ${err.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (err) {
    return { ok: false, worktrees: [], error: `malformed registry (invalid JSON): ${err.message}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.worktrees)) {
    return { ok: false, worktrees: [], error: 'malformed registry (expected {worktrees: []})' };
  }
  const worktrees = doc.worktrees
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.branch === 'string' && typeof entry.path === 'string')
    .map((entry) => ({ branch: entry.branch, path: entry.path }));
  return { ok: true, worktrees, error: null };
}

// ---------------------------------------------------------------------------
// Liveness and name resolution
// ---------------------------------------------------------------------------

// The ONE definition of "is this path a real, live checkout?":
// `{absolute, real, exists, isDirectory}`, never a throw. Absolute inputs
// resolve directly, relative ones against the repository root (never the
// process cwd). `exists` follows symlinks, so a dangling link reads absent,
// and a FILE at the path is not a checkout.
function checkoutState(entryPath, repoRoot) {
  const none = { absolute: null, real: null, exists: false, isDirectory: false };
  try {
    if (typeof entryPath !== 'string' || entryPath.length === 0) return { ...none };
    let absolute = null;
    if (path.isAbsolute(entryPath)) absolute = path.resolve(entryPath);
    else {
      if (typeof repoRoot !== 'string' || repoRoot.length === 0) return { ...none };
      absolute = path.resolve(repoRoot, entryPath);
    }
    let exists = false;
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(absolute).isDirectory();
      exists = true;
    } catch {
      exists = false;
      isDirectory = false;
    }
    let real = null;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      real = null;
    }
    return { absolute, real, exists, isDirectory };
  } catch {
    return { ...none };
  }
}

// Realpath identities of the LIVE checkouts git lists, so a registry row that
// reaches a checkout through a symlink still reads live.
function liveIdentities(listed, repoRoot) {
  const ids = new Set();
  for (const entry of listed || []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    if (!st.exists || !st.isDirectory) continue;
    if (st.real !== null) ids.add(st.real);
    else if (st.absolute !== null) ids.add(st.absolute);
  }
  return ids;
}

// Each live checkout identity mapped to its CURRENT branch, so a row whose
// branch was renamed still resolves by the name the listing prints.
function liveBranchMap(live, repoRoot) {
  const map = new Map();
  for (const record of live || []) {
    if (!record || typeof record.path !== 'string' || record.path.length === 0) continue;
    const st = checkoutState(record.path, repoRoot);
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null || map.has(id)) continue;
    if (typeof record.branch === 'string' && record.branch.length > 0) map.set(id, record.branch);
  }
  return map;
}

function slugOf(branch) {
  try {
    const slug = typeof branch === 'string' ? slugifyBranch(branch) : null;
    return typeof slug === 'string' && slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}

function prefixScore(query, slug) {
  const q = String(query);
  const s = String(slug);
  let score = 0;
  while (score < Math.min(q.length, s.length) && q[score] === s[score]) score += 1;
  return score;
}

// Live checkouts git lists that no registry row owns, by resolved identity.
// The principal checkout is never one of them: it prints as `principal`, so
// a branch whose slug equals the principal's own branch slug stays unique.
function liveUnregisteredEntries(rows, live, repoRoot, principal) {
  const owned = new Set();
  for (const row of rows) {
    const st = checkoutState(row && row.path, repoRoot);
    if (st.absolute !== null) owned.add(st.absolute);
    if (st.real !== null) owned.add(st.real);
  }
  let principalId = null;
  if (principal && typeof principal.path === 'string' && principal.path.length > 0) {
    const st = checkoutState(principal.path, repoRoot);
    principalId = st.real !== null ? st.real : st.absolute;
  }
  const out = [];
  for (const entry of live || []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    // The same liveness the listing applies: a git record whose directory is
    // gone must not make a name ambiguous either.
    if (!st.exists || !st.isDirectory) continue;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null || owned.has(id)) continue;
    if (principalId !== null && id === principalId) continue;
    out.push({ path: id, branch: entry.branch || '(detached)' });
  }
  return out;
}

// The principal checkout for name resolution: the live entry whose resolved
// identity equals the main root recovered from the shared common dir. Null
// when git lists no such entry, so no `principal` name is invented.
function principalForName(repo, live) {
  try {
    if (!repo || path.basename(repo.commonDir) !== '.git') return null;
    const principalState = checkoutState(path.resolve(path.dirname(repo.commonDir)), repo.root);
    const principalPath = principalState.real !== null ? principalState.real : principalState.absolute;
    if (principalPath === null) return null;
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repo.root);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null && id === principalPath) {
        return { path: principalPath, branch: entry.branch || '(detached)' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Resolve the name the tool was given — the slug the listing prints, or a
// branch spelling — to one registry row. Unknown, ambiguous and unregistered
// checkouts all fail closed; the unregistered case states the rule rather
// than offering a way around it.
function resolveCheckoutByName(name, { read, principal, live, repoRoot }) {
  const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
  const extras = liveUnregisteredEntries(rows, live, repoRoot, principal);
  const knownNames = [];
  if (principal) knownNames.push('principal');
  const seen = new Set();
  for (const item of [...rows, ...extras]) {
    const slug = slugOf(item && item.branch);
    if (slug === null || seen.has(slug)) continue;
    seen.add(slug);
    knownNames.push(slug);
  }
  if (name === 'principal') {
    const clashes = [];
    for (const row of rows) {
      if (slugOf(row && row.branch) === 'principal') clashes.push(`'${row.branch}' at ${row.path}`);
    }
    for (const extra of extras) {
      if (slugOf(extra.branch) === 'principal') clashes.push(`'${extra.branch}' at ${extra.path} (unregistered)`);
    }
    if (clashes.length > 0) {
      return {
        ok: false,
        error: `worktree name "principal" is ambiguous: it names the principal checkout and ${clashes.join(', ')}; pass the path or branch instead`,
        candidates: knownNames,
      };
    }
    if (principal) {
      return { ok: true, kind: 'principal', name: 'principal', path: principal.path, branch: principal.branch, entry: null };
    }
    return {
      ok: false,
      error: `no registered worktree for "principal": the principal checkout could not be determined; known worktrees: ${knownNames.join(', ') || '(none)'}`,
      candidates: knownNames,
    };
  }
  const liveById = liveBranchMap(live, repoRoot);
  const matches = [];
  for (const row of rows) {
    if (slugOf(row && row.branch) === name) {
      matches.push(row);
      continue;
    }
    if (row && typeof row.path === 'string' && path.isAbsolute(row.path)) {
      const st = checkoutState(row.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      const current = id !== null ? liveById.get(id) : undefined;
      if (typeof current === 'string' && slugOf(current) === name) matches.push(row);
    }
  }
  const extraMatches = extras.filter((extra) => slugOf(extra.branch) === name);
  if (matches.length + extraMatches.length > 1) {
    const named = [
      ...matches.map((row) => `'${row.branch}' at ${row.path}`),
      ...extraMatches.map((extra) => `'${extra.branch}' at ${extra.path} (unregistered)`),
    ].join(', ');
    return {
      ok: false,
      error: `worktree name "${name}" is ambiguous: ${named}; pass the path or branch instead`,
      candidates: knownNames,
    };
  }
  if (matches.length === 1) {
    const row = matches[0];
    return { ok: true, kind: 'agent', name, path: row.path, branch: row.branch, entry: row };
  }
  if (extraMatches.length === 1) {
    const only = extraMatches[0];
    return {
      ok: false,
      error: `no registered worktree for ${JSON.stringify(name)}: '${only.branch}' at ${only.path} is unregistered, and worktree_session_open only opens a registered worktree`,
      candidates: knownNames,
    };
  }
  const ranked = [...rows.map((row) => ({ branch: row && row.branch, path: row && row.path })), ...extras]
    .map((item) => ({ item, slug: slugOf(item.branch) || '' }))
    .sort((a, b) => prefixScore(name, b.slug) - prefixScore(name, a.slug))
    .slice(0, 3);
  const named = ranked.map((item) => `'${item.slug}' (branch '${item.item.branch}') at ${item.item.path}`).join(', ');
  const suffix = ranked.length > 0 ? `: closest worktrees: ${named}` : ': no worktrees are registered';
  return {
    ok: false,
    error: `no registered worktree for ${JSON.stringify(name)}${suffix}`,
    candidates: knownNames,
  };
}

// The PATH leg of the same field: an absolute path resolves only when it
// exists, is a directory, is a live checkout git lists, and a registry row
// reaches it by resolved identity. Anything else yields null, so the caller
// fails closed with the name refusal.
function resolveRegisteredPathEntry(raw, read, live, repoRoot) {
  try {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const st = checkoutState(raw, repoRoot);
    if (st.absolute === null || !st.exists || !st.isDirectory) return null;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null || !liveIdentities(live, repoRoot).has(id)) return null;
    const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
    for (const row of rows) {
      if (!row || typeof row.path !== 'string' || !path.isAbsolute(row.path)) continue;
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid !== null && rid === id) return row;
    }
    return null;
  } catch {
    return null;
  }
}

// A value that is unambiguously a path rather than a worktree name: absolute,
// or explicitly relative (`.`, `..`, `./`, `../`). A bare `foo/bar` may still
// be a branch spelling, so it resolves through its slug first.
function isExplicitPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (path.isAbsolute(value)) return true;
  if (value === '.' || value === '..') return true;
  return value.startsWith('./') || value.startsWith('../');
}

function looksLikePath(value) {
  if (isExplicitPath(value)) return true;
  if (typeof value !== 'string') return false;
  return value.includes('/') || value.includes('\\');
}

function pathRefusal(value) {
  return `worktree session open refuses ${JSON.stringify(value)}: pass the worktree NAME 'worktree list' prints, not a path`;
}

// ---------------------------------------------------------------------------
// Herdr plumbing
// ---------------------------------------------------------------------------

// Closed union of herdr operations with a per-operation flag allowlist,
// mirroring the installed CLI surface. Every value travels as its own argv
// element because herdr rejects `--flag=value`. Unknown operations or flags
// throw, and `--trust-repository` is absent everywhere: trusting a repository
// is a human decision this tool never takes. `--focus` stays out too — the
// session tool only ever passes `--no-focus`.
const HERDR_ALLOWLIST = {
  list: ['cwd'],
  open: ['cwd', 'path', 'branch', 'noFocus'],
  'pane-list': ['workspace'],
  'agent-start': ['name', 'kind', 'pane', 'timeout', 'agentArgs'],
  'agent-get': ['target'],
};

const HERDR_FLAG = {
  cwd: '--cwd',
  workspace: '--workspace',
  branch: '--branch',
  path: '--path',
  noFocus: '--no-focus',
  kind: '--kind',
  pane: '--pane',
  timeout: '--timeout',
};

// Build the fixed argv for one herdr operation. `herdr agent start <NAME>
// --kind <KIND> --pane <ID> --timeout <MS> -- [AGENT_ARG]...` keeps the agent
// name positional and first, with the Pi argv after a `--` separator.
function herdrArgv(operation, params = {}) {
  const allowed = HERDR_ALLOWLIST[operation];
  if (!allowed) throw new Error(`unknown herdr operation: ${operation}`);
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new Error(`flag not allowed for herdr ${operation}: ${key}`);
  }
  if (operation === 'agent-start') {
    const { name, kind, pane, timeout, agentArgs } = params;
    if (typeof name !== 'string' || name === '') throw new Error('invalid value for herdr agent-start name');
    for (const [key, value] of [['kind', kind], ['pane', pane], ['timeout', timeout]]) {
      if (typeof value !== 'string' || value === '') throw new Error(`invalid value for herdr agent-start ${key}`);
    }
    if (!Array.isArray(agentArgs) || agentArgs.some((entry) => typeof entry !== 'string')) {
      throw new Error('invalid value for herdr agent-start agentArgs');
    }
    return ['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', timeout, '--', ...agentArgs];
  }
  if (operation === 'agent-get') {
    const { target } = params;
    if (typeof target !== 'string' || target === '') throw new Error('invalid value for herdr agent-get target');
    return ['agent', 'get', target];
  }
  if (operation === 'pane-list') {
    const argv = ['pane', 'list'];
    if (params.workspace !== undefined) {
      if (typeof params.workspace !== 'string' || params.workspace === '') {
        throw new Error('invalid value for herdr pane-list workspace');
      }
      argv.push('--workspace', params.workspace);
    }
    return argv;
  }
  const argv = ['worktree', operation];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (typeof value === 'boolean') {
      if (value) argv.push(HERDR_FLAG[key]);
      continue;
    }
    if (typeof value !== 'string' || value === '') throw new Error(`invalid value for herdr ${operation} ${key}`);
    argv.push(HERDR_FLAG[key], value);
  }
  return argv;
}

// Where the herdr binary comes from: the documented HERDR_BIN_PATH override
// (tests), else `herdr` on PATH.
//
// Under the test harness (GENTLE_HERDR_SESSION_LIB_DIR or the inherited
// GENTLE_WORKTREE_LIB_DIR, set by the test loaders) the override is NOT
// trusted on its own: an exported HERDR_BIN_PATH is inherited by every test
// process, so honoring it first let a test spawn the developer's LIVE herdr
// and create real workspaces. Under the harness a binary is honored only when
// its path proves it cannot be the live one, or when the current test opts in
// with GENTLE_HERDR_ALLOW_LIVE_HERDR=1.
const LIVE_HERDR_OPT_IN = 'GENTLE_HERDR_ALLOW_LIVE_HERDR';
const HARNESS_MARKERS = ['GENTLE_HERDR_SESSION_LIB_DIR', 'GENTLE_WORKTREE_LIB_DIR'];

function realPathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isInsideDir(candidate, dir) {
  if (candidate === dir) return true;
  return candidate.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

function isProvablyNotLiveHerdr(bin) {
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) return false;
  const real = realPathOrNull(bin);
  if (real === null) return true;
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return true;
  }
  if (!stat.isFile()) return true;
  try {
    fs.accessSync(real, fs.constants.X_OK);
  } catch {
    return true;
  }
  // os.tmpdir() is where every fixture builds its stub binary, and no live
  // Herdr install lives there.
  const scratch = realPathOrNull(os.tmpdir()) || os.tmpdir();
  return isInsideDir(real, scratch);
}

function resolveHerdrBinary(env = process.env) {
  const source = env || {};
  const bin = source.HERDR_BIN_PATH;
  const injected = typeof bin === 'string' && bin.length > 0;
  const inHarness = HARNESS_MARKERS.some((name) => typeof source[name] === 'string' && source[name].length > 0);
  if (!inHarness) return injected ? bin : 'herdr';
  if (source[LIVE_HERDR_OPT_IN] === '1') return injected ? bin : 'herdr';
  if (!injected) {
    throw new Error('herdr binary is not injected: set HERDR_BIN_PATH in tests (refusing to run live herdr)');
  }
  if (isProvablyNotLiveHerdr(bin)) return bin;
  throw new Error(
    `refusing to run live herdr from a test harness: HERDR_BIN_PATH=${bin} can execute a live herdr; `
    + `inject a scratch stub inside the OS temp directory, or set ${LIVE_HERDR_OPT_IN}=1 in the test that needs a live session`,
  );
}

// The texts the binary guard uses to refuse. Matching on text keeps the
// boundary between lib and extension small: a refusal is a resolved STATE,
// not an error class shared across it.
const HERDR_REFUSAL_PATTERN = /refusing to run live herdr|herdr binary is not injected/;

function isHerdrRefusal(err) {
  return !!(err && typeof err.message === 'string' && HERDR_REFUSAL_PATTERN.test(err.message));
}

function herdrFailureText(call, status, reason) {
  const detail = ((reason || 'unknown error') + '').trim() || 'unknown error';
  return `'${call}' exited ${status} (${detail})`;
}

// ---------------------------------------------------------------------------
// Herdr replies
// ---------------------------------------------------------------------------

// The Herdr workspace id for a worktree from `herdr worktree list` JSON. An
// entry matches by resolved path identity or by exact branch equality.
// `conflict` means several DIFFERENT workspace ids claim this one worktree —
// the caller fails closed; a matching entry with no workspace id is the
// normal shape of a worktree Herdr has not opened.
function sessionWorkspaceId(stdout, repoRoot, branch, targetCwd) {
  const none = { id: null, matched: 0, claimed: 0, conflict: false };
  let list = null;
  try {
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.worktrees)) list = doc.result.worktrees;
    else if (doc && Array.isArray(doc.worktrees)) list = doc.worktrees;
    else if (doc && Array.isArray(doc.result)) list = doc.result;
  } catch {
    return { id: null, matched: 0, claimed: 0, conflict: false, parseError: true };
  }
  if (!list) return none;
  const ids = new Set();
  let matched = 0;
  let claimed = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    let hit = false;
    if (typeof item.path === 'string' && item.path.length > 0) {
      try {
        const resolved = path.isAbsolute(item.path) ? path.resolve(item.path) : path.resolve(repoRoot, item.path);
        if (resolved === targetCwd) hit = true;
      } catch {
        // Unresolvable entries never match.
      }
    }
    if (!hit && typeof item.branch === 'string' && item.branch === branch) hit = true;
    if (!hit) continue;
    matched += 1;
    let id = null;
    for (const key of ['open_workspace_id', 'workspace_id', 'workspace', 'id']) {
      if (typeof item[key] === 'string' && item[key].length > 0) {
        id = item[key];
        break;
      }
    }
    if (id !== null) {
      claimed += 1;
      ids.add(id);
    }
  }
  if (matched === 0) return { id: null, matched: 0, claimed: 0, conflict: false };
  if (ids.size > 1) return { id: null, matched, claimed, conflict: true };
  if (claimed === 0) return { id: null, matched, claimed, conflict: false };
  return { id: [...ids][0], matched, claimed, conflict: false };
}

// The workspace's ROOT pane from `herdr pane list` JSON: the lowest
// `<workspace>:pN` index. Membership is verified here as well as by the
// herdr filter, because an unfiltered list is global — a pane of another
// workspace would start Pi outside the worktree.
function rootPaneId(stdout, workspaceId) {
  let panes = null;
  try {
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.panes)) panes = doc.result.panes;
    else if (doc && Array.isArray(doc.panes)) panes = doc.panes;
    else if (doc && Array.isArray(doc.result)) panes = doc.result;
  } catch {
    return null;
  }
  if (!panes) return null;
  let best = null;
  let bestN = Infinity;
  for (const pane of panes) {
    if (!pane || typeof pane !== 'object') continue;
    const id = typeof pane.pane_id === 'string' && pane.pane_id.length > 0
      ? pane.pane_id
      : typeof pane.id === 'string' && pane.id.length > 0 ? pane.id : null;
    if (id === null) continue;
    if (typeof workspaceId === 'string' && workspaceId.length > 0) {
      const owner = typeof pane.workspace_id === 'string' && pane.workspace_id.length > 0 ? pane.workspace_id : null;
      // Both facts must agree: the owner the pane reports AND the workspace
      // its id carries. Either one alone lets through a foreign pane.
      if (owner !== null && owner !== workspaceId) continue;
      if (!id.startsWith(`${workspaceId}:`)) continue;
    }
    const match = /:p(\d+)$/.exec(id);
    const n = match ? Number(match[1]) : Infinity;
    if (n < bestN) {
      bestN = n;
      best = id;
    }
  }
  return best;
}

// The `cwd` a pane reports, or null when it reports none.
function paneCwdFor(stdout, paneId) {
  let panes = null;
  try {
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.panes)) panes = doc.result.panes;
    else if (doc && Array.isArray(doc.panes)) panes = doc.panes;
    else if (doc && Array.isArray(doc.result)) panes = doc.result;
  } catch {
    return null;
  }
  if (!panes) return null;
  for (const pane of panes) {
    if (!pane || typeof pane !== 'object') continue;
    const id = typeof pane.pane_id === 'string' && pane.pane_id.length > 0
      ? pane.pane_id
      : typeof pane.id === 'string' && pane.id.length > 0 ? pane.id : null;
    if (id !== paneId) continue;
    return typeof pane.cwd === 'string' && pane.cwd.length > 0 ? pane.cwd : null;
  }
  return null;
}

// One decision, one owner: both the reuse path and the create-then-list path
// choose their pane here, so neither can drift from the other. `reason` says
// why nothing was chosen ("no-panes", "cwd").
function selectSessionPane(stdout, workspaceId, targetCwd, repoRoot) {
  const paneId = rootPaneId(stdout, workspaceId);
  if (paneId === null) return { paneId: null, paneCwd: null, reason: 'no-panes' };
  const paneCwd = paneCwdFor(stdout, paneId);
  if (paneCwd === null) return { paneId, paneCwd: null, reason: null };
  const paneState = checkoutState(paneCwd, repoRoot);
  const paneReal = paneState.real !== null ? paneState.real : paneState.absolute;
  const inside = paneReal !== null && (paneReal === targetCwd || paneReal.startsWith(targetCwd + path.sep));
  if (!inside) return { paneId, paneCwd, reason: 'cwd' };
  return { paneId, paneCwd, reason: null };
}

// `workspace.workspace_id` and `root_pane.pane_id` from a `herdr worktree
// open` reply, with the pane's own cwd and workspace when it reports them.
function openedWorkspace(stdout) {
  let doc = null;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { workspaceId: null, paneId: null, paneCwd: null, paneWorkspace: null };
  }
  const result = doc && typeof doc === 'object' ? (doc.result || doc) : null;
  const workspace = result && typeof result.workspace === 'object' ? result.workspace : null;
  const rootPane = result && typeof result.root_pane === 'object' ? result.root_pane : null;
  const workspaceId = workspace && typeof workspace.workspace_id === 'string' && workspace.workspace_id.length > 0
    ? workspace.workspace_id
    : typeof result.workspace_id === 'string' && result.workspace_id.length > 0 ? result.workspace_id : null;
  const paneId = rootPane && typeof rootPane.pane_id === 'string' && rootPane.pane_id.length > 0
    ? rootPane.pane_id
    : typeof result.pane_id === 'string' && result.pane_id.length > 0
      ? result.pane_id
      : typeof result.root_pane_id === 'string' && result.root_pane_id.length > 0 ? result.root_pane_id : null;
  const paneCwd = rootPane && typeof rootPane.cwd === 'string' && rootPane.cwd.length > 0
    ? rootPane.cwd
    : typeof result.cwd === 'string' && result.cwd.length > 0 ? result.cwd : null;
  const paneWorkspace = rootPane && typeof rootPane.workspace_id === 'string' && rootPane.workspace_id.length > 0
    ? rootPane.workspace_id
    : null;
  return { workspaceId, paneId, paneCwd, paneWorkspace };
}

// ---------------------------------------------------------------------------
// Model-facing text
// ---------------------------------------------------------------------------

const ANSI_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// One-line, escape-free value: a branch name or path is untrusted input and
// must never reshape a row.
function cleanValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

// The agent-facing result: short `label: value` rows in a stable order, with
// the routing ids a caller needs to reach the session it just started.
function sessionOpenRows(details) {
  const rows = [`outcome: ${details.resumed === true ? 'resumed' : 'opened'}`];
  const worktree = cleanValue(details.worktree);
  if (worktree.length > 0) rows.push(`worktree: ${worktree}`);
  const branch = cleanValue(details.branch);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
  const target = cleanValue(details.path);
  if (target.length > 0) rows.push(`path: ${target}`);
  const session = cleanValue(details.sessionId);
  if (session.length > 0) rows.push(`session: ${session}`);
  const workspace = cleanValue(details.workspaceId);
  if (workspace.length > 0) rows.push(`workspace: ${workspace}`);
  const pane = cleanValue(details.paneId);
  if (pane.length > 0) rows.push(`pane: ${pane}`);
  const agent = cleanValue(details.agentName);
  if (agent.length > 0) rows.push(`agent: ${agent}`);
  return rows;
}

module.exports = {
  runArgvAsync,
  repoIdentity,
  listWorktrees,
  parseWorktreeList,
  slugifyBranch,
  registryPath,
  readRegistry,
  checkoutState,
  liveIdentities,
  liveBranchMap,
  liveUnregisteredEntries,
  principalForName,
  resolveCheckoutByName,
  resolveRegisteredPathEntry,
  isExplicitPath,
  looksLikePath,
  pathRefusal,
  herdrArgv,
  resolveHerdrBinary,
  isHerdrRefusal,
  herdrFailureText,
  sessionWorkspaceId,
  selectSessionPane,
  openedWorkspace,
  sessionOpenRows,
};
