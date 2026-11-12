#!/usr/bin/env node
'use strict';

// Gentle status consumer daemon: snapshot → reduce → sidebar tokens.
//
// Polls `agent list`, reduces each pane with lib/gentle-tokens.js (DESIGN
// §5.2), publishes the owned `gentle_*` family (chunked ≤ 16 per report),
// and sweeps only its own token names on handover/uninstall (DESIGN §3 O5).
// Desktop attention is native Herdr (ask + finish toasts, DESIGN §7): this
// daemon emits no notification for any display.
//
// Usage:
//   node bin/gentle-status.js          ensure the daemon is running
//   node bin/gentle-status.js --run    BE the daemon (Herdr [[startup]])
//   node bin/gentle-status.js --once   single frame, then exit (debugging)
//   node bin/gentle-status.js --refresh ensure one daemon + coalesced
//                                        immediate refresh (event hooks); also
//                                        requests one `gs` discovery scan
//   node bin/gentle-status.js --stop   stop the daemon (scoped sweep of live
//   node bin/gentle-status.js --stop --purge   also clear every owned token)
//
// `gs` label (DESIGN §5.5, T5): an isolated Gentle Shell pane has no row until
// this daemon labels it. A pane belongs to the isolated install when a member of
// its foreground process group runs an argv path under the install root — the
// same input Herdr's detection reads, because a real pane is launched from the
// user's project directory and its cwd is never the install; cwd is the fallback
// only when the group cannot be read. Such a pane gets `--display-agent gs` when
// Herdr detects it (presentation only, state untouched) and a reported
// `--agent gs --state idle` label only when it detects nothing, released again
// as soon as detection appears. The root resolves from
// GENTLE_SHELL_INSTALL_ROOT, else GENTLE_SHELL_HOME, else
// <XDG_DATA_HOME|~/.local/share>/gentle-shell/install.
//
// S7 sidebar gate: the sibling sidebar writer owns
// <stateDir>/gentle-sidebar-mode.json ({version:1,enabled:boolean}); this
// daemon only reads it. Missing defaults to enabled (current installs
// unchanged); enabled:false (or malformed, fail-closed) suppresses all
// sidebar publishes and clears only the owned family once per pane. No
// daemon path — including --refresh — ever writes the flag.
//
// Transport mirrors herdr-pi-tree lib/ipc.js + lib/herdr.js: socket calls
// with one CLI fallback each, so a misbehaving socket degrades to slow, not
// broken. A failed snapshot is "no data", never "empty": nothing is
// published or swept on a failed read.
//
// Drawing is subscription-driven and polling is the fallback (DESIGN §5, §8):
// one long-lived socket `events.subscribe` for `pane.updated` (plus the roster
// kinds) wakes the single frame loop, because `pane.report_metadata` makes
// Herdr emit that event and repaint. The subscription can never fail the
// daemon: it reconnects on a bounded backoff, reports one line per distinct
// failure, and the poll below is unchanged and correct without it. The
// git-derived `+N/-N` and `↑N` row data and the presence prefix have no Herdr
// event at all, which is why polling is never removed.
//
// T5 `gs` label ladder (DESIGN §5.5): an isolated Gentle Shell pane has no
// Agents row because `gs` is not a canonical Herdr agent. A pane Herdr detects
// keeps Herdr's own truthful identity and only gets the presentation-only
// `gs` display label; a pane Herdr does not detect gets a reported `gs` label
// as the last resort, so a row exists at all, and that reported label is
// released the moment detection appears.

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-shell: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const contract = require('../lib/gentle-tokens');
const interruptions = require('../lib/gentle-interruptions');
const gsLabel = require('../lib/gentle-gs');

// This daemon's token source tag. The producer extension reports under
// `gentle:v1`; the daemon writes under the plugin convention
// `plugin:<id>` (same as herdr-pi-tree's herdr.source()), so a clear
// touches only this writer's tokens even where names collide.
// Active plugin lookup identity (S15 rename): the manifest id is now
// herdr-gentle-shell, so Herdr injects HERDR_PLUGIN_ID/HERDR_PLUGIN_STATE_DIR
// for the new id. The SOURCE fallback follows the install; the stored
// state dir below deliberately keeps the pre-rename segment so upgrades
// keep their flags, pidfile and ledger with no migration step.
const PLUGIN_ID = 'herdr-gentle-shell';
const PLUGIN_SCOPE = process.env.HERDR_PLUGIN_ID ?? PLUGIN_ID;
const STATE_PLUGIN_ID = 'herdr-gentle-agents';
const SOURCE = `plugin:${PLUGIN_SCOPE}`;

// DESIGN §10 U2 is unresolved (no normative cadence); the provisional poll
// is comfortably below the 60 s token TTL and the producer's 15 s beat so
// every beat is observed at least once. Env-overridable, documented here
// rather than normatively fixed. P1 adaptive poll: the loop idles at the
// baseline cadence and drops to a fast cycle while recent ask activity, an
// active (non-idle) display, or send/publish failures are observed,
// recovering after N quiet frames or when the TTL-bounded fast window
// expires. Single setTimeout chain with a dynamic delay — never a busy loop,
// never setInterval.
const POLL_MS = Number(process.env.GENTLE_STATUS_POLL_MS ?? 10000) || 10000;
const POLL_MIN_MS = 250;

function toPollMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// Pure and env-injectable so tests can assert overrides without reloading
// the module or touching live timers. fastMs is clamped to <= baselineMs
// so a misconfigured fast value can never poll faster than intended.
function resolvePollConfig(env = process.env) {
  const baselineMs = Math.max(POLL_MIN_MS, toPollMs(env?.GENTLE_STATUS_POLL_MS, 10000));
  const fastMs = Math.max(
    POLL_MIN_MS,
    Math.min(toPollMs(env?.GENTLE_STATUS_FAST_POLL_MS, 2000), baselineMs),
  );
  const quietFrames = Math.min(
    100,
    Math.max(1, toPollMs(env?.GENTLE_STATUS_FAST_QUIET_FRAMES, 3)),
  );
  const windowMs = Math.max(POLL_MIN_MS, toPollMs(env?.GENTLE_STATUS_FAST_WINDOW_MS, 60000));
  return { baselineMs, fastMs, quietFrames, windowMs };
}

function createPollState() {
  return { fastUntil: 0, quietFrames: 0 };
}

function createPollStateObserved() {
  return { askActivity: false, failure: false, active: false };
}

// S4: the row data this daemon derives itself — the `+N/-N` changes summary
// and the `↑N` pull marker, read from local git plus `agent.list` — is
// refreshed by a frame, not by a producer report, so an idle pane waits a
// whole baseline for a git change to appear. The reduced display a frame
// already computed is the only classification used: anything other than the
// settled `idle` is active, while an absent or unknown display counts as
// settled and keeps today's baseline (fail closed, like every parser).
function observeDisplay(observed, display) {
  const active = typeof display === 'string' && display.length > 0 && display !== 'idle';
  if (active && observed) observed.active = true;
  return active;
}

// Decide the next loop delay and advance pollState. Any ask activity, active
// display, or send/publish failure (re)arms the TTL-bounded fast window; N
// consecutive quiet frames inside the window recover to baseline early.
function nextPollDelay(pollState, now, observed = {}, config = resolvePollConfig()) {
  if (observed.askActivity || observed.failure || observed.active) {
    pollState.fastUntil = now + config.windowMs;
    pollState.quietFrames = 0;
  } else if (pollState.fastUntil > now) {
    pollState.quietFrames += 1;
    if (pollState.quietFrames >= config.quietFrames) {
      pollState.fastUntil = 0;
      pollState.quietFrames = 0;
    }
  } else {
    pollState.fastUntil = 0;
    pollState.quietFrames = 0;
  }
  return pollState.fastUntil > now ? config.fastMs : config.baselineMs;
}

