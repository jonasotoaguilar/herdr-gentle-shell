'use strict';
// The pink `job` display state is GONE, and the finish it used to block is
// pinned here (odd/tasks/restore-done-idle.md, S1/S2/S3/S4).
//
// Gentle Shell publishes its running `bash_background` / `monitor` set on the
// Pi event bus:
//   pi.events.emit("gentle-ai:jobs-sidebar",
//     { sessionId, snapshot: { jobs: [{ id, label, startedAt }] } })
// The producer used to publish a job count and render a `job` row from it. That
// snapshot is unversioned, carries no liveness proof, and is not cleared on
// session reset, so ONE stale snapshot latched the row non-terminal for the life
// of the process: `done` plus the finish notification never arrived (live
// capture /tmp/done-watch3.log).
//
// The contract now: a live job is pending WORK, never a display state. A settled
// session still waiting on a job renders the pink generic `gentle` (the
// root-session marker), `done` waits until the job set clears, and the snapshot
// is trusted only while it is ours and fresh — a stale or foreign snapshot
// counts as zero jobs (fail OPEN), so it can never latch the row again. No job
// token exists in either direction.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
const srcText = fs.readFileSync(src, 'utf8');
const stubbed = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');

const JOBS_EVENT = 'gentle-ai:jobs-sidebar';
const DONE_TOKEN = 'gentle_done_v1';
const ORCHESTRATING_TOKEN = 'gentle_orchestrating_v1';
const ERROR_TOKEN = 'gentle_error_v1';
// The sidebar daemon derives the pane's binding hash from exactly the same
// agent_session path, so this is the hash both sides must agree on.
const contract = require('../herdr-plugin/lib/gentle-tokens.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-done-'));
const herdrSock = path.join(root, 'herdr.sock');
const moshiSock = path.join(root, 'moshi.sock');
const stateDir = path.join(root, 'state');
const sessionFile = path.join(root, 'sess.jsonl');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(sessionFile, '{"type":"session"}\n');
const SESSION_HASH = contract.expectedSessionHash({
  agent_session: { agent: 'pi', kind: 'path', value: sessionFile },
});
fs.writeFileSync(path.join(stateDir, 'gentle-moshi.json'), '{"enabled":true}\n');
const fakeHerdr = path.join(root, 'herdr-fake.sh');
fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = herdrSock;
process.env.HERDR_BIN_PATH = fakeHerdr;
process.env.MOSHI_SOCKET_PATH = moshiSock;
process.env.GENTLE_STATUS_STATE_DIR = stateDir;

const herdrFrames = [];
const moshiFrames = [];

function socketListener(record, { reply = false } = {}) {
  return (conn) => {
    let buffer = '';
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
        record.push(request);
        if (reply) {
          try {
            conn.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          } catch {}
        }
      }
    });
    conn.on('end', () => {
      try {
        conn.end();
      } catch {}
    });
    conn.on('error', () => {});
  };
}

const herdrServer = net.createServer(socketListener(herdrFrames, { reply: true }));
const moshiServer = net.createServer(socketListener(moshiFrames));
herdrServer.unref();
moshiServer.unref();
const listening = Promise.all([
  new Promise((resolve) => herdrServer.listen(herdrSock, resolve)),
  new Promise((resolve) => moshiServer.listen(moshiSock, resolve)),
]);

after(() => {
  try {
    herdrServer.close();
  } catch {}
  try {
    moshiServer.close();
  } catch {}
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

// Every instance gets its own pane id, so one test never reads another
// instance's frames: `paneId` is captured at module load from the env.
function paneFrames(paneId) {
  return herdrFrames.filter((frame) => frame && frame.params && frame.params.pane_id === paneId);
}

const cursor = (paneId) => paneFrames(paneId).length;

async function waitFrom(paneId, from, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = paneFrames(paneId).slice(from).find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await settle(25);
  }
}

const metadataTokensFrom = (paneId, from) =>
  paneFrames(paneId)
    .slice(from)
    .filter((f) => f && f.method === 'pane.report_metadata')
    .map((f) => f.params.tokens ?? {});

const doneValuesFrom = (paneId, from) =>
  metadataTokensFrom(paneId, from)
    .map((tokens) => tokens[DONE_TOKEN])
    .filter((value) => typeof value === 'string');

const nativeStatesFrom = (paneId, from) =>
  paneFrames(paneId)
    .slice(from)
    .filter((f) => f?.method === 'pane.report_agent')
    .map((f) => f.params.state);

const finishesFrom = (from) =>
  moshiFrames.slice(from).filter((f) => f && f.category === 'task_complete');

function harness() {
  const handlers = new Map();
  const busHandlers = new Map();
  // In-process `herdr:blocked` labels are the producer's own channel into the
  // consumer (never a Herdr notification): recording them is how a test proves
  // which label, if any, the sidebar was told to render.
  const emitted = [];
  const on = (registry) => (kind, fn) => {
    if (!registry.has(kind)) registry.set(kind, []);
    registry.get(kind).push(fn);
  };
  const pi = {
    on: on(handlers),
    events: {
      on: on(busHandlers),
      emit: (kind, payload) => {
        emitted.push({ kind, payload });
      },
    },
  };
  return {
    pi,
    emitted,
    labels: () => emitted.filter((entry) => entry.kind === 'herdr:blocked'),
    fire: (kind, event, ctx) => {
      for (const fn of handlers.get(kind) ?? []) fn(event, ctx);
    },
    fireBus: (kind, payload) => {
      for (const fn of busHandlers.get(kind) ?? []) fn(payload);
    },
  };
}

const CWD = '/tmp/gentle-proj/myproj';

function ctx({ idle = true } = {}) {
  return {
    mode: 'tui',
    cwd: CWD,
    model: { displayName: 'gpt-test' },
    getContextUsage: () => ({ percent: 40 }),
    sessionManager: {
      getSessionId: () => 'sess-1',
      getSessionFile: () => sessionFile,
      getEntries: () => [],
    },
    isIdle: () => idle,
  };
}

let runtimeSeq = 0;
async function loadRuntime() {
  runtimeSeq += 1;
  const paneId = `pane-${runtimeSeq}`;
  const previous = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = paneId;
  try {
    const copy = path.join(root, `runtime-${runtimeSeq}.mjs`);
    fs.writeFileSync(copy, stubbed);
    const module = await import(pathToFileURL(copy).href);
    return { module, paneId };
  } finally {
    if (previous === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = previous;
  }
}

const jobsSnapshot = (sessionId, jobs) => ({ sessionId, snapshot: { jobs } });
const job = (id, label = 'ci') => ({ id, label, startedAt: Date.now() });

// One turn, started and settled, leaving the caller to assert on the window
// after the settle.
async function startAndSettle(h, paneId) {
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);
  const from = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  return from;
}

test('an empty settle lands the native Working -> Idle edge the host finishes on', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);

  const from = cursor(paneId);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(400);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  const idle = await waitFrom(
    paneId,
    from,
    (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
  );
  assert.ok(
    idle,
    'a truly empty settle reports native idle, which is what fires the host Finished toast',
  );
  assert.equal(idle.params.message, undefined, 'idle carries no message');
  await settle(400);
  assert.deepEqual(
    nativeStatesFrom(paneId, from),
    ['working', 'idle'],
    'the host sees exactly one Working -> Idle transition, never a duplicate',
  );
});

// --- the reported defect: a failed tool call repainted the whole row --------
//
// "tiro error y me notificio pero paso a estado idle, ademas que se quedo
// pegado en error": a tool that failed inside a healthy turn latched
// `error:task-failed`, which cleared the role/`gentle` display, claimed native
// `blocked` (the host's NeedsAttention toast + sound) and held the finish
// back. A failed tool call now changes nothing at all.

async function workingTurn() {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(350);
  return { h, paneId };
}

// Every observable effect of one failed tool call at once: no label, no
// native state, no repaint of the role/`gentle` display, no phone envelope, no
// held finish.
const displayOf = (tokens) => ({
  work:
    typeof tokens.gentle_work_v1 === 'string'
      ? tokens.gentle_work_v1.split(':').slice(0, 2).join(':')
      : null,
  roles: tokens.gentle_roles_v1 ?? null,
  principal: tokens.gentle_principal_v1 === null ? null : 'live',
  errorKeys: Object.keys(tokens).filter((key) => /error/i.test(key)),
});

