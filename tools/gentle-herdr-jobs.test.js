'use strict';
// A live background job keeps the session non-terminal (DESIGN §7, S9 in
// odd/tasks/moshi-full-replacement.md).
//
// Gentle Shell runs `bash_background` / `monitor` jobs per session and
// publishes the running set on the Pi event bus:
//   pi.events.emit("gentle-ai:jobs-sidebar",
//     { sessionId, snapshot: { jobs: [{ id, label, startedAt }] } })
// While that set is non-empty the principal may settle — but it has NOT
// finished: the native state must stay `working`, the orchestrating marker
// must keep publishing (sidebar keeps showing `gentle`), the terminal
// `done`/`idle` must not be reached, and the Moshi finish notification must
// not fire. Only when the last job is gone does the working→idle edge happen.

const { test } = require('node:test');
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-jobs-'));
const herdrSock = path.join(root, 'herdr.sock');
const moshiSock = path.join(root, 'moshi.sock');
const stateDir = path.join(root, 'state');
const sessionFile = path.join(root, 'sess.jsonl');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(sessionFile, '{"type":"session"}\n');
fs.writeFileSync(path.join(stateDir, 'gentle-moshi.json'), '{"enabled":true}\n');
const fakeHerdr = path.join(root, 'herdr-fake.sh');
fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = herdrSock;
process.env.HERDR_PANE_ID = 'pane-1';
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

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = herdrFrames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await settle(25);
  }
}

const nativeStates = () => herdrFrames.filter((f) => f?.method === 'pane.report_agent').map((f) => f.params.state);
const moshiOf = (kind) => moshiFrames.filter((f) => f && f.category === kind);

function harness() {
  const handlers = new Map();
  const busHandlers = new Map();
  const on = (registry) => (kind, fn) => {
    if (!registry.has(kind)) registry.set(kind, []);
    registry.get(kind).push(fn);
  };
  const pi = {
    on: on(handlers),
    events: { on: on(busHandlers), emit: () => {} },
  };
  return {
    pi,
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
  const copy = path.join(root, `runtime-${runtimeSeq}.mjs`);
  fs.writeFileSync(copy, stubbed);
  const module = await import(pathToFileURL(copy).href);
  return module;
}

const jobsSnapshot = (sessionId, jobs) => ({ sessionId, snapshot: { jobs } });
const job = (id, label = 'ci') => ({ id, label, startedAt: Date.now() });

// Principal settles while the given job set is live; returns the runtime
// handles so a test can then clear the set.
async function settleWithJobs(h) {
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(500);
}

test('computeNativeState treats a live job as working, never idle', async () => {
  const mod = await loadRuntime();
  const base = {
    agentActive: false,
    settled: true,
    activeCount: 0,
    pendingCount: 0,
    askActive: false,
    reviewActive: false,
    hasError: false,
  };
  assert.equal(mod.computeNativeState(base), 'idle', 'true empty settle is idle');
  assert.equal(mod.computeNativeState({ ...base, jobCount: 1 }), 'working', 'a live job keeps it working');
  assert.equal(mod.computeNativeState({ ...base, jobCount: 2, activeCount: 1 }), 'working');
});

test('a running job keeps the native state working and the marker alive', async () => {
  await listening;
  const before = herdrFrames.length;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));
  await settleWithJobs(h);

  const frames = herdrFrames.slice(before);
  assert.ok(frames.length > 0, 'the extension must keep publishing');
  assert.ok(
    !nativeStates().slice(-1).includes('idle'),
    `no terminal idle while a job runs (saw ${JSON.stringify(nativeStates())})`,
  );
  assert.equal(nativeStates().at(-1), 'working', 'the last native state stays working');

  const marker = frames
    .filter((f) => f.method === 'pane.report_metadata')
    .flatMap((f) => Object.entries(f.params.tokens ?? {}))
    .filter(([name]) => name === 'gentle_orchestrating_v1')
    .map(([, value]) => value);
  assert.ok(
    marker.some((value) => typeof value === 'string' && value.length > 0),
    'the orchestrating marker keeps publishing (sidebar keeps showing gentle)',
  );
  assert.equal(moshiOf('task_complete').length, 0, 'no finish notification while a job runs');
});

test('the finish waits for the last job to end', async () => {
  await listening;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1'), job('job-2', 'monitor')]));
  await settleWithJobs(h);
  assert.equal(moshiOf('task_complete').length, 0, 'still nothing while jobs run');

  // One job left: still not finished.
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-2', 'monitor')]));
  await settle(400);
  assert.equal(moshiOf('task_complete').length, 0, 'one job left is still working');

  // All clear: the working→idle edge fires once.
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', []));
  const idle = await waitFor((f) => f.method === 'pane.report_agent' && f.params.state === 'idle');
  assert.ok(idle, 'the terminal idle arrives once the last job ends');
  await waitFor(() => moshiOf('task_complete').length === 1);
  assert.equal(moshiOf('task_complete').length, 1, 'exactly one finish notification');
});