// A `done` display IS a token expiry (DESIGN §4.3): it recedes to `idle` when
// the hold lapses, so a sleep that runs past it keeps a settled row on `done`
// for up to one whole poll after the hold ended. Capping the sleep at the
// nearest pending expiry fixes that without a second timer. The cap may only
// SHORTEN the delay it was given: a distant expiry returns the delay
// unchanged, an absent or unparseable one returns it unchanged (fail closed,
// exactly like the token parsers), and an already-expired or near expiry falls
// to POLL_MIN_MS instead of 0 so no busy loop is possible.
function capDelayToExpiry(delayMs, nearestExpiry, now = Date.now()) {
  if (typeof nearestExpiry !== 'number' || !Number.isFinite(nearestExpiry)) return delayMs;
  const remaining = nearestExpiry - now;
  if (!(remaining < delayMs)) return delayMs;
  if (!(remaining > POLL_MIN_MS)) return Math.min(delayMs, POLL_MIN_MS);
  return Math.floor(remaining);
}

// Event-synchronized drawing floor (DESIGN §8): a token report lands in Herdr,
// not in this loop, so the producer requests the coalesced refresh above. The
// request may break the sleep, but never sooner than POLL_MIN_MS after the
// frame that started it, so a burst of reports cannot spin the loop faster
// than the poll floor. Returns 0 when a wake may fire now, else how long is
// left before it may — the sleep slices to that instant so an eligible request
// is consumed on the next pass (a naive boolean check would re-test at the
// same phase every slice and could starve while the poll delay IS the floor).
// The request is only consumed once this allows the wake, so nothing is lost.
function refreshGateMs(lastFrameAt, now = Date.now()) {
  if (!Number.isFinite(lastFrameAt)) return 0;
  const elapsed = now - lastFrameAt;
  if (elapsed >= POLL_MIN_MS) return 0;
  return Math.min(POLL_MIN_MS, POLL_MIN_MS - elapsed);
}

// B: the soonest live `done` expiry among the panes a frame reduced. The
// contract's own parser fails closed (foreign session, malformed, already
// expired, or beyond the freshness ceiling all yield null), so a bad token
// never schedules a wake and no value is ever re-derived here.
function doneExpiryOf(entry, now) {
  const tokens =
    entry && typeof entry === 'object' && entry.tokens && typeof entry.tokens === 'object'
      ? entry.tokens
      : null;
  if (tokens === null) return null;
  const done = contract.parseDone(
    tokens[contract.DONE_TOKEN],
    contract.expectedSessionHash(entry),
    now,
  );
  return done === null ? null : done.expiry;
}
const MAX_TOKENS_PER_REPORT = 16;
const SOCKET_TIMEOUT_MS = 4000;
const CLI_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT = 16;

// DESIGN §5.3 pull marker: behind-upstream count per pane cwd, read from
// fixed-argv `git status --porcelain=2 --branch` ONLY (the `# branch.ab`
// line). No shell, no diff, no fetch. Bounded: 2 s timeout, 64 KiB cap,
// short-TTL per-cwd cache (default 30 s, env-overridable) with in-frame
// dedupe via the same cache, so N panes in one worktree cost ~1 git call
// per TTL window. Any failure (no cwd, no git, no upstream, timeout)
// resolves to 0 — fail-closed, the marker simply stays absent.
const PULL_TTL_MS = Number(process.env.GENTLE_PULL_TTL_MS ?? 30000) || 30000;
const PULL_CACHE_MAX = 128;
const pullCache = new Map(); // cwd -> { behind, at }

function branchBehind(cwd) {
  const now = Date.now();
  if (typeof cwd === 'string' && cwd.length > 0) {
    const hit = pullCache.get(cwd);
    if (hit && now - hit.at < PULL_TTL_MS) return hit.behind;
  }
  let behind = 0;
  try {
    if (typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096) {
      const result = spawnSync(
        'git',
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=2', '--branch', '--untracked-files=no'],
        { cwd, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, windowsHide: true },
      );
      if (result.status === 0 && typeof result.stdout === 'string') {
        const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(result.stdout);
        if (ab) behind = Number(ab[2]) || 0;
      }
    }
  } catch {
    behind = 0;
  }
  if (typeof cwd === 'string' && cwd.length > 0) {
    if (pullCache.size >= PULL_CACHE_MAX) pullCache.clear();
    pullCache.set(cwd, { behind, at: now });
  }
  return behind;
}

function pullMarkerFor(entry) {
  const foreground = entry?.foreground_cwd;
  const base = entry?.cwd;
  const cwd =
    typeof foreground === 'string' && foreground.length > 0
      ? foreground
      : typeof base === 'string'
        ? base
        : '';
  const behind = branchBehind(cwd);
  return behind > 0 ? `↑${behind}` : '';
}

const DEBUG = process.env.GENTLE_STATUS_DEBUG === '1';
function debug(...args) {
  if (DEBUG) console.error('[gentle-status]', ...args);
}

/* ------------------------------------------------------------ paths */

function herdrConfigPath() {
  if (process.env.HERDR_CONFIG_PATH) return path.resolve(process.env.HERDR_CONFIG_PATH);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'herdr', 'config.toml');
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

function herdrStateDir() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'herdr');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'herdr');
  }
  return path.join(os.homedir(), '.local', 'state', 'herdr');
}

// Family of files proving a state dir is ours: the stored dir wins whenever it
// holds one of these, so pre-rename flags stay readable and one stray known
// file in the Herdr-injected dir (which changes with the plugin id) may never
// outrank the stored state. Selection order: stored if it holds a known file,
// else the active-id/injected dir if it holds one, else stored — the stored
// canonical dir is the FINAL fallback, so a fresh install converges there and
// every context that does not receive the injected variable names the same
// directory as this daemon. An injected path is honoured only when it IS the
// directory this package derives for that name under the resolved state home
// (S1c); any other path — including an owned basename under another root — is
// ignored and the derived active-id dir is used instead. GENTLE_STATUS_STATE_DIR (explicit user
// override) is always used as-is. This family is IDENTICAL in the sidebar,
// diagnostics, worktree-mode and state-extension resolvers. The daemon also
// WRITES here (pidfile, mode, ledger), so a file it cannot see is a file whose
// dir it splits off: the stored ODD/Issues toggle then reads as missing, i.e.
// enabled.
const STATE_KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
  'gentle-plugin-tools.json',
];
// S1c: the only basenames an injected state dir may have to be honoured — the
// active plugin id Herdr injects today and the stored canonical segment — and
// the path must also BE the one this package derives for that name under the
// resolved state home. Any other injected path belongs to another plugin (or a
// stale/dev id) and is ignored, and so is an owned basename under another root,
// because this daemon receives the variable and every producer does not:
// honouring either is exactly what splits them.
const OWNED_DIR_NAMES = [PLUGIN_ID, STATE_PLUGIN_ID];

function dirHasKnownFiles(dir) {
  for (const name of STATE_KNOWN_FILES) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // A single unreadable entry never decides; keep scanning.
    }
  }
  return false;
}

function storedStateRoot() {
  return path.join(herdrStateDir(), 'plugins', STATE_PLUGIN_ID);
}