async function assertToolFailureChangesNothing(h, paneId, fireFailure) {
  const before = metadataTokensFrom(paneId, 0).at(-1);
  assert.ok(before, 'the working turn published its state before the failure');
  const framesFrom = cursor(paneId);
  const labelsFrom = h.labels().length;
  const phoneFrom = moshiFrames.length;
  fireFailure();
  await settle(450);
  assert.deepEqual(
    h.labels().slice(labelsFrom),
    [],
    'a failed tool call publishes no blocked label',
  );
  for (const tokens of metadataTokensFrom(paneId, framesFrom)) {
    assert.deepEqual(
      displayOf(tokens),
      displayOf(before),
      'a failed tool call never repaints the role/working display',
    );
  }
  assert.deepEqual(
    nativeStatesFrom(paneId, framesFrom),
    [],
    'a failed tool call publishes no native state',
  );
  assert.deepEqual(
    moshiFrames.slice(phoneFrom),
    [],
    'a failed tool call sends no phone envelope',
  );
  // The turn keeps its own edges: the settle still reaches native idle and the
  // finish still ships, which the error leg used to hold back.
  const settledFrom = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  const idle = await waitFrom(
    paneId,
    settledFrom,
    (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
  );
  assert.ok(idle, 'a settle after a failed tool call still reaches native idle');
  assert.ok(
    doneValuesFrom(paneId, settledFrom).length > 0,
    'a failed tool call never blocks the done edge',
  );
  assert.deepEqual(
    nativeStatesFrom(paneId, framesFrom).filter((state) => state === 'blocked'),
    [],
    'a tool error never claims native blocked, which is the host NeedsAttention toast',
  );
  // The durable error token is the run-error signal: a tool-level failure
  // never publishes it, so the settle beat above carries an explicit clear.
  const settledTokens = metadataTokensFrom(paneId, settledFrom);
  assert.ok(settledTokens.length > 0, 'the settle beat still publishes a full snapshot');
  for (const published of settledTokens) {
    assert.equal(
      published[ERROR_TOKEN],
      null,
      'a failed tool call never publishes the run-error token',
    );
  }
}

test('S-E1: a failed subagent launch changes nothing in the published state', async () => {
  const { h, paneId } = await workingTurn();
  await assertToolFailureChangesNothing(h, paneId, () =>
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'tool-err-1', isError: true }),
  );
});

test('S-E1: a failed TaskStore status changes nothing in the published state', async () => {
  const { h, paneId } = await workingTurn();
  await assertToolFailureChangesNothing(h, paneId, () =>
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'task-err-1',
      details: { gentleAgents: { taskId: 't-err-1', agent: 'gentle-ai-worker', status: 'failed' } },
    }),
  );
});

test('S-E1: a failed background delegate result changes nothing in the published state', async () => {
  const { h, paneId } = await workingTurn();
  await assertToolFailureChangesNothing(h, paneId, () =>
    h.fire('message_end', {
      message: {
        role: 'custom',
        customType: 'gentle-agents.result',
        details: { gentleAgents: { taskId: 'bg-err-1', agent: 'gentle-ai-worker', status: 'failed' } },
      },
    }),
  );
});

// S-E2/S-E3: the one real error state — the run itself stopped on an error
// (Pi's own `turn_end.outcome === "error"` derives from exactly this
// stopReason). It is sidebar-only: our own `error:` label, native state stays
// `working` so no NeedsAttention toast/sound fires, and no phone envelope.
test('S-E2/S-E3: a run that stops on an error shows our label only, never native blocked', async () => {
  const { h, paneId } = await workingTurn();
  const framesFrom = cursor(paneId);
  const labelsFrom = h.labels().length;
  const phoneFrom = moshiFrames.length;

  h.fire('message_end', { message: { role: 'assistant', content: [], stopReason: 'error' } });
  await settle(500);

  const raised = h.labels().slice(labelsFrom);
  assert.equal(raised.length, 1, 'a run that stops on an error raises exactly one label');
  assert.deepEqual(
    raised[0].payload,
    { active: true, label: 'error:run-failed' },
    'the error is our own sidebar label, not a native state',
  );
  assert.deepEqual(
    nativeStatesFrom(paneId, framesFrom).filter((state) => state === 'blocked'),
    [],
    'native blocked fires the host NeedsAttention toast + sound: an error never claims it',
  );
  assert.deepEqual(
    moshiFrames.slice(phoneFrom),
    [],
    'error never reaches the phone channel',
  );

  // The label survives the settle of the run that died: it is the state, not a
  // transient. The pane stays on the attention-free native `working` — and a
  // settle that would otherwise report `idle` (the host's Finished toast) sends
  // nothing at all.
  const settledFrom = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(500);
  assert.deepEqual(
    nativeStatesFrom(paneId, settledFrom),
    [],
    'while the error label stands the pane never reports idle or blocked',
  );
  assert.equal(
    nativeStatesFrom(paneId, 0).at(-1),
    'working',
    'the pane sits on native working, the only silent native state, while the error label stands',
  );
  assert.deepEqual(
    h.labels().slice(labelsFrom),
    raised,
    'no label churn on the settle of an already-failed run',
  );
});

// S-E4: the error must never latch. The first non-error beat clears it.
test('S-E4: the error label clears on the next non-error beat', async () => {
  const { h, paneId } = await workingTurn();
  h.fire('message_end', { message: { role: 'assistant', content: [], stopReason: 'error' } });
  await settle(450);
  assert.equal(
    h.labels().filter((entry) => entry.payload?.label === 'error:run-failed').length,
    1,
    'the run error is up before the recovery beat',
  );
  const settledFrom = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(450);

  const labelsFrom = h.labels().length;
  h.fire('tool_result', { toolName: 'bash', toolCallId: 'alive-1' });
  await settle(450);
  assert.deepEqual(
    h.labels().slice(labelsFrom),
    [{ kind: 'herdr:blocked', payload: { active: false } }],
    'the next non-error beat releases the error label instead of sticking',
  );
  const idle = await waitFrom(
    paneId,
    settledFrom,
    (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
  );
  assert.ok(idle, 'once the error is gone the pane returns to the lifecycle state');
});

test('S-E4: a retried run clears the error without waiting for a new turn', async () => {
  const { h } = await workingTurn();
  h.fire('message_end', { message: { role: 'assistant', content: [], stopReason: 'error' } });
  await settle(450);
  const labelsFrom = h.labels().length;
  h.fire('message_end', { message: { role: 'assistant', content: [], stopReason: 'stop' } });
  await settle(450);
  assert.deepEqual(
    h.labels().slice(labelsFrom),
    [{ kind: 'herdr:blocked', payload: { active: false } }],
    'a successful retry releases the error label',
  );
});

// S-E5: the run error is OUR OWN durable sidebar signal, not the native
// `blocked` state. `blocked` is exactly what fires the host NeedsAttention
// toast and sound, so the error rides a session-bound, TTL-fresh token that
// the consumer reduces to the `error` display word, while the pane keeps
// reporting the attention-free native `working`.

function parsedError(value, now = Date.now()) {
  return contract.parseError(value, SESSION_HASH, now);
}

async function fireRunError(h) {
  h.fire('message_end', { message: { role: 'assistant', content: [], stopReason: 'error' } });
}

const publishedErrorToken = (frame) => {
  const published = frame?.params?.tokens ?? {};
  return typeof published[ERROR_TOKEN] === 'string' ? published[ERROR_TOKEN] : undefined;
};

test('S-E5: a run error publishes its own durable token, never native blocked', async () => {
  const { h, paneId } = await workingTurn();
  const framesFrom = cursor(paneId);
  const phoneFrom = moshiFrames.length;

  await fireRunError(h);
  const beat = await waitFrom(
    paneId,
    framesFrom,
    (f) => publishedErrorToken(f) !== undefined,
  );
  assert.ok(beat, 'the run error reaches the sidebar as our own durable token');
  const value = publishedErrorToken(beat);
  assert.match(
    value,
    /^[A-Za-z0-9_-]{43}:run-failed:[1-9]\d{0,15}$/,
    'the error token mirrors the durable ask/review grammar',
  );
  assert.deepEqual(
    parsedError(value),
    { code: 'run-failed', expiry: Number(value.split(':')[2]) },
    'the token is session-bound and TTL-fresh for this pane',
  );

  await settle(300);
  assert.deepEqual(
    nativeStatesFrom(paneId, framesFrom).filter((state) => state === 'blocked'),
    [],
    'an error never claims native blocked: no NeedsAttention toast, no sound',
  );
  assert.equal(
    nativeStatesFrom(paneId, 0).at(-1),
    'working',
    'the pane stays on the only attention-free native state',
  );
  assert.deepEqual(
    moshiFrames.slice(phoneFrom),
    [],
    'an error never sends a phone envelope',
  );
});

test('S-E5: the error token is republished on every beat while the leg stands', async () => {
  const { h, paneId } = await workingTurn();
  await fireRunError(h);
  const first = await waitFrom(paneId, 0, (f) => publishedErrorToken(f) !== undefined);
  assert.ok(first, 'the error beat publishes the token');

  // The settle of the run that died is a second beat while the leg still
  // stands: a durable signal is republished there, never fired once on the
  // error edge, so a missed beat cannot strand the row.
  const from = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  const second = await waitFrom(paneId, from, (f) => publishedErrorToken(f) !== undefined);
  assert.ok(second, 'a later beat republishes the error token instead of firing it once');

  const firstExpiry = parsedError(publishedErrorToken(first)).expiry;
  const secondExpiry = parsedError(publishedErrorToken(second)).expiry;
  assert.ok(secondExpiry >= firstExpiry, 'each beat mints a fresh expiry for the live leg');
  assert.equal(
    contract.reducePane({
      agent_session: { agent: 'pi', kind: 'path', value: sessionFile },
      agent_status: 'working',
      group: 'myproj',
      state_labels: {},
      tokens: second.params.tokens,
    }).display,
    'error',
    'the republished token still reads as the error state',
  );
});

test('S-E5: the release beat clears the error token to null', async () => {
  const { h, paneId } = await workingTurn();
  await fireRunError(h);
  await waitFrom(paneId, 0, (f) => publishedErrorToken(f) !== undefined);

  const from = cursor(paneId);
  h.fire('tool_result', { toolName: 'bash', toolCallId: 'alive-1' });
  const cleared = await waitFrom(paneId, from, (f) => {
    const published = f?.params?.tokens;
    return !!published && ERROR_TOKEN in published && published[ERROR_TOKEN] === null;
  });
  assert.ok(cleared, 'the beat that releases the leg publishes the clear');

  await settle(250);
  const after = metadataTokensFrom(paneId, from);
  assert.equal(after.at(-1)[ERROR_TOKEN], null, 'the token stays cleared while the leg is down');
});

// The assertion that was missing and let this regress: the run error actually
// reaches the sidebar row, through the real producer output.
test('S-E5 end-to-end: the run error renders as `error` in the sidebar reducer', async () => {
  const { h, paneId } = await workingTurn();
  await fireRunError(h);
  const beat = await waitFrom(paneId, 0, (f) => publishedErrorToken(f) !== undefined);
  assert.ok(beat, 'the producer published the error token');

  const reduced = contract.reducePane({
    agent_session: { agent: 'pi', kind: 'path', value: sessionFile },
    agent_status: 'working',
    group: 'myproj',
    state_labels: {},
    tokens: beat.params.tokens,
  });
  assert.equal(reduced.display, 'error', 'the row shows the run error, not generic `gentle`');
  assert.equal(reduced.label, 'blocked', 'the error row word is the existing one');
  assert.equal(reduced.notify, null, 'and the error never notifies');
});

// PRESERVE: an actual human-wait intervention is still the leg that claims
// native `blocked` with its own label (the state this change kept intact).
test('PRESERVE: an ask still reports native blocked with its label', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);

  const from = cursor(paneId);
  h.fireBus('gentle-pi:ask-user-choice:blocked', { active: true });
  const blocked = await waitFrom(
    paneId,
    from,
    (f) => f?.method === 'pane.report_agent' && f.params?.state === 'blocked',
  );
  assert.ok(blocked, 'a real human-wait still reports native blocked');
  assert.match(blocked.params.message ?? '', /^ask:/, 'blocked carries the ask label');
  assert.ok(
    h.labels().some((entry) => entry.payload?.label === blocked.params.message),
    'the label on the wire is the label the sidebar was told to render',
  );
});

