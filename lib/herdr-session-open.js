'use strict';
// Helpers for `herdr_session_open` (odd/tasks/split-odd-worktree.md S8/T7):
// open a Herdr panel running a Pi session at a PATH, as a WORKTREE panel when
// the path is a linked Git worktree or as a NORMAL panel when it is a
// repository's primary checkout or any other directory.
//
// Recovered from the pre-split worktree tooling: the herdr argv allowlist, the
// binary trust rules and the workspace/pane reply parsers are the same code
// paths, so no herdr call is hand-built and no reply is trusted blindly. The
// worktree NAME/registry resolution that older tool needed is gone with it —
// this tool classifies a path instead.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 120000;
const KILL_GRACE_MS = 2000;

// Herdr agent names: lowercase start, then lowercase letters, digits, dash or
// underscore, at most 32 characters.
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const AGENT_NAME_MAX = 32;

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

// Run a binary with a fixed argument vector — never a shell string, so a path
// or an agent name cannot inject a command. Resolves to
// `{status, stdout, stderr, error}` and never rejects: a refusal to spawn is an
// `error` string, exactly like a non-zero exit.
//
// On timeout the owned child is SIGTERMed, given KILL_GRACE_MS, then
// SIGKILLed, so awaiting one herdr call can never hang a session. On POSIX the
// child gets its own process group and the signals go to that group, so its own
// children die with it; win32 has no negative-pid signals, so only the owned
// handle is signalled there.
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

// A real identity for a filesystem path: the symlink-resolved realpath, or the
// normalized absolute path when the filesystem cannot resolve it. Identity
// comparisons always go through here, so two spellings of one directory never
// read as two directories.
function identityOf(target) {
  try {
    const real = fs.realpathSync(target);
    if (typeof real === 'string' && real.length > 0) return path.resolve(real);
  } catch {
    // Fall through to the lexical identity.
  }
  try {
    return path.resolve(target);
  } catch {
    return null;
  }
}

// The canonical identity of a requested path, or null when it cannot be
// resolved at all (missing path, unreadable parent).
function canonicalPath(target) {
  try {
    const real = fs.realpathSync(target);
    return typeof real === 'string' && real.length > 0 ? path.resolve(real) : null;
  } catch {
    return null;
  }
}

// Ask git about the repository containing `dir`. Returns
// `{repo: {root, commonDir, gitDir, isLinkedWorktree}, error}` where `error` is
// null, `'not-a-repo'` (git says there is none here) or `'unproven'` (git says
// there is one but cannot name its own directories, so no panel kind can be
// proven).
//
// git's own answer decides the kind: a LINKED worktree is the only checkout
// whose `--git-dir` differs from its `--git-common-dir`. That holds for a plain
// repository, for `git init --separate-git-dir` (where `.git` is a FILE and the
// common dir is not named `.git`), and for a linked worktree of either.
async function repoProbe(dir, opts = {}) {
  const runAsync = runnerFor(opts);
  const top = await runAsync('git', ['rev-parse', '--show-toplevel'], dir);
  if (!top || top.status !== 0) return { repo: null, error: 'not-a-repo' };
  const root = path.resolve(String(top.stdout || '').trim());
  const common = await runAsync('git', ['rev-parse', '--git-common-dir'], dir);
  const gitDir = await runAsync('git', ['rev-parse', '--git-dir'], dir);
  if (!common || common.status !== 0 || !gitDir || gitDir.status !== 0) {
    return { repo: null, error: 'unproven', root };
  }
  let base = dir;
  try {
    base = fs.realpathSync(dir);
  } catch {
    // git already ran, so an unreadable cwd keeps the lexical base.
  }
  const resolveGitPath = (raw) => {
    const value = String(raw || '').trim();
    if (value.length === 0) return null;
    return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
  };
  const commonDir = resolveGitPath(common.stdout);
  const gitDirPath = resolveGitPath(gitDir.stdout);
  const commonId = commonDir === null ? null : canonicalPath(commonDir);
  const gitId = gitDirPath === null ? null : canonicalPath(gitDirPath);
  if (commonId === null || gitId === null) return { repo: null, error: 'unproven', root };
  return {
    repo: {
      root,
      commonDir,
      gitDir: gitDirPath,
      isLinkedWorktree: gitId !== commonId,
    },
    error: null,
  };
}

// The branch checked out at `repoRoot`, or null when HEAD is detached or
// unreadable. A display fact only: no decision depends on it.
async function currentBranch(repoRoot, opts = {}) {
  const runAsync = runnerFor(opts);
  const head = await runAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (!head || head.status !== 0) return null;
  const name = String(head.stdout || '').trim();
  return name.length > 0 && name !== 'HEAD' ? name : null;
}

// The ONE liveness predicate: `{absolute, real, exists, isDirectory}`, never a
// throw. `exists` follows symlinks, so a dangling link reads absent, and a FILE
// at the path is not a directory.
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

