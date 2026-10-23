'use strict';
// S4 (UI consistency round 3): the warp keyboard delete's ONE confirmation.
//
// Both keyboard surfaces — the panel's `ctrl+d` and the extended list's
// `Ctrl+D` — emit the same `{ delete: path }` marker, so a single builder
// here words every prompt. The invariant this module owns is that a keyboard
// delete is ALWAYS a human decision: nothing here reads gentle-shell's YOLO
// grant, so no permission mode can let a keypress alone remove a checkout.
// (The grant still waives the `worktree_close` tool's OWN dialog; that is a
// different caller and stays untouched.)
//
// The disclosure covers exactly what the human cannot see from the warp
// panel at that moment:
//   - pending changes, through lib/worktree-changes.js;
//   - commits this checkout has that `main` does not, through
//     lib/worktree-git.js `aheadBehind` with `base: 'main'` passed
//     EXPLICITLY. The helper's own resolution would fall back to
//     `origin/main`/`master`, and "ahead of upstream" is not the question
//     that was asked, so the base is never silently substituted.
//
// Every read may fail. A failed read is reported as UNKNOWN with its reason,
// never as zero and never as "no pending changes": a false "clean" would turn
// this dialog into false reassurance about work that is about to be removed.

// Each read is bounded so a hung git can never hold the dialog hostage; the
// interactive path awaits them, so nothing here blocks the host's event loop.
const EVIDENCE_TIMEOUT_MS = 15000;

function optionalRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function reasonOf(error, fallback) {
  if (typeof error === 'string' && error.length > 0) return error;
  if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  if (error && typeof error.error === 'string' && error.error.length > 0) return error.error;
  return fallback;
}

// `unknown` instead of `clean` on every failure path: only a positive read of
// zero changed files may claim a checkout has nothing pending.
async function readChanges(checkoutPath, changesLib, git, timeoutMs) {
  if (!changesLib || typeof changesLib.summarizeChanges !== 'function') {
    return { status: 'unknown', reason: 'the change summary is unavailable' };
  }
  let summary;
  try {
    summary = await changesLib.summarizeChanges(checkoutPath, { git, timeoutMs });
  } catch (err) {
    return { status: 'unknown', reason: reasonOf(err, 'the change summary failed') };
  }
  if (!summary || summary.ok !== true) {
    return { status: 'unknown', reason: reasonOf(summary && summary.error, 'the change summary failed') };
  }
  const files = Number.isFinite(summary.files) ? summary.files : 0;
  if (files === 0) return { status: 'clean', files: 0, added: 0, deleted: 0 };
  return {
    status: 'dirty',
    files,
    added: Number.isFinite(summary.added) ? summary.added : 0,
    deleted: Number.isFinite(summary.deleted) ? summary.deleted : 0,
  };
}

// `ahead: null` means "not known", which is a different statement from
// "zero commits ahead" and stays distinguishable downstream.
async function readAheadMain(checkoutPath, git, timeoutMs) {
  if (!git || typeof git.aheadBehind !== 'function') {
    return { status: 'unknown', ahead: null, reason: 'the ahead/behind read is unavailable' };
  }
  let compared;
  try {
    compared = await git.aheadBehind(checkoutPath, { base: 'main', timeoutMs });
  } catch (err) {
    return { status: 'unknown', ahead: null, reason: reasonOf(err, 'the ahead/behind read failed') };
  }
  if (!compared || compared.ok !== true) {
    return { status: 'unknown', ahead: null, reason: reasonOf(compared && compared.error, 'the ahead/behind read failed') };
  }
  const ahead = Number.isFinite(compared.ahead) ? compared.ahead : null;
  if (ahead === null) {
    return { status: 'unknown', ahead: null, reason: 'the ahead/behind read was unreadable' };
  }
  return { status: ahead > 0 ? 'ahead' : 'none', ahead, base: compared.base };
}

// Options: `git` (the caller's lib/worktree-git.js module), `changesLib`,
// `timeoutMs`. Resolves; never rejects.
async function readWarpDeleteEvidence(checkoutPath, opts = {}) {
  const git = opts.git || optionalRequire('./worktree-git.js');
  const changesLib = opts.changesLib || optionalRequire('./worktree-changes.js');
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? Math.floor(opts.timeoutMs)
    : EVIDENCE_TIMEOUT_MS;
  if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
    return {
      changes: { status: 'unknown', reason: 'the checkout path is empty' },
      aheadMain: { status: 'unknown', ahead: null, reason: 'the checkout path is empty' },
    };
  }
  const [changes, aheadMain] = await Promise.all([
    readChanges(checkoutPath, changesLib, git, timeoutMs),
    readAheadMain(checkoutPath, git, timeoutMs),
  ]);
  return { changes, aheadMain };
}

function changesLine(changes) {
  if (!changes || typeof changes !== 'object') return ' Uncommitted changes: unknown.';
  if (changes.status === 'dirty') {
    const files = Number.isFinite(changes.files) ? changes.files : 0;
    return ` Pending changes: ${files} file${files === 1 ? '' : 's'}, +${changes.added}/-${changes.deleted}.`;
  }
  // A clean checkout says nothing extra: the absence of a warning is the
  // positive "nothing pending" statement, exactly as before this change.
  if (changes.status === 'clean') return '';
  const reason = typeof changes.reason === 'string' && changes.reason.length > 0
    ? changes.reason
    : 'the change summary failed';
  return ` Uncommitted changes: unknown (${reason}).`;
}

function aheadLine(aheadMain) {
  if (!aheadMain || typeof aheadMain !== 'object') return ' Commits ahead of main: unknown.';
  if (aheadMain.status === 'ahead') return ` Commits ahead of main: ${aheadMain.ahead}.`;
  if (aheadMain.status === 'none') return '';
  const reason = typeof aheadMain.reason === 'string' && aheadMain.reason.length > 0
    ? aheadMain.reason
    : 'the ahead/behind read failed';
  return ` Commits ahead of main: unknown (${reason}).`;
}

// Build the dialog for one checkout. `force: true` only on POSITIVE evidence
// of pending changes, so the shared close is never forced on a checkout the
// evidence cannot vouch for.
function warpDeletePrompt(target, evidence) {
  const entry = target && typeof target === 'object' ? target : {};
  const name = typeof entry.name === 'string' ? entry.name : String(entry.name ?? '');
  const checkoutPath = typeof entry.path === 'string' ? entry.path : String(entry.path ?? '');
  const branch = typeof entry.branch === 'string' ? entry.branch : String(entry.branch ?? '');
  const read = evidence && typeof evidence === 'object' ? evidence : {};
  const body = `Delete worktree checkout at ${checkoutPath} for branch '${branch}'? This removes the checkout but keeps the branch.`
    + changesLine(read.changes)
    + aheadLine(read.aheadMain);
  return {
    title: `Delete worktree '${name}'?`,
    body,
    force: !!(read.changes && read.changes.status === 'dirty'),
  };
}

module.exports = {
  EVIDENCE_TIMEOUT_MS,
  readWarpDeleteEvidence,
  warpDeletePrompt,
};