// S4 (odd/tasks/sidebar-terminal-state.md) narrows `restore-done-idle.md` S4
// for the NATIVE state only. The sentence it supersedes was written against the
// unversioned snapshot; that document's own S6/T5 replaced it with the
// freshness-bounded, session-owned count, and that same count now gates the
// terminal native report the way it already gated the display `done` mint.
// A stale or foreign snapshot arrives here as 0, so the terminal state stays
// fail-OPEN.
test('computeNativeState gates the terminal native report on the live job count', async () => {
  const { module } = await loadRuntime();
  const base = {
    agentActive: false,
    settled: true,
    activeCount: 0,
    pendingCount: 0,
    askActive: false,
    reviewActive: false,
    hasError: false,
  };
  assert.equal(module.computeNativeState(base), 'idle', 'true empty settle is idle');
  assert.equal(
    module.computeNativeState({ ...base, liveJobCount: 1 }),
    'working',
    'a live job is pending work: the terminal report waits on it',
  );
  assert.equal(
    module.computeNativeState({ ...base, liveJobCount: 0 }),
    'idle',
    'a stale or foreign snapshot reaches this input as zero and never blocks',
  );
  assert.equal(module.computeNativeState({ ...base, activeCount: 1 }), 'working');
});

test('a fresh job snapshot keeps the settled row on gentle and holds the finish', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));

  const from = await startAndSettle(h, paneId);
  const held = await waitFrom(
    paneId,
    from,
    (f) => typeof (f?.params?.tokens ?? {})[ORCHESTRATING_TOKEN] === 'string',
  );
  assert.ok(held, 'the root marker keeps the settled job wait on the pink generic `gentle`');
  assert.equal(held.params.tokens[DONE_TOKEN], null, 'no finish token is minted while the job waits');

  await settle(700);
  assert.deepEqual(doneValuesFrom(paneId, from), [], 'the finish never appears while the job waits');
  assert.equal(finishesFrom(moshiBefore).length, 0, 'no finish notification while the job waits');
  assert.deepEqual(
    nativeStatesFrom(paneId, 0).filter((state) => state === 'idle'),
    [],
    'the native state waits on the job too: no terminal report beside a non-terminal row',
  );
  assert.ok(
    nativeStatesFrom(paneId, 0).includes('working'),
    'the pane reports the non-terminal working state while the job waits',
  );
});

test('no job token name is ever published, not even a clear', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));
  await startAndSettle(h, paneId);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', []));
  await settle(700);

  const names = paneFrames(paneId)
    .filter((f) => f?.method === 'pane.report_metadata')
    .flatMap((f) => Object.keys(f.params.tokens ?? {}))
    .filter((name) => /job/i.test(name));
  assert.deepEqual(names, [], 'the producer writes no job-named token in either direction');
});

test('when the job set clears, done mints once and notifies once', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1'), job('job-2', 'monitor')]));

  const settledAt = await startAndSettle(h, paneId);
  await settle(400);
  assert.deepEqual(doneValuesFrom(paneId, settledAt), [], 'two waiting jobs hold the finish');

  const from = cursor(paneId);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', []));
  const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
  assert.ok(minted, 'the cleared job set releases the finish');
  assert.match(minted.params.tokens[DONE_TOKEN], /^[A-Za-z0-9_-]{43}:\d+$/, 'session-bound with an expiry');
  assert.equal(
    minted.params.tokens[ORCHESTRATING_TOKEN],
    null,
    'the same beat drops the gentle wait, so the row reads done',
  );

  await settle(700);
  assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish notification for one finish');
});

test('a stale job snapshot never blocks done again', async (t) => {
  const FIXED = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: FIXED });
  await listening;
  const { module, paneId } = await loadRuntime();
  const ttl = module.JOBS_SNAPSHOT_TTL_MS;
  assert.equal(typeof ttl, 'number');
  assert.ok(ttl >= 30000 && ttl <= 300000, `the staleness bound stays in the sane band (saw ${ttl})`);

  const h = harness();
  module.default(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));

  const settledAt = await startAndSettle(h, paneId);
  await settle(400);
  assert.deepEqual(doneValuesFrom(paneId, settledAt), [], 'a fresh snapshot holds the finish');

  // The job emits nothing between start and exit, so nothing refreshes the
  // snapshot: past its bound it stops counting and the finish is released.
  const from = cursor(paneId);
  t.mock.timers.tick(ttl + 1000);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
  assert.ok(minted, 'a stale snapshot is zero jobs, so the finish is minted');
  assert.equal(minted.params.tokens[ORCHESTRATING_TOKEN], null, 'and the stale gentle wait is cleared');
  await settle(700);
  assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish notification');
});

test('a snapshot owned by another session is ignored', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('other-session', [job('job-x')]));

  const from = await startAndSettle(h, paneId);
  const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
  assert.ok(minted, 'a foreign job set never holds this session');
});

// A finished job keeps appearing in the snapshot as a result tail; only an
// entry with no `status` is still running (upstream RunningJobDisplay).
const finishedJob = (id, status = 'exited', label = 'ci') => ({
  ...job(id, label),
  status,
  endedAt: Date.now(),
  exitCode: 0,
});

