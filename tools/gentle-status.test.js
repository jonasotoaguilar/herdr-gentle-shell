'use strict';
// The daemon's state-dir probe family must match every other consumer.
//
// `herdr-plugin/bin/gentle-status.js` both reads and WRITES the shared state
// dir (pidfile, sidebar mode, notification ledger, interruption ledger), so
// its probe family decides where those writes land. A family that omits a file
// the other consumers recognise makes the daemon create state in the
// Herdr-injected dir while the stored dir holds the real flags; once a family
// file exists in the injected dir, resolution flips there for everyone and a
// stored DISABLED toggle reads as MISSING — and missing means enabled.
//
// Fully isolated: sandbox HOME/XDG, a fake `herdr`, and a socket path that
// never exists. The host daemon is never touched.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_BIN = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-status.js');
const SIDEBAR = require('../lib/gentle-sidebar.js');

const FAKE_HERDR = `#!/bin/sh
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then printf '{"result":{"agents":[]}}\\n'; exit 0; fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then printf '{"result":{"panes":[]}}\\n'; exit 0; fi
echo "fake-herdr: unknown command $*" >&2
exit 1
`;

// Every file that proves a state dir is ours. The plugin toggles file is the
// one that used to be missing from this resolver.
const KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
  'gentle-plugin-tools.json',
];

function cmdlineNamesUs(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('gentle-status.js');
  } catch {
    return false;
  }
}

async function pollFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// One daemon lifecycle over a sandbox whose stored dir holds exactly the given
// files and whose injected dir is empty. `check` runs while the daemon is
// alive, before teardown, so every assertion sees real files.
async function daemonCycle(tag, storedFiles, check) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), `gentle-daemon-known-${tag}-`));
  const xdg = path.join(sb, 'xdg');
  const stored = path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents');
  const injected = path.join(sb, 'injected-shell');
  fs.mkdirSync(stored, { recursive: true });
  fs.mkdirSync(injected, { recursive: true });
  for (const [name, body] of Object.entries(storedFiles)) {
    fs.writeFileSync(path.join(stored, name), body);
  }
  // A seeded pidfile must look reaped-but-dead so the daemon replaces it.
  const seededPid = storedFiles['gentle-status.pid'] !== undefined;
  const fake = path.join(sb, 'herdr');
  fs.writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
  const env = { ...process.env };
  delete env.GENTLE_STATUS_STATE_DIR;
  Object.assign(env, {
    HOME: sb,
    XDG_STATE_HOME: xdg,
    HERDR_PLUGIN_STATE_DIR: injected,
    HERDR_BIN_PATH: fake,
    HERDR_SOCKET_PATH: path.join(sb, 'no-socket.sock'),
    HERDR_CONFIG_PATH: path.join(sb, 'config.toml'),
    COLUMNS: '80',
  });
  const storedPid = path.join(stored, 'gentle-status.pid');
  const injectedPid = path.join(injected, 'gentle-status.pid');
  const livePids = () => {
    const out = [];
    for (const file of [storedPid, injectedPid]) {
      try {
        const n = Number(fs.readFileSync(file, 'utf8').trim());
        if (Number.isSafeInteger(n) && n > 0 && cmdlineNamesUs(n)) out.push(n);
      } catch {
        // Absent or foreign; never kill blindly.
      }
    }
    return out;
  };
  try {
    const start = spawnSync('node', [DAEMON_BIN], { encoding: 'utf8', timeout: 15000, env });
    assert.equal(start.status, 0, `ensure failed: stdout=${start.stdout} stderr=${start.stderr}`);
    // A pidfile the fixture seeded is dead, so wait for the live daemon's own.
    const daemonPid = await pollFor(() => {
      try {
        const n = Number(fs.readFileSync(storedPid, 'utf8').trim());
        return Number.isSafeInteger(n) && n > 0 && cmdlineNamesUs(n) ? n : null;
      } catch {
        return null;
      }
    }, 10000, 'stored pidfile naming the daemon');
    assert.ok(!seededPid || daemonPid !== 2147483646, 'the dead seeded pid was replaced');
    assert.doesNotThrow(() => process.kill(daemonPid, 0), 'the daemon runs from the stored dir');
    await check({ stored, injected, storedPid, injectedPid, env: { HERDR_PLUGIN_STATE_DIR: injected, XDG_STATE_HOME: xdg } });
  } finally {
    try {
      const stop = spawnSync('node', [DAEMON_BIN, '--stop'], { encoding: 'utf8', timeout: 15000, env });
      for (const pid of livePids()) {
        try {
          process.kill(pid, 0);
        } catch {
          continue;
        }
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone; the death poll below is authoritative.
        }
      }
      await pollFor(() => (livePids().length === 0 ? true : null), 5000, 'daemon death');
      assert.ok(!fs.existsSync(storedPid) && !fs.existsSync(injectedPid), 'no pidfile remains');
      assert.equal(stop.status, 0, `stop failed: stdout=${stop.stdout} stderr=${stop.stderr}`);
    } finally {
      fs.rmSync(sb, { recursive: true, force: true });
    }
  }
}

describe('daemon state-dir probe family', () => {
  for (const name of KNOWN_FILES) {
    it(`stays in the stored dir when it holds only ${name}`, async () => {
      // The pidfile case is the file the daemon itself writes; the fixture
      // content is irrelevant, only its presence proves the family.
      // The pidfile case is the one file the daemon writes itself; seed it
      // with a dead pid so the daemon has to replace it in the same dir.
      const body = name === 'gentle-status.pid' ? '2147483646\n' : 'placeholder\n';
      await daemonCycle(name.replace(/\W+/g, '-'), { [name]: body }, (cycle) => {
        assert.ok(!fs.existsSync(cycle.injectedPid), 'no pidfile leaks into the injected dir');
      });
    });
  }

  it('a stored known file keeps the resolution on the stored dir after the pidfile write (fail-open regression)', async () => {
    await daemonCycle('known-family', { 'gentle-plugin-tools.json': '{"version":1,"odd":false,"issues":false}\n' }, (cycle) => {
      assert.equal(SIDEBAR.stateDir(cycle.env), cycle.stored, 'resolution does not flip after the pidfile write');
    });
  });
});
