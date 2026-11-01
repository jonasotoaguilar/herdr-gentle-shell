'use strict';
// T8/S12 model-facing half (test-first): lib/worktree-model-result.js turns
// the four own worktree tools' raw content text into concise, stable,
// agent-useful text built from the SAME `details` object execute() already
// returns.
//
// Why this exists: the extension's current success text prints one raw line
// per checkout (`worktree list: <name> <branch> thread=<id> issues=<csv>
// odd=<csv>`), so a listing with many checkouts and many available ODD
// documents spends the agent's context on data it never acts on. The formatter
// keeps what the agent acts on (outcome, name, branch, path, kind, status,
// routing ids, warnings) and drops the rest — including issue numbers and ODD
// documents, which S1 removed from every worktree surface: a worktree carries
// neither.
//
// Fixtures are synthetic but shaped from the extension's real result
// objects (textResult/errorResult in extensions/gentle-worktree-tools.ts):
// { content: [{type:'text', text}], details, isError? }. Every case pins the
// contract from the OUTSIDE (exported helper only) and asserts that
// `details`, `isError` and non-text content survive untouched — the UI and
// runtime read the same result object.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatWorktreeModelResult,
  WORKTREE_MODEL_TOOLS,
} = require('../lib/worktree-model-result.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOf(result) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  return content
    .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
}

