'use strict';
// Tests for lib/pi-perf-settings.js: the atomic, fail-closed merge writer the
// customize panel uses to flip pi's four performance switches.
//
// Contract under test (observable behavior only — the bytes on disk, the mode,
// the temp files that are or are not left behind, and the returned verdict;
// never internal helper names):
// - one entry point merges boolean keys into `<agent-dir>/settings.json` and
//   disturbs nothing else in the file;
// - a write that would change nothing reports changed:false and leaves the
//   file byte-identical;
// - a malformed, non-object, unreadable or symlink-dangling target is never
//   overwritten: the verdict says so and the file is untouched;
// - only the four known keys with boolean values are accepted;
// - writes are atomic: a unique temp file in the target directory, the
//   previous mode preserved, no temp file left behind on success or failure;
// - a symlinked settings.json keeps being a symlink and its target is updated.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const perf = require('../lib/pi-perf-settings.js');

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-perf-settings-'));
  roots.push(dir);
  return dir;
}

function agentEnv() {
  const dir = scratch();
  return { GENTLE_PI_AGENT_HOME: undefined, PI_CODING_AGENT_DIR: path.join(dir, 'agent') };
}

function withEnv(env, run) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
}

function settingsFile(env) {
  return perf.settingsPath(env);
}

function readBytes(env) {
  return fs.readFileSync(settingsFile(env), 'utf8');
}

function tempLeftovers(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  } catch {
    return [];
  }
}

