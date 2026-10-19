'use strict';
// Tests for lib/clipboard.js — the seam-injectable system clipboard writer
// (key-consistency S6/K4: `y` copies the number, `Y` the URL).
//
// Contract under test: `writeText(text)` tries the system clipboard tools
// in order with fixed argv (never a shell string) and returns
// `{ok:true, via}` or `{ok:false, error}`. When no tool exists it reports
// the miss honestly instead of pretending it copied.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const clipboard = require('../lib/clipboard.js');

function okRun() {
  return { status: 0, stdout: '', stderr: '', error: null };
}

function missingRun() {
  return { status: null, stdout: '', stderr: '', error: 'spawn ENOENT: no such tool' };
}

beforeEach(() => {
  clipboard.setClipboardRunner(null);
});

describe('clipboard writer', () => {
  test('success returns {ok:true, via} with the tool fixed argv', async () => {
    const calls = [];
    clipboard.setClipboardRunner((bin, argv, runOpts) => {
      calls.push({ bin, argv: argv.slice(), runOpts: { ...(runOpts || {}) } });
      return Promise.resolve(okRun());
    });
    const res = await clipboard.writeText('76');
    assert.equal(res.ok, true);
    assert.equal(typeof res.via, 'string');
    assert.ok(res.via.length > 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, res.via);
    assert.ok(Array.isArray(calls[0].argv));
    assert.ok(calls[0].argv.every((entry) => typeof entry === 'string'));
  });

  test('the text travels as input, never interpolated into argv', async () => {
    const hostile = 'x; rm -rf / $(evil) `id` | cat /etc/passwd';
    const calls = [];
    clipboard.setClipboardRunner((bin, argv, runOpts) => {
      calls.push({ bin, argv: argv.slice(), text: runOpts && runOpts.text });
      return Promise.resolve(okRun());
    });
    const res = await clipboard.writeText(hostile);
    assert.equal(res.ok, true);
    assert.equal(calls[0].text, hostile);
    assert.ok(!calls[0].argv.some((entry) => entry.includes('rm -rf')), 'argv carries no payload text');
  });

  test('a missing first tool falls through to the next one in order', async () => {
    const calls = [];
    clipboard.setClipboardRunner((bin, argv) => {
      calls.push({ bin, argv: argv.slice() });
      if (calls.length === 1) return Promise.resolve(missingRun());
      return Promise.resolve(okRun());
    });
    const res = await clipboard.writeText('76');
    assert.equal(res.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(res.via, calls[1].bin);
  });

  test('no tool anywhere is an honest miss, never a fake success', async () => {
    const calls = [];
    clipboard.setClipboardRunner((bin, argv) => {
      calls.push(bin);
      return Promise.resolve(missingRun());
    });
    const res = await clipboard.writeText('76');
    assert.equal(res.ok, false);
    assert.ok(String(res.error).length > 0);
    assert.match(String(res.error), /no clipboard tool/i);
    assert.ok(calls.length >= 2, 'every candidate tool was tried');
  });

  test('a present tool that fails reports its error honestly', async () => {
    clipboard.setClipboardRunner(() => Promise.resolve({
      status: 1, stdout: '', stderr: 'display closed', error: 'display closed',
    }));
    const res = await clipboard.writeText('76');
    assert.equal(res.ok, false);
    assert.match(String(res.error), /display closed/);
    assert.ok(!res.ok, 'a failed copy never reports ok:true');
  });

  test('empty text refuses without touching any tool', async () => {
    let calls = 0;
    clipboard.setClipboardRunner(() => { calls += 1; return Promise.resolve(okRun()); });
    assert.equal((await clipboard.writeText('')).ok, false);
    assert.equal((await clipboard.writeText(123)).ok, false);
    assert.equal(calls, 0);
  });

  test('a throwing runner still returns {ok:false}', async () => {
    clipboard.setClipboardRunner(() => Promise.reject(new Error('boom')));
    const res = await clipboard.writeText('76');
    assert.equal(res.ok, false);
    assert.match(String(res.error), /boom/);
  });

  test('the module source never builds a shell string', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'clipboard.js'), 'utf8');
    assert.ok(!/exec\s*\(/.test(src), 'no child_process.exec with a shell string');
    assert.ok(!/execSync\s*\(/.test(src), 'no child_process.execSync with a shell string');
    assert.ok(!/shell\s*:\s*true/.test(src), 'no shell:true spawn option');
  });

  test('wl-copy case: a helper that ACCEPTS the text and NEVER EXITS reports success', async () => {
    // Reproduced false negative: wl-copy takes the text on stdin and then
    // stays alive serving the selection, so waiting for exit hits the
    // timeout even though the copy succeeded. The runner below models that
    // accepted-but-still-running child: it records the text and never
    // settles an exit.
    const received = [];
    let unrefCalls = 0;
    clipboard.setClipboardRunner(() => ({
      stdin: {
        write(data, cb) { received.push(String(data)); if (typeof cb === 'function') cb(null); },
        end() {},
      },
      unref() { unrefCalls += 1; },
      on() { return this; },
      once() { return this; },
    }));
    const started = Date.now();
    const res = await clipboard.writeText('herdr-gentle-clip-test');
    const elapsed = Date.now() - started;
    assert.equal(res.ok, true);
    assert.equal(received.join(''), 'herdr-gentle-clip-test');
    assert.ok(elapsed < 2000, `returned promptly without waiting for exit (took ${elapsed}ms)`);
    assert.equal(unrefCalls, 1, 'detached child is unref\'d so pi is not kept alive');
  });

  test('a runner that throws ENOENT on every tool is still an honest miss', async () => {
    const tried = [];
    clipboard.setClipboardRunner((bin) => {
      tried.push(bin);
      throw new Error(`spawn ${bin} ENOENT`);
    });
    const res = await clipboard.writeText('76');
    assert.equal(res.ok, false);
    assert.match(String(res.error), /ENOENT|no clipboard tool/i);
    assert.ok(tried.length >= 2, 'every candidate tool was tried');
  });

  test('a helper whose stdin write fails reports a failure, never success', async () => {
    clipboard.setClipboardRunner(() => ({
      stdin: {
        write(data, cb) { if (typeof cb === 'function') cb(new Error('write EPIPE')); },
        end() {},
      },
      unref() {},
      on() { return this; },
      once() { return this; },
    }));
    const res = await clipboard.writeText('76');
    assert.equal(res.ok, false);
    assert.match(String(res.error), /EPIPE|write|failed/i);
  });
});
