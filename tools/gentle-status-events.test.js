'use strict';
// S5/S6: the daemon's token path is subscription-driven; polling stays the
// fallback (odd/tasks/sidebar-sync.md, T4).
//
// `pane.report_metadata` bumps the pane revision and Herdr emits
// `pane.updated` with the full pane payload, but that kind is absent from the
// 22-name manifest hook surface, so `[[events]] on = "pane.updated"` is inert.
// The supported route is a long-lived socket `events.subscribe`. An event may
// only mark one dirty flag and wake the existing sleep: one coalesced frame
// per burst, never a second frame loop, never a frame per event, never faster
// than the existing `refreshGateMs`/`POLL_MIN_MS` floor.
//
// Isolation: every test owns a temp sandbox (state dir, fake `herdr` binary,
// fake socket server) and drives the real `--run` daemon against it. Frames
// are counted from the fake binary's own `agent list` log, so a frame is an
// observable process event, never an internal detail. Every wait is
// deadline-bounded and every daemon is spawned as a tracked child.
//
// The socket server answers every snapshot call with an explicit error, so the
// daemon's per-call transport degrades to the fake binary exactly as it does
// with no Herdr at all; only the subscription connection stays open.
//
// T5 (gs label ladder) reuses the same sandbox and fake binary: the fake also
// answers `pane process-info`, `pane report-agent`, `pane release-agent`, and
// logs every invocation to one call log, so each rule is asserted from an
// observable process event (a CLI call) rather than an internal detail.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-status.js');
const contract = require('../herdr-plugin/lib/gentle-tokens.js');

const FAKE_HERDR = `#!/bin/sh
# Fake herdr for event-subscription and gs-label tests: logs each frame's agent
# snapshot as a start/end pair (frame overlap and count are both observable),
# replays canned JSON, and logs every pane call to one call log plus the
# report-metadata calls to META_LOG.
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  printf -- '---AGENTS-S--- %s\\n' "$(date +%s%N)" >>"$FRAME_LOG"
  if [ -f "$AGENTS_SLEEP" ]; then sleep "$(cat "$AGENTS_SLEEP")"; fi
  cat "$AGENTS_FILE"
  printf -- '---AGENTS-E--- %s\\n' "$(date +%s%N)" >>"$FRAME_LOG"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  printf -- '---PANELIST---\\n' >>"$CALL_LOG"
  cat "$PANES_FILE"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "process-info" ]; then
  printf -- '---PROC--- %s\\n' "$*" >>"$CALL_LOG"
  if [ -f "$PROC_FAIL" ]; then echo "fake-herdr: process-info unavailable" >&2; exit 1; fi
  if [ -f "$PROC_DIR/$4.json" ]; then cat "$PROC_DIR/$4.json"; exit 0; fi
  cat "$PROC_FILE"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "report-agent" ]; then
  printf -- '---REPORT--- %s\\n' "$*" >>"$CALL_LOG"
  printf '{"result":{}}\\n'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "release-agent" ]; then
  printf -- '---RELEASE--- %s\\n' "$*" >>"$CALL_LOG"
  printf '{"result":{}}\\n'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "report-metadata" ]; then
  printf -- '---META--- %s\\n' "$*" >>"$META_LOG"
  printf -- '---META--- %s\\n' "$*" >>"$CALL_LOG"
  printf '{"ok":true}\\n'
  exit 0
fi
echo "fake-herdr: unknown command $*" >&2
exit 1
`;

let sandbox = null;
let daemonChild = null;
let herdrServer = null;

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-events-'));
  const stateDir = path.join(root, 'state');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const installRoot = path.join(root, 'gentle-install');
  fs.mkdirSync(installRoot, { recursive: true });
  const fake = path.join(root, 'herdr-fake.sh');
  fs.writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
  const sb = {
    root,
    stateDir,
    workDir,
    installRoot,
    fake,
    agentsFile: path.join(root, 'agents.json'),
    panesFile: path.join(root, 'panes.json'),
    procFile: path.join(root, 'proc.json'),
    procDir: path.join(root, 'proc'),
    procFail: path.join(root, 'proc-unavailable'),
    callLog: path.join(root, 'calls.log'),
    metaLog: path.join(root, 'meta.log'),
    frameLog: path.join(root, 'frames.log'),
    sleepFile: path.join(root, 'agents-sleep'),
    errFile: path.join(stateDir, 'gentle-status.err'),
    socketPath: path.join(root, 'herdr.sock'),
  };
  fs.writeFileSync(sb.agentsFile, '{"result":{"agents":[]}}\n');
  fs.writeFileSync(sb.panesFile, '{"result":{"panes":[]}}\n');
  fs.writeFileSync(sb.procFile, '{"result":{"process_info":null}}\n');
  fs.mkdirSync(sb.procDir, { recursive: true });
  fs.writeFileSync(sb.callLog, '');
  fs.writeFileSync(sb.metaLog, '');
  fs.writeFileSync(sb.frameLog, '');
  return sb;
}

function sandboxEnv(sb, extra = {}) {
  return {
    ...process.env,
    HOME: sb.root,
    XDG_STATE_HOME: path.join(sb.root, 'xdg-state'),
    XDG_CONFIG_HOME: path.join(sb.root, 'xdg-config'),
    HERDR_CONFIG_PATH: path.join(sb.root, 'no-herdr-config.toml'),
    HERDR_BIN_PATH: sb.fake,
    HERDR_SOCKET_PATH: sb.socketPath,
    HERDR_PLUGIN_ID: 'herdr-gentle-shell',
    GENTLE_STATUS_STATE_DIR: sb.stateDir,
    AGENTS_FILE: sb.agentsFile,
    PANES_FILE: sb.panesFile,
    PROC_FILE: sb.procFile,
    PROC_DIR: sb.procDir,
    PROC_FAIL: sb.procFail,
    CALL_LOG: sb.callLog,
    META_LOG: sb.metaLog,
    FRAME_LOG: sb.frameLog,
    AGENTS_SLEEP: sb.sleepFile,
    GENTLE_SHELL_INSTALL_ROOT: sb.installRoot,
    ...extra,
  };
}

// `mode`: 'accept' holds the subscription open, 'reject' answers it with an
// error, 'close' accepts and drops the connection at once. Every other request
// gets an explicit error so the daemon's call transport falls back to the CLI.
function startHerdrServer(sb, { mode = 'accept', onSubscribed } = {}) {
  const state = { mode, subscriptions: new Set(), closedSubscriptions: 0, requests: [] };
  const server = net.createServer((conn) => {
    let buffer = '';
    let isSubscription = false;
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        state.requests.push(request);
        if (request.method !== 'events.subscribe') {
          try {
            conn.write(`${JSON.stringify({ id: request.id, error: { code: 'unsupported', message: 'test' } })}\n`);
            conn.end();
          } catch {}
          continue;
        }
        isSubscription = true;
        state.subscriptions.add(conn);
        if (state.mode === 'reject') {
          try {
            conn.write(`${JSON.stringify({ id: request.id, error: { code: 'unsupported', message: 'no events' } })}\n`);
          } catch {}
          continue;
        }
        try {
          conn.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
        } catch {}
        if (typeof onSubscribed === 'function') onSubscribed(request);
        if (state.mode === 'close') {
          try {
            conn.destroy();
          } catch {}
        }
      }
    });
    conn.on('close', () => {
      if (!isSubscription) return;
      state.subscriptions.delete(conn);
      state.closedSubscriptions += 1;
    });
    conn.on('error', () => {});
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sb.socketPath, () => resolve({ server, state }));
  });
}

