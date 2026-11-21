'use strict';
// The in-process Herdr theme writer (theme-sync-fix T2 over S3/S4, risk 1).
//
// Ported from gentle-herdr lib/herdr-visuals-application.ts, with our own
// planner underneath, so the assertions are about this repository's contract:
//
// - the guard matrix is a PURE function, so every reason it can return is
//   asserted with no filesystem access at all;
// - `unchanged` writes nothing and reloads nothing: the inode, the bytes, the
//   directory listing and the fake Herdr's argv log all prove it;
// - a real write preserves the file mode, creates ONE backup with the original
//   bytes, and reloads only after the rename, through a real executable that
//   records its argv (no `shell`, no interpolation);
// - a compare-and-swap failure is not clobbered, a symlink/hardlink/oversized/
//   missing config is refused, and a planner refusal leaves the bytes untouched;
// - a reload failure reports partial state and keeps the written config.
//
// The reload argv and its bounded timeout are asserted exactly by replacing
// `child_process.execFile` for that one test; the argv-forwarding test uses a
// real script on disk under a directory whose name has a space, so nothing about
// the invocation is inferred.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyHerdrTheme, herdrThemeAvailability, herdrConfigPath } = require('../lib/herdr-theme-apply.js');

const PROJECTION = { name: 'one-dark', custom: { accent: '#bb9af7', text: '#c0caf5' } };
const SECOND_PROJECTION = { name: 'nord', custom: { accent: '#111111' } };

// The user's real config shape (evidence E1), including the `auto_switch = false`
// line the reference implementation chokes on.
const CONFIG = [
  'onboarding = false',
  '',
  '[theme]',
  'name = "catppuccin"',
  '',
  'auto_switch = false',
  '[theme.custom]',
  '# TokyoNight Night and Moon',
  'panel_bg = "#1a1b26"',
  'accent = "#7aa2f7"',
  '',
  '[terminal]',
  'new_cwd = "follow"',
  '',
].join('\n');

// A fake `herdr` that records the argv it was given and exits with the code the
// test asks for. It is a real executable on disk: "no reload" and "one reload
// with these arguments" are facts about this file, not about a stub.
const FAKE_HERDR = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$@" > "$HERDR_ARGV_LOG"',
  'exit "${HERDR_FAKE_EXIT:-0}"',
  '',
].join('\n');

function fixture(t, options = {}) {
  // realpath so a platform whose temp root is a symlink (macOS /var) is not
  // mistaken for a symlinked config parent by the snapshot guard.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-theme-apply-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = options.binDir ?? root;
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'herdr');
  fs.writeFileSync(bin, FAKE_HERDR, { mode: 0o755 });
  const logPath = path.join(root, 'herdr-argv.log');
  const configPath = options.configPath ?? path.join(root, 'config.toml');
  if (options.writeConfig !== false) fs.writeFileSync(configPath, options.config ?? CONFIG, { mode: 0o640 });
  const env = {
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_SOCKET_PATH: path.join(root, 'herdr.sock'),
    HERDR_BIN_PATH: bin,
    HERDR_CONFIG_PATH: configPath,
    HERDR_ARGV_LOG: logPath,
  };
  const bytes = () => fs.readFileSync(configPath, 'utf8');
  const backup = () => `${configPath}.herdr-gentle-shell.bak`;
  const argv = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : null);
  return { root, binDir, bin, logPath, configPath, env, bytes, backup, argv };
}

const LINUX = { platform: 'linux' };
function run(config, projection = PROJECTION) {
  return applyHerdrTheme({ projection, env: config.env, platform: LINUX.platform });
}