// Classify an ABSOLUTE, canonical path into the panel it should open:
//   worktree  — the path is the checkout root of a linked Git worktree;
//   primary   — the path is a repository's primary checkout (a plain one, or
//               one created with `git init --separate-git-dir`);
//   generic   — any other existing directory (not a repository, or a
//               subdirectory of one, which is opened where it is);
//   invalid   — the path is missing or is not a directory;
//   unproven  — git reports a repository but cannot name its own directories,
//               so neither kind can be proven and nothing may be opened.
// Nothing is guessed: the kind comes from git's `--git-dir` versus
// `--git-common-dir` answer, never from a path's spelling.
async function classifyPanel(target, opts = {}) {
  const state = checkoutState(target, null);
  if (!state.exists || !state.isDirectory) return { kind: 'invalid', path: state.absolute, state, repo: null, branch: null };
  const real = canonicalPath(target) || (state.real !== null ? state.real : state.absolute);
  const probe = await repoProbe(real, opts);
  if (probe.error === 'unproven') {
    return { kind: 'unproven', path: real, state, repo: null, branch: null };
  }
  if (probe.error !== null || probe.repo === null) {
    return { kind: 'generic', path: real, state, repo: null, branch: null };
  }
  const repo = probe.repo;
  const rootId = identityOf(repo.root);
  if (rootId !== real) {
    // Inside a checkout but not its root: open the panel where the caller asked.
    return { kind: 'generic', path: real, state, repo, branch: null };
  }
  return {
    kind: repo.isLinkedWorktree ? 'worktree' : 'primary',
    path: real,
    state,
    repo,
    branch: await currentBranch(real, opts),
  };
}

// Herdr's documented agent-name shape, used to refuse a name the CLI would
// reject anyway instead of reporting a false success.
function validAgentName(value) {
  return typeof value === 'string' && AGENT_NAME_PATTERN.test(value);
}

// A valid Herdr agent name derived from what identifies the panel: the branch
// for a worktree panel (the pre-existing default), the directory's own last
// component otherwise. Either way it cannot collide with an option.
function agentNameForPath(target, options = {}) {
  const branch = options && typeof options.branch === 'string' && options.branch.length > 0 ? options.branch : null;
  const source = branch !== null ? branch : String(target || '').replace(/[\\/]+$/, '');
  const base = branch !== null ? source : path.basename(source);
  let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length === 0) return 'pi';
  if (!/^[a-z]/.test(slug)) slug = `p${slug}`;
  const capped = slug.slice(0, AGENT_NAME_MAX).replace(/-+$/g, '');
  return capped.length > 0 ? capped : 'pi';
}

// ---------------------------------------------------------------------------
// Herdr plumbing
// ---------------------------------------------------------------------------

// Closed union of herdr operations with a per-operation flag allowlist,
// mirroring the installed CLI surface (`herdr worktree list|open`,
// `herdr workspace create`, `herdr pane list`, `herdr agent start|get`). Every
// value travels as its own argv element because herdr rejects
// `--flag=value`. Unknown operations or flags throw, and `--trust-repository`
// is absent everywhere: trusting a repository is a human decision this tool
// never takes. `--focus` stays out too — panels open with `--no-focus`.
//
// `open` accepts `cwd` beside `path` because herdr resolves a worktree against
// the repository of the FOCUSED workspace, not against the process cwd
// (herdr 0.9.5: `herdr worktree list` reported the focused workspace's repo
// from three different cwds, while `--cwd <worktree>` reported the worktree's
// own repo). Passing the target as `--cwd` is what makes a worktree of
// another repository resolvable.
const HERDR_ALLOWLIST = {
  list: ['cwd'],
  open: ['cwd', 'path', 'noFocus'],
  'workspace-create': ['cwd', 'noFocus'],
  'pane-list': ['workspace'],
  'agent-start': ['name', 'kind', 'pane', 'timeout', 'agentArgs'],
  'agent-get': ['target'],
};

const HERDR_COMMAND = {
  list: ['worktree', 'list'],
  open: ['worktree', 'open'],
  'workspace-create': ['workspace', 'create'],
  'pane-list': ['pane', 'list'],
};

