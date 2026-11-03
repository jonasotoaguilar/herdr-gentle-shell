'use strict';
// T6/S13 tests (test-first): reusable native Pi worktree tool card renderer.
//
// The renderer lives in lib/worktree-card.js and is pure rendering: given
// the tool name plus the public render hooks (args/result/options/theme/
// context) it returns Pi component objects ({render(width), invalidate}).
// Tests invoke those public hooks and assert geometry — every line fits the
// supplied width at 30/60/100 columns, collapsed cards stay compact, the
// frame keeps its left-accent structure — plus collapsed/expanded, error/
// partial/empty/malformed details, and one semantic summary per tool.
// S12 adds the two halves of the card contract: the collapsed body says
// only what happened, and the expanded body is ordered, labelled detail
// read from the same details object instead of the raw content dump.
// Text presence alone is never the assertion: width bounds, line budgets
// and frame structure travel with every case.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  createWorktreeCardRenderer,
  createWarpMessageRenderer,
  summarizeWorktreeResult,
  safeText,
} = require('../lib/worktree-card.js');

const TOOLS = ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open', 'worktree_warp'];
const WIDTHS = [30, 60, 100];

// Identity theme: adds no ANSI of its own, so any escape left in a line is
// leaked untrusted input rather than theme paint.
const THEME = {
  bold: (s) => s,
  fg: (_color, s) => s,
};

function stripAnsi(line) {
  // eslint-disable-next-line no-control-regex
  return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
}

function visible(line) {
  return [...stripAnsi(line)].length;
}

function renderLines(component, width) {
  const lines = component.render(width);
  assert.ok(Array.isArray(lines), 'component.render(width) returns string[]');
  for (const line of lines) assert.strictEqual(typeof line, 'string');
  return lines;
}

function assertFits(lines, width) {
  for (const line of lines) {
    assert.ok(
      visible(line) <= width,
      `line exceeds width ${width}: ${JSON.stringify(stripAnsi(line))}`,
    );
  }
}

function assertFrame(lines) {
  assert.ok(lines.length > 0, 'card renders at least one row');
  for (const line of lines) {
    assert.ok(
      stripAnsi(line).startsWith('▎'),
      `every row carries the accent bar: ${JSON.stringify(stripAnsi(line))}`,
    );
  }
}

function callFor(tool) {
  switch (tool) {
    case 'worktree_create': return { branch: 'feat/cards' };
    case 'worktree_list': return { all: true };
    case 'worktree_close': return { name: 'feat-cards' };
    case 'worktree_session_open': return { worktree: 'feat-cards' };
    case 'worktree_warp': return { name: 'feat-cards' };
    default: throw new Error(`unknown tool ${tool}`);
  }
}

function resultFor(tool) {
  switch (tool) {
    case 'worktree_create':
      return {
        content: [{ type: 'text', text: 'created: feat-cards \u00B7 feat/cards\npath: /repo/../feat-cards\ncodegraph: initialized' }],
        details: { path: '/repo/../feat-cards', branch: 'feat/cards', registered: 'new', codegraph: { status: 'done', detail: '' }, warnings: [] },
      };
    case 'worktree_list':
      return {
        content: [{ type: 'text', text: 'worktree list: feat-cards feat/cards thread=t issues=12' }],
        details: {
          worktrees: [{ name: 'feat-cards', path: '/repo/../feat-cards', branch: 'feat/cards', assignedOdd: null, odd: [] }],
          count: 1, all: true, pruned: [], warnings: [],
        },
      };
    case 'worktree_close':
      return {
        content: [{ type: 'text', text: 'worktree close: /repo/../feat-cards' }],
        details: { path: '/repo/../feat-cards', branch: 'feat/cards', removed: true, branchKept: true },
      };
    case 'worktree_session_open':
      return {
        content: [{ type: 'text', text: 'opened: feat-cards · abc123\npath: /repo/../feat-cards' }],
        details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: false, paneId: 'p1', path: '/repo/../feat-cards' },
      };
    case 'worktree_warp':
      return {
        content: [{ type: 'text', text: 'moved: principal\nto: feat-cards\npath: now in "/repo/../feat-cards"\nbranch: now in "feat/cards"' }],
        details: { fromName: 'principal', fromDesc: 'principal · main', name: 'feat-cards', branch: 'feat/cards', path: '/repo/../feat-cards', to: '/repo/../feat-cards' },
      };
    default: throw new Error(`unknown tool ${tool}`);
  }
}

// The Pi host (dist/modes/interactive/components/tool-execution.js) shares ONE
// rendererState object across the call and result renders of a tool row and
// re-invokes both renderers on every update; renderResult marks that state,
// which is what turns the paired call card into the card's top rule (no
// closing rule of its own). `settledCard` replays that order through the
// public hooks, so a test can read the WHOLE card — top rule, body, closing
// rule — the way the transcript shows it.
function settledCard(tool, options) {
  const opts = options || {};
  const width = opts.width === undefined ? 60 : opts.width;
  const theme = opts.theme || THEME;
  const card = createWorktreeCardRenderer(tool);
  const state = {};
  const context = {
    state,
    isPartial: false,
    expanded: opts.expanded === true,
    durationMs: opts.durationMs,
    outputPad: opts.outputPad === undefined ? 0 : opts.outputPad,
  };
  const expanded = opts.expanded === true;
  const body = renderLines(
    card.renderResult(resultFor(tool), { expanded, isPartial: false }, theme, context), width);
  const top = renderLines(card.renderCall(callFor(tool), theme, context), width);
  return { card, state, context, top, body, lines: [...top, ...body] };
}

describe('factory contract', () => {
  test('exposes renderShell self plus renderCall/renderResult for every tool', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      assert.strictEqual(card.renderShell, 'self');
      assert.strictEqual(typeof card.renderCall, 'function');
      assert.strictEqual(typeof card.renderResult, 'function');
    }
  });

  test('rejects unknown tool names instead of rendering a blank card', () => {
    assert.throws(() => createWorktreeCardRenderer('bash'), /unknown worktree tool/);
  });

  test('renders deterministically: no leaking timer between passes', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const result = resultFor('worktree_list');
    const first = renderLines(card.renderResult(result, {}, THEME, {}), 60).join('\n');
    const second = renderLines(card.renderResult(result, {}, THEME, {}), 60).join('\n');
    assert.strictEqual(first, second);
  });
});

describe('renderCall geometry', () => {
  for (const tool of TOOLS) {
    test(`${tool}: header fits 30/60/100 and keeps the accent frame`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const width of WIDTHS) {
        const lines = renderLines(card.renderCall(callFor(tool), THEME, {}), width);
        assertFits(lines, width);
        assertFrame(lines);
        assert.ok(lines.length <= 4, `call card stays compact at ${width}: got ${lines.length} rows`);
      }
    });

    test(`${tool}: malformed args never throw and still fit`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const bad of [undefined, null, 'feat/x', 42, { branch: { nested: true } }]) {
        const lines = renderLines(card.renderCall(bad, THEME, {}), 60);
        assertFits(lines, 60);
        assertFrame(lines);
      }
    });
  }

  test('narrow widths truncate, zero width renders nothing', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const narrow = renderLines(
      card.renderCall({ branch: 'feat/a-very-long-branch-name-that-keeps-going', issues: [1] }, THEME, {}),
      10,
    );
    assertFits(narrow, 10);
    assertFrame(narrow);
    assert.deepStrictEqual(card.renderCall({ branch: 'feat/x' }, THEME, {}).render(0), []);
  });

  test('ANSI in args is stripped: no raw escape leaks with an identity theme', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const lines = renderLines(
      card.renderCall({ branch: '\x1b[31mfeat/evil\x1b[0m', issues: [1] }, THEME, {}),
      60,
    );
    for (const line of lines) assert.ok(!line.includes('\x1b'), `escape leaked: ${JSON.stringify(line)}`);
  });
});

describe('renderResult geometry and states', () => {
  for (const tool of TOOLS) {
    test(`${tool}: collapsed result fits 30/60/100 inside a compact frame`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const width of WIDTHS) {
        const lines = renderLines(card.renderResult(resultFor(tool), { expanded: false }, THEME, {}), width);
        assertFits(lines, width);
        assertFrame(lines);
        assert.ok(lines.length <= 6, `collapsed card stays compact at ${width}: got ${lines.length} rows`);
      }
    });

    // S12: with usable details the expanded body formats them instead of
    // echoing the content text, so the FALLBACK is what this pins — a
    // result the details cannot describe still reaches the reader whole.
    test(`${tool}: expanded keeps a result the details cannot describe`, () => {
      const card = createWorktreeCardRenderer(tool);
      const longText = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n');
      const result = { content: [{ type: 'text', text: longText }], details: {} };
      const collapsed = renderLines(card.renderResult(result, { expanded: false }, THEME, {}), 100);
      const expanded = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 100);
      assertFits(expanded, 100);
      assertFrame(expanded);
      assert.ok(expanded.length >= collapsed.length, 'expanded shows at least as much as collapsed');
      for (const line of ['line four', 'line five']) {
        assert.ok(expanded.join('\n').includes(line), `expanded keeps ${JSON.stringify(line)}`);
      }
      assert.ok(
        collapsed.join('\n').split('\n').length <= 6,
        'collapsed stays bounded while expanded grows',
      );
    });

    test(`${tool}: error results keep the frame and surface the failure`, () => {
      const card = createWorktreeCardRenderer(tool);
      const failed = {
        content: [{ type: 'text', text: 'worktree exploded: bad things happened' }],
        details: resultFor(tool).details,
        isError: true,
      };
      const lines = renderLines(card.renderResult(failed, { expanded: false }, THEME, {}), 60);
      assertFits(lines, 60);
      assertFrame(lines);
      assert.ok(lines.join('\n').includes('bad things happened'), 'error text reaches the card');
    });

    test(`${tool}: partial results stay bounded and marked as running`, () => {
      const card = createWorktreeCardRenderer(tool);
      const lines = renderLines(card.renderResult(resultFor(tool), { expanded: false, isPartial: true }, THEME, {}), 60);
      assertFits(lines, 60);
      assertFrame(lines);
      assert.ok(lines.join('\n').includes('…'), 'partial card carries the running marker');
    });

    test(`${tool}: malformed details never throw and still fit`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const details of [undefined, null, 'nope', 42, []]) {
        const lines = renderLines(
          card.renderResult({ content: [{ type: 'text', text: 'some text' }], details }, {}, THEME, {}),
          60,
        );
        assertFits(lines, 60);
        assertFrame(lines);
      }
    });
  }

  test('empty result text renders a placeholder inside the frame', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const lines = renderLines(
      card.renderResult({ content: [{ type: 'text', text: '' }], details: { worktrees: [], count: 0 } }, {}, THEME, {}),
      60,
    );
    assertFits(lines, 60);
    assertFrame(lines);
    assert.ok(lines.join('\n').includes('(no output)'), 'empty result says so');
  });

  test('warnings travel in the expanded body', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const result = resultFor('worktree_create');
    result.details.warnings = ['pruned 1 stale worktree record(s)'];
    const expanded = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 100);
    assert.ok(expanded.join('\n').includes('pruned 1 stale'), 'warning survives expansion');
  });

  test('duration only renders from lifecycle evidence, never fabricated', () => {
    const card = createWorktreeCardRenderer('worktree_close');
    const plain = renderLines(card.renderResult(resultFor('worktree_close'), {}, THEME, {}), 60).join('\n');
    assert.ok(!plain.includes('1.2s'), 'no duration without evidence');
    const timed = renderLines(
      card.renderResult(resultFor('worktree_close'), {}, THEME, { durationMs: 1200 }),
      60,
    );
    assertFits(timed, 60);
    assert.ok(timed.join('\n').includes('1.2s'), 'evidence-backed duration renders');
  });
});

describe('semantic summaries', () => {
  test('create names the branch', () => {
    assert.ok(summarizeWorktreeResult('worktree_create', resultFor('worktree_create')).includes('feat/cards'));
  });

  test('list reports the checkout count', () => {
    const summary = summarizeWorktreeResult('worktree_list', resultFor('worktree_list'));
    assert.ok(summary.includes('1'), `count visible in ${JSON.stringify(summary)}`);
  });

  test('list with zero checkouts says so', () => {
    const summary = summarizeWorktreeResult('worktree_list', {
      content: [{ type: 'text', text: 'worktree list: none' }],
      details: { worktrees: [], count: 0 },
    });
    assert.ok(/no worktrees/i.test(summary), `empty listing reads clearly: ${JSON.stringify(summary)}`);
  });

  test('close names the removed checkout', () => {
    const summary = summarizeWorktreeResult('worktree_close', resultFor('worktree_close'));
    assert.ok(summary.includes('feat-cards'), `removed path visible in ${JSON.stringify(summary)}`);
  });

  test('session_open names the worktree and session', () => {
    const summary = summarizeWorktreeResult('worktree_session_open', resultFor('worktree_session_open'));
    assert.ok(summary.includes('feat-cards'), 'worktree visible');
    assert.ok(summary.includes('abc123'), 'session visible');
  });

  test('error results summarize as errors without hiding the message', () => {
    const summary = summarizeWorktreeResult('worktree_create', {
      content: [{ type: 'text', text: 'invalid branch name "a..b": bad pattern' }],
      details: { branch: 'a..b' },
      isError: true,
    });
    assert.ok(summary.includes('a..b'), `failing input stays visible: ${JSON.stringify(summary)}`);
  });

  test('safeText strips escapes and control characters', () => {
    assert.ok(!safeText('\x1b[31mhi\x1b[0m\x07').includes('\x1b'));
    assert.strictEqual(typeof safeText(undefined), 'string');
  });
});

describe('call/result pair coherence', () => {
  // renderShell:self draws ONE coherent card: while no result exists the
  // call closes its own frame; once the result marks the shared row state,
  // the call drops to the top rule and the result body closes the frame.
  // Two independent full cards stacked is the defect this pins.
  test('call drops its closing rule once the shared row state carries a result', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const state = {};
    const callArgs = { branch: 'feat/cards', issues: [12] };
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const lone = card.renderCall(callArgs, theme, { state }).render(60);
    assert.ok(lone.some((line) => line.includes('─')), 'awaiting call closes its own frame');
    const loneRows = lone.length;
    card.renderResult(resultFor('worktree_create'), { expanded: false }, theme, { state });
    const paired = card.renderCall(callArgs, theme, { state }).render(60);
    assert.ok(paired.length < loneRows, 'paired call drops to the top rule');
    assert.ok(!paired.some((line) => line.includes('─')), 'paired call leaves the closing rule to the result');
    const body = card.renderResult(resultFor('worktree_create'), { expanded: false }, theme, { state }).render(60);
    assert.ok(body.some((line) => line.includes('─')), 'the result closes the shared frame');
  });

  test('options.durationMs is ignored: only host context timing renders', () => {
    const card = createWorktreeCardRenderer('worktree_close');
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const lines = card.renderResult(resultFor('worktree_close'), { durationMs: 1200 }, theme, {}).render(60);
    assert.ok(!lines.join('\n').includes('1.2s'), 'uncontracted options timing never renders');
  });
});