describe('availability guard matrix (pure)', () => {
  const pane = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/owned-fake.sock' };

  test('a local Linux Herdr pane with an absolute socket and config is available', () => {
    assert.deepEqual(
      herdrThemeAvailability({ ...pane, HERDR_CONFIG_PATH: '/fake/config.toml' }, 'linux'),
      { available: true },
    );
  });

  test('no Herdr environment is not-herdr', () => {
    for (const env of [{}, { HERDR_ENV: '1' }, { HERDR_ENV: '0', HERDR_PANE_ID: 'p', HERDR_SOCKET_PATH: '/s' },
      { ...pane, HERDR_PANE_ID: '' }, { ...pane, HERDR_SOCKET_PATH: '' }]) {
      assert.deepEqual(herdrThemeAvailability(env, 'linux'), { available: false, reason: 'not-herdr' });
    }
  });

  test('a subagent child may never write the user\'s config', () => {
    assert.deepEqual(
      herdrThemeAvailability({ ...pane, GENTLE_PI_AGENTS_CHILD: '1', HERDR_CONFIG_PATH: '/fake/config.toml' }, 'linux'),
      { available: false, reason: 'child' },
    );
  });

  test('an SSH session inside a Herdr pane reads another machine\'s config', () => {
    for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
      assert.deepEqual(
        herdrThemeAvailability({ ...pane, [key]: 'remote', HERDR_CONFIG_PATH: '/fake/config.toml' }, 'linux'),
        { available: false, reason: 'remote' },
      );
    }
  });

  test('a dev binary, a non-Linux platform and non-absolute paths are unsupported', () => {
    const base = { ...pane, HERDR_CONFIG_PATH: '/fake/config.toml' };
    assert.deepEqual(herdrThemeAvailability({ ...base, HERDR_BIN_PATH: 'herdr-dev' }, 'linux'), { available: false, reason: 'unsupported' });
    assert.deepEqual(herdrThemeAvailability({ ...base, HERDR_BIN_PATH: '/owned fake/HERDR-DEV.EXE' }, 'linux'), { available: false, reason: 'unsupported' });
    assert.deepEqual(herdrThemeAvailability(base, 'darwin'), { available: false, reason: 'unsupported' });
    assert.deepEqual(herdrThemeAvailability({ ...base, HERDR_SOCKET_PATH: 'relative.sock' }, 'linux'), { available: false, reason: 'unsupported' });
    assert.deepEqual(herdrThemeAvailability({ ...base, HERDR_CONFIG_PATH: 'relative.toml' }, 'linux'), { available: false, reason: 'unsupported' });
    assert.deepEqual(herdrThemeAvailability({ ...base, HERDR_CONFIG_PATH: '/fake/../config.toml' }, 'linux'), { available: false, reason: 'unsupported' });
    assert.deepEqual(herdrThemeAvailability({ ...pane, HOME: undefined, XDG_CONFIG_HOME: undefined }, 'linux'), { available: false, reason: 'unsupported' });
  });

  test('the config path resolves override, then XDG, then HOME', () => {
    assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: '/a/config.toml', XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/a/config.toml');
    assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/x/herdr/config.toml');
    assert.equal(herdrConfigPath({ HOME: '/h' }), '/h/.config/herdr/config.toml');
    assert.equal(herdrConfigPath({}), null);
  });
});

describe('guarded application', () => {
  test('an unavailable context returns its reason without reading or writing the config', async (t) => {
    const config = fixture(t);
    const before = config.bytes();
    for (const [extra, reason] of [
      [{ HERDR_ENV: '0' }, 'not-herdr'],
      [{ GENTLE_PI_AGENTS_CHILD: '1' }, 'child'],
      [{ SSH_TTY: '/dev/pts/1' }, 'remote'],
      [{ HERDR_BIN_PATH: 'herdr-dev' }, 'unsupported'],
    ]) {
      const env = { ...config.env, ...extra };
      const result = await applyHerdrTheme({ projection: PROJECTION, env, platform: 'linux' });
      assert.deepEqual(result, { status: 'unavailable', reason });
    }
    assert.equal(config.bytes(), before);
    assert.equal(config.argv(), null);
    assert.equal(fs.existsSync(config.backup()), false);
  });

  test('a missing config is not bootstrapped', async (t) => {
    const config = fixture(t, { writeConfig: false });
    const result = await run(config);
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.match(result.error, /ENOENT/);
    assert.ok(result.error.includes(config.configPath));
    assert.equal(fs.existsSync(config.configPath), false);
    assert.equal(config.argv(), null);
  });
});

describe('unchanged: no write, no backup, no reload', () => {
  test('a config that already carries the projection is left byte-identical', async (t) => {
    const config = fixture(t);
    assert.deepEqual(await run(config), { status: 'requested' });
    const written = config.bytes();
    const inode = fs.statSync(config.configPath).ino;
    fs.rmSync(config.logPath);
    const entries = fs.readdirSync(config.root).sort();
    assert.deepEqual(await run(config), { status: 'unchanged' });
    assert.equal(config.bytes(), written);
    assert.equal(fs.statSync(config.configPath).ino, inode);
    assert.deepEqual(fs.readdirSync(config.root).sort(), entries);
    assert.equal(config.argv(), null);
  });

  test('an already-projected config never creates a backup', async (t) => {
    const config = fixture(t, { config: '[theme]\nname = "one-dark"\n[theme.custom]\naccent = "#bb9af7"\ntext = "#c0caf5"\n' });
    assert.deepEqual(await run(config), { status: 'unchanged' });
    assert.equal(fs.existsSync(config.backup()), false);
    assert.equal(config.argv(), null);
  });
});