test('a finished-tail job is never pending work, whatever its terminal status', async () => {
  await listening;
  for (const status of ['exited', 'stopped', 'failed']) {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    const moshiBefore = moshiFrames.length;
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [finishedJob('job-1', status)]));

    const from = await startAndSettle(h, paneId);
    const minted = await waitFrom(
      paneId,
      from,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
    );
    assert.ok(minted, `${status}: a finished-tail entry never holds the finish`);
    assert.equal(
      minted.params.tokens[ORCHESTRATING_TOKEN],
      null,
      `${status}: the row leaves the pink generic gentle wait on the same beat`,
    );
    await settle(400);
    assert.equal(finishesFrom(moshiBefore).length, 1, `${status}: exactly one finish notification`);
  }
});

test('a live job next to a finished tail holds the row, then releases it', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  const moshiBefore = moshiFrames.length;
  // The live job carries no `status` at all (an older publisher shape): it
  // still counts as pending work.
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-live'), finishedJob('job-done')]));

  const from = await startAndSettle(h, paneId);
  const held = await waitFrom(
    paneId,
    from,
    (f) => typeof (f?.params?.tokens ?? {})[ORCHESTRATING_TOKEN] === 'string',
  );
  assert.ok(held, 'a live job keeps the row on the pink generic gentle');
  assert.equal(held.params.tokens[DONE_TOKEN], null, 'and holds the finish');
  await settle(400);
  assert.equal(finishesFrom(moshiBefore).length, 0, 'no finish while one job still runs');

  const freedFrom = cursor(paneId);
  h.fireBus(
    JOBS_EVENT,
    jobsSnapshot('sess-1', [finishedJob('job-live'), finishedJob('job-done')]),
  );
  const minted = await waitFrom(
    paneId,
    freedFrom,
    (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
  );
  assert.ok(minted, 'a snapshot of finished tails alone releases the finish');
  assert.equal(minted.params.tokens[ORCHESTRATING_TOKEN], null, 'and clears the gentle wait');
  await settle(400);
  assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish notification');
});

// --- S2/S3/S4/S5: the reported defect --------------------------------------
// "cuando terminaba subagentes pero habia job en espera seguia en status gentle
// pero como que mandaba a herdr status (done) el circulo salia como ticket, lo
// cual tiraba notificacion": the display waited on the live job while the
// native report said `idle`, which Herdr presents as finished. Both sides now
// wait on the same freshness-bounded, session-owned count, so the terminal
// state (and the host check circle + notification that ride it) happens only on
// the real finish.
test('S2/S4: a live job holds the native terminal report, then both settle once', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));

  const from = await startAndSettle(h, paneId);
  await settle(450);
  const states = nativeStatesFrom(paneId, 0);
  assert.ok(states.includes('working'), 'the pane reports the non-terminal working state');
  assert.deepEqual(
    states.filter((state) => state === 'idle'),
    [],
    'no terminal native report while the display still reads non-terminal',
  );
  for (const state of states) {
    assert.ok(
      ['working', 'blocked', 'idle'].includes(state),
      `${state} must stay in working|blocked|idle (never done/finished)`,
    );
  }
  assert.deepEqual(doneValuesFrom(paneId, from), [], 'and no done mint while the job runs');
  assert.equal(finishesFrom(moshiBefore).length, 0, 'hence no finish notification');

  // The job exits: the display and the native state reach the terminal edge
  // together, exactly once.
  const freedFrom = cursor(paneId);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [finishedJob('job-1')]));
  const idle = await waitFrom(
    paneId,
    freedFrom,
    (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
  );
  assert.ok(idle, 'the real finish releases the native terminal report');
  const minted = await waitFrom(
    paneId,
    freedFrom,
    (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
  );
  assert.ok(minted, 'and the done mint rides the same edge');
  await settle(700);
  assert.equal(
    nativeStatesFrom(paneId, freedFrom).filter((state) => state === 'idle').length,
    1,
    'the native terminal report lands exactly once',
  );
  const expiries = new Set(doneValuesFrom(paneId, freedFrom).map((token) => token.split(':')[1]));
  assert.equal(expiries.size, 1, 'one real finish, one minted hold');
  assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish notification');
});

// S4 fail-OPEN: the snapshot is an edge-emitted hint, so a stale one counts as
// zero jobs and may never keep the pane off its terminal state.
test('S4: a stale job snapshot never holds the native terminal report', async () => {
  await listening;
  const previousTtl = process.env.GENTLE_HERDR_JOBS_TTL_MS;
  process.env.GENTLE_HERDR_JOBS_TTL_MS = '2000';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    const moshiBefore = moshiFrames.length;
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));

    const from = await startAndSettle(h, paneId);
    await settle(250);
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((state) => state === 'idle'),
      [],
      'a fresh snapshot holds the terminal report across the settle edge',
    );

    // No bus event ever refreshes it: past the bound it is zero jobs, and the
    // expiry beat lands the real finish on its own.
    const releasedFrom = cursor(paneId);
    const idle = await waitFrom(
      paneId,
      releasedFrom,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
    );
    assert.ok(idle, 'a stale snapshot settles normally');
    const minted = await waitFrom(
      paneId,
      releasedFrom,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
    );
    assert.ok(minted, 'and mints done on the same beat');
    await settle(400);
    assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish notification');
  } finally {
    if (previousTtl === undefined) delete process.env.GENTLE_HERDR_JOBS_TTL_MS;
    else process.env.GENTLE_HERDR_JOBS_TTL_MS = previousTtl;
  }
});

// S4 fail-OPEN: another session's job set is zero jobs for this pane.
test('S4: a snapshot owned by another session never holds the native terminal report', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('other-session', [job('job-x')]));

  const from = await startAndSettle(h, paneId);
  const idle = await waitFrom(
    paneId,
    from,
    (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
  );
  assert.ok(idle, 'a foreign job set never holds this pane terminal state');
});

// S4/S11: a live job beside a running delegate is still one pending-work set:
// neither leg alone may release the terminal report.
test('S4: a live job beside a running delegate stays non-terminal', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);
  h.fire('tool_call', {
    toolName: 'subagent_run',
    toolCallId: 'run-d1',
    input: { agent: 'gentle-ai-worker', label: 'delegate work' },
  });
  h.fire('tool_result', {
    toolName: 'subagent_run',
    toolCallId: 'run-d1',
    details: { gentleAgents: { taskId: 'd1', agent: 'gentle-ai-worker', status: 'running' } },
  });
  await settle(300);

  const from = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(500);
  assert.deepEqual(
    nativeStatesFrom(paneId, 0).filter((state) => state === 'idle'),
    [],
    'a live job plus a running delegate never reports the terminal state',
  );
  assert.deepEqual(doneValuesFrom(paneId, from), [], 'and never mints done');

  // The delegate completes; the live job keeps holding on its own.
  h.fire('message_end', {
    message: {
      role: 'custom',
      customType: 'gentle-agents.result',
      details: { gentleAgents: { taskId: 'd1', agent: 'gentle-ai-worker', status: 'completed' } },
    },
  });
  await settle(450);
  assert.deepEqual(
    nativeStatesFrom(paneId, 0).filter((state) => state === 'idle'),
    [],
    'the live job alone still holds the terminal report',
  );
});

// --- T9/S12: the settle edge may not disagree ------------------------------
// A `subagent_run` still in flight when the principal settles, whose result
// never arrives, used to leave the native state held non-terminal for one
// finish hold while the display minted `done` on the same beat: the row read
// `done` beside a native `working`. That is a premature finish (S3) and a
// display/native disagreement (S5). The same held condition now gates the
// display `done` mint and the `orchestrating` marker, and the hold's expiry
// arms one beat so the terminal state still lands on its own.
test('S3/S4/S5: a stranded delegate cannot mint done at settle', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);
  h.fire('tool_call', {
    toolName: 'subagent_run',
    toolCallId: 'stranded',
    input: { agent: 'gentle-ai-worker' },
  });
  await settle(250);
  const from = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(500);
  assert.equal(nativeStatesFrom(paneId, 0).at(-1), 'working');
  assert.deepEqual(doneValuesFrom(paneId, from), []);
  // The same held condition gates the display marker: the row keeps the pink
  // generic wait on the settle beat instead of reading `done`.
  const held = await waitFrom(
    paneId,
    from,
    (f) => typeof (f?.params?.tokens ?? {})[ORCHESTRATING_TOKEN] === 'string',
    1000,
  );
  assert.ok(held, 'the held settle keeps the orchestrating marker');
  assert.equal(held.params.tokens[DONE_TOKEN], null, 'and never mints done on that beat');
  // Drop the hold's expiry beat with the session: this test asserts the
  // settle edge only, and a live timer would publish into a later test.
  h.fire('session_shutdown', {}, ctx());
});