describe('extension wiring', () => {
  // The five registered tools carry the card hooks from the REAL
  // extension module (loaded through the repo harness), without touching
  // execute/schemas/content/details. Helpers resolve through the
  // injectable seam, so tests prove runtime injection — including real
  // pi-tui width measurement over emoji — instead of the local fallback.
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');

  const LIB_DIR = path.resolve(__dirname, '../lib');
  const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

  // Isolated mode state: registration and render hints read the worktree
  // mode flag, so the ambient user's flag must never decide these fixtures.
  // A missing mode file means enabled.
  let modeDir = null;
  function wiredModeDir() {
    if (modeDir === null) modeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-card-mode-'));
    return modeDir;
  }
  after(() => {
    if (modeDir !== null) fs.rmSync(modeDir, { recursive: true, force: true });
  });

  async function loadWiredExtension() {
    const srcText = fs.readFileSync(SRC, 'utf8');
    const stubbed = srcText
      .replace(
        'import { Type } from "@earendil-works/pi-ai";',
        'const Type = { Object: (p) => p, String: (o) => o, Number: (o) => o, Array: (i, o) => o, Boolean: (o) => o, Optional: (s) => s };',
      )
      .replace(
        'import { defineTool } from "@earendil-works/pi-coding-agent";',
        'const defineTool = (def) => def;',
      );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-card-wire-'));
    try {
      const copy = path.join(dir, 'gentle-worktree-tools.mjs');
      fs.writeFileSync(copy, stubbed);
      const tools = new Map();
      const pi = { registerTool: (tool) => { tools.set(tool.name, tool); }, registerCommand: () => {}, on: () => () => {} };
      // The card hooks resolve lib/ at module evaluation time, so the lib
      // dir must be set before the import — like every other suite's
      // setEnv-before-loadExtension pattern. The mode dir stays set for the
      // file's lifetime: render hooks read it too.
      process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
      process.env.GENTLE_STATUS_STATE_DIR = wiredModeDir();
      const mod = await import(pathToFileURL(copy).href);
      mod.default(pi);
      return { mod, tools };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const WIRED = ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open', 'worktree_warp'];

  test('all five tools expose renderShell self with renderCall/renderResult hooks', async () => {
    const { tools } = await loadWiredExtension();
    for (const name of WIRED) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} is registered while enabled`);
      assert.strictEqual(tool.renderShell, 'self', `${name} draws its own shell`);
      assert.strictEqual(typeof tool.renderCall, 'function', `${name} wires renderCall`);
      assert.strictEqual(typeof tool.renderResult, 'function', `${name} wires renderResult`);
      assert.strictEqual(typeof tool.execute, 'function', `${name} keeps its execute`);
      assert.ok(tool.parameters, `${name} keeps its schema`);
    }
  });

  test('wired hooks render fitting framed components for every tool', async () => {
    const { tools } = await loadWiredExtension();
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const argsFor = {
      worktree_create: { branch: 'feat/cards' },
      worktree_list: { all: true },
      worktree_close: { name: 'feat-cards' },
      worktree_session_open: { worktree: 'feat-cards' },
      worktree_warp: { name: 'feat-cards' },
    };
    for (const name of WIRED) {
      const tool = tools.get(name);
      for (const width of [30, 60, 100]) {
        for (const lines of [
          tool.renderCall(argsFor[name], theme, {}).render(width),
          tool.renderResult(
            { content: [{ type: 'text', text: `${name} ok` }], details: {} },
            { expanded: false },
            theme,
            {},
          ).render(width),
        ]) {
          assert.ok(lines.length > 0 && lines.length <= 6, `${name} stays compact at ${width}`);
          for (const line of lines) {
            assert.ok([...line].length <= width, `${name} fits ${width}: ${JSON.stringify(line)}`);
          }
        }
      }
    }
  });

  test('injected helpers reach the hooks: real pi-tui measures emoji width', async () => {
    const { mod, tools } = await loadWiredExtension();
    assert.strictEqual(typeof mod.setWorktreeCardHelpers, 'function', 'expected the injectable card helpers seam');
    let realTui = null;
    try {
      realTui = require('@earendil-works/pi-tui');
    } catch {
      realTui = null;
    }
    if (!realTui || typeof realTui.visibleWidth !== 'function') {
      return;
    }
    let measured = 0;
    mod.setWorktreeCardHelpers({
      visibleWidth: (s) => { measured += 1; return realTui.visibleWidth(s); },
      truncateToWidth: (s, w, e) => realTui.truncateToWidth(s, w, e),
    });
    try {
      const theme = { bold: (s) => s, fg: (_c, s) => s };
      const tool = tools.get('worktree_create');
      const lines = tool.renderCall({ branch: 'feat/👍👍', issues: [1] }, theme, {}).render(30);
      assert.ok(measured > 0, 'the hook measures through the injected helpers');
      for (const line of lines) {
        assert.ok(realTui.visibleWidth(line) <= 30, `emoji-aware fit at 30: ${JSON.stringify(line)}`);
      }
    } finally {
      mod.setWorktreeCardHelpers(undefined);
    }
  });

  test('resetting the seam returns renders to the stable auto resolution', async () => {
    const { mod, tools } = await loadWiredExtension();
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const tool = tools.get('worktree_list');
    const before = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    let calls = 0;
    mod.setWorktreeCardHelpers({
      visibleWidth: (s) => { calls += 1; return [...String(s)].length; },
      truncateToWidth: (s, w) => [...String(s)].slice(0, w).join(''),
    });
    const injected = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    assert.ok(calls > 0, 'injected helpers measure while set');
    assert.strictEqual(typeof injected, 'string');
    mod.setWorktreeCardHelpers(undefined);
    const after = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    assert.strictEqual(after, before, 'reset renders exactly the pre-injection output');
    const again = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    assert.strictEqual(again, before, 'auto resolution stays stable across renders');
  });
});

describe('outputPad contract', () => {
  // Installed Pi 1.3.0 ToolRenderContext (dist/core/extensions/types.d.ts)
  // carries outputPad (0|1, default 1) with the explicit rule that
  // renderShell:self renderers apply it themselves: the host wraps self
  // cards in a plain Container with no padding (tool-execution.js), while
  // default-shell content goes through setPaddingX(outputPad) on both
  // sides (pi-tui Text: content width − 2×pad, one margin each side).
  const theme = { bold: (s) => s, fg: (_c, s) => s };

  test('nonzero outputPad pads both sides and keeps content inside width-2', () => {
    for (const tool of ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open']) {
      const card = createWorktreeCardRenderer(tool);
      const ctx = { outputPad: 1, state: {} };
      for (const width of [30, 60]) {
        const call = card.renderCall({ branch: 'feat/cards' }, theme, ctx).render(width);
        const result = card.renderResult(
          { content: [{ type: 'text', text: `${tool} ok` }], details: {} },
          { expanded: false },
          theme,
          { outputPad: 1, state: {} },
        ).render(width);
        for (const lines of [call, result]) {
          assert.ok(lines.length > 0, `${tool} renders rows at ${width}`);
          for (const line of lines) {
            const plain = stripAnsi(line);
            assert.ok(visible(line) <= width, `${tool} exceeds ${width}: ${JSON.stringify(plain)}`);
            assert.ok(plain.startsWith(' ') && plain.endsWith(' '), `${tool} applies pad on both sides: ${JSON.stringify(plain)}`);
            assert.ok([...plain.slice(1, -1)].length <= width - 2, `${tool} content fits ${width}-2`);
          }
        }
      }
    }
  });

  test('absent outputPad keeps the unpadded shape', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const lines = card.renderCall({ all: true }, theme, {}).render(60);
    assert.ok(lines.length > 0);
    assert.ok(stripAnsi(lines[0]).startsWith('▎'), 'no pad configured, frame leads the row');
  });

  for (const width of [0, 1, 2, 3]) {
    test(`width ${width} never exceeds the viewport`, () => {
      const card = createWorktreeCardRenderer('worktree_create');
      const theme = { bold: (s) => s, fg: (_c, s) => s };
      const sets = [
        card.renderCall({ branch: 'feat/cards' }, theme, {}).render(width),
        card.renderResult(
          { content: [{ type: 'text', text: 'worktree create: /r/feat-cards' }], details: {} },
          { expanded: false },
          theme,
          {},
        ).render(width),
      ];
      for (const lines of sets) {
        for (const line of lines) {
          assert.ok(visible(line) <= width, `width ${width} exceeded: ${JSON.stringify(stripAnsi(line))}`);
        }
      }
      if (width === 0) {
        for (const lines of sets) assert.deepStrictEqual(lines, []);
      } else {
        for (const lines of sets) assert.ok(lines.length > 0, `width ${width} still draws`);
      }
    });
  }

  test('unicode branch names fit narrow widths through real measurement', () => {
    let real = null;
    try {
      real = require('@earendil-works/pi-tui');
    } catch {
      real = null;
    }
    if (!real || typeof real.visibleWidth !== 'function' || typeof real.truncateToWidth !== 'function') {
      return;
    }
    const card = createWorktreeCardRenderer('worktree_create', {
      visibleWidth: real.visibleWidth,
      truncateToWidth: (text, width, ellipsis) => real.truncateToWidth(text, width, ellipsis),
    });
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const lines = card.renderCall({ branch: 'feat/日本語👍' }, theme, {}).render(8);
    assert.ok(lines.length > 0, 'narrow unicode call still draws');
    for (const line of lines) {
      assert.ok(real.visibleWidth(line) <= 8, `unicode row exceeds 8: ${JSON.stringify(stripAnsi(line))}`);
    }
  });
});

describe('lifecycle coherence', () => {
  // The host (tool-execution.js getRenderContext/updateDisplay) shares ONE
  // rendererState object across call/result renders and re-invokes both
  // renderers on every update; durationMs is undefined while partial and
  // options carry only expanded/isPartial. The sequence below replays that
  // order through the public hooks: running call, settled result, then a
  // re-rendered call that must join the same frame instead of doubling it.
  const theme = { bold: (s) => s, fg: (_c, s) => s };

  function hostCtx(state, over = {}) {
    return {
      args: { branch: 'feat/cards' },
      toolCallId: 'call_1',
      invalidate: () => {},
      lastComponent: undefined,
      state,
      cwd: '/repo',
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 0,
      ...over,
    };
  }

  function closers(lines) {
    return lines.filter((line) => stripAnsi(line).includes('─')).length;
  }

  function running(lines) {
    const text = lines.map(stripAnsi).join('\n');
    return text.includes('running') || text.includes('receiving');
  }

  test('call → result → call re-render forms one frame with no stale running line', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const state = {};
    const args = { branch: 'feat/cards' };
    const ok = {
      content: [{ type: 'text', text: 'created: feat-cards \u00B7 feat/cards\npath: /r/feat-cards\ncodegraph: initialized' }],
      details: { path: '/r/feat-cards', branch: 'feat/cards', codegraph: { status: 'done', detail: '' } },
    };
    const runningCall = card.renderCall(args, theme, hostCtx(state)).render(60);
    assert.ok(runningCall.length > 0, 'running call draws');
    assert.ok(running(runningCall), 'running call says so');
    assert.strictEqual(closers(runningCall), 1, 'awaiting call closes its own frame');
    const body = card.renderResult(ok, { expanded: false, isPartial: false }, theme, hostCtx(state, {
      isPartial: false,
      durationMs: 1200,
    })).render(60);
    assert.ok(!running(body), 'settled body carries no running marker');
    assert.strictEqual(closers(body), 1, 'result closes the shared frame');
    assert.ok(body.join('\n').includes('1.2s'), 'settled host duration renders');
    const pairedCall = card.renderCall(args, theme, hostCtx(state, { isPartial: false, durationMs: 1200 })).render(60);
    assert.ok(!running(pairedCall), 're-rendered call drops the stale running line');
    assert.strictEqual(closers(pairedCall), 0, 'paired call leaves the closing rule to the result');
    const combined = [...pairedCall, ...body].map(stripAnsi).join('\n');
    assert.strictEqual(closers([...pairedCall, ...body]), 1, 'one frame, one closing rule across the pair');
    assert.ok(combined.includes('worktree create'), 'header survives on the call side');
    assert.ok(combined.includes('feat/cards'), 'summary survives on the result side');
  });
});

describe('worktree git-identity compact cards (S19 RED)', () => {
  const DOCUMENTED_ROLES = ['warning', 'error', 'muted'];

  function recorder() {
    const roles = [];
    const theme = {
      bold: (s) => s,
      fg: (role, s) => { roles.push(role); return s; },
    };
    return { theme, roles };
  }

  function bodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  function closer(lines) {
    const found = lines.map((line) => stripAnsi(line)).filter((line) => line.includes('\u2500'));
    assert.equal(found.length, 1, 'one closing rule, got ' + JSON.stringify(lines));
    return found[0];
  }

  test('every header carries the branch glyph in the warning role', () => {
    for (const tool of TOOLS) {
      const rec = recorder();
      const card = createWorktreeCardRenderer(tool);
      const lines = renderLines(card.renderCall(callFor(tool), rec.theme, {}), 60);
      const header = stripAnsi(lines[0]);
      assert.ok(header.includes('\u2387'), tool + ' header carries the git-branch glyph: ' + JSON.stringify(header));
      assert.ok(rec.roles.includes('warning'), tool + ' paints in the git-orange role, saw ' + JSON.stringify(rec.roles));
    }
  });

  test('only documented theme roles reach the transcript (no invented orange)', () => {
    const seen = new Set();
    for (const tool of TOOLS) {
      const rec = recorder();
      const card = createWorktreeCardRenderer(tool);
      card.renderCall(callFor(tool), rec.theme, {}).render(60);
      card.renderCall(callFor(tool), rec.theme, { isPartial: false }).render(60);
      card.renderResult(resultFor(tool), { expanded: false }, rec.theme, {}).render(60);
      card.renderResult(resultFor(tool), { expanded: true }, rec.theme, { durationMs: 1500 }).render(60);
      card.renderResult(
        { content: [{ type: 'text', text: 'boom' }], details: resultFor(tool).details, isError: true },
        { expanded: false }, rec.theme, {},
      ).render(60);
      card.renderResult(resultFor(tool), { expanded: false, isPartial: true }, rec.theme, {}).render(60);
      for (const role of rec.roles) seen.add(role);
    }
    for (const role of seen) {
      assert.ok(DOCUMENTED_ROLES.includes(role), 'undocumented theme role ' + JSON.stringify(role));
    }
    assert.ok(seen.has('warning'), 'the git-orange role is actually used');
    assert.ok(seen.has('error'), 'failures still read as errors');
  });

  test('collapsed bodies are ordered short lines per tool', () => {
    const cases = [
      ['worktree_create', ['status: created']],
      ['worktree_list', ['listed: 1 checkout']],
      ['worktree_close', ['removed: feat-cards · feat/cards', 'branch kept']],
      ['worktree_session_open', ['opened: feat-cards · abc123']],
    ];
    for (const entry of cases) {
      const tool = entry[0];
      const expected = entry[1];
      const card = createWorktreeCardRenderer(tool);
      // The new two-identifier heads (`created: <slug> · <branch>`) are
      // longer than the old one-word rows, so width 30 truncates them:
      // exact rows at readable widths, row-count plus fit at 30.
      for (const width of [60, 100]) {
        const lines = renderLines(card.renderResult(resultFor(tool), { expanded: false }, THEME, {}), width);
        assertFits(lines, width);
        assert.deepStrictEqual(bodyRows(lines), expected, tool + ' compact rows at ' + width);
      }
      const narrow = renderLines(card.renderResult(resultFor(tool), { expanded: false }, THEME, {}), 30);
      assertFits(narrow, 30);
      assert.equal(bodyRows(narrow).length, expected.length, tool + ' keeps every compact row at 30');
    }
  });

  test('close names a removed branch and session_open marks a resume', () => {
    const closeCard = createWorktreeCardRenderer('worktree_close');
    const dropped = {
      content: [{ type: 'text', text: 'worktree close: /repo/../feat-gone' }],
      details: { path: '/repo/../feat-gone', branch: 'feat/gone', removed: true, branchKept: false },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(closeCard.renderResult(dropped, { expanded: false }, THEME, {}), 60)),
      ['removed: feat-gone · feat/gone', 'branch deleted'],
    );
    const openCard = createWorktreeCardRenderer('worktree_session_open');
    const resumed = {
      content: [{ type: 'text', text: 'opened: feat-cards · abc123\nresumed' }],
      details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: true, path: '/repo/../feat-cards' },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(openCard.renderResult(resumed, { expanded: false }, THEME, {}), 60)),
      ['opened: feat-cards · abc123', 'resumed'],
    );
  });

  test('an empty listing compacts to one line', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const lines = renderLines(card.renderResult(
      { content: [{ type: 'text', text: 'worktree list: none' }], details: { worktrees: [], count: 0 } },
      { expanded: false }, THEME, {},
    ), 60);
    assert.deepStrictEqual(bodyRows(lines), ['no worktrees']);
  });

  test('the top rule right-aligns the hint; the closing rule carries the duration only', () => {
    const timed = settledCard('worktree_close', { durationMs: 1200 });
    const topRow = stripAnsi(timed.top[0]);
    assert.ok(topRow.endsWith('ctrl+o to expand'), 'hint rides the top rule: ' + JSON.stringify(topRow));
    assert.equal(visible(timed.top[0]), 60, 'the hint is right-aligned to the full width: ' + JSON.stringify(topRow));
    const rule = closer(timed.body);
    assert.ok(!rule.includes('ctrl+o'), 'the closing rule carries no hint: ' + JSON.stringify(rule));
    assert.ok(rule.endsWith('1.2s'), 'duration closes the rule: ' + JSON.stringify(rule));
    assert.ok(!timed.body.map(stripAnsi).some((row) => row.includes('ctrl+o')),
      'the hint appears once, above the body: ' + JSON.stringify(timed.body));
    const untimed = settledCard('worktree_close', {});
    assert.ok(!untimed.lines.join('\n').includes('1.2s'), 'no duration without host evidence');
    assert.ok(!closer(untimed.body).includes('ctrl+o'), 'no hint on the closing rule without timing either');
  });

  test('expanded list shows every row while compact shows the action and count', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const words = ['worktree list: a-x feat/x thread=t1 issues=1', 'worktree list: b-y feat/y thread=t2 issues=2'];
    const result = {
      content: [{ type: 'text', text: words.join('\n') }],
      details: {
        worktrees: [
          { name: 'a-x', path: '/repo/a-x', branch: 'feat/x' },
          { name: 'b-y', path: '/repo/b-y', branch: 'feat/y' },
        ],
        count: 2,
      },
    };
    const compact = renderLines(card.renderResult(result, { expanded: false }, THEME, {}), 100).map(stripAnsi).join('\n');
    assert.ok(compact.includes('listed: 2 checkouts'), 'compact names the action and the count');
    assert.ok(!compact.includes('current'), 'compact never claims which checkout is current');
    assert.ok(!compact.includes('a-x'), 'compact never names the first row as the current checkout');
    assert.ok(!compact.includes('b-y'), 'compact stays short instead of listing rows');
    const expanded = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 100).map(stripAnsi).join('\n');
    assert.ok(expanded.includes('a-x') && expanded.includes('b-y'), 'expanded keeps the full listing');
  });

  test('result rows strip ANSI smuggled through branch names and paths', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const evil = {
      content: [{ type: 'text', text: 'worktree create: /repo/x' }],
      details: { path: '/repo/\x1b[31mx', branch: 'feat/\x1b[31mevil', issues: [] },
    };
    const lines = renderLines(card.renderResult(evil, { expanded: false }, THEME, {}), 60);
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'escape leaked: ' + JSON.stringify(line));
    assertFits(lines, 60);
  });
});

describe('S19: bounded compact per tool plus card parity', () => {
  function bodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  function freshResult(tool) {
    switch (tool) {
      case 'worktree_create':
        return {
          content: [{ type: 'text', text: 'created: feat-cards · feat/cards\npath: /repo/../feat-cards\nissues: 12' }],
          details: { path: '/repo/../feat-cards', branch: 'feat/cards', issues: [12], created: true },
        };
      case 'worktree_close':
        return {
          content: [{ type: 'text', text: 'removed: feat-cards · feat/cards\nbranch kept' }],
          details: { path: '/repo/../feat-cards', branch: 'feat/cards', removed: true, branchKept: true },
        };
      case 'worktree_session_open':
        return {
          content: [{ type: 'text', text: 'opened: feat-cards · abc123\npath: /repo/../feat-cards' }],
          details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: false, path: '/repo/../feat-cards' },
        };
      default:
        throw new Error(`no fresh fixture for ${tool}`);
    }
  }

  test('collapsed bodies are the ordered short lines of the new contract', () => {
    const cases = [
      ['worktree_create', ['status: created']],
      ['worktree_close', ['removed: feat-cards · feat/cards', 'branch kept']],
      ['worktree_session_open', ['opened: feat-cards · abc123']],
    ];
    for (const entry of cases) {
      const tool = entry[0];
      const expected = entry[1];
      const card = createWorktreeCardRenderer(tool);
      // Width 30 truncates the two-identifier heads: exact rows at
      // readable widths, row-count plus fit at 30.
      for (const width of [60, 100]) {
        const lines = renderLines(card.renderResult(freshResult(tool), { expanded: false }, THEME, {}), width);
        assertFits(lines, width);
        assert.deepStrictEqual(bodyRows(lines), expected, tool + ' compact rows at ' + width);
      }
      const narrow = renderLines(card.renderResult(freshResult(tool), { expanded: false }, THEME, {}), 30);
      assertFits(narrow, 30);
      assert.equal(bodyRows(narrow).length, expected.length, tool + ' keeps every compact row at 30');
    }
  });

  test('already-exists create, deleted branch, and resume keep the same ordered shape', () => {
    const createCard = createWorktreeCardRenderer('worktree_create');
    const owned = {
      content: [{ type: 'text', text: 'created: feat-cards · feat/cards · already exists\npath: /repo/../feat-cards' }],
      details: { path: '/repo/../feat-cards', branch: 'feat/cards', alreadyExists: true },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(createCard.renderResult(owned, { expanded: false }, THEME, {}), 60)),
      ['status: already existed'],
    );
    const closeCard = createWorktreeCardRenderer('worktree_close');
    const dropped = {
      content: [{ type: 'text', text: 'removed: feat-gone · feat/gone\nbranch deleted' }],
      details: { path: '/repo/../feat-gone', branch: 'feat/gone', removed: true, branchKept: false },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(closeCard.renderResult(dropped, { expanded: false }, THEME, {}), 60)),
      ['removed: feat-gone · feat/gone', 'branch deleted'],
    );
    const openCard = createWorktreeCardRenderer('worktree_session_open');
    const resumed = {
      content: [{ type: 'text', text: 'opened: feat-cards · abc123\nresumed' }],
      details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: true, path: '/repo/../feat-cards' },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(openCard.renderResult(resumed, { expanded: false }, THEME, {}), 60)),
      ['opened: feat-cards · abc123', 'resumed'],
    );
  });

  test('all five tools share one glyph, one tone role, and one right-aligned hint', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const header = stripAnsi(card.renderCall(callFor(tool), THEME, {}).render(60)[0]);
      assert.ok(header.startsWith('▎ ⎇ '), `${tool} carries the shared glyph: ${JSON.stringify(header)}`);
    }
    const roles = new Set();
    const rec = { theme: { bold: (s) => s, fg: (role, s) => { roles.add(role); return s; } }, roles };
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      card.renderCall(callFor(tool), rec.theme, {}).render(60);
      card.renderResult(resultFor(tool), { expanded: false }, rec.theme, {}).render(60);
      card.renderResult(
        { content: [{ type: 'text', text: 'boom' }], details: resultFor(tool).details, isError: true },
        { expanded: false }, rec.theme, {},
      ).render(60);
    }
    for (const role of roles) assert.ok(['warning', 'error', 'muted'].includes(role), `documented role only: ${role}`);
    assert.ok(roles.has('warning'), 'the git-orange tone role is used');
    assert.ok(roles.has('error'), 'failures read as errors');
    for (const tool of TOOLS) {
      const { top, body, lines } = settledCard(tool);
      const topRow = stripAnsi(top[0]);
      assert.ok(topRow.endsWith('ctrl+o to expand'), `${tool} hint rides the top rule: ${JSON.stringify(topRow)}`);
      assert.equal(visible(top[0]), 60, `${tool} hint right-aligned on the top rule: ${JSON.stringify(topRow)}`);
      assert.ok(!body.map(stripAnsi).some((row) => row.includes('ctrl+o')),
        `${tool} keeps the hint above the body: ${JSON.stringify(body)}`);
      const untimed = lines.map(stripAnsi).join('\n').replace(/ctrl\+o to (expand|collapse)/g, '');
      assert.ok(!/\d+(ms|s)/.test(untimed), `${tool} shows no duration without host evidence`);
    }
  });
});

describe('expand-hint placement: the hint rides the top rule, the closing rule carries only the duration', () => {
  // The user's report (screenshot of the Warp card): the ctrl+o hint sat at the
  // bottom right beside the duration, so one corner carried two unrelated
  // facts — "el expand debe ir arriba ... abajo derecha van los ms/s". The
  // hint now right-aligns on the card's TOP rule (the header row the call
  // renderer draws for a tool card, the heading row for a message card) and
  // the closing rule carries only the host-evidenced duration, never a
  // fabricated or placeholder one. Click-to-expand is the host's, not ours:
  // see the mouse test at the end of this block.
  const HINT = /ctrl\+o to (expand|collapse)/;

  function warpMessage(overrides) {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        fromName: 'principal',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
      ...(overrides || {}),
    };
  }

  function floatTheme() {
    const BG_OPEN = '\x1b[48;5;22m';
    const BG_RESET = '\x1b[49m';
    return { fg: (_role, text) => text, bg: (_role, text) => `${BG_OPEN}${text}${BG_RESET}` };
  }

  test('every tool card shows the hint once, on the top rule, in both states', () => {
    for (const tool of TOOLS) {
      for (const expanded of [false, true]) {
        for (const width of [60, 100]) {
          const { top, body } = settledCard(tool, { expanded, width });
          assertFits([...top, ...body], width);
          const topRow = stripAnsi(top[0]);
          assert.ok(topRow.startsWith('\u258E \u2387 '), `${tool} keeps the identity first: ${JSON.stringify(topRow)}`);
          assert.ok(topRow.includes(expanded ? 'ctrl+o to collapse' : 'ctrl+o to expand'),
            `${tool} at ${width} (${expanded ? 'expanded' : 'collapsed'}) hint on top: ${JSON.stringify(topRow)}`);
          assert.equal(visible(top[0]), width, `${tool} hint right-aligned on the top rule: ${JSON.stringify(topRow)}`);
          const below = body.map(stripAnsi).filter((row) => HINT.test(row));
          assert.deepStrictEqual(below, [], `${tool} never repeats the hint below the top rule: ${JSON.stringify(below)}`);
        }
      }
    }
  });

  test('the closing rule carries the host duration alone, and nothing without it', () => {
    for (const tool of TOOLS) {
      const timed = settledCard(tool, { durationMs: 1500 });
      const rule = stripAnsi(timed.body[timed.body.length - 1]);
      assert.ok(rule.includes('\u2500'), `${tool} still closes its frame: ${JSON.stringify(rule)}`);
      assert.ok(!HINT.test(rule), `${tool} closing rule carries no hint: ${JSON.stringify(rule)}`);
      assert.ok(rule.endsWith('1.5s'), `${tool} duration sits bottom-right: ${JSON.stringify(rule)}`);
      assert.equal(visible(timed.body[timed.body.length - 1]), 60, `${tool} duration right-aligned: ${JSON.stringify(rule)}`);
      const untimed = settledCard(tool, {});
      const bare = stripAnsi(untimed.body[untimed.body.length - 1]).replace(/\s+$/, '');
      assert.equal(bare, '\u258E \u2500', `${tool} bare rule without timing evidence: ${JSON.stringify(bare)}`);
      assert.ok(!/\d+(ms|s)/.test(untimed.lines.map(stripAnsi).join('\n').replace(HINT, '')),
        `${tool} never invents a duration`);
    }
  });

  test('sub-second and second-scale host timings keep their own units', () => {
    const ms = settledCard('worktree_create', { durationMs: 40 });
    assert.ok(stripAnsi(ms.body[ms.body.length - 1]).endsWith('40ms'), 'milliseconds stay milliseconds');
    const seconds = settledCard('worktree_create', { durationMs: 12345 });
    assert.ok(stripAnsi(seconds.body[seconds.body.length - 1]).endsWith('12.3s'), 'long runs read in seconds');
  });

  test('a header with no room for the hint keeps its identity and drops the hint', () => {
    // Documented degradation: the hint is an affordance, the identity is the
    // content, so a narrow card clips the identity and omits the hint rather
    // than truncating the identity to make room — and the hint never falls
    // back to the bottom-right corner, which belongs to the duration.
    const { top, body } = settledCard('worktree_session_open', { width: 30 });
    assertFits([...top, ...body], 30);
    const topRow = stripAnsi(top[0]);
    assert.ok(topRow.includes('\u2026'), `the identity clips with an ellipsis: ${JSON.stringify(topRow)}`);
    assert.ok(!HINT.test(topRow), `no fill column means no hint: ${JSON.stringify(topRow)}`);
    assert.ok(![...top, ...body].map(stripAnsi).some((row) => HINT.test(row)), 'the hint never drops to the bottom');
    assert.equal(stripAnsi(body[body.length - 1]).replace(/\s+$/, ''), '\u258E \u2500', 'the closing rule stays bare');
  });

  test('the float card puts the hint on its heading band and the duration on the closing band', () => {
    const theme = floatTheme();
    for (const tool of TOOLS) {
      const { top, body } = settledCard(tool, { theme, durationMs: 1200 });
      // The float recipe opens with a blank padding band above the heading.
      const heading = top[1];
      assert.equal(visible(heading), 60, `${tool} float heading band is full width`);
      assert.ok(stripAnsi(heading).includes('ctrl+o to expand'),
        `${tool} float hint on the heading: ${JSON.stringify(stripAnsi(heading))}`);
      const closer = stripAnsi(body[body.length - 1]);
      assert.ok(/1\.2s {1,2}$/.test(closer), `${tool} float duration closes the card: ${JSON.stringify(closer)}`);
      assert.ok(!HINT.test(closer), `${tool} float closing band carries no hint: ${JSON.stringify(closer)}`);
      assert.equal(visible(body[body.length - 1]), 60, `${tool} float closing band is full width`);
    }
  });

  test('the warp card puts the hint on its heading row and leaves the closing rule empty', () => {
    const render = createWarpMessageRenderer();
    for (const expanded of [false, true]) {
      const lines = renderLines(render(warpMessage(), { expanded, outputPad: 1 }, THEME), 60);
      assertFits(lines, 60);
      // outputPad adds one margin column on each side, so the heading row is
      // read trimmed: the bar, the identity, the right-aligned hint.
      const heading = stripAnsi(lines[0]).trim();
      assert.ok(heading.startsWith('\u258E \u2387 Warp \u00B7 moved'),
        `heading identity first: ${JSON.stringify(heading)}`);
      assert.ok(heading.endsWith(expanded ? 'ctrl+o to collapse' : 'ctrl+o to expand'),
        `warp hint on the heading: ${JSON.stringify(heading)}`);
      assert.equal(visible(lines[0]), 60, `warp hint right-aligned: ${JSON.stringify(heading)}`);
      const rules = lines.map(stripAnsi).filter((line) => line.includes('\u2500'));
      assert.equal(rules.length, 1, 'one closing rule');
      assert.ok(!HINT.test(rules[0]), `warp closing rule carries no hint: ${JSON.stringify(rules[0])}`);
      assert.ok(!lines.slice(1).map(stripAnsi).some((row) => HINT.test(row)), 'the hint appears once, on top');
    }
  });

  test('the hint does not depend on render order: a settled call shows it before the result marks the row', () => {
    // The host re-invokes the call renderer BEFORE the result renderer in the
    // same update (tool-execution.js updateDisplay), and it is the RESULT
    // render that marks the shared row state. So on the first pass after a
    // result arrives the call still looks 'awaiting' while the execution is
    // already finished — the expand hint must be on the top rule there too,
    // never only after some later re-render.
    const card = createWorktreeCardRenderer('worktree_create');
    const state = {};
    const context = { state, isPartial: false, expanded: false, outputPad: 0 };
    const call = renderLines(card.renderCall(callFor('worktree_create'), THEME, context), 60);
    assert.ok(stripAnsi(call[0]).endsWith('ctrl+o to expand'),
      `the settled call carries the hint before the result renders: ${JSON.stringify(stripAnsi(call[0]))}`);
    const running = renderLines(card.renderCall(callFor('worktree_create'), THEME, { ...context, isPartial: true }), 60);
    assert.ok(!running.map(stripAnsi).some((row) => HINT.test(row)),
      `a still-running card advertises nothing to expand: ${JSON.stringify(running.map(stripAnsi))}`);
  });

  test('without the injected toggle the card stays keyboard-only: no mouse handler', () => {
    // Opt-in seam: the mouse handler exists ONLY when the extension injects a
    // toggle callback (the host integration is wired by the extension, which
    // calls ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded())). With no
    // callback the components stay render/invalidate-only and the host's own
    // click paths are untouched.
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const state = {};
      const context = { state, isPartial: false, outputPad: 0 };
      const components = [
        card.renderCall(callFor(tool), THEME, context),
        card.renderResult(resultFor(tool), { expanded: false }, THEME, context),
      ];
      for (const component of components) {
        assert.equal(typeof component.handleMouse, 'undefined', `${tool} has no mouse seam without a callback`);
        assert.equal(typeof component.render, 'function', `${tool} still renders`);
        assert.equal(typeof component.invalidate, 'function', `${tool} still invalidates`);
      }
    }
    const warp = createWarpMessageRenderer()(warpMessage(), { expanded: false, outputPad: 1 }, THEME);
    assert.equal(typeof warp.handleMouse, 'undefined', 'the warp card has no mouse seam without a callback');
  });
});

describe('click-to-expand seam: left press/click on the hint region only', () => {
  // The host (pi-tui 1.4.0) delivers a click to the component that CLAIMED the
  // press: tui-alt-screen.js records `mousePressTarget` from the dispatch result
  // of the press, and on release at the same cell it synthesizes a `click`
  // retargeted to that exact component (handleMouseEvent). So a press must
  // return { handled: true } or the click never arrives. Both host shells reach
  // the renderer: tool cards through tool-execution.js's MouseRegion, which
  // dispatches to its child first, and message cards through
  // CustomMessageComponent (a Container) forwarding to the renderer component.
  // The card therefore claims ONLY the hint's own cells, and only a left
  // press/click; everywhere else it returns undefined so the host's behavior is
  // exactly what it was.
  const HINT_TEXT = /ctrl\+o to (expand|collapse)/;

  function hintGeometry(lines) {
    for (let row = 0; row < lines.length; row += 1) {
      const plain = stripAnsi(lines[row]);
      const found = HINT_TEXT.exec(plain);
      if (!found) continue;
      // The fixtures are all single-column characters, so the string index is
      // the visible column: exactly what the host reports in event.x.
      return { row, start: found.index, end: found.index + found[0].length, text: found[0] };
    }
    return undefined;
  }

  function mouseEvent(type, x, y, over) {
    return { type, button: 'left', x, y, width: 60, height: 6, shift: false, alt: false, ctrl: false, ...(over || {}) };
  }

  function seam() {
    const calls = [];
    return { calls, deps: { toggleExpanded: () => calls.push('toggle') } };
  }

  function settledComponents(tool, deps, options) {
    const opts = options || {};
    const theme = opts.theme || THEME;
    const card = createWorktreeCardRenderer(tool, deps);
    const state = {};
    const context = { state, isPartial: false, expanded: opts.expanded === true, outputPad: 0, durationMs: opts.durationMs };
    const expanded = opts.expanded === true;
    const body = card.renderResult(resultFor(tool), { expanded, isPartial: false }, theme, context);
    const top = card.renderCall(callFor(tool), theme, context);
    return { card, top, body, lines: [...renderLines(top, opts.width || 60), ...renderLines(body, opts.width || 60)] };
  }

  function warpMessage(overrides) {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        fromName: 'principal',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
      ...(overrides || {}),
    };
  }

  test('an injected toggle makes the hint cells a left-click target, and only the click toggles', () => {
    for (const tool of TOOLS) {
      const s = seam();
      const { top } = settledComponents(tool, s.deps);
      const lines = renderLines(top, 60);
      const hint = hintGeometry(lines);
      assert.ok(hint, `${tool} renders the hint: ${JSON.stringify(lines.map(stripAnsi))}`);
      assert.equal(typeof top.handleMouse, 'function', `${tool} exposes the seam`);
      const cell = { x: hint.start, y: hint.row };
      // The press CLAIMS the gesture (so the host retargets the click here) but
      // must not repaint, so the measured row stays valid for the click.
      assert.deepStrictEqual(
        top.handleMouse(mouseEvent('press', cell.x, cell.y)),
        { handled: true, render: false },
        `${tool} press on the hint is claimed without a repaint`,
      );
      assert.deepStrictEqual(s.calls, [], `${tool} a press alone never toggles`);
      const click = top.handleMouse(mouseEvent('click', cell.x, cell.y));
      assert.ok(click && click.handled === true, `${tool} click on the hint is handled: ${JSON.stringify(click)}`);
      assert.deepStrictEqual(s.calls, ['toggle'], `${tool} exactly one toggle per click`);
      // Every cell of the hint range reacts; the last one included.
      top.handleMouse(mouseEvent('click', hint.end - 1, hint.row));
      assert.deepStrictEqual(s.calls, ['toggle', 'toggle'], `${tool} the hint's last cell is inside the region`);
    }
  });

  test('only the hint cells react: the header text, the body, and the closing rule pass through', () => {
    const s = seam();
    const { top, body, lines } = settledComponents('worktree_create', s.deps);
    const hint = hintGeometry(lines);
    assert.ok(hint);
    const outside = [
      ['left of the hint', mouseEvent('press', hint.start - 1, hint.row)],
      ['left of the hint (click)', mouseEvent('click', hint.start - 1, hint.row)],
      ['one past the hint', mouseEvent('click', hint.end, hint.row)],
      ['the header bar cell', mouseEvent('click', 0, hint.row)],
      ['a body row', mouseEvent('click', hint.start, hint.row + 2)],
      ['the closing rule', mouseEvent('click', hint.start, lines.length - 1)],
      ['past the last row', mouseEvent('click', hint.start, lines.length)],
      ['a negative row', mouseEvent('click', hint.start, -1)],
    ];
    for (const entry of outside) {
      const label = entry[0];
      const event = entry[1];
      assert.equal(top.handleMouse(event), undefined, `${label} is not claimed by the card`);
    }
    assert.deepStrictEqual(s.calls, [], 'no click outside the hint region toggles');
    // The body-only half renders no hint at all, so it claims nothing either.
    assert.equal(typeof body.handleMouse, 'function', 'the result half still exposes the seam');
    for (let row = 0; row < lines.length; row += 1) {
      assert.equal(body.handleMouse(mouseEvent('click', hint.start, row)), undefined, `result row ${row} is not claimed`);
    }
    assert.deepStrictEqual(s.calls, [], 'the result half never toggles on its own');
  });

  test('only a left press/click reacts: other buttons, wheel, move, drag and release pass through', () => {
    const s = seam();
    const { top } = settledComponents('worktree_warp', s.deps);
    const hint = hintGeometry(renderLines(top, 60));
    assert.ok(hint);
    const passthrough = [
      mouseEvent('press', hint.start, hint.row, { button: 'right' }),
      mouseEvent('click', hint.start, hint.row, { button: 'right' }),
      mouseEvent('click', hint.start, hint.row, { button: 'middle' }),
      mouseEvent('click', hint.start, hint.row, { button: 'none' }),
      mouseEvent('wheel', hint.start, hint.row),
      mouseEvent('move', hint.start, hint.row),
      mouseEvent('drag', hint.start, hint.row),
      mouseEvent('release', hint.start, hint.row),
    ];
    for (const event of passthrough) {
      assert.equal(top.handleMouse(event), undefined, `${event.type}/${event.button} is not claimed`);
    }
    assert.deepStrictEqual(s.calls, [], 'nothing but a left press/click toggles');
    assert.equal(top.handleMouse(undefined), undefined, 'a missing event never throws or toggles');
    assert.equal(top.handleMouse({}), undefined, 'a malformed event never throws or toggles');
  });

  test('a narrow card that drops the hint has no click region at all', () => {
    const s = seam();
    const { top } = settledComponents('worktree_session_open', s.deps, { width: 30 });
    const lines = renderLines(top, 30);
    assert.ok(!lines.map(stripAnsi).some((row) => HINT_TEXT.test(row)), 'no hint is rendered at 30');
    for (let row = 0; row < lines.length; row += 1) {
      for (let x = 0; x < 30; x += 1) {
        assert.equal(top.handleMouse(mouseEvent('press', x, row)), undefined, `press at ${x},${row} is not claimed`);
        assert.equal(top.handleMouse(mouseEvent('click', x, row)), undefined, `click at ${x},${row} is not claimed`);
      }
    }
    assert.deepStrictEqual(s.calls, [], 'a card with no visible hint cannot be clicked open');
  });

  test('the seam never changes what the card renders, and the keyboard path stays', () => {
    const withSeam = { toggleExpanded: () => {} };
    const float = { fg: (_role, text) => text, bg: (_role, text) => `\x1b[48;5;22m${text}\x1b[49m` };
    for (const tool of TOOLS) {
      for (const expanded of [false, true]) {
        for (const theme of [THEME, float]) {
          const plain = settledComponents(tool, undefined, { expanded, width: 80, theme });
          const seamed = settledComponents(tool, withSeam, { expanded, width: 80, theme });
          assert.deepStrictEqual(seamed.lines, plain.lines, `${tool} renders identically with the seam`);
        }
      }
    }
    const s = seam();
    const { top } = settledComponents('worktree_close', s.deps);
    const text = renderLines(top, 60).map(stripAnsi).join('\n');
    assert.ok(text.includes('ctrl+o to expand'), 'the key hint still names ctrl+o: ' + JSON.stringify(text));
  });

  // The real host shells, driven through the real pi-tui primitives: the tool
  // card sits inside tool-execution.js's MouseRegion, and the message card sits
  // inside CustomMessageComponent — a Container — which forwards to its child
  // with a row offset. Both must reach the card, and the card's claimed press
  // must become the gesture target the synthesized click is retargeted to.
  test('the real host shells reach the card: claimed press, retargeted click, host toggle untouched', () => {
    let tui = null;
    try {
      tui = require('@earendil-works/pi-tui');
    } catch {
      tui = null;
    }
    if (!tui || typeof tui.MouseRegion !== 'function' || typeof tui.Container !== 'function' || typeof tui.Spacer !== 'function') {
      return;
    }

    // tui-alt-screen's retarget: the click arrives with the target's own
    // origin subtracted, exactly as retargetMouseEvent computes it.
    function hostClickFrom(pressResult, clickEvent) {
      const target = pressResult.target;
      return {
        ...clickEvent,
        x: clickEvent.screenX - target.originX,
        y: clickEvent.screenY - target.originY,
        width: target.width,
        height: target.height,
      };
    }

    // --- tool card: Container -> MouseRegion(card, hostToggle) -> card ---
    const s = seam();
    const hostToggles = [];
    const hostToggle = (event) => {
      if (event.type !== 'click' || event.button !== 'left') return undefined;
      hostToggles.push('host');
      return { handled: true };
    };
    const { top } = settledComponents('worktree_create', s.deps);
    const lines = renderLines(top, 60);
    const hint = hintGeometry(lines);
    assert.ok(hint);
    const region = new tui.MouseRegion(top, hostToggle);
    const pressEvent = { ...mouseEvent('press', hint.start, hint.row), screenX: hint.start, screenY: hint.row, height: lines.length };
    const pressResult = region.handleMouse(pressEvent);
    assert.ok(pressResult && pressResult.handled === true, 'the host region forwards and keeps the card\'s claimed press');
    assert.strictEqual(pressResult.target.component, top, 'the gesture target is the card component itself');
    const clickEvent = { ...pressEvent, type: 'click' };
    const clickResult = pressResult.target.component.handleMouse(hostClickFrom(pressResult, clickEvent));
    assert.ok(clickResult && clickResult.handled === true, 'the retargeted click is handled by the card');
    assert.deepStrictEqual(s.calls, ['toggle'], 'the card callback toggled exactly once');
    assert.deepStrictEqual(hostToggles, [], 'the host region handler did not also toggle');

    // A press OUTSIDE the hint is not claimed, so the host's own handler keeps
    // the click: nothing about the surrounding card changes.
    const outside = region.handleMouse({ ...pressEvent, x: 0, screenX: 0 });
    assert.equal(outside, undefined, 'a press off the hint is not claimed by the card');
    assert.deepStrictEqual(s.calls, ['toggle'], 'no extra toggle from the pass-through press');

    // --- message card: Container (CustomMessageComponent) -> card ---
    const m = seam();
    const render = createWarpMessageRenderer(m.deps);
    const card = render(warpMessage(), { expanded: false, outputPad: 0 }, THEME);
    const cardLines = renderLines(card, 60);
    const cardHint = hintGeometry(cardLines);
    assert.ok(cardHint);
    const container = new tui.Container();
    // CustomMessageComponent opens with a Spacer(1), so the card starts one row down.
    container.addChild(new tui.Spacer(1));
    container.addChild(card);
    const height = cardLines.length + 1;
    const messagePress = container.handleMouse({
      ...mouseEvent('press', cardHint.start, cardHint.row + 1), screenX: cardHint.start, screenY: cardHint.row + 1, height,
    });
    assert.ok(messagePress && messagePress.handled === true, 'the message container forwards the claimed press');
    assert.strictEqual(messagePress.target.component, card, 'the message gesture target is the card component');
    const messageClick = container.handleMouse({
      ...mouseEvent('click', cardHint.start, cardHint.row + 1), screenX: cardHint.start, screenY: cardHint.row + 1, height,
    });
    assert.ok(messageClick && messageClick.handled === true, 'the message card handles the click');
    assert.deepStrictEqual(m.calls, ['toggle'], 'the message card toggled exactly once');
  });

  test('the warp message card gets the same hint-region seam', () => {
    const s = seam();
    const render = createWarpMessageRenderer(s.deps);
    const component = render(warpMessage(), { expanded: false, outputPad: 1 }, THEME);
    const lines = renderLines(component, 60);
    const hint = hintGeometry(lines);
    assert.ok(hint, 'the warp heading carries the hint');
    assert.equal(typeof component.handleMouse, 'function', 'the message card exposes the seam');
    assert.deepStrictEqual(
      component.handleMouse(mouseEvent('press', hint.start, hint.row)),
      { handled: true, render: false },
      'the warp press is claimed so the host retargets the click',
    );
    assert.deepStrictEqual(s.calls, [], 'the warp press alone never toggles');
    assert.ok(component.handleMouse(mouseEvent('click', hint.start, hint.row)).handled, 'the warp click is handled');
    assert.deepStrictEqual(s.calls, ['toggle'], 'one warp toggle per click');
    assert.equal(component.handleMouse(mouseEvent('click', 0, hint.row)), undefined, 'the heading bar cell is not claimed');
    assert.deepStrictEqual(s.calls, ['toggle'], 'clicks outside the warp hint change nothing');
  });
});

