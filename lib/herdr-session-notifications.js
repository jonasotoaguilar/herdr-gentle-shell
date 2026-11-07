'use strict';
// Finish subscription for `herdr_session_open` (recovered from the
// pre-split extensions/gentle-worktree-tools.ts, S26/T35).
//
// Whoever opens a session subscribes to its real finish: the tool passes
// `notify !== false` and ONE watcher starts for the pane it just opened.
// Watchers live in `SESSION_WATCHERS`, keyed by pane id, and
// `clearSessionWatchers` stops them all so tests can reset the registry.
//
// WHAT it watches: the pane id the tool returns, read with `herdr agent get
// <paneId>`. A missing agent (`agent_not_found`) is the VANISHED signal.
// WHAT a finish is: `agent_status` reading `idle` AFTER that same pane was
// observed `working`. `blocked` means the delegate waits for input and never
// counts as `working`. A delegate that never reports `working` is reported as
// never-started, a vanished pane as vanished, the maximum wait as timed out —
// none of those three claims a finish.
// HOW it polls: a bounded unref'd interval with a launch grace window (the
// delegate is idle right after `agent start`, so a finish inside it is
// impossible) and a maximum wait, all injectable so tests run in
// milliseconds.
// HOW it delivers: `pi.sendMessage({customType, content, display, details},
// {deliverAs: "followUp", triggerTurn: true})`, the route incoming session
// messages already use, because the orchestrator has to act on it.

const { spawn } = require('node:child_process');
const path = require('node:path');

const lib = require('./herdr-session-open.js');

const SESSION_WATCH_DEFAULTS = { intervalMs: 15000, graceMs: 60000, maxWaitMs: 4 * 60 * 60 * 1000 };
const AGENT_GET_TIMEOUT_MS = 10000;

const SESSION_WATCHERS = new Map();
let sessionNotifyPi = null;

// The host handle whose `sendMessage` is the delivery route (set once by the
// extension at load, null until then).
function setSessionNotifier(pi) {
  sessionNotifyPi = pi && typeof pi.sendMessage === 'function' ? pi : null;
}

// Explicit options win, then the environment overrides (tests), then the
// production defaults. Non-positive or unparseable values never apply.
function sessionWatchOptions(overrides) {
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
  const envPick = (name) => {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    intervalMs: pick(src.intervalMs) ?? envPick('GENTLE_HERDR_SESSION_WATCH_INTERVAL_MS')
      ?? SESSION_WATCH_DEFAULTS.intervalMs,
    graceMs: pick(src.graceMs) ?? envPick('GENTLE_HERDR_SESSION_WATCH_GRACE_MS')
      ?? SESSION_WATCH_DEFAULTS.graceMs,
    maxWaitMs: pick(src.maxWaitMs) ?? envPick('GENTLE_HERDR_SESSION_WATCH_MAX_MS')
      ?? SESSION_WATCH_DEFAULTS.maxWaitMs,
  };
}

// One outcome, one text. Only the finished text claims a finish.
function sessionWatchContent(outcome, { path: targetPath, paneId, sessionId, maxWaitMs }) {
  switch (outcome) {
    case 'finished':
      return `herdr session finished: ${targetPath} ${sessionId} in pane ${paneId} is idle after working`;
    case 'never-started':
      return `herdr session never started: ${targetPath} ${sessionId} in pane ${paneId} went idle without ever reporting working (the published state is another process's view, so "never started" and "never reported anything" are indistinguishable)`;
    case 'vanished':
      return `herdr session vanished: ${targetPath} ${sessionId} in pane ${paneId} disappeared (agent not found)`;
    default:
      return `herdr session timed out: ${targetPath} ${sessionId} in pane ${paneId} did not finish within ${maxWaitMs}ms`;
  }
}

