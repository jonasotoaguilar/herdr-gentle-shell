#!/usr/bin/env node
'use strict';

// The read-only window this package has on Pi's settings file.
//
// One host setting is observable here: `tuiMode`, which says whether a traced
// run drove the fullscreen or the regular TUI, and therefore whether two runs
// may be compared at all. The trace records it and never writes it — there is
// no write path in this module, so a measurement can never edit host
// configuration.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST_TUI_MODES = Object.freeze(['fullscreen', 'regular']);

// Same agent-dir resolution as lib/gentle-sidebar.js, so every part of this
// package means the same file.
function agentDir(env = process.env) {
  const selected = env.GENTLE_PI_AGENT_HOME ?? env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  if (selected === '~') return os.homedir();
  if (selected.startsWith('~/')) return path.join(os.homedir(), selected.slice(2));
  return selected;
}

function settingsPath(env = process.env) {
  return path.join(agentDir(env), 'settings.json');
}

// Pi strips a single leading BOM before parsing; do the same.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// A missing file is an empty document. A file that cannot be read or parsed is
// a refusal: the caller records "not read" rather than a guess.
function loadDocument(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, doc: {} };
    return { ok: false, error: `cannot read ${file}: ${err.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(stripBom(raw));
  } catch (err) {
    return { ok: false, error: `cannot parse ${file}: ${err.message}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: `cannot parse ${file}: top-level JSON must be an object` };
  }
  return { ok: true, doc };
}

// The host tui mode as it takes effect, or an empty set: a mode outside the two
// the trace understands is not a value.
function readHostValues(env = process.env) {
  const file = settingsPath(env);
  const loaded = loadDocument(file);
  if (!loaded.ok) return { ok: false, path: file, values: {} };
  const values = {};
  const mode = loaded.doc.tuiMode;
  if (typeof mode === 'string' && HOST_TUI_MODES.includes(mode)) values.tuiMode = mode;
  return { ok: true, path: file, values };
}

module.exports = { readHostValues };
