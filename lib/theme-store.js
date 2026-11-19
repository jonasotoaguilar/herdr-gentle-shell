#!/usr/bin/env node
'use strict';

// The persisted theme switch: whether Herdr follows Pi's active theme (S1/S2)
// and, with the sync off, the one theme the user assigned (S4).
//
// This file is the only persisted truth the customize panel reads and writes, so
// it is deliberately one small JSON document with inert defaults: a fresh
// install writes NOTHING, and a document this module cannot read is a refusal
// rather than a guess, because guessing here would silently repaint Herdr with a
// palette the user never chose (S7).
//
// One document, one directory: `themeStateDir` must resolve the SAME plugin state
// dir the Moshi flag already uses, or the panel toggles two places and the switch
// reads as missing — and a missing switch means "off", so a stored `sync: true`
// would go unnoticed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { normalizeThemeName } = require('./theme-projection.js');

const THEME_FILE_NAME = 'gentle-theme.json';
const STORED_SEGMENT = 'herdr-gentle-agents';
const ACTIVE_PLUGIN_ID = 'herdr-gentle-shell';
const OWNED_DIR_NAMES = [ACTIVE_PLUGIN_ID, STORED_SEGMENT];

// The same known-file family every state-dir consumer declares, kept byte-equal
// on purpose: a consumer that does not recognise a file another one writes picks
// a different directory on the next launch and splits the state (see
// tools/state-dir-known-files.test.js). `gentle-theme.json` is deliberately NOT
// in it — this module must resolve the directory exactly like the Moshi flag
// does, and adding a file here would make the resolution diverge from the very
// function it reproduces.
const KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
  'gentle-plugin-tools.json',
];

// Reproduces `sidebarEffectiveDir()` in extensions/gentle-herdr-state.ts:1806
// (with `sidebarStoredDir()` at :1747 and `sidebarActiveDir()`/`sidebarCanonicalDir()`
// above it). Duplicating it is deliberate: the extension is TypeScript and cannot
// require this module, and both sides of the feature must agree on one file, so
// the decision order is copied verbatim — explicit `GENTLE_STATUS_STATE_DIR`
// override, then the stored canonical dir, then the active-id dir when only it
// holds a file of ours, then the stored dir as the final fallback. Change that
// function and this one in the same commit.
//
// It takes `env` instead of reading process.env only so the resolution is
// assertable; every value and every ordering rule is the extension's.
function themeStateDir(env = process.env) {
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const stored = storedStateDir(env);
  // An explicit-but-empty (or otherwise invalid non-nullish) value ignores every
  // other candidate and uses the stored default; only an omitted explicit falls
  // through to the active-id dir.
  if (explicit !== undefined && explicit !== null) return stored;
  const active = activeStateDir(env);
  if (active === stored) return stored;
  try {
    if (dirHasKnownFiles(stored)) return stored;
    if (dirHasKnownFiles(active)) return active;
  } catch {
    // Fall through to the stored canonical dir on unexpected failure.
  }
  return stored;
}

function themeStatePath(env = process.env) {
  return path.join(themeStateDir(env), THEME_FILE_NAME);
}

function pluginsDir(env) {
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'herdr')
    : path.join(os.homedir(), '.local', 'state', 'herdr');
  return path.join(base, 'plugins');
}

function storedStateDir(env) {
  return path.join(pluginsDir(env), STORED_SEGMENT);
}

// Two spellings name the same directory when their canonical forms match. A path
// that does not exist yet has no realpath, so the deepest existing ancestor is
// resolved and the missing tail re-appended, which keeps a symlinked or relative
// spelling from being rejected as a different directory.
function canonicalDir(dir) {
  const absolute = path.resolve(dir);
  const tail = [];
  let current = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// The active plugin id dir: the Herdr-injected one only when it IS the directory
// this package derives for that name under the resolved state home. Any other
// basename — or an owned basename under another root — is ignored, because
// honouring it selects a directory the rest of the package never writes.
function activeStateDir(env) {
  const base = pluginsDir(env);
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  if (typeof injected === 'string' && injected.length > 0) {
    const name = path.basename(injected);
    if (OWNED_DIR_NAMES.includes(name) && canonicalDir(injected) === canonicalDir(path.join(base, name))) {
      return injected;
    }
  }
  return path.join(base, ACTIVE_PLUGIN_ID);
}

function dirHasKnownFiles(dir) {
  for (const name of KNOWN_FILES) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // A single unreadable entry never decides; keep scanning.
    }
  }
  return false;
}

// Pi strips a single leading BOM before parsing; do the same.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// A missing file is an inert document (S7: a fresh install writes nothing, so
// nothing is what it reads). A file that cannot be read or parsed is a refusal:
// the caller records "not read" with the inert defaults instead of trusting a
// partially understood switch.
function readThemeState(env = process.env) {
  const file = themeStatePath(env);
  const inert = { ok: false, sync: false, theme: null, updatedAt: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, sync: false, theme: null, updatedAt: null };
    return { ...inert, error: `cannot read ${file}: ${err.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(stripBom(raw));
  } catch (err) {
    return { ...inert, error: `cannot parse ${file}: ${err.message}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ...inert, error: `cannot parse ${file}: top-level JSON must be an object` };
  }
  // The switch is on only when the document literally says so; an unusable theme
  // is unassigned, never the nearest name.
  return {
    ok: true,
    sync: doc.sync === true,
    theme: normalizeThemeName(doc.theme),
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : null,
  };
}

// Atomic and mode-preserving, so a crash mid-write cannot leave a half document
// for the panel to read (same pattern as `writeSettingsDoc` in
// extensions/gentle-herdr-state.ts:2417). The temp file is created next to the
// resolved target, which also keeps a symlinked target's link intact.
function writeThemeState(env, input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('writeThemeState expects an object with `sync` and `theme`');
  }
  if (typeof input.sync !== 'boolean') {
    throw new TypeError('writeThemeState expects `sync` to be a boolean');
  }
  if (input.theme !== null && input.theme !== undefined && typeof input.theme !== 'string') {
    throw new TypeError('writeThemeState expects `theme` to be a string or null');
  }
  const doc = {
    sync: input.sync,
    theme: normalizeThemeName(input.theme),
    // Stamped here: the document always records when the switch was last
    // changed, and a caller can never write a timestamp it made up.
    updatedAt: new Date().toISOString(),
  };
  const file = themeStatePath(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // Missing or dangling: write where the path points.
  }
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // Fresh file.
  }
  const temp = path.join(path.dirname(target), `.${THEME_FILE_NAME}.gentle-${randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort: a failure here is non-fatal */
    }
    throw error;
  }
  return { path: file };
}

module.exports = { themeStateDir, themeStatePath, readThemeState, writeThemeState };
