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

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-status.js');

const FAKE_HERDR = `#!/bin/sh
# Fake herdr for event-subscription tests: logs each frame's agent snapshot as
# a start/end pair (frame overlap and count are both observable), replays canned
# JSON, and logs every report-metadata call.
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  printf -- '---AGENTS-S--- %s\\n' "$(date +%s%N)" >>"$FRAME_LOG"
  if [ -f "$AGENTS_SLEEP" ]; then sleep "$(cat "$AGENTS_SLEEP")"; fi
  cat "$AGENTS_FILE"
  printf -- '---AGENTS-E--- %s\\n' "$(date +%s%N)" >>"$FRAME_LOG"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  cat "$PANES_FILE"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "report-metadata" ]; then
  printf -- '---META--- %s\\n' "$*" >>"$META_LOG"
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
  const fake = path.join(root, 'herdr-fake.sh');
  fs.writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
  const sb = {
    root,
    stateDir,
    workDir,
    fake,
    agentsFile: path.join(root, 'agents.json'),
    panesFile: path.join(root, 'panes.json'),
    metaLog: path.join(root, 'meta.log'),
    frameLog: path.join(root, 'frames.log'),
    sleepFile: path.join(root, 'agents-sleep'),
    errFile: path.join(stateDir, 'gentle-status.err'),
    socketPath: path.join(root, 'herdr.sock'),
  };
  fs.writeFileSync(sb.agentsFile, '{"result":{"agents":[]}}\n');
  fs.writeFileSync(sb.panesFile, '{"result":{"panes":[]}}\n');
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
    GENTLE_STATUS_STATE_DIR: sb.stateDir,
    AGENTS_FILE: sb.agentsFile,
    PANES_FILE: sb.panesFile,
    META_LOG: sb.metaLog,
    FRAME_LOG: sb.frameLog,
    AGENTS_SLEEP: sb.sleepFile,
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

function pushPaneUpdated(server, conn) {
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