function linesOf(result) {
  return textOf(result).split('\n');
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

// Legacy raw text the extension prints today, kept in the fixtures so every
// test can prove the formatter ignores it instead of echoing it.
const THREAD_ID = 'thread-4f9c1d2e8a7b6c5d';

// ---------------------------------------------------------------------------
// Fixtures: one per tool, shaped like the real details objects
// ---------------------------------------------------------------------------

function listResult(overrides) {
  const worktrees = [
    { name: 'principal', path: '/repo', branch: 'main', thread: null, issues: [], assignedOdd: null, odd: [], status: 'live', kind: 'principal' },
    { name: 'feat-cards', path: '/repo/feat-cards', branch: 'feat/cards', thread: THREAD_ID, issues: [12, 13], assignedOdd: 'odd/native-tool-output.md', odd: ['odd/a.md', 'odd/b.md'], status: 'live', kind: 'agent' },
    { name: 'feat-gone', path: '/repo/feat-gone', branch: 'feat/gone', thread: 'unknown', issues: [], assignedOdd: null, odd: [], status: 'missing', kind: 'agent' },
    { name: 'stray-x', path: '/repo/stray-x', branch: 'feat/stray', thread: null, issues: [], assignedOdd: null, odd: [], status: 'unregistered', kind: 'unregistered' },
  ];
  return {
    content: [{
      type: 'text',
      text: [
        'worktree list: principal main principal',
        `worktree list: feat-cards feat/cards thread=${THREAD_ID} issues=12,13 odd=odd/a.md,odd/b.md`,
        'worktree list: feat-gone feat/gone thread=unknown issues= missing',
        'worktree list: stray-x feat/stray unregistered',
      ].join('\n'),
    }],
    details: { worktrees, count: 4, all: true, pruned: [], warnings: [], pruneError: null },
    ...(overrides || {}),
  };
}

function closeResult(overrides) {
  return {
    content: [{ type: 'text', text: 'removed: feat-cards · feat/cards\nbranch kept' }],
    details: {
      path: '/repo/feat-cards',
      branch: 'feat/cards',
      removed: true,
      branchKept: true,
      thread: THREAD_ID,
    },
    ...(overrides || {}),
  };
}

function sessionOpenResult(overrides) {
  return {
    content: [{ type: 'text', text: 'opened: feat-cards · abc123\npath: /repo/feat-cards' }],
    details: {
      worktree: 'feat-cards',
      branch: 'feat/cards',
      path: '/repo/feat-cards',
      paneId: 'pane-7',
      workspaceId: 'ws-3',
      sessionId: 'abc123',
      resumed: false,
      agentName: 'cards',
      notify: true,
    },
    ...(overrides || {}),
  };
}

function warpResult(overrides) {
  return {
    content: [{
      type: 'text',
      text: 'moved: principal\nto: feat-cards\npath: now in "/repo/feat-cards"\nbranch: now in "feat/cards"',
    }],
    details: {
      tool: 'worktree_warp',
      name: 'feat-cards',
      path: '/repo/feat-cards',
      branch: 'feat/cards',
      kind: 'agent',
      fromName: 'principal',
      fromDesc: 'principal · main',
      from: '/repo',
      to: '/repo/feat-cards',
      alreadyThere: false,
      cancelled: false,
      resumed: false,
    },
    ...(overrides || {}),
  };
}

const FIXTURES = {
  worktree_list: listResult,
  worktree_close: closeResult,
  worktree_session_open: sessionOpenResult,
  worktree_warp: warpResult,
};

// ---------------------------------------------------------------------------
// API contract
// ---------------------------------------------------------------------------

describe('helpful pure API', () => {
  test('exports the formatter and its four-tool coverage', () => {
    assert.strictEqual(typeof formatWorktreeModelResult, 'function');
    assert.deepStrictEqual(
      [...WORKTREE_MODEL_TOOLS].sort(),
      ['worktree_close', 'worktree_list', 'worktree_session_open', 'worktree_warp'],
    );
  });

  // S1: the create tool writes its own short ordered text (`created:`, `path:`,
  // `codegraph:`), so the adapter has no builder for it — and none for the
  // retired `worktree_upsert` name the create replaced. A build that still
  // carried that dead builder is what kept the retired name alive.
  test('the create/upsert family has no builder: its result returns untouched', () => {
    for (const name of ['worktree_create', 'worktree_upsert']) {
      assert.ok(!WORKTREE_MODEL_TOOLS.includes(name), `${name} is not a formatted tool`);
      const result = {
        content: [{ type: 'text', text: 'created: feat-cards \u00B7 feat/cards\npath: /repo/feat-cards' }],
        details: { path: '/repo/feat-cards', branch: 'feat/cards', created: true },
      };
      assert.strictEqual(formatWorktreeModelResult(name, result), result, `${name} keeps its own text`);
    }
  });

  test('an unknown tool name returns the result untouched', () => {
    const result = listResult();
    assert.strictEqual(formatWorktreeModelResult('bash', result), result);
    assert.strictEqual(formatWorktreeModelResult('', result), result);
    assert.strictEqual(formatWorktreeModelResult(undefined, result), result);
  });

  test('a non-object result returns untouched', () => {
    for (const value of [null, undefined, 'text', 42, [], true]) {
      assert.strictEqual(formatWorktreeModelResult('worktree_list', value), value);
    }
  });

  test('formatting is idempotent: the same details always give the same text', () => {
    for (const tool of WORKTREE_MODEL_TOOLS) {
      const once = formatWorktreeModelResult(tool, FIXTURES[tool]());
      const twice = formatWorktreeModelResult(tool, once);
      assert.strictEqual(textOf(twice), textOf(once), `${tool} reformatting changes nothing`);
      assert.strictEqual(twice.details, once.details, `${tool} keeps the same details object`);
    }
  });
});

// ---------------------------------------------------------------------------
// Preservation: the formatter may only rewrite the text content
// ---------------------------------------------------------------------------

describe('preservation contract', () => {
  test('details, isError and extra result fields survive every tool', () => {
    for (const tool of WORKTREE_MODEL_TOOLS) {
      const original = FIXTURES[tool]();
      const before = snapshot(original);
      original.durationMs = 1234;
      const formatted = formatWorktreeModelResult(tool, original);
      assert.notStrictEqual(formatted, original, `${tool}: a known success is rewritten`);
      assert.strictEqual(formatted.details, original.details, `${tool}: details object identity kept`);
      assert.deepStrictEqual(formatted.details, before.details, `${tool}: details byte-equivalent`);
      assert.strictEqual(formatted.durationMs, 1234, `${tool}: extra fields kept`);
      assert.ok(!('isError' in formatted), `${tool}: no isError invented on a success`);
      assert.strictEqual(formatted.content.length, 1, `${tool}: one text entry`);
      assert.strictEqual(formatted.content[0].type, 'text');
    }
  });

  test('non-text content is preserved in order around the one text entry', () => {
    const original = listResult();
    original.content = [
      { type: 'image', data: 'base64-bytes', mimeType: 'image/png' },
      { type: 'text', text: 'worktree list: principal main principal' },
      { type: 'text', text: 'second raw copy' },
    ];
    const formatted = formatWorktreeModelResult('worktree_list', original);
    assert.strictEqual(formatted.content.length, 2, 'the second raw copy is dropped, the image kept');
    assert.deepStrictEqual(formatted.content[0], { type: 'image', data: 'base64-bytes', mimeType: 'image/png' });
    assert.strictEqual(formatted.content[1].type, 'text');
    assert.ok(textOf(formatted).includes('worktrees: 4'));
  });

  test('error results are returned untouched, diagnostics intact', () => {
    const failed = {
      content: [{ type: 'text', text: 'cannot close the worktree at /repo/feat-cards: another live Pi session is active in that checkout (/repo/feat-cards/sub); warp it to the principal and retry' }],
      details: { branch: 'feat/cards', path: '/repo/feat-cards', force: false, agents: [{ cwd: '/repo/feat-cards/sub' }] },
      isError: true,
    };
    assert.strictEqual(formatWorktreeModelResult('worktree_close', failed), failed);
  });

  test('a partial result is returned untouched', () => {
    const partial = listResult();
    partial.isPartial = true;
    assert.strictEqual(formatWorktreeModelResult('worktree_list', partial), partial);
  });

  test('malformed details are returned untouched instead of guessed', () => {
    for (const details of [undefined, null, 'nope', 42, [], {}]) {
      const result = { content: [{ type: 'text', text: 'worktree list: none' }], details };
      assert.strictEqual(
        formatWorktreeModelResult('worktree_list', result),
        result,
        `details ${JSON.stringify(details)} falls back unchanged`,
      );
    }
  });

  test('per-tool evidence gaps fall back unchanged', () => {
    const cases = [
      ['worktree_close', { removed: true }],
      ['worktree_session_open', { notify: true }],
      ['worktree_warp', { kind: 'agent' }],
      ['worktree_list', { count: 0, all: true }],
    ];
    for (const entry of cases) {
      const result = { content: [{ type: 'text', text: 'raw text' }], details: entry[1] };
      assert.strictEqual(formatWorktreeModelResult(entry[0], result), result, `${entry[0]} keeps its raw text`);
    }
  });

  test('a result whose content is not a text array is returned untouched', () => {
    const noContent = { details: listResult().details };
    assert.strictEqual(formatWorktreeModelResult('worktree_list', noContent), noContent);
    const textless = { content: [{ type: 'text' }, { type: 'image', data: 'x' }], details: listResult().details };
    assert.strictEqual(formatWorktreeModelResult('worktree_list', textless), textless);
  });
});

// ---------------------------------------------------------------------------
// Per-tool model text
// ---------------------------------------------------------------------------

// S1 removed issue and ODD associations from every worktree surface, so the
// create tool owns its own text and this adapter formats only the four
// operational tools. Their warning rows are ONE shared derivation: a failed
// step the details carry is surfaced, a skipped one is not, and a hook's
// stdout transcript never enters the model text.
describe('shared warning rows', () => {
  test('a failed step stays visible even without a matching warning', () => {
    const details = {
      ...closeResult().details,
      hooks: {
        ok: false,
        steps: [
          { name: 'copy-env', status: 'failed', detail: 'copied none; source .env is git-ignored', stdout: 'x'.repeat(200) },
          { name: 'install', status: 'skipped', detail: 'skipped because the previous step failed' },
        ],
        warnings: [],
      },
      warnings: [],
    };
    const formatted = formatWorktreeModelResult('worktree_close', closeResult({ details }));
    const rows = linesOf(formatted);
    assert.ok(
      rows.includes('warning: copied none; source .env is git-ignored'),
      'a failed step is a warning the agent must see: ' + JSON.stringify(rows),
    );
    assert.ok(!rows.some((row) => row.includes('skipped because')), 'a skipped step is not a failure');
    assert.ok(!textOf(formatted).includes('x'.repeat(20)), 'hook stdout is never copied');
  });

  test('a warning the details already summarize is printed once, without transcripts', () => {
    const warning = 'creation hooks failed: copy-env exited 1';
    const details = {
      ...closeResult().details,
      hooks: {
        ok: false,
        steps: [{ name: 'copy-env', status: 'failed', detail: warning, stdout: 'x'.repeat(400) }],
        warnings: [warning],
      },
      warnings: [warning, "pruned 1 stale worktree record(s) via 'git worktree prune': /repo/dead; git no longer records the missing checkout"],
    };
    const formatted = formatWorktreeModelResult('worktree_close', closeResult({ details }));
    const rows = linesOf(formatted);
    assert.strictEqual(rows.filter((row) => row === `warning: ${warning}`).length, 1, 'no duplicated warning: ' + JSON.stringify(rows));
    assert.ok(rows.some((row) => row.startsWith('warning: pruned 1 stale worktree record(s)')), 'prune warning kept');
    assert.ok(!textOf(formatted).includes('x'.repeat(50)), 'hook stdout never enters the model text');
  });
});

describe('worktree_list model text', () => {
  test('count plus one stable row per checkout, and no association cell', () => {
    // S6: being listed IS the existence proof (a checkout whose path is gone
    // is pruned, never listed), so `live` is not a cell; `kind` was a second
    // spelling of what the row already said (`principal` repeated the name,
    // `agent` repeated "a registered worktree", `unregistered` repeated the
    // status). What survives is the state that changes how the row reads.
    // S1 removed the issue/ODD association column from every worktree display,
    // so a row is the checkout's identity plus that one state.
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_list', listResult())), [
      'worktrees: 4 (name · branch · path)',
      'principal · main · /repo',
      'feat-cards · feat/cards · /repo/feat-cards',
      'feat-gone · feat/gone · /repo/feat-gone · missing',
      'stray-x · feat/stray · /repo/stray-x · unregistered',
    ]);
  });

  test('S6: no redundant existence status and no repeated kind cell, ever', () => {
    const text = textOf(formatWorktreeModelResult('worktree_list', listResult()));
    assert.ok(!/\blive\b/.test(text), 'the redundant live status never reaches the model: ' + text);
    assert.ok(!/\bexists\b/.test(text), 'the same for an exists spelling: ' + text);
    assert.ok(!/\bagent\b/.test(text), 'the ordinary registered kind is not a cell: ' + text);
    assert.ok(!text.includes('principal · live'), 'no principal kind cell either: ' + text);
    assert.strictEqual(
      text.split('\n').filter((row) => row.startsWith('principal · ')).length,
      1,
      'the principal checkout is one row: ' + text,
    );
  });

  test('S6: unregistered is stated once and stays distinct from missing', () => {
    const rows = linesOf(formatWorktreeModelResult('worktree_list', listResult()));
    const stray = rows.find((row) => row.startsWith('stray-x · '));
    assert.strictEqual(stray, 'stray-x · feat/stray · /repo/stray-x · unregistered', 'one unregistered cell: ' + stray);
    assert.strictEqual(
      stray.split('unregistered').length - 1,
      1,
      'the unregistered word appears exactly once in its row: ' + stray,
    );
    const gone = rows.find((row) => row.startsWith('feat-gone · '));
    assert.ok(gone.endsWith(' · missing'), 'missing stays its own distinct state: ' + gone);
    assert.ok(!stray.includes('missing'), 'a live-but-unowned checkout is not missing: ' + stray);
    assert.ok(!gone.includes('unregistered'), 'a registered checkout is not unregistered: ' + gone);
    assert.strictEqual(rows.filter((row) => row.endsWith(' · missing')).length, 1, 'one missing row: ' + JSON.stringify(rows));
    assert.strictEqual(rows.filter((row) => row.endsWith(' · unregistered')).length, 1, 'one unregistered row: ' + JSON.stringify(rows));
  });

  test('S6: a kind the identity does not already carry is still surfaced', () => {
    // The ordinary kinds collapse because the row already states them. A kind
    // that is neither ordinary nor a repeat of the row's own words is a fact
    // the details carry, so it is never dropped.
    const details = {
      worktrees: [{ name: 'odd-one', path: '/repo/odd-one', branch: 'feat/odd', thread: null, status: 'live', kind: 'foreign' }],
      count: 1,
      all: false,
      pruned: [],
      warnings: [],
    };
    assert.deepStrictEqual(
      linesOf(formatWorktreeModelResult('worktree_list', listResult({ details }))),
      ['worktrees: 1 (name · branch · path)', 'odd-one · feat/odd · /repo/odd-one · foreign'],
    );
  });

  test('S6: a kind that only repeats an existence state earns no cell either', () => {
    // `live`/`exists` are the existence states the listing itself already
    // proves, so a producer that also spells one as `kind` must not buy a
    // second cell for it. The details keep the field — only the text drops it.
    const worktrees = [
      { name: 'feat-a', path: '/repo/feat-a', branch: 'feat/a', thread: null, status: 'live', kind: 'live' },
      { name: 'feat-b', path: '/repo/feat-b', branch: 'feat/b', thread: null, status: 'exists', kind: 'exists' },
    ];
    const result = formatWorktreeModelResult('worktree_list', listResult({
      details: { worktrees, count: 2, all: false, pruned: [], warnings: [] },
    }));
    assert.deepStrictEqual(linesOf(result), [
      'worktrees: 2 (name · branch · path)',
      'feat-a · feat/a · /repo/feat-a',
      'feat-b · feat/b · /repo/feat-b',
    ], 'neither existence spelling reaches the text: ' + textOf(result));
    assert.deepStrictEqual(result.details.worktrees, worktrees, 'the structured details keep every field');
  });

  test('thread ids, raw prefixes and associations never reach the model', () => {
    const text = textOf(formatWorktreeModelResult('worktree_list', listResult()));
    assert.ok(!text.includes(THREAD_ID), 'no thread id: ' + text);
    assert.ok(!text.includes('thread='), 'no thread= key: ' + text);
    assert.ok(!text.includes('odd='), 'no odd= key: ' + text);
    assert.ok(!text.includes('worktree list:'), 'no repeated legacy prefix: ' + text);
    assert.ok(!/issues/i.test(text), 'no issue label or number anywhere: ' + text);
    assert.ok(!/odd/i.test(text), 'no ODD label or document anywhere: ' + text);
  });

  // S1: a worktree carries no issue and no ODD association. The stored legacy
  // fields the registry still keeps are data preservation, not display: the
  // listing text must be identical whether the details carry them or not.
  test('legacy registry associations never change the listing text', () => {
    const withLegacy = linesOf(formatWorktreeModelResult('worktree_list', listResult()));
    const stripped = listResult({
      details: {
        ...listResult().details,
        worktrees: listResult().details.worktrees.map((row) => {
          const { issues, assignedOdd, odd, ...rest } = row;
          void issues; void assignedOdd; void odd;
          return rest;
        }),
      },
    });
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_list', stripped)), withLegacy);
    const text = textOf(formatWorktreeModelResult('worktree_list', listResult()));
    assert.ok(!text.includes('#12') && !text.includes('native-tool-output'), 'no association value: ' + text);
    assert.ok(!text.includes('a.md') && !text.includes('b.md'), 'no document inventory: ' + text);
    assert.ok(!text.includes(' -'), 'no bare association placeholder column: ' + text);
  });

  test('a 100-document inventory never enters the text and details stay byte-equivalent', () => {
    const original = listResult();
    const inventory = Array.from({ length: 100 }, (_unused, index) => `odd/inventory-${index}.md`);
    original.details.worktrees = original.details.worktrees.map((row) => ({ ...row, odd: inventory.slice() }));
    original.details.count = original.details.worktrees.length;
    const before = snapshot(original.details);
    const formatted = formatWorktreeModelResult('worktree_list', original);
    const text = textOf(formatted);
    assert.ok(!text.includes('inventory-'), 'no available-document names in the text: ' + text);
    assert.ok(!text.includes('odd'), 'no odd segment at all: ' + text);
    assert.deepStrictEqual(formatted.details, before, 'details keep every document');
    assert.strictEqual(formatted.details.worktrees[0].odd.length, 100);
  });

  test('100 checkouts keep one row each: nothing is truncated away', () => {
    const worktrees = [];
    for (let index = 0; index < 100; index += 1) {
      worktrees.push({
        name: `feat-${index}`,
        path: `/repo/wt/feat-${index}`,
        branch: `feat/branch-${index}`,
        thread: `thread-${index}`,
        issues: index % 2 === 0 ? [index] : [],
        odd: [`odd/doc-${index}.md`],
        status: index === 99 ? 'missing' : 'live',
        kind: 'agent',
      });
    }
    const original = listResult();
    original.details = { worktrees, count: 100, all: false, pruned: [], warnings: [], pruneError: null };
    const rows = linesOf(formatWorktreeModelResult('worktree_list', original));
    assert.strictEqual(rows.length, 101, 'one header plus one row per checkout');
    assert.strictEqual(rows[0], 'worktrees: 100 (name · branch · path)');
    for (let index = 0; index < 100; index += 1) {
      const state = index === 99 ? ' · missing' : '';
      assert.strictEqual(
        rows[index + 1],
        `feat-${index} · feat/branch-${index} · /repo/wt/feat-${index}${state}`,
        `row ${index} is the checkout's identity plus its state: ${rows[index + 1]}`,
      );
    }
  });

  test('listing warnings and prune errors stay visible once', () => {
    const warning = "pruned 2 stale worktree path(s) from the registry: /repo/a, /repo/b; git may still record the checkout until 'git worktree prune'";
    const details = { ...listResult().details, warnings: [warning], pruneError: 'EACCES: registry write denied' };
    const rows = linesOf(formatWorktreeModelResult('worktree_list', listResult({ details })));
    assert.ok(rows.includes(`warning: ${warning}`), 'the prune warning is kept verbatim');
    assert.ok(rows.includes('warning: EACCES: registry write denied'), 'the prune error is kept');
    assert.strictEqual(rows.filter((row) => row.startsWith('warning:')).length, 2, 'no duplicated warnings');
    const covered = listResult({ details: { ...details, warnings: [`registry prune failed: EACCES: registry write denied`] } });
    const coveredRows = linesOf(formatWorktreeModelResult('worktree_list', covered));
    assert.strictEqual(coveredRows.filter((row) => row.includes('EACCES')).length, 1, 'an already-covered prune error is not repeated');
  });

  test('an empty listing still says so', () => {
    const empty = listResult({ details: { worktrees: [], count: 0, all: false, pruned: [], warnings: [], pruneError: null } });
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_list', empty)), ['worktrees: 0']);
  });
});

