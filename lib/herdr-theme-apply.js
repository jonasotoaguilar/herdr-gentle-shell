#!/usr/bin/env node
'use strict';

// The in-process Herdr theme writer (theme-sync-fix T2 over S3/S4, correction
// pass; risk 1 — it replaces a file the user owns).
//
// Why this exists at all: the shipped 1.8.0 writer ran from the separately
// installed Herdr plugin, so a Pi-only update left it behind (evidence E2), and
// it refused any `[theme]` table outside its own markers, which the user's real
// config owns (E1). Everything here happens inside the Pi package.
//
// Ported from gentle-herdr `lib/herdr-visuals-application.ts`
// (https://github.com/MarsSall/gentle-herdr, MIT License, Copyright (c) MarsSall):
// the availability guard matrix, the bounded snapshot, the compare-and-swap
// replacement and the reload invocation are that file's logic in plain
// CommonJS, so the two implementations fail in the same places.
//
// What the guards mean, in a user's terms:
// - `not-herdr`/`unsupported`: there is no local Linux Herdr whose config this
//   process may edit (a `herdr-dev` binary or a non-Linux host is not the
//   Herdr the user is looking at);
// - `child`: a subagent's Pi must never write the user's config, because its
//   "active theme" is not the palette the user sees;
// - `remote`: in an SSH session Herdr's client reads another machine's config,
//   so writing the server-side file would change nothing on screen.
//
// A write is bounded and staged: the path must be a regular, single-link file of
// at most 256 KiB in a non-symlinked directory, the bytes are decoded strictly
// and the BOM is preserved, the planned document is refused if it would grow
// past the same limit, and the new bytes are written to an exclusive 0o600 file
// in the same directory, chmod'ed to the original mode (all permission bits),
// fsynced and renamed. The original bytes are kept once in
// `<config>.herdr-gentle-shell.bak`, published atomically and never overwritten.
//
// LIMITS, stated rather than hidden and deliberately not coded in this pass: an
// edit that lands between the final compare and the rename cannot be detected
// without holding a lock on the config, which this writer deliberately does not
// do; and a projected palette is checked for shape only (#rrggbb, known token),
// never for Herdr's own semantics. The compare is therefore as close to the
// rename as it can be, and everything earlier is still detected.
//
// `unchanged` performs no write and NO reload (Herdr already holds that palette,
// and a reload on every theme tick would make the sidebar flicker). `forceReload`
// exists for the one case that needs it: repairing a config whose previous
// reload failed.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { planThemeConfig } = require('./herdr-theme-config.js');

const MAX_BYTES = 256 * 1024;
const RELOAD_TIMEOUT_MS = 5000;
const RELOAD_MAX_BUFFER = 4096;
const BACKUP_SUFFIX = '.herdr-gentle-shell.bak';
const CHANGED_BEFORE_REPLACEMENT = 'Herdr config changed before replacement';

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------- resolution */

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

// Herdr sets all three of these in every pane it owns. Requiring them is what
// keeps a plain Pi session (which happens to run on a machine with Herdr
// installed) from writing a config nobody is looking at.
function herdrDetected(env) {
  return env.HERDR_ENV === '1' && nonEmpty(env.HERDR_PANE_ID) && nonEmpty(env.HERDR_SOCKET_PATH);
}

// `HERDR_CONFIG_PATH`, then XDG, then the default under `~/.config`. `null` when
// nothing is resolvable, which the guard reports as `unsupported`.
function herdrConfigPath(env = process.env) {
  if (nonEmpty(env.HERDR_CONFIG_PATH)) return env.HERDR_CONFIG_PATH;
  const root = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : nonEmpty(env.HOME) ? path.join(env.HOME, '.config') : null;
  return root === null ? null : path.join(root, 'herdr', 'config.toml');
}