describe('warp message renderer (S20)', () => {
  // The warp confirmation is a custom MESSAGE (commands have no render
  // hook), so its card lives here as a pure message renderer: no brackets
  // from the customType, a capitalised label, the compact moved:/to: name rows
  // and the expanded path/detail on ctrl+o. Same geometry helpers as the
  // tool cards (accent bar, right-aligned hint, outputPad), same fake-theme
  // discipline: the identity theme below adds no paint of its own.
  const WIDTHS_WARP = [30, 60, 100];

  function warpMessage(overrides) {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        fromName: 'principal',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
      ...(overrides || {}),
    };
  }

  function recordingTheme() {
    const roles = [];
    return {
      roles,
      fg: (role, text) => { roles.push(role); return text; },
      bg: (_role, text) => text,
    };
  }

  function warpBodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  // buildCard honours outputPad with a margin on both sides, so the bar
  // check tolerates leading space; width fit is asserted separately.
  function assertWarpFrame(lines) {
    assert.ok(lines.length > 0, 'card renders at least one row');
    for (const line of lines) {
      assert.ok(/^\s*\u258E/.test(stripAnsi(line)),
        `every row carries the accent bar: ${JSON.stringify(stripAnsi(line))}`);
    }
  }

  test('compact renders the capitalised label, glyph and ordered moved:/to: name rows (S42)', () => {
    const render = createWarpMessageRenderer();
    for (const width of [60, 100]) {
      const lines = renderLines(render(warpMessage(), { expanded: false, outputPad: 1 }, THEME), width);
      assertFits(lines, width);
      assertWarpFrame(lines);
      const rows = warpBodyRows(lines);
      assert.ok(rows[0].startsWith('\u2387 Warp \u00B7 moved'),
        'own label with glyph, never the bracketed customType: ' + JSON.stringify(rows[0]));
      assert.ok(rows[0].endsWith('ctrl+o to expand'), 'the expand hint rides the heading: ' + JSON.stringify(rows[0]));
      // S42: compact is EXACTLY the two name-only rows — no branch, no path.
      assert.deepStrictEqual(rows.slice(1), ['moved: principal', 'to: feat-cards']);
      assert.ok(!rows.join('\n').includes('feat/cards'), 'no branch row in the compact card: ' + JSON.stringify(rows));
      assert.ok(!rows.join('\n').includes('/repo/to'), 'no path row in the compact card: ' + JSON.stringify(rows));
      assert.ok(!lines.join('\n').includes('[worktree-warp]'), 'no default-renderer bracket label');
    }
    const narrow = renderLines(render(warpMessage(), { expanded: false, outputPad: 1 }, THEME), 30);
    assertFits(narrow, 30);
    assertWarpFrame(narrow);
    assert.equal(warpBodyRows(narrow).length, 3, 'header plus both compact rows survive at 30');
  });

  test('compact without fromName still names the worktrees only (legacy details fallback)', () => {
    const render = createWarpMessageRenderer();
    const legacy = warpMessage({ details: {
      from: '/repo/from',
      to: '/repo/to',
      fromDesc: 'feat-old \u00B7 feat/old',
      name: 'feat-cards',
      branch: 'feat/cards',
    } });
    const rows = warpBodyRows(renderLines(render(legacy, { expanded: false, outputPad: 1 }, THEME), 100));
    // The source name is read off the fromDesc's name segment, never the branch.
    assert.deepStrictEqual(rows.slice(1), ['moved: feat-old', 'to: feat-cards']);
    assert.ok(!rows.join('\n').includes('feat/old'), 'no branch row in the compact card: ' + JSON.stringify(rows));
  });

  test('expanded adds path: and branch: rows after the compact pair, in that order (S42)', () => {
    const render = createWarpMessageRenderer();
    const lines = renderLines(render(warpMessage(), { expanded: true, outputPad: 1 }, THEME), 100);
    assertFits(lines, 100);
    const rows = warpBodyRows(lines);
    assert.ok(rows[0].startsWith('\u2387 Warp \u00B7 moved'),
      'the heading keeps its identity first: ' + JSON.stringify(rows[0]));
    assert.ok(rows[0].endsWith('ctrl+o to collapse'),
      'the hint rides the heading, not the closing rule: ' + JSON.stringify(rows[0]));
    assert.deepStrictEqual(rows.slice(1, 3), ['moved: principal', 'to: feat-cards']);
    assert.deepStrictEqual(rows.slice(3), ['path: now in "/repo/to"', 'branch: now in "feat/cards"'],
      'S42: expanded appends exactly path then branch: ' + JSON.stringify(rows));
    assert.ok(!rows.some((row) => /Worktree warp: now in/.test(row)), 'S42: the long prose notice stays out of the card body');
    assert.ok(!rows.some((row) => /evalidate/i.test(row)), 'S41: the filler sentence is gone from the card');
    for (const width of WIDTHS_WARP) {
      assertFits(renderLines(render(warpMessage(), { expanded: true, outputPad: 1 }, THEME), width), width);
    }
  });

  test('expanded wraps a long line with no ellipsis instead of cutting it', () => {
    const render = createWarpMessageRenderer();
    const longTo = `/repo/very-long-checkout-path-that-keeps-going-and-going-${'x'.repeat(80)}`;
    const message = warpMessage({ details: {
      from: '/repo/from',
      to: longTo,
      fromDesc: 'principal \u00B7 main',
      name: 'feat-cards',
      branch: 'feat/cards',
    } });
    const lines = renderLines(render(message, { expanded: true, outputPad: 1 }, THEME), 60);
    assertFits(lines, 60);
    const rows = warpBodyRows(lines);
    assert.ok(!rows.join('\n').includes('\u2026') && !rows.join('\n').includes('...'), 'S39: no ellipsis in the expanded form');
    assert.ok(rows.join('').includes(longTo), 'S39: the long line survives whole across the wrapped rows');
    assert.ok(rows.length > 4, 'the long path wrapped onto extra rows: ' + JSON.stringify(rows));
  });

  test('tool expanded wraps a long body line with no ellipsis', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const longPath = `/repo/${'odd-doc-'.repeat(20)}checkout`;
    const result = {
      content: [{ type: 'text', text: 'worktree list: feat-cards feat/cards' }],
      details: { worktrees: [{ name: 'feat-cards', path: longPath, branch: 'feat/cards' }], count: 1, all: true, pruned: [], warnings: [] },
    };
    const lines = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 60);
    assertFits(lines, 60);
    const text = lines.map((line) => stripAnsi(line)).join('\n');
    assert.ok(!text.includes('\u2026'), 'S39: no ellipsis in the expanded form');
    // Wrapped chunks carry the accent bar per row: strip it (and the
    // closing rule) before rejoining, so the check sees only content.
    const content = lines
      .map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500') && !row.includes('ctrl+o'))
      .join('');
    assert.ok(content.includes(longPath), 'S39: the long value survives whole across the wrapped rows');
  });

  test('outputPad is honoured and widths 30/60/100 all fit', () => {
    const render = createWarpMessageRenderer();
    for (const width of WIDTHS_WARP) {
      for (const outputPad of [0, 1, 2]) {
        const lines = renderLines(
          render(warpMessage(), { expanded: false, outputPad }, THEME), width);
        assertFits(lines, width);
        assertWarpFrame(lines);
      }
    }
    const padded = renderLines(render(warpMessage(), { expanded: false, outputPad: 2 }, THEME), 60);
    const plain = renderLines(render(warpMessage(), { expanded: false, outputPad: 0 }, THEME), 60);
    assert.ok(padded[0].startsWith('  '), 'outputPad pads both sides: ' + JSON.stringify(padded[0]));
    assert.ok(!plain[0].startsWith(' '), 'zero pad leaves no margin: ' + JSON.stringify(plain[0]));
  });

  test('branch names and paths cannot leak ANSI, controls or newlines into the card', () => {
    const render = createWarpMessageRenderer();
    const evil = warpMessage({
      content: "Worktree warp: now in /x (branch 'b').\x1b[31mred\x1b[0m",
      details: {
        from: '/repo/\x1b[31mfrom\x1b[0m',
        to: '/repo/to\nsecond-line\x07bell',
        fromDesc: 'principal \u00B7 \x1b[1mmain\x1b[22m',
        name: 'feat-\x1b]8;;http://evil\x07cards',
        branch: 'feat/cards\nnext',
      },
    });
    for (const expanded of [false, true]) {
      for (const width of WIDTHS_WARP) {
        const lines = renderLines(render(evil, { expanded, outputPad: 1 }, THEME), width);
        assertFits(lines, width);
        for (const line of lines) {
          // eslint-disable-next-line no-control-regex
          assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line), 'no control characters: ' + JSON.stringify(line));
          assert.ok(!/\x1b\[[0-9;]*m/.test(line), 'no ANSI escapes: ' + JSON.stringify(line));
        }
        assert.ok(!lines.join('\n').includes('second-line'), 'embedded newlines never add rows');
      }
    }
  });

  test('a foreign customType falls back to the default renderer via undefined', () => {
    const render = createWarpMessageRenderer();
    assert.equal(render(warpMessage({ customType: 'something-else' }), { expanded: false, outputPad: 1 }, THEME), undefined);
    assert.equal(render(null, { expanded: false, outputPad: 1 }, THEME), undefined);
  });

  test('malformed details still render from the content, never throw', () => {
    const render = createWarpMessageRenderer();
    for (const details of [undefined, null, {}, { name: 42 }]) {
      const lines = renderLines(
        render(warpMessage({ details }), { expanded: false, outputPad: 1 }, THEME), 60);
      assertFits(lines, 60);
      assertWarpFrame(lines);
      assert.ok(warpBodyRows(lines).length >= 1, 'at least one row, got ' + JSON.stringify(lines));
    }
  });

  test('the tone is the documented warning role, never an orange role or the customType', () => {
    const theme = recordingTheme();
    const render = createWarpMessageRenderer();
    render(warpMessage(), { expanded: false, outputPad: 1 }, theme).render(60);
    render(warpMessage(), { expanded: true, outputPad: 1 }, theme).render(60);
    const roles = new Set(theme.roles);
    assert.ok(roles.has('warning'), 'git-orange reads as warning: ' + JSON.stringify([...roles]));
    for (const role of roles) {
      assert.ok(['warning', 'muted', 'dim'].includes(role), 'documented role only: ' + role);
    }
    // The installed Pi theme schema exposes no orange role, so the closest
    // documented role (warning, yellow in the built-in themes) carries the
    // tone; that limitation is stated in lib/worktree-card.js and the docs.
  });

  test('the heading row carries the ctrl+o hint on both states', () => {
    const render = createWarpMessageRenderer();
    for (const expanded of [false, true]) {
      const lines = renderLines(render(warpMessage(), { expanded, outputPad: 1 }, THEME), 60);
      assert.ok(stripAnsi(lines[0]).trim().endsWith(expanded ? 'ctrl+o to collapse' : 'ctrl+o to expand'),
        'expand hint rides the heading: ' + JSON.stringify(stripAnsi(lines[0])));
      const rules = lines.map((line) => stripAnsi(line)).filter((line) => line.includes('\u2500'));
      assert.equal(rules.length, 1, 'one closing rule');
      assert.ok(!rules[0].includes('ctrl+o'),
        'the closing rule carries no hint: ' + JSON.stringify(rules[0]));
    }
  });
});

