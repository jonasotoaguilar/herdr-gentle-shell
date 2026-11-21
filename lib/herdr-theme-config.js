#!/usr/bin/env node
'use strict';

// The in-process owner of Herdr's `[theme]` table (theme-sync-fix T2 over S3/S4,
// third correction pass).
//
// WHY THIS SHAPE. Three verifiers in a row broke a planner that tried to VALIDATE
// the whole document with a hand-written TOML grammar: every pass fixed one
// corner and the next one found another. The scope was wrong. This planner is a
// LINE SPLICER, not a validator:
//
//   OPAQUE OUTSIDE THE THEME TABLES. It finds table boundaries (headers are only
//   headers at a real line start — never inside a multi-line string, a multi-line
//   array, an inline table or a comment) and then treats every other line as
//   opaque bytes. An input that is already invalid TOML outside `[theme]` and
//   `[theme.custom]` is the user's pre-existing breakage: Herdr refuses to load
//   it, and this module's only promise is that it does not touch those lines.
//
//   STRICT INSIDE THE THEME TABLES. Where it writes, it accepts only comments,
//   blank lines and `key = value [comment]` with a single-line string, boolean,
//   integer or float, and it refuses anything else for a key it must touch. A key
//   it does not touch is left byte for byte whenever the scanner can tell where
//   that line ends (so an untargeted `yellow = """reset"""` keeps working).
//
//   SPLICING INVARIANT, ENFORCED. Before `ok: true` the planner re-derives the
//   non-theme lines of its own output and compares them with the input's; a
//   mismatch is an internal error, never a silent edit. The only lines it may
//   remove from the opaque region are the 1.8.0 markers this package wrote.
//
// WHAT IS GUARANTEED: table boundaries are correct for documents whose
// multi-line strings, arrays and inline tables are terminated; the theme tables
// only ever contain the strict line forms above; every byte outside the theme
// tables is preserved (modulo one added line terminator when a table or block is
// placed after an unterminated last line, and that addition is recorded on the
// managed block's end line so a later clear takes it back); a `was` marker
// records the whole original line and a restore gives back its key/value plus the
// user's CURRENT trailing comment when they edited it; CRLF/mixed EOL, a BOM and
// a missing final newline survive; planning is idempotent and reversible.
//
// WHAT IS NOT GUARANTEED, deliberately: this is NOT a TOML validator. It does not
// check values, dates, numbers or keys outside the theme tables, does not detect
// duplicate keys or tables anywhere else, does not validate a projected palette
// beyond its shape (#rrggbb, known token), and does not lock the config. Deleting
// those checks is the point of this pass: they caused false refusals of valid
// files, and they were never able to make an invalid file valid. Outside the
// theme tables an escape only consumes the character after it, so an illegal
// escape there is not a refusal (whether it is legal TOML is a parser's job).
//
// TWO KNOWN LIMITS. A comment that would parse as a `was` marker for the key
// below a managed block is AMBIGUOUS once that block is removed or moved (the
// next plan would promote the user's ordinary comment to ownership), so such a
// plan refuses instead of guessing. And a `[theme]` name line this planner
// inserted is never removed again: a projection always carries a theme name, so
// there is no "empty projection" that could ask for it.
//
// Pure on purpose: it takes text and a projection and returns text. The writer
// (lib/herdr-theme-apply.js) owns every file descriptor, backup and reload.

const { HERDR_BASE_THEMES, HERDR_TOKEN_ORDER, isConcreteHex } = require('./theme-projection.js');

const WAS_PREFIX = '# herdr-gentle-shell: was ';
const BLOCK_BEGIN = '# herdr-gentle-shell: begin';
const BLOCK_BEGIN_CREATED = '# herdr-gentle-shell: begin created';
// The block's end, when placing the block also added the file's missing final
// line ending to the line above it. A later clear must take that ending back,
// and the text alone cannot tell who added it, so the fact is recorded here.
const BLOCK_END_ADDED = '# herdr-gentle-shell: end after a missing line ending';
const BLOCK_END = '# herdr-gentle-shell: end';

// The 1.8.0 managed block. Its body is ordinary `[theme]` config now, so only a
// nearest-paired marker pair that encloses a theme table is dropped; every other
// marker line is the user's text and is preserved.
const LEGACY_BEGIN = '# BEGIN herdr-gentle-theme (managed; do not edit)';
const LEGACY_END = '# END herdr-gentle-theme';

// Raw control characters make the line scan unsafe and are invalid TOML
// anywhere, including inside a comment. Tab and newline are the exceptions, and
// U+2028/U+2029/U+0085 are ordinary characters in a comment.
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const BARE_CARRIAGE_RETURN = /\r(?!\n)/;
const BOM = '\uFEFF';

// A line we record as an original cannot carry a character that breaks "one
// line" for a reader. Only C0 controls (tab excepted) and DEL do that: U+0085,
// U+2028 and U+2029 are legal characters in a TOML comment and are ordinary
// text, not line separators, so they must survive a record/restore untouched.
const UNRECORDABLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// The ONLY value forms accepted inside `[theme]`/`[theme.custom]` (design point
// 3). Outside those tables nothing is validated.
const STRICT_NUMBER = new RegExp(
  '^(?:'
  + '[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?'
  + '|[+-]?(?:inf|nan)'
  + '|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*'
  + '|0o[0-7](?:_?[0-7])*'
  + '|0b[01](?:_?[01])*'
  + ')$',
);

const BASIC_ESCAPES = new Set(['b', 't', 'n', 'f', 'r', '"', '\\']);

const THEME_KEYS_REFUSED = new Set(['dark_name', 'light_name']);
const THEME_OWNED_KEYS = new Set(['name', 'custom', 'auto_switch', 'dark_name', 'light_name']);

function fail(line, reason) {
  return `line ${line}: ${reason}; no changes proposed.`;
}

/* ------------------------------------------------------------- projection */