// The single guard behind both the exported availability answer and the apply
// path, so the two can never disagree about who may write.
function herdrTarget(env, platform) {
  if (!herdrDetected(env)) return { available: false, reason: 'not-herdr' };
  if (env.GENTLE_PI_AGENTS_CHILD === '1') return { available: false, reason: 'child' };
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return { available: false, reason: 'remote' };
  const binary = nonEmpty(env.HERDR_BIN_PATH) ? env.HERDR_BIN_PATH : 'herdr';
  // A build-tree binary belongs to whoever is developing Herdr; its config is
  // not the installed one the user's session reads.
  if (/^herdr-dev(?:\.exe)?$/i.test(path.basename(binary))) return { available: false, reason: 'unsupported' };
  if (platform !== 'linux') return { available: false, reason: 'unsupported' };
  if (!path.isAbsolute(env.HERDR_SOCKET_PATH)) return { available: false, reason: 'unsupported' };
  const configPath = herdrConfigPath(env);
  if (!configPath || !path.isAbsolute(configPath) || path.resolve(configPath) !== configPath) {
    return { available: false, reason: 'unsupported' };
  }
  return { available: true, binary, configPath };
}

// Pure eligibility: not a filesystem health check and not a build attestation.
function herdrThemeAvailability(env = process.env, platform = process.platform) {
  const target = herdrTarget(env, platform);
  return target.available ? { available: true } : { available: false, reason: target.reason };
}

/* --------------------------------------------------------------- snapshot */

function sameStat(before, after) {
  return (
    before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.mode === after.mode
  );
}

// A bounded, strictly decoded read. Every rejection names the invariant it
// protects: a symlinked, linked, directory or oversized path is not a config
// this process may replace, and reading through one could write somewhere else.
function snapshot(file) {
  const directory = path.dirname(file);
  if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(directory) !== directory) {
    throw new Error('Unsupported or symlinked Herdr config path');
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) {
    throw new Error('Herdr config must be a bounded regular single-link file');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!sameStat(before, opened)) throw new Error('Herdr config changed during read');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    let count = 0;
    do {
      count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      size += count;
    } while (count > 0 && size < buffer.length);
    if (size > MAX_BYTES || size !== opened.size || !sameStat(opened, fs.fstatSync(fd))) {
      throw new Error('Herdr config changed or exceeded the read limit');
    }
    return { bytes: buffer.subarray(0, size), stat: opened };
  } finally {
    fs.closeSync(fd);
  }
}

function unchangedSince(file, original) {
  const fresh = snapshot(file);
  if (!sameStat(original.stat, fresh.stat) || !original.bytes.equals(fresh.bytes)) {
    throw new Error(CHANGED_BEFORE_REPLACEMENT);
  }
}

/* ------------------------------------------------------------------ write */

function writeAll(fd, bytes) {
  fs.writeFileSync(fd, bytes);
  fs.fsyncSync(fd);
}