describe('warp card background (R4, S24 roles)', () => {
  // R4 as corrected by S24: the warp/worktree card carries a solid tone
  // background like gentle-shell's float cards (today it has none on the
  // outlined fallback). The roles follow the tone table
  // (info/success toolSuccessBg, warning toolPendingBg, error
  // toolErrorBg); customMessageBg is used nowhere in gentle-shell, so the
  // warp card — tone warning, the documented git-orange match — paints
  // toolPendingBg, and tool failures paint toolErrorBg. No invented hex
  // ever reaches the transcript. Every painted row is full-width (the
  // float rectangle with one-column margins); width, outputPad and ANSI
  // safety hold.
  const BG_OPEN = '\x1b[48;5;235m';
  const BG_RESET = '\x1b[49m';

  function bgTheme() {
    const roles = [];
    return {
      roles,
      fg: (role, text) => { roles.push(role); return text; },
      bg: (role, text) => { roles.push('bg:' + role); return BG_OPEN + text + BG_RESET; },
    };
  }

  function warpMessage(overrides) {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
      ...(overrides || {}),
    };
  }

  test('every warp card row carries the tone background toolPendingBg', () => {
    const render = createWarpMessageRenderer();
    const theme = bgTheme();
    const lines = render(warpMessage(), { expanded: false, outputPad: 1 }, theme).render(60);
    assert.ok(lines.length >= 3, 'header plus both compact rows plus rule, got ' + JSON.stringify(lines));
    assert.ok(theme.roles.includes('bg:toolPendingBg'), 'uses the tone-table role, saw ' + JSON.stringify(theme.roles));
    for (const line of lines) {
      assert.ok(line.includes(BG_OPEN) && line.includes(BG_RESET), 'no transparent gap: ' + JSON.stringify(line));
    }
    assert.ok(!theme.roles.some((role) => role.startsWith('bg:') && role !== 'bg:toolPendingBg'),
      'no invented background role: ' + JSON.stringify(theme.roles));
  });

  test('background holds on every row with width/outputPad/ANSI safety', () => {
    const render = createWarpMessageRenderer();
    for (const width of [30, 60, 100]) {
      for (const outputPad of [0, 1, 2]) {
        const theme = bgTheme();
        const lines = render(warpMessage(), { expanded: false, outputPad }, theme).render(width);
        assert.ok(lines.length > 0, 'rows at ' + width + '/' + outputPad);
        for (const line of lines) {
          const plain = stripAnsi(line);
          assert.ok([...plain].length <= width, 'painted row still fits ' + width + ': ' + JSON.stringify(plain));
          assert.ok(line.includes(BG_OPEN), 'background on every row at ' + width + '/' + outputPad);
        }
      }
    }
    // ANSI smuggled through details never breaks the paint or the width.
    const theme = bgTheme();
    const evil = warpMessage({
      details: {
        from: '/repo/\x1b[31mfrom\x1b[0m',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 \x1b[1mmain\x1b[22m',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
    });
    const lines = render(evil, { expanded: false, outputPad: 1 }, theme).render(60);
    for (const line of lines) {
      assert.ok(line.includes(BG_OPEN), 'paint survives sanitized input');
      const noBg = line.split(BG_OPEN).join('').split(BG_RESET).join('');
      assert.ok(!/\x1b\[[0-9;]*m\x1b\[31m/.test(noBg), 'no smuggled escape survives');
    }
  });

  test('a theme without bg still renders the same rows unpainted', () => {
    const render = createWarpMessageRenderer();
    const plain = { fg: (_role, text) => text };
    const lines = render(warpMessage(), { expanded: false, outputPad: 1 }, plain).render(60);
    assert.ok(lines.length >= 3, 'unpainted fallback still draws');
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'no paint without a bg function');
  });
});

describe('S24 float card recipe (T17 RED)', () => {
  // gentle-shell lib/shell-card.ts, CARD_STYLE.FLOAT: a one-column
  // transparent margin on both sides; float chrome
  // { topLeft:"\u258E", topLead:" ", topRight:"  ", rule:" ", side:"\u258E",
  // rail:" ", bottomLeft:"\u258E", bottomRight:" " }; every row padded to the
  // full target width; a blank padding row above the heading and between
  // heading and body; the opener is theme.bg(role,"") minus its trailing
  // \x1b[49m, re-armed after every inner reset, closed with \x1b[49m; roles
  // by tone (info/success toolSuccessBg, warning toolPendingBg, error
  // toolErrorBg); outlined fallback below width 10 or without the role;
  // the duration rides the closing rule only when it fits, never as a
  // placeholder dash.
  const BG_OPEN = '\x1b[48;5;22m';
  const BG_RESET = '\x1b[49m';

  function floatTheme(over) {
    const bgRoles = [];
    return {
      bgRoles,
      fg: (_role, text) => text,
      bg: (role, text) => { bgRoles.push(role); return `${BG_OPEN}${text}${BG_RESET}`; },
      ...(over || {}),
    };
  }

  function warpMsg() {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
    };
  }

  function assertFullWidthPainted(lines, width) {
    assert.ok(lines.length > 0, 'the float card draws rows');
    for (const line of lines) {
      assert.equal(visible(line), width, `every row is the full target width: ${JSON.stringify(stripAnsi(line))}`);
      assert.ok(line.includes(BG_OPEN), `no transparent gap inside a row: ${JSON.stringify(line)}`);
      assert.ok(line.endsWith(`${BG_RESET} `), `the opener closes before the margin: ${JSON.stringify(line)}`);
      const plain = stripAnsi(line);
      assert.ok(plain.startsWith(' ') && plain.endsWith(' '), `one-column transparent margins: ${JSON.stringify(plain)}`);
      assert.equal(plain[1], '\u258E', `the float bar opens the band: ${JSON.stringify(plain)}`);
    }
  }

  test('tool cards paint full-width rows inside one-column margins', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const theme = floatTheme();
      assertFullWidthPainted(renderLines(card.renderCall(callFor(tool), theme, {}), 60), 60);
      assertFullWidthPainted(renderLines(card.renderResult(resultFor(tool), { expanded: false }, theme, {}), 60), 60);
      assertFullWidthPainted(renderLines(card.renderResult(resultFor(tool), { expanded: true }, theme, {}), 100), 100);
    }
  });

  test('the warp card paints full-width rows inside one-column margins', () => {
    const render = createWarpMessageRenderer();
    const theme = floatTheme();
    assertFullWidthPainted(renderLines(render(warpMsg(), { expanded: false }, theme), 60), 60);
    assertFullWidthPainted(renderLines(render(warpMsg(), { expanded: true }, theme), 100), 100);
  });

  test('a blank padding row sits above the heading and between heading and body', () => {
    const render = createWarpMessageRenderer();
    const lines = renderLines(render(warpMsg(), { expanded: false }, floatTheme()), 60)
      .map((line) => stripAnsi(line));
    const isBlank = (row) => /^ \u258E * $/.test(row);
    assert.ok(isBlank(lines[0]), `padding row above the heading: ${JSON.stringify(lines)}`);
    assert.ok(lines[1].includes('Warp'), `the heading follows the padding: ${JSON.stringify(lines)}`);
    assert.ok(isBlank(lines[2]), `padding row between heading and body: ${JSON.stringify(lines)}`);
    assert.ok(lines[3].includes('moved:'), `the body follows: ${JSON.stringify(lines)}`);
  });

  test('the opener is re-armed after every inner reset', () => {
    const theme = floatTheme({ fg: (_role, text) => `\x1b[32m${text}\x1b[0m` });
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      for (const lines of [
        renderLines(card.renderCall(callFor(tool), theme, {}), 60),
        renderLines(card.renderResult(resultFor(tool), { expanded: false }, theme, {}), 60),
      ]) {
        assert.ok(lines.some((line) => line.includes('\x1b[0m')), `${tool} carries an inner reset to re-arm`);
        for (const line of lines) {
          let index = -1;
          while ((index = line.indexOf('\x1b[0m', index + 1)) !== -1) {
            assert.equal(line.slice(index, index + 4 + BG_OPEN.length), `\x1b[0m${BG_OPEN}`,
              `${tool} re-arms the opener after every reset: ${JSON.stringify(line)}`);
          }
        }
      }
    }
  });

  test('background roles follow the tone table, never customMessageBg', () => {
    const lib = require('../lib/worktree-card.js');
    assert.equal(lib.floatBgRoleForTone('info'), 'toolSuccessBg');
    assert.equal(lib.floatBgRoleForTone('success'), 'toolSuccessBg');
    assert.equal(lib.floatBgRoleForTone('warning'), 'toolPendingBg');
    assert.equal(lib.floatBgRoleForTone('error'), 'toolErrorBg');
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const okTheme = floatTheme();
      card.renderResult(resultFor(tool), { expanded: false }, okTheme, {}).render(60);
      assert.ok(okTheme.bgRoles.includes('toolPendingBg'), `${tool} settled tone paints toolPendingBg`);
      const errTheme = floatTheme();
      card.renderResult(
        { content: [{ type: 'text', text: 'boom' }], details: resultFor(tool).details, isError: true },
        { expanded: false }, errTheme, {},
      ).render(60);
      assert.ok(errTheme.bgRoles.includes('toolErrorBg'), `${tool} failure paints toolErrorBg`);
      assert.ok(!errTheme.bgRoles.includes('customMessageBg'), `${tool} never paints the wrong role`);
    }
    const render = createWarpMessageRenderer();
    const warpTheme = floatTheme();
    render(warpMsg(), { expanded: false }, warpTheme).render(60);
    assert.ok(warpTheme.bgRoles.length > 0 && !warpTheme.bgRoles.includes('customMessageBg'),
      `the warp card never paints customMessageBg: ${JSON.stringify(warpTheme.bgRoles)}`);
  });

  test('width under 10 falls back to the outlined card with no paint', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const theme = floatTheme();
      for (const lines of [
        renderLines(card.renderCall(callFor(tool), theme, {}), 9),
        renderLines(card.renderResult(resultFor(tool), { expanded: false }, theme, {}), 9),
      ]) {
        assertFits(lines, 9);
        for (const line of lines) assert.ok(!line.includes(BG_OPEN), `${tool} paints nothing below width 10`);
        assert.ok(stripAnsi(lines[0]).replace(/^ /, '').startsWith('\u258E'), `${tool} keeps the outlined bar: ${JSON.stringify(stripAnsi(lines[0]))}`);
      }
    }
    const render = createWarpMessageRenderer();
    const theme = floatTheme();
    const lines = renderLines(render(warpMsg(), { expanded: false }, theme), 9);
    assertFits(lines, 9);
    for (const line of lines) assert.ok(!line.includes(BG_OPEN), 'warp paints nothing below width 10');
  });

  test('a theme whose bg carries no role falls back with no paint', () => {
    const flat = { fg: (_role, text) => text, bg: (_role, text) => text };
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      for (const lines of [
        renderLines(card.renderCall(callFor(tool), flat, {}), 60),
        renderLines(card.renderResult(resultFor(tool), { expanded: false }, flat, {}), 60),
      ]) {
        assertFits(lines, 60);
        for (const line of lines) assert.ok(!line.includes('\x1b'), `${tool} paints nothing without the role`);
      }
    }
    const render = createWarpMessageRenderer();
    const lines = renderLines(render(warpMsg(), { expanded: false }, flat), 60);
    assertFits(lines, 60);
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'warp paints nothing without the role');
  });

  test('the duration rides the closing rule only when it fits, never as a dash', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const theme = floatTheme();
      const wide = renderLines(
        card.renderResult(resultFor(tool), { expanded: false }, theme, { durationMs: 1200 }), 60);
      assertFullWidthPainted(wide, 60);
      const wideCloser = stripAnsi(wide[wide.length - 1]);
      assert.ok(/1\.2s {1,2}$/.test(wideCloser), `${tool} duration closes the rule when it fits: ${JSON.stringify(wideCloser)}`);
      // the closing rule is the duration's alone, so the only way it is
      // omitted is a duration that leaves no fill column at a narrow width.
      const narrow = renderLines(
        card.renderResult(resultFor(tool), { expanded: false }, floatTheme(), { durationMs: 1234567 }), 12);
      assertFullWidthPainted(narrow, 12);
      const narrowCloser = stripAnsi(narrow[narrow.length - 1]);
      assert.ok(!narrowCloser.includes('1234.6s'), `${tool} omits the duration when it cannot fit: ${JSON.stringify(narrowCloser)}`);
      assert.ok(!narrowCloser.includes('\u2500'), `${tool} never renders a placeholder dash: ${JSON.stringify(narrowCloser)}`);
    }
  });
});