describe('worktree_close model text', () => {
  test('removed target and branch state are reported', () => {
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_close', closeResult())), [
      'outcome: removed',
      'name: feat-cards',
      'branch: feat/cards',
      'path: /repo/feat-cards',
      'branch state: kept',
    ]);
  });

  test('a dropped-association warning, the warp and a skipped workspace all survive together', () => {
    const warning = 'a worktree carries ONE odd document, so the registry kept the first and dropped: "odd/b.md"';
    const details = {
      ...closeResult().details,
      warp: { name: 'principal', path: '/repo', branch: 'main' },
      herdrWorkspace: { status: 'skipped', notice: 'herdr workspace step skipped: no root pane available' },
      warnings: [warning],
      droppedOdd: ['odd/b.md'],
    };
    const rows = linesOf(formatWorktreeModelResult('worktree_close', closeResult({ details })));
    assert.deepStrictEqual(rows, [
      'outcome: removed',
      'name: feat-cards',
      'branch: feat/cards',
      'path: /repo/feat-cards',
      'branch state: kept',
      'session: warped to principal · /repo',
      'herdr workspace: skipped · herdr workspace step skipped: no root pane available',
      `warning: ${warning}`,
    ], 'no meaningful close warning is dropped when several arrive together');
  });

  test('deleted branch, the session warp and a skipped Herdr workspace stay visible', () => {
    const details = {
      ...closeResult().details,
      branchKept: false,
      warp: { name: 'principal', path: '/repo', branch: 'main', sessionFile: '/sessions/abc.jsonl' },
      herdrWorkspace: { status: 'skipped', notice: 'herdr workspace left as it was: no root pane available' },
    };
    const formatted = formatWorktreeModelResult('worktree_close', closeResult({ details }));
    const rows = linesOf(formatted);
    assert.ok(rows.includes('branch state: deleted'));
    assert.ok(rows.includes('session: warped to principal · /repo'), 'the warp target is named: ' + JSON.stringify(rows));
    assert.ok(
      rows.includes('herdr workspace: skipped · herdr workspace left as it was: no root pane available'),
      'a skipped workspace step stays visible: ' + JSON.stringify(rows),
    );
    assert.ok(!textOf(formatted).includes(THREAD_ID), 'no thread id');
    assert.ok(!textOf(formatted).includes('/sessions/abc.jsonl'), 'no session file path');
  });
});