function pushPaneUpdated(_server, conn) {
  conn.write(`${JSON.stringify({
    event: 'pane_updated',
    data: { type: 'pane_updated', pane: { pane_id: 'pane-1', tokens: {} } },
  })}\n`);
}

function pushTwoPaneUpdated(conn) {
  const frame = `${JSON.stringify({
    event: 'pane_updated',
    data: { type: 'pane_updated', pane: { pane_id: 'pane-1', tokens: {} } },
  })}\n`;
  conn.write(frame);
  conn.write(frame);
}

function startDaemon(sb, extraEnv = {}) {
  daemonChild = spawn(process.execPath, [DAEMON, '--run'], {
    env: sandboxEnv(sb, extraEnv),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  daemonChild.stderrText = '';
  daemonChild.stderr.setEncoding('utf8');
  daemonChild.stderr.on('data', (chunk) => {
    daemonChild.stderrText += chunk;
  });
  return daemonChild;
}

async function stopDaemon() {
  const child = daemonChild;
  daemonChild = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return null;
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    child.kill('SIGTERM');
  } catch {
    return null;
  }
  const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 6000))]);
  if (result === null) {
    try {
      child.kill('SIGKILL');
    } catch {}
    await exited;
  }
  return result;
}

// Frame log as ordered start/end pairs: `frames` counts completed frames and
// `overlaps` proves two frames never ran at the same time.
function readFrames(sb) {
  let text = '';
  try {
    text = fs.readFileSync(sb.frameLog, 'utf8');
  } catch {
    return { frames: 0, started: 0, overlaps: 0 };
  }
  let started = 0;
  let finished = 0;
  let overlaps = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('---AGENTS-S---')) {
      if (started > finished) overlaps += 1;
      started += 1;
    } else if (line.startsWith('---AGENTS-E---')) {
      finished += 1;
    }
  }
  return { frames: finished, started, overlaps };
}