describe('S1: the listing shows no issue or ODD association', () => {
  // S1 removed issue and ODD associations from every worktree surface: a
  // worktree carries neither, so the listing card never renders an issue
  // number, an assigned ODD document or the checkout's `odd/` inventory. The
  // registry still stores those legacy fields, and the details handed to the
  // renderer may still carry them — they are data preservation, not display.
  function bodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  function listResult(worktrees, count) {
    return {
      content: [{ type: 'text', text: worktrees.map((row) => `worktree list: ${row.name} ${row.branch}`).join('\n') }],
      details: { worktrees, count },
    };
  }

  test('expanded list prints identity rows only, with no association rows at all', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const result = listResult([
      { name: 'a-x', path: '/repo/a-x', branch: 'feat/x', issues: [12, 13], assignedOdd: 'odd/x.md', odd: ['odd/x-extra.md', 'odd/x.md'] },
      { name: 'b-y', path: '/repo/b-y', branch: 'feat/y', issues: [], assignedOdd: null, odd: ['odd/y-held.md'] },
      { name: 'c-z', path: '/repo/c-z', branch: 'feat/z', issues: [], assignedOdd: 'odd/assigned.md', odd: ['odd/assigned.md', 'odd/z-two.md'] },
      { name: 'principal', path: '/repo', branch: 'main', issues: [], assignedOdd: null, odd: [] },
    ], 4);
    for (const width of [60, 100]) {
      const rows = bodyRows(renderLines(card.renderResult(result, { expanded: true }, THEME, {}), width));
      assert.deepStrictEqual(rows, [
        'checkouts: 4',
        'a-x \u00B7 feat/x',
        'path: /repo/a-x',
        '',
        'b-y \u00B7 feat/y',
        'path: /repo/b-y',
        '',
        'c-z \u00B7 feat/z',
        'path: /repo/c-z',
        '',
        'principal \u00B7 main',
        'path: /repo',
      ], `expanded listing rows at ${width}`);
    }
    const rows = bodyRows(renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 60));
    for (const label of ['issues:', 'odd:', 'available odd:']) {
      assert.ok(!rows.some((row) => row.startsWith(label)), `no ${label} row: ${JSON.stringify(rows)}`);
    }
    assert.ok(!rows.some((row) => /#\d|\.md\b/.test(row)), 'no issue number or ODD document leaks: ' + JSON.stringify(rows));
  });

  test('legacy association fields change nothing about the rendered rows', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const withLegacy = listResult([
      { name: 'd-w', path: '/repo/d-w', branch: 'feat/w', issues: [7], assignedOdd: 'odd/w.md', odd: ['odd/w.md'] },
    ], 1);
    const stripped = listResult([{ name: 'd-w', path: '/repo/d-w', branch: 'feat/w' }], 1);
    assert.deepStrictEqual(
      bodyRows(renderLines(card.renderResult(withLegacy, { expanded: true }, THEME, {}), 60)),
      bodyRows(renderLines(card.renderResult(stripped, { expanded: true }, THEME, {}), 60)),
      'display ignores the preserved legacy association data',
    );
  });

  test('the collapsed list stays the action and the count, and escapes stay stripped', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const clean = listResult([
      { name: 'a-x', path: '/repo/a-x', branch: 'feat/x', assignedOdd: 'odd/x.md', odd: ['odd/x.md'] },
    ], 1);
    assert.deepStrictEqual(
      bodyRows(renderLines(card.renderResult(clean, { expanded: false }, THEME, {}), 60)),
      ['listed: 1 checkout'],
      'S12: the collapsed card says what happened, not which associations exist',
    );
    const evil = listResult([
      { name: '\x1b[31ma-x\x1b[0m', path: '/repo/a-x', branch: 'feat/x', assignedOdd: '\x1b[31modd/evil.md\x1b[0m', odd: [] },
    ], 1);
    const lines = renderLines(card.renderResult(evil, { expanded: true }, THEME, {}), 60);
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'escape leaked: ' + JSON.stringify(line));
    const rows = bodyRows(lines);
    assert.ok(rows.includes('a-x \u00B7 feat/x'), 'the cleaned identity still shows: ' + JSON.stringify(rows));
    assert.ok(!rows.some((row) => row.includes('evil')), 'the ODD association never renders: ' + JSON.stringify(rows));
  });
});