// S11/T5 (odd/tasks/sidebar-terminal-state.md): the count that renders the
// `(n)` suffix is now the union of running records and in-flight launches, so
// two synchronous delegates are two pending-work entries. The S4/S12 terminal
// gate must hold exactly as before: a settle beside those two launches is
// never terminal, mints no `done`, and sends no finish envelope — while the
// sidebar row renders the user's own `explorer (2)` (the consumer's suffix
// comes from the same count).
test('S11: two in-flight launches gate the terminal state and render `explorer (2)`', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);
  h.fire('tool_call', {
    toolName: 'subagent_run',
    toolCallId: 't5-gate-1',
    input: { agent: 'gentle-ai-explore', label: 'first explore' },
  });
  h.fire('tool_call', {
    toolName: 'subagent_run',
    toolCallId: 't5-gate-2',
    input: { agent: 'gentle-ai-explore', label: 'second explore' },
  });
  await settle(250);

  // The count the row consumes: two in-flight delegates, one role word. It is
  // published on the launch beat (a settle clears the in-flight evidence on
  // its own beat, which is the decrement S11 requires).
  const beat = await waitFrom(
    paneId,
    0,
    (f) => {
      const tokens = f?.params?.tokens ?? {};
      return typeof tokens.gentle_work_v1 === 'string' && tokens.gentle_work_v1.split(':')[1] === '2';
    },
    2000,
  );
  assert.ok(beat, 'the launch beat carries the in-flight count');
  const tokens = beat.params.tokens;
  assert.equal(tokens.gentle_roles_v1, 'explorer');
  assert.equal(tokens.gentle_pending_v1.split(':')[1], 'explorer');
  assert.equal(
    contract.reducePane({
      agent_session: { agent: 'pi', kind: 'path', value: sessionFile },
      agent_status: 'working',
      group: 'myproj',
      state_labels: {},
      tokens,
    }).label,
    'explorer (2)',
    'the sidebar renders the reported `explorer (2)` row',
  );

  // S4/S12 untouched: the same two launches still gate the terminal state.
  const from = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(500);
  assert.equal(nativeStatesFrom(paneId, 0).at(-1), 'working', 'never a terminal native status');
  assert.deepEqual(doneValuesFrom(paneId, from), [], 'never a done mint');
  assert.equal(finishesFrom(moshiBefore).length, 0, 'never a finish envelope');
  // Drop the hold's expiry beat with the session: a live timer would publish
  // into a later test.
  h.fire('session_shutdown', {}, ctx());
});

// The release path the hold must not break: when the stranded launch never
// reports back, the bounded hold expires and nothing else has to happen for
// the terminal state to land. One beat at that instant carries native `idle`,
// exactly one `done` mint, and exactly one finish envelope (no double
// notification).
test('S12: the settle-time hold expiry lands native idle and exactly one done', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1200';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    const moshiBefore = moshiFrames.length;
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(250);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(300);
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'stranded-release',
      input: { agent: 'gentle-ai-worker' },
    });
    await settle(250);
    const from = cursor(paneId);
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(400);
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'no done mint inside the hold');
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((state) => state === 'idle'),
      [],
      'the native terminal state waits on the same hold',
    );

    // Nothing else fires: the hold's own expiry must land the terminal state.
    const idle = await waitFrom(
      paneId,
      from,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      4000,
    );
    assert.ok(idle, 'the hold expiry arms the beat that lands native idle');
    const minted = await waitFrom(
      paneId,
      from,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
      4000,
    );
    assert.ok(minted, 'and mints done on that same expiry beat');
    assert.equal(
      minted.params.tokens[ORCHESTRATING_TOKEN],
      null,
      'the expiry beat drops the gentle wait, so the row reads done',
    );
    await settle(500);
    assert.equal(
      nativeStatesFrom(paneId, from).filter((state) => state === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, from).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish envelope, no double notification');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// A result that finally arrives inside the hold is the other way out: the hold
// is released on that edge, so the cancelled expiry beat can never leave the
// terminal state waiting for an unrelated event. A failed launch carries no
// task record and no pending call any more (the settle cleared it), which is
// exactly the path that used to publish nothing at all.
test('S12: a launch result inside the hold releases it on its own beat', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1200';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    const moshiBefore = moshiFrames.length;
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(250);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(300);
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'stranded-late-result',
      input: { agent: 'gentle-ai-worker' },
    });
    await settle(250);
    const from = cursor(paneId);
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(300);
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'the hold blocks done before the result');

    const releaseFrom = cursor(paneId);
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'stranded-late-result',
      isError: true,
    });
    const idle = await waitFrom(
      paneId,
      releaseFrom,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      2500,
    );
    assert.ok(idle, 'the released hold still lands native idle on its own beat');
    const minted = await waitFrom(
      paneId,
      releaseFrom,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
      2500,
    );
    assert.ok(minted, 'and mints done; the cancelled expiry is not a lost finish');
    await settle(400);
    assert.equal(
      nativeStatesFrom(paneId, releaseFrom).filter((state) => state === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, releaseFrom).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish envelope');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// A settle can observe more than one launch in flight. Each result retires only
// its own evidence: the hold must stand until the LAST of them resolves, or a
// single early result would report the terminal state (and announce the finish)
// while another launch is still unresolved.
test('S3/S12: one result cannot release another pending launch', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '3000';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(200);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(200);
    for (const id of ['a', 'b']) {
      h.fire('tool_call', { toolName: 'subagent_run', toolCallId: id, input: { agent: 'gentle-ai-worker' } });
    }
    await settle(200);
    const from = cursor(paneId);
    const phoneFrom = moshiFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(300);
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'a', isError: true });
    await settle(700);
    assert.deepEqual(nativeStatesFrom(paneId, from).filter((s) => s === 'idle'), []);
    assert.deepEqual(doneValuesFrom(paneId, from), []);
    assert.equal(finishesFrom(phoneFrom).length, 0);
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// The release path with more than one launch: the last result is the finish
// edge, and it must carry exactly one native idle, one done mint, and one
// envelope (no double notification).
test('S12: the last pending result releases the hold once', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '3000';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(200);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(200);
    for (const id of ['a', 'b']) {
      h.fire('tool_call', { toolName: 'subagent_run', toolCallId: id, input: { agent: 'gentle-ai-worker' } });
    }
    await settle(200);
    const from = cursor(paneId);
    const phoneFrom = moshiFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(300);
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'a', isError: true });
    await settle(500);
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle'),
      [],
      'the first result leaves the hold standing on the second launch',
    );
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'and mints no done');
    assert.equal(finishesFrom(phoneFrom).length, 0, 'and announces no finish');

    const releaseFrom = cursor(paneId);
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'b', isError: true });
    const idle = await waitFrom(
      paneId,
      releaseFrom,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      2500,
    );
    assert.ok(idle, 'the last result lands native idle');
    const minted = await waitFrom(
      paneId,
      releaseFrom,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
      2500,
    );
    assert.ok(minted, 'and mints done on the same edge');
    await settle(400);
    assert.equal(
      nativeStatesFrom(paneId, releaseFrom).filter((s) => s === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, from).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(phoneFrom).length, 1, 'exactly one finish envelope');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// A launch that never reports back must not pin the terminal state: the hold
// stays bounded and its own expiry lands the finish, never early and never
// waiting for an unrelated event.
test('S12: an unresolved launch keeps the hold until its own expiry', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1500';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(200);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(200);
    for (const id of ['a', 'b']) {
      h.fire('tool_call', { toolName: 'subagent_run', toolCallId: id, input: { agent: 'gentle-ai-worker' } });
    }
    await settle(200);
    const from = cursor(paneId);
    const phoneFrom = moshiFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(300);
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'a', isError: true });
    await settle(500);
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle'),
      [],
      'one resolved launch never lands the terminal state early',
    );
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'and never mints done early');

    const idle = await waitFrom(
      paneId,
      from,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      4000,
    );
    assert.ok(idle, 'the bounded hold expiry still lands native idle');
    await settle(400);
    assert.equal(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, from).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(phoneFrom).length, 1, 'exactly one finish envelope');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// A redundant lifecycle settle must not wipe the retained launch evidence: the
// settle-time pending set is the only record that a launch is still in flight,
// because the first settle already cleared the metadata hint. Re-settling keeps
// the set (and the original deadline), so the release authority stays with the
// last unresolved launch or the bounded expiry.
test('S12: a duplicate settle cannot release the hold on an unresolved launch', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1200';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(200);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(200);
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'a',
      input: { agent: 'gentle-ai-worker' },
    });
    await settle(200);
    const from = cursor(paneId);
    const phoneFrom = moshiFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(300);
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(650);
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle'),
      [],
      'a redundant settle cannot land native idle while the launch is unresolved',
    );
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'and mints no done');
    assert.equal(finishesFrom(phoneFrom).length, 0, 'and announces no finish');

    const idle = await waitFrom(
      paneId,
      from,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      4000,
    );
    assert.ok(idle, 'the bounded hold expiry still lands native idle');
    await settle(400);
    assert.equal(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, from).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(phoneFrom).length, 1, 'exactly one finish envelope');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// The other release authority after a redundant settle: the unresolved launch