function invalidProjection(projection) {
  if (typeof projection !== 'object' || projection === null || Array.isArray(projection)) {
    return 'Invalid Herdr theme projection: expected an object; no changes proposed.';
  }
  for (const key of Object.keys(projection)) {
    if (key !== 'name' && key !== 'custom') {
      return `Invalid Herdr theme projection: unknown key \`${key}\`; no changes proposed.`;
    }
  }
  if (typeof projection.name !== 'string' || !HERDR_BASE_THEMES.includes(projection.name)) {
    return `Invalid Herdr theme projection: theme name ${JSON.stringify(projection.name)} is not a Herdr native theme; no changes proposed.`;
  }
  if (projection.custom !== undefined) {
    const custom = projection.custom;
    if (typeof custom !== 'object' || custom === null || Array.isArray(custom)) {
      return 'Invalid Herdr theme projection: `custom` must be a record of tokens; no changes proposed.';
    }
    for (const [token, value] of Object.entries(custom)) {
      if (!HERDR_TOKEN_ORDER.includes(token)) {
        return `Invalid Herdr theme projection: \`${token}\` is not a Herdr theme token; no changes proposed.`;
      }
      if (!isConcreteHex(value)) {
        return `Invalid Herdr theme projection: \`${token}\` value ${JSON.stringify(value)} is not #rrggbb; no changes proposed.`;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ lines */

function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) {
      lines.push({ start, end: text.length, content: text.slice(start), eol: '' });
      break;
    }
    const crlf = newline > start && text[newline - 1] === '\r';
    const contentEnd = crlf ? newline - 1 : newline;
    lines.push({ start, end: newline + 1, content: text.slice(start, contentEnd), eol: crlf ? '\r\n' : '\n' });
    start = newline + 1;
  }
  return lines;
}

function lineIndexAt(lines, offset) {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lines[mid].start <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function isSpace(character) {
  return character === ' ' || character === '\t';
}

function indentOf(content) {
  const match = /^[ \t]*/.exec(content);
  return match ? match[0] : '';
}

/* --------------------------------------------------- string / value echoes */

// Validate one escape sequence starting at the backslash. Surrogates are refused
// because they are not scalar values: a config Herdr cannot parse is not a config.
function escapeAt(text, index, multiline) {
  const escape = text[index + 1];
  if (escape === undefined) return { error: 'unterminated string' };
  if (BASIC_ESCAPES.has(escape)) return { end: index + 2 };
  if (escape === 'u' || escape === 'U') {
    const size = escape === 'u' ? 4 : 8;
    const hex = text.slice(index + 2, index + 2 + size);
    if (hex.length !== size || !/^[0-9a-fA-F]+$/.test(hex)) return { error: 'invalid unicode escape in a string' };
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return { error: 'unicode escapes must be scalar values' };
    return { end: index + 2 + size };
  }
  if (multiline) {
    // A line-ending backslash: the backslash is the last non-blank character of
    // the line and it trims all following whitespace and newlines.
    let cursor = index + 1;
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1;
    const newline = text[cursor] === '\n' ? cursor + 1 : text[cursor] === '\r' && text[cursor + 1] === '\n' ? cursor + 2 : -1;
    if (newline >= 0) {
      let end = newline;
      while (end < text.length && /[ \t\r\n]/.test(text[end])) end += 1;
      return { end };
    }
  }
  return { error: `unsupported escape \\${escape} in a string` };
}

function decodeEscapes(inner, multiline) {
  let out = '';
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character !== '\\') {
      out += character;
      continue;
    }
    const escape = inner[index + 1];
    if (escape === 'u' || escape === 'U') {
      const size = escape === 'u' ? 4 : 8;
      const code = Number.parseInt(inner.slice(index + 2, index + 2 + size), 16);
      if (!Number.isFinite(code)) return null;
      out += String.fromCodePoint(code);
      index += 1 + size;
      continue;
    }
    if (multiline && (escape === '\n' || escape === '\r')) {
      index += escape === '\r' ? 2 : 1;
      while (index + 1 < inner.length && /[ \t\r\n]/.test(inner[index + 1])) index += 1;
      continue;
    }
    const values = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (escape === undefined || !Object.hasOwn(values, escape)) return null;
    out += values[escape];
    index += 1;
  }
  return out;
}

// Where a single-line string starting here ends, checking its escapes.
function singleLineStringEnd(text, index) {
  const quote = text[index];
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (quote === '"' && character === '\\') {
      const escape = escapeAt(text, cursor, false);
      if (escape.error) return null;
      cursor = escape.end;
      continue;
    }
    if (character === quote) return cursor + 1;
    cursor += 1;
  }
  return null;
}

/* ------------------------------------------- tolerant boundary scanning --- */

