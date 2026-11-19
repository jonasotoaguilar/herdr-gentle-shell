# perf-review-fixes

Remediates the findings of a read-only review of herdr-gentle-shell (readability,
refactor, optimization). Six units, in the order the review recommended and the
human accepted. Three landed, one landed narrowed, two were rejected with evidence
(see L4 and L5). No behavior changes beyond the two bounds in S1 and S2.

## Specs

S1 — Presence activity read must be bounded to a size the writer can actually reach.
Quote from the review, accepted verbatim: "`PRESENCE_ACTIVITY_LIMIT = 16 * 1024 * 1024` …
Cada beat (15 s) hace `opendirSync` … y `JSON.parse` … **Este es el único hallazgo de
performance con potencial de molestar de verdad**: 16 MB de lectura + parse bloquean el
loop cientos de milisegundos". Acceptance: the limit is lowered to a bounded value
proportional to real usage (a small multiple of `PRESENCE_HEADER_LIMIT`), the existing
guards stay, and a test pins that an oversized activity file is rejected exactly like the
other bounded reads (never partially parsed, never throws). Existing behavior for a
file at or below the limit is unchanged. DONE: 256 KiB.

S2 — A Moshi envelope must never hold a socket forever.
Quote: "`moshiSendEnvelope` no tiene timeout … si el daemon acepta y nunca manda FIN de
vuelta, el fd queda en FIN_WAIT_2 para siempre". Acceptance: every envelope gets a
bounded destroy timer that is unref'd and cleared on close, the promise always settles,
`moshiInFlight` always drains, and no unhandled rejection is produced when the socket is
destroyed mid-flight. Sending to an absent or healthy Moshi daemon behaves exactly as today.
DONE: 2000 ms.

S3 — Repeated state-root resolution must not re-run per call.
Quote: "`stateRoot()` sin cache en el daemon … ~1000 syscalls por ciclo idle".
Acceptance: the daemon's sleep loop resolves the state root once per iteration and
hands it to the coalesced refresh/gs-scan probes; a handed-in directory is never
re-resolved. The state-dependent rule ("the dir holding a known file wins") stays
dynamic — a permanent global memo that freezes a decision the filesystem can still
change is NOT acceptable. Narrowed to the daemon in L4.

S4 — The state-dir resolver must exist once. REJECTED, see L5.
Quote: "El resolver de state-dir está triplicado byte a byte … Los comentarios
**prometen** que se mantengan idénticos". Rejected because the copies live in separate
shipping units and the parity is already test-enforced; the real divergences found are
recorded as a finding for the human, not unified silently.

S5 — Dead transcript aggregate must go.
Quote: "`aggregateChanges` … no tiene ni un llamador. Con él quedan inalcanzables
`patchLineCounts`, `sameSnapshot`, `snapshotPatchText`, `unavailableReason`,
`safePatchPath`, `isPlausibleEvidence` … y son **el único uso** de `generateUnifiedPatch`".
Acceptance: `aggregateChanges` and its six unreachable helpers are deleted, the
`generateUnifiedPatch` import is removed, and every test that stubbed that import line by
regex is updated so the suite is green. DONE.

S6 — Publish dedupe must not build and stringify the full token patch first.
Quote: "se construye el objeto de 71 claves (`lib/gentle-tokens.js:1162`) y se
`JSON.stringify`ea **antes** de comparar con `lastSent`". Acceptance: a cheap change
signature over the reduced scalars is compared first and `displayTokens` + stringify run
only when it differs; a pane whose reduced display is unchanged publishes exactly as
before (zero socket writes), and a pane whose display changed still publishes the same
token set as today. DONE.

## Tasks

- T1 — S1 — bound PRESENCE_ACTIVITY_LIMIT + test — done
- T2 — S2 — moshiSendEnvelope destroy timer + test — done
- T3 — S3 — daemon state-root resolved once per loop iteration + test — done
- T3b — S3 — memo sidebarEffectiveDir — dropped (L4)
- T3c — S3 — concurrent gs scan — dropped (L4)
- T4 — S4 — extract lib/state-dir.js — rejected (L5)
- T5 — S5 — delete aggregateChanges block and import, fix test stubs — done
- T6 — S6 — cheap signature before displayTokens + test — done

### Evidence

| Task | Commit | Verified by |
| --- | --- | --- |
| T1/S1 | 09ca851 | suite pins the bound from both sides: a fully populated 128-task envelope still reads, past the ceiling yields no snapshot |
| T2/S2 | 09ca851 | a stuck peer (allowHalfOpen, never closes) reproduced RED at 8 s, GREEN at the 2 s bound |
| T3/S3 | 10d7bf0 | marker probes consume a handed-in dir with zero resolution syscalls; full suite 851/851 |
| T4/S4 | rejected (L5) | five copies across three shipping units; parity already enforced by tools/state-dir-known-files.test.js |
| T5/S5 | ba52804 | 132 lines + the only package import removed; full suite 853/853 |
| T6/S6 | de2911e | equivalence property over a variant table; the one non-collapsible case (empty vs absent label) pinned |

Slice boundary: the four commits total ~624 authored lines, past the ~400-line review
slice. Delivery shape (one PR, or T1-T3 then T5 then T6 as a chain) is a human decision
at publish time.

## Log

L1 (verbatim, human): "quier que hagas una review del proyecto buscando puntos de mejoras
en legibilidad, refactor y principalmente en optimizacion. SI ya esta bien o el cambi es
insifigante lo mencionas en el reporte"

L2 (verbatim, human): "Bien, arranca con todo en el orden que recomiendas"

L3: Review delivered read-only; three explore passes plus parent verification of the
highest-impact claims. One reported finding was rejected as a performance issue
(`lib/perf-trace.js` per-event state-dir resolution) because `createFrameObserver` and
`traceSession` have no production caller — reframed as dead code, not fixed here.

L4 (decision, S3 narrowed): two of S3's three original sub-items were dropped because
their premises did not survive a bounded re-read of the code:
- `sidebarEffectiveDir()` memo: the review called its inputs "static", which is wrong —
  the resolution reads the filesystem ("the dir holding a known file wins"), so a cache
  either freezes a decision that can still change or needs a TTL staleness window. Payoff:
  ~10-20 syscalls per 15 s beat. Rejected: a staleness window on a publish gate is a worse
  trade than 15 syscalls.
- `scanGsPanes` fan-out: the <=64 pane probe is a rare roster-triggered scan, and the
  per-frame `gsBeat` set is `held`, typically 0-2 panes. Rejected: adds concurrency to a
  write-adjacent loop to save tens of milliseconds on a rare path.

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
cross-unit divergence untouched.

L6 (new finding, not fixed — needs a human decision): the five copies have already
diverged in two real ways. `herdr-plugin/lib/gentle-diagnostics.js` honours
`LOCALAPPDATA` on win32 and `path.resolve`s both `GENTLE_STATUS_STATE_DIR` and
`HERDR_PLUGIN_STATE_DIR`; the other four do neither. With a RELATIVE
`GENTLE_STATUS_STATE_DIR`, the daemon and the readers therefore resolve to different
files depending on each process's cwd. Fixing it is a behavior change in five files and
was not part of this authorized scope.
