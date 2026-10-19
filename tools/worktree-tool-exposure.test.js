'use strict';
// Tool exposure (S1/S2): `worktree_create`, `worktree_close` and
// `worktree_session_open` declare `exposure: "codemode"` so Pi stops
// declaring them to the model on every turn, while `worktree_list` and
// `worktree_warp` stay direct (Pi's default: the field is absent, not
// spelled out as "direct").
//
// The assertions read the REGISTERED tool objects, never the source text:
// every tool goes through `withWorktreeCardRenderer(defineTool(...))`, so
// only the object handed to `pi.registerTool` proves the field survives
// the wrapper.
//
// Loading pattern mirrors tools/worktree-list.test.js: the TypeScript
// extension is plain JS under the hood, so the test copies it to a
// temporary .mjs path with the package import lines stubbed and import()s
// it with a fake `pi` object.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText
  .replace(
    'import { Type } from "@earendil-works/pi-ai";',
    TYPE_STUB,
  )
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

const CODEmode_TOOLS = ['worktree_create', 'worktree_close', 'worktree_session_open'];
const DIRECT_TOOLS = ['worktree_list', 'worktree_warp'];

const scratchDirs = [];
after(() => {
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function scratch(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

async function loadRegisteredTools() {
  const dir = scratch('wt-exposure-ext-');
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  // A fresh state dir keeps the real user's worktree-mode file out of the
  // picture: a missing mode file means enabled, so the tools register.
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  process.env.GENTLE_STATUS_STATE_DIR = scratch('wt-exposure-state-');
  delete process.env.GENTLE_WORKTREE_THREAD;
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

describe('worktree tool exposure', { concurrency: false }, () => {
  test('create, close and session_open declare exposure codemode on the registered object', async () => {
    const tools = await loadRegisteredTools();
    for (const name of CODEmode_TOOLS) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} is registered`);
      assert.equal(tool.exposure, 'codemode', `${name} declares exposure codemode`);
    }
  });

  test('list and warp stay direct: no exposure field at all', async () => {
    const tools = await loadRegisteredTools();
    for (const name of DIRECT_TOOLS) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} is registered`);
      assert.equal(tool.exposure, undefined, `${name} declares no exposure`);
      assert.equal('exposure' in tool, false, `${name} has no exposure field`);
    }
  });
});