function errLines(sb) {
  try {
    return fs.readFileSync(sb.errFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

async function waitFor(label, fn, timeoutMs = 6000) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function waitWithin(label, fn, timeoutMs = 4000) {
  return waitFor(label, fn, timeoutMs);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// T5 harness additions: the fake binary's call log is the observable surface
// (one line per invocation), so every rule is asserted from a real process
// call instead of an internal predicate.
function readCalls(sb) {
  try {
    return fs.readFileSync(sb.callLog, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function callsWith(sb, tag) {
  return readCalls(sb).filter((line) => line.startsWith(tag));
}

function writePanes(sb, panes) {
  fs.writeFileSync(sb.panesFile, `${JSON.stringify({ result: { panes } })}\n`);
}

// One process-info answer for every pane, or one just for `paneId`.
function writeProc(sb, processInfo) {
  fs.writeFileSync(sb.procFile, `${JSON.stringify({ result: { process_info: processInfo } })}\n`);
}

function writeProcFor(sb, paneId, processInfo) {
  fs.writeFileSync(path.join(sb.procDir, `${paneId}.json`), `${JSON.stringify({ result: { process_info: processInfo } })}\n`);
}

// A real isolated pane: `gentle-shell` is launched from the user's PROJECT
// directory, so cwd is never the install root — only the foreground process
// group knows which install the pane belongs to.
const PROJECT_CWD = '/home/someone/project';

function launchPane(sb, overrides = {}) {
  return { pane_id: 'wT:p1', cwd: PROJECT_CWD, foreground_cwd: PROJECT_CWD, agent_status: 'idle', ...overrides };
}

// A pane the cwd rule alone would accept: it sits inside the install root, as
// the isolated launch's own shell does.
function installRootPane(sb, overrides = {}) {
  return {
    pane_id: 'wT:p1',
    cwd: path.join(sb.installRoot, 'work'),
    foreground_cwd: path.join(sb.installRoot, 'work'),
    agent_status: 'idle',
    ...overrides,
  };
}

const GS_SOURCE = 'plugin:herdr-gentle-shell:gs';

// The isolated install's entry script, exactly where a real launch exposes it in
// the pane's foreground process group.
function gsScriptPath(sb, runtime = 'main-sdk') {
  return path.join(sb.installRoot, 'runtime', runtime, 'bin', 'gentle-shell.mjs');
}

// The install's own launch process in the foreground group: the signal Herdr's
// detection reads, and the one this plugin qualifies on.
function procGs(sb, { group = 4242, pid = 4242, extra = [] } = {}) {
  const script = gsScriptPath(sb);
  return {
    pane_id: 'wT:p1',
    foreground_process_group_id: group,
    foreground_processes: [
      {
        pid,
        argv0: 'node',
        name: 'node',
        argv: ['node', script],
        cmdline: `node ${script}`,
        cwd: PROJECT_CWD,
      },
      ...extra,
    ],
  };
}

// The same group once Herdr detects the agent: `pi` runs inside it, which is
// exactly why a reported `gs` label would mask a real detection.
function procGsAndPi(sb) {
  return procGs(sb, {
    group: 5353,
    pid: 5353,
    extra: [{ pid: 5354, argv0: 'pi', name: 'pi', argv: ['pi'], cmdline: 'pi', cwd: PROJECT_CWD }],
  });
}

// A readable group with no install member: an ordinary agent pane.
function procPiOnly() {
  return {
    pane_id: 'wT:p1',
    foreground_process_group_id: 6001,
    foreground_processes: [{ pid: 6001, argv0: 'pi', name: 'pi', argv: ['pi'], cmdline: 'pi', cwd: PROJECT_CWD }],
  };
}

function runRefresh(sb, extra = {}) {
  return spawnSync(process.execPath, [DAEMON, '--refresh'], {
    encoding: 'utf8',
    timeout: 15000,
    env: sandboxEnv(sb, extra),
  });
}

function pushEvent(conn, kind, data) {
  conn.write(`${JSON.stringify({ event: kind, data: { type: kind, ...data } })}\n`);
}

beforeEach(() => {
  sandbox = makeSandbox();
  daemonChild = null;
  herdrServer = null;
});

afterEach(async () => {
  await stopDaemon();
  try {
    herdrServer?.server.close();
  } catch {}
  herdrServer = null;
  try {
    if (sandbox) fs.rmSync(sandbox.root, { recursive: true, force: true });
  } catch {}
  sandbox = null;
});

describe('event subscription wakes the drawing (S5/S6)', () => {
  it('one pane.updated event wakes exactly one frame, and two in one tick still produce one', async () => {
    // A 30 s baseline means no frame can come from the poll inside this test:
    // every frame observed after the startup one is event-driven.
    const sb = sandbox;
    herdrServer = await startHerdrServer(sb);
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '30000', GENTLE_STATUS_FAST_POLL_MS: '30000' });
    await waitFor('the daemon subscribes', () => herdrServer.state.subscriptions.size > 0);
    const conn = [...herdrServer.state.subscriptions][0];
    const base = await waitFor('the startup frame', () => {
      const { frames } = readFrames(sb);
      return frames > 0 ? frames : 0;
    });

    pushPaneUpdated(herdrServer, conn);
    await waitFor('one frame drawn by the event', () => readFrames(sb).frames >= base + 1, 4000);
    await wait(700);
    assert.equal(readFrames(sb).frames, base + 1, 'one event draws exactly one frame');

    pushTwoPaneUpdated(conn);
    await waitFor('one frame for the burst', () => readFrames(sb).frames >= base + 2, 4000);
    await wait(700);
    assert.equal(readFrames(sb).frames, base + 2, 'two events in one tick still draw a single frame');
    assert.equal(readFrames(sb).overlaps, 0, 'frames never overlap');
  });

  it('an event arriving while a frame renders coalesces into the next frame', async () => {
    const sb = sandbox;
    // A slow snapshot keeps a frame open long enough to deliver an event
    // inside it deterministically.
    fs.writeFileSync(sb.sleepFile, '0.7\n');
    herdrServer = await startHerdrServer(sb);
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '30000', GENTLE_STATUS_FAST_POLL_MS: '30000' });
    await waitFor('the daemon subscribes', () => herdrServer.state.subscriptions.size > 0);
    const conn = [...herdrServer.state.subscriptions][0];
    const base = await waitFor('the startup frame', () => {
      const { frames } = readFrames(sb);
      return frames > 0 ? frames : 0;
    });

    pushPaneUpdated(herdrServer, conn);
    await waitFor('a frame started by the event', () => readFrames(sb).started >= base + 1, 4000);
    // Mid-frame: the event must not be lost and must not start a second frame.
    pushPaneUpdated(herdrServer, conn);
    await waitFor('the coalesced frame after it', () => readFrames(sb).frames >= base + 2, 6000);
    await wait(900);
    assert.equal(readFrames(sb).frames, base + 2, 'the mid-frame event draws exactly one more frame');
    assert.equal(readFrames(sb).overlaps, 0, 'a mid-frame event never starts a second concurrent frame');
  });

  it('a subscription that cannot be established leaves the poll running and logs once', async () => {
    // (a) no server at all, (b) a server that rejects the subscription, and
    // (c) one that accepts and drops it: all three must degrade to polling with
    // one bounded log line, never a crash, never a reconnect storm of lines.
    const modes = ['absent', 'reject', 'close'];
    for (const mode of modes) {
      if (mode !== 'absent') herdrServer = await startHerdrServer(sandbox, { mode });
      startDaemon(sandbox, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });
      const child = daemonChild;
      try {
        await waitFor(`${mode}: the poll keeps drawing frames`, () => readFrames(sandbox).frames >= 3, 6000);
        // Long enough for several reconnect attempts (1 s, 2 s, 4 s ladder).
        await wait(2600);
        assert.ok(
          readFrames(sandbox).frames >= 4,
          `${mode}: polling must keep running without the subscription`,
        );
        assert.equal(child.exitCode, null, `${mode}: the daemon must not crash`);
        const reported = errLines(sandbox).filter((line) => /event subscription unavailable/.test(line));
        assert.equal(reported.length, 1, `${mode}: exactly one bounded line for one distinct failure, saw ${reported.length}`);
        assert.match(
          reported[0],
          /polling continues/,
          `${mode}: the line must say polling still covers the token path`,
        );
        const stderrLines = String(child.stderrText).split('\n').filter((line) => /event subscription unavailable/.test(line));
        assert.equal(stderrLines.length, 1, `${mode}: one stderr line, not one per attempt`);
      } finally {
        await stopDaemon();
      }
      try {
        herdrServer?.server.close();
      } catch {}
      herdrServer = null;
      fs.writeFileSync(sandbox.frameLog, '');
      try {
        fs.rmSync(sandbox.errFile, { force: true });
      } catch {}
    }
  });

  it('the reconnect backoff is bounded and never decreases', () => {
    const daemon = require('../herdr-plugin/bin/gentle-status.js');
    const cap = daemon.SUBSCRIBE_BACKOFF_CAP_MS;
    let prior = 0;
    let attempt = 0;
    const delays = [];
    for (let step = 0; step < 40; step += 1) {
      const next = daemon.nextSubscribeDelayMs(attempt, 0);
      assert.ok(next.delayMs >= prior, `attempt ${step} went backwards: ${next.delayMs} < ${prior}`);
      assert.ok(next.delayMs <= cap, `attempt ${step} exceeded the cap: ${next.delayMs}`);
      assert.ok(next.attempt >= attempt, 'a failed attempt never rewinds the ladder');
      if (attempt < 31) assert.ok(next.attempt > attempt, 'below saturation every failure advances the ladder');
      prior = next.delayMs;
      attempt = next.attempt;
      delays.push(next.delayMs);
    }
    assert.deepEqual(
      delays.slice(0, 8),
      [1000, 2000, 4000, 8000, 16000, 32000, cap, cap],
      'the ladder starts at 1 s, doubles, and stops at the cap',
    );
    assert.equal(delays[delays.length - 1], cap, 'the ladder ends at the cap, not past it');
    assert.equal(cap, 60000, 'a permanently absent server costs one attempt a minute at most');
    // A connection that stayed live for the stable window reconnects promptly.
    assert.deepEqual(daemon.nextSubscribeDelayMs(7, daemon.SUBSCRIBE_STABLE_MS), { attempt: 1, delayMs: 1000 });
    assert.deepEqual(daemon.nextSubscribeDelayMs(7, 0), { attempt: 8, delayMs: cap });
    // Garbage input fails closed to the base delay: one attempt, never a spin.
    for (const garbage of [Number.NaN, -1, 2.5, 'x', null, undefined]) {
      assert.equal(daemon.nextSubscribeDelayMs(garbage, garbage).delayMs, 1000, `${String(garbage)} falls back to the base`);
    }
  });

  it('shutdown during an active subscription exits cleanly', async () => {
    const sb = sandbox;
    herdrServer = await startHerdrServer(sb);
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '30000', GENTLE_STATUS_FAST_POLL_MS: '30000' });
    await waitFor('the daemon subscribes', () => herdrServer.state.subscriptions.size > 0);
    const conn = [...herdrServer.state.subscriptions][0];
    pushPaneUpdated(herdrServer, conn);
    await waitFor('a frame while subscribed', () => readFrames(sb).frames > 0, 4000);

    const result = await stopDaemon();
    assert.deepEqual(result, { code: 0, signal: null }, 'SIGINT/SIGTERM shutdown exits cleanly');
    assert.equal(herdrServer.state.closedSubscriptions >= 1, true, 'the subscription socket is closed on shutdown');
    assert.equal(fs.existsSync(path.join(sb.stateDir, 'gentle-status.pid')), false, 'the pidfile is removed');
  });

  // PRESERVE: the producer's file request keeps its exact behavior — the sleep
  // is broken by the request alone, with no event subscription involved.
  it('a producer refresh request still draws one coalesced frame', async () => {
    const sb = sandbox;
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '30000', GENTLE_STATUS_FAST_POLL_MS: '30000' });
    await waitFor('the startup frame', () => readFrames(sb).frames >= 1);
    const base = readFrames(sb).frames;
    fs.writeFileSync(path.join(sb.stateDir, 'gentle-status.refresh'), String(Date.now()), 'utf8');
    await waitFor('one frame drawn by the request', () => readFrames(sb).frames >= base + 1, 4000);
    await wait(600);
    assert.equal(readFrames(sb).frames, base + 1, 'one request draws exactly one frame');
  });
});

