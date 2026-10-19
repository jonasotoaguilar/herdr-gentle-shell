'use strict';
// Tests for lib/session-auto-name.js (T2 of odd/tasks/session-auto-name.md,
// D2-D7): the PURE derivation of the session name from the ODD document a
// tool call wrote, and the ownership test that decides whether the plugin
// may write a name at all.
//
// Contract under test, observable only through the module's exports:
// - only a WRITE to `odd/tasks/<feature>.md` derives a label, and the label
//   is `<feature> @ <branch>`;
// - a read (or a write anywhere else) derives nothing;
// - the same label over the same current name is a no-op, so a caller can
//   run the planner on every event without issuing repeated host writes;
// - a name that is not empty and does not match the plugin's own pattern was
//   chosen by a human and is never replaced;
// - the ownership test accepts exactly the two shapes the plugin writes
//   (`<feature>` and `<feature> @ <branch>`) plus the empty/unnamed session.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const auto = require('../lib/session-auto-name.js');

function plan(rels, overrides = {}) {
  return auto.planSessionRename({
    rels,
    isWrite: true,
    branch: 'feat/perf-switches',
    currentName: '',
    ...overrides,
  });
}

describe('session auto name derivation', () => {
  test('a write to odd/tasks/<feature>.md derives <feature> @ <branch>', () => {
    assert.equal(plan(['odd/tasks/perf-switches.md']), 'perf-switches @ feat/perf-switches');
    // The label uses the document's feature and the owning branch verbatim.
    assert.equal(
      plan(['odd/tasks/session-auto-name.md'], { branch: 'feat/session-auto-name' }),
      'session-auto-name @ feat/session-auto-name',
    );
    // A nested document keeps its relative path as the feature.
    assert.equal(plan(['odd/tasks/perf/plan.md']), 'perf/plan @ feat/perf-switches');
  });

  test('a read derives nothing', () => {
    assert.equal(plan(['odd/tasks/perf-switches.md'], { isWrite: false }), null);
  });

  test('a write that is not an odd/tasks document derives nothing', () => {
    for (const rels of [
      ['odd/session-auto-name.md'],
      ['odd/tasks/'],
      ['odd/tasks/perf-switches.txt'],
      ['odd/tasks/.md'],
      ['docs/odd/tasks/perf-switches.md'],
      ['src/app.js'],
      [],
    ]) {
      assert.equal(plan(rels), null, `expected no label for ${JSON.stringify(rels)}`);
    }
  });

  test('the first odd/tasks document of the call wins', () => {
    assert.equal(plan(['odd/notes.md', 'odd/tasks/first.md', 'odd/tasks/second.md']), 'first @ feat/perf-switches');
  });

  test('the same label over the same current name is a no-op', () => {
    assert.equal(plan(['odd/tasks/perf-switches.md'], { currentName: 'perf-switches @ feat/perf-switches' }), null);
  });

  test('a resumed session recomputes when the document changed', () => {
    // The previous label is the plugin's own, so it may move to the feature
    // the session is working on now.
    assert.equal(
      plan(['odd/tasks/new-feature.md'], { currentName: 'old-feature @ feat/perf-switches' }),
      'new-feature @ feat/perf-switches',
    );
  });

  test('a human-chosen name is never replaced', () => {
    // D7's admitted ambiguity: a hand-typed name that IS the plugin's shape
    // (say `perf-switches`) is indistinguishable from the plugin's own label.
    // Every other hand-typed name fails the ownership test and survives.
    for (const currentName of ['my own session', 'Perf switches', 'session auto name', 'fix@home']) {
      assert.equal(
        plan(['odd/tasks/perf-switches.md'], { currentName }),
        null,
        `expected the human name ${JSON.stringify(currentName)} to survive`,
      );
    }
  });

  test('without a branch the label is the bare feature name', () => {
    assert.equal(plan(['odd/tasks/perf-switches.md'], { branch: '' }), 'perf-switches');
    assert.equal(plan(['odd/tasks/perf-switches.md'], { branch: undefined }), 'perf-switches');
    assert.equal(plan(['odd/tasks/perf-switches.md'], { branch: '  ' }), 'perf-switches');
  });

  test('write tools are recognized by name and reads are not', () => {
    assert.equal(auto.isWriteToolName('write'), true);
    assert.equal(auto.isWriteToolName('edit'), true);
    assert.equal(auto.isWriteToolName('read'), false);
    assert.equal(auto.isWriteToolName('bash'), false);
    assert.equal(auto.isWriteToolName(undefined), false);
  });

  test('the ownership test accepts exactly the plugin pattern plus the empty name', () => {
    assert.equal(auto.isPluginSessionName('perf-switches'), true);
    assert.equal(auto.isPluginSessionName('perf-switches @ feat/perf-switches'), true);
    assert.equal(auto.isPluginSessionName('perf/plan @ feat/perf-switches'), true);
    assert.equal(auto.isPluginSessionName('feature @ fix/#1'), true);
    for (const name of [
      '',
      '   ',
      'my own session',
      'Perf switches',
      'perf-switches@feat/perf-switches',
      'perf-switches @ ',
      ' @ feat/perf-switches',
      'perf switches @ feat/perf-switches',
      'perf-switches @ feat perf',
      'perf-switches @ a @ b',
      'perf-switches @ ',
      'perf-switches ',
    ]) {
      assert.equal(auto.isPluginSessionName(name), false, `expected ${JSON.stringify(name)} to be human-owned`);
    }
  });

  test('an unnamed session is writable and a human name is not', () => {
    assert.equal(auto.canAdoptSessionName(''), true);
    assert.equal(auto.canAdoptSessionName(undefined), true);
    assert.equal(auto.canAdoptSessionName(null), true);
    assert.equal(auto.canAdoptSessionName('perf-switches @ feat/x'), true);
    assert.equal(auto.canAdoptSessionName('my own session'), false);
  });
});

