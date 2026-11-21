'use strict';

// Regression cases from the fourth independent verification of the Herdr theme
// planner/writer (inputs reproduced verbatim from the verifier's report).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planThemeConfig: plan } = require('../lib/herdr-theme-config.js');
const { applyHerdrTheme } = require('../lib/herdr-theme-apply.js');

const theme = '[theme]\nname="one-dark"\n';
const clear = { name: 'one-dark', custom: {} };
const paint = { name: 'one-dark', custom: { teal: '#123456' } };
const custom = theme + '[theme.custom]\n';
const begin = '# herdr-gentle-shell: begin\n';
const end = '# herdr-gentle-shell: end\n';
const legacyBegin = '# BEGIN herdr-gentle-theme (managed; do not edit)\n';
const legacyEnd = '# END herdr-gentle-theme';
function ok(result) {
  assert.equal(result.ok, true, result.error);
  return result.text;
}

test('clearing a created table after an opaque unterminated line', () => {
  const before = theme + '[x]\na=1';
  assert.equal(ok(plan(ok(plan(before, paint)), clear)), before);
});
test('a full cycle restores the original file when custom was created', () => {
  const before = "[theme]\nname = 'one-dark'\n";
  let text = before;
  for (const p of [{ ...paint, name: 'nord' }, paint, { name: 'dracula' }, clear]) {
    text = ok(plan(text, p));
  }
  assert.equal(text, before);
});
test('a was marker restores trailing whitespace on a user line', () => {
  const before = custom + ' teal = "#aaaaaa" # note \t \r\n';
  assert.equal(ok(plan(ok(plan(before, paint)), clear)), before);
});
for (const body of ['# user comment\n', ' \t\n']) {
  test(`a non-token block line ${JSON.stringify(body)} is refused, never deleted`, () => {
    assert.deepEqual(plan(custom + begin + body + 'teal = "#aaaaaa"\n' + end, clear), {
      ok: false,
      error: 'line 5: unexpected content inside the herdr-gentle-shell block; no changes proposed.',
    });
  });
}
test('a user multiline edit underneath an old marker is never deleted', () => {
  const before = custom + '# herdr-gentle-shell: was teal = "#aaaaaa"\n'
    + 'teal = """\n# new user bytes\n"""\n';
  const r = plan(before, clear);
  if (r.ok) assert.ok(r.text.includes('# new user bytes\n'));
});
test('backslashes in a TOML literal name are not decoded', () => {
  const before = "[theme]\nname = 'one\\u002ddark'\n";
  // The literal string is the 14-character text one\u002ddark, which is not the
  // projected name: the planner must replace it, never treat it as already equal.
  assert.match(ok(plan(before, clear)), /\nname = "one-dark"\n/);
});
test('backslashes in a TOML literal color are not decoded', () => {
  const before = custom + "teal = '\\u0023123456'\n";
  assert.match(ok(plan(before, paint)), /\nteal = "#123456"\n/);
});
test('a legacy pair whose end is an opaque unterminated comment migrates', () => {
  const expected = theme + '[x]\na=1\n';
  assert.equal(ok(plan(legacyBegin + expected + legacyEnd, clear)), expected);
});
test('an opaque, structurally closed string need not have a valid escape', () => {
  const opaque = '[x]\na="\\q"\n';
  assert.ok(ok(plan(opaque + theme, paint)).startsWith(opaque));
});
test('legal Unicode in a user comment remains recordable', () => {
  const before = '[theme]\nname = "nord" # a\u2028b\n';
  assert.match(ok(plan(before, clear)), /name = "one-dark" # a\u2028b\n/);
});
for (const kind of ['backup', 'staged']) {
  test(`${kind} temporary is cleaned after one transient unlink failure`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-regression-'));
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, theme);
    const env = {
      HERDR_ENV: '1', HERDR_PANE_ID: '1', HERDR_SOCKET_PATH: path.join(dir, 'socket'),
      HERDR_CONFIG_PATH: file, HERDR_BIN_PATH: '/usr/bin/true',
    };
    const unlink = fs.unlinkSync, rename = fs.renameSync;
    let injected = false;
    try {
      if (kind === 'staged') fs.renameSync = () => { throw new Error('injected rename'); };
      fs.unlinkSync = (target) => {
        if (!injected && target.endsWith('.tmp') && (target.includes('.bak.') === (kind === 'backup'))) {
          injected = true;
          throw Object.assign(new Error('injected transient unlink'), { code: 'EIO' });
        }
        return unlink(target);
      };
      await applyHerdrTheme({ env, platform: 'linux', projection: paint });
    } finally {
      fs.unlinkSync = unlink;
      fs.renameSync = rename;
    }
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(injected, true);
    assert.deepEqual(leftovers, []);
  });
}
