'use strict';
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { formatWorktreeModelResult, WORKTREE_MODEL_TOOLS } = require('../lib/worktree-model-result.js');

const roots = [];
const originalEnv = {
  GENTLE_WORKTREE_LIB_DIR: process.env.GENTLE_WORKTREE_LIB_DIR,
  GENTLE_STATUS_STATE_DIR: process.env.GENTLE_STATUS_STATE_DIR,
};
afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

async function registeredTools({ missingFormatter = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-model-wiring-'));
  roots.push(root);
  process.env.GENTLE_STATUS_STATE_DIR = path.join(root, 'state');
  const lib = path.resolve(__dirname, '../lib');
  process.env.GENTLE_WORKTREE_LIB_DIR = lib;
  if (missingFormatter) {
    const partial = path.join(root, 'partial-lib');
    fs.mkdirSync(partial);
    fs.writeFileSync(path.join(partial, 'worktree-mode.js'), 'module.exports = { readMode: () => ({ enabled: true, state: "enabled" }) };');
    process.env.GENTLE_WORKTREE_LIB_DIR = partial;
  }
  // Intercept only the backend at defineTool, before the real registration
  // adapter runs. Tests exercise registered tool.execute, not exported helpers,
  // without invoking Git, Herdr, GitHub or a user registry.
  const source = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts'), 'utf8')
    .replace('import { Type } from "@earendil-works/pi-ai";', 'const Type = new Proxy({}, { get: () => () => ({}) });')
    .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', `
      export const produced = new Map();
      export const calls = [];
      const defineTool = (definition) => ({ ...definition, execute: async function (...args) {
        calls.push({ name: definition.name, receiver: this, args });
        const result = produced.get(definition.name);
        if (result instanceof Error) throw result;
        return result;
      } });`);
  const copy = path.join(root, 'extension.mjs');
  fs.writeFileSync(copy, source);
  const mod = await import(pathToFileURL(copy).href);
  const tools = new Map();
  mod.default({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  assert.deepEqual([...tools.keys()].sort(), [...WORKTREE_MODEL_TOOLS].sort());
  return { tools, mod };
}

const details = {
  worktree_upsert: { created: true, branch: 'feat/demo', path: '/repo/demo', issues: [7], odd: 'odd/tasks/active.md' },
  worktree_list: { count: 1, worktrees: [{ name: 'demo', path: '/repo/demo', branch: 'feat/demo', kind: 'agent', status: 'live', issues: [7], assignedOdd: 'odd/tasks/active.md', odd: ['odd/tasks/discovered-only.md'] }] },
  worktree_close: { path: '/repo/demo', branch: 'feat/demo', removed: true, branchKept: true, warnings: ['legacy association dropped'], droppedOdd: ['old.md'] },
  worktree_session_open: { worktree: 'demo', path: '/repo/demo', sessionId: 'session-7', workspaceId: 'workspace-7', paneId: 'pane-7', resumed: true },
  worktree_warp: { name: 'demo', path: '/repo/demo', fromName: 'principal', from: '/repo', branch: 'feat/demo' },
};

for (const name of WORKTREE_MODEL_TOOLS) {
  test(`${name}: registered execute formats successful text without changing its contract`, async () => {
    const { tools, mod } = await registeredTools();
    const image = { type: 'image', mimeType: 'image/png', data: 'fixture' };
    const raw = { content: [{ type: 'text', text: 'RAW DISCOVERY DUMP' }, image], details: details[name], isError: false, evidence: 'kept' };
    mod.produced.set(name, raw);
    const receiver = { identity: 'caller' };
    const args = ['call-7', { name: 'demo' }, { aborted: false }, () => {}, { cwd: '/repo' }];
    const result = await tools.get(name).execute.apply(receiver, args);
    assert.deepEqual(result, formatWorktreeModelResult(name, raw));
    assert.notStrictEqual(result, raw, 'successful model text actually passed through the adapter');
    assert.strictEqual(result.details, raw.details);
    assert.strictEqual(result.content[1], image);
    assert.equal(result.evidence, 'kept');
    assert.equal(result.isError, false);
    assert.doesNotMatch(result.content[0].text, /RAW DISCOVERY DUMP|discovered-only/);
    assert.strictEqual(mod.calls[0].receiver, receiver);
    assert.deepEqual(mod.calls[0].args, args);
    if (name === 'worktree_close') assert.match(result.content[0].text, /warning: legacy association dropped/);
  });
}

test('errors, partials and backend exceptions keep their identity and diagnostics', async () => {
  const { tools, mod } = await registeredTools();
  for (const name of WORKTREE_MODEL_TOOLS) {
    for (const extra of [{ isError: true }, { isPartial: true }]) {
      const raw = { content: [{ type: 'text', text: 'exact failure diagnostic' }], details: details[name], ...extra };
      mod.produced.set(name, raw);
      assert.strictEqual(await tools.get(name).execute(), raw);
    }
    const failure = new Error('backend rejected');
    mod.produced.set(name, failure);
    await assert.rejects(tools.get(name).execute(), (error) => error === failure);
  }
});

test('a missing presentation module leaves registered execution untouched', async () => {
  const { tools, mod } = await registeredTools({ missingFormatter: true });
  for (const name of WORKTREE_MODEL_TOOLS) {
    const raw = { content: [{ type: 'text', text: 'backend result' }], details: details[name] };
    mod.produced.set(name, raw);
    assert.strictEqual(await tools.get(name).execute(), raw);
  }
});
