'use strict';

// Managed `[theme]` projection owner for herdr-gentle-theme (theme-sync T2).
//
// Herdr keeps the last palette it was given, so the Pi side only has to pipe
// the projected palette in; this module owns the Herdr side and nothing else:
//
// - A SECOND managed block, marked and owned here. It is deliberately distinct
//   from the sidebar block owned by bin/configure.js: two writers must never
//   share marker bytes, or each would treat the other's block as its own and
//   the last writer would erase the first.
// - Validation of the projected palette before anything reaches disk: an
//   unknown theme name, an unknown custom token or a non-#rrggbb value would
//   otherwise land in the user's config.toml as an invalid Herdr palette.
// - The same atomic write, `.bak` backup and reload primitives as the sidebar
//   writer, required from bin/configure.js rather than copied, so both blocks
//   fail, back up and reload identically.
//
// Ownership contract (mirrors the sidebar block's philosophy):
// - A `[theme]` or `[theme.custom]` table outside our markers is user config.
//   Refuse; never adopt, merge or overwrite it.
// - Unterminated or duplicated markers are malformed: refuse instead of
//   guessing where our block ends.
// - Nothing else in the file is read or written.

const configure = require('../bin/configure');

const THEME_BEGIN = '# BEGIN herdr-gentle-theme (managed; do not edit)';
const THEME_END = '# END herdr-gentle-theme';

// Herdr theme names this writer accepts. Anything else is a caller bug, not a
// future-compatible extension point: Herdr would reject it or fall back
// silently, and the user would see a palette that is not the one they chose.
const THEMES = [
  'catppuccin',
  'terminal',
  'tokyo-night',
  'dracula',
  'nord',
  'gruvbox',
  'one-dark',
  'solarized',
  'kanagawa',
  'rose-pine',
  'vesper',
];

// The only Herdr tokens the projection may override, in the order they are
// emitted. The order is fixed here and never taken from the payload: a stable
// order is what makes two applies of the same palette byte-identical.
const CUSTOM_TOKENS = [
  'sidebar_bg',
  'panel_bg',
  'active_row_bg',
  'selection_bg',
  'accent',
  'text',
  'red',
  'green',
  'subtext0',
  'overlay0',
  'overlay1',
  'mauve',
  'yellow',
  'peach',
  'blue',
  'teal',
  'surface0',
  'surface1',
  'surface_dim',
];

const THEME_SET = new Set(THEMES);
const TOKEN_SET = new Set(CUSTOM_TOKENS);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BACKUP_SUFFIX = '.herdr-gentle-theme.bak';

