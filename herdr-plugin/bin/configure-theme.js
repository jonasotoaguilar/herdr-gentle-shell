#!/usr/bin/env node
'use strict';

// configure-theme: write the managed `[theme]` block that carries the Herdr
// theme projection (theme-sync T2 over S3/S5). The Pi extension computes the
// palette and pipes it in on stdin as
//   { "theme": { "name": "<herdr-theme>", "custom": { "<token>": "#rrggbb" } } }
// and this CLI owns everything that touches config.toml: planning, validation,
// the atomic write and the optional reload. It never touches the sidebar block
// and never prints the file or anything read from the environment.
//
// Exit codes: 0 applied/current/removed/absent (or --check current/absent);
// 1 --check found a stale block, or a requested reload failed after a write;
// 2 refused (malformed payload, foreign [theme] table, malformed markers, bad
// argv) with no write and no reload. Refusals print exactly one stderr line
// naming the problem.

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-agents: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const fs = require('node:fs');

const theme = require('../lib/gentle-theme-config');

const OPS = ['--apply', '--remove', '--check'];

function usage() {
  return [
    'usage: node bin/configure-theme.js [--apply | --remove | --check] [--reload] [--json]',
    '',
    '  --apply   (default) read the projected palette from stdin and write the',
    '            managed [theme] block; a refusal leaves the file untouched',
    '  --remove  remove the managed [theme] block; absent means nothing to do',
    '  --check   read-only: exit 0 current/absent, 1 stale, 2 refused; never writes',
    '  --reload  run `herdr server reload-config` after a write',
    '  --json    print one machine-readable JSON line instead of a sentence',
    '',
    '  stdin     {"theme":{"name":"<herdr-theme>","custom":{"<token>":"#rrggbb"}}}',
    `  themes    ${theme.THEMES.join(', ')}`,
    '  tokens    ' + theme.CUSTOM_TOKENS.join(', '),
    `  config: ${theme.themeConfigPath()} (HERDR_CONFIG_PATH/XDG_CONFIG_HOME override)`,
  ].join('\n');
}

// Herdr runs this against a live config, so a terminal stdin must never make
// the reader block: no pipe means "no payload".
function readStdin() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function humanLine(result) {
  const key = `${result.op}:${result.status}`;
  switch (key) {
    case 'apply:applied':
      return `configure-theme: applied theme "${result.theme}" to ${result.file}`;
    case 'apply:current':
      return `configure-theme: theme "${result.theme}" already current in ${result.file}; unchanged`;
    case 'remove:removed':
      return `configure-theme: removed managed theme block from ${result.file}`;
    case 'remove:absent':
      return 'configure-theme: no managed theme block; nothing to do';
    case 'check:current':
      return 'configure-theme: managed theme block present and current';
    case 'check:absent':
      return 'configure-theme: managed theme block absent';
    default:
      return null;
  }
}

function report(result, wantsJson, wantsReload) {
  // A refusal is always named on stderr, in every output mode: the machine
  // line on stdout is for the caller, the stderr line is for the human
  // reading the log.
  if (result.error !== undefined) process.stderr.write(`configure-theme: ${result.error}\n`);
  if (wantsJson) {
    const payload = {
      op: result.op,
      status: result.status,
      file: result.file,
      theme: result.theme,
      changed: result.changed,
    };
    // `reloaded` answers "did a reload happen": false both when nothing was
    // written and when the reload was not requested.
    if (wantsReload) payload.reloaded = result.reloaded === true;
    if (result.error !== undefined) payload.error = result.error;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (result.error !== undefined) return;
  // A stale block is a "needs --apply", not a success: keep stdout empty and
  // say what to run on stderr, like the sidebar writer's --check.
  if (result.op === 'check' && result.status === 'stale') {
    process.stderr.write('configure-theme: managed theme block is stale; run --apply to update it\n');
    return;
  }
  process.stdout.write(`${humanLine(result)}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const known = new Set([...OPS, '--reload', '--json', '--help', '-h']);
  for (const arg of argv) {
    if (!known.has(arg)) {
      process.stderr.write(`configure-theme: unknown flag ${arg}\n${usage()}\n`);
      return 2;
    }
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const selected = OPS.filter((flag) => argv.includes(flag));
  if (selected.length > 1) {
    process.stderr.write(`configure-theme: choose exactly one of ${OPS.join(', ')}\n${usage()}\n`);
    return 2;
  }
  const op = selected.length === 1 ? selected[0].slice(2) : 'apply';
  const wantsReload = argv.includes('--reload');
  const wantsJson = argv.includes('--json');

  const payloadText = op === 'remove' ? '' : readStdin();

  let result;
  try {
    result = theme.run(op, payloadText);
  } catch (error) {
    if (!(error instanceof theme.RefusalError)) throw error;
    report(
      { op, status: 'refused', file: theme.themeConfigPath(), theme: null, changed: false, error: error.message },
      wantsJson,
      wantsReload,
    );
    return 2;
  }

  // Reload only after a write: an unchanged file needs no Herdr round-trip,
  // and --check never mutates anything to reload for.
  if (wantsReload && result.changed) result.reloaded = theme.reloadThemeConfig();
  report(result, wantsJson, wantsReload);

  if (result.reloaded === false) return 1;
  if (result.op === 'check' && result.status === 'stale') return 1;
  return 0;
}

if (require.main === module) process.exitCode = main();