// Where does the value starting at `from` end? This is NOT a grammar: it only
// tracks the three contexts that can hide a line break — multi-line strings,
// arrays and inline tables — plus comments, so table headers can be recognised
// at real line starts. It refuses only when a context cannot be closed.
function scanValueBoundary(text, from) {
  const length = text.length;
  let index = from;
  const brackets = [];
  let string = null;
  while (index < length) {
    const character = text[index];
    if (string !== null) {
      if (string === '"""' || string === "'''") {
        if (string === '"""' && character === '\\') {
          // Boundary scan only: consume the escaped character and never validate
          // it (this covers line continuations, a bad escape, and an escaped
          // quote alike). Whether the escape is legal TOML is a parser's job.
          if (index + 1 >= length) return { error: 'unterminated string' };
          index += 2;
          continue;
        }
                if (character === string[0]) {
          let run = 0;
          while (text[index + run] === string[0]) run += 1;
          if (run < 3) {
            index += run;
            continue;
          }
          // Any run of three or more closes the string. Whether the remaining
          // quotes are legal TOML is a parser's judgement, not a boundary's.
          string = null;
          index += run;
          continue;
        }
        index += 1;
        continue;
      }
      if (string === '"') {
        if (character === '\\') {
          // Boundary scan only: an escape consumes the next character and is not
          // validated here. A string outside the theme tables is the user's
          // bytes; whether its escapes are legal is not this scanner's business.
          if (index + 1 >= length) return { error: 'unterminated string' };
          index += 2;
          continue;
        }
        if (character === '"') {
          string = null;
          index += 1;
          continue;
        }
      } else if (character === "'") {
        string = null;
        index += 1;
        continue;
      }
      if (character === '\n') return { error: 'unterminated string' };
      index += 1;
      continue;
    }
    if (character === '#') {
      while (index < length && text[index] !== '\n') index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const triple = character.repeat(3);
      if (text.startsWith(triple, index)) {
        string = triple;
        index += 3;
        continue;
      }
      string = character;
      index += 1;
      continue;
    }
    if (character === '[' || character === '{') {
      brackets.push(character === '[' ? ']' : '}');
      index += 1;
      continue;
    }
    if (character === ']' || character === '}') {
      const expected = brackets.pop();
      if (expected !== undefined && expected !== character) return { error: 'mismatched bracket or brace' };
      index += 1;
      continue;
    }
    if (character === '\n' && brackets.length === 0) return { end: index };
    index += 1;
  }
  if (string !== null) return { error: 'unterminated string' };
  if (brackets.length > 0) return { error: 'unterminated array or inline table' };
  return { end: length };
}

// One quoted key segment: a quoted segment is ONE literal segment, so
// `["theme"]` is `[theme]` while `["theme.custom"]` is a different root key.
function quotedSegmentAt(text, start, limit) {
  if (text.startsWith(text[start].repeat(3), start)) return { error: 'a quoted key must be on one line' };
  const end = singleLineStringEnd(text, start);
  if (end === null || end > limit) return { error: 'unterminated quoted key' };
  const raw = text.slice(start + 1, end - 1);
  const value = text[start] === '"' ? decodeEscapes(raw, false) : raw;
  if (value === null) return { error: 'unsupported escape in a quoted key' };
  return { value, end };
}

function parseKeySegmentsAt(text, start, limit) {
  const segments = [];
  let index = start;
  for (;;) {
    if (index >= limit) return { error: 'unterminated key' };
    const character = text[index];
    if (character === '"' || character === "'") {
      const quoted = quotedSegmentAt(text, index, limit);
      if (quoted.error) return quoted;
      segments.push(quoted.value);
      index = quoted.end;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(index, limit));
      if (!bare) return { error: 'not a key/value line' };
      segments.push(bare[0]);
      index += bare[0].length;
    }
    while (index < limit && isSpace(text[index])) index += 1;
    if (text[index] !== '.') return { segments, end: index };
    index += 1;
    while (index < limit && isSpace(text[index])) index += 1;
  }
}

function parseTableHeaderAt(text, start, limit) {
  const array = text[start + 1] === '[';
  let index = start + (array ? 2 : 1);
  const segments = [];
  let expectSegment = true;
  for (;;) {
    while (index < limit && isSpace(text[index])) index += 1;
    if (index >= limit) return { error: 'unterminated table header' };
    const character = text[index];
    if (character === ']') {
      if (segments.length === 0 || expectSegment) return { error: 'unsupported table header' };
      index += 1;
      if (array) {
        if (text[index] !== ']') return { error: 'unterminated array-of-tables header' };
        index += 1;
      }
      const rest = text.slice(index, limit).trim();
      if (rest !== '' && !rest.startsWith('#')) return { error: 'trailing content after the table header' };
      return { array, segments };
    }
    if (character === '.') {
      if (expectSegment) return { error: 'unsupported table header' };
      index += 1;
      expectSegment = true;
      continue;
    }
    if (!expectSegment) return { error: 'unsupported table header' };
    if (character === '"' || character === "'") {
      const quoted = quotedSegmentAt(text, index, limit);
      if (quoted.error) return quoted;
      segments.push(quoted.value);
      index = quoted.end;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(index, limit));
      if (!bare) return { error: 'unsupported table header' };
      segments.push(bare[0]);
      index += bare[0].length;
    }
    expectSegment = false;
  }
}

// Statements: blank, comment, header or content. A content statement may span
// lines; its `keys` are a best-effort key prefix (null when unparseable), which
// is all the theme decisions need.
function scanStatements(text, lines) {
  const statements = [];
  let pos = 0;
  let lineIndex = 0;
  while (pos < text.length) {
    const line = lines[lineIndex];
    const contentEnd = line.start + line.content.length;
    let cursor = pos;
    while (cursor < contentEnd && isSpace(text[cursor])) cursor += 1;
    if (cursor >= contentEnd) {
      statements.push({ kind: 'blank', line: lineIndex + 1, lastLine: lineIndex + 1 });
      pos = line.end;
      lineIndex += 1;
      continue;
    }
    if (text[cursor] === '#') {
      statements.push({ kind: 'comment', line: lineIndex + 1, lastLine: lineIndex + 1, text: line.content });
      pos = line.end;
      lineIndex += 1;
      continue;
    }
    if (text[cursor] === '[') {
      const header = parseTableHeaderAt(text, cursor, contentEnd);
      if (header.error) return { error: fail(lineIndex + 1, header.error) };
      statements.push({ kind: 'header', array: header.array, path: header.segments, line: lineIndex + 1, lastLine: lineIndex + 1 });
      pos = line.end;
      lineIndex += 1;
      continue;
    }
    const key = parseKeySegmentsAt(text, cursor, contentEnd);
    let valueStart = null;
    let boundary;
    if (key.error) {
      // No key: the line is opaque content that cannot continue past its `=`.
      const equals = text.indexOf('=', cursor);
      boundary = equals >= 0 && equals < contentEnd ? scanValueBoundary(text, equals + 1) : { end: contentEnd };
    } else {
      let after = key.end;
      while (after < contentEnd && isSpace(text[after])) after += 1;
      if (text[after] !== '=') {
        boundary = { end: contentEnd };
      } else {
        after += 1;
        while (after < text.length && isSpace(text[after])) after += 1;
        valueStart = after;
        boundary = scanValueBoundary(text, after);
      }
    }
    if (boundary.error) return { error: fail(lineIndex + 1, boundary.error) };
    const lastLine = lineIndexAt(lines, Math.max(cursor, boundary.end - 1)) + 1;
    statements.push({
      kind: 'content',
      line: lineIndex + 1,
      lastLine,
      keys: key.error ? null : key.segments,
      valueStart,
    });
    if (lines[lastLine - 1].end >= text.length) break;
    pos = lines[lastLine - 1].end;
    lineIndex = lineIndexAt(lines, pos);
  }
  return { statements };
}