// Two spellings name the same directory when their canonical forms match.
// realpath resolves symlinks but throws for a path that does not exist yet, so
// walk up to the deepest existing ancestor and re-append the missing tail: that
// keeps a symlinked or relative spelling of the derived dir from being rejected
// as a different directory (S1c/T12 compares paths, never raw strings).
function canonicalStateDir(dir) {
  const absolute = path.resolve(dir);
  const tail = [];
  let current = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      // Prepended so the missing tail is re-appended in its original order.
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// The active-id dir: the Herdr-injected one only when it IS the directory this
// package derives for that name under the resolved state home, else the same
// sibling of the stored dir derived from the state home. S1c: Herdr injects a
// path per plugin id, so a third id, a stale name or a dev checkout would
// otherwise select a directory we do not own — and so does an owned basename
// under another root, which is exactly the split (the daemon receives the
// variable, the producer derives its own state home). Any other injected path is
// ignored.
function activeStateRoot() {
  const pluginsDir = path.join(herdrStateDir(), 'plugins');
  const injected = process.env.HERDR_PLUGIN_STATE_DIR;
  if (typeof injected === 'string' && injected.length > 0) {
    const name = path.basename(injected);
    if (
      OWNED_DIR_NAMES.includes(name) &&
      canonicalStateDir(injected) === canonicalStateDir(path.join(pluginsDir, name))
    ) {
      return injected;
    }
  }
  return path.join(pluginsDir, PLUGIN_ID);
}

function stateRoot() {
  const explicit = process.env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) {
    try {
      fs.mkdirSync(explicit, { recursive: true });
    } catch {
      // Callers degrade rather than crash; pid writes are best-effort.
    }
    return explicit;
  }
  const stored = storedStateRoot();
  // HEAD parity: an explicit-but-empty (or otherwise invalid non-nullish)
  // value ignores every override and uses the stored default. Only an
  // omitted (null/undefined) explicit falls through to the active-id dir.
  if (explicit !== undefined && explicit !== null) {
    try {
      fs.mkdirSync(stored, { recursive: true });
    } catch {
      // Callers degrade rather than crash; pid writes are best-effort.
    }
    return stored;
  }
  const active = activeStateRoot();
  let dir = stored;
  if (active !== stored) {
    try {
      if (dirHasKnownFiles(stored)) dir = stored;
      else if (dirHasKnownFiles(active)) dir = active;
      else dir = stored;
    } catch {
      dir = stored;
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Callers degrade rather than crash; pid writes are best-effort.
  }
  return dir;
}

const PID_FILE = () => path.join(stateRoot(), 'gentle-status.pid');
const SIDEBAR_MODE_FILE = () => path.join(stateRoot(), 'gentle-sidebar-mode.json');
const SIDEBAR_MODE_MAX_BYTES = 64 * 1024;

// S7 shared gate (sidebar writer owns writing this flag; the daemon only
// reads): {version:1,enabled:boolean}. Missing file defaults to enabled,
// preserving current installations. enabled:false selects the native
// sidebar: this daemon publishes no sidebar tokens and clears only its own
// family once per pane (retrying transport failures). Malformed content
// fails closed as disabled — a naive truthy check could otherwise silently
// reactivate a deliberately disabled mode — with one bounded error report
// per distinct content (see reportSidebarModeError). The flag carries no
// tokens or pane data, and no daemon path (including --refresh hooks)
// ever writes it.
function readSidebarMode() {
  let stat;
  try {
    stat = fs.statSync(SIDEBAR_MODE_FILE());
    if (stat.size > SIDEBAR_MODE_MAX_BYTES) return { enabled: false, malformed: true, raw: '<oversize>' };
  } catch {
    return { enabled: true, malformed: false, raw: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(SIDEBAR_MODE_FILE(), 'utf8');
  } catch {
    return { enabled: true, malformed: false, raw: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: false, malformed: true, raw };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { enabled: false, malformed: true, raw };
  }
  if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean') {
    return { enabled: false, malformed: true, raw };
  }
  return { enabled: parsed.enabled, malformed: false, raw: null };
}

// Bounded malformed-flag report: one stderr line plus one err-file entry
// per distinct flag content. Never throws; never spams per pane/frame.
function reportSidebarModeError(state, raw) {
  const key = `${String(raw).length}:${String(raw).slice(0, 1024)}`;
  if (state && state.sidebarModeErrorReported === key) return;
  if (state) state.sidebarModeErrorReported = key;
  const message = 'gentle-status: sidebar mode flag unreadable; sidebar publishing disabled';
  try {
    console.error(message);
  } catch {
    // stderr is best-effort; the err file below is the durable record.
  }
  logError(new Error(`${message} (raw: ${String(raw).slice(0, 200)})`));
}
const LEDGER_FILE = () => path.join(stateRoot(), 'gentle-status-notified.json');
const ERR_FILE = () => path.join(stateRoot(), 'gentle-status.err');

function logError(error) {
  try {
    try {
      if (fs.statSync(ERR_FILE()).size > 256 * 1024) fs.truncateSync(ERR_FILE(), 0);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(ERR_FILE(), `${new Date().toISOString()} ${error?.stack ?? error}\n`, 'utf8');
  } catch {
    // Logging must never take the daemon down.
  }
}

/* ------------------------------------------------------------ transport */

function pipePath() {
  const sock =
    process.env.HERDR_SOCKET_PATH ?? path.join(path.dirname(herdrConfigPath()), 'herdr.sock');
  return process.platform === 'win32' ? `\\\\.\\pipe\\${sock}` : sock;
}

function rawSocketCall(method, params) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        stream.destroy();
      } catch {
        // Already gone.
      }
      resolve(value);
    };
    let stream;
    try {
      stream = net.connect({ path: pipePath() });
    } catch {
      resolve(null);
      return;
    }
    let body = '';
    stream.setTimeout(SOCKET_TIMEOUT_MS, () => finish(null));
    stream.on('error', () => finish(null));
    stream.on('connect', () => {
      try {
        stream.write(`${JSON.stringify({ id: 'gentle-status', method, params })}\n`);
      } catch {
        finish(null);
      }
    });
    stream.on('data', (chunk) => {
      body += chunk;
      if (body.indexOf('\n') < 0) return;
      try {
        finish(JSON.parse(body.slice(0, body.indexOf('\n'))));
      } catch {
        finish(null);
      }
    });
  });
}

let inFlight = 0;
const waiters = [];

async function socketCall(method, params) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((wake) => waiters.push(wake));
  inFlight += 1;
  try {
    return await rawSocketCall(method, params);
  } finally {
    inFlight -= 1;
    const wake = waiters.shift();
    if (wake) wake();
  }
}

/* ------------------------------------------------------------ events */

// DESIGN §5: the token path is subscription-driven and polling is the
// fallback. `pane.report_metadata` bumps the pane revision and Herdr emits
// `pane.updated` with the full pane payload, but that kind is deliberately
// absent from the manifest hook surface (22 names), so a `[[events]] on =
// "pane.updated"` hook never fires. The supported route is this long-lived
// socket subscription. Roster kinds ride along because they cost one array
// entry each and a roster change is a visible row change.
//
// Nothing here parses the payload: an event only marks ONE dirty flag that
// wakes the single existing sleep, so an event burst collapses into one frame
// (never a second loop, never a timer, never a frame per event). Nothing is
// queued, so bounded memory is one boolean.
const EVENT_SUBSCRIPTIONS = ['pane.updated', 'pane.created', 'pane.closed', 'pane.moved'];
const EVENT_WAKE_KINDS = new Set();
for (const kind of EVENT_SUBSCRIPTIONS) {
  // Pushed envelopes name their kind in snake_case (`pane_updated`); accept
  // both spellings so a framing change can never silently stop the wakes.
  EVENT_WAKE_KINDS.add(kind);
  EVENT_WAKE_KINDS.add(kind.replace('.', '_'));
}
// T5: a roster change is the only moment a pane can enter or leave the
// qualifying `gs` set, so those kinds request one bounded discovery scan. The
// scan itself is never per frame; `pane.agent_detected` rides along because a
// new detection is exactly when a reported label has to be released.
const GS_SCAN_EVENT_KINDS = new Set();
for (const kind of ['pane.created', 'pane.closed', 'pane.moved', 'pane.exited', 'pane.agent_detected']) {
  GS_SCAN_EVENT_KINDS.add(kind);
  GS_SCAN_EVENT_KINDS.add(kind.replace('.', '_'));
}
const EVENT_LINE_MAX_BYTES = 1024 * 1024;
const SUBSCRIBE_REQUEST_ID = 'gentle-status-events';
const SUBSCRIBE_BACKOFF_BASE_MS = 1000;
const SUBSCRIBE_BACKOFF_CAP_MS = 60000;
// A connection that lived this long counts as healthy, so its failure resets
// the backoff ladder. A server that accepts and immediately drops climbs it.
const SUBSCRIBE_STABLE_MS = 5000;