describe('pi perf settings writer', { concurrency: false }, () => {
  test('exposes exactly the four performance keys', () => {
    assert.deepEqual(
      [...perf.PERF_KEYS],
      ['heightIndex', 'evictOffscreenLines', 'expandRecentToolOutput', 'incrementalSearchCorpus'],
    );
  });

  test('creates settings.json with only the merged key, 2-space JSON and a private mode', () => {
    const env = agentEnv();
    withEnv(env, () => {
      const result = perf.writeSettings({ expandRecentToolOutput: true }, process.env);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.changed, true);
      assert.equal(readBytes(env), `${JSON.stringify({ expandRecentToolOutput: true }, null, 2)}\n`);
      assert.equal(fs.statSync(settingsFile(env)).mode & 0o777, 0o600, 'a fresh file is created 0600');
      assert.deepEqual(tempLeftovers(path.dirname(settingsFile(env))), [], 'no temp file is left behind');
    });
  });

  test('merges into an existing file and keeps every unrelated key', () => {
    const env = agentEnv();
    withEnv(env, () => {
      fs.mkdirSync(path.dirname(settingsFile(env)), { recursive: true });
      const before = {
        theme: 'gentle',
        compaction: { enabled: true, keepRecentTokens: 4000 },
        extensions: ['-extensions/moshi-hooks.ts'],
        incrementalSearchCorpus: false,
      };
      fs.writeFileSync(settingsFile(env), `${JSON.stringify(before, null, 2)}\n`);
      const result = perf.writeSettings({ heightIndex: true, evictOffscreenLines: true }, process.env);
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(JSON.parse(readBytes(env)), { ...before, heightIndex: true, evictOffscreenLines: true });
    });
  });

  test('an already-matching value reports changed:false and leaves the file byte-identical', () => {
    const env = agentEnv();
    withEnv(env, () => {
      fs.mkdirSync(path.dirname(settingsFile(env)), { recursive: true });
      const original = '{\n    "expandRecentToolOutput": true\n}\n';
      fs.writeFileSync(settingsFile(env), original);
      const result = perf.writeSettings({ expandRecentToolOutput: true }, process.env);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.changed, false, 'a no-op must not claim a change');
      assert.equal(readBytes(env), original, 'a no-op rewrites nothing');
    });
  });

  test('malformed JSON is refused and the file stays byte-identical', () => {
    const env = agentEnv();
    withEnv(env, () => {
      fs.mkdirSync(path.dirname(settingsFile(env)), { recursive: true });
      const broken = '{ "heightIndex": tru';
      fs.writeFileSync(settingsFile(env), broken);
      const result = perf.writeSettings({ heightIndex: true }, process.env);
      assert.equal(result.ok, false);
      assert.match(result.error, /invalid JSON/);
      assert.equal(readBytes(env), broken);
      assert.deepEqual(tempLeftovers(path.dirname(settingsFile(env))), []);
    });
  });

  test('a non-object document is refused and left untouched', () => {
    const env = agentEnv();
    withEnv(env, () => {
      fs.mkdirSync(path.dirname(settingsFile(env)), { recursive: true });
      fs.writeFileSync(settingsFile(env), '[]\n');
      const result = perf.writeSettings({ heightIndex: true }, process.env);
      assert.equal(result.ok, false);
      assert.match(result.error, /top-level JSON must be an object/);
      assert.equal(readBytes(env), '[]\n');
    });
  });

  test('an unreadable target is refused instead of replaced', () => {
    const env = agentEnv();
    withEnv(env, () => {
      fs.mkdirSync(settingsFile(env), { recursive: true });
      const result = perf.writeSettings({ heightIndex: true }, process.env);
      assert.equal(result.ok, false, 'a directory is not a settings file');
      assert.ok(fs.statSync(settingsFile(env)).isDirectory(), 'the target is still a directory');
    });
  });

  test('unknown keys and non-boolean values are rejected before any write', () => {
    const env = agentEnv();
    withEnv(env, () => {
      const unknown = perf.writeSettings({ collapseOldToolOutput: true }, process.env);
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /collapseOldToolOutput/, 'the rejected key is named');
      assert.equal(fs.existsSync(settingsFile(env)), false, 'nothing is created for a rejected key');
      const wrongType = perf.writeSettings({ heightIndex: 'true' }, process.env);
      assert.equal(wrongType.ok, false);
      assert.match(wrongType.error, /boolean/);
      assert.equal(fs.existsSync(settingsFile(env)), false);
      const empty = perf.writeSettings({}, process.env);
      assert.equal(empty.ok, false);
      assert.match(empty.error, /at least one/);
    });
  });

  test('a symlinked settings.json keeps its link and its target is updated', () => {
    const env = agentEnv();
    withEnv(env, () => {
      const dir = path.dirname(settingsFile(env));
      fs.mkdirSync(dir, { recursive: true });
      const real = path.join(dir, 'settings-real.json');
      fs.writeFileSync(real, `${JSON.stringify({ theme: 'gentle' }, null, 2)}\n`);
      fs.symlinkSync(real, settingsFile(env));
      const result = perf.writeSettings({ incrementalSearchCorpus: true }, process.env);
      assert.equal(result.ok, true, result.error);
      assert.ok(fs.lstatSync(settingsFile(env)).isSymbolicLink(), 'the link is preserved');
      assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { theme: 'gentle', incrementalSearchCorpus: true });
    });
  });

  test('a dangling symlink is refused', () => {
    const env = agentEnv();
    withEnv(env, () => {
      const dir = path.dirname(settingsFile(env));
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(dir, 'nowhere.json'), settingsFile(env));
      const result = perf.writeSettings({ heightIndex: true }, process.env);
      assert.equal(result.ok, false);
      assert.match(result.error, /dangling symlink/);
      assert.ok(fs.lstatSync(settingsFile(env)).isSymbolicLink());
    });
  });

  test('readValues reports a missing file as all-default and an existing one as its values', () => {
    const env = agentEnv();
    withEnv(env, () => {
      const missing = perf.readValues(perf.PERF_KEYS, process.env);
      assert.equal(missing.ok, true);
      assert.deepEqual(missing.values, {
        heightIndex: undefined,
        evictOffscreenLines: undefined,
        expandRecentToolOutput: undefined,
        incrementalSearchCorpus: undefined,
      });
      fs.mkdirSync(path.dirname(settingsFile(env)), { recursive: true });
      fs.writeFileSync(settingsFile(env), `${JSON.stringify({ heightIndex: true, theme: 'x' }, null, 2)}\n`);
      const present = perf.readValues(perf.PERF_KEYS, process.env);
      assert.equal(present.ok, true);
      assert.equal(present.values.heightIndex, true);
      assert.equal(present.values.expandRecentToolOutput, undefined, 'an absent key stays absent');
    });
  });

  test('readValues reports a malformed file instead of pretending it is empty', () => {
    const env = agentEnv();
    withEnv(env, () => {
      fs.mkdirSync(path.dirname(settingsFile(env)), { recursive: true });
      fs.writeFileSync(settingsFile(env), 'not json');
      const read = perf.readValues(perf.PERF_KEYS, process.env);
      assert.equal(read.ok, false);
      assert.match(read.error, /invalid JSON/);
    });
  });
});