describe('a real write', () => {
  test('edits the config in place, preserves the mode, backs up once and reloads exactly once', async (t) => {
    const config = fixture(t);
    const before = config.bytes();
    assert.deepEqual(await run(config), { status: 'requested' });
    const written = config.bytes();
    assert.ok(written.includes('# herdr-gentle-shell: was name = "catppuccin"\nname = "one-dark"\n'));
    assert.ok(written.includes('# herdr-gentle-shell: was accent = "#7aa2f7"\naccent = "#bb9af7"\n'));
    assert.ok(written.includes('panel_bg = "#1a1b26"'), 'a token the projection does not carry was touched');
    assert.ok(written.includes('auto_switch = false'), 'the accepted auto_switch line was not preserved');
    assert.equal(fs.statSync(config.configPath).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(config.backup(), 'utf8'), before);
    assert.equal(config.argv(), 'server\nreload-config\n');
    // The staged temp file is renamed away, never left behind.
    assert.deepEqual(fs.readdirSync(config.root).sort(), ['config.toml', 'config.toml.herdr-gentle-shell.bak', 'herdr', 'herdr-argv.log']);
  });

  test('works when the binary path contains a space (no shell interpolation)', async (t) => {
    const config = fixture(t, { binDir: path.join(os.tmpdir(), `herdr bin ${process.pid}`) });
    t.after(() => fs.rmSync(config.binDir, { recursive: true, force: true }));
    assert.ok(config.bin.includes(' '));
    assert.deepEqual(await run(config), { status: 'requested' });
    assert.equal(config.argv(), 'server\nreload-config\n');
  });

  test('the reload argv and its bounded options are exactly these values', async (t) => {
    const config = fixture(t);
    const calls = [];
    t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null);
    });
    assert.deepEqual(await run(config), { status: 'requested' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, config.bin);
    assert.deepEqual(calls[0].args, ['server', 'reload-config']);
    assert.deepEqual(calls[0].options, { env: config.env, timeout: 5000, maxBuffer: 4096 });
    assert.equal('shell' in calls[0].options, false);
  });

  test('the backup is created once from the first original and never overwritten', async (t) => {
    const config = fixture(t);
    const original = config.bytes();
    assert.deepEqual(await run(config), { status: 'requested' });
    const firstWrite = config.bytes();
    assert.notEqual(firstWrite, original);
    assert.deepEqual(await run(config, SECOND_PROJECTION), { status: 'requested' });
    assert.notEqual(config.bytes(), firstWrite);
    assert.equal(fs.readFileSync(config.backup(), 'utf8'), original);
    const kept = fs.readFileSync(config.backup(), 'utf8');
    fs.rmSync(config.logPath);
    assert.deepEqual(await run(config, SECOND_PROJECTION), { status: 'unchanged' });
    assert.equal(fs.readFileSync(config.backup(), 'utf8'), kept);
    assert.equal(config.argv(), null);
  });

  test('a planner refusal writes nothing, backs up nothing and reloads nothing', async (t) => {
    const raw = '[theme]\nname = "catppuccin"\nauto_switch = true\n';
    const config = fixture(t, { config: raw });
    const result = await run(config);
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.match(result.error, /^line 3: .*`auto_switch`/);
    assert.equal(config.bytes(), raw);
    assert.equal(fs.existsSync(config.backup()), false);
    assert.equal(config.argv(), null);
  });
});