// T5 (S5/S6): the `gs` label ladder. Herdr has no canonical `gs` agent, so a
// `gs` row only exists from a reported label, and that label must never mask a
// real `pi`/`gentle-shell` detection. Detection keeps Herdr's truthful state and
// only the presentation-only display label changes; the reported label is the
// last resort for a pane Herdr does not detect at all, and it is reverted the
// moment detection appears.
//
// Qualification follows Herdr's own detection input — the pane's foreground
// process group — because a real isolated pane is launched from the user's
// project directory and its cwd never sits inside the install. cwd is the
// secondary signal, reachable only when the group cannot be read at all.
describe('gs label ladder for an isolated Gentle Shell pane (S5/S6)', () => {
  it('a detected gs pane gets only the display label, never a reported authority', async () => {
    const sb = sandbox;
    writePanes(sb, [launchPane(sb, { agent: 'pi' })]);
    writeProc(sb, procGsAndPi(sb));
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });

    const meta = await waitFor('the display label', () => {
      const hits = callsWith(sb, '---META---').filter((line) => line.includes('--display-agent gs'));
      return hits.length > 0 ? hits : null;
    });
    assert.match(
      meta[0],
      new RegExp(`pane report-metadata wT:p1 --source ${GS_SOURCE} --display-agent gs`),
      'the label is presentation-only metadata under this plugin\'s own gs source',
    );

    await wait(800);
    assert.equal(
      callsWith(sb, '---REPORT---').length,
      0,
      'a pane Herdr already detects never gets a reported authority (its truthful state stays)',
    );
    assert.equal(
      callsWith(sb, '---META---').filter((line) => line.includes('--display-agent gs')).length,
      1,
      'one display write, then deduped while nothing changes',
    );
  });

  it('a pane whose cwd is the project but whose foreground group runs the install qualifies', async () => {
    const sb = sandbox;
    // The real shape: launched from a repo, so cwd is nowhere near the install.
    writePanes(sb, [launchPane(sb, { agent: undefined })]);
    writeProc(sb, procGs(sb));
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });

    const report = await waitFor('the reported label', () => {
      const hits = callsWith(sb, '---REPORT---');
      return hits.length > 0 ? hits : null;
    });
    assert.match(
      report[0],
      new RegExp(`pane report-agent wT:p1 --source ${GS_SOURCE} --agent gs --state idle`),
      'the foreground group runs <root>/runtime/.../gentle-shell.mjs, so the row exists',
    );
    assert.ok(
      callsWith(sb, '---PROC---').some((line) => line.includes('wT:p1')),
      'the qualification came from the pane\'s process info, not from its cwd',
    );

    await wait(800);
    assert.equal(callsWith(sb, '---REPORT---').length, 1, 'identical reports are never re-sent');
    assert.equal(
      callsWith(sb, '---META---').filter((line) => line.includes('--display-agent gs')).length,
      1,
      'the display label is written once too',
    );
  });

  it('a cwd inside the root cannot qualify a pane whose readable group shows an ordinary agent', async () => {
    const sb = sandbox;
    // cwd alone would say "yes"; the readable process group is authoritative and
    // says "no", so the cwd rule is never consulted.
    writePanes(sb, [installRootPane(sb)]);
    writeProc(sb, procPiOnly());
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });

    await waitFor('a process read', () => callsWith(sb, '---PROC---').length >= 1);
    await wait(800);
    assert.ok(callsWith(sb, '---PROC---').length >= 1, 'the group was read');
    for (const tag of ['---REPORT---', '---RELEASE---', '---META---']) {
      assert.equal(callsWith(sb, tag).length, 0, `${tag} must not fire: the process group decided against qualifying`);
    }
  });

  it('an unreadable group falls back to cwd, silently and once', async () => {
    const sb = sandbox;
    writePanes(sb, [installRootPane(sb)]);
    fs.writeFileSync(sb.procFail, '');
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });

    const report = await waitFor('the reported label', () => {
      const hits = callsWith(sb, '---REPORT---');
      return hits.length > 0 ? hits : null;
    });
    assert.match(report[0], /--agent gs --state idle/, 'the cwd fallback still gives the pane a row');
    assert.ok(callsWith(sb, '---PROC---').length >= 1, 'the group was attempted first');

    await wait(800);
    // Noise means the daemon's own bounded gs-ladder warnings, matched by the
    // exact message text it writes for a failed report/process-group read. A
    // `/gs|process/i` substring also matches the sandbox path itself (a TMPDIR
    // may contain `gs`) and unrelated stack frames such as
    // `process.processTicksAndRejections`, so a clean run would pass by luck.
    const gsWarning = new RegExp(
      'gentle-status: (?:'
        + 'cannot (?:report|set|clear|release) the (?:reported )?gs (?:display )?label'
        + '|pane list unavailable; gs labels unchanged'
        + '|pane list over \\d+ panes; gs discovery stopped at the cap'
        + ')',
    );
    const noise = errLines(sb).filter((line) => gsWarning.test(line));
    assert.ok(noise.length <= 1, `an unreadable group logs at most one bounded line, saw ${noise.length}`);
    assert.equal(daemonChild.exitCode, null, 'the daemon never crashes on an unreadable group');
  });

  it('a non-gs pane is never touched', async () => {
    const sb = sandbox;
    writePanes(sb, [
      { pane_id: 'wT:p2', cwd: PROJECT_CWD, foreground_cwd: PROJECT_CWD, agent: 'pi', agent_status: 'idle' },
      { pane_id: 'wT:p3', cwd: PROJECT_CWD, agent_status: 'idle' },
      { pane_id: 'wT:p4', agent_status: 'idle' },
    ]);
    writeProc(sb, procPiOnly());
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });

    await waitFor('one discovery scan', () => callsWith(sb, '---PANELIST---').length >= 1);
    await wait(800);
    assert.ok(callsWith(sb, '---PANELIST---').length >= 1, 'discovery did run');
    assert.ok(callsWith(sb, '---PROC---').length >= 1, 'each pane\'s group is read once to decide');
    for (const tag of ['---REPORT---', '---RELEASE---', '---META---']) {
      assert.equal(callsWith(sb, tag).length, 0, `${tag} must never touch a pane outside the isolated install`);
    }
  });

  it('once detection appears the authority is cleared and the display label remains', async () => {
    const sb = sandbox;
    writePanes(sb, [launchPane(sb)]);
    writeProc(sb, procGs(sb));
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });
    await waitFor('the reported label', () => callsWith(sb, '---REPORT---').length >= 1);

    // Herdr's detection input changed (the group now carries the agent too), so
    // Herdr detects it: this plugin's own label would otherwise mask it forever.
    writeProc(sb, procGsAndPi(sb));
    writePanes(sb, [launchPane(sb, { agent: 'pi' })]);

    const releases = await waitFor('the authority release', () => {
      const hits = callsWith(sb, '---RELEASE---');
      return hits.length > 0 ? hits : null;
    });
    assert.match(
      releases[0],
      new RegExp(`pane release-agent wT:p1 --source ${GS_SOURCE} --agent gs`),
      'the plugin releases exactly the authority it set, under its own source',
    );

    await wait(800);
    assert.equal(callsWith(sb, '---RELEASE---').length, 1, 'one release, then nothing left to release');
    assert.equal(
      callsWith(sb, '---REPORT---').length,
      1,
      'the label is never reported again once Herdr detects the agent',
    );
    assert.equal(
      callsWith(sb, '---META---').filter((line) => line.includes('--display-agent gs')).length,
      1,
      'the display label remains (presentation only)',
    );
    assert.equal(
      callsWith(sb, '---META---').filter((line) => line.includes('--clear-display-agent')).length,
      0,
      'a live pane keeps its label',
    );
    const order = readCalls(sb);
    assert.ok(
      order.findIndex((line) => line.startsWith('---REPORT---')) <
        order.findIndex((line) => line.startsWith('---RELEASE---')),
      'the release follows the report it undoes',
    );
  });

  it('a detection noticed by a scan releases the authority and keeps the label', async () => {
    const sb = sandbox;
    writePanes(sb, [launchPane(sb)]);
    writeProc(sb, procGs(sb));
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });
    await waitFor('the reported label', () => callsWith(sb, '---REPORT---').length >= 1);

    // The hook path: Herdr detects the agent and its own event asks for a
    // refresh, so no foreground change is needed for the scan to see it.
    writePanes(sb, [launchPane(sb, { agent: 'gentle-shell' })]);
    assert.equal(runRefresh(sb).status, 0, 'the detection hook exits cleanly');

    await waitFor('the authority release', () => callsWith(sb, '---RELEASE---').length >= 1);
    await wait(600);
    assert.equal(callsWith(sb, '---RELEASE---').length, 1, 'one release of the authority');
    assert.equal(
      callsWith(sb, '---META---').filter((line) => line.includes('--clear-display-agent')).length,
      0,
      'the display label stays: it is presentation only, and the row keeps its gs word',
    );
    assert.equal(callsWith(sb, '---REPORT---').length, 1, 'the reported label is never re-sent');
  });

  it('a departure releases only the authority this plugin reported', async () => {
    const sb = sandbox;
    const ordinary = { pane_id: 'wT:p2', cwd: PROJECT_CWD, foreground_cwd: PROJECT_CWD, agent: 'pi', agent_status: 'idle' };
    writePanes(sb, [launchPane(sb), ordinary]);
    writeProcFor(sb, 'wT:p1', procGs(sb));
    writeProcFor(sb, 'wT:p2', procPiOnly());
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });
    await waitFor('the reported label', () => callsWith(sb, '---REPORT---').length >= 1);

    // The pane exits: it is gone from the roster, and the explicit refresh makes
    // the daemon re-read it.
    writePanes(sb, [ordinary]);
    assert.equal(runRefresh(sb).status, 0, 'the refresh hook exits cleanly');
    await waitFor('the release on departure', () => callsWith(sb, '---RELEASE---').length >= 1);
    await wait(600);

    const releases = callsWith(sb, '---RELEASE---');
    assert.ok(releases.length >= 1, 'the departing pane is released');
    for (const line of releases) {
      assert.match(line, /wT:p1/, 'only the pane this plugin reported');
      assert.match(line, new RegExp(`--source ${GS_SOURCE}`), 'only under this plugin\'s own source');
      assert.match(line, /--agent gs/, 'only the label this plugin set');
      assert.ok(!line.includes('wT:p2'), 'a foreign pane is never released');
    }
    for (const tag of ['---REPORT---', '---META---']) {
      assert.equal(
        callsWith(sb, tag).filter((line) => line.includes('wT:p2')).length,
        0,
        `${tag} must never touch a pane without the install in its group`,
      );
    }
  });

  it('discovery runs on start, on an explicit refresh, and on roster events — never per frame', async () => {
    const sb = sandbox;
    herdrServer = await startHerdrServer(sb);
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });
    await waitFor('the daemon subscribes', () => herdrServer.state.subscriptions.size > 0);
    const conn = [...herdrServer.state.subscriptions][0];

    await waitFor('the startup scan', () => callsWith(sb, '---PANELIST---').length >= 1);
    const frames = readFrames(sb).frames;
    // Several more poll frames must add no scan at all.
    await waitWithin('more poll frames', () => readFrames(sb).frames >= frames + 2);
    assert.equal(callsWith(sb, '---PANELIST---').length, 1, 'the poll never scans per frame');

    pushEvent(conn, 'pane_created', { pane: { pane_id: 'wT:p9' } });
    await waitWithin('the roster scan', () => callsWith(sb, '---PANELIST---').length >= 2);
    pushEvent(conn, 'pane_closed', { pane_id: 'wT:p9', workspace_id: 'wT' });
    await waitWithin('the close scan', () => callsWith(sb, '---PANELIST---').length >= 3);

    assert.equal(runRefresh(sb).status, 0, 'the refresh hook exits cleanly');
    await waitWithin('the refresh scan', () => callsWith(sb, '---PANELIST---').length >= 4);

    // PRESERVE: the producer's per-beat request draws a frame and scans nothing.
    const before = readFrames(sb).frames;
    fs.writeFileSync(path.join(sb.stateDir, 'gentle-status.refresh'), String(Date.now()), 'utf8');
    await waitWithin('the frame drawn by the producer request', () => readFrames(sb).frames >= before + 1);
    await wait(600);
    assert.equal(callsWith(sb, '---PANELIST---').length, 4, 'a producer beat never triggers a discovery scan');
  });
});

