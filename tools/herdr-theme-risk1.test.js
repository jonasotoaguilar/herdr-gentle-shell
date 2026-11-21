'use strict';

// Regression cases from the third independent verification of the Herdr theme
// writer (inputs reproduced verbatim). Every accepted plan must also parse with
// tomllib: string equality alone once hid invalid TOML.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { planThemeConfig: plan } = require('../lib/herdr-theme-config.js');
const { applyHerdrTheme: apply } = require('../lib/herdr-theme-apply.js');

const empty = { name: 'one-dark' };
const accent = { ...empty, custom: { accent: '#112233' } };
function toml(text, expression = 'd') {
  const r = spawnSync('python3', ['-I', '-c',
    `import json, sys, tomllib\nd = tomllib.loads(sys.stdin.read().removeprefix('\\ufeff'))\nprint(json.dumps(${expression}, default=str))`],
  { input: text, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}
function accepted(input, projection = accent) {
  const r = plan(input, projection);
  assert.equal(r.ok, true, r.error);
  const parsed = toml(r.text);
  assert.equal(parsed.status, 0, parsed.stderr);
  return r.text;
}
function cycle(input) {
  for (const p of [accent, { ...empty, custom: { red: '#445566' } },
    { ...empty, custom: { accent: '#778899', text: '#abcdef' } }, empty]) {
    input = accepted(input, p);
  }
  return input;
}

for (const payload of ['aba', '[x[', '101']) {
  test(`an unquoted marker payload ${payload} is an ordinary comment, never an original value`, () => {
    const input = `[theme.custom]\n# herdr-gentle-shell: was blue = ${payload}\nblue = "red"\n`;
    const output = accepted(input, empty);
    assert.equal(JSON.parse(toml(output, 'd["theme"]["custom"]["blue"]').stdout), 'red');
    assert.ok(output.includes(`# herdr-gentle-shell: was blue = ${payload}\n`));
  });
}

// Invalid TOML outside the theme tables is not ours to judge (Herdr already
// refuses such a file); what is required is that the planner never turns a
// document into a different invalid one and never rewrites it: refuse, or
// leave every non-theme line byte for byte.
for (const [label, input] of Object.entries({
  calendar: '[terminal]\nx=2025-02-29\n',
  offset: '[terminal]\nx=2024-02-29T12:00:00+24:00\n',
  localZone: '[terminal]\nx=12:00:00Z\n',
  inlineCollision: '[terminal]\nx={a=1,a.b=2}\n',
  dottedRedeclaration: '[ui]\nsidebar.agents=true\n[ui.sidebar]\n',
  arrayTableCollision: '[ui]\n[[ui]]\n',
  headerWhitespace: '[ui]\u00a0\n',
})) {
  test(`invalid ${label} outside the theme tables: refuse or leave those lines untouched`, () => {
    assert.equal(toml(input).status, 1);
    const r = plan(input, accent);
    if (r.ok) assert.ok(r.text.startsWith(input.replace(/\n?$/, '\n')) || r.text.startsWith(input), 'non-theme lines must be byte-identical');
  });
}

test('inline comments, spacing, CRLF and an unterminated EOF survive a projection cycle', () => {
  const input = '[theme]\r\nname="one-dark"\r\n[theme.custom]\r\naccent = \'red\' \t# personal';
  assert.equal(cycle(input), input);
});
test('a [theme.custom] header the planner created disappears when its block empties', () => {
  const input = '[theme]\nname="one-dark"\n';
  assert.equal(cycle(input), input);
});
test('a non-theme EOF line keeps its bytes when a table is appended after it', () => {
  const input = '[ui]\nmouse = true';
  const out = accepted(input);
  // The only permitted change is the single newline needed to end that line.
  assert.ok(out.startsWith(input + '\n'));
});
test('a human comment inside a managed block is never silently deleted', () => {
  const input = '[theme.custom]\n# herdr-gentle-shell: begin\n# personal note\nred="#445566"\n# herdr-gentle-shell: end\n';
  const r = plan(input, accent);
  if (r.ok) assert.ok(r.text.includes('# personal note\n'));
});
test('four closing quotes do not turn a malformed color into the projected one', () => {
  const r = plan('[theme.custom]\naccent="""#112233""""\n', accent);
  if (r.ok) assert.equal(JSON.parse(toml(r.text, 'd["theme"]["custom"]["accent"]').stdout), '#112233');
});

for (const [label, input] of Object.entries({
  continuation: '[ui.sidebar.agents]\nrows = [["""ag\\ \t\n ent"""]]\n',
  nestedAoT: '[[x]]\n[[x.y]]\n[x.y.z]\nv=1\n[[x.y]]\n[x.y.z]\nv=2\n',
  unicodeComment: '[ui]\nmouse = true # a\u2028b\n',
  quotedKeyIdentity: '[x]\n"a\\u0000b"=1\na.b=2\n',
})) {
  test(`valid ${label} never blocks a projection`, () => {
    assert.equal(toml(input).status, 0);
    accepted(input);
  });
}

function fixture(t, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-risk1-'));
  const file = path.join(dir, 'config.toml');
  const bin = path.join(dir, 'herdr-stub');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(file, input);
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'p', HERDR_SOCKET_PATH: path.join(dir, 'socket'),
    HERDR_CONFIG_PATH: file, HERDR_BIN_PATH: bin, HOME: dir };
  return { file, env };
}
test('apply never commits a malformed restore payload', async t => {
  const input = '[theme.custom]\n# herdr-gentle-shell: was blue = aba\nblue="red"\n';
  const { file, env } = fixture(t, input);
  const result = await apply({ projection: empty, env, platform: 'linux' });
  const written = fs.readFileSync(file, 'utf8');
  const parsed = toml(written);
  assert.equal(parsed.status, 0, `${result.status}: ${parsed.stderr}`);
});