// One table-header line, with its key path captured. A bare `theme = ...` key
// never matches: the line has to start with `[`, and inside another table such a
// key is a different key path and legitimately user config.
const TABLE_HEADER_RE = /^\s*\[\[?\s*([^[\]\n]+?)\s*\]\]?(?:\s*#.*)?$/;

// TOML spells the same table path with a bare or a quoted key — `[theme]`,
// `["theme"]`, `['theme']`, `['theme.custom']` — and Herdr reads them as one
// table. Comparing the header with every quote stripped puts all spellings on
// the same test: a quoted table must be refused like the bare one, or this
// writer would append a second `[theme]` table below it and leave behind a
// config Herdr can no longer parse.
function isThemeTableHeader(line) {
  const header = TABLE_HEADER_RE.exec(line);
  if (!header) return false;
  return /^theme(\s*\.|$)/.test(header[1].replace(/["']/g, '').trim());
}

class RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefusalError';
  }
}

function reject(detail) {
  throw new RefusalError(`refusing malformed payload: ${detail}`);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'non-object';
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Validate the piped payload and normalise it into `{name, custom}` where
// `custom` is an ordered `[token, value]` list and hex is lower-cased, so the
// same palette always renders the same bytes.
function validatePayload(body) {
  if (!isPlainObject(body)) reject(`expected a JSON object, got ${describe(body)}`);
  for (const key of Object.keys(body)) {
    if (key !== 'theme') reject(`extra top-level key "${key}"`);
  }
  if (!Object.hasOwn(body, 'theme')) reject('missing theme object');
  const theme = body.theme;
  if (!isPlainObject(theme)) reject('theme must be an object');
  for (const key of Object.keys(theme)) {
    if (key !== 'name' && key !== 'custom') reject(`unknown theme key "${key}"`);
  }
  if (typeof theme.name !== 'string') reject('theme.name must be a string');
  if (!THEME_SET.has(theme.name)) {
    reject(`unknown theme "${theme.name}"; expected one of ${THEMES.join(', ')}`);
  }
  const rawCustom = theme.custom === undefined ? {} : theme.custom;
  if (!isPlainObject(rawCustom)) reject('theme.custom must be an object');
  for (const key of Object.keys(rawCustom)) {
    if (!TOKEN_SET.has(key)) reject(`unknown custom token "${key}"`);
  }
  const custom = [];
  for (const token of CUSTOM_TOKENS) {
    if (!Object.hasOwn(rawCustom, token)) continue;
    const value = rawCustom[token];
    if (typeof value !== 'string' || !HEX_RE.test(value)) {
      reject(`theme.custom.${token} must be #rrggbb, got ${JSON.stringify(value)}`);
    }
    custom.push([token, value.toLowerCase()]);
  }
  return { name: theme.name, custom };
}

// Parse a stdin payload. An empty stdin is "no payload", which --apply refuses
// and --check treats as "check the block on its own".
function parsePayload(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    reject('stdin is not valid JSON');
  }
  return validatePayload(body);
}

// The exact bytes of the managed block, without the trailing newline the file
// adds on write. `[theme.custom]` exists only when there is something to
// override, so an empty palette never emits an empty table.
function renderBlock(parsed) {
  const lines = [THEME_BEGIN, '[theme]', `name = "${parsed.name}"`];
  if (parsed.custom.length > 0) {
    lines.push('', '[theme.custom]');
    for (const [token, value] of parsed.custom) lines.push(`${token} = "${value}"`);
  }
  lines.push(THEME_END);
  return lines.join('\n');
}

// Read our own block back into a validated payload, or null when the body is
// not exactly what this writer emits. Used by --check without a payload: a
// body that cannot round-trip through renderBlock is stale, not current.
function parseBlock(block) {
  const lines = block.split('\n');
  if (lines[0] !== THEME_BEGIN) return null;
  if (lines[lines.length - 1] !== THEME_END) return null;
  const body = lines.slice(1, -1);
  if (body[0] !== '[theme]') return null;
  const nameLine = (body[1] ?? '').match(/^name = "([^"]*)"$/);
  if (!nameLine) return null;
  const custom = {};
  const rest = body.slice(2);
  if (rest.length > 0) {
    if (rest[0] !== '' || rest[1] !== '[theme.custom]') return null;
    for (const line of rest.slice(2)) {
      const pair = line.match(/^([a-z0-9_]+) = "(#[0-9a-f]{6})"$/);
      if (!pair) return null;
      custom[pair[1]] = pair[2];
    }
  }
  try {
    return validatePayload({ theme: { name: nameLine[1], custom } });
  } catch {
    return null;
  }
}

// Locate our single block. Anything that is not exactly one well-formed pair —
// a lone begin, a lone end, end before begin, or a second pair — is malformed
// rather than absent: treating it as absent would append a second copy of the
// same tables and leave the file invalid TOML.
function locateBlock(text) {
  const begin = text.indexOf(THEME_BEGIN);
  const end = text.indexOf(THEME_END);
  if (begin < 0 && end < 0) return { present: false };
  if (begin < 0 || end < 0 || end < begin) return { malformed: true };
  if (text.indexOf(THEME_BEGIN, begin + THEME_BEGIN.length) >= 0) return { malformed: true };
  if (text.indexOf(THEME_END, end + THEME_END.length) >= 0) return { malformed: true };
  return { present: true, block: text.slice(begin, end + THEME_END.length) };
}

function hasForeignThemeTable(text) {
  const body = configure.removeBlock(text, THEME_BEGIN, THEME_END);
  return body.split('\n').some(isThemeTableHeader);
}

function opFlag(op) {
  return `--${op}`;
}

function refuseForeign(op) {
  throw new RefusalError(
    `refusing ${opFlag(op)}: a [theme] or [theme.custom] table already exists outside the managed markers. ` +
      'This tool only manages its marked block; move or delete that table, then re-run.',
  );
}

function refuseMalformed(op) {
  throw new RefusalError(
    `refusing ${opFlag(op)}: managed theme markers are malformed (unterminated); fix them manually.`,
  );
}

function refuseNoPayload() {
  throw new RefusalError(
    'no theme payload on stdin; expected JSON {"theme":{"name":"<herdr-theme>","custom":{"<token>":"#rrggbb"}}}',
  );
}

function writeManaged(file, next) {
  try {
    // Same atomic write and `.bak` backup as the sidebar block, with this
    // block's own backup file so one writer never overwrites the other's
    // recovery copy.
    configure.writeAtomic(file, next, `${file}${BACKUP_SUFFIX}`);
  } catch (error) {
    throw new RefusalError(`write failed, original untouched: ${error.message}`);
  }
}

// One operation on the real config file. Returns a result the CLI renders;
// every refusal throws RefusalError before the write, so a refusal can never
// leave partial bytes behind.
function run(op, payloadText) {
  const file = configure.herdrConfigPath();
  let text;
  try {
    text = configure.readConfig(file);
  } catch (error) {
    throw new RefusalError(`cannot read ${file}: ${error.message}`);
  }
  const hasPayload = typeof payloadText === 'string' && payloadText.trim() !== '';
  const located = text === null ? { present: false } : locateBlock(text);
  if (located.malformed) refuseMalformed(op);

  if (op === 'remove') {
    // Absent is inert (exit 0, no write) even when a foreign table exists:
    // there is nothing of ours to take away, and uninstall must not touch
    // user config.
    if (!located.present) return { op, status: 'absent', file, theme: null, changed: false };
    writeManaged(file, configure.removeBlock(text, THEME_BEGIN, THEME_END));
    return { op, status: 'removed', file, theme: null, changed: true };
  }

  if (text !== null && hasForeignThemeTable(text)) refuseForeign(op);

  if (op === 'check') {
    if (text === null) return { op, status: 'absent', file, theme: null, changed: false };
    if (!located.present) return { op, status: 'absent', file, theme: null, changed: false };
    const expected = hasPayload ? parsePayload(payloadText) : parseBlock(located.block);
    if (expected === null) return { op, status: 'stale', file, theme: null, changed: false };
    if (located.block !== renderBlock(expected)) {
      return { op, status: 'stale', file, theme: expected.name, changed: false };
    }
    return { op, status: 'current', file, theme: expected.name, changed: false };
  }

  // apply
  if (!hasPayload) refuseNoPayload();
  const parsed = parsePayload(payloadText);
  const block = renderBlock(parsed);
  if (located.present && located.block === block) {
    return { op, status: 'current', file, theme: parsed.name, changed: false };
  }
  const base = located.present ? configure.removeBlock(text, THEME_BEGIN, THEME_END) : text;
  writeManaged(file, configure.appendBlock(base, `${block}\n`));
  return { op, status: 'applied', file, theme: parsed.name, changed: true };
}

// Reload through the sidebar writer's own reloadConfig (same spawn, argv,
// 15 s timeout and failure handling). Its success note is suppressed because
// this CLI already prints exactly one result line; its failure note stays on
// stderr, where the caller must see it.
function reloadThemeConfig() {
  return configure.reloadConfig(
    () => {},
    (message) => process.stderr.write(`${message}\n`),
  );
}

module.exports = {
  THEMES,
  CUSTOM_TOKENS,
  THEME_BEGIN,
  THEME_END,
  BACKUP_SUFFIX,
  RefusalError,
  themeConfigPath: configure.herdrConfigPath,
  validatePayload,
  parsePayload,
  renderBlock,
  locateBlock,
  run,
  reloadThemeConfig,
};