// The same rules at their decision points, so a resolver boundary or a signal
// precedence is asserted directly instead of only through a daemon run.
describe('gs label decisions (S5/S6)', () => {
  const ROOT = '/home/someone/.local/share/gentle-shell/install';

  it('resolves the isolated install under the XDG data dir, and explicit overrides win', () => {
    const gs = require('../herdr-plugin/lib/gentle-gs.js');
    assert.equal(
      gs.resolveInstallRoot({ XDG_DATA_HOME: '/srv/data' }, '/home/someone', 'linux'),
      '/srv/data/gentle-shell/install',
      'XDG_DATA_HOME is honored, matching install/installation.json inside a real install',
    );
    assert.equal(
      gs.resolveInstallRoot({}, '/home/someone', 'linux'),
      ROOT,
      'with no XDG_DATA_HOME the default is ~/.local/share/gentle-shell/install',
    );
    assert.equal(gs.resolveInstallRoot({ GENTLE_SHELL_HOME: '/opt/gs' }, '/home/someone'), '/opt/gs');
    assert.equal(
      gs.resolveInstallRoot({ GENTLE_SHELL_HOME: '/opt/gs', GENTLE_SHELL_INSTALL_ROOT: '/srv/gs' }, '/home/someone'),
      '/srv/gs',
      'the plugin override wins so tests never touch a real install',
    );
    assert.equal(
      gs.resolveInstallRoot({ GENTLE_SHELL_INSTALL_ROOT: '   ' }, '/home/someone', 'linux'),
      ROOT,
      'a blank override falls through instead of resolving to the cwd',
    );
    assert.equal(gs.resolveInstallRoot({ XDG_DATA_HOME: '  ' }, '/home/someone', 'linux'), ROOT);
    assert.equal(
      gs.resolveInstallRoot({ LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\someone', 'win32'),
      path.join('C:\\Local', 'gentle-shell', 'install'),
      'win32 keeps its own data dir (unverified: this plugin ships linux-only)',
    );
  });

  it('treats the root and anything under it identically, and never a sibling', () => {
    const gs = require('../herdr-plugin/lib/gentle-gs.js');
    assert.equal(gs.isUnderRoot(ROOT, ROOT), true, 'the root itself qualifies');
    assert.equal(gs.isUnderRoot(`${ROOT}/runtime/main-sdk/bin/gentle-shell.mjs`, ROOT), true, 'a deep member qualifies');
    assert.equal(gs.isUnderRoot(`${ROOT}/prefix/lib/node_modules/gentle-pi/bin/gentle-shell.mjs`, ROOT), true);
    assert.equal(gs.isUnderRoot('/home/someone/.local/share/gentle-shell/other', ROOT), false, 'a sibling install does not');
    assert.equal(gs.isUnderRoot(`${ROOT}/../install.replaced-20261107T204840Z`, ROOT), false, 'a replaced install does not');
    assert.equal(gs.isUnderRoot(`${ROOT}-other`, ROOT), false, 'a path prefix is not a child');
    assert.equal(gs.isUnderRoot('/home/someone/project', ROOT), false, 'an ordinary project does not');
    for (const garbage of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(gs.isUnderRoot(garbage, ROOT), false, `${String(garbage)} never qualifies`);
    }
    assert.equal(gs.isUnderRoot(`${ROOT}/work`, ''), false, 'an empty root matches nothing');
  });

  it('decides by the foreground group first and falls back to cwd only when it is unreadable', () => {
    const gs = require('../herdr-plugin/lib/gentle-gs.js');
    const launch = { cwd: PROJECT_CWD, foreground_cwd: PROJECT_CWD };
    const inside = { cwd: `${ROOT}/work`, foreground_cwd: `${ROOT}/work` };

    assert.deepEqual(
      gs.qualifyPaneForGs(launch, { foreground_processes: [{ pid: 1, argv: ['node', `${ROOT}/runtime/main-sdk/bin/gentle-shell.mjs`] }] }, ROOT),
      { qualifies: true, signal: 'process' },
      'the project-cwd pane qualifies through its group',
    );
    assert.deepEqual(
      gs.qualifyPaneForGs(inside, procPiOnly(), ROOT),
      { qualifies: false, signal: 'process' },
      'a readable group with no install member wins over a cwd inside the root',
    );
    assert.deepEqual(
      gs.qualifyPaneForGs(inside, null, ROOT),
      { qualifies: true, signal: 'cwd' },
      'the cwd fallback is reachable only when the group is unreadable',
    );
    assert.deepEqual(gs.qualifyPaneForGs(launch, null, ROOT), { qualifies: false, signal: 'none' });
    assert.deepEqual(
      gs.qualifyPaneForGs(launch, { foreground_processes: [{ pid: 2, argv0: 'pi', name: 'pi' }] }, ROOT),
      { qualifies: false, signal: 'process' },
      'argv0 alone with no install path does not qualify',
    );
    // A relative script path resolves against the process cwd, never the plugin cwd.
    assert.deepEqual(
      gs.qualifyPaneForGs(launch, { foreground_processes: [{ pid: 3, argv: ['node', 'runtime/main-sdk/bin/gentle-shell.mjs'], cwd: ROOT }] }, ROOT),
      { qualifies: true, signal: 'process' },
      'a relative script path resolves against the process cwd',
    );
    assert.deepEqual(
      gs.qualifyPaneForGs(launch, { foreground_processes: [{ pid: 4, argv: ['node', 'runtime/main-sdk/bin/gentle-shell.mjs'] }] }, ROOT),
      { qualifies: false, signal: 'process' },
      'an unresolvable relative path never qualifies',
    );
    assert.deepEqual(
      gs.qualifyPaneForGs(launch, { foreground_processes: [] }, ROOT),
      { qualifies: false, signal: 'process' },
      'a readable but empty group decides against qualifying',
    );
  });

  it('never treats gs as a detection and only accepts safe identifiers', () => {
    const gs = require('../herdr-plugin/lib/gentle-gs.js');
    assert.equal(gs.GS_AGENT, 'gs');
    assert.equal(gs.isDetectedAgent('pi'), true, 'pi is a detection');
    assert.equal(gs.isDetectedAgent('gentle-shell'), true, 'gentle-shell is a detection');
    assert.equal(gs.isDetectedAgent('gs'), false, 'gs is only ever this plugin\'s label');
    for (const garbage of [null, undefined, '', 42]) {
      assert.equal(gs.isDetectedAgent(garbage), false, `${String(garbage)} is not a detection`);
    }
    assert.equal(gs.paneAgentOf({ agent: null }), null);
    assert.equal(gs.paneAgentOf({ agent: '  ' }), null);
    assert.equal(gs.paneAgentOf({ agent: 'pi' }), 'pi');
    assert.equal(gs.gsSource('herdr-gentle-shell'), GS_SOURCE, 'one stable per-session source');
    assert.equal(gs.gsSource('bad id'), GS_SOURCE, 'an unusable id falls back to the plugin default');
    for (const good of ['wT:p1', 'w1:p10', 'w9:p1']) assert.equal(gs.safePaneId(good), true, `${good} is a pane id`);
    for (const bad of ['--purge', 'wT:p1 --force', '', null, 42, '${x}']) {
      assert.equal(gs.safePaneId(bad), false, `${String(bad)} is never interpolated`);
    }
  });

  it('summarizes a foreground group deterministically', () => {
    const gs = require('../herdr-plugin/lib/gentle-gs.js');
    const sb = { installRoot: ROOT };
    const a = gs.processSignature(procGs(sb));
    assert.equal(typeof a, 'string');
    assert.equal(gs.processSignature(procGs(sb)), a, 'the same group yields the same signature');
    assert.notEqual(gs.processSignature(procGs(sb, { group: 7, pid: 7 })), a, 'a changed group is a changed signature');
    assert.equal(
      gs.processSignature({ ...procGs(sb), foreground_processes: [...procGs(sb).foreground_processes].reverse() }),
      a,
      'order never changes the signature of one group',
    );
    assert.equal(gs.processSignature(null), null, 'no process info has no signature');
    assert.equal(gs.processSignature({}), null, 'an empty payload has no signature');
    assert.equal(gs.processSignature({ foreground_processes: [{ pid: 'x' }] }), null, 'a malformed pid is ignored');
  });
});

// T3 (S6-S9): `done` holds until the pane's own snapshot says the human looked
// at it (`focused: true`, L5), then one 5 s dwell, then `idle`. The producer
// stamps the unseen cap as the token expiry; the daemon owns the recede. These
// tests drive the real `--run` daemon against the fake binary, so the observed
// surface is the metadata call it actually publishes.
function writeAgents(sb, agents) {
  fs.writeFileSync(sb.agentsFile, `${JSON.stringify({ result: { agents } })}\n`);
}

const DONE_SESSION = '/tmp/gentle-done-view-session.jsonl';

function doneAgent({ doneExpiry, workExpiry, focused = false }) {
  const entry = {
    pane_id: 'wD:p1',
    agent: 'pi',
    agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: DONE_SESSION },
    agent_status: 'idle',
    cwd: PROJECT_CWD,
    focused,
    revision: 1,
    tab_id: 'wD:t1',
    workspace_id: 'wD',
    tokens: {},
  };
  const hash = contract.expectedSessionHash(entry);
  entry.tokens.gentle_work_v1 = `${hash}:0:${workExpiry}`;
  entry.tokens.gentle_done_v1 = `${hash}:${doneExpiry}`;
  return entry;
}

// The display each published frame rendered, in order: the one state token the
// daemon carried with `--token` on that call.
function publishedDisplays(sb) {
  let text = '';
  try {
    text = fs.readFileSync(sb.metaLog, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('---META---')) continue;
    for (const [display, name] of Object.entries(contract.STATE_TOKENS)) {
      if (line.includes(`--token ${name}=${display}`)) {
        out.push(display);
        break;
      }
    }
  }
  return out;
}

describe('done until viewed (S6-S9/T3)', () => {
  it('a finish nobody viewed stays done well past the old 5 s hold', async () => {
    const sb = sandbox;
    const now = Date.now();
    writeAgents(sb, [doneAgent({ doneExpiry: now + 900000, workExpiry: now + 30000 })]);
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });

    await waitFor('the planted finish to render done', () => publishedDisplays(sb).includes('done'), 8000);
    await wait(6000);
    assert.equal(publishedDisplays(sb).includes('idle'), false, 'never focused: the row never recedes');
    assert.equal(publishedDisplays(sb).at(-1), 'done', 'the row still reads done past the old 5 s hold');
  });

  it('the first focused snapshot starts the 5 s dwell, then the row recedes to idle', async () => {
    const sb = sandbox;
    const now = Date.now();
    const doneExpiry = now + 900000;
    const workExpiry = now + 30000;
    writeAgents(sb, [doneAgent({ doneExpiry, workExpiry })]);
    startDaemon(sb, { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' });

    await waitFor('the planted finish to render done', () => publishedDisplays(sb).includes('done'), 8000);
    await wait(700);
    assert.equal(publishedDisplays(sb).includes('idle'), false, 'an unfocused finish never recedes');

    const focusedAt = Date.now();
    writeAgents(sb, [doneAgent({ doneExpiry, workExpiry, focused: true })]);
    await waitFor('the row to recede after the dwell', () => publishedDisplays(sb).includes('idle'), 10000);
    const elapsed = Date.now() - focusedAt;
    assert.ok(elapsed >= 4800, `the recede waits the 5 s dwell (saw ${elapsed}ms)`);
    assert.ok(elapsed <= 9000, `the recede is bounded by the dwell (saw ${elapsed}ms)`);
    assert.equal(publishedDisplays(sb).at(-1), 'idle', 'the row ends on idle');
  });
});

// T10 (S9/S10): the view ledger is per pane, and the row it renders is the row
// the human sees. These tests drive the real `--run` daemon with TWO owned panes
// and with the cap/live-job/reactivation edges, so a shared ledger, a focus on
// one pane receding another, a repeated focus restarting a dwell, or a display
// paired with the opposite kind of native status fails here instead of in
// manual review.
const PANE_A = 'wV:p1';
const PANE_B = 'wV:p2';
const VIEW_POLL = { GENTLE_STATUS_POLL_MS: '250', GENTLE_STATUS_FAST_POLL_MS: '250' };

// S4: a native `done` (or the native idle Herdr presents as finished) is
// terminal; every other native status is not. The display is terminal for
// `done`/`idle` only, so the two must agree at every edge.
const TERMINAL_NATIVE = new Set(['done', 'idle']);
const TERMINAL_DISPLAY = new Set(['done', 'idle']);

function assertDisplayMatchesNative(display, nativeStatus, why) {
  assert.ok(display, `a display was published for ${why}`);
  assert.equal(
    TERMINAL_DISPLAY.has(display),
    TERMINAL_NATIVE.has(nativeStatus),
    `${why}: display ${display} beside native ${nativeStatus}`,
  );
}

function viewAgent(paneId, options = {}) {
  const {
    doneExpiry,
    workExpiry = Date.now() + 30000,
    focused = false,
    status = 'idle',
    orchExpiry,
    principalExpiry,
  } = options;
  const entry = {
    pane_id: paneId,
    agent: 'pi',
    agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: DONE_SESSION },
    agent_status: status,
    cwd: PROJECT_CWD,
    focused,
    revision: 1,
    tab_id: 'wV:t1',
    workspace_id: 'wV',
    tokens: {},
  };
  const hash = contract.expectedSessionHash(entry);
  entry.tokens.gentle_work_v1 = `${hash}:0:${workExpiry}`;
  if (doneExpiry !== undefined) entry.tokens[contract.DONE_TOKEN] = `${hash}:${doneExpiry}`;
  if (orchExpiry !== undefined) entry.tokens[contract.ORCH_TOKEN] = `${hash}:${orchExpiry}`;
  if (principalExpiry !== undefined) entry.tokens[contract.PRINCIPAL_TOKEN] = `${hash}:${principalExpiry}`;
  return entry;
}