// The document's own heading is the honest source for what the session is
// about (D2), so the label head comes from the first level-1 heading and the
// filename slug is only the fallback. These tests call the module through
// `planSessionRename` / `canAdoptSessionName` only.
const BRANCH = 'feat/pi-fullscreen-perf';

function planDocument({ text, rel = 'odd/tasks/pi-fullscreen-perf.md', readDocument, ...overrides } = {}) {
  return auto.planSessionRename({
    rels: [rel],
    isWrite: true,
    branch: BRANCH,
    currentName: '',
    readDocument: readDocument !== undefined ? readDocument : () => text,
    ...overrides,
  });
}

describe('session auto name from the document heading', () => {
  test('the label uses the document first level-1 heading', () => {
    assert.equal(
      planDocument({ text: '# Pi fullscreen performance for long sessions\n\nBody.\n' }),
      `Pi fullscreen performance for long sessions${auto.BRANCH_SEPARATOR}${BRANCH}`,
    );
    // Inner whitespace collapses and outer whitespace is trimmed.
    assert.equal(
      planDocument({ text: '#   Pi    fullscreen  \n' }),
      `Pi fullscreen${auto.BRANCH_SEPARATOR}${BRANCH}`,
    );
    // A deeper heading is a section title, not the document's own heading.
    assert.equal(
      planDocument({ text: '## Section\n# Real heading\n' }),
      `Real heading${auto.BRANCH_SEPARATOR}${BRANCH}`,
    );
  });

  test('a long heading is truncated to 48 characters on a word boundary', () => {
    assert.equal(
      planDocument({ text: '# Automatic session naming from the ODD work in progress\n' }),
      `Automatic session naming from the ODD work in${auto.BRANCH_SEPARATOR}${BRANCH}`,
    );
  });

  test('a document without a readable heading falls back to the filename slug', () => {
    const slug = `pi-fullscreen-perf${auto.BRANCH_SEPARATOR}${BRANCH}`;
    assert.equal(planDocument({ readDocument: undefined }), slug, 'no reader at all');
    assert.equal(planDocument({ text: '' }), slug, 'empty document');
    assert.equal(planDocument({ text: 'no heading here\n' }), slug, 'no level-1 heading');
    assert.equal(planDocument({ text: '#\n' }), slug, 'empty heading');
    assert.equal(planDocument({ text: '#NoSpace\n' }), slug, 'a hashed word is prose, not a heading');
    assert.equal(planDocument({ readDocument: () => { throw new Error('unreadable'); } }), slug, 'reader throws');
    assert.equal(planDocument({ readDocument: () => 42 }), slug, 'reader returns a non-string');
  });

  test('the label is stable across two writes of the same document', () => {
    const text = '# Pi fullscreen performance for long sessions\n';
    const first = planDocument({ text });
    assert.equal(first, `Pi fullscreen performance for long sessions${auto.BRANCH_SEPARATOR}${BRANCH}`);
    assert.equal(planDocument({ text, currentName: first }), null, 'the second write is a no-op');
    assert.equal(planDocument({ text, currentName: first }), null, 'and stays a no-op');
  });

  test('a heading with spaces is the plugin own name through the branch suffix', () => {
    const heading = `Pi fullscreen performance for long sessions${auto.BRANCH_SEPARATOR}${BRANCH}`;
    // (b): the branch suffix this worktree writes pins the name as ours,
    // which is what survives a resume with no in-memory state.
    assert.equal(auto.canAdoptSessionName(heading, { branch: BRANCH }), true);
    // A different branch is a different worktree, so this name is not ours.
    assert.equal(auto.canAdoptSessionName(heading, { branch: 'feat/other' }), false);
    // Without any context the heading shape stays unrecognized.
    assert.equal(auto.isPluginSessionName(heading), false);
  });

  test('a heading name carrying a different branch is never touched', () => {
    assert.equal(
      planDocument({ text: '# Pi fullscreen performance for long sessions\n', currentName: `Pi fullscreen performance for long sessions${auto.BRANCH_SEPARATOR}feat/other` }),
      null,
    );
  });

  test('a human name with spaces matching none of the four shapes is refused', () => {
    const human = 'Fix the sidebar layout by hand';
    assert.equal(
      auto.canAdoptSessionName(human, { branch: BRANCH, feature: 'pi-fullscreen-perf', documentLabel: 'Pi fullscreen performance' }),
      false,
    );
    assert.equal(auto.canAdoptSessionName(human, {}), false);
  });

  test('ownership also recognises the applied label, the slug and the heading', () => {
    // (a) the label this session already applied (reused from the memory).
    assert.equal(auto.canAdoptSessionName('Old heading', { branch: BRANCH, appliedLabel: 'Old heading' }), true);
    // (c) the plain filename slug an earlier version wrote.
    assert.equal(auto.canAdoptSessionName('pi-fullscreen-perf', { feature: 'pi-fullscreen-perf' }), true);
    // (d) the document's current heading.
    assert.equal(
      auto.canAdoptSessionName('Pi fullscreen performance', { documentLabel: 'Pi fullscreen performance' }),
      true,
    );
    // A near miss is still human.
    assert.equal(auto.canAdoptSessionName('Pi fullscreen', { documentLabel: 'Pi fullscreen performance' }), false);
  });
});