describe('bounded snapshot refusals', () => {
  test('a session where the config is a symlink, directory, hardlink or oversized file is refused', async (t) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-theme-apply-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const realConfig = path.join(home, 'config.toml');
    fs.writeFileSync(realConfig, CONFIG, { mode: 0o640 });

    const links = path.join(home, 'links');
    fs.mkdirSync(links);

    for (const kind of ['symlink', 'directory', 'oversized', 'hardlink']) {
      const target = path.join(links, kind);
      if (kind === 'symlink') fs.symlinkSync(realConfig, target);
      if (kind === 'directory') fs.mkdirSync(target);
      if (kind === 'oversized') fs.writeFileSync(target, `# ${'x'.repeat(256 * 1024 + 1)}`);
      if (kind === 'hardlink') fs.linkSync(realConfig, target);

      const config = fixture(t, { binDir: links, configPath: target, writeConfig: false });
      const result = await run(config);
      assert.deepEqual(result, {
        status: 'partial',
        stage: 'config',
        error: 'Herdr config must be a bounded regular single-link file',
      });
      assert.equal(config.argv(), null);
      assert.equal(fs.existsSync(`${target}.herdr-gentle-shell.bak`), false);
      if (kind === 'oversized') assert.ok(fs.readFileSync(target, 'utf8').length > 256 * 1024);
      if (kind === 'directory') assert.deepEqual(fs.readdirSync(target), []);
    }
    assert.equal(fs.readFileSync(realConfig, 'utf8'), CONFIG);
  });

  test('a symlinked parent directory is refused', async (t) => {
    const config = fixture(t);
    const alias = path.join(config.root, 'alias');
    fs.symlinkSync(config.root, alias);
    const aliased = { ...config, env: { ...config.env, HERDR_CONFIG_PATH: path.join(alias, 'config.toml') } };
    assert.deepEqual(await run(aliased), {
      status: 'partial',
      stage: 'config',
      error: 'Unsupported or symlinked Herdr config path',
    });
    assert.equal(config.bytes(), CONFIG);
    assert.equal(config.argv(), null);
  });

  test('invalid UTF-8 is refused without touching the bytes', async (t) => {
    const config = fixture(t);
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x0a]);
    fs.writeFileSync(config.configPath, bytes);
    const result = await run(config);
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'config');
    assert.match(result.error, /not valid for encoding utf-8/i);
    assert.deepEqual(fs.readFileSync(config.configPath), bytes);
    assert.equal(config.argv(), null);
    assert.equal(fs.existsSync(config.backup()), false);
  });
});

describe('compare and swap', () => {
  test('a config changed between the snapshot and the replacement is not clobbered', async (t) => {
    const config = fixture(t);
    const external = `${CONFIG}# external edit\n`;
    const realFsync = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', (fd) => {
      realFsync(fd);
      fs.writeFileSync(config.configPath, external);
    });
    assert.deepEqual(await run(config), {
      status: 'partial',
      stage: 'config',
      error: 'Herdr config changed before replacement',
    });
    assert.equal(config.bytes(), external);
    assert.equal(config.argv(), null);
  });
});

describe('reload', () => {
  test('a reload failure reports partial state and keeps the written config', async (t) => {
    const config = fixture(t);
    const env = { ...config.env, HERDR_FAKE_EXIT: '7' };
    const result = await applyHerdrTheme({ projection: PROJECTION, env, platform: 'linux' });
    assert.equal(result.status, 'partial');
    assert.equal(result.stage, 'reload');
    assert.match(result.error, /Command failed/);
    assert.ok(config.bytes().includes('name = "one-dark"'));
    assert.equal(config.argv(), 'server\nreload-config\n');
    // The write is committed, so a second run is a no-op and does not retry.
    fs.rmSync(config.logPath);
    assert.deepEqual(await applyHerdrTheme({ projection: PROJECTION, env, platform: 'linux' }), { status: 'unchanged' });
    assert.equal(config.argv(), null);
  });
});

describe('backup path decisions', () => {
  test('a regular file that appears in the linkSync race is accepted as the existing backup', async (t) => {
    // DECISION (documented in lib/herdr-theme-apply.js): a regular file at the
    // backup path is an older original we cannot tell from a raced copy, so it is
    // kept as it is — the config is still replaced, and the backup is untouched.
    const config = fixture(t);
    const realLink = fs.linkSync;
    t.mock.method(fs, 'linkSync', (from, to) => {
      fs.writeFileSync(to, 'an older original\n');
      return realLink(from, to);
    });
    assert.deepEqual(await run(config), { status: 'requested' });
    assert.equal(fs.readFileSync(config.backup(), 'utf8'), 'an older original\n');
    assert.ok(config.bytes().includes('name = "one-dark"'));
    assert.equal(config.argv(), 'server\nreload-config\n');
  });
});