const HERDR_FLAG = {
  cwd: '--cwd',
  workspace: '--workspace',
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
  const argv = [...HERDR_COMMAND[operation]];
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
// process, so honoring it first let a test spawn the developer's LIVE herdr and
// create real workspaces. Under the harness a binary is honored only when its
// path proves it cannot be the live one, or when the current test opts in with
// GENTLE_HERDR_ALLOW_LIVE_HERDR=1.
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
// boundary between lib and extension small: a refusal is a resolved STATE, not
// an error class shared across it.
const HERDR_REFUSAL_PATTERN = /refusing to run live herdr|herdr binary is not injected/;

function isHerdrRefusal(err) {
  return !!(err && typeof err.message === 'string' && HERDR_REFUSAL_PATTERN.test(err.message));
}

function herdrFailureText(call, status, reason) {
  const detail = ((reason || 'unknown error') + '').trim() || 'unknown error';
  return `'${call}' exited ${status} (${detail})`;
}

// The `error.code` a failed herdr reply names, or null when it names none.
// Herdr prints `{"error":{"code":"…","message":"…"}}`; only the CODE is read
// (a message is prose, never a decision), and a reply carrying anything else —
// plain text, or JSON without an error code — reads as no code at all.
function herdrErrorCode(reply) {
  const source = reply && typeof reply === 'object' ? reply : {};
  for (const raw of [source.stderr, source.stdout]) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text.length === 0) continue;
    const candidates = [text];
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
    for (const candidate of candidates) {
      let doc = null;
      try {
        doc = JSON.parse(candidate);
      } catch {
        continue;
      }
      const code = doc && typeof doc === 'object' && doc.error && typeof doc.error === 'object'
        && typeof doc.error.code === 'string' && doc.error.code.length > 0
        ? doc.error.code
        : null;
      if (code !== null) return code;
    }
  }
  return null;
}

// Whether `target` is STILL the checkout root of an existing linked worktree,
// re-probed from git at the moment a failed open would fall back (never
// remembered from the earlier classification): a path that vanished, stopped
// being a worktree, or stopped being that worktree's ROOT keeps today's abort
// behaviour instead of falling back. Root identity matters on its own: a plain
// directory recreated inside another linked worktree resolves to the ENCLOSING
// checkout, whose kind says nothing about this path.
async function isLinkedWorktreePath(target, opts = {}) {
  const state = checkoutState(target, null);
  if (!state.exists || !state.isDirectory) return false;
  const real = canonicalPath(target) || (state.real !== null ? state.real : state.absolute);
  if (typeof real !== 'string' || real.length === 0) return false;
  const probe = await repoProbe(real, opts);
  if (probe.error !== null || probe.repo === null || probe.repo.isLinkedWorktree !== true) return false;
  return identityOf(probe.repo.root) === identityOf(real);
}

// ---------------------------------------------------------------------------
// Herdr replies
// ---------------------------------------------------------------------------

// The Herdr workspace id already open for a worktree from `herdr worktree
// list` JSON, matching by resolved path identity only (no branch is consulted:
// the caller holds a path). `conflict` means several DIFFERENT workspace ids
// claim this one checkout — the caller fails closed; a matching entry with no
// workspace id is the normal shape of a worktree Herdr has not opened.
function worktreeWorkspaceId(stdout, repoRoot, targetCwd) {
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
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || item.path.length === 0) continue;
    let resolved;
    try {
      resolved = path.isAbsolute(item.path) ? path.resolve(item.path) : path.resolve(repoRoot, item.path);
    } catch {
      continue;
    }
    // Compare real identities: Herdr may list the real checkout while the
    // caller holds a symlinked spelling (or the other way round).
    if (identityOf(resolved) !== targetCwd) continue;
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
// `<workspace>:pN` index. Membership is verified here as well as by the herdr
// filter, because an unfiltered list is global — a pane of another workspace
// would start Pi outside the requested path.
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
      // Both facts must agree: the owner the pane reports AND the workspace its
      // id carries. Either one alone lets through a foreign pane.
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
// open` / `herdr workspace create` reply, with the pane's own cwd and workspace
// when it reports them.
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

// One-line, escape-free value: a path, branch or agent name is untrusted input
// and must never reshape a row.
function cleanValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').replace(/\s+/g, ' ').trim();
}

// The agent-facing result: short `label: value` rows in a stable order, naming
// the panel that was opened and the routing ids a caller needs to reach the
// session it just started.
function sessionOpenRows(details) {
  const rows = [`outcome: ${details.resumed === true ? 'resumed' : 'opened'}`];
  const target = cleanValue(details.path);
  if (target.length > 0) rows.push(`path: ${target}`);
  rows.push(`panel: ${details.kind === 'worktree' ? 'worktree' : 'normal'}`);
  // A fallback is never silent: a normal panel created because herdr refused
  // the worktree says so, and names the error code that made it happen.
  const fallback = cleanValue(details.fallback);
  if (fallback.length > 0) rows.push(`fallback: normal panel after herdr reported ${fallback}`);
  const branch = cleanValue(details.branch);
  if (branch.length > 0) rows.push(`branch: ${branch}`);
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
  AGENT_NAME_PATTERN,
  runArgvAsync,
  identityOf,
  canonicalPath,
  repoProbe,
  currentBranch,
  checkoutState,
  classifyPanel,
  validAgentName,
  agentNameForPath,
  herdrArgv,
  resolveHerdrBinary,
  isHerdrRefusal,
  herdrFailureText,
  herdrErrorCode,
  isLinkedWorktreePath,
  worktreeWorkspaceId,
  selectSessionPane,
  openedWorkspace,
  sessionOpenRows,
};
