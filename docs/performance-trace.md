# Performance trace (S18/S24)

The trace is a JSONL log of what a Pi session cost. It is switched on by ONE
environment variable, never from the UI:

```bash
GENTLE_PERF_TRACE=1 pi          # or: export GENTLE_PERF_TRACE=1
```

`GENTLE_PERF_TRACE` is ON only when it is exactly `1` or `true`. Every other
value — absent, empty, `0`, `false`, `TRUE`, `yes`, anything else — leaves the
trace OFF. The check reads the environment and nothing else: it probes no file,
writes nothing, and cannot throw.

The log is written by the parts of this package that can actually observe
themselves. Nothing here instruments Pi's own renderer. Every line is stamped
with a **run id**, so sessions can be told apart and compared afterwards with
`herdr-plugin/bin/gentle-perf-report.js`.

## Turning it on and reading it

1. Export the variable for the Pi process you want to measure:

   ```bash
   export GENTLE_PERF_TRACE=1
   ```

2. Run Pi and use the session as you normally would. The sidebar daemon this
   package ships inherits the same variable, so both write into the same log.

3. Read the report at any time — it only reads the log:

   ```bash
   node herdr-plugin/bin/gentle-perf-report.js
   ```

4. To stop tracing, start Pi without the variable. Existing records are never
   modified or deleted: `perf-trace.jsonl` and its rotated generation stay until
   the next traced run rotates them.

A second run is traced the same way. Changing the variable requires a new Pi
process — it is read from that process's environment, not from a settings file —
which is exactly what makes two runs comparable: each one is a separate process
with its own run id.

## What a run is

A **run** is one Pi process. Every record carries `run`, a short id made of the
process id and six random bytes, assigned by the writer itself: a caller cannot
override it, and a rotated log holding two sessions still groups correctly. The
`session` snapshot additionally identifies the run:

| field | meaning |
| --- | --- |
| `pid` | the process id, bounded to `1..4194304` |
| `uptimeMs` | `process.uptime()` in milliseconds, bounded to `0..1e10` |
| `tuiMode` | `fullscreen` or `regular`, **read** from `settings.json`; absent when that file cannot be read or holds no valid mode |

The tui mode is read through `readHostValues()` in `lib/host-settings.js`, a
read-only window on Pi's settings file with **no write path at all**: the trace
never edits host configuration. A mode that cannot be read is left out rather
than guessed, and a comparison then says the modes differ.

## What the trace records — and what it cannot

Five event kinds, one JSON object per line:

| kind | fields | what it measures |
| --- | --- | --- |
| `session` | `piVersion`, `pid`, `uptimeMs`, `tuiMode` | the identity of the run |
| `render` | `view`, `ms`, `width`, `height`, `rows` | **only** one frame of one of **this package's** views: the component's own `render()` duration and its size. No view records this kind any more (the worktree, warp, ODD and issues readers were removed); older logs keep theirs |
| `observer` | `view`, `frame`, `measuredAppends`, `prevAppendMs`, `hostFullRedrawsState`, `hostRenderMsState`, `hostFullRedraws`, `hostFullRedrawsDelta`, `processLoopState`, `processLoopUtilization`, `processLoopActiveMs`, `processLoopIdleMs`, `processLoopWindowMs` | the context one traced frame cannot answer on its own: what the trace writes cost, what the public host counter did, and how busy the Node event loop was |
| `resource` | `frames`, `rssMB`, `heapUsedMB`, `heapTotalMB`, `externalMB`, `cpuUserMs`, `cpuSystemMs`, `windowMs`, `cpuPercent` | the Pi **process** cost: memory and CPU consumed, sampled at an interval |
| `daemon` | `ms`, `panes`, `tokens` | one sidebar-daemon frame: its duration, the owned panes it reduced, and how many token names it published |

### `render.ms` is the component, not the host and not the trace

`ms` is the wall time inside that view's own `render()` call, measured with
`process.hrtime.bigint()` and rounded to three decimals. It excludes Pi's
renderer, input handling, terminal writes and the trace's own append, so it is
not a full-TUI frame time and no package timing is ever relabelled as one.

### `observer`: the cost of measuring, kept out of the measurement

A write cannot report its own duration without inventing it, so the append cost
is **trailing**: each `observer` sample reports `prevAppendMs`, the measured cost
of the *previous* frame's writes (the `render` line, the `observer` line, and the
`resource` line when that frame wrote one), and `measuredAppends` says how many
writes that covers (`0` on the first sample, so `prevAppendMs` is absent rather
than a fabricated `0`). A traced frame therefore writes two lines, plus the
`resource` line when a sample is due:

- `hostFullRedraws` — the **counter** read from the public root host object
  (`hostTui.fullRedraws`), with `hostFullRedrawsState` describing how it was
  obtained: `declared` (a finite number was read), `absent` (the host object was
  inspected and does not expose it), `unknown` (the host could not be inspected:
  missing object, or a getter that threw). `hostFullRedrawsDelta` is the change
  since the previous sample; it is a count difference, never a duration.
