'use strict';
// The sidebar switch, exercised through the shipped CLI (`bin/gentle-sidebar.js`
// over `lib/gentle-sidebar.js`). This is the one supported way to hand the
// sidebar between this plugin and native Herdr now that the Pi-side panel is
// gone, so its observable contract is pinned here: the mode file bytes, the
// managed Herdr rows, and the owned native-extension exclusion.
//
// Everything runs against a temp sandbox: a fake installed plugin root whose
// `bin/configure.js` writes the managed rows into HERDR_CONFIG_PATH, an agent
// dir holding settings.json plus the native extension file, and the CLI's own
// environment seams. Exit codes, stdout and the files on disk are the only
// assertions, so nothing here depends on a real Herdr install or a real Pi
// agent dir.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '../bin/gentle-sidebar.js');
const NATIVE_REL = path.join('extensions', 'herdr-agent-state.ts');
const NATIVE_ENTRY = '-extensions/herdr-agent-state.ts';
const MANAGED_BEGIN = '# BEGIN herdr-gentle-agents (managed; do not edit)';
const MANAGED_END = '# END herdr-gentle-agents';

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// The fake plugin root stands in for the Herdr plugin: `--apply` appends the
// managed block, `--uninstall` removes it, both only inside the markers, so the
// CLI's "verify the row effect" step has something honest to read.
const FAKE_CONFIGURE = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const file = process.env.HERDR_CONFIG_PATH;
const begin = ${JSON.stringify(MANAGED_BEGIN)};
const end = ${JSON.stringify(MANAGED_END)};
const block = [begin, '[ui.sidebar.agents.rows_by_agent]', 'pi = ["gentle_title_v1"]', end, ''].join('\\n');
const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const start = current.indexOf(begin);
const stop = current.indexOf(end);
const without = start >= 0 && stop > start ? current.slice(0, start) + current.slice(stop + end.length + 1) : current;
const apply = process.argv.includes('--apply');
fs.writeFileSync(file, apply ? (without + block) : without);
process.stdout.write(apply ? 'rows applied\\n' : 'rows removed\\n');
`;

function sandbox(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sidebar-cli-${tag}-`));
  roots.push(root);
  const state = path.join(root, 'state');
  const agent = path.join(root, 'agent');
  const plugin = path.join(root, 'plugin');
  const configPath = path.join(root, 'config.toml');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'extensions', 'herdr-agent-state.ts'), '// native sidecar\n');
  fs.writeFileSync(path.join(agent, 'settings.json'), `${JSON.stringify({ theme: 'keep', extensions: ['-builtin:codemode'] }, null, 2)}\n`);
  fs.writeFileSync(configPath, '[ui.sidebar.agents]\norder = ["pi"]\n');
  fs.writeFileSync(path.join(plugin, 'bin', 'configure.js'), FAKE_CONFIGURE);
  return {
    root,
    state,
    agent,
    configPath,
    env: {
      ...process.env,
      GENTLE_STATUS_STATE_DIR: state,
      GENTLE_PI_AGENT_HOME: agent,
      GENTLE_HERDR_PLUGIN_ROOT: plugin,
      HERDR_CONFIG_PATH: configPath,
    },
  };
}

function run(fixture, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60000, env: fixture.env });
}

function modeFile(fixture) {
  return path.join(fixture.state, 'gentle-sidebar-mode.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

describe('gentle-sidebar CLI', () => {
  test('status reports the missing-means-enabled default and writes nothing', () => {
    const fx = sandbox('status');
    const before = fs.readdirSync(fx.state);
    const r = run(fx, 'status');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Gentle sidebar is enabled \(default; no mode file\)/);
    assert.deepEqual(fs.readdirSync(fx.state), before, 'status never writes');
    assert.equal(fs.existsSync(modeFile(fx)), false);
  });

  test('enable records the mode, the managed rows and the owned exclusion', () => {
    const fx = sandbox('enable');
    const r = run(fx, 'enable');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Gentle sidebar enabled \(ours\)/);
    assert.deepEqual(readJson(modeFile(fx)), { version: 1, enabled: true });
    const config = fs.readFileSync(fx.configPath, 'utf8');
    assert.ok(config.includes(MANAGED_BEGIN) && config.includes(MANAGED_END), 'managed rows applied');
    assert.ok(config.includes('[ui.sidebar.agents]'), 'the user table survives');
    const settings = readJson(path.join(fx.agent, 'settings.json'));
    assert.deepEqual(settings.extensions, ['-builtin:codemode', NATIVE_ENTRY], 'only the owned entry is appended');
    assert.equal(settings.theme, 'keep', 'unrelated keys survive');
    assert.ok(fs.existsSync(path.join(fx.state, 'pi-extension-exclusion-owned')), 'ownership is recorded');
  });

  test('disable hands the sidebar back and removes only our owned state', () => {
    const fx = sandbox('disable');
    assert.equal(run(fx, 'enable').status, 0);
    const r = run(fx, 'disable');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Gentle sidebar disabled \(native renders again\)/);
    assert.deepEqual(readJson(modeFile(fx)), { version: 1, enabled: false });
    const config = fs.readFileSync(fx.configPath, 'utf8');
    assert.equal(config.includes(MANAGED_BEGIN), false, 'managed rows removed');
    assert.ok(config.includes('[ui.sidebar.agents]'), 'the user table survives');
    assert.deepEqual(readJson(path.join(fx.agent, 'settings.json')).extensions, ['-builtin:codemode']);
    assert.equal(fs.existsSync(path.join(fx.state, 'pi-extension-exclusion-owned')), false);
  });

  test('toggle flips the recorded mode and a second toggle flips it back', () => {
    const fx = sandbox('toggle');
    assert.equal(run(fx, 'toggle').status, 0);
    assert.deepEqual(readJson(modeFile(fx)), { version: 1, enabled: false });
    assert.equal(run(fx, 'toggle').status, 0);
    assert.deepEqual(readJson(modeFile(fx)), { version: 1, enabled: true });
    assert.deepEqual(readJson(path.join(fx.agent, 'settings.json')).extensions.length, 2);
  });

  test('an unknown verb fails closed with exit 2 and no write', () => {
    const fx = sandbox('usage');
    const r = run(fx, 'native');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown verb "native"/);
    assert.equal(fs.existsSync(modeFile(fx)), false);
  });
});