/* -------------------------------------------- strict theme-table grammar --- */

// `key = value [comment]` where the key is ONE bare or quoted segment and the
// value is a single-line string, boolean, integer or float. Anything else is
// `other` — not an error by itself, because an untouched line is the user's.
function parseThemeLine(content) {
  const indent = indentOf(content);
  let index = indent.length;
  if (index >= content.length || content[index] === '#') return { kind: 'blank-line' };
  let key;
  if (content[index] === '"' || content[index] === "'") {
    const quoted = quotedSegmentAt(content, index, content.length);
    if (quoted.error) return { kind: 'other' };
    key = quoted.value;
    index = quoted.end;
  } else {
    const bare = /^[A-Za-z0-9_-]+/.exec(content.slice(index));
    if (!bare) return { kind: 'other' };
    key = bare[0];
    index += bare[0].length;
  }
  while (index < content.length && isSpace(content[index])) index += 1;
  if (content[index] !== '=') return { kind: 'other' };
  index += 1;
  while (index < content.length && isSpace(content[index])) index += 1;
  const valueStart = index;
  let valueKind = null;
  if (content[index] === '"' || content[index] === "'") {
    const end = singleLineStringEnd(content, index);
    if (end === null) return { kind: 'other' };
    valueKind = 'string';
    index = end;
  } else {
    const run = /^[^ \t#]*/.exec(content.slice(index))[0];
    if (run === '') return { kind: 'other' };
    if (/^(?:true|false)$/.test(run)) valueKind = 'boolean';
    else if (STRICT_NUMBER.test(run)) valueKind = 'number';
    else return { kind: 'other' };
    index += run.length;
  }
  while (index < content.length && isSpace(content[index])) index += 1;
  if (index < content.length && content[index] !== '#') return { kind: 'other' };
  return {
    kind: 'key',
    key,
    indent,
    valueStart,
    valueEnd: valueStart + (valueKind === 'string' ? (singleLineStringEnd(content, valueStart) - valueStart) : (/^[^ \t#]*/.exec(content.slice(valueStart))[0].length)),
    valueKind,
    raw: content.slice(valueStart, valueStart + (valueKind === 'string'
      ? singleLineStringEnd(content, valueStart) - valueStart
      : /^[^ \t#]*/.exec(content.slice(valueStart))[0].length)),
  };
}

// The text of a `was` marker for `key`, or null when the comment is not one of
// ours. The payload is the WHOLE original line minus its indentation — trailing
// spaces, tabs and an inline comment included — because a restore must give back
// the user's bytes exactly. It must parse with the same strict grammar, name the
// same key and carry a string (the only thing this writer records); a payload
// that cannot be read back safely is an ordinary comment.
function markerLine(commentText, key) {
  const indent = indentOf(commentText);
  const rest = commentText.slice(indent.length);
  if (!rest.startsWith(WAS_PREFIX)) return null;
  const payload = rest.slice(WAS_PREFIX.length);
  if (UNRECORDABLE.test(payload)) return null;
  const parsed = parseThemeLine(payload);
  if (parsed.kind !== 'key' || parsed.key !== key || parsed.valueKind !== 'string') return null;
  return { payload, value: decodedStringValue(parsed) };
}

// A comment line directly above `begin` that would parse as a marker for the
// first key after the block. Such a line is the user's ordinary comment today,
// but once the block lines are removed it is adjacent to that key and the next
// plan would treat it as ownership. Returns its line number, or -1.
function ambiguousMarkerAbove(lines, statements, isComment, blockBegin, blockEnd) {
  let key = null;
  for (const statement of statements) {
    if (statement.kind !== 'content' || statement.line <= blockEnd) continue;
    if (!statement.keys || statement.keys.length !== 1) break;
    key = statement.keys[0];
    break;
  }
  if (key === null || !HERDR_TOKEN_ORDER.includes(key)) return -1;
  for (let line = blockBegin - 1; line >= 1 && isComment(line); line -= 1) {
    if (markerLine(lines[line - 1].content, key) !== null) return line;
  }
  return -1;
}

// Every marker for `key` in the contiguous comment block above the key line.
function markersAbove(lines, isComment, keyLine, key) {
  const found = [];
  for (let line = keyLine - 1; line >= 1; line -= 1) {
    if (!isComment(line)) break;
    const marker = markerLine(lines[line - 1].content, key);
    if (marker === null) continue;
    found.push({ line, payload: marker.payload, value: marker.value });
  }
  return found;
}

// A string value's decoded text. Escapes belong to basic strings only: a literal
// string is exactly the characters between its quotes, so `'\u0023123456'` is
// that text and NOT the colour `#123456`.
function decodedStringValue(strict) {
  return strict.raw[0] === '"' ? decodeEscapes(strict.raw.slice(1, -1), false) : strict.raw.slice(1, -1);
}

/* ------------------------------------------------------------------ splice */

function themePath(path) {
  if (path.length === 1) return path[0] === 'theme';
  return path.length === 2 && path[0] === 'theme' && path[1] === 'custom';
}

// The lines the planner guarantees it will not touch: every physical line that
// is not inside a `[theme]`/`[theme.custom]` table. Exported so the splice
// invariant can be tested directly.
function opaqueLines(text, skipLines = []) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  const lines = splitLines(body);
  const scanned = scanStatements(body, lines);
  if (scanned.error) return null;
  const skip = new Set(skipLines);
  const headers = scanned.statements.filter((statement) => statement.kind === 'header');
  const inside = new Set();
  for (let index = 0; index < headers.length; index += 1) {
    if (!themePath(headers[index].path)) continue;
    const from = headers[index].line;
    const to = index + 1 < headers.length ? headers[index + 1].line - 1 : lines.length;
    for (let line = from; line <= to; line += 1) inside.add(line);
  }
  const opaque = [];
  for (let line = 1; line <= lines.length; line += 1) {
    if (inside.has(line) || skip.has(line)) continue;
    opaque.push({ content: lines[line - 1].content, eol: lines[line - 1].eol });
  }
  return opaque;
}

// The invariant itself: the opaque lines of the output equal the input's, except
// that the last one may GAIN the single line terminator needed to append a table.
function spliceInvariant(beforeText, afterText, skipBeforeLines = []) {
  const before = opaqueLines(beforeText, skipBeforeLines);
  const after = opaqueLines(afterText);
  if (before === null || after === null) return false;
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index].content !== after[index].content) return false;
    if (index === before.length - 1) {
      // The file's tail: appending a table may add the one terminator that ends
      // an unterminated last line, and clearing may take it back again. Any
      // other change to a terminator is a splice.
      if (before[index].eol !== after[index].eol && beforeText.endsWith('\n')) return false;
      continue;
    }
    if (before[index].eol !== after[index].eol) return false;
  }
  return true;
}

/* ------------------------------------------------------------------- plan */

function planThemeConfig(rawText, projection) {
  const invalid = invalidProjection(projection);
  if (invalid) return { ok: false, error: invalid };
  if (typeof rawText !== 'string') {
    return { ok: false, error: 'Unsupported Herdr config: expected text; no changes proposed.' };
  }

  // A UTF-8 BOM is part of the file the user owns: skip it while scanning and
  // put it back byte for byte.
  const bom = rawText.startsWith(BOM) ? BOM : '';
  const body = rawText.slice(bom.length);
  const lines = splitLines(body);
  const documentEol = (lines.find((line) => line.eol !== '') ?? { eol: '\n' }).eol;

  // Structural, not semantic: these characters break the line model itself.
  const control = CONTROL_CHARACTERS.exec(body);
  if (control) return { ok: false, error: fail(lineIndexAt(lines, control.index) + 1, 'unsupported control character') };
  const carriageReturn = BARE_CARRIAGE_RETURN.exec(body);
  if (carriageReturn) {
    return { ok: false, error: fail(lineIndexAt(lines, carriageReturn.index) + 1, 'a bare carriage return is not a line ending') };
  }

  const scanned = scanStatements(body, lines);
  if (scanned.error) return { ok: false, error: scanned.error };
  const { statements } = scanned;
  const kindByLine = new Map(statements.map((statement) => [statement.line, statement.kind]));
  const isCommentLine = (line) => kindByLine.get(line) === 'comment';

  // ---- pass 1: sections, theme tables, our block.
  let section = 'root';
  let themeHeader = -1;
  let customHeader = -1;
  let customLastKeyLine = -1;
  let customHasOtherContent = false;
  let blockBegin = -1;
  let blockEnd = -1;
  let blockCreated = false;
  let blockAddedEof = false;
  let nameField = null;
  const userTokens = new Map();
  const blockTokens = new Map();
  const themeKeys = new Set();
  const customKeys = new Set();
  const legacyBegin = [];
  const legacyEnd = [];

  const fieldOf = (statement) => ({
    keyLine: statement.line,
    lastLine: statement.lastLine,
    indent: indentOf(lines[statement.line - 1].content),
    lineText: lines[statement.line - 1].content.slice(indentOf(lines[statement.line - 1].content).length),
    // A multi-line STRING form can sit on one physical line; it still cannot be
    // recorded as one original line.
    multiline: statement.lastLine !== statement.line
      || (statement.valueStart !== null && /^["']{3}/.test(body.slice(statement.valueStart, statement.valueStart + 3))),
  });

  for (const statement of statements) {
    if (statement.kind === 'comment') {
      const trimmed = statement.text.trim();
      if (section === 'theme.custom') {
        if (trimmed === BLOCK_BEGIN || trimmed === BLOCK_BEGIN_CREATED) {
          if (blockBegin >= 0) return { ok: false, error: fail(statement.line, 'the `# herdr-gentle-shell: begin` line appears more than once') };
          blockBegin = statement.line;
          blockCreated = trimmed === BLOCK_BEGIN_CREATED;
        } else if (trimmed === BLOCK_END || trimmed === BLOCK_END_ADDED) {
          blockAddedEof = trimmed === BLOCK_END_ADDED;
          if (blockBegin < 0 || blockEnd >= 0) {
            return { ok: false, error: fail(statement.line, 'the `# herdr-gentle-shell: end` line has no matching begin') };
          }
          blockEnd = statement.line;
        }
      }
      if (section === 'theme.custom' && blockBegin >= 0 && blockEnd < 0
        && statement.line !== blockBegin && statement.line !== blockEnd) {
        // Between begin and end only our own `<token> = "#rrggbb"` lines are ours.
        // A comment there would be deleted by the rewrite, so it is a refusal.
        return { ok: false, error: fail(statement.line, 'unexpected content inside the herdr-gentle-shell block') };
      }
      if (section === 'theme.custom' && trimmed !== BLOCK_BEGIN && trimmed !== BLOCK_BEGIN_CREATED
        && trimmed !== BLOCK_END && trimmed !== BLOCK_END_ADDED) {
        customHasOtherContent = true;
      }
      if (trimmed === LEGACY_BEGIN) legacyBegin.push(statement.line);
      else if (trimmed === LEGACY_END) legacyEnd.push(statement.line);
      continue;
    }

    if (statement.kind === 'header') {
      if (blockBegin >= 0 && blockEnd < 0) {
        return { ok: false, error: fail(statement.line, 'the `# herdr-gentle-shell` block is not terminated') };
      }
      const path = statement.path;
      if (path[0] !== 'theme') {
        section = 'other';
        continue;
      }
      if (statement.array) {
        return { ok: false, error: fail(statement.line, `\`[[${path.join('.')}]]\` array-of-tables is not supported`) };
      }
      if (path.length === 1) {
        if (themeHeader >= 0) return { ok: false, error: fail(statement.line, '`[theme]` appears more than once') };
        themeHeader = statement.line;
        section = 'theme';
        continue;
      }
      if (path.length === 2 && path[1] === 'custom') {
        if (customHeader >= 0) return { ok: false, error: fail(statement.line, '`[theme.custom]` appears more than once') };
        customHeader = statement.line;
        section = 'theme.custom';
        continue;
      }
      return { ok: false, error: fail(statement.line, `\`[${path.join('.')}]\` is not a table this writer owns`) };
    }

    if (statement.kind === 'blank' && section === 'theme.custom') {
      if (blockBegin >= 0 && blockEnd < 0) {
        // A whitespace-only line inside our block is not ours either.
        return { ok: false, error: fail(statement.line, 'unexpected content inside the herdr-gentle-shell block') };
      }
      customHasOtherContent = true;
      continue;
    }
    if (statement.kind !== 'content') continue;
    if (section === 'root' && statement.keys && statement.keys[0] === 'theme') {
      return {
        ok: false,
        error: fail(statement.line, statement.keys.length === 1 ? 'a top-level `theme` key is user configuration' : 'a dotted `theme` key cannot be adopted safely'),
      };
    }
    if (section !== 'theme' && section !== 'theme.custom') continue;

    const lineContent = lines[statement.line - 1].content;
    const single = statement.lastLine === statement.line;
    const strict = single ? parseThemeLine(lineContent) : { kind: 'other' };
    const keys = statement.keys;
    const keyName = keys && keys.length >= 1 ? keys[0] : null;

    if (section === 'theme.custom' && blockBegin >= 0 && blockEnd < 0) {
      // Inside our block ONLY our own `<token> = "#rrggbb"` lines are ours. A
      // human line is never deleted, so anything else is a refusal.
      const match = /^([a-z0-9_]+) = "(#[0-9a-fA-F]{6})"$/.exec(lineContent.trim());
      if (!single || !match || !HERDR_TOKEN_ORDER.includes(match[1])) {
        return { ok: false, error: fail(statement.line, 'unexpected content inside the herdr-gentle-shell block') };
      }
      if (blockTokens.has(match[1])) {
        return { ok: false, error: fail(statement.line, `\`${match[1]}\` appears more than once in \`[theme.custom]\``) };
      }
      blockTokens.set(match[1], { line: statement.line });
      continue;
    }

    if (section === 'theme') {
      if (keyName === null) continue;
      const dotted = keys.length > 1;
      if (dotted && THEME_OWNED_KEYS.has(keyName)) {
        return { ok: false, error: fail(statement.line, 'a dotted key extending `[theme]` cannot be adopted safely') };
      }
      if (dotted) continue;
      if (THEME_KEYS_REFUSED.has(keyName)) {
        return { ok: false, error: fail(statement.line, `\`${keyName}\` in \`[theme]\` is not supported`) };
      }
      if (keyName === 'custom') {
        return { ok: false, error: fail(statement.line, '`custom` in `[theme]` must be a `[theme.custom]` table') };
      }
      if (keyName === 'auto_switch' || keyName === 'name') {
        if (themeKeys.has(keyName)) {
          return { ok: false, error: fail(statement.line, `\`${keyName}\` appears more than once in \`[theme]\``) };
        }
        themeKeys.add(keyName);
      }
      if (keyName === 'auto_switch') {
        // The reference refuses this line outright, which is why the user's real
        // config (auto_switch = false) was never written. Accept it untouched.
        if (strict.kind !== 'key' || strict.raw !== 'false') {
          return { ok: false, error: fail(statement.line, '`auto_switch` is only supported as `auto_switch = false`') };
        }
        continue;
      }
      if (keyName === 'name') {
        if (strict.kind !== 'key' || strict.valueKind !== 'string') {
          return { ok: false, error: fail(statement.line, '`name` value is not a plain single-line string') };
        }
        nameField = { ...fieldOf(statement), strict, value: decodedStringValue(strict) };
      }
      continue;
    }

    // [theme.custom]
    if (keyName === null) {
      customHasOtherContent = true;
      continue;
    }
    if (keys.length > 1 && HERDR_TOKEN_ORDER.includes(keyName)) {
      return { ok: false, error: fail(statement.line, 'a dotted key extending `[theme.custom]` cannot be adopted safely') };
    }
    if (keys.length > 1) {
      customHasOtherContent = true;
      continue;
    }
    customLastKeyLine = statement.lastLine;
    if (!HERDR_TOKEN_ORDER.includes(keyName)) {
      customHasOtherContent = true;
      continue;
    }
    if (customKeys.has(keyName)) {
      return { ok: false, error: fail(statement.line, `\`${keyName}\` appears more than once in \`[theme.custom]\``) };
    }
    customKeys.add(keyName);
    userTokens.set(keyName, { ...fieldOf(statement), strict, value: strict.kind === 'key' && strict.valueKind === 'string' ? decodedStringValue(strict) : null });
  }

  if (blockBegin >= 0 && blockEnd < 0) {
    return { ok: false, error: fail(blockBegin, 'the `# herdr-gentle-shell` block is not terminated') };
  }
  for (const [token, field] of blockTokens) {
    const user = userTokens.get(token);
    if (user) return { ok: false, error: fail(user.keyLine, `\`${token}\` appears more than once in \`[theme.custom]\``) };
    void field;
  }

  // ---- legacy 1.8.0 marker pairing: nearest preceding BEGIN, theme table inside.
  const dropped = new Set();
  const legacyDroppedLines = [];
  {
    const open = [];
    for (const statement of statements) {
      if (statement.kind !== 'comment') continue;
      const trimmed = statement.text.trim();
      if (trimmed === LEGACY_BEGIN) {
        open.push(statement.line);
        continue;
      }
      if (trimmed !== LEGACY_END) continue;
      const begin = open.pop();
      if (begin === undefined) continue;
      const enclosesTheme = statements.some(
        (candidate) => candidate.kind === 'header' && candidate.line > begin && candidate.line < statement.line && themePath(candidate.path),
      );
      if (!enclosesTheme) continue;
      dropped.add(begin - 1);
      dropped.add(statement.line - 1);
      legacyDroppedLines.push(begin, statement.line);
    }
  }

  const desired = new Map(Object.entries(projection.custom ?? {}));
  const replaced = new Map();
  const insertBefore = new Map();
  const insertAfter = new Map();

  const replaceValue = (field, raw) => {
    const content = lines[field.keyLine - 1].content;
    replaced.set(field.keyLine - 1, content.slice(0, field.strict.valueStart) + raw + content.slice(field.strict.valueEnd));
  };
  const restoreLine = (field, marker) => {
    // A restore gives the user's original line back, but their LATEST edit wins:
    // the key/value part comes from the recorded line, the trailing whitespace
    // and inline comment from the line as it is now when they differ (E: a user
    // who edits the comment after we wrote the value must keep their comment).
    const payload = marker.payload;
    const stored = parseThemeLine(payload);
    const current = field.strict;
    let restored = payload;
    if (stored.kind === 'key' && current.kind === 'key') {
      const currentTrailing = lines[field.keyLine - 1].content.slice(current.valueEnd);
      // Only an explicit comment/whitespace on the line now counts as an edit;
      // an empty tail says nothing, so the recorded bytes (D: exact restore) win.
      if (currentTrailing.trim() !== '' && currentTrailing !== payload.slice(stored.valueEnd)) {
        restored = payload.slice(0, stored.valueEnd) + currentTrailing;
      }
    }
    replaced.set(field.keyLine - 1, field.indent + restored);
    for (let line = field.keyLine; line < field.lastLine; line += 1) dropped.add(line);
  };

  const addMarker = (field, marker) => {
    if (!insertBefore.has(field.keyLine - 1)) insertBefore.set(field.keyLine - 1, []);
    insertBefore.get(field.keyLine - 1).push(`${field.indent}${WAS_PREFIX}${marker}`);
  };
  const cannotRecord = (field, key) => fail(field.keyLine, `cannot record the original value of \`${key}\` safely`);

  // Rule 1: the theme name, in place, or inserted right after its header.
  if (nameField) {
    const markers = markersAbove(lines, isCommentLine, nameField.keyLine, 'name');
    if (markers.length > 1) {
      return { ok: false, error: fail(markers[0].line, 'duplicate herdr-gentle-shell marker for `name`') };
    }
    const marker = markers.length === 1 ? markers[0] : null;
    if (marker && marker.value === projection.name) {
      // The projection is back to the value the user originally had: give the
      // ORIGINAL line back (its quoting, spacing and comment) and drop the marker.
      restoreLine(nameField, marker);
      dropped.add(marker.line - 1);
    } else if (nameField.value !== projection.name) {
      if (nameField.strict.kind !== 'key' || nameField.strict.valueKind !== 'string') {
        return { ok: false, error: fail(nameField.keyLine, '`name` value is not a plain single-line string') };
      }
      // A line we cannot record on one comment line is refused, not half-recorded.
      if (!marker && UNRECORDABLE.test(nameField.lineText)) {
        return { ok: false, error: cannotRecord(nameField, 'name') };
      }
      replaceValue(nameField, `"${projection.name}"`);
      if (!marker) addMarker(nameField, nameField.lineText);
    }
  } else if (themeHeader >= 0) {
    insertAfter.set(themeHeader - 1, [`name = "${projection.name}"`]);
  } else if (blockBegin >= 0 || customHeader >= 0) {
    // A theme name that no table carries is appended at the end (see below).
  }

  // Rule 2 + reconciliation.
  const blockLines = [];
  for (const token of HERDR_TOKEN_ORDER) {
    const wanted = desired.get(token);
    const user = userTokens.get(token);
    if (!user) {
      if (wanted !== undefined) blockLines.push(`${token} = "${wanted}"`);
      continue;
    }
    const markers = markersAbove(lines, isCommentLine, user.keyLine, token);
    if (markers.length > 1) {
      return { ok: false, error: fail(markers[0].line, `duplicate herdr-gentle-shell marker for \`${token}\``) };
    }
    const marker = markers.length === 1 ? markers[0] : null;
    if (marker === null && wanted === undefined) continue;
    if (user.strict.kind !== 'key' || user.strict.valueKind !== 'string') {
      // This line would be replaced or dropped, and the user edited it since (a
      // multi-line value, for instance). Refuse: never delete the user's bytes.
      return {
        ok: false,
        error: user.multiline
          ? cannotRecord(user, token)
          : fail(user.keyLine, `\`${token}\` value is not a plain single-line string`),
      };
    }
    if (marker !== null && marker.value === wanted) {
      // Back to the user's original value: restore the line verbatim (quoting,
      // spacing, inline comment) and forget the marker.
      restoreLine(user, marker);
      dropped.add(marker.line - 1);
      continue;
    }
    if (wanted === undefined) {
      restoreLine(user, marker);
      dropped.add(marker.line - 1);
      continue;
    }
    if (user.value === wanted) continue;
    if (!marker && UNRECORDABLE.test(user.lineText)) {
      return { ok: false, error: cannotRecord(user, token) };
    }
    replaceValue(user, `"${wanted}"`);
    if (!marker) addMarker(user, user.lineText);
  }

  const willAppendEof = (!nameField && themeHeader < 0) || (customHeader < 0 && blockLines.length > 0);
  const createdFlag = blockCreated || customHeader < 0;
  // Does this plan append a table after an unterminated last line, i.e. add the
  // file's missing final line ending? Only then may a later clear take it back.
  const lastIndex = lines.length - 1;
  // Lines this plan puts AFTER the document's last line force that line's
  // terminator: an append at EOF, a name inserted below an unterminated header,
  // or a block inserted below the last user key.
  const blockAnchor = customLastKeyLine > 0 ? customLastKeyLine - 1 : customHeader - 1;
  const insertAfterLast = insertAfter.has(lastIndex)
    || (blockLines.length > 0 && customHeader >= 0 && blockAnchor === lastIndex);
  const addsEofTerminator = lines.length > 0 && !dropped.has(lastIndex)
    && lines[lastIndex].eol === '' && (willAppendEof || insertAfterLast);
  // Where the block is (or was) placed, did that add the file's missing final
  // line ending? Once the block exists its end line is the only record; while it
  // is being placed this plan knows it directly. (An unchanged block is never
  // rewritten just to restate its spelling.)
  const eofMarked = blockBegin >= 0 ? blockAddedEof : addsEofTerminator;
  const beginLine = createdFlag ? BLOCK_BEGIN_CREATED : BLOCK_BEGIN;
  const endLine = eofMarked ? BLOCK_END_ADDED : BLOCK_END;
  const blockWanted = [];
  if (blockLines.length > 0) blockWanted.push(beginLine, ...blockLines, endLine);

  if (blockBegin >= 0) {
    const actual = [];
    for (let line = blockBegin; line <= blockEnd; line += 1) actual.push(lines[line - 1].content);
    const sameBlock = actual.length === blockWanted.length && actual.every((text, index) => text === blockWanted[index]);
    if (!sameBlock) {
      // Removing or moving the block makes a comment that sat above `begin`
      // adjacent to the key below it. If that comment would parse as a marker
      // for that key, the next plan would promote the user's ordinary comment to
      // ownership (silently restoring an old colour and eating the comment), so
      // the shape is ambiguous and this plan refuses instead of guessing.
      const ambiguous = ambiguousMarkerAbove(lines, statements, isCommentLine, blockBegin, blockEnd);
      if (ambiguous >= 0) {
        return { ok: false, error: fail(ambiguous, 'ambiguous herdr-gentle-shell marker above the managed block') };
      }
      for (let line = blockBegin; line <= blockEnd; line += 1) dropped.add(line - 1);
      if (blockWanted.length > 0) {
        const anchor = customLastKeyLine > 0 ? customLastKeyLine - 1 : customHeader - 1;
        if (!insertAfter.has(anchor)) insertAfter.set(anchor, []);
        insertAfter.get(anchor).push(...blockWanted);
      }
    }
  } else if (blockWanted.length > 0) {
    const anchor = customLastKeyLine > 0 ? customLastKeyLine - 1 : customHeader - 1;
    if (!insertAfter.has(anchor)) insertAfter.set(anchor, []);
    insertAfter.get(anchor).push(...blockWanted);
  }

  // A `[theme.custom]` header this planner created goes away again when its
  // block empties and the table holds nothing else, so a full cycle is byte
  // identical. A header the user wrote is never removed.
  if (blockBegin >= 0 && blockWanted.length === 0 && blockCreated && !customHasOtherContent
    && userTokens.size === 0 && customLastKeyLine === -1) {
    dropped.add(customHeader - 1);
  }

  // Tables that do not exist yet are created at the end, theme before custom.
  const eofBlocks = [];
  if (!nameField && themeHeader < 0) eofBlocks.push(['[theme]', `name = "${projection.name}"`]);
  if (customHeader < 0 && blockWanted.length > 0) eofBlocks.push(['[theme.custom]', ...blockWanted]);

  // Rebuild line by line. Every inserted line uses the ending of the line it is
  // attached to, so CRLF and mixed documents keep their shape.
  let text = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const eol = line.eol || documentEol;
    const before = insertBefore.get(index);
    if (before) for (const entry of before) text += entry + eol;
    if (!dropped.has(index)) text += (replaced.get(index) ?? line.content) + line.eol;
    const after = insertAfter.get(index);
    if (after) {
      if (line.eol === '') text += eol;
      for (const entry of after) text += entry + eol;
    }
  }

  const eofEol = lines.length > 0 ? lines[lines.length - 1].eol || documentEol : documentEol;
  for (const block of eofBlocks) {
    // Appending a table adds exactly ONE terminator to end an unterminated last
    // line, and a blank separator only when the file already ended with one.
    if (text.length > 0 && !text.endsWith('\n')) text += eofEol;
    for (const line of block) text += line + eofEol;
  }

  // A document without a final newline keeps having none, and the removed line
  // ending must be the whole ending: stripping a bare "\n" from "\r\n" would
  // leave a lone CR and an invalid file.
  const unterminated = rawText.length > 0 && !rawText.endsWith('\n');
  // ...only when THIS planner is the one that added the ending (it is appending
  // a table after an unterminated last line now, or the created block records
  // that it did). A user's own unterminated line that merely sat above a block
  // we removed keeps its bytes, and a legacy marker at EOF owned its own ending.
  const addedEofTerminator = addsEofTerminator || blockAddedEof;
  if (unterminated && addedEofTerminator && !legacyDroppedLines.includes(lines.length) && /\r?\n$/.test(text)) {
    text = text.replace(/\r?\n$/, '');
  }

  const result = bom + text;
  if (result !== rawText && !spliceInvariant(rawText, result, legacyDroppedLines)) {
    return { ok: false, error: 'internal splice invariant violated; no changes proposed.' };
  }
  return { ok: true, text: result, changed: result !== rawText };
}

module.exports = {
  planThemeConfig,
  opaqueLines,
  spliceInvariant,
};