- `hostRenderMsState` — whether a **full-host render duration** is available.
  `pi-tui` 1.4's public host surface (`dist/tui.d.ts`: `fullRedraws`,
  `renderNow`, `requestRender`, `addInputListener`) publishes no render-duration
  observer, so this is `absent` for an inspectable host and `unknown` for one
  that could not be read. Measuring a full Pi frame duration needs a **public
  hook in the core** (an exported last-frame duration or a render-observer
  callback); until then this trace says honestly that the number does not exist
  instead of deriving one from the redraw counter.
- `processLoop*` — a bounded **process-level** metric from public
  `node:perf_hooks` (`performance.eventLoopUtilization()`): the delta between two
  samples gives `processLoopActiveMs`, `processLoopIdleMs`, `processLoopWindowMs`
  (the interval the sample covers) and `processLoopUtilization` (active /
  window, `0..1`), with `processLoopState` saying how much that is worth:
  `declared` (a positive interval was measured, the numbers follow) or `unknown`
  (no elapsed window yet, sampler failure, backwards readings, an excessive
  interval or empty data). Zero bootstrap samples prove neither missing support
  nor healthy 0% load; later advancing samples can become `declared`.
  The first sample of a session only establishes the baseline. It is
  process-level between two traced frames — not a component render, not a host
  frame, and not per-frame latency. `monitorEventLoopDelay()` would report real
  loop delay but needs a running interval timer, and the trace never adds a
  timer.

A frame whose `render` line is not written (trace off, unresolved state dir,
write failure) writes no `observer` line and reads neither the host counter nor
the event loop, so nothing is sampled for a frame the log cannot describe.

### `resource`: the Pi process cost

The observer samples the process itself with public Node APIs only:

- the first traced frame writes a **baseline** immediately, so even a short run
  has a starting point;
- afterwards at most one sample per `resourceIntervalMs` (default `1000` ms) is
  written, and `frames` counts the traced frames since the previous sample;
- `rssMB`, `heapUsedMB`, `heapTotalMB` and `externalMB` come from
  `process.memoryUsage()` converted to MB and rounded to `0.1`;
- `cpuUserMs` and `cpuSystemMs` are the **cumulative** `process.cpuUsage()`
  readings in milliseconds rounded to `0.1` — how much CPU this process has used
  since it started, which is what a run summary reports as its CPU total;
- `windowMs` is the wall time the sample covers, and `cpuPercent` is
  `100 * ((userDelta + systemDelta) / 1000) / windowMs` over that window,
  rounded to `0.1`. Both appear only from the second sample on: the baseline has
  no preceding reading, so it has no window and no percentage.

Every value is bounded (memory `0..100000` MB, CPU `0..1e9` ms, percentage
`0..100000`, window `0..3600000` ms), so a nonsense clock or a hostile host
cannot put a `10^12` number — or a negative one — into a log a user may share.
A sampler that throws or returns nonsense contributes **no field at all** for
that sample: absent is honest, an invented `0` would be averaged later as a real
measurement. `sampleMemory` and `sampleCpu` are injectable through the observer
options so tests are deterministic; the defaults are guarded calls to
`process.memoryUsage()` and `process.cpuUsage()`.

Nothing is sampled while the trace is off, and nothing is sampled for a frame
whose write — including the `observer` line — failed: the sample is anchored to
a frame the log already describes.

**Limits, stated plainly:**

- This measures **this package's views, its own tracing cost and the Pi
  process**. It does **not** measure Pi's transcript rendering, terminal writes
  or input handling, so it cannot show that the TUI itself got faster.
- `render`/`observer`/`resource` were recorded by the view and snapshot
  instrumentation that used to live in `extensions/gentle-worktree-tools.ts`.
  That extension is gone, so a current run records no `render`, `observer`,
  `resource` or `session` line; the daemon frame, the report CLI and the
  reader stay, and older logs remain fully readable.
- The trace itself costs something, and two or three lines per traced frame are
  part of that cost. `prevAppendMs` exists so the cost is visible in the same
  log it inflates; it is the package's own write cost, never a Pi measurement. A
  reproducible isolated experiment (below) compares an observer-on frame with an
  observer-off frame **inside this package** and must not be read as full-Pi
  performance.

## Comparing two runs

The comparison is a read-only CLI over the log, so no Pi restart and no
re-running is needed after both sessions happened:

```bash
node herdr-plugin/bin/gentle-perf-report.js          # table per run + comparison
node herdr-plugin/bin/gentle-perf-report.js --json   # runs, warnings, comparison
```

It reads `perf-trace.1.jsonl` (older) and `perf-trace.jsonl` (current) from the
same resolved state directory as the writer, groups the records by `run`, prints
one summary per run — what each run cost — and compares the **last two** runs. It
exits `0` when the trace was read (also when it holds no complete run yet), `1`
when no log exists — with the exact path it looked for — and `2` for invalid
arguments. It writes nothing, calls nothing and never reads the live settings.

