'use strict';
// Pin the S2 contract rename: the agent tool is registered as
// `worktree_upsert` (it creates OR updates), never `worktree_create`.
// No alias, no compatibility shim. Internal identifiers
// (`executeWorktreeCreate`, `worktreeCreateTool`, `warpCreate*` helpers)
// keep their names by design (S4) and are not asserted here.
//
// Loading pattern mirrors tools/worktree-create.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck), so the test
// copies it to a temporary .mjs path with exactly the two package import
// lines stubbed and import()s it with a fake `pi`.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const SELF = path.resolve(__filename);

const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
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

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function loadExtension() {
  // The mode gate reads through lib/worktree-mode.js: a missing state
  // file means enabled, so a fresh scratch dir registers every tool.
  const savedLibDir = process.env.GENTLE_WORKTREE_LIB_DIR;
  const savedStateDir = process.env.GENTLE_STATUS_STATE_DIR;
  const modeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rename-mode-'));
  roots.push(modeDir);
  process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
  process.env.GENTLE_STATUS_STATE_DIR = modeDir;
  try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rename-'));
  roots.push(dir);
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
  } finally {
    if (savedLibDir === undefined) delete process.env.GENTLE_WORKTREE_LIB_DIR;
    else process.env.GENTLE_WORKTREE_LIB_DIR = savedLibDir;
    if (savedStateDir === undefined) delete process.env.GENTLE_STATUS_STATE_DIR;
    else process.env.GENTLE_STATUS_STATE_DIR = savedStateDir;
  }
}

// Every file that may still name the old contract string. Historical
// requirement documents under odd/tasks/ are the record of what was asked
// and stay verbatim (S3); indexes, vendored code and this pin test itself
// (which quotes the old name only to assert its absence) are not living
// surfaces.
function livingFilesWithOldName() {
  const SKIP_DIRS = new Set(['.git', '.codegraph', 'node_modules']);
  const hits = [];
  const stack = [REPO_ROOT];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = path.relative(REPO_ROOT, full);
        if (rel === path.join('odd', 'tasks') || rel.startsWith(path.join('odd', 'tasks') + path.sep)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (full === SELF) continue;
        let text;
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('worktree_create') || text.includes('Worktree Create')) {
          hits.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }
  return hits.sort();
}

describe('worktree_upsert rename (S2)', () => {
  test('extension registers worktree_upsert and not worktree_create', async () => {
    const tools = await loadExtension();
    assert.ok(tools.has('worktree_upsert'), 'expected worktree_upsert to be registered');
    assert.ok(!tools.has('worktree_create'), 'old worktree_create name must not be registered');
    assert.equal(tools.get('worktree_upsert').label, 'Worktree Upsert');
    assert.match(tools.get('worktree_upsert').description, /create or update/i);
  });

  test('no living surface still names the old contract string', () => {
    assert.deepEqual(livingFilesWithOldName(), []);
  });
});
