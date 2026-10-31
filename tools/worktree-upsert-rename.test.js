'use strict';
// Pin the S1 contract rename: the agent tool is registered as
// `worktree_create` and only creates. The retired `worktree_upsert` name
// (which created OR updated, and carried issue/ODD associations) is gone
// from the registered contract — no alias, no compatibility shim.
// Internal identifiers (`executeWorktreeCreate`, `worktreeCreateTool`,
// `warpCreate*` helpers) keep their names by design and are not asserted
// here.
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

// Every file that may still name the retired contract string. Historical
// requirement documents under odd/tasks/ are the record of what was asked and
// stay verbatim; vendored code and this pin test itself (which quotes the old
// name only to assert its absence) are not living surfaces.
//
// PENDING (outside the worktree listing/display surfaces this pin covers, so
// pinned rather than fixed): this module still names the retired tool in a
// comment and in one refusal message, and must be updated by the follow-up
// that owns it. Naming it here keeps the gap visible instead of letting
// the old contract quietly reappear. The presentation modules are NOT in this
// list any more: the dead `worktree_upsert` model-text builder and its tests
// were removed, so no display surface names the retired contract.
const PENDING_OLD_NAME = [
  path.join('lib', 'worktree-hooks.js'),
];

// Files that must name the retired string precisely to assert its absence (or
// to document the pending follow-up above). Everything else has to be clean.
const ABSENCE_ASSERTIONS = [
  path.join('tools', 'worktree-create-tool.test.js'),
  path.join('tools', 'worktree-model-result.test.js'),
  path.join('tools', 'worktree-model-wiring.test.js'),
];

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
        if (text.includes('worktree_upsert') || text.includes('Worktree Upsert')) {
          hits.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  }
  return hits.sort();
}

describe('worktree_create rename (S1)', () => {
  test('extension registers worktree_create and not worktree_upsert', async () => {
    const tools = await loadExtension();
    assert.ok(tools.has('worktree_create'), 'expected worktree_create to be registered');
    assert.ok(!tools.has('worktree_upsert'), 'the retired worktree_upsert name must not be registered');
    assert.equal(tools.get('worktree_create').label, 'Worktree Create');
    assert.match(tools.get('worktree_create').description, /create/i);
    assert.doesNotMatch(tools.get('worktree_create').description, /create or update/i);
  });

  test('no living surface outside the pending follow-up list names the old contract', () => {
    const hits = livingFilesWithOldName();
    const pending = hits.filter((hit) => PENDING_OLD_NAME.includes(hit));
    const allowed = new Set([...PENDING_OLD_NAME, ...ABSENCE_ASSERTIONS]);
    const unexpected = hits.filter((hit) => !allowed.has(hit));
    assert.deepEqual(unexpected, [], `these surfaces must stop naming worktree_upsert: ${unexpected.join(', ')}`);
    // The pinned follow-ups must still be real: when one is cleaned up, drop it
    // from the list above instead of leaving a stale allowance behind.
    assert.deepEqual(
      pending.sort(),
      PENDING_OLD_NAME.slice().sort(),
      'the pending list matches exactly what still needs the follow-up',
    );
  });
});
