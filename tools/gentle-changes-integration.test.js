'use strict';
// S62/T48 integration: the producer publishes live Git totals (not transcript
// sums) over the subscribed scope with the unchanged gentle_changes_v2
// schema, and its inline live-change helpers keep their fixed-vector
// contract (extensions/gentle-herdr-state.ts).
// Real isolated git repos + a loopback Herdr socket; no live daemon/Pi/UI.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-live-int-'));
after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live-int-${name}-`));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function sessionHashOf(file) {
  return createHash('sha256').update(file, 'utf8').digest('base64url');
}

describe('inline live-change helpers keep their fixed-vector contract', { concurrency: false }, () => {
  test('parsers and scope resolve known inputs', async () => {
    const src = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
    const srcText = fs.readFileSync(src, 'utf8');
    const stubbed = srcText.replace(
      /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
      'const generateUnifiedPatch = () => { throw new Error("stubbed"); };',
    );
    const copy = path.join(scratch, 'inline-state.mjs');
    fs.writeFileSync(copy, stubbed);
    const mod = await import(pathToFileURL(copy).href);
    for (const name of ['liveParseNumstat', 'liveParsePorcelain', 'liveSnapshotChanges', 'liveSessionChangeRoots', 'liveResolveScopeRoots', 'liveSummarizeRoots']) {
      assert.equal(typeof mod[name], 'function', `${name} must be exported live (not a stub)`);
    }
    assert.deepEqual(mod.liveParseNumstat('2\t1\ta.txt\n-\t-\timg.bin\n'), [
      { path: 'a.txt', added: 2, deleted: 1 },
      { path: 'img.bin', added: 0, deleted: 0 },
    ]);
    const porcelain = ['M  a.txt', '?? new.txt', 'R  new2.txt', 'old.txt'].join('\0') + '\0';
    assert.deepEqual([...mod.liveParsePorcelain(porcelain).entries()], [
      ['a.txt', 'modified'],
      ['new.txt', 'untracked'],
      ['new2.txt', 'renamed'],
    ]);
    const snap = { numstat: '3\t1\ta.txt\n', porcelain: ['M  a.txt', '?? new.txt'].join('\0') + '\0' };
    assert.deepEqual(mod.liveSnapshotChanges(snap), [
      { path: 'a.txt', added: 3, deleted: 1, status: 'modified' },
      { path: 'new.txt', added: 0, deleted: 0, status: 'untracked' },
    ]);
    const WT = 'gentle-pi.session-worktree/v1';
    const CE = 'gentle-pi.session-change/v1';
    const entries = [
      { type: 'custom', customType: WT, data: { sessionId: 's1', root: '/r/a' } },
      { type: 'custom', customType: CE, data: { sessionId: 's1', evidence: { id: 'e1', root: '/r/b', path: 'f', before: { kind: 'absent' }, after: { kind: 'text', text: 'x' } } } },
      { type: 'custom', customType: WT, data: { sessionId: 's2', root: '/r/other' } },
    ];
    assert.deepEqual(mod.liveSessionChangeRoots('s1', entries).sort(), ['/r/a', '/r/b']);
  });
});

describe('producer publishes live totals with unchanged schema', { concurrency: false }, () => {
  test('dirty session publishes exact hash:files:added:deleted:expiry; switch re-scopes', async () => {
    const sockPath = path.join(scratch, 'herdr.sock');
    const seen = [];
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += String(chunk);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg && msg.method === 'pane.report_metadata' && msg.params && msg.params.tokens) {
              seen.push(msg.params.tokens);
            }
          } catch { /* ignore */ }
          try { socket.write('{}\n'); } catch { /* ignore */ }
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(sockPath, resolve);
    });
    if (typeof server.unref === 'function') server.unref();

    const stateDir = path.join(scratch, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.GENTLE_STATUS_STATE_DIR = stateDir;
    process.env.HERDR_ENV = '1';
    process.env.HERDR_SOCKET_PATH = sockPath;
    process.env.HERDR_PANE_ID = 'test-pane-live';

    const src = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
    const srcText = fs.readFileSync(src, 'utf8');
    assert.ok(!/^import .* from "\.\//m.test(srcText), 'state.ts stays self-contained (no relative imports)');
    const stubbed = srcText.replace(
      /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
      'const generateUnifiedPatch = () => { throw new Error("stubbed"); };',
    );
    const copy = path.join(scratch, 'live-state.mjs');
    fs.writeFileSync(copy, stubbed);
    const mod = await import(pathToFileURL(copy).href);
    const factory = mod.default;
    assert.equal(typeof factory, 'function');

    const handlers = new Map();
    const eventHandlers = new Map();
    const pi = {
      on: (kind, fn) => {
        if (!handlers.has(kind)) handlers.set(kind, []);
        handlers.get(kind).push(fn);
      },
      events: {
        on: (kind, fn) => {
          if (!eventHandlers.has(kind)) eventHandlers.set(kind, []);
          eventHandlers.get(kind).push(fn);
        },
        emit: () => {},
      },
    };
    factory(pi);
    const fire = (kind, event, ctx) => {
      for (const fn of handlers.get(kind) ?? []) fn(event, ctx);
    };

    // Dirty principal: staged + unstaged on a.txt (2 added / 1 deleted),
    // plus a 2-line untracked file => 2 files, +4/-1.
    const principal = makeRepo('int-principal');
    fs.writeFileSync(path.join(principal, 'a.txt'), 'one\nTWO-staged\n');
    git(principal, ['add', 'a.txt']);
    fs.appendFileSync(path.join(principal, 'a.txt'), 'three-unstaged\n');
    fs.writeFileSync(path.join(principal, 'new.txt'), 'l1\nl2\n');
    const sessionFile = path.join(scratch, 'sess1.json');
    fs.writeFileSync(sessionFile, '{}');
    const sessionId = 'sess-live-1';
    const ctx = {
      mode: 'tui',
      cwd: principal,
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => true,
      hasUI: false,
    };
    fire('session_start', {}, ctx);
    fire('agent_settled', {}, ctx);

    const expectedHash = sessionHashOf(sessionFile);
    const deadline = Date.now() + 15000;
    let tokens;
    while (Date.now() < deadline) {
      const match = seen.find((t) => typeof t.gentle_changes_v2 === 'string' && t.gentle_changes_v2.startsWith(`${expectedHash}:`));
      if (match) {
        tokens = match;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(tokens, `expected a live gentle_changes_v2 beat for ${expectedHash}; saw ${JSON.stringify(seen).slice(0, 500)}`);
    const parts = tokens.gentle_changes_v2.split(':');
    assert.equal(parts.length, 5, 'schema stays hash:files:added:deleted:expiry');
    assert.equal(parts[0], expectedHash);
    assert.equal(parts[1], '2', 'two files');
    assert.equal(parts[2], '4', 'staged+unstaged counted once plus untracked lines');
    assert.equal(parts[3], '1');
    const expiry = Number(parts[4]);
    assert.ok(Number.isSafeInteger(expiry) && expiry > Date.now() && expiry <= Date.now() + 60000, 'session-bound TTL');

    // Session switch re-scopes: a clean checkout under a new session hash
    // must not retain the previous session's totals.
    const clean = makeRepo('int-clean');
    const sessionFile2 = path.join(scratch, 'sess2.json');
    fs.writeFileSync(sessionFile2, '{}');
    const sessionId2 = 'sess-live-2';
    fire('session_start', {}, {
      mode: 'tui',
      cwd: clean,
      sessionManager: { getSessionId: () => sessionId2, getSessionFile: () => sessionFile2, getEntries: () => [] },
      isIdle: () => true,
      hasUI: false,
    });
    const mark = seen.length;
    const fresh = () => seen.slice(mark);
    const deadline2 = Date.now() + 15000;
    let cleared = false;
    while (Date.now() < deadline2) {
      // A clean checkout publishes null clears (never a zero-count string).
      const done = fresh().find((t) => t.gentle_changes_v2 === null && t.gentle_changes_v1 === null);
      if (done) {
        cleared = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(cleared, 'session switch clears scope (no stale totals under the new session)');
    // Nothing after the switch may carry the previous session hash.
    for (const t of fresh()) {
      assert.ok(!(typeof t.gentle_changes_v2 === 'string' && t.gentle_changes_v2.startsWith(`${expectedHash}:`)), 'old session totals do not overwrite the new session');
    }

    try {
      await new Promise((resolve) => server.close(resolve));
    } catch { /* the after() scratch removal owns teardown */ }
  });
});