const DISPLAY_OF_STATE_TOKEN = new Map(Object.entries(contract.STATE_TOKENS).map(([display, name]) => [name, display]));

// The display each published frame rendered, per pane: one state token per
// metadata call, so a dual publish would surface as two entries.
function publishedByPane(sb) {
  const byPane = new Map();
  let text = '';
  try {
    text = fs.readFileSync(sb.metaLog, 'utf8');
  } catch {
    return byPane;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('---META---')) continue;
    const parts = line.split(' ');
    const paneId = parts[3];
    if (!paneId) continue;
    if (!byPane.has(paneId)) byPane.set(paneId, []);
    for (let at = 0; at < parts.length - 1; at += 1) {
      if (parts[at] !== '--token') continue;
      const pair = parts[at + 1];
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const display = DISPLAY_OF_STATE_TOKEN.get(pair.slice(0, eq));
      if (display) byPane.get(paneId).push(display);
    }
  }
  return byPane;
}

function displaysOf(sb, paneId) {
  return publishedByPane(sb).get(paneId) ?? [];
}

function lastDisplayOf(sb, paneId) {
  return displaysOf(sb, paneId).at(-1);
}

describe('two-pane view ledger through the daemon (S9/S10/T10)', () => {
  it('pane A recedes on its own dwell, pane B keeps done, a repeated focus is inert, and the token clear drops the entry', async () => {
    const sb = sandbox;
    const now = Date.now();
    const capExpiry = now + 900000;
    const workExpiry = now + 30000;
    const aDone = viewAgent(PANE_A, { doneExpiry: capExpiry, workExpiry });
    const bDone = viewAgent(PANE_B, { doneExpiry: capExpiry, workExpiry });
    writeAgents(sb, [aDone, bDone]);
    startDaemon(sb, VIEW_POLL);

    await waitFor(
      'both owned panes to render done',
      () => lastDisplayOf(sb, PANE_A) === 'done' && lastDisplayOf(sb, PANE_B) === 'done',
      8000,
    );
    assertDisplayMatchesNative('done', aDone.agent_status, 'the mint on pane A');
    assertDisplayMatchesNative('done', bDone.agent_status, 'the mint on pane B');

    // The first focused snapshot of A starts A's own dwell.
    const focusedAt = Date.now();
    const aFocused = viewAgent(PANE_A, { doneExpiry: capExpiry, workExpiry, focused: true });
    writeAgents(sb, [aFocused, bDone]);
    await wait(1000);
    assert.equal(lastDisplayOf(sb, PANE_A), 'done', 'the dwell keeps the row done until it elapses');
    // A repeated focus observation one second in must not restart the dwell.
    writeAgents(sb, [aFocused, bDone]);
    await waitFor('pane A to recede after one dwell', () => lastDisplayOf(sb, PANE_A) === 'idle', 12000);
    const elapsed = Date.now() - focusedAt;
    assert.ok(elapsed >= 4800, `pane A waits one 5 s dwell (saw ${elapsed}ms)`);
    assert.ok(elapsed <= 9500, `the repeated focus does not restart the dwell (saw ${elapsed}ms)`);
    assertDisplayMatchesNative('idle', aFocused.agent_status, 'the dwell boundary on pane A');

    // Pane B was never focused: its own ledger never receded.
    const bDisplays = displaysOf(sb, PANE_B);
    assert.equal(bDisplays.includes('idle'), false, 'viewing pane A never recedes pane B');
    assert.equal(bDisplays.at(-1), 'done', 'pane B stays done until its own focus or its cap');

    // A repeated focus AFTER the recede changes nothing.
    const beforeRepeat = displaysOf(sb, PANE_A).length;
    writeAgents(sb, [aFocused, bDone]);
    await wait(1200);
    assert.deepEqual(displaysOf(sb, PANE_A).slice(beforeRepeat), [], 'a later focus on a receded pane publishes nothing');

    // The token clear removes the ledger entry. The cleared beat drops the
    // finish token while the pane stays focused (a reactivation), so the row
    // leaves done without any recede; re-minting the IDENTICAL finish expiry
    // then starts a NEW dwell. A surviving receded entry would key that same
    // expiry, force idle, and publish nothing here.
    const cleared = viewAgent(PANE_A, {
      workExpiry: Date.now() + 30000,
      focused: true,
      status: 'working',
      orchExpiry: Date.now() + 30000,
    });
    writeAgents(sb, [cleared, bDone]);
    await waitFor('the token clear to leave done', () => lastDisplayOf(sb, PANE_A) === 'orchestrating', 6000);
    assertDisplayMatchesNative('orchestrating', cleared.agent_status, 'the focus-without-a-finish edge');
    const beforeReMint = displaysOf(sb, PANE_A).length;
    const reMint = viewAgent(PANE_A, { doneExpiry: capExpiry, workExpiry: Date.now() + 30000, focused: true });
    writeAgents(sb, [reMint, bDone]);
    await waitFor('the re-minted finish to start a fresh dwell', () => lastDisplayOf(sb, PANE_A) === 'done', 4000);
    assert.deepEqual(displaysOf(sb, PANE_A).slice(beforeReMint).at(-1), 'done', 'a new episode shows done again');
    assert.equal(displaysOf(sb, PANE_B).includes('idle'), false, 'pane B still never receded');
  });

  it('the pink gentle, the held done and the native status agree at the job, cap and reactivation edges (S10)', async () => {
    const sb = sandbox;
    const now = Date.now();
    const workExpiry = now + 45000;
    const mint = viewAgent(PANE_A, { doneExpiry: now + 30000, workExpiry });
    writeAgents(sb, [mint]);
    startDaemon(sb, VIEW_POLL);

    await waitFor('the mint to render done', () => lastDisplayOf(sb, PANE_A) === 'done', 8000);
    assertDisplayMatchesNative('done', mint.agent_status, 'the mint');

    // A live job holds the terminal state: the producer keeps the native status
    // non-terminal while the root marker is fresh, and the row keeps the pink
    // generic gentle instead of the held done.
    const beforeJob = displaysOf(sb, PANE_A).length;
    const markerExpiry = Date.now() + 1800;
    const jobHeld = viewAgent(PANE_A, {
      doneExpiry: now + 30000,
      workExpiry,
      status: 'working',
      orchExpiry: markerExpiry,
    });
    writeAgents(sb, [jobHeld]);
    await waitFor('the live-job row to read the pink gentle', () => lastDisplayOf(sb, PANE_A) === 'orchestrating', 6000);
    assertDisplayMatchesNative('orchestrating', jobHeld.agent_status, 'the live-job edge');
    assert.deepEqual(
      displaysOf(sb, PANE_A).slice(beforeJob),
      ['orchestrating'],
      'the live-job marker holds the pink gentle and never renders done',
    );

    // The marker clearing (the job set empty) is what makes the still-fresh
    // finish token reachable again.
    const markerCleared = viewAgent(PANE_A, { doneExpiry: now + 30000, workExpiry });
    writeAgents(sb, [markerCleared]);
    await waitFor('done to return once the job marker clears', () => lastDisplayOf(sb, PANE_A) === 'done', 8000);
    assertDisplayMatchesNative('done', markerCleared.agent_status, 'the marker-cleared edge');

    // The cap boundary: the finish token expires with no focus, so the row
    // recedes to idle on its own (the unseen cap, at daemon scale).
    const expiring = viewAgent(PANE_A, { doneExpiry: Date.now() + 1500, workExpiry: Date.now() + 30000 });
    writeAgents(sb, [expiring]);
    await waitFor('the cap to recede the row', () => lastDisplayOf(sb, PANE_A) === 'idle', 8000);
    assertDisplayMatchesNative('idle', expiring.agent_status, 'the cap boundary');

    // The reactivation edge: a new turn (fresh beat + live principal marker, the
    // producer reporting working) renders the pink generic gentle, never done
    // beside a non-terminal native status and never the amber `working`.
    const beforeReactivation = displaysOf(sb, PANE_A).length;
    const reactivationWork = Date.now() + 60000;
    const reactivated = viewAgent(PANE_A, {
      workExpiry: reactivationWork,
      status: 'working',
      principalExpiry: reactivationWork,
    });
    writeAgents(sb, [reactivated]);
    await waitFor('the reactivated row to read gentle', () => lastDisplayOf(sb, PANE_A) === 'orchestrating', 6000);
    assertDisplayMatchesNative('orchestrating', reactivated.agent_status, 'the reactivation edge');
    const reactivationTail = displaysOf(sb, PANE_A).slice(beforeReactivation);
    assert.equal(reactivationTail.includes('done'), false, 'no done beside a live principal');
    assert.equal(reactivationTail.includes('working'), false, 'a no-delegation working beat stays the pink gentle');

    // S10: one state token per published frame — no dual publishers.
    const lines = fs.readFileSync(sb.metaLog, 'utf8').split('\n').filter((line) => line.startsWith('---META---'));
    for (const line of lines) {
      let stateTokens = 0;
      const parts = line.split(' ');
      for (let at = 0; at < parts.length - 1; at += 1) {
        if (parts[at] !== '--token') continue;
        const name = parts[at + 1].slice(0, Math.max(0, parts[at + 1].indexOf('=')));
        if (DISPLAY_OF_STATE_TOKEN.has(name)) stateTokens += 1;
      }
      assert.ok(stateTokens <= 1, `one state token per frame, saw ${stateTokens}: ${line}`);
    }
  });
});