test('jobs owned by another session never block this one', async () => {
  await listening;
  const before = herdrFrames.length;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('other-session', [job('job-x')]));
  await settleWithJobs(h);
  const states = herdrFrames.slice(before).filter((f) => f.method === 'pane.report_agent').map((f) => f.params.state);
  assert.ok(states.includes('idle'), `another session's job must not block this one (saw ${JSON.stringify(states)})`);
});

// S2/S3 (D2): the host never reports `done`, so the producer mints the finish
// itself — one session-bound `gentle_done_v1` token at the settled-and-empty
// edge, carrying the hold expiry. The sidebar reads `done` while it is fresh
// and recedes to `idle` after it, and the finish notification hangs off that
// same edge (never off a raw working->idle transition with work still left).
const DONE_TOKEN = 'gentle_done_v1';

async function waitFrom(from, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = herdrFrames.slice(from).find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await settle(25);
  }
}

const metadataTokensFrom = (from) =>
  herdrFrames
    .slice(from)
    .filter((f) => f && f.method === 'pane.report_metadata')
    .map((f) => f.params.tokens ?? {});

const doneValuesFrom = (from) =>
  metadataTokensFrom(from)
    .map((tokens) => tokens[DONE_TOKEN])
    .filter((value) => typeof value === 'string');

const finishesFrom = (from) =>
  moshiFrames.slice(from).filter((f) => f && f.category === 'task_complete');

test('the settle edge mints the finish token and notifies exactly once', async () => {
  await listening;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);

  const from = herdrFrames.length;
  h.fire('agent_settled', {}, ctx({ idle: true }));
  const minted = await waitFrom(from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
  assert.ok(minted, 'the settle edge publishes a finish token');
  const value = minted.params.tokens[DONE_TOKEN];
  assert.match(value, /^[A-Za-z0-9_-]{43}:\d+$/, 'the finish token is session-bound with an expiry');
  const expiry = Number(value.split(':')[1]);
  assert.ok(expiry > Date.now(), 'the finish hold is still in the future');
  assert.ok(expiry <= Date.now() + 60000 + 1000, 'the hold defaults to 60 s');

  await settle(600);
  assert.equal(finishesFrom(moshiBefore).length, 1, 'exactly one finish notification for one finish');

  // A repeated settle neither re-mints (the expiry is never refreshed, so the
  // hold cannot be extended) nor re-notifies.
  const settledAgain = herdrFrames.length;
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(600);
  const held = doneValuesFrom(settledAgain);
  assert.ok(held.length > 0, 'the live hold keeps publishing');
  assert.ok(
    held.every((token) => Number(token.split(':')[1]) === expiry),
    'the published expiry never moves while the hold is live',
  );
  assert.equal(finishesFrom(moshiBefore).length, 1, 'a settled session never re-notifies');
});

test('the finish hold is overridable and its expiry clears the token', async () => {
  await listening;
  const mod = await loadRuntime();
  assert.equal(typeof mod.doneHoldMs, 'function');
  assert.equal(mod.doneHoldMs(undefined), 60000, 'default hold is 60 s');
  assert.equal(mod.doneHoldMs('1500'), 1500, 'the hold is overridable');
  assert.equal(mod.doneHoldMs('nonsense'), 60000, 'an unparseable override keeps the default');
  assert.equal(mod.doneHoldMs('0'), 1000, 'clamped up to the floor');
  assert.equal(mod.doneHoldMs('99999999'), mod.DONE_HOLD_MAX_MS, 'clamped down to the ceiling');

  const { default: factory } = mod;
  const h = harness();
  factory(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);

  const previous = process.env.GENTLE_HERDR_DONE_HOLD_MS;
  process.env.GENTLE_HERDR_DONE_HOLD_MS = '1500';
  try {
    const from = herdrFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    const minted = await waitFrom(from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
    assert.ok(minted, 'the settle edge publishes a finish token');
    const expiry = Number(minted.params.tokens[DONE_TOKEN].split(':')[1]);
    assert.ok(expiry - Date.now() <= 1500, 'the override shortens the hold');

    await settle(1800);
    const clearedFrom = herdrFrames.length;
    h.fire('agent_settled', {}, ctx({ idle: true }));
    const cleared = await waitFrom(
      clearedFrom,
      (f) => (f?.params?.tokens ?? {})[DONE_TOKEN] === null,
    );
    assert.ok(cleared, 'an expired hold republishes a clear instead of a stale done');
    assert.equal(
      doneValuesFrom(clearedFrom).length,
      0,
      'no live finish token is republished after the hold',
    );
    assert.equal(finishesFrom(moshiBefore).length, 1, 'an expired hold never re-notifies');
  } finally {
    if (previous === undefined) delete process.env.GENTLE_HERDR_DONE_HOLD_MS;
    else process.env.GENTLE_HERDR_DONE_HOLD_MS = previous;
  }
});

test('no finish token is minted while a background job is still pending', async () => {
  await listening;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  const moshiBefore = moshiFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-p1')]));
  const from = herdrFrames.length;
  await settleWithJobs(h);
  await settle(400);
  assert.deepEqual(doneValuesFrom(from), [], 'a pending job blocks the finish signal');
  assert.ok(
    metadataTokensFrom(from).length > 0,
    'the producer keeps beating while the job waits',
  );
  assert.equal(finishesFrom(moshiBefore).length, 0, 'no finish notification while work is left');
});

const JOBS_TOKEN = 'gentle_jobs_v1';

const jobCountsFrom = (from) =>
  metadataTokensFrom(from)
    .map((tokens) => tokens[JOBS_TOKEN])
    .filter((value) => typeof value === 'string');

// S5/D4: the pink `job` state. The producer publishes the pending count only
// while the session waits on those jobs — principal settled, no delegate
// running, no launch pending — and clears it on the beat the principal resumes
// or a delegate starts, so the row can never linger on `job`. The last job
// ending continues the normal sequence (done, then idle) and notifies then.
test('a settled principal waiting on a job publishes the pending count', async () => {
  await listening;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  const from = herdrFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-a'), job('job-b', 'monitor')]));
  await settleWithJobs(h);

  const waiting = await waitFrom(from, (f) => typeof (f?.params?.tokens ?? {})[JOBS_TOKEN] === 'string');
  assert.ok(waiting, 'the job wait publishes its pending count');
  const [hash, rawCount, rawExpiry] = waiting.params.tokens[JOBS_TOKEN].split(':');
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/, 'the count is session-bound');
  assert.equal(Number(rawCount), 2, 'both pending jobs are counted');
  assert.ok(Number(rawExpiry) > Date.now(), 'the count carries a TTL expiry');
  assert.deepEqual(doneValuesFrom(from), [], 'a pending job is never a finish');
});

