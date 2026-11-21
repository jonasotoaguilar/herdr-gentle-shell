'use strict';

// Regression cases from the fifth independent verification of the Herdr theme
// planner/writer (inputs reproduced verbatim from the verifier's report).
// Not included on purpose: a "full clear restores the file where both tables
// were added" case. There is no operation distinct from "project an empty
// custom", and a projection always carries the theme name, so the name line
// the planner inserted stays; that is a documented limit.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planThemeConfig: plan } = require('../lib/herdr-theme-config.js');
const { applyHerdrTheme } = require('../lib/herdr-theme-apply.js');

const clear = { name: 'nord', custom: {} };
const paint = { name: 'nord', custom: { red: '#bbaacc' } };
const theme = '[theme]\nname="nord"\n';
const custom = '[theme.custom]\n';
const was = '# herdr-gentle-shell: was ';
const begin = '# herdr-gentle-shell: begin\n';
const end = '# herdr-gentle-shell: end\n';

function text(raw, projection) {
  const r = plan(raw, projection);
  assert.equal(r.ok, true, r.error);
  return r.text;
}

test('A: clearing a block must not take a pre-existing opaque terminator', () => {
  const original = theme + '[ui]\nwidth=40\n';
  const painted = text(original, paint);
  assert.ok(painted.endsWith(end));
  assert.equal(text(painted.slice(0, -1), clear), original);
});

test('D: an invalid escape in a terminated opaque multi-line string is not a refusal', () => {
  const opaque = 'note = """x\\q"""\n';
  assert.equal(text(opaque + theme, { name: 'dracula' }).slice(0, opaque.length), opaque);
});

// A marker-looking comment that sits ABOVE a managed block is not adjacent to
// the key under the block. Removing the block must never make it adjacent and
// thereby promote it to a marker (the second plan used to change the user's
// colour and eat the comment). Refusing the ambiguity is acceptable; promoting
// it is not.
const between = theme + custom + was + 'red="#112233" # example\n'
  + begin + 'green = "#123456"\n' + end + 'red="#223344"\n';
for (const p of [clear, paint]) {
  test(`F: removing a block does not activate an ordinary comment (${Object.keys(p.custom).length} token)`, () => {
    const first = plan(between, p);
    if (!first.ok) return; // an explicit refusal of the ambiguity is fine
    const second = plan(first.text, p);
    assert.equal(second.ok, true, second.error);
    assert.equal(second.changed, false, 'the plan must be idempotent');
    assert.ok(first.text.includes('red="#223344"') || first.text.includes('#bbaacc'));
    assert.ok(first.text.includes(was + 'red="#112233" # example\n'), 'the ordinary comment survives untouched');
  });
}

test('C: restoring a colour keeps a comment the user edited after we wrote it', () => {
  const original = theme + custom + 'red="#112233" # old\n';
  const edited = text(original, paint).replace('red="#bbaacc" # old', 'red="#bbaacc" # new');
  assert.equal(text(edited, clear), original.replace('# old', '# new'));
});

test('G: backup staging must not delete an unowned EEXIST file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-fifth-'));
  const config = path.join(dir, 'config.toml');
  fs.writeFileSync(config, theme);
  const open = fs.openSync;
  let foreign;
  try {
    fs.openSync = function (file, flags, mode) {
      if (typeof file === 'string' && file.includes('.bak.') && file.endsWith('.tmp')) {
        foreign = file;
        const fd = open(file, 'wx');
        try { fs.writeFileSync(fd, 'other writer'); } finally { fs.closeSync(fd); }
      }
      return open(file, flags, mode);
    };
    const r = await applyHerdrTheme({ platform: 'linux', projection: paint, env: {
      HERDR_ENV: '1', HERDR_PANE_ID: 'test', HERDR_SOCKET_PATH: path.join(dir, 'server.sock'),
      HERDR_CONFIG_PATH: config,
    } });
    assert.equal(r.stage, 'config');
    assert.match(r.error, /EEXIST/);
    assert.equal(fs.readFileSync(config, 'utf8'), theme);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'other writer');
  } finally {
    fs.openSync = open;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