// itself resolving still lands the terminal state, with one mint and one
// envelope and no double notification from the duplicate settle.
test('S12: a duplicate settle keeps the last-launch release authority', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '3000';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(200);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(200);
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'a',
      input: { agent: 'gentle-ai-worker' },
    });
    await settle(200);
    const from = cursor(paneId);
    const phoneFrom = moshiFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(300);
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(100);
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'the duplicate settle mints nothing');

    const releaseFrom = cursor(paneId);
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'a', isError: true });
    const idle = await waitFrom(
      paneId,
      releaseFrom,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      2500,
    );
    assert.ok(idle, 'the last launch resolving still lands native idle');
    const minted = await waitFrom(
      paneId,
      releaseFrom,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
      2500,
    );
    assert.ok(minted, 'and mints done on that edge');
    await settle(400);
    assert.equal(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, from).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(phoneFrom).length, 1, 'exactly one finish envelope');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// Three or more consecutive settles are the same rule: none of them retires an
// unresolved launch, and the bounded expiry still lands one terminal state.
test('S12: repeated settles keep the hold on one unresolved launch', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1200';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(200);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(200);
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'a',
      input: { agent: 'gentle-ai-worker' },
    });
    await settle(200);
    const from = cursor(paneId);
    const phoneFrom = moshiFrames.length;
    for (let i = 0; i < 4; i += 1) {
      h.fire('agent_settled', {}, ctx({ idle: true }));
      await settle(200);
    }
    await settle(100);
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle'),
      [],
      'four settles never land native idle on an unresolved launch',
    );
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'and mint no done');
    assert.equal(finishesFrom(phoneFrom).length, 0, 'and announce no finish');

    const idle = await waitFrom(
      paneId,
      from,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      4000,
    );
    assert.ok(idle, 'the bounded expiry still lands the terminal state');
    await settle(400);
    assert.equal(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, from).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(phoneFrom).length, 1, 'exactly one finish envelope');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// A later settle of the same episode must ADD its in-flight launches to the
// retained set, never replace it: a launch the first settle observed is still
// unresolved even though the second settle no longer lists it, and resolving
// the newer launch alone may not retire evidence the older one still owes.
test('S12: a re-settle unions the still-unresolved launches it carries', async () => {
  await listening;
  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1200';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(200);
    h.fire('agent_start', {}, ctx({ idle: false }));
    await settle(200);
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'a',
      input: { agent: 'gentle-ai-worker' },
    });
    await settle(200);
    const from = cursor(paneId);
    const phoneFrom = moshiFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(600);
    // A second launch starts and the principal settles again: the new hold
    // carries 'a' plus 'b'.
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'b',
      input: { agent: 'gentle-ai-worker' },
    });
    h.fire('agent_settled', {}, ctx({ idle: true }));
    await settle(150);
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle'),
      [],
      'the extended hold stays non-terminal with both launches unresolved',
    );
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'and mints no done');
    assert.equal(finishesFrom(phoneFrom).length, 0, 'and announces no finish');

    // Only the newer launch resolves: 'a' is still owed, so nothing terminal
    // may land and nothing may be announced.
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'b', isError: true });
    await settle(400);
    assert.deepEqual(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle'),
      [],
      'resolving the newer launch cannot release the older unresolved one',
    );
    assert.deepEqual(doneValuesFrom(paneId, from), [], 'and still mints no done');
    assert.equal(finishesFrom(phoneFrom).length, 0, 'and still announces no finish');

    // The last owed launch resolves: the terminal state lands once.
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'a', isError: true });
    const idle = await waitFrom(
      paneId,
      from,
      (f) => f?.method === 'pane.report_agent' && f.params?.state === 'idle',
      4000,
    );
    assert.ok(idle, 'the last owed launch lands native idle');
    await settle(400);
    assert.equal(
      nativeStatesFrom(paneId, from).filter((s) => s === 'idle').length,
      1,
      'native idle lands exactly once',
    );
    const expiries = new Set(doneValuesFrom(paneId, from).map((token) => token.split(':')[1]));
    assert.equal(expiries.size, 1, 'exactly one done mint');
    assert.equal(finishesFrom(phoneFrom).length, 1, 'exactly one finish envelope');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

// The deadline rule behind the union: a first raise starts the episode, a
// re-settle that adds no launch id never extends it, a new id may extend it,
// and the whole episode never runs past the hold ceiling measured from its
// first raise.
test('S12: the settle-hold deadline extends only for new launches, within the ceiling', async () => {
  const { module } = await loadRuntime();
  assert.equal(typeof module.settleHoldUntil, 'function');
  const now = 1_000_000;
  const hold = 1200;
  assert.deepEqual(
    module.settleHoldUntil({ now, held: false, startedAt: 0, until: 0, added: false, holdMs: hold }),
    { startedAt: now, until: now + hold },
    'a first raise starts the episode at now with the overridden hold',
  );
  assert.deepEqual(
    module.settleHoldUntil({ now: now + 900, held: true, startedAt: now, until: now + hold, added: false, holdMs: hold }),
    { startedAt: now, until: now + hold },
    'a settle with no new launch id never extends the deadline',
  );
  assert.deepEqual(
    module.settleHoldUntil({ now: now + 900, held: true, startedAt: now, until: now + hold, added: true, holdMs: hold }),
    { startedAt: now, until: now + 900 + hold },
    'a new launch id may extend the deadline from now',
  );
  const late = now + module.DONE_HOLD_MAX_MS - 500;
  assert.deepEqual(
    module.settleHoldUntil({ now: late, held: true, startedAt: now, until: late + 100, added: true, holdMs: hold }),
    { startedAt: now, until: now + module.DONE_HOLD_MAX_MS },
    'the episode never extends past the hold ceiling from its first raise',
  );
  assert.equal(
    module.settleHoldUntil({ now, held: false, startedAt: 0, until: 0, added: false, holdMs: 99_999_999 }).until - now,
    module.DONE_HOLD_MAX_MS,
    'an oversized hold is clamped to the ceiling',
  );
});

test('a job whose exit snapshot never arrives still releases the finish at the TTL', async () => {
  await listening;
  const previousTtl = process.env.GENTLE_HERDR_JOBS_TTL_MS;
  process.env.GENTLE_HERDR_JOBS_TTL_MS = '1500';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    const moshiBefore = moshiFrames.length;
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));

    const from = await startAndSettle(h, paneId);
    await settle(350);
    assert.deepEqual(
      doneValuesFrom(paneId, from),
      [],
      'a fresh job holds the finish: the beat it painted reports no done token',
    );

    // No further bus event ever arrives. Only the freshness bound can release
    // the settle it is holding, and nothing else programs that beat.
    const releasedFrom = cursor(paneId);
    const minted = await waitFrom(
      paneId,
      releasedFrom,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
    );
    assert.ok(
      minted,
      'the snapshot going stale publishes a beat of its own, and that beat mints the finish',
    );
    assert.equal(
      minted.params.tokens[ORCHESTRATING_TOKEN],
      null,
      'the same beat drops the gentle wait, so the row reads done',
    );
    await settle(400);
    assert.equal(
      finishesFrom(moshiBefore).length,
      1,
      'the expiry beat is enough for the channel-on finish notification: exactly one',
    );
    assert.ok(
      nativeStatesFrom(paneId, from).includes('idle'),
      'the native Working -> Idle edge still lands on its own',
    );
  } finally {
    if (previousTtl === undefined) delete process.env.GENTLE_HERDR_JOBS_TTL_MS;
    else process.env.GENTLE_HERDR_JOBS_TTL_MS = previousTtl;
  }
});

test('the exiting snapshot mints done on the spot, never waiting for the TTL', async () => {
  await listening;
  const previousTtl = process.env.GENTLE_HERDR_JOBS_TTL_MS;
  process.env.GENTLE_HERDR_JOBS_TTL_MS = '3000';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));

    const heldFrom = await startAndSettle(h, paneId);
    await settle(350);
    assert.deepEqual(doneValuesFrom(paneId, heldFrom), [], 'the live job holds the finish');

    const from = cursor(paneId);
    const startedAt = Date.now();
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', []));
    const minted = await waitFrom(
      paneId,
      from,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
      2500,
    );
    assert.ok(minted, 'the exit snapshot releases the finish on the next beat');
    assert.ok(
      Date.now() - startedAt < 3000,
      'it lands on the band the snapshot already describes, not on the staleness bound',
    );
  } finally {
    if (previousTtl === undefined) delete process.env.GENTLE_HERDR_JOBS_TTL_MS;
    else process.env.GENTLE_HERDR_JOBS_TTL_MS = previousTtl;
  }
});

