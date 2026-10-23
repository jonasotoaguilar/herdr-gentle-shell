'use strict';
// Contract under test (observable behavior only — child exit codes and output):
// - requiring lib/pi-extension-exclusion.js as a LIBRARY runs no CLI: the
//   importer's argv is never parsed, nothing is printed, and the process does
//   not exit. Tooling that loads every module in lib/ must survive it.
// - running it as the entry point still validates its arguments and exits 2
//   with the usage line, so the install path keeps its fail-closed CLI.
// ---------------------------------------------------------------------------

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib', 'pi-extension-exclusion.js');

function runNode(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
}

describe('pi-extension-exclusion is safe to require', { concurrency: false }, () => {
  test('requiring it runs no CLI, parses no argv and does not exit', () => {
    // The child gets an argv the CLI would reject, so an accidental main()
    // shows up as exit 2 and a usage line instead of a clean module load.
    const result = runNode([
      '-e',
      `const mod = require(${JSON.stringify(LIB)});
       process.stdout.write(typeof mod.main);`,
      'ensure',
      '--bogus',
    ]);
    assert.equal(result.status, 0, `require must not exit the importer: ${result.stderr}`);
    assert.equal(result.stdout, 'function', 'main is exported for programmatic use');
    assert.equal(result.stderr, '', 'a library load prints nothing');
  });

  test('running it as the entry point still fails closed on bad usage', () => {
    const result = runNode([LIB]);
    assert.equal(result.status, 2, 'usage failures keep exit code 2');
    assert.match(result.stderr, /pi-extension-exclusion: error: usage: pi-extension-exclusion\.js \(ensure\|remove\)/);
  });
});