What it cannot use is reported as a warning instead of being silently skipped:
lines that are not JSON, truncated stubs, records without a run id (written
before run identity existed), unknown kinds, and render records naming a view
this package does not write. A log written before run identity existed therefore
holds no complete runs, and the report says exactly that instead of inventing a
session from unlabeled lines.

A comparison is only made when all three comparability guards pass; every failing
guard is named with its evidence, and no deltas are printed for an incomparable
pair:

| reason | what it means |
| --- | --- |
| `different-pi-version` | the two runs are not the same Pi build |
| `different-tui-mode` | a `fullscreen` run is not comparable with a `regular` one (also when one run has no recorded mode) |
| `insufficient-frames` | a run has fewer than `MIN_FRAMES` = `30` traced frames, too few to average |

When every guard passes, the verdict is `conclusive` and the deltas name: the
mean render ms of each view, mean append ms, mean event-loop utilization, RSS
delta and RSS at the end of the run, and CPU total and CPU per traced frame.
**These are this package's own view renderings plus process cost.** A host
renderer duration is not among them and will not be until Pi exposes a public
hook for it.

## Files

Both live in the plugin state directory, the same one the other Gentle flags
use (`GENTLE_STATUS_STATE_DIR`, else the Herdr-injected
`HERDR_PLUGIN_STATE_DIR` when it already holds our files, else
`$XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents`, else
`~/.local/state/herdr/plugins/herdr-gentle-agents`):

- `perf-trace.jsonl` — the current log, rotated to `perf-trace.1.jsonl` when it
  would pass 256 KiB. Exactly one previous file is kept.

Nothing else is created: there is no switch file, no marker and no lock. A
session started without `GENTLE_PERF_TRACE=1` creates neither the log nor the
state directory.

## Privacy

Every event is reduced to the per-kind allowlist above before it is written, and
`run` is assigned by the writer from its own module constant, so no caller can
replace it. The trace never records prompt text, tool output, file contents,
rendered lines, paths, pane ids, issue titles, credentials or tokens —
`daemon.tokens` is a count, not the names, and `tuiMode` is one of two fixed
strings. A line that would exceed 2 KiB is replaced by a truncated stub that
says so (keeping `at`, `kind` and `run`), so an oversized event is visible as a
loss rather than silently dropped.

## Measuring the observer's own overhead

The observer cost is measurable without claiming anything about Pi: run the same
in-process frame loop twice, once with tracing OFF (no wrapper, no clock read, no
write per frame) and once with the frame observer writing to a scratch state
directory, and compare microseconds per frame. Report it as **this package's
trace overhead** — two trace write paths (including the environment check,
serialization and append) plus a host-counter and `eventLoopUtilization` read per
traced frame — never as full-TUI performance.
Keep both runs in a fresh system temp directory and delete it afterwards; a
cached or committed result is meaningless because the number depends on the disk
and the filesystem journal.

## Measured limits of the current metrics (evidence, not a claim)

From one isolated run in this repository's worktree, on the Node runtime in use
(`node v26.8.1`):

- The initial synchronous probe returned `{ idle: 0, active: 0 }`; that alone
  cannot establish unsupported ELU. A follow-up through real event-loop turns
  measured an advancing interval of about `10.158 ms` active after a 10 ms busy
  loop. The trace records zero-window samples as `unknown` and positive intervals
  as `declared`; neither probe measures full-host rendering.
- The public root host object exposes `fullRedraws` (a count) but no
  render-duration observer, so **full-host frame duration is unsupported**. It
  needs a public core hook — an exported last-frame duration or a render
  observer — before any full-Pi timing can be compared.
- An isolated in-process frame loop (same component work, trace off versus
  trace on, 4000 frames, scratch state directory) showed the package's own
  tracing overhead at roughly `+0.018 ms/frame` at p50 (`0.018` vs `0.000`).
  That number is **this package's write cost on this disk**, measured once, not
  a benchmark of Pi.

## Where the code lives

- `lib/perf-trace.js` — the activation check, the allowlist, the run id, the
  writer, the session snapshot (including pid/uptime/tui mode) and the per-frame
  observer (host capability probe, event-loop interval, trailing append cost,
  process resource samples).
- `lib/perf-analyze.js` — the pure reader: `analyzeLog(text)` per-run summaries
  and `compareRuns(a, b)` with its three comparability guards. No fs, no clock.
- `lib/host-settings.js` — the read-only tui-mode reader. It has no write path.
- `extensions/gentle-herdr-state.ts` — does not trace: the producer publishes
  Herdr tokens and Moshi notifications only.
- `herdr-plugin/bin/gentle-perf-report.js` — the read-only report CLI.
- `herdr-plugin/bin/gentle-status.js` — the daemon frame event, gated by the
  same environment variable.