test('a new live snapshot after the expiry mints a second finish, once', async () => {
  await listening;
  const previousTtl = process.env.GENTLE_HERDR_JOBS_TTL_MS;
  process.env.GENTLE_HERDR_JOBS_TTL_MS = '1200';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));

    const from = await startAndSettle(h, paneId);
    const first = await waitFrom(
      paneId,
      from,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
    );
    assert.ok(first, 'the first expiry releases the finish');
    const firstExpiry = first.params.tokens[DONE_TOKEN].split(':')[1];
    await settle(300);
    assert.deepEqual(
      doneValuesFrom(paneId, from).map((token) => token.split(':')[1]),
      [firstExpiry],
      'the hold republishes one expiry, never a second mint',
    );

    // A new live snapshot is activity again: the row returns to `gentle` and
    // the finish it will hold is a genuinely new edge.
    const backFrom = cursor(paneId);
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-2')]));
    const back = await waitFrom(
      paneId,
      backFrom,
      (f) => typeof (f?.params?.tokens ?? {})[ORCHESTRATING_TOKEN] === 'string',
    );
    assert.ok(back, 'a new live job returns the row to the gentle wait');
    assert.equal(back.params.tokens[DONE_TOKEN], null, 'and clears the finished row');

    const secondFrom = cursor(paneId);
    const second = await waitFrom(
      paneId,
      secondFrom,
      (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string',
    );
    assert.ok(second, 'the new snapshot is its own expiry: the finish returns at its bound');
    assert.notEqual(
      second.params.tokens[DONE_TOKEN].split(':')[1],
      firstExpiry,
      'a new finish is a new hold, not the old one replayed',
    );
  } finally {
    if (previousTtl === undefined) delete process.env.GENTLE_HERDR_JOBS_TTL_MS;
    else process.env.GENTLE_HERDR_JOBS_TTL_MS = previousTtl;
  }
});

test('shutdown drops the pending expiry instead of leaving an orphan beat', async () => {
  await listening;
  const previousTtl = process.env.GENTLE_HERDR_JOBS_TTL_MS;
  process.env.GENTLE_HERDR_JOBS_TTL_MS = '800';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));
    h.fire('session_start', { reason: 'startup' }, ctx());
    await settle(250);

    const afterShutdown = cursor(paneId);
    h.fire('session_shutdown', {}, ctx());
    await settle(200);
    const quietFrom = cursor(paneId);
    await settle(1200);
    assert.equal(
      cursor(paneId),
      quietFrom,
      'the expiry timer is dropped with the session: no orphan beat after shutdown',
    );
    assert.ok(quietFrom >= afterShutdown, 'the shutdown itself published nothing extra');
  } finally {
    if (previousTtl === undefined) delete process.env.GENTLE_HERDR_JOBS_TTL_MS;
    else process.env.GENTLE_HERDR_JOBS_TTL_MS = previousTtl;
  }
});

test('the settle edge mints the finish token and notifies exactly once', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  const moshiBefore = moshiFrames.length;

  const from = await startAndSettle(h, paneId);
  const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
  assert.ok(minted, 'the settle edge publishes a finish token');
  const value = minted.params.tokens[DONE_TOKEN];
  assert.match(value, /^[A-Za-z0-9_-]{43}:\d+$/, 'the finish token is session-bound with an expiry');
  const expiry = Number(value.split(':')[1]);
  assert.ok(expiry > Date.now(), 'the finish hold is still in the future');
  assert.ok(expiry > Date.now() + 5000, 'the finish outlives the old 5 s hold');
  assert.ok(expiry <= Date.now() + 900000 + 1000, 'the hold defaults to the 15 min unseen cap');

  await settle(700);
  assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish notification for one finish');

  // A repeated settle neither re-mints (the expiry is never refreshed, so the
  // hold cannot be extended) nor re-notifies.
  const settledAgain = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(700);
  const held = doneValuesFrom(paneId, settledAgain);
  assert.ok(held.length > 0, 'the live hold keeps publishing');
  assert.ok(
    held.every((token) => Number(token.split(':')[1]) === expiry),
    'the published expiry never moves while the hold is live',
  );
  assert.equal(finishesFrom(moshiBefore).length, 1, 'a settled session never re-notifies');
});

test('the settle-time hold is overridable and its own clock never moves', async () => {
  await listening;
  const { module } = await loadRuntime();
  // The settle-edge latch (T9/S12) keeps its own 5 s clock: it is what holds
  // the terminal state for one finish after a stranded launch, and this task
  // never changes it. The finish token's expiry is the unseen cap below.
  assert.equal(typeof module.doneHoldMs, 'function');
  assert.equal(module.doneHoldMs(undefined), 5000, 'default hold is 5 s');
  assert.equal(module.doneHoldMs('1500'), 1500, 'the hold is overridable');
  assert.equal(module.doneHoldMs('nonsense'), 5000, 'an unparseable override keeps the default');
  assert.equal(module.doneHoldMs('0'), 1000, 'clamped up to the floor');
  assert.equal(module.doneHoldMs('99999999'), module.DONE_HOLD_MAX_MS, 'clamped down to the ceiling');
});

// T3/S8: the finish token's absolute expiry is the UNSEEN cap (15 min by
// default), not the settle hold, because the row must stay `done` until the
// human looks at it. The env var is clamped exactly like the jobs snapshot TTL.
test('the unseen cap is the finish token expiry, env-overridable and clamped', async () => {
  await listening;
  const { module } = await loadRuntime();
  assert.equal(typeof module.doneUnseenCapMs, 'function');
  assert.equal(module.doneUnseenCapMs(undefined), 900000, 'default unseen cap is 15 min');
  assert.equal(module.doneUnseenCapMs('1500'), 1500, 'the cap is overridable');
  assert.equal(module.doneUnseenCapMs('nonsense'), 900000, 'an unparseable override keeps the default');
  assert.equal(module.doneUnseenCapMs('0'), 100, 'clamped up to the floor');
  assert.equal(module.doneUnseenCapMs('99999999'), module.DONE_UNSEEN_CAP_MAX_MS, 'clamped down to the ceiling');
});

test('a never-viewed finish recedes at the unseen cap, not at the old 5 s hold', async () => {
  await listening;
  const previousBeat = process.env.GENTLE_HERDR_BEAT_MS;
  const previousCap = process.env.GENTLE_DONE_UNSEEN_CAP_MS;
  process.env.GENTLE_HERDR_BEAT_MS = '300';
  process.env.GENTLE_DONE_UNSEEN_CAP_MS = '1500';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    const moshiBefore = moshiFrames.length;

    const from = await startAndSettle(h, paneId);
    const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
    assert.ok(minted, 'the settle edge publishes the finish token');
    const expiry = Number(minted.params.tokens[DONE_TOKEN].split(':')[1]);
    assert.ok(expiry - Date.now() <= 1500, 'the small cap is the minted expiry');

    const mintedAt = cursor(paneId);
    await settle(1800);
    const after = paneFrames(paneId).slice(mintedAt);
    assert.equal(
      doneValuesFrom(paneId, mintedAt).every((value) => Number(value.split(':')[1]) === expiry),
      true,
      'every republish before the cap carries the one stamped expiry',
    );
    assert.ok(
      after.some((f) => (f?.params?.tokens ?? {})[DONE_TOKEN] === null),
      'the cap expiry republishes a clear instead of a stale done',
    );
    assert.equal(finishesFrom(moshiBefore).length, 1, 'the cap never re-notifies the finish');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previousBeat === undefined) delete process.env.GENTLE_HERDR_BEAT_MS;
    else process.env.GENTLE_HERDR_BEAT_MS = previousBeat;
    if (previousCap === undefined) delete process.env.GENTLE_DONE_UNSEEN_CAP_MS;
    else process.env.GENTLE_DONE_UNSEEN_CAP_MS = previousCap;
  }
});

// T3/S6/S9: a real finish holds `done` far past the old 5 s hold (the expiry is
// the unseen cap), the expiry is never refreshed, and the finish envelope is
// emitted exactly once. A second beat must never create a second notification.
test('a held finish stays done past the old 5 s hold with exactly one notification', async () => {
  await listening;
  const previousBeat = process.env.GENTLE_HERDR_BEAT_MS;
  process.env.GENTLE_HERDR_BEAT_MS = '300';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);
    const moshiBefore = moshiFrames.length;

    const from = await startAndSettle(h, paneId);
    const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
    assert.ok(minted, 'the settle edge publishes the finish token');
    const expiry = Number(minted.params.tokens[DONE_TOKEN].split(':')[1]);
    assert.ok(expiry - Date.now() > 60000, 'the minted expiry is the unseen cap, not the 5 s hold');

    await settle(6200);
    const values = doneValuesFrom(paneId, from);
    assert.ok(values.length >= 2, 'the finish token is republished while the row holds done');
    assert.ok(
      values.every((value) => Number(value.split(':')[1]) === expiry),
      'the expiry never moves: the hold is never refreshed',
    );
    assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish envelope, no second notification');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previousBeat === undefined) delete process.env.GENTLE_HERDR_BEAT_MS;
    else process.env.GENTLE_HERDR_BEAT_MS = previousBeat;
  }
});

