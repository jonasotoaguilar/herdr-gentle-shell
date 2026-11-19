# perf-review-fixes

Remediates the findings of a read-only review of herdr-gentle-shell (readability,
refactor, optimization). Six units, in the order the review recommended and the
human accepted. No behavior changes except the two documented bounds (S1, S2).

## Specs

S1 — Presence activity read must be bounded to a size the writer can actually reach.
Quote from the review, accepted verbatim: "`PRESENCE_ACTIVITY_LIMIT = 16 * 1024 * 1024` …
Cada beat (15 s) hace `opendirSync` … y `JSON.parse` … **Este es el único hallazgo de
performance con potencial de molestar de verdad**: 16 MB de lectura + parse bloquean el
loop cientos de milisegundos". Acceptance: the limit is lowered to a bounded value
proportional to real usage (a small multiple of `PRESENCE_HEADER_LIMIT`), the existing
guards stay, and a test pins that an oversized activity file is rejected exactly like the
other bounded reads (never partially parsed, never throws). Existing behavior for a
file at or below the limit is unchanged.

S2 — A Moshi envelope must never hold a socket forever.
Quote: "`moshiSendEnvelope` no tiene timeout … si el daemon acepta y nunca manda FIN de
vuelta, el fd queda en FIN_WAIT_2 para siempre". Acceptance: every envelope gets a
bounded destroy timer that is unref'd and cleared on close, the promise always settles,
`moshiInFlight` always drains, and no unhandled rejection is produced when the socket is
destroyed mid-flight. Sending to an absent or healthy Moshi daemon behaves exactly as today.

S3 — Repeated state-root resolution must not re-run per call.
Quote: "`stateRoot()` sin cache en el daemon … ~1000 syscalls por ciclo idle".
Acceptance: the daemon's sleep loop resolves the state root once per iteration and
hands it to the coalesced refresh/gs-scan probes; a handed-in directory is never
re-resolved. The state-dependent rule ("the dir holding a known file wins") stays
dynamic — a permanent global memo that freezes a decision the filesystem can still
change is NOT acceptable. Amendments recorded in L4 scope S3 to the daemon only.

S4 — The state-dir resolver must exist once.
Quote: "El resolver de state-dir está triplicado byte a byte … Los comentarios **prometen**
que se mantengan idénticos". Acceptance: `lib/state-dir.js` is the single implementation,
required by `lib/perf-trace.js`, `lib/gentle-sidebar.js` and
`herdr-plugin/lib/gentle-diagnostics.js`; the known-file family, owned dir names and
resolution order are byte-identical to today; the one real divergence
(`gentle-diagnostics.js:113` `path.resolve(injected)` vs `perf-trace.js:141` raw `injected`)
is reconciled explicitly and covered by a test, not silently unified. The full existing
suite still passes, including `tools/state-dir-known-files.test.js`.

S5 — Dead transcript aggregate must go.
Quote: "`aggregateChanges` … no tiene ni un llamador. Con él quedan inalcanzables
`patchLineCounts`, `sameSnapshot`, `snapshotPatchText`, `unavailableReason`,
`safePatchPath`, `isPlausibleEvidence` … y son **el único uso** de `generateUnifiedPatch`".
Acceptance: `aggregateChanges` and its six unreachable helpers are deleted, the
`generateUnifiedPatch` import is removed, and every test that stubbed that import line by
regex is updated so the suite is green. No live path may reference the removed symbols.

S6 — Publish dedupe must not build and stringify the full token patch first.
Quote: "se construye el objeto de 71 claves (`lib/gentle-tokens.js:1162`) y se
`JSON.stringify`ea **antes** de comparar con `lastSent`". Acceptance: a cheap change
signature over the reduced scalars is compared first and `displayTokens` + stringify run
only when it differs; a pane whose reduced display is unchanged publishes exactly as
before (zero socket writes), and a pane whose display changed still publishes the same
token set as today.

## Tasks

- T1 — S1 — inline — bound PRESENCE_ACTIVITY_LIMIT + test
- T2 — S2 — inline — moshiSendEnvelope destroy timer + test
- T3 — S3 — inline — memo sidebarEffectiveDir, per-frame stateRoot, concurrent gs scan + tests
- T4 — S4 — inline — extract lib/state-dir.js, rewire three modules + parity test
- T5 — S5 — inline — delete aggregateChanges block and import, fix test stubs
- T6 — S6 — inline — cheap signature before displayTokens + test

## Log

L1 (verbatim, human): "quier que hagas una review del proyecto buscando puntos de mejoras en legibilidad, refactor y principalmente en optimizacion. SI ya esta bien o el cambi es insifigante lo mencionas en el reporte"

L2 (verbatim, human): "Bien, arranca con todo en el orden que recomiendas"

L4 (decision, after implementation evidence): S3 was narrowed to the daemon. Two of
its three original sub-items were dropped because their premises did not survive a
bounded re-read of the code:
- `sidebarEffectiveDir()` memo: my own review called its inputs "static", which is
  wrong — the resolution reads the filesystem ("the dir holding a known file wins"),
  so a cache either freezes a decision that can still change or needs a TTL staleness
  window. Payoff: ~10-20 syscalls per 15 s beat. Rejected: a staleness window on a
  publish gate is a worse trade than 15 syscalls.
- `scanGsPanes` fan-out: the ≤64 pane probe is a rare roster-triggered scan, and the
  per-frame `gsBeat` set is `held`, typically 0-2 panes. Rejected: adds concurrency to
  a write-adjacent loop to save tens of milliseconds on a rare path.

L5 (decision, T4 rejected): the state-dir extraction was dropped after reading all three
copies. Evidence: there are FIVE copies, not three, and they live in three separate
shipping units — the npm package (`lib/perf-trace.js`, `lib/gentle-sidebar.js`), the
`herdr-plugin/` install unit, and `extensions/gentle-herdr-state.ts`, whose own test
forbids relative imports ("single-file deployment boundary"). A shared `lib/state-dir.js`
cannot be required from the other two units without breaking what they ship. The drift
risk the extraction was meant to remove is already enforced:
`tools/state-dir-known-files.test.js` reads `STATE_KNOWN_FILES` out of every consumer's
source and fails on divergence. Extracting only the two `lib/` copies would weaken that
source-reading guard for the two most used resolvers while leaving the dangerous
cross-unit divergence untouched. The copies have already diverged in two real ways, and
both are recorded as a separate finding for the human, not silently unified here:
`gentle-diagnostics.js` honours `LOCALAPPDATA` on win32 and `path.resolve`s the
`GENTLE_STATUS_STATE_DIR` / `HERDR_PLUGIN_STATE_DIR` overrides, while the other four
copies do neither.

L3: Review delivered read-only; three explore passes plus parent verification of the
highest-impact claims. One reported finding was rejected as a performance issue
(`lib/perf-trace.js` per-event state-dir resolution) because `createFrameObserver` and
`traceSession` have no production caller — reframed as dead code, not fixed here.
