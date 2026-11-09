'use strict';

// T5 (S5/S6): an isolated Gentle Shell pane has no Herdr Agents row of its own.
//
// Herdr identifies an agent from the pane's foreground process group, and its
// canonical aliases include `pi` and `gentle-shell` but never `gs`; path
// prefixes are not consulted, so an isolated Gentle Shell pane is only
// auto-detected when its foreground group exposes the node/gentle-shell.mjs
// process. `gs` is therefore NOT a canonical agent and must never key
// rows_by_agent — it is only ever a display label, and a reported label is the
// last resort that exists so an undetected pane gets a row at all.
//
// This module holds only the pure decisions: which panes belong to an isolated
// install, what counts as a detected agent, and how a pane's foreground group
// is summarized so a caller can tell that Herdr's detection input changed.
// Transport (socket plus CLI fallback) stays in bin/gentle-status.js, exactly
// like every other contract consumer here.

const os = require('node:os');
const path = require('node:path');

const GS_AGENT = 'gs';
const GS_STATE = 'idle';
const ROOT_ENV_NAMES = ['GENTLE_SHELL_INSTALL_ROOT', 'GENTLE_SHELL_HOME'];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const CMDLINE_MAX = 200;
const PATH_MAX = 4096;

// Herdr pane ids look like `w1:p1`; the check keeps a value from ever reaching
// a fixed argv as something that reads like a flag (no leading `-`, no space,
// no shell metacharacter). Any other shape is skipped, never interpolated.
function safePaneId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

// A reporter source is free text to Herdr but this plugin builds it itself, so
// the same grammar applies: a stable per-run identity, never user input.
function safeSource(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

// Stable per-run source for the reported fallback label. The `:gs` suffix keeps
// it distinct from the token source this daemon already reports under, so a
// release of `gs` can never touch the token family.
function gsSource(pluginId) {
  const id = safeSource(pluginId) ? pluginId : 'herdr-gentle-shell';
  return `plugin:${id}:${GS_AGENT}`;
}

// The isolated Gentle Shell root, resolved from the environment exactly like
// every other directory this plugin derives: an explicit plugin override, then
// the launcher's own GENTLE_SHELL_HOME, then the default. Never a hardcoded
// absolute home.
//
// The verified installation shape is a user install under the XDG data dir —
// <data>/gentle-shell/install, anchored by install/installation.json
// ({"Schema":"gentle-shell-user-install/v1",...,"Mode":"separate"}), whose
// launcher starts the pane as node <root>/runtime/<channel>/bin/gentle-shell.mjs.
// That is what exists on Linux today, so XDG_DATA_HOME is honored the way every
// XDG consumer here honors it. Windows keeps its own user data dir (mirroring
// Herdr's LOCALAPPDATA state-dir convention) but is unverified: the manifest
// ships linux-only, and no other platform has an install shape to confirm.
function dataHome(env = process.env, homedir = os.homedir(), platform = process.platform) {
  if (platform === 'win32') {
    const local = env?.LOCALAPPDATA;
    if (typeof local === 'string' && local.trim().length > 0) return local;
    return path.join(homedir, 'AppData', 'Local');
  }
  const xdg = env?.XDG_DATA_HOME;
  if (typeof xdg === 'string' && xdg.trim().length > 0) return xdg;
  return path.join(homedir, '.local', 'share');
}

function resolveInstallRoot(env = process.env, homedir = os.homedir(), platform = process.platform) {
  for (const name of ROOT_ENV_NAMES) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim().length > 0) return path.resolve(value);
  }
  return path.join(dataHome(env, homedir, platform), 'gentle-shell', 'install');
}

function normalizeDir(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return path.resolve(value);
  } catch {
    return null;
  }
}

// At or under: the root itself qualifies, a sibling does not, and a `..` path
// trick resolves before it is compared. An absent or unusable path never
// qualifies (fail closed, like every parser in this plugin).
function isUnderRoot(candidate, root) {
  const target = normalizeDir(candidate);
  const base = normalizeDir(root);
  if (target === null || base === null) return false;
  if (target === base) return true;
  const rel = path.relative(base, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// cwd is the SECONDARY signal: it only answers when the pane's process group
// cannot be read at all. A real isolated pane is launched from the user's
// project directory, so this is never the rule that decides in practice.
function paneQualifiesForGs(pane, root) {
  if (!pane || typeof pane !== 'object') return false;
  return isUnderRoot(pane.cwd, root) || isUnderRoot(pane.foreground_cwd, root);
}

// Every path-shaped string a process exposes: its argv (a launcher runs
// `node <script>`), argv0, and the tokens of a synthesized cmdline when the
// richer field is all the API gives.
function executablePathsOf(proc) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && value.length <= PATH_MAX) out.push(value);
  };
  if (Array.isArray(proc.argv)) for (const arg of proc.argv) push(arg);
  push(proc.argv0);
  if (typeof proc.cmdline === 'string') {
    for (const token of proc.cmdline.split(/\s+/)) push(token);
  }
  return out.filter(looksLikePath);
}