// T3/S9: a new turn reactivates the producer, so the held finish is cleared on
// that beat instead of waiting for the cap.
test('a reactivation clears the held done immediately', async () => {
  await listening;
  const previousBeat = process.env.GENTLE_HERDR_BEAT_MS;
  process.env.GENTLE_HERDR_BEAT_MS = '300';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);

    const from = await startAndSettle(h, paneId);
    const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
    assert.ok(minted, 'the finish is held');

    const reactFrom = cursor(paneId);
    h.fire('agent_start', {}, ctx({ idle: false }));
    const cleared = await waitFrom(
      paneId,
      reactFrom,
      (f) => (f?.params?.tokens ?? {})[DONE_TOKEN] === null,
    );
    assert.ok(cleared, 'a fresh turn clears the held done at once');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previousBeat === undefined) delete process.env.GENTLE_HERDR_BEAT_MS;
    else process.env.GENTLE_HERDR_BEAT_MS = previousBeat;
  }
});

// T3/S9: done state is per session. The session reset drops the held finish,
// so the next session's first beat republishes a cleared token.
test('resetSessionState clears the held done', async () => {
  await listening;
  const previousBeat = process.env.GENTLE_HERDR_BEAT_MS;
  process.env.GENTLE_HERDR_BEAT_MS = '300';
  try {
    const { module, paneId } = await loadRuntime();
    const h = harness();
    module.default(h.pi);

    const from = await startAndSettle(h, paneId);
    const minted = await waitFrom(paneId, from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
    assert.ok(minted, 'the finish is held');

    h.fire('session_shutdown', {}, ctx());
    await settle(200);
    const resetFrom = cursor(paneId);
    h.fire('session_start', { reason: 'startup' }, ctx());
    const cleared = await waitFrom(
      paneId,
      resetFrom,
      (f) => f?.method === 'pane.report_metadata' && (f?.params?.tokens ?? {})[DONE_TOKEN] === null,
    );
    assert.ok(cleared, 'the reset session never republishes the old finish');
    h.fire('session_shutdown', {}, ctx());
  } finally {
    if (previousBeat === undefined) delete process.env.GENTLE_HERDR_BEAT_MS;
    else process.env.GENTLE_HERDR_BEAT_MS = previousBeat;
  }
});

test('a landed beat requests the daemon coalesced refresh, never a second writer', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  const refreshFile = path.join(stateDir, 'gentle-status.refresh');
  fs.rmSync(refreshFile, { force: true });

  assert.equal(fs.existsSync(refreshFile), false, 'no request exists before a beat lands');
  const from = cursor(paneId);
  h.fire('session_start', { reason: 'startup' }, ctx());
  const first = await waitFrom(paneId, from, (f) => f?.method === 'pane.report_metadata');
  assert.ok(first, 'the beat landed');
  assert.ok(fs.existsSync(refreshFile), 'a landed report requests one daemon refresh');
  const body = fs.readFileSync(refreshFile, 'utf8');
  assert.match(body, /^\d+$/, 'the request carries a timestamp only, never tokens or pane data');

  // A second beat overwrites the SAME request instead of queueing a second
  // one: N reports in one window collapse into one wake.
  const before = Number(body);
  const secondFrom = cursor(paneId);
  h.fire('agent_start', {}, ctx({ idle: false }));
  const second = await waitFrom(paneId, secondFrom, (f) => f?.method === 'pane.report_metadata');
  assert.ok(second, 'the second beat landed');
  const queued = fs.readdirSync(stateDir).filter((name) => name === 'gentle-status.refresh');
  assert.equal(queued.length, 1, 'one request file, never a second wake queue');
  assert.ok(
    Number(fs.readFileSync(refreshFile, 'utf8')) >= before,
    'the surviving request carries the newest timestamp',
  );
});

test('the producer cap ceiling and the consumer freshness ceiling agree', async () => {
  const { module } = await loadRuntime();
  assert.equal(module.DONE_UNSEEN_CAP_MAX_MS, 3600000);
  const consumer = fs.readFileSync(path.resolve(__dirname, '../herdr-plugin/lib/gentle-tokens.js'), 'utf8');
  assert.match(consumer, /FINISH_HOLD_MAX_MS = 3600000/, 'both sides pin the same ceiling');
});

test('independent S12: duplicate does not extend deadline, continue launch', async () => {
  await listening;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1200';
  const { module, paneId } = await loadRuntime();
  const h = harness(); module.default(h.pi);
  h.fire('session_start', {}, ctx()); await settle(200);
  h.fire('agent_start', {}, ctx({idle:false})); await settle(200);
  h.fire('tool_call', {toolName:'subagent_continue', toolCallId:'a', input:{task_id:'t'}}); await settle(200);
  const from = cursor(paneId), phone = moshiFrames.length, start = Date.now();
  h.fire('agent_settled', {}, ctx()); await settle(600);
  h.fire('agent_settled', {}, ctx());
  const idle = await waitFrom(paneId, from, f => f?.method === 'pane.report_agent' && f.params?.state === 'idle', 850);
  assert.ok(idle, 'original 1200ms deadline must win over duplicate at 600ms');
  assert.ok(Date.now()-start < 1700, 'deadline did not move to 1800ms');
  await settle(100);
  assert.equal(new Set(doneValuesFrom(paneId,from)).size,1);
  assert.equal(finishesFrom(phone).length,1);
  h.fire('session_shutdown', {}, ctx()); delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
});

test('independent S12: new continue extends original deadline but old run still holds', async () => {
  await listening;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1200';
  const { module, paneId } = await loadRuntime();
  const h = harness(); module.default(h.pi);
  h.fire('session_start', {}, ctx()); await settle(200);
  h.fire('agent_start', {}, ctx({idle:false})); await settle(200);
  h.fire('tool_call', {toolName:'subagent_run', toolCallId:'a', input:{agent:'gentle-ai-worker'}}); await settle(200);
  const from = cursor(paneId), phone = moshiFrames.length;
  h.fire('agent_settled', {}, ctx()); await settle(700);
  h.fire('tool_call', {toolName:'subagent_continue', toolCallId:'b', input:{task_id:'t'}});
  h.fire('agent_settled', {}, ctx());
  h.fire('tool_result', {toolName:'subagent_continue', toolCallId:'b', isError:true});
  await settle(650);
  assert.deepEqual(nativeStatesFrom(paneId,from).filter(s=>s==='idle'), []);
  assert.deepEqual(doneValuesFrom(paneId,from), []);
  assert.equal(finishesFrom(phone).length,0);
  h.fire('tool_result', {toolName:'subagent_run', toolCallId:'a', isError:true});
  const idle = await waitFrom(paneId,from,f=>f?.method==='pane.report_agent' && f.params?.state==='idle', 1000);
  assert.ok(idle); await settle(150);
  assert.equal(nativeStatesFrom(paneId,from).filter(s=>s==='idle').length,1);
  assert.equal(new Set(doneValuesFrom(paneId,from)).size,1);
  assert.equal(finishesFrom(phone).length,1);
  h.fire('session_shutdown', {}, ctx()); delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
});

test('live job and two settled launches retain independent gates', async () => {
  await listening;
  const { module, paneId } = await loadRuntime();
  const h = harness();
  module.default(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(200);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(200);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('independent')]));
  for (const id of ['x', 'y']) {
    h.fire('tool_call', { toolName: 'subagent_run', toolCallId: id, input: { agent: 'gentle-ai-explore' } });
  }
  await settle(200);
  const from = cursor(paneId);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(200);
  h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'x', isError: true });
  await settle(400);
  assert.deepEqual(nativeStatesFrom(paneId, from).filter(s => s === 'idle'), []);
  assert.deepEqual(doneValuesFrom(paneId, from), []);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', []));
  await settle(400);
  assert.deepEqual(nativeStatesFrom(paneId, from).filter(s => s === 'idle'), []);
  assert.deepEqual(doneValuesFrom(paneId, from), []);
  h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'y', isError: true });
  assert.ok(await waitFrom(paneId, from, f => f?.method === 'pane.report_agent' && f.params?.state === 'idle', 2500));
  assert.ok(await waitFrom(paneId, from, f => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string', 2500));
  h.fire('session_shutdown', {}, ctx());
});