// Is this published binding OUR session? The value is the session file this
// plugin reports, named `<timestamp>_<session-id>.jsonl`, so the id is
// compared against the SEGMENT the file names — never the whole name as a
// substring or suffix: `session: "def"` would otherwise match
// `..._abc_def.jsonl` and `session: "."` would match any path. The timestamp
// prefix is stripped only when it has the shape Pi writes, so an id that
// itself contains `_` still matches its own file.
const SESSION_FILE_STEM = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;

function bindingNamesSession(value, sessionId) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  if (value === sessionId) return true;
  const base = path.basename(value);
  if (!base.endsWith('.jsonl')) return false;
  return base.slice(0, -6).replace(SESSION_FILE_STEM, '') === sessionId;
}

// Read one `herdr agent get` reply: `{status, vanished, bound, foreign}`.
// `bound` means the pane reports OUR session and `foreign` that it reports a
// different one; both stay false when no binding is available, where the
// published status is all there is. Anything unparseable is neither, so the
// watcher keeps polling to its maximum.
function sessionWatchReading(stdout, sessionId) {
  const unreadable = { status: null, vanished: false, bound: false, foreign: false };
  let doc = null;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  if (!doc || typeof doc !== 'object') return unreadable;
  const err = doc.error;
  if (err && typeof err === 'object' && err.code === 'agent_not_found') {
    return { status: null, vanished: true, bound: false, foreign: false };
  }
  const agent = doc.result && typeof doc.result === 'object' ? doc.result.agent : null;
  const boundValue = agent && agent.agent_session && typeof agent.agent_session.value === 'string'
    ? agent.agent_session.value
    : null;
  const bound = bindingNamesSession(boundValue, sessionId);
  const foreign = boundValue !== null && !bound;
  const status = agent && typeof agent.agent_status === 'string'
    ? agent.agent_status
    : doc.result && typeof doc.result === 'object' && typeof doc.result.agent_status === 'string'
      ? doc.result.agent_status
      : typeof doc.agent_status === 'string' ? doc.agent_status : null;
  return { status, vanished: false, bound, foreign };
}

// One non-blocking `herdr agent get <pane>`: a hung daemon must never freeze
// the session that opened the delegate, so the poll is an async child with
// its own kill timer. `null` means "no reading", never a state.
function pollAgentGet(paneId, repoRoot, onDone) {
  let child = null;
  let settled = false;
  let killer = null;
  const done = (value) => {
    if (settled) return;
    settled = true;
    if (killer !== null) {
      try {
        clearTimeout(killer);
      } catch {}
    }
    onDone(value);
  };
  try {
    child = spawn(lib.resolveHerdrBinary(process.env), lib.herdrArgv('agent-get', { target: paneId }), {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    done(null);
    return;
  }
  killer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
    done(null);
  }, AGENT_GET_TIMEOUT_MS);
  if (killer && typeof killer.unref === 'function') {
    try {
      killer.unref();
    } catch {}
  }
  let out = '';
  try {
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', () => done(null));
    child.on('close', () => done(out));
  } catch {
    done(null);
  }
}

