#!/usr/bin/env node
'use strict';

// Atomic, fail-closed merge writer for pi's performance switches.
//
// The customize panel's performance rows write through here instead of
// touching the file themselves: one entry point takes a set of key/value
// pairs and merges them into <agent-dir>/settings.json.
//
// Invariants, all of them observable:
// - only the four known boolean keys are accepted, so a renamed or mistyped
//   key fails loudly instead of writing a setting pi never reads;
// - every other key, value and nested object in the file is preserved;
// - a file that cannot be read, parsed as an object, or stat'd is NEVER
//   overwritten — the caller gets {ok:false, error} and the bytes stay put;
// - a write that would change nothing reports changed:false and does not
//   rewrite the file;
// - the write is atomic (unique O_EXCL temp file in the target directory,
//   previous mode preserved, fresh files 0600, then rename), the symlink
//   itself is preserved, and no temp file survives success or failure.
//
// Both functions return a verdict object and never throw, because every
// caller is a panel row that owes the user an honest "nothing was changed".

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The single authority for what this writer may touch. Row metadata in
// lib/customize-perf-rows.js maps its rows onto these names.
const PERF_KEYS = Object.freeze([
  'heightIndex',
  'evictOffscreenLines',
  'expandRecentToolOutput',
  'incrementalSearchCorpus',
]);

const CREATE_MODE = 0o600;
const TEMP_ATTEMPTS = 10;

// Same agent-dir resolution as lib/gentle-sidebar.js, so the panel and the
// rest of the package can never disagree about which file they mean.
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

function loadDocument(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, raw: null, doc: {} };
    return { ok: false, error: `cannot read ${file}: ${err.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(stripBom(raw));
  } catch (err) {
    return { ok: false, error: `refusing to edit ${file}: invalid JSON (${err.message}); fix or remove the file first` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: `refusing to edit ${file}: top-level JSON must be an object` };
  }
  return { ok: true, raw, doc };
}

// 'missing' | 'file' | 'symlink'. A dangling symlink, a directory or a
// special file is a refusal, never a target to replace.
function classify(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, kind: 'missing' };
    return { ok: false, error: `cannot stat ${file}: ${err.message}` };
  }
  if (st.isSymbolicLink()) {
    try {
      fs.statSync(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: false, error: `refusing to edit ${file}: dangling symlink` };
      return { ok: false, error: `cannot stat ${file}: ${err.message}` };
    }
    return { ok: true, kind: 'symlink' };
  }
  if (st.isFile()) return { ok: true, kind: 'file' };
  return { ok: false, error: `refusing to edit ${file}: not a regular file` };
}

// Exact-bytes atomic replace: unique temp file created O_CREAT|O_EXCL (never
// truncating a foreign file), mode applied regardless of umask, then rename.
function writeAtomic(target, text, mode) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let lastError = null;
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
    const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`);
    let fd = null;
    try {
      fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        lastError = err;
        continue;
      }
      throw err;
    }
    try {
      const buf = Buffer.from(text, 'utf8');
      let offset = 0;
      while (offset < buf.length) offset += fs.writeSync(fd, buf, offset);
      fs.chmodSync(tmp, mode);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, target);
    } catch (err) {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        // Best-effort descriptor cleanup.
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Best-effort temp cleanup.
      }
      throw err;
    }
    return;
  }
  throw lastError || new Error('could not create a unique temporary file');
}

function validatedPairs(pairs) {
  if (typeof pairs !== 'object' || pairs === null || Array.isArray(pairs)) {
    return { ok: false, error: 'performance settings must be given as an object of key/value pairs' };
  }
  const entries = Object.entries(pairs);
  if (entries.length === 0) return { ok: false, error: 'at least one performance setting pair is required' };
  for (const [key, value] of entries) {
    if (!PERF_KEYS.includes(key)) {
      return { ok: false, error: `unknown performance setting ${key}; known keys: ${PERF_KEYS.join(', ')}` };
    }
    if (typeof value !== 'boolean') {
      return { ok: false, error: `${key} must be a boolean, got ${value === null ? 'null' : typeof value}` };
    }
  }
  return { ok: true, entries };
}

function readValues(keys, env = process.env) {
  const file = settingsPath(env);
  const wanted = Array.isArray(keys) && keys.length > 0 ? keys : PERF_KEYS;
  for (const key of wanted) {
    if (!PERF_KEYS.includes(key)) {
      return { ok: false, path: file, error: `unknown performance setting ${key}` };
    }
  }
  const loaded = loadDocument(file);
  if (!loaded.ok) return { ok: false, path: file, error: loaded.error };
  const values = {};
  for (const key of wanted) {
    values[key] = typeof loaded.doc[key] === 'boolean' ? loaded.doc[key] : undefined;
  }
  return { ok: true, path: file, values };
}

function writeSettings(pairs, env = process.env) {
  const file = settingsPath(env);
  const validated = validatedPairs(pairs);
  if (!validated.ok) return { ok: false, changed: false, path: file, error: validated.error };
  const loaded = loadDocument(file);
  if (!loaded.ok) return { ok: false, changed: false, path: file, error: loaded.error };
  const written = {};
  for (const [key, value] of validated.entries) {
    if (loaded.doc[key] !== value) written[key] = value;
  }
  if (Object.keys(written).length === 0) {
    return { ok: true, changed: false, path: file, written: {} };
  }
  const kind = classify(file);
  if (!kind.ok) return { ok: false, changed: false, path: file, error: kind.error };
  let target;
  let mode = CREATE_MODE;
  try {
    if (kind.kind === 'missing') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      target = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    } else {
      target = fs.realpathSync(file);
      mode = fs.statSync(file).mode & 0o777;
    }
  } catch (err) {
    return { ok: false, changed: false, path: file, error: `cannot resolve ${file}: ${err.message}` };
  }
  const next = `${JSON.stringify({ ...loaded.doc, ...written }, null, 2)}\n`;
  try {
    writeAtomic(target, next, mode);
  } catch (err) {
    return { ok: false, changed: false, path: file, error: `cannot write ${file}: ${err.message}` };
  }
  return { ok: true, changed: true, path: file, written };
}

module.exports = { PERF_KEYS, agentDir, settingsPath, readValues, writeSettings };