function looksLikePath(value) {
  return value.includes('/') || value.includes('\\');
}

// Resolve one candidate against the process's own cwd: an absolute path stands,
// a relative one is resolved there (never against this daemon's cwd), and one
// that cannot be resolved never qualifies.
function resolveCandidate(candidate, procCwd) {
  try {
    if (path.isAbsolute(candidate)) return path.resolve(candidate);
    const base = normalizeDir(procCwd);
    return base === null ? null : path.resolve(base, candidate);
  } catch {
    return null;
  }
}

// The PRIMARY signal, and the same input Herdr's detection reads: a member of
// the pane's foreground process group whose executable path resolves at or
// under the install root proves the pane was launched from that install —
// whatever the pane's cwd is. Returns null only when the group is unreadable,
// which is the single case the cwd fallback may decide; `false` is a readable
// answer and is therefore authoritative (a cwd inside the root cannot override
// it).
function groupRunsInstall(processInfo, root) {
  if (!processInfo || typeof processInfo !== 'object') return null;
  if (normalizeDir(root) === null) return null;
  const processes = Array.isArray(processInfo.foreground_processes)
    ? processInfo.foreground_processes
    : [];
  for (const proc of processes) {
    if (!proc || typeof proc !== 'object') continue;
    for (const candidate of executablePathsOf(proc)) {
      const resolved = resolveCandidate(candidate, proc.cwd);
      if (resolved !== null && isUnderRoot(resolved, root)) return true;
    }
  }
  return false;
}

// The qualification decision, with the signal that made it, so callers and
// tests can say which rule decided instead of guessing.
function qualifyPaneForGs(pane, processInfo, root) {
  const byProcess = groupRunsInstall(processInfo, root);
  if (byProcess !== null) return { qualifies: byProcess, signal: 'process' };
  if (paneQualifiesForGs(pane, root)) return { qualifies: true, signal: 'cwd' };
  return { qualifies: false, signal: 'none' };
}

// The agent Herdr reports for a pane: a detection, another reporter's label, or
// this plugin's own `gs`. Anything else (absent, null, blank) is undetected.
function paneAgentOf(pane) {
  const agent = pane?.agent;
  return typeof agent === 'string' && agent.trim().length > 0 ? agent : null;
}

// `gs` is never a detection: Herdr only detects canonical aliases, so a pane
// whose only agent is `gs` is still undetected (it is this plugin's own label).
function isDetectedAgent(agent) {
  return typeof agent === 'string' && agent.length > 0 && agent !== GS_AGENT;
}

// One stable summary of a pane's foreground process group. Detection is a
// function of that group, so an unchanged signature means Herdr's detection
// input is unchanged and no re-check is owed; a changed one means the blocked
// question ("is a real agent there now?") has to be asked again. Sorted and
// length-capped so the value is deterministic and cheap to compare.
function processSignature(processInfo) {
  if (!processInfo || typeof processInfo !== 'object') return null;
  const group = Number.isSafeInteger(processInfo.foreground_process_group_id)
    ? processInfo.foreground_process_group_id
    : null;
  const processes = Array.isArray(processInfo.foreground_processes)
    ? processInfo.foreground_processes
    : [];
  const parts = [];
  for (const proc of processes) {
    if (!proc || typeof proc !== 'object') continue;
    if (!Number.isSafeInteger(proc.pid)) continue;
    const argv0 = typeof proc.argv0 === 'string' ? proc.argv0 : '';
    const name = typeof proc.name === 'string' ? proc.name : '';
    const cmdline = typeof proc.cmdline === 'string' ? proc.cmdline.slice(0, CMDLINE_MAX) : '';
    parts.push(`${proc.pid}:${argv0 || name}:${cmdline}`);
  }
  if (group === null && parts.length === 0) return null;
  parts.sort();
  return `${group === null ? 'group:-' : `group:${group}`}|${parts.join(';')}`;
}

module.exports = {
  GS_AGENT,
  GS_STATE,
  gsSource,
  resolveInstallRoot,
  isUnderRoot,
  paneQualifiesForGs,
  groupRunsInstall,
  qualifyPaneForGs,
  paneAgentOf,
  isDetectedAgent,
  processSignature,
  safePaneId,
  safeSource,
};