// Start the watcher for one opened pane, replacing any watcher already keyed
// at that pane id. The timer is unref'd so it never holds the process open,
// and cleared with the registry entry the moment an outcome is delivered.
function startAgentSessionWatcher({ paneId, path: targetPath, kind, branch, sessionId, agentName, workspaceId, repoRoot }, options) {
  const { intervalMs, graceMs, maxWaitMs } = sessionWatchOptions(options);
  const startedAt = Date.now();
  let seenWorking = false;
  let sawBound = false;
  let pendingOutcome = null;
  let pendingAt = 0;
  let polling = false;
  let delivering = false;
  const previous = SESSION_WATCHERS.get(paneId);
  if (previous) {
    try {
      clearInterval(previous.timer);
    } catch {}
  }
  const stop = () => {
    const record = SESSION_WATCHERS.get(paneId);
    if (record && record.timer === timer) SESSION_WATCHERS.delete(paneId);
    try {
      clearInterval(timer);
    } catch {}
  };
  // Deliver the one outcome. A host whose `sendMessage` throws or rejects
  // does not turn the notification into silence: the outcome stays pending
  // and is retried on the next tick, bounded by the same maximum wait
  // measured from the outcome itself. One send in flight at a time, so a
  // promise that settles after the next tick cannot deliver twice.
  const attemptDelivery = () => {
    if (delivering) return;
    const sender = sessionNotifyPi && typeof sessionNotifyPi.sendMessage === 'function' ? sessionNotifyPi : null;
    if (!sender) {
      stop();
      return;
    }
    const content = sessionWatchContent(pendingOutcome, { path: targetPath, paneId, sessionId, maxWaitMs });
    const details = {
      path: targetPath, kind, branch, paneId, workspaceId, sessionId, agentName,
      outcome: pendingOutcome, seenWorking,
    };
    const retry = () => {
      delivering = false;
      if (Date.now() - pendingAt >= maxWaitMs) stop();
    };
    let sent;
    delivering = true;
    try {
      sent = sender.sendMessage(
        { customType: 'herdr-agent-sessions.finished', content, display: true, details },
        { deliverAs: 'followUp', triggerTurn: true },
      );
    } catch {
      retry();
      return;
    }
    if (sent && typeof sent.then === 'function') {
      Promise.resolve(sent).then(() => {
        delivering = false;
        stop();
      }, retry);
      return;
    }
    delivering = false;
    stop();
  };
  const finish = (outcome) => {
    pendingOutcome = outcome;
    pendingAt = Date.now();
    attemptDelivery();
  };
  const timer = setInterval(() => {
    if (pendingOutcome !== null) {
      // A host whose send never settles must not keep the watcher alive past
      // its maximum wait: the outcome is dropped, and the timer with it.
      if (delivering && Date.now() - pendingAt >= maxWaitMs) {
        stop();
        return;
      }
      attemptDelivery();
      return;
    }
    if (polling) return;
    polling = true;
    pollAgentGet(paneId, repoRoot, (stdout) => {
      polling = false;
      if (pendingOutcome !== null) return;
      const reading = stdout === null
        ? { status: null, vanished: false, bound: false, foreign: false }
        : sessionWatchReading(stdout, sessionId);
      const elapsed = Date.now() - startedAt;
      const ours = reading.bound || !reading.foreign;
      if (reading.status === 'working' && ours) seenWorking = true;
      if (reading.bound) sawBound = true;
      // Launch grace: the delegate is idle right after `agent start`, so no
      // outcome is concluded inside it. Observations still count: a `working`
      // here arms the finish.
      if (elapsed < graceMs) return;
      if (reading.vanished) {
        finish('vanished');
        return;
      }
      // A pane holding a DIFFERENT session is never ours: a finish is only
      // ever concluded for the session this tool opened.
      if (reading.foreign) {
        finish(sawBound ? 'vanished' : 'never-started');
        return;
      }
      if (reading.status === 'idle') {
        finish(seenWorking ? 'finished' : 'never-started');
        return;
      }
      // `blocked` is the delegate waiting for input — never a finish — and
      // anything unparseable keeps polling to the maximum.
      if (elapsed >= maxWaitMs) finish('timed-out');
    });
  }, intervalMs);
  if (timer && typeof timer.unref === 'function') {
    try {
      timer.unref();
    } catch {}
  }
  SESSION_WATCHERS.set(paneId, { timer, startedAt, paneId, path: targetPath, sessionId });
  return timer;
}

// Stop every watcher and empty the registry.
function clearSessionWatchers() {
  for (const record of SESSION_WATCHERS.values()) {
    try {
      clearInterval(record.timer);
    } catch {}
  }
  SESSION_WATCHERS.clear();
}

module.exports = {
  setSessionNotifier,
  startAgentSessionWatcher,
  clearSessionWatchers,
  sessionWatchOptions,
  sessionWatchContent,
  sessionWatchReading,
};