// Pure and time-free so the ladder is asserted directly instead of through
// wall-clock behavior: 1 s, 2 s, 4 s ... capped at 60 s, never decreasing. A
// Herdr restart usually lands inside the first second, and the cap keeps a
// permanently absent server at one connect attempt a minute — a cost the 10 s
// baseline poll it can never replace already pays. Garbage input fails closed
// to the base delay, so no value can produce a 0 delay spin.
function nextSubscribeDelayMs(attempt, livedMs) {
  const prior = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  const stable = Number.isFinite(livedMs) && livedMs >= SUBSCRIBE_STABLE_MS;
  const next = stable ? 1 : Math.min(prior + 1, 31);
  const delayMs = Math.min(SUBSCRIBE_BACKOFF_BASE_MS * 2 ** Math.min(next - 1, 16), SUBSCRIBE_BACKOFF_CAP_MS);
  return { attempt: next, delayMs };
}

// The pushed envelope names the kind at `event` (and repeats it at
// `data.type`); a reply to our own request carries `id` and is not an event.
function eventKindOf(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.id !== undefined && message.id !== null) return null;
  const data = message.data;
  let kind = null;
  if (typeof message.event === 'string') kind = message.event;
  else if (data && typeof data.type === 'string') kind = data.type;
  if (kind === null || !EVENT_WAKE_KINDS.has(kind)) return null;
  return kind;
}

// One connection at a time, reconnected on failure. Every failure is reported
// once per distinct reason (never per attempt) and can never throw or leave an
// unhandled rejection: without the subscription the poll is unchanged and
// correct, so degrading is always the safe outcome.
function startEventSubscription({ onEvent, onFailure } = {}) {
  const notifyEvent = typeof onEvent === 'function' ? onEvent : () => {};
  const reportFailure = typeof onFailure === 'function' ? onFailure : () => {};
  let stream = null;
  let buffer = '';
  let attempt = 0;
  let openedAt = 0;
  let acknowledged = false;
  let failed = false; // this connection already reported and scheduled its retry
  let retryTimer = null;
  let stopped = false;

  const destroy = () => {
    const current = stream;
    stream = null;
    if (!current) return;
    try {
      current.destroy();
    } catch {
      // Already gone.
    }
  };

  const fail = (reason, detail) => {
    if (stopped || failed) return;
    failed = true;
    const livedMs = openedAt === 0 ? 0 : Date.now() - openedAt;
    destroy();
    buffer = '';
    const next = nextSubscribeDelayMs(attempt, livedMs);
    attempt = next.attempt;
    reportFailure(reason, detail);
    retryTimer = setTimeout(connect, next.delayMs);
    // A reconnect timer must never be what keeps the daemon alive.
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  };

  const handleLine = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && message.id === SUBSCRIBE_REQUEST_ID && !acknowledged) {
      if (message.error) {
        const detail = message.error.message ?? message.error.code;
        fail('rejected', typeof detail === 'string' ? detail : undefined);
        return;
      }
      acknowledged = true;
      // A live subscription is idle traffic, not a request awaiting a reply.
      try {
        stream?.setTimeout(0);
      } catch {
        // Not fatal; the socket stays subscribed either way.
      }
      return;
    }
    const kind = eventKindOf(message);
    if (kind !== null) notifyEvent(kind);
  };

  function connect() {
    retryTimer = null;
    if (stopped) return;
    failed = false;
    acknowledged = false;
    buffer = '';
    let next;
    try {
      next = net.connect({ path: pipePath() });
    } catch (error) {
      fail('connect', error?.message);
      return;
    }
    stream = next;
    openedAt = Date.now();
    try {
      next.setEncoding('utf8');
      // A server that accepts the connection and never answers would leave the
      // token path silently unpushed: treat silence like a rejection.
      next.setTimeout(SOCKET_TIMEOUT_MS);
    } catch {
      // Timeouts are best-effort; the data path below still works.
    }
    next.on('connect', () => {
      try {
        next.write(
          `${JSON.stringify({
            id: SUBSCRIBE_REQUEST_ID,
            method: 'events.subscribe',
            params: { subscriptions: EVENT_SUBSCRIPTIONS.map((type) => ({ type })) },
          })}\n`,
        );
      } catch (error) {
        fail('connect', error?.message);
      }
    });
    next.on('timeout', () => fail('unanswered', 'no subscribe acknowledgement'));
    next.on('error', (error) => fail(error?.code ?? 'error', error?.message));
    next.on('end', () => fail('closed', 'subscription ended'));
    next.on('close', () => fail('closed', 'subscription closed'));
    next.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > EVENT_LINE_MAX_BYTES) {
        fail('oversize', 'event frame too large');
        return;
      }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim()) handleLine(line);
        if (stopped || failed) return;
      }
    });
  }

  connect();

  return {
    // Idempotent and synchronous: shutdown must never wait on an event.
    stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      buffer = '';
      destroy();
    },
  };
}

// Bounded subscription report: one stderr line plus one err-file entry per
// distinct failure reason. A Herdr that rejects, closes, or never answers the
// subscription must never be louder than the polling that still covers it.
function reportSubscriptionError(state, reason, detail) {
  const key = typeof reason === 'string' && reason.length > 0 ? reason : 'unknown';
  if (state && state.subscriptionErrorReported === key) return;
  if (state) state.subscriptionErrorReported = key;
  const message =
    `gentle-status: event subscription unavailable (${key}${detail ? `: ${detail}` : ''}); polling continues`;
  try {
    console.error(message);
  } catch {
    // stderr is best-effort; the err file below is the durable record.
  }
  logError(new Error(message));
}

function binary() {
  return process.env.HERDR_BIN_PATH ?? 'herdr';
}

