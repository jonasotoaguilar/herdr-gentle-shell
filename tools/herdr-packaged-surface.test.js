'use strict';
// What the published package ships, after the worktree/plugin-tools removal
// (odd/tasks/split-odd-worktree.md S1, S3).
//
// A document is part of the product: `rules/worktrees.md` shipped inside the
// tarball and taught the deleted `worktree_*` tools, so an install kept handing
// an agent instructions it could not follow. These assertions read the same
// `files` list npm packs from, so a removed surface cannot come back through a
// stray document, a leftover module, or a package entry that ships nothing.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SHIPPED = PKG.files ?? [];

// Commands and agent tools the package no longer implements. The session
// opener (`worktree_session_open`) is NOT on this list: it is retained (S6).
const REMOVED_SURFACE = [
  '/herdr-gentle:customize',
  '/herdr-gentle:odd',
  '/herdr-gentle:issues',
  '/herdr-gentle:warp',
  '/herdr-gentle:worktree',
  'worktree_create',
  'worktree_list',
  'worktree_close',
  'worktree_warp',
];

// Modules whose only consumers were the removed tools, panels and readers.
const OBSOLETE_MODULES = [
  'clipboard.js',
  'herdr-plugin-check.js',
  'moshi-prereq.js',
  'open-external.js',
  'perf-observer.js',
  'preview-scroll-keys.js',
  'session-auto-name.js',
  'tui-paint.js',
  'view-layout.js',
  'worktree-mode.js',
];

const TEXT_EXTENSIONS = new Set(['.js', '.ts', '.md', '.json', '.toml', '.mjs', '.sh']);

// DESIGN.md is excluded on purpose: it is the design record and states what was
// removed, which is documentation of the change rather than an instruction.
const DESIGN_RECORD = path.join(ROOT, 'DESIGN.md');

function shippedPaths() {
  const files = [];
  const walk = (abs) => {
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) walk(path.join(abs, name));
      return;
    }
    if (TEXT_EXTENSIONS.has(path.extname(abs)) && abs !== DESIGN_RECORD) files.push(abs);
  };
  for (const entry of SHIPPED) {
    const abs = path.join(ROOT, entry);
    if (fs.existsSync(abs)) walk(abs);
  }
  return files;
}

describe('packaged rules', () => {
  test('ship no worktree rules document', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'rules', 'worktrees.md')), false);
    assert.equal(SHIPPED.includes('rules'), false, 'package.json still ships the rules directory');
  });

  test('ship only package entries that exist', () => {
    for (const entry of SHIPPED) {
      assert.ok(fs.existsSync(path.join(ROOT, entry)), `files[] entry is missing on disk: ${entry}`);
    }
  });

  test('teach no removed command or agent tool', () => {
    const offenders = [];
    for (const file of shippedPaths()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const needle of REMOVED_SURFACE) {
        if (text.includes(needle)) offenders.push(`${path.relative(ROOT, file)}: ${needle}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('packaged modules', () => {
  test('ship no module whose consumers were removed', () => {
    for (const name of OBSOLETE_MODULES) {
      assert.equal(fs.existsSync(path.join(ROOT, 'lib', name)), false, `lib/${name} still ships`);
    }
  });

  test('ship no unreferenced library', () => {
    const libs = fs.readdirSync(path.join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).sort();
    // Everything that can name a module: the shipped surface plus the Herdr
    // plugin and the installer, which load these libs from the Pi package.
    const referrers = [
      ...shippedPaths(),
      ...walkText(path.join(ROOT, 'herdr-plugin')),
      path.join(ROOT, 'install.sh'),
    ];
    const orphans = [];
    for (const name of libs) {
      const used = referrers.some((file) => {
        if (path.basename(file) === name) return false;
        try {
          return fs.readFileSync(file, 'utf8').includes(name);
        } catch {
          return false;
        }
      });
      if (!used) orphans.push(`lib/${name}`);
    }
    assert.deepEqual(orphans, []);
  });
});

function walkText(abs) {
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return fs.readdirSync(abs).flatMap((name) => walkText(path.join(abs, name)));
  return TEXT_EXTENSIONS.has(path.extname(abs)) ? [abs] : [];
}