// The backup is published atomically and never overwritten. Writing it straight
// at its final name is what made a failed write (ENOSPC, a killed process) leave
// a truncated `.bak` that every later run then treated as "already backed up",
// so the true original was lost. Staging + link gives atomicity AND "fail if it
// already exists", and a path that is not a regular file is refused rather than
// followed.
function ensureBackup(file, bytes) {
  const backup = `${file}${BACKUP_SUFFIX}`;
  let existing = null;
  try {
    existing = fs.lstatSync(backup);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Herdr backup path is not a regular file: ${backup}`);
    }
    return backup;
  }
  const temporary = `${backup}.${randomUUID()}.tmp`;
  let published = false;
  // Only a path THIS call created may ever be removed. An exclusive open that
  // fails with EEXIST means the name belongs to someone else (another writer,
  // or a left-over file), and deleting it would destroy a file we do not own.
  let created = false;
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    created = true;
    try {
      writeAll(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, backup);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      // DECISION: a regular file that already sits at the backup path — whether
      // it was there when we checked or appeared in this race — IS the existing
      // backup and is accepted as it is. It may legitimately be an older original
      // from before the user edited the config, and a raced copy is
      // indistinguishable from it, so we neither compare it nor overwrite it.
      // (A pre-existing truncated backup is therefore a documented limit: it is
      // kept, not repaired.) Only something that is not a real file — a
      // directory, a symlink, a socket — is refused, because writing next to it
      // could mean writing somewhere else.
      const raced = fs.lstatSync(backup);
      if (!raced.isFile() || raced.isSymbolicLink()) {
        throw new Error(`Herdr backup path is not a regular file: ${backup}`);
      }
    }
    published = true;
  } finally {
    // A leftover temp is a stray file in the user's config directory: remove it,
    // and never report `requested` while one survives.
    const leftover = created ? discard(temporary) : null;
    if (leftover !== null && published) {
      throw new Error(`Herdr backup temporary could not be removed: ${leftover}`);
    }
  }
  return backup;
}

// Removing a temporary file this call created. A single transient failure must
// not leave a stray file beside the user's config, so retry once and then force-
// remove; if even that fails the caller must report the path instead of claiming
// success. Returns the leftover path, or null when the path is gone.
function discard(path) {
  if (path === null) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.unlinkSync(path);
      return null;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
    }
  }
  try {
    fs.rmSync(path, { force: true });
    return null;
  } catch {
    return path;
  }
}

// Exclusive 0o600 staging at a path the CALLER already knows, then the original
// mode (all permission bits, including setuid/setgid/sticky), so the rename never
// widens or narrows the file's permissions even for a moment. The path is chosen
// before the file exists so that every failure — open, write, fsync, chmod —
// leaves the caller able to unlink it.
function writeStaged(temporary, bytes, mode, state) {
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  // Only a file this call created may ever be removed by its caller.
  state.created = true;
  try {
    writeAll(fd, bytes);
    fs.fchmodSync(fd, mode & 0o7777);
  } finally {
    fs.closeSync(fd);
  }
}

// No shell: the binary is exec'd with this exact argv, and the bounded output
// keeps a chatty server from buffering without limit.
function reload(binary, env) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      binary,
      ['server', 'reload-config'],
      { env, timeout: RELOAD_TIMEOUT_MS, maxBuffer: RELOAD_MAX_BUFFER },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

// `ignoreBOM` keeps the leading U+FEFF in the decoded text. Without it a changed
// write silently drops the user's byte-order mark while the backup still has it,
// so the backup and the file would disagree about the first three bytes.
function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/* ------------------------------------------------------------------ apply */

// One entry point. The guard is evaluated here, before any file is opened, and a
// refusal returns the reason instead of guessing a target.
async function applyHerdrTheme({ projection, env = process.env, platform = process.platform, forceReload = false } = {}) {
  const target = herdrTarget(env, platform);
  if (!target.available) return { status: 'unavailable', reason: target.reason };

  let temporary = null;
  const staged = { created: false };
  try {
    const original = snapshot(target.configPath);
    const plan = planThemeConfig(decodeUtf8(original.bytes), projection);
    if (plan.ok === false) return { status: 'partial', stage: 'config', error: plan.error };
    if (plan.changed) {
      const bytes = Buffer.from(plan.text, 'utf8');
      // The read limit is also the write limit: a file we could read but not
      // write back would make the next run refuse its own output.
      if (bytes.length > MAX_BYTES) {
        return {
          status: 'partial',
          stage: 'config',
          error: `Herdr config would grow to ${bytes.length} bytes, past the ${MAX_BYTES}-byte limit; no changes proposed.`,
        };
      }
      // Compare before the backup so the backup is never taken from bytes that
      // are already gone.
      unchangedSince(target.configPath, original);
      ensureBackup(target.configPath, original.bytes);
      // The path exists before the bytes do: a failure inside staging must leave
      // this function able to remove it.
      temporary = `${target.configPath}.${randomUUID()}.tmp`;
      writeStaged(temporary, bytes, original.stat.mode, staged);
      // The final compare sits immediately before the rename: an edit that
      // landed while the new bytes were staged is still caught here, and one
      // that lands after this point is the inherent limit of rename-based
      // writes (see the module header).
      unchangedSince(target.configPath, original);
      fs.renameSync(temporary, target.configPath);
      temporary = null;
    } else if (!forceReload) {
      // Nothing to write means nothing to reload: Herdr already shows this palette.
      return { status: 'unchanged' };
    }
  } catch (error) {
    // A staged temp file must never survive a failed replace: it would sit
    // beside the user's config forever. The original is never touched here.
    const leftover = temporary !== null && staged.created ? discard(temporary) : null;
    return {
      status: 'partial',
      stage: 'config',
      error: leftover === null ? message(error) : `${message(error)}; temporary file left behind: ${leftover}`,
    };
  }

  try {
    await reload(target.binary, env);
  } catch (error) {
    // The config is committed and Herdr's client state is unknown; retrying a
    // reload here would race the next tick, so the caller sees partial state.
    return { status: 'partial', stage: 'reload', error: message(error) };
  }
  return { status: 'requested' };
}

module.exports = {
  applyHerdrTheme,
  herdrThemeAvailability,
  herdrConfigPath,
};