function cliJson(...args) {
  try {
    const result = spawnSync(binary(), args, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// Null on failure, not an empty list: acting on nothing-as-empty would clear
// tokens or sweep over one timed-out read.
async function agentsAsync() {
  const reply = await socketCall('agent.list', {});
  if (reply && !reply.error && Array.isArray(reply.result?.agents)) return reply.result.agents;
  return cliJson('agent', 'list')?.result?.agents ?? null;
}

async function panesAsync() {
  const reply = await socketCall('pane.list', {});
  if (reply && !reply.error && Array.isArray(reply.result?.panes)) return reply.result.panes;
  const viaCli = cliJson('pane', 'list')?.result?.panes;
  // Null on failure, never an empty list: a failed pane read is unknown
  // presence, not confirmed absence (interruption + sweep decisions must
  // tell the two apart). Malformed payloads fail closed the same way.
  return Array.isArray(viaCli) ? viaCli : null;
}

function tokenPatch(tokens) {
  const patch = {};
  for (const [name, value] of Object.entries(tokens)) patch[name] = value ?? null;
  return patch;
}

function reportMetadataCli(paneId, source, tokens) {
  const args = ['pane', 'report-metadata', paneId, '--source', source];
  for (const [name, value] of Object.entries(tokens)) {
    if (value === null || value === undefined) args.push('--clear-token', name);
    else args.push('--token', `${name}=${value}`);
  }
  return cliJson(...args) !== null;
}

async function reportMetadataAsync(paneId, source, tokens) {
  const reply = await socketCall('pane.report_metadata', {
    pane_id: paneId,
    source,
    tokens: tokenPatch(tokens),
  });
  if (reply) return !reply.error;
  return reportMetadataCli(paneId, source, tokens);
}

async function reportChunked(source, paneId, tokens) {
  const names = Object.keys(tokens);
  const jobs = [];
  for (let at = 0; at < names.length; at += MAX_TOKENS_PER_REPORT) {
    const patch = {};
    for (const name of names.slice(at, at + MAX_TOKENS_PER_REPORT)) patch[name] = tokens[name];
    jobs.push(reportMetadataAsync(paneId, source, patch));
  }
  return (await Promise.all(jobs)).every(Boolean);
}

/* ------------------------------------------------------------ gs transport */

// T5 transport: the same socket-then-CLI shape as every other call here, and
// every interpolated value is checked against the lib's identifier grammar
// first, so an unusable pane id or source is skipped rather than reaching a
// fixed argv.
async function paneProcessInfoAsync(paneId) {
  if (!gsLabel.safePaneId(paneId)) return null;
  const reply = await socketCall('pane.process_info', { pane_id: paneId });
  if (reply && !reply.error && reply.result && typeof reply.result === 'object') {
    const info = reply.result.process_info;
    if (info && typeof info === 'object') return info;
  }
  const viaCli = cliJson('pane', 'process-info', '--pane', paneId)?.result?.process_info;
  return viaCli && typeof viaCli === 'object' ? viaCli : null;
}

async function reportAgentAsync(paneId, source, agent, stateName) {
  if (!gsLabel.safePaneId(paneId) || !gsLabel.safeSource(source)) return false;
  const reply = await socketCall('pane.report_agent', { pane_id: paneId, source, agent, state: stateName });
  if (reply) return !reply.error;
  return cliJson('pane', 'report-agent', paneId, '--source', source, '--agent', agent, '--state', stateName) !== null;
}

// Both the source and the label are part of the release: Herdr clears only the
// authority this plugin reported, never another reporter's label on the pane.
async function releaseAgentAsync(paneId, source, agent) {
  if (!gsLabel.safePaneId(paneId) || !gsLabel.safeSource(source)) return false;
  const reply = await socketCall('pane.release_agent', { pane_id: paneId, source, agent });
  if (reply) return !reply.error;
  return cliJson('pane', 'release-agent', paneId, '--source', source, '--agent', agent) !== null;
}

async function setDisplayAgentAsync(paneId, source, label) {
  if (!gsLabel.safePaneId(paneId) || !gsLabel.safeSource(source) || !gsLabel.safeSource(label)) return false;
  const reply = await socketCall('pane.report_metadata', { pane_id: paneId, source, display_agent: label });
  if (reply) return !reply.error;
  return cliJson('pane', 'report-metadata', paneId, '--source', source, '--display-agent', label) !== null;
}

async function clearDisplayAgentAsync(paneId, source) {
  if (!gsLabel.safePaneId(paneId) || !gsLabel.safeSource(source)) return false;
  const reply = await socketCall('pane.report_metadata', {
    pane_id: paneId,
    source,
    clear_display_agent: true,
  });
  if (reply) return !reply.error;
  return cliJson('pane', 'report-metadata', paneId, '--source', source, '--clear-display-agent') !== null;
}

/* ------------------------------------------------------------ gs label */

// Bounded report for the gs path: one stderr line plus one err-file entry per
// distinct failure, never one per frame and never one per pane. Fail closed:
// the label simply stays as it was, exactly like every other degraded path.
const GS_ERROR_KEYS_MAX = 8;

function reportGsError(state, key, message) {
  const errors = state?.gs?.errors;
  if (!(errors instanceof Set) || errors.has(key)) return;
  if (errors.size < GS_ERROR_KEYS_MAX) errors.add(key);
  try {
    console.error(message);
  } catch {
    // stderr is best-effort; the err file below is the durable record.
  }
  logError(new Error(message));
}

function createGsState() {
  return {
    source: gsLabel.gsSource(PLUGIN_SCOPE),
    root: gsLabel.resolveInstallRoot(process.env),
    held: new Map(),
    qualified: new Set(),
    scanPending: true,
    errors: new Set(),
  };
}

// Release only this plugin's reported authority, keeping the presentation-only
// display label: that is the shape every "detection appeared" transition needs,
// and it is also what a departure releases first. Naming our own source AND
// label is what keeps another reporter's authority untouched.
async function releaseGsAuthority(state, paneId) {
  const gsState = state?.gs;
  const entry = gsState?.held?.get(paneId);
  if (!entry || !entry.reported) return true;
  if (!(await releaseAgentAsync(paneId, gsState.source, gsLabel.GS_AGENT))) {
    reportGsError(state, 'release', 'gentle-status: cannot release the reported gs label; retrying next frame');
    if (state.pollObserved) state.pollObserved.failure = true;
    return false;
  }
  entry.reported = false;
  entry.signature = null;
  return true;
}

// Clear everything this plugin reported for one pane: its authority first (the
// masking one), then its display label. A transport failure keeps the entry so
// the next beat retries; only this plugin's own source and label are named.
async function releaseGsPane(state, paneId) {
  const gsState = state?.gs;
  const entry = gsState?.held?.get(paneId);
  if (!entry) return;
  if (!(await releaseGsAuthority(state, paneId))) return;
  if (entry.display) {
    if (!(await clearDisplayAgentAsync(paneId, gsState.source))) {
      reportGsError(state, 'display-clear', 'gentle-status: cannot clear the gs display label; retrying next frame');
      if (state.pollObserved) state.pollObserved.failure = true;
      return;
    }
    entry.display = false;
  }
  gsState.held.delete(paneId);
}

async function releaseGsHeld(state) {
  const gsState = state?.gs;
  if (!gsState || !(gsState.held instanceof Map)) return;
  for (const paneId of [...gsState.held.keys()]) await releaseGsPane(state, paneId);
}

// One qualifying pane, decided by the ladder: the display label always, the
// reported label only while Herdr detects nothing. Every write is deduped by
// the held entry, so a steady pane costs no call at all. `processInfo` is the
// read the caller already had to make (the discovery scan decides qualification
// from it), so a scan never pays for the same answer twice.
async function applyGsPane(state, paneId, detected, processInfo) {
  const gsState = state.gs;
  let entry = gsState.held.get(paneId);
  if (!entry) {
    entry = { display: false, reported: false, signature: null };
    gsState.held.set(paneId, entry);
  }
  if (!entry.display) {
    if (await setDisplayAgentAsync(paneId, gsState.source, gsLabel.GS_AGENT)) entry.display = true;
    else {
      reportGsError(state, 'display', 'gentle-status: cannot set the gs display label; retrying next frame');
      if (state.pollObserved) state.pollObserved.failure = true;
    }
  }
  if (detected) {
    // Herdr's own identity stands: releasing ours is what stops the mask, while
    // the display label stays so the row keeps its `gs` word.
    if (entry.reported) await releaseGsAuthority(state, paneId);
    return;
  }
  if (entry.reported) return;
  const info = processInfo === undefined ? await paneProcessInfoAsync(paneId) : processInfo;
  const signature = gsLabel.processSignature(info);
  if (await reportAgentAsync(paneId, gsState.source, gsLabel.GS_AGENT, gsLabel.GS_STATE)) {
    entry.reported = true;
    entry.signature = signature;
    return;
  }
  reportGsError(state, 'report', 'gentle-status: cannot report the gs label; retrying next frame');
  if (state.pollObserved) state.pollObserved.failure = true;
}

// One bounded discovery scan: `pane list` names the panes, and one
// `pane.process_info` per pane answers the qualification question from the same
// foreground process group Herdr's detection reads. Run at daemon start, on an
// explicit refresh, and on a roster event — never per frame. A failed pane read
// is unknown, never empty, so nothing is released on it.
const GS_SCAN_PANE_MAX = 64;

async function scanGsPanes(state) {
  const gsState = state.gs;
  const panes = await panesAsync();
  if (panes === null) {
    reportGsError(state, 'pane-list', 'gentle-status: pane list unavailable; gs labels unchanged');
    return;
  }
  const qualified = new Set();
  const decided = [];
  let probed = 0;
  for (const pane of panes) {
    const paneId = pane?.pane_id;
    if (!gsLabel.safePaneId(paneId)) continue;
    if (probed >= GS_SCAN_PANE_MAX) {
      reportGsError(
        state,
        'scan-cap',
        `gentle-status: pane list over ${GS_SCAN_PANE_MAX} panes; gs discovery stopped at the cap`,
      );
      break;
    }
    probed += 1;
    const processInfo = await paneProcessInfoAsync(paneId);
    const decision = gsLabel.qualifyPaneForGs(pane, processInfo, gsState.root);
    if (!decision.qualifies) continue;
    qualified.add(paneId);
    decided.push([paneId, gsLabel.isDetectedAgent(gsLabel.paneAgentOf(pane)), processInfo]);
  }
  gsState.qualified = qualified;
  for (const [paneId, detected, processInfo] of decided) {
    await applyGsPane(state, paneId, detected, processInfo);
  }
  for (const paneId of [...gsState.held.keys()]) {
    if (!qualified.has(paneId)) await releaseGsPane(state, paneId);
  }
}

// One beat of label maintenance. Detection is a function of the pane's
// foreground process group and a reported label masks it, so the group is the
// only thing that can answer "is a real agent there now?": an unchanged group
// owes nothing, a changed one releases the label and re-decides immediately, so
// `gs` never masks a detection for longer than the beat it appeared in.
async function gsBeat(state, sidebarEnabled) {
  const gsState = state.gs;
  if (!gsState) return;
  if (sidebarEnabled !== true) {
    // The sidebar is disabled (or its flag is unreadable): this plugin's label
    // is not shown, so it must stop holding agent authority as well.
    await releaseGsHeld(state);
    gsState.scanPending = false;
    return;
  }
  if (gsState.scanPending) {
    gsState.scanPending = false;
    await scanGsPanes(state);
  }
  for (const paneId of [...gsState.held.keys()]) {
    const entry = gsState.held.get(paneId);
    if (!entry) continue;
    if (!gsState.qualified.has(paneId)) {
      await releaseGsPane(state, paneId);
      continue;
    }
    if (!entry.reported) continue;
    const signature = gsLabel.processSignature(await paneProcessInfoAsync(paneId));
    if (signature === null) continue;
    if (entry.signature === null) {
      entry.signature = signature;
      continue;
    }
    if (signature === entry.signature) continue;
    if (!(await releaseGsAuthority(state, paneId))) continue;
    await scanGsPanes(state);
  }
}

// DESIGN §7 notification ownership: desktop attention is native Herdr —
// this consumer emits `herdr notification` for nothing. The ask token still
// drives the sidebar ask display; the Moshi phone path lives in the
// producer extension. This daemon keeps no notification ledger and tracks
// no in-flight sends.

/* ------------------------------------------------------------ frame */

const lastSent = new Map(); // paneId -> JSON of last published family

/* ------------------------------------------------------------ trace */

// S18: optional frame trace. The writer lives in the package's lib/ directory
// one level above the plugin root (herdr-plugin/bin → ../..); a plugin
// installed without it records nothing, and tracing never breaks a frame.
// Activation is the GENTLE_PERF_TRACE environment variable and nothing else, so
// this daemon reads the same shell-level switch as the extension: no flag file
// is written, read or stat'ed here.
let perfTraceModule;
function perfTrace() {
  if (perfTraceModule !== undefined) return perfTraceModule;
  try {
    perfTraceModule = require(path.join(__dirname, '..', '..', 'lib', 'perf-trace.js'));
  } catch {
    perfTraceModule = null;
  }
  return perfTraceModule;
}

function traceEnabled(trace) {
  if (!trace) return false;
  try {
    return trace.isTraceEnabled(process.env) === true;
  } catch {
    return false;
  }
}

// Single scoped sweeper (R3-orphan + R4-live-loop): the owned gentle_*
// family only, cleared under this daemon's own source tag. Foreign tokens
// (pi-tree, native, other plugins) are never touched. All sweep paths —
// per-frame departed-pane sweep, shutdown sweep, --stop handover/purge —
// go through clearOwnedFamily; no duplicated clear logic.
function ownedClearPatch() {
  const clear = {};
  for (const name of contract.SWEEP_TOKENS) clear[name] = null;
  return clear;
}

async function clearOwnedFamily(paneId) {
  lastSent.delete(paneId);
  return reportChunked(SOURCE, paneId, ownedClearPatch());
}

async function frame(state, opts = {}) {
  // Off path: one environment check, no clock read, no object built.
  const trace = perfTrace();
  const tracing = traceEnabled(trace);
  const started = tracing ? process.hrtime.bigint() : 0n;
  const now = Date.now();
  // Cleared every frame, including the failed-snapshot path below: a stale
  // expiry must never cap a later sleep (it would floor every poll at
  // POLL_MIN_MS until the snapshot recovers), and no expiry means today's
  // delay applies.
  state.nearestExpiry = null;
  if (state.pollObserved) {
    state.pollObserved.askActivity = false;
    state.pollObserved.failure = false;
    state.pollObserved.active = false;
  }
  const agents = await agentsAsync();
  if (agents === null) {
    debug('snapshot failed; skipping frame');
    return;
  }
  // S7 gate: read every frame so a sidebar toggle applies on the next
  // poll/event refresh without a daemon restart. Malformed fails closed.
  const sidebar = readSidebarMode();
  if (sidebar.malformed) reportSidebarModeError(state, sidebar.raw);
  const live = new Set();
  const liveOwned = []; // owned pane ids (disabled-mode clear-once)
  const sightings = {}; // paneId -> {entry, reduced} (ledger, daemon only)
  const publishJobs = [];
  let nearestExpiry = null;
  for (const entry of agents) {
    const paneId = entry?.pane_id;
    if (typeof paneId !== 'string') continue;
    live.add(paneId);
    let reduced = contract.reducePane(entry, now);
    if (!reduced.owned) {
      if (state.doneViews instanceof Map) state.doneViews.delete(paneId);
      debug(`pane ${paneId}: pi-tree owns; yielding`);
      continue;
    }
    // T3/S6-S9: done until viewed. The producer stamps the unseen cap as the
    // finish token's expiry, so a fresh token alone would keep `done` for the
    // whole cap. The recede belongs here because `focused` rides the same
    // snapshot this frame already reads: the first observation of the pane as
    // focused starts one dwell, and only then does the row move to `idle`.
    // The ledger is per pane and keyed by the token's absolute expiry, so a
    // cleared token (reactivation or cap) drops it and a new mint starts a new
    // episode. A second look changes nothing: `receded` stays true.
    if (!(state.doneViews instanceof Map)) state.doneViews = new Map();
    const doneView = contract.observeDoneView(state.doneViews.get(paneId), entry, now);
    if (doneView === undefined) state.doneViews.delete(paneId);
    else state.doneViews.set(paneId, doneView);
    if (doneView !== undefined && doneView.receded === true && reduced.display === 'done') {
      reduced = { ...reduced, display: 'idle', label: 'idle' };
    }
    const expiry = doneExpiryOf(entry, now);
    if (expiry !== null && (nearestExpiry === null || expiry < nearestExpiry)) nearestExpiry = expiry;
    // The dwell deadline is a second wake the frame has to honour: without it
    // the recede could wait a whole baseline after the 5 s elapsed.
    if (
      doneView !== undefined &&
      doneView.recedeAt !== undefined &&
      (nearestExpiry === null || doneView.recedeAt < nearestExpiry)
    ) {
      nearestExpiry = doneView.recedeAt;
    }
    sightings[paneId] = { entry, reduced };
    if (!sidebar.enabled) {
      // Native sidebar selected (or malformed flag): never compose a
      // publish; the clear-once phase below handles owned leftovers.
      liveOwned.push(paneId);
      continue;
    }
    // Behind-upstream marker, resolved per cwd with TTL dedupe (no storm
    // across panes sharing a worktree). Absent on any failure.
    reduced.pull = pullMarkerFor(entry);
    // Ask activity keeps the P1 fast cycle armed while a question waits.
    // Desktop attention itself is native (DESIGN §7): no toast here.
    if (reduced.display === 'ask' && reduced.notify && state.pollObserved) {
      state.pollObserved.askActivity = true;
    }
    // S4: any non-idle display keeps the fast cycle armed too, so the git
    // changes summary and pull marker this daemon derives by itself stop
    // lagging up to a whole baseline. Set before the signature short-circuit
    // below: an unchanged row is still a rendered one.
    observeDisplay(state.pollObserved, reduced.display);
    const patch = contract.displayTokens(reduced);
    const signature = JSON.stringify(patch);
    if (lastSent.get(paneId) === signature) continue;
    publishJobs.push({ paneId, patch, signature });
  }
  // The next sleep may not outlive the soonest hold it just drew.
  state.nearestExpiry = nearestExpiry;
  // Publishes land every frame; with no notification path nothing gates them.
  // Suppressed entirely while the native sidebar is selected (S7 gate).
  if (sidebar.enabled) {
    const publishResults = await Promise.all(
      publishJobs.map(async (job) => ({ job, ok: await reportChunked(SOURCE, job.paneId, job.patch) })),
    );
    for (const { job, ok } of publishResults) {
      if (ok) lastSent.set(job.paneId, job.signature);
      else {
        if (state.pollObserved) state.pollObserved.failure = true;
        debug(`publish failed for pane ${job.paneId}; will retry next frame`);
      }
    }
  } else {
    // Disabled clear-once: remove ONLY the owned family from live panes
    // so native selection leaves no gentle_* residue, then stop — one
    // successful clear per pane per tracking window. Transport failure
    // leaves the pane unmarked for retry on the next frame (and arms the
    // fast poll cycle via pollObserved.failure). Producer and foreign
    // tokens are never touched: clearOwnedFamily is the single scoped
    // sweeper. clearOwnedFamily drops lastSent, so re-enable republishes.
    if (!state.clearedWhileDisabled || !(state.clearedWhileDisabled instanceof Set)) {
      state.clearedWhileDisabled = new Set();
    }
    // Bounded tracking: on overflow forget and re-clear once (harmless —
    // clears are idempotent and scoped to the owned family).
    if (state.clearedWhileDisabled.size > 512) state.clearedWhileDisabled.clear();
    for (const paneId of liveOwned) {
      if (state.clearedWhileDisabled.has(paneId)) continue;
      let ok = false;
      try {
        ok = await clearOwnedFamily(paneId);
      } catch (error) {
        logError(error);
      }
      if (ok) state.clearedWhileDisabled.add(paneId);
      else if (state.pollObserved) state.pollObserved.failure = true;
    }
  }

  // Live-set-change orphan sweep (R3-orphan + R4-live-loop): panes that
  // dropped out of the live agent set keep presence-encoded owned tokens;
  // clear the owned family under our own source (never foreign tokens).
  const departed = [...state.live].filter((id) => !live.has(id));
  for (const id of departed) {
    if (state.doneViews instanceof Map) state.doneViews.delete(id);
    try {
      await clearOwnedFamily(id);
    } catch (error) {
      logError(error);
    }
  }
  state.live = live;
  // T5 label ladder, after the token work so a gs failure can never disturb a
  // publish: bounded discovery on the frames that asked for one, then the
  // per-beat re-check of whatever this plugin currently reports.
  try {
    await gsBeat(state, sidebar.enabled);
  } catch (error) {
    logError(error);
  }
  // Diagnostic-only interruption ledger (daemon loop only): --once must
  // never become a second ledger writer, so it skips this entirely.
  if (opts.persistInterruptions === true) {
    try {
      await trackInterruptions(state, sightings, now);
    } catch (error) {
      logError(error);
    }
  }
  // Counts only, never pane ids, cwd, tokens or their values: `panes` is the
  // owned panes this frame reduced and `tokens` the token NAMES it published
  // (0 when nothing changed or the native sidebar is selected).
  if (tracing) {
    let tokens = 0;
    for (const job of publishJobs) tokens += Object.keys(job.patch).length;
    try {
      trace.traceEvent('daemon', {
        ms: Number(process.hrtime.bigint() - started) / 1e6,
        panes: Object.keys(sightings).length,
        tokens,
      }, process.env);
    } catch (error) {
      logError(error);
    }
  }
}

// Daemon-side ledger update: needs pane presence to tell disappearance
// (pane listed, agent gone) from closure (pane gone). A failed pane read
// is unknown — callers pass null and updateInterruptions records nothing.
// Pane presence is fetched only when a previously fresh pane is missing
// from the snapshot, so steady-state frames cost no extra Herdr call.
async function trackInterruptions(state, sightings, now) {
  const prior = state.interruptionsPrior ?? {};
  const stored = state.interruptions ?? interruptions.blankInterruptions();
  const missing = Object.keys(prior).filter((id) => !(id in sightings));
  let paneIds = new Set();
  if (missing.length > 0) {
    const panes = await panesAsync();
    paneIds =
      panes === null
        ? null
        : new Set(panes.map((p) => p?.pane_id).filter((id) => typeof id === 'string'));
  }
  const next = interruptions.updateInterruptions({ prior, stored, live: sightings, paneIds, now });
  state.interruptionsPrior = next.prior;
  state.interruptions = next.stored;
  // Persist only ledger (record) changes: prior churn (last_fresh_ts per
  // frame) stays memory-only and rebuilds from fresh frames after a
  // restart, so steady-state frames cost no disk write.
  if (JSON.stringify(next.stored) !== JSON.stringify(stored)) {
    interruptions.saveInterruptions(stateRoot(), next.stored);
  }
}

// Scoped orphan sweep (DESIGN §3 O5): clear ONLY owned gentle_* names, only
// on panes outside `live`. Foreign tokens (pi-tree, native, other plugins)
// are never touched; the clear runs under this daemon's own source tag.
async function sweepOrphans(live) {
  const panes = await panesAsync();
  if (panes === null) {
    // Unknown presence, never empty: claiming a complete sweep over an
    // unread list would be a lie (callers report incomplete instead).
    debug('pane list failed; skipping sweep');
    return false;
  }
  const jobs = [];
  for (const pane of panes) {
    const id = pane?.pane_id;
    if (typeof id !== 'string' || live.has(id)) continue;
    const tokens = pane?.tokens && typeof pane.tokens === 'object' ? pane.tokens : {};
    if (!contract.SWEEP_TOKENS.some((name) => name in tokens)) continue;
    jobs.push(clearOwnedFamily(id));
  }
  if (jobs.length === 0) return true;
  return (await Promise.all(jobs)).every(Boolean);
}

/* ------------------------------------------------------------ lifecycle */

// PID-reuse guard: a stale pidfile pointing at a recycled PID must never
// be signalled or reported as live. On Linux the daemon cmdline still
// names this script; a mismatch means the pidfile is stale (removed
// best-effort). Where /proc is unavailable the kill(0) liveness check is
// the fallback.
function pidIsOurs(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('gentle-status.js');
  } catch {
    return true;
  }
}

function daemonAlive() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE(), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    if (!pidIsOurs(pid)) {
      try {
        fs.rmSync(PID_FILE(), { force: true });
      } catch {
        // Already gone.
      }
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

const REFRESH_FILE = () => path.join(stateRoot(), 'gentle-status.refresh');

// Coalesced immediate-refresh request: event hooks, the producer extension
// (after every landed token report) and operators touch this file; the daemon
// loop consumes it (delete) and runs one extra frame. N concurrent requests
// collapse to one frame. The file carries only a timestamp — never tokens,
// pane data, or sidebar mode — so an
// event-triggered wake cannot self-feedback: this daemon's own metadata
// writes emit no agent lifecycle events, --refresh itself publishes
// nothing, and the sidebar flag is never written here.
function requestRefresh() {
  try {
    fs.writeFileSync(REFRESH_FILE(), String(Date.now()), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function takeRefresh() {
  try {
    if (!fs.existsSync(REFRESH_FILE())) return false;
    fs.rmSync(REFRESH_FILE(), { force: true });
    return true;
  } catch {
    return false;
  }
}

// T5 discovery request: a separate marker so an EXPLICIT --refresh (the CLI, the
// manifest lifecycle hooks) asks for one `pane list` scan while the producer's
// per-beat wake below never does — otherwise "on an explicit refresh" would
// degrade into a scan per frame. Same bounded file discipline: one coalesced
// timestamp, consumed once, never written by the token path.
const GS_SCAN_FILE = () => path.join(stateRoot(), 'gentle-status.gs-scan');

function requestGsScan() {
  try {
    fs.writeFileSync(GS_SCAN_FILE(), String(Date.now()), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function takeGsScanRequest() {
  try {
    if (!fs.existsSync(GS_SCAN_FILE())) return false;
    fs.rmSync(GS_SCAN_FILE(), { force: true });
    return true;
  } catch {
    return false;
  }
}

function ensureRunning() {
  const pid = daemonAlive();
  if (pid !== null) {
    console.log(`gentle-status: already running (pid ${pid})`);
    return;
  }
  const child = spawn(process.execPath, [__filename, '--run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log('gentle-status: daemon started');
}

async function run() {
  process.on('uncaughtException', (error) => {
    logError(error);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    logError(error);
    process.exit(1);
  });
  if (daemonAlive() !== null) {
    console.error('gentle-status: another daemon owns the pidfile; exiting');
    process.exit(1);
  }
  try {
    fs.writeFileSync(PID_FILE(), String(process.pid), 'utf8');
  } catch (error) {
    console.error(`gentle-status: cannot write pidfile: ${error.message}`);
    process.exit(1);
  }
  const state = {
    live: new Set(),
    pollObserved: createPollStateObserved(),
    nearestExpiry: null,
    interruptionsPrior: {},
    interruptions: interruptions.loadInterruptions(stateRoot()),
    clearedWhileDisabled: new Set(),
    sidebarModeErrorReported: null,
    subscriptionErrorReported: null,
    gs: createGsState(),
  };
  const pollConfig = resolvePollConfig();
  const pollState = createPollState();
  let stopped = false;
  // The whole event state: one dirty flag, no queue. An event may only wake
  // the sleep below; the frame it draws is the same one the poll would draw.
  let eventWake = false;
  const takeEventWake = () => {
    if (!eventWake) return false;
    eventWake = false;
    return true;
  };
  const subscription = startEventSubscription({
    onEvent: (kind) => {
      eventWake = true;
      // A roster change is when the qualifying set can change, so it asks for
      // one bounded scan; `pane.updated` alone never does.
      if (typeof kind === 'string' && GS_SCAN_EVENT_KINDS.has(kind)) state.gs.scanPending = true;
    },
    onFailure: (reason, detail) => reportSubscriptionError(state, reason, detail),
  });
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    // Close the subscription first: a signal must never leave a live socket
    // (or its reconnect timer) behind, and stop() never waits on it.
    try {
      subscription.stop();
    } catch (error) {
      logError(error);
    }
    try {
      fs.rmSync(PID_FILE(), { force: true });
    } catch {
      // Already gone.
    }
    // T5: never leave a reported `gs` authority behind — it would survive this
    // daemon and keep masking a real detection forever. Best-effort and scoped
    // to this plugin's own source and label.
    try {
      await releaseGsHeld(state);
    } catch (error) {
      logError(error);
    }
    // Detached-child rollback (R4): terminate the poll loop and run the
    // scoped sweep over the last-known live set, so disable/uninstall/
    // shutdown leaves no polling child and no orphan owned tokens behind.
    // Best-effort: transport failure is logged, never thrown from a signal.
    try {
      await sweepOrphans(state.live ?? new Set());
    } catch (error) {
      logError(error);
    }
  };
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  for (;;) {
    if (stopped) break;
    const frameStartedAt = Date.now();
    try {
      await frame(state, { persistInterruptions: true });
    } catch (error) {
      logError(error);
    }
    if (stopped) break;
    // Single-loop dynamic delay: fast cycle while recent ask activity, an
    // active display or failures were observed, baseline otherwise, capped at
    // the nearest pending token expiry so a `done` row reaches `idle` on
    // time. No setInterval, no busy loop (delays floored at POLL_MIN_MS via
    // resolvePollConfig and capDelayToExpiry). The sleep is interruptible: a
    // coalesced refresh request — from a lifecycle hook or from the producer
    // after every landed token report — or a `pane.updated` burst on the event
    // subscription breaks the wait early for one immediate frame, never sooner
    // than POLL_MIN_MS after the frame that started it. Both marks are consumed
    // together, so a report and an event landing in the same window still draw
    // one frame. Sequential — the next frame never overlaps the current one;
    // concurrent requests collapse to one.
    const now = Date.now();
    const delay = nextPollDelay(pollState, now, state.pollObserved, pollConfig);
    const sleepMs = capDelayToExpiry(delay, state.nearestExpiry, now);
    // Slice accounting stays whole slices to a deadline, so the sleep can only
    // be shortened by a coalesced refresh request, never extended.
    const deadline = now + sleepMs;
    const sliceMs = 250;
    while (!stopped) {
      const at = Date.now();
      const left = deadline - at;
      if (left <= 0) break;
      const gateMs = refreshGateMs(frameStartedAt, at);
      if (gateMs === 0) {
        const requested = takeRefresh();
        const scanRequested = takeGsScanRequest();
        if (scanRequested) state.gs.scanPending = true;
        if (takeEventWake() || requested || scanRequested) break;
      }
      const slice = Math.min(sliceMs, left);
      await new Promise((resolve) => setTimeout(resolve, gateMs > 0 ? Math.min(slice, gateMs) : slice));
    }
  }
}

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--'));
  if (mode === '--run') {
    await run();
    return;
  }
  if (mode === '--once') {
    const state = { live: new Set(), pollObserved: createPollStateObserved() };
    await frame(state);
    return;
  }
  if (mode === '--refresh') {
    // Recovery + acceleration: ensure exactly one daemon, then request a
    // coalesced immediate refresh. Never renders a frame here, so this
    // path can never become a second interruption-ledger writer; never
    // touches the S7 sidebar flag, so hooks cannot silently reactivate it.
    const live = daemonAlive();
    if (live !== null) {
      console.log(`gentle-status: already running (pid ${live})`);
    } else {
      ensureRunning();
    }
    if (requestRefresh()) console.log('gentle-status: refresh requested');
    else {
      console.error('gentle-status: cannot request refresh');
      process.exit(1);
    }
    requestGsScan();
    return;
  }
  if (mode === '--stop') {
    const purge = process.argv.includes('--purge');
    const pid = daemonAlive();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`gentle-status: stopped daemon (pid ${pid})`);
      } catch (error) {
        console.error(`gentle-status: cannot stop pid ${pid}: ${error.message}`);
      }
    } else {
      console.log('gentle-status: no running daemon');
    }
    try {
      fs.rmSync(PID_FILE(), { force: true });
    } catch {
      // Already gone.
    }
    if (purge) {
      const ok = await sweepOrphans(new Set());
      try {
        fs.rmSync(LEDGER_FILE(), { force: true });
      } catch {
        // Already gone.
      }
      lastSent.clear();
      console.log(ok ? 'gentle-status: purged owned tokens' : 'gentle-status: purge incomplete (transport failure)');
      if (!ok) process.exit(1);
    } else {
      // Handover sweep: clear owned tokens only on panes with no live
      // agent; live panes keep their last reduced family until TTL or the
      // successor writer takes over (never touch foreign tokens).
      const agents = await agentsAsync();
      if (agents === null) {
        console.error('gentle-status: snapshot failed; skipping handover sweep');
        process.exit(1);
      }
      const live = new Set(
        agents.map((a) => a?.pane_id).filter((id) => typeof id === 'string'),
      );
      const ok = await sweepOrphans(live);
      console.log(ok ? 'gentle-status: handover sweep done' : 'gentle-status: handover sweep incomplete');
      if (!ok) process.exit(1);
    }
    return;
  }
  ensureRunning();
}

if (require.main === module) {
  main().catch((error) => {
    logError(error);
    console.error(`gentle-status: ${error?.message ?? error}`);
    process.exit(1);
  });
} else {
  module.exports = {
    POLL_MS,
    POLL_MIN_MS,
    resolvePollConfig,
    createPollState,
    createPollStateObserved,
    nextPollDelay,
    observeDisplay,
    capDelayToExpiry,
    refreshGateMs,
    requestRefresh,
    takeRefresh,
    requestGsScan,
    takeGsScanRequest,
    readSidebarMode,
    nextSubscribeDelayMs,
    startEventSubscription,
    eventKindOf,
    EVENT_SUBSCRIPTIONS,
    SUBSCRIBE_BACKOFF_CAP_MS,
    SUBSCRIBE_STABLE_MS,
    GS_SCAN_EVENT_KINDS,
    createGsState,
    gsBeat,
    scanGsPanes,
  };
}