describe('S12: compact precision and formatted expanded detail (T8)', () => {
  // The user's report (Image#7): the collapsed card must say only what
  // happened, and the expanded card must read as ordered, labelled,
  // multi-line detail — never the raw `key=value` dump the transcript
  // showed (`worktree list: … thread=t issues=1 odd=a,b,c`) with a giant
  // ODD list on one line. Every row is read from the SAME details object
  // execute() returns; the content text is the model-facing half owned
  // elsewhere and stays out of the formatted body, except as the honest
  // fallback when the details cannot describe the result at all.
  function rowsOf(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  function compactRows(tool, result, width = 100) {
    const card = createWorktreeCardRenderer(tool);
    return rowsOf(renderLines(card.renderResult(result, { expanded: false }, THEME, {}), width));
  }

  function expandedRows(tool, result, width = 100) {
    const card = createWorktreeCardRenderer(tool);
    return rowsOf(renderLines(card.renderResult(result, { expanded: true }, THEME, {}), width)).filter(
      (row) => !row.includes('ctrl+o'),
    );
  }

  // The one guard every expectation below shares: no raw legacy prefix and
  // no key=value pair survives into a formatted body.
  function assertFormatted(rows, label) {
    const text = rows.join('\n');
    assert.ok(!/thread=|issues=|odd=/.test(text), `${label}: no raw key=value pairs: ${JSON.stringify(rows)}`);
    assert.ok(
      !/^worktree (list|create|close|session open|warp):/m.test(text),
      `${label}: no repeated legacy prefix: ${JSON.stringify(rows)}`,
    );
  }

  // One row shape per tool, pinned exactly: identities first, then the
  // labels that carry status, path and associations in a stable order.
  const EXPANDED = {
    worktree_create: [
      'status: created',
      'path: /repo/../feat-cards',
      'registered: new',
      'codegraph: initialized',
    ],
    worktree_list: [
      'checkouts: 1',
      'feat-cards \u00B7 feat/cards',
      'path: /repo/../feat-cards',
    ],
    worktree_close: [
      'name: feat-cards',
      'branch: feat/cards',
      'path: /repo/../feat-cards',
      'branch state: kept',
    ],
    worktree_session_open: [
      'worktree: feat-cards',
      'session: abc123',
      'path: /repo/../feat-cards',
      'status: opened',
    ],
    worktree_warp: [
      'moved: principal',
      'to: feat-cards',
      'path: now in "/repo/../feat-cards"',
      'branch: now in "feat/cards"',
    ],
  };

  const COMPACT = {
    worktree_create: ['status: created'],
    worktree_list: ['listed: 1 checkout'],
    worktree_close: ['removed: feat-cards \u00B7 feat/cards', 'branch kept'],
    worktree_session_open: ['opened: feat-cards \u00B7 abc123'],
    worktree_warp: ['moved: principal', 'to: feat-cards'],
  };

  test('expanded renders ordered, labelled rows per tool — never the raw dump', () => {
    for (const tool of TOOLS) {
      const rows = expandedRows(tool, resultFor(tool));
      assert.deepStrictEqual(rows, EXPANDED[tool], `${tool} expanded rows`);
      assertFormatted(rows, tool);
    }
  });

  test('compact shows only the action and the identity it acted on', () => {
    for (const tool of TOOLS) {
      const rows = compactRows(tool, resultFor(tool));
      assert.deepStrictEqual(rows, COMPACT[tool], `${tool} compact rows`);
      assertFormatted(rows, `${tool} compact`);
      assert.ok(!rows.join('\n').includes('/repo/'), `${tool}: no full path while collapsed: ${JSON.stringify(rows)}`);
      assert.ok(rows.length <= 3, `${tool}: compact stays to three rows, got ${rows.length}`);
    }
  });

  test('compact never reports a create that already existed', () => {
    // S1: the tool only creates, so the one non-create outcome left is the
    // thread's own checkout already being there — and it must never read as a
    // fresh create.
    const owned = {
      content: [{ type: 'text', text: 'created: feat-cards \u00B7 feat/cards \u00B7 already exists' }],
      details: {
        path: '/repo/../feat-cards',
        branch: 'feat/cards',
        alreadyExists: true,
        registered: 'unchanged',
        codegraph: { status: 'present', detail: '' },
      },
    };
    assert.deepStrictEqual(
      compactRows('worktree_create', owned),
      ['status: already existed'],
      'the collapsed card is the status row, and it never reads as a fresh create',
    );
    const expanded = expandedRows('worktree_create', owned);
    assert.deepStrictEqual(expanded, [
      'status: already existed',
      'path: /repo/../feat-cards',
      'registered: unchanged',
      'codegraph: initialized',
    ], 'the expanded card reports the real index state and that no row was written');
  });

  test('S8: the collapsed create card is the status row only and the expanded one drops name/branch', () => {
    // The name is implied by the path and the branch is the tool's input, so
    // both rows only repeat what the caller already knows. What stays: the
    // status, the path, the registry write (S7) and the real CodeGraph state.
    const created = resultFor('worktree_create');
    assert.deepStrictEqual(compactRows('worktree_create', created), ['status: created']);
    const expanded = expandedRows('worktree_create', created);
    assert.deepStrictEqual(expanded, [
      'status: created',
      'path: /repo/../feat-cards',
      'registered: new',
      'codegraph: initialized',
    ]);
    assert.ok(!expanded.some((row) => row.startsWith('name:')), 'no redundant name row');
    assert.ok(!expanded.some((row) => row.startsWith('branch:')), 'no redundant branch row');
    // A fresh checkout whose index the hook could not build still says so.
    const failed = {
      content: [{ type: 'text', text: 'created: feat-cards \u00B7 feat/cards\npath: /repo/../feat-cards\nregistered: replaced\ncodegraph: not initialized (init failed)' }],
      details: {
        path: '/repo/../feat-cards',
        branch: 'feat/cards',
        registered: 'replaced',
        codegraph: { status: 'failed', detail: 'init failed' },
      },
    };
    assert.deepStrictEqual(expandedRows('worktree_create', failed), [
      'status: created',
      'path: /repo/../feat-cards',
      'registered: replaced',
      'codegraph: not initialized (init failed)',
    ]);
  });

  test('a create renders no association rows at all (S1/S6)', () => {
    // The listing still reads legacy registry data, but a CREATE neither
    // accepts nor displays an association: even details that still carry the
    // legacy fields must not reach the card.
    const result = {
      content: [{ type: 'text', text: 'created: feat-cards \u00B7 feat/cards' }],
      details: {
        path: '/repo/../feat-cards',
        branch: 'feat/cards',
        issues: [12, 13],
        odd: 'odd/2026-02-01-native-tool-output.md',
      },
    };
    const rows = expandedRows('worktree_create', result);
    assert.ok(!rows.some((row) => row.startsWith('issues:')), 'no issue row: ' + JSON.stringify(rows));
    assert.ok(!rows.some((row) => row.startsWith('odd:')), 'no odd row: ' + JSON.stringify(rows));
    // S1: the listing shows no association either — the legacy registry data
    // is preserved in the details and deliberately not displayed anywhere.
    const listed = {
      content: [{ type: 'text', text: 'worktree list: feat-cards feat/cards thread=t issues=12' }],
      details: {
        worktrees: [{
          name: 'feat-cards',
          path: '/repo/../feat-cards',
          branch: 'feat/cards',
          issues: [12, 13],
          assignedOdd: 'odd/2026-02-01-native-tool-output.md',
          odd: ['odd/2026-02-01-native-tool-output.md'],
        }],
        count: 1,
      },
    };
    const listRows = expandedRows('worktree_list', listed);
    assert.deepStrictEqual(listRows, [
      'checkouts: 1',
      'feat-cards \u00B7 feat/cards',
      'path: /repo/../feat-cards',
    ], 'the listing row is the checkout identity, with no association cell: ' + JSON.stringify(listRows));
    assert.ok(!listRows.some((row) => row.includes('.md')), 'the odd path never renders: ' + JSON.stringify(listRows));
    const bare = {
      content: [{ type: 'text', text: 'worktree list: feat-cards feat/cards thread=t issues=' }],
      details: {
        worktrees: [{ name: 'feat-cards', path: '/repo/../feat-cards', branch: 'feat/cards', issues: [], assignedOdd: null, odd: [] }],
        count: 1,
      },
    };
    assert.deepStrictEqual(expandedRows('worktree_list', bare), listRows, 'a known-empty association renders nothing at all');
  });

  test('a large listing expands to one labelled block per entry, no association rows', () => {
    // Screenshot-shaped data: many checkouts, each with its own thread and the
    // legacy issue/ODD fields the registry still stores. S1 removed those
    // associations from every worktree surface, so none of it renders.
    function docsFor(index) {
      if (index % 3 === 0) return ['odd/a.md', 'odd/b.md', 'odd/c.md'];
      if (index % 3 === 1) return ['odd/a.md'];
      return [];
    }
    const entries = [];
    for (let index = 0; index < 12; index += 1) {
      const docs = docsFor(index);
      entries.push({
        name: `feat-${index}`,
        path: `/repo/wt/feat-${index}`,
        branch: `feat/branch-${index}`,
        thread: index === 0 ? 'unknown' : `thread-${index}`,
        issues: index % 2 === 0 ? [70 + index, 90 + index] : [],
        assignedOdd: docs.length > 0 ? 'odd/a.md' : null,
        odd: docs,
        status: index === 11 ? 'missing' : 'live',
        kind: 'agent',
      });
    }
    const result = {
      content: [{
        type: 'text',
        text: entries
          .map((row) => `worktree list: ${row.name} ${row.branch} thread=${row.thread} issues=${row.issues.join(',')} odd=${row.odd.join(',')}`)
          .join('\n'),
      }],
      details: { worktrees: entries, count: entries.length, all: true, pruned: [], warnings: [] },
    };
    const card = createWorktreeCardRenderer('worktree_list');
    const rows = expandedRows('worktree_list', result);
    assertFormatted(rows, 'large listing');
    assert.strictEqual(rows[0], 'checkouts: 12');
    for (const entry of entries) {
      // S6: existence is implied by being listed, so `live` adds no cell; a
      // status that DOES carry information rides the identity row it belongs to.
      const identity = [entry.name, entry.branch, entry.status === 'live' ? '' : entry.status]
        .filter((cell) => cell.length > 0)
        .join(' \u00B7 ');
      assert.strictEqual(
        rows.filter((row) => row === identity).length,
        1,
        `${entry.name} has exactly one identity row: ${JSON.stringify(rows)}`,
      );
    }
    assert.ok(!rows.some((row) => row.startsWith('issues:')), 'no issue row anywhere: ' + JSON.stringify(rows));
    assert.ok(!rows.some((row) => row.startsWith('odd:')), 'no ODD row anywhere: ' + JSON.stringify(rows));
    assert.ok(!rows.some((row) => row.includes('.md')), 'no odd path or .md suffix leaks into the card');
    assert.ok(!rows.some((row) => /#\d/.test(row)), 'no issue number leaks into the card');
    assert.ok(rows.includes('thread: thread-1'), 'a known thread is detail, not noise');
    assert.ok(!rows.includes('thread: unknown'), 'the unknown thread placeholder never renders');
    assert.strictEqual(
      rows.filter((row) => row === 'feat-11 \u00B7 feat/branch-11 \u00B7 missing').length,
      1,
      'the missing status survives on the entry it belongs to',
    );
    assert.ok(!rows.some((row) => row.startsWith('status:')), 'no status row: ' + JSON.stringify(rows));
    assert.ok(!rows.some((row) => row.endsWith('\u00B7 live')), 'the redundant live status never renders');
    for (const width of [30, 60, 100]) {
      const lines = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), width);
      assertFits(lines, width);
      assertFrame(lines);
    }
  });

  test('expanded failures keep the honest prose and invent no success row', () => {
    for (const tool of TOOLS) {
      const failed = {
        content: [{ type: 'text', text: `worktree ${tool}: refused, the checkout is still listed` }],
        details: resultFor(tool).details,
        isError: true,
      };
      const rows = expandedRows(tool, failed);
      assert.ok(
        rows.some((row) => row.includes('the checkout is still listed')),
        `${tool}: the failure text reaches the expanded card: ${JSON.stringify(rows)}`,
      );
      assert.ok(
        !rows.some((row) => /^status: (created|opened|resumed|updated|live)/.test(row)),
        `${tool}: no success status is invented for a failure: ${JSON.stringify(rows)}`,
      );
    }
  });

  test('preserve: an expanded failure keeps every prose line, the collapsed one stays bounded', () => {
    for (const tool of TOOLS) {
      const prose = ['refused: the branch is checked out elsewhere', 'hint: run worktree list', 'hint: close it first', 'hint: then retry', 'note: the registry was left untouched'];
      const failed = { content: [{ type: 'text', text: prose.join('\n') }], details: {}, isError: true };
      const expanded = expandedRows(tool, failed);
      for (const line of prose) {
        assert.ok(expanded.some((row) => row.includes(line)), `${tool}: expanded keeps ${JSON.stringify(line)}`);
      }
      const collapsed = compactRows(tool, failed);
      assert.ok(collapsed.length <= 5, `${tool}: the collapsed failure stays bounded: ${JSON.stringify(collapsed)}`);
      assert.ok(collapsed[0].includes('error') || collapsed[0].includes('refused'), `${tool}: the failure head survives`);
    }
  });

  test('a partial result still marks itself receiving in the expanded form', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const rows = rowsOf(renderLines(
        card.renderResult(resultFor(tool), { expanded: true, isPartial: true }, THEME, {}), 100,
      )).filter((row) => !row.includes('ctrl+o'));
      assert.strictEqual(rows[rows.length - 1], 'receiving\u2026', `${tool}: expanded partial says receiving`);
    }
  });

  test('expanded never invents a value the details do not carry', () => {
    const close = {
      content: [{ type: 'text', text: 'worktree close: /repo/../feat-ghost (branch feat/ghost)' }],
      details: { path: '/repo/../feat-ghost', removed: true, branchKept: false },
    };
    const rows = expandedRows('worktree_close', close);
    assert.deepStrictEqual(rows, ['name: feat-ghost', 'path: /repo/../feat-ghost', 'branch state: deleted']);
    assert.ok(!rows.some((row) => row.includes('feat/ghost')), 'no branch row without a branch value');
    const bare = {
      content: [{ type: 'text', text: 'opened: feat-cards \u00B7 abc123' }],
      details: {},
    };
    assert.ok(
      expandedRows('worktree_session_open', bare).includes('opened: feat-cards \u00B7 abc123'),
      'undescribable details fall back to the content instead of an empty body',
    );
  });

  test('expanded wraps a long value instead of cutting it, at every width', () => {
    const longPath = `/repo/very-long-checkout-path-${'x'.repeat(120)}`;
    const result = {
      content: [{ type: 'text', text: 'created: feat-cards \u00B7 feat/cards' }],
      details: {
        path: longPath,
        branch: 'feat/cards',
        issues: [12],
        created: true,
        odd: 'odd/deep/nested/design-doc.md',
      },
    };
    const card = createWorktreeCardRenderer('worktree_create');
    for (const width of [30, 60, 100]) {
      const lines = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), width);
      assertFits(lines, width);
      assertFrame(lines);
      const rows = rowsOf(lines).filter((row) => !row.includes('ctrl+o'));
      assert.ok(!rows.join('').includes('\u2026'), `${width}: expanded never truncates values`);
      assert.ok(rows.join('').includes(longPath), `${width}: the whole path survives across wrapped rows`);
    }
  });

  test('every labelled row keeps its label at every width', () => {
    for (const tool of TOOLS) {
      const wideRows = expandedRows(tool, resultFor(tool), 100);
      for (const width of [30, 60]) {
        const text = expandedRows(tool, resultFor(tool), width).join('\n');
        for (const row of wideRows) {
          if (!row.includes(': ')) continue;
          const label = row.slice(0, row.indexOf(': ') + 1);
          assert.ok(text.includes(label), `${tool}: ${label} survives ${width}: ${JSON.stringify(text)}`);
        }
      }
    }
  });

  test('a listing never claims a current checkout the result does not name', () => {
    // executeWorktreeList puts the PRINCIPAL first and the session's own
    // checkout SECOND when they differ, and no details field names which row
    // is current — so `current: <rows[0].name>` read `current: principal`
    // for a session sitting in a linked worktree. Array order is never an
    // identity: the compact card names the action and the count only.
    const withLinkedSession = {
      content: [{
        type: 'text',
        text: 'worktree list: principal main principal\nworktree list: feat-cards feat/cards thread=t1 issues=12',
      }],
      details: {
        count: 2,
        all: false,
        pruned: [],
        warnings: [],
        worktrees: [
          { name: 'principal', path: '/repo', branch: 'main', thread: null, issues: [], odd: [], status: 'live', kind: 'principal' },
          { name: 'feat-cards', path: '/repo/feat-cards', branch: 'feat/cards', thread: 't1', issues: [12], odd: [], status: 'live', kind: 'agent' },
        ],
      },
    };
    const reversed = {
      ...withLinkedSession,
      details: { ...withLinkedSession.details, worktrees: [...withLinkedSession.details.worktrees].reverse() },
    };
    for (const entry of [['principal first', withLinkedSession], ['agent first', reversed]]) {
      const label = entry[0];
      const result = entry[1];
      for (const width of [30, 60, 100]) {
        const rows = compactRows('worktree_list', result, width);
        const text = rows.join('\n');
        assert.ok(!text.includes('current'), `${label} at ${width}: no current claim: ${JSON.stringify(rows)}`);
        assert.ok(!text.includes('principal'), `${label} at ${width}: the principal is not named as current: ${JSON.stringify(rows)}`);
        assert.ok(!text.includes('feat-cards'), `${label} at ${width}: no checkout is named: ${JSON.stringify(rows)}`);
        assert.ok(/^listed: 2 checkouts$/.test(rows[0]), `${label} at ${width}: the action reads: ${JSON.stringify(rows)}`);
      }
    }
    const expanded = expandedRows('worktree_list', withLinkedSession).join('\n');
    assert.ok(
      expanded.includes('principal \u00B7 main') && expanded.includes('feat-cards \u00B7 feat/cards'),
      'the expanded detail still names every checkout: ' + JSON.stringify(expandedRows('worktree_list', withLinkedSession)),
    );
  });

  test('an unknown or zero count stays truthful in the compact card', () => {
    const noCount = {
      content: [{ type: 'text', text: 'worktree list: principal main principal' }],
      details: { worktrees: [{ name: 'principal', path: '/repo', branch: 'main' }] },
    };
    assert.deepStrictEqual(
      compactRows('worktree_list', noCount),
      ['worktree list: principal main principal'],
      'without a count the honest first line stands in, never a guessed total',
    );
    const empty = { content: [{ type: 'text', text: 'worktree list: none' }], details: { worktrees: [], count: 0 } };
    assert.deepStrictEqual(compactRows('worktree_list', empty), ['no worktrees']);
    assert.ok(!compactRows('worktree_list', empty).join('').includes('current'), 'an empty listing claims no current checkout');
    const noText = { content: [{ type: 'text', text: '' }], details: { worktrees: [], count: 0 } };
    assert.deepStrictEqual(compactRows('worktree_list', noText), ['no worktrees', '(no output)']);
  });

  test('preserve: close and warp keep their S19/S42 rows on both states', () => {
    assert.deepStrictEqual(compactRows('worktree_close', resultFor('worktree_close')), [
      'removed: feat-cards \u00B7 feat/cards',
      'branch kept',
    ]);
    assert.deepStrictEqual(compactRows('worktree_warp', resultFor('worktree_warp')), [
      'moved: principal',
      'to: feat-cards',
    ]);
    const warpRows = expandedRows('worktree_warp', resultFor('worktree_warp'));
    assert.deepStrictEqual(warpRows.slice(2), [
      'path: now in "/repo/../feat-cards"',
      'branch: now in "feat/cards"',
    ], 'S42: expanded appends path then branch after the names');
  });
});