test('the job count clears the moment the principal resumes or a delegate starts', async () => {
  await listening;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  const from = herdrFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-c')]));
  await settleWithJobs(h);
  assert.ok(
    await waitFrom(from, (f) => typeof (f?.params?.tokens ?? {})[JOBS_TOKEN] === 'string'),
    'waiting on the job shows the count',
  );

  const resumed = herdrFrames.length;
  h.fire('agent_start', {}, ctx({ idle: false }));
  const cleared = await waitFrom(resumed, (f) => (f?.params?.tokens ?? {})[JOBS_TOKEN] === null);
  assert.ok(cleared, 'the principal resuming clears the job count on that beat');

  const settling = herdrFrames.length;
  h.fire('agent_settled', {}, ctx({ idle: true }));
  const waitingAgain = await waitFrom(settling, (f) => typeof (f?.params?.tokens ?? {})[JOBS_TOKEN] === 'string');
  assert.ok(waitingAgain, 'settling again with the job still live restores the count');

  const launched = herdrFrames.length;
  h.fire('tool_call', { toolName: 'subagent_run', toolCallId: 'tc-job-1', input: { agent: 'worker', label: 'job work' } });
  const launchBeat = await waitFrom(launched, (f) => {
    const tokens = f?.params?.tokens ?? {};
    return tokens[JOBS_TOKEN] === null && typeof tokens.gentle_roles_v1 === 'string';
  });
  assert.ok(launchBeat, 'a delegate launch clears the job count on that beat');
});

test('the last job ending continues to done and notifies then', async () => {
  await listening;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  const moshiBefore = moshiFrames.length;
  const from = herdrFrames.length;
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-d')]));
  await settleWithJobs(h);
  assert.ok(
    await waitFrom(from, (f) => typeof (f?.params?.tokens ?? {})[JOBS_TOKEN] === 'string'),
    'the job wait shows the count',
  );
  assert.deepEqual(doneValuesFrom(from), [], 'no finish token while the job waits');
  assert.equal(finishesFrom(moshiBefore).length, 0, 'no finish notification while the job waits');

  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', []));
  const finished = await waitFrom(from, (f) => typeof (f?.params?.tokens ?? {})[DONE_TOKEN] === 'string');
  assert.ok(finished, 'the last job ending mints the finish token');
  assert.equal(finished.params.tokens[JOBS_TOKEN], null, 'the job count clears on the finish beat');
  await settle(600);
  assert.equal(finishesFrom(moshiBefore).length, 1, 'the finish notification fires when the job ends');
});

test('the producer hold ceiling and the consumer freshness ceiling agree', async () => {
  const mod = await loadRuntime();
  const contract = require('../herdr-plugin/lib/gentle-tokens.js');
  assert.equal(
    contract.FINISH_HOLD_MAX_MS,
    mod.DONE_HOLD_MAX_MS,
    'an overridden hold must stay readable as done',
  );
  assert.equal(mod.doneHoldMs('999999999'), mod.DONE_HOLD_MAX_MS, 'the producer clamps to the same ceiling');
  const hash = 'a'.repeat(43);
  const expiry = Date.now() + mod.DONE_HOLD_MAX_MS;
  assert.deepEqual(contract.parseDone(`${hash}:${expiry}`, hash, Date.now()), { expiry });
});