describe('ODD phase transition re-application', () => {
  const text = '# Pi fullscreen performance for long sessions\n';
  const label = `Pi fullscreen performance for long sessions${auto.BRANCH_SEPARATOR}${BRANCH}`;

  test('a phase transition re-applies the label remembered from the write', () => {
    assert.equal(planDocument({ text, sessionId: 's-applied', currentName: '' }), label);
    // The name was lost (resumed record) and the phase is the only event
    // left: the remembered label comes back through the same ownership test.
    assert.equal(
      auto.planPhaseSessionRename({ sessionId: 's-applied', branch: BRANCH, currentName: '' }),
      label,
    );
  });

  test('a phase transition applies nothing when the session never wrote an ODD document', () => {
    assert.equal(auto.planPhaseSessionRename({ sessionId: 's-no-write', branch: BRANCH, currentName: '' }), null);
    assert.equal(auto.planPhaseSessionRename({ branch: BRANCH, currentName: '' }), null, 'and without a session id');
  });

  test('a phase transition still refuses a human-chosen name', () => {
    assert.equal(planDocument({ text, sessionId: 's-human', currentName: '' }), label);
    assert.equal(
      auto.planPhaseSessionRename({ sessionId: 's-human', branch: BRANCH, currentName: 'my own session' }),
      null,
    );
  });

  test('a phase transition is a no-op when the label is already applied', () => {
    assert.equal(planDocument({ text, sessionId: 's-noop', currentName: '' }), label);
    assert.equal(
      auto.planPhaseSessionRename({ sessionId: 's-noop', branch: BRANCH, currentName: label }),
      null,
    );
  });

  test('a later write moves the remembered label the phase re-applies', () => {
    assert.equal(planDocument({ text, sessionId: 's-move' }), label);
    const moved = `Renamed document${auto.BRANCH_SEPARATOR}${BRANCH}`;
    assert.equal(planDocument({ text: '# Renamed document\n', sessionId: 's-move', currentName: label }), moved);
    assert.equal(auto.planPhaseSessionRename({ sessionId: 's-move', branch: BRANCH, currentName: '' }), moved);
  });
});