describe('worktree_session_open model text', () => {
  test('opened session keeps its routing ids', () => {
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_session_open', sessionOpenResult())), [
      'outcome: opened',
      'worktree: feat-cards',
      'branch: feat/cards',
      'path: /repo/feat-cards',
      'session: abc123',
      'workspace: ws-3',
      'pane: pane-7',
      'agent: cards',
    ]);
  });

  test('a resumed session says so and omits ids the details do not carry', () => {
    const details = { worktree: 'feat-cards', sessionId: 'abc123', resumed: true, path: '/repo/feat-cards' };
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_session_open', sessionOpenResult({ details }))), [
      'outcome: resumed',
      'worktree: feat-cards',
      'path: /repo/feat-cards',
      'session: abc123',
    ]);
  });
});

describe('worktree_warp model text', () => {
  test('moved names both checkouts and the continuation path', () => {
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_warp', warpResult())), [
      'outcome: moved',
      'from: principal · /repo',
      'to: feat-cards · /repo/feat-cards',
      'branch: feat/cards',
    ]);
  });

  test('already there is an outcome, not a move', () => {
    const details = { tool: 'worktree_warp', name: 'feat-cards', path: '/repo/feat-cards', branch: 'feat/cards', kind: 'agent', alreadyThere: true, cancelled: false };
    assert.deepStrictEqual(linesOf(formatWorktreeModelResult('worktree_warp', warpResult({ details }))), [
      'outcome: already there',
      'to: feat-cards · /repo/feat-cards',
      'branch: feat/cards',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Shared formatting guarantees
// ---------------------------------------------------------------------------

describe('shared formatting guarantees', () => {
  test('no tool prints key=value dumps or legacy raw prefixes', () => {
    for (const tool of WORKTREE_MODEL_TOOLS) {
      const text = textOf(formatWorktreeModelResult(tool, FIXTURES[tool]()));
      assert.ok(!/thread=|issues=|odd=|path=/.test(text), `${tool}: no key=value dump: ${text}`);
      assert.ok(!/^worktree (list|create|close|session open|warp):/m.test(text), `${tool}: no legacy prefix: ${text}`);
      assert.ok(!text.includes('"' + '/repo'), `${tool}: no quoted path prose: ${text}`);
    }
  });

  test('every row is one line: newlines and control characters never reshape it', () => {
    const details = {
      ...closeResult().details,
      branch: 'feat/evil\nsecond-line\x07bell',
      path: '/repo/evil\r\npath',
    };
    const formatted = formatWorktreeModelResult('worktree_close', closeResult({ details }));
    const text = textOf(formatted);
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text), 'no control characters: ' + JSON.stringify(text));
    assert.strictEqual(linesOf(formatted).filter((row) => row.startsWith('branch:')).length, 1, 'one branch row');
    assert.strictEqual(text.includes('second-line'), true, 'the value itself is not dropped');
  });

  test('ANSI escapes in untrusted values are stripped', () => {
    const details = { ...warpResult().details, name: '\x1b[31mfeat-cards\x1b[0m' };
    const text = textOf(formatWorktreeModelResult('worktree_warp', warpResult({ details })));
    assert.ok(!text.includes('\x1b'), 'no escape reaches the model: ' + JSON.stringify(text));
    assert.ok(text.includes('feat-cards'), 'the cleaned value survives');
  });

  test('no field is invented when the details do not carry it', () => {
    const details = { name: 'feat-cards', path: '/repo/feat-cards', branch: 'feat/cards', alreadyThere: false };
    const rows = linesOf(formatWorktreeModelResult('worktree_warp', warpResult({ details })));
    assert.deepStrictEqual(rows, ['outcome: moved', 'to: feat-cards · /repo/feat-cards', 'branch: feat/cards']);
    assert.ok(!rows.some((row) => row.startsWith('from:')), 'no from row without a source: ' + JSON.stringify(rows));
  });
});