describe('S6: the expanded listing is one block per checkout, without a live status', () => {
  // The user's report (L10): the listing's status "no tiene sentido, pues si
  // esta en la lista es porque existe" — every listed row IS a real checkout
  // (a row whose path is gone is pruned and never listed), so `live` is a row
  // that only repeats the fact that the entry exists. The statuses that carry
  // information stay: `missing` (the path exists but git no longer lists the
  // checkout) and `unregistered` (a live checkout the registry does not own).
  // The same report asks for list separation — "no se nota separacion de
  // listado en expanded, esta como todo acoplado" — so each entry is one block
  // separated from the next by a blank row, and nothing is repeated per entry.
  function rowsOf(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500') && !row.includes('ctrl+o'));
  }

  function listResult(entries, extra = {}) {
    return {
      content: [{ type: 'text', text: entries.map((row) => `worktree list: ${row.name} ${row.branch}`).join('\n') }],
      details: { worktrees: entries, count: entries.length, all: true, pruned: [], warnings: [], ...extra },
    };
  }

  function expandedRowsOf(entries, width) {
    const card = createWorktreeCardRenderer('worktree_list');
    return rowsOf(renderLines(card.renderResult(listResult(entries), { expanded: true }, THEME, {}), width));
  }

  const ENTRIES = [
    { name: 'principal', path: '/repo', branch: 'main', thread: null, status: 'live', kind: 'principal' },
    { name: 'fix-worktree', path: '/repo/wt/fix-worktree', branch: 'fix/worktree-issues', thread: 't1', status: 'live', kind: 'agent' },
    { name: 'feat-cards', path: '/repo/wt/feat-cards', branch: 'feat/cards', thread: 't2', status: 'missing', kind: 'agent' },
    { name: 'feat-x', path: '/repo/wt/feat-x', branch: 'feat/x', thread: null, status: 'unregistered', kind: 'unregistered' },
  ];

  test('no live or exists status is printed, and the meaningful ones ride the identity row', () => {
    const rows = expandedRowsOf(ENTRIES, 100);
    const text = rows.join('\n');
    assert.ok(!/\b(live|exists)\b/.test(text), `no redundant existence status: ${JSON.stringify(rows)}`);
    assert.ok(!rows.some((row) => row.startsWith('status:')), `no status row at all: ${JSON.stringify(rows)}`);
    assert.ok(
      rows.includes('feat-cards \u00B7 feat/cards \u00B7 missing'),
      `the missing status survives on the entry it belongs to: ${JSON.stringify(rows)}`,
    );
    assert.ok(
      rows.includes('feat-x \u00B7 feat/x \u00B7 unregistered'),
      `the unregistered status survives too: ${JSON.stringify(rows)}`,
    );
    assert.strictEqual(
      rows.filter((row) => row.endsWith('missing')).length, 1,
      `the missing status is stated once: ${JSON.stringify(rows)}`,
    );
  });

  test('every entry is its own block, separated by exactly one blank row', () => {
    const expected = [
      'checkouts: 4',
      'principal \u00B7 main',
      'path: /repo',
      '',
      'fix-worktree \u00B7 fix/worktree-issues',
      'path: /repo/wt/fix-worktree',
      'thread: t1',
      '',
      'feat-cards \u00B7 feat/cards \u00B7 missing',
      'path: /repo/wt/feat-cards',
      'thread: t2',
      '',
      'feat-x \u00B7 feat/x \u00B7 unregistered',
      'path: /repo/wt/feat-x',
    ];
    for (const width of [60, 100]) {
      const rows = expandedRowsOf(ENTRIES, width);
      assert.deepStrictEqual(rows, expected, `expanded listing blocks at ${width}`);
      assert.strictEqual(
        rows.filter((row) => row === '').length,
        ENTRIES.length - 1,
        `one separator between the blocks, none at the edges: ${JSON.stringify(rows)}`,
      );
      assert.strictEqual(rows[0], 'checkouts: 4', 'the count leads the listing');
      assert.notStrictEqual(rows[rows.length - 1], '', 'the listing never ends on a separator');
    }
  });

  test('the blocks stay framed and fitting at every width, wrapping instead of cutting', () => {
    for (const width of [30, 60, 100]) {
      const lines = renderLines(
        createWorktreeCardRenderer('worktree_list').renderResult(listResult(ENTRIES), { expanded: true }, THEME, {}), width,
      );
      assertFits(lines, width);
      assertFrame(lines);
      const rows = rowsOf(lines).filter((row) => row !== '').join('');
      assert.ok(!rows.includes('\u2026'), `${width}: expanded never truncates: ${JSON.stringify(rows)}`);
      for (const entry of ENTRIES) {
        assert.ok(rows.includes(entry.path), `${width}: ${entry.path} survives whole`);
      }
    }
  });

  test('preserve: the collapsed listing still states the action and the count only', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    for (const width of [30, 60, 100]) {
      const rows = rowsOf(renderLines(card.renderResult(listResult(ENTRIES), { expanded: false }, THEME, {}), width));
      assert.deepStrictEqual(rows, ['listed: 4 checkouts'], `collapsed listing at ${width}`);
    }
    assert.deepStrictEqual(
      rowsOf(renderLines(card.renderResult(listResult([]), { expanded: true }, THEME, {}), 60)),
      ['checkouts: 0'],
      'an empty listing is still one count row',
    );
  });
});
