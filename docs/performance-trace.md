# Performance trace (S16/S16a/S18)

`/herdr-gentle:customize` → **Performance** → **Performance trace** turns on a
JSONL log so a run with the optimizations OFF can be compared with a run with
them ON. It is **OFF by default**.

The switch is a small flag file, and the log is written by the parts of this
package that can actually observe themselves. Nothing here instruments Pi's own
renderer. Every line is stamped with a **run id**, so sessions can be told apart
and compared afterwards with `herdr-plugin/bin/gentle-perf-report.js`.

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

The tui mode is read through `readHostValues()` in `lib/pi-perf-settings.js`,
with the same settings-path resolution as the writer and **no write path at all**:
the trace never edits host configuration. A mode that cannot be read is left out
rather than guessed, and a comparison then says the modes differ.

## What the trace records — and what it cannot

Five event kinds, one JSON object per line:

| kind | fields | what it measures |
| --- | --- | --- |
| `session` | `piVersion`, `perf`, `support`, `pid`, `uptimeMs`, `tuiMode` | the four-switch snapshot in effect, whether the installed Pi package declares each setting, and the identity of the run |
| `render` | `view`, `ms`, `width`, `height`, `rows` | **only** one frame of one of **this package's** views (`warp`, `odd`, `issues`, `create`, `detail`): the component's own `render()` duration and its size |
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

The switches are supposed to move process cost, so the observer samples the
process itself with public Node APIs only:

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

Nothing is sampled while the trace is disabled, and nothing is sampled for a
frame whose write — including the `observer` line — failed: the sample is
anchored to a frame the log already describes.

**Limits, stated plainly:**

- This measures **this package's views, its own tracing cost and the Pi
  process**. It does **not** measure Pi's transcript rendering, so it cannot
  show that a Pi optimization made the TUI faster. `heightIndex`,
  `evictOffscreenLines`, `expandRecentToolOutput` and
  `incrementalSearchCorpus` are Pi settings; this package only writes them.
- All four switch settings currently exist **only on the Pi build
  `perf/fullscreen-long-sessions`** (upstream branch, in no tag and not in
  `main`). On a released Pi build the keys are accepted and ignored, so `perf`
  still records them faithfully while the running Pi does nothing with them;
  `support` is what shows that. A comparison of two runs on such a build is
  comparing nothing, and the report says the snapshot is identical only when the
  switches really are the same — a differing snapshot on a build that ignores
  them proves nothing either.
- `support` is **evidence, not a verdict**. `declared` means some shipped file
  of the installed Pi package mentions the setting; `absent` means the whole
  package was inspected and nothing mentions it; `unknown` means the scan could
  not look (no package, unparsable metadata, file/byte budget, unreadable
  path). A minified bundle could rename a setting internally while still
  reading it, so `absent` never means "this optimization does not work", and no
  keyword scan proves execution or speedup.
- A missing setting in `settings.json` is the OFF default and is recorded as
  `false`, so two runs are comparable field by field.
- `render`/`observer`/`resource` cover warp, creation and the fullscreen ODD,
  Issues and worktree-detail readers. They do not cover the customize panel
  itself.
- The trace itself costs something, and two or three lines per traced frame are
  part of that cost. `prevAppendMs` exists so the cost is visible in the same
  log it inflates; it is the package's own write cost, never a Pi measurement. A
  reproducible isolated experiment (below) compares an observer-on frame with an
  observer-off frame **inside this package** and must not be read as the effect
  of a switch on full-Pi performance.

## Comparing two runs

The comparison is a read-only CLI over the log, so no Pi restart and no
re-running is needed after both sessions happened:

```bash
node herdr-plugin/bin/gentle-perf-report.js          # table per run + comparison
node herdr-plugin/bin/gentle-perf-report.js --json   # runs, warnings, comparison
```

It reads `perf-trace.1.jsonl` (older) and `perf-trace.jsonl` (current) from the
same resolved state directory as the writer, groups the records by `run`, prints
one summary per run and compares the **last two** runs. It exits `0` when the
trace was read (also when it holds no complete run yet), `1` when no log exists
— with the exact path it looked for — and `2` for invalid arguments. It writes
nothing, calls nothing and never reads the live settings.

What it cannot use is reported as a warning instead of being silently skipped:
lines that are not JSON, truncated stubs, records without a run id (written
before run identity existed), unknown kinds, and render records naming a view
this package does not write. A log written before run identity existed therefore
holds no complete runs, and the report says exactly that instead of inventing a
session from unlabeled lines.

A comparison is only made when all four comparability guards pass; every failing
guard is named with its evidence, and no deltas are printed for an incomparable
pair:

| reason | what it means |
| --- | --- |
| `different-pi-version` | the two runs are not the same Pi build |
| `identical-perf-snapshot` | both runs recorded the same four switches, so nothing was switched between them (or one run has no snapshot at all) |
| `different-tui-mode` | a `fullscreen` run is not comparable with a `regular` one (also when one run has no recorded mode) |
| `insufficient-frames` | a run has fewer than `MIN_FRAMES` = `30` traced frames, too few to average |

When every guard passes, the verdict is `conclusive` and the deltas name: the
mean render ms of each view, mean append ms, mean event-loop utilization, RSS
delta and RSS at the end of the run, and CPU total and CPU per traced frame.
**These are this package's own view renderings plus process cost.** A host
renderer duration is not among them and never will be until Pi exposes a public
hook for it.

### Running an A/B comparison by hand

1. Turn **Performance trace** ON. The snapshot for the run is written
   immediately, so no restart is needed.
2. Leave tracing **ON** for **both** runs. Turning it off for the baseline
   would make the two runs incomparable — the whole point is one switch at a
   time.
3. Run once with the four optimization rows OFF (their default).
4. Turn the rows ON and run again. Every switch change writes a new `session`
   snapshot, so each run in the log is identified by the snapshot before it.
5. Run `herdr-plugin/bin/gentle-perf-report.js` and read the verdict. Turn
   tracing OFF when you are done. The log is kept, not deleted.

## Files

Both live in the plugin state directory, the same one the other Gentle flags
use (`GENTLE_STATUS_STATE_DIR`, else the Herdr-injected
`HERDR_PLUGIN_STATE_DIR` when it already holds our files, else
`$XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents`, else
`~/.local/state/herdr/plugins/herdr-gentle-agents`):

- `gentle-perf-trace.json` — `{ "version": 1, "enabled": true|false }`. A
  missing, malformed or unreadable flag means **disabled**; the panel refuses to
  overwrite a flag it cannot parse instead of guessing.
- `perf-trace.jsonl` — the current log, rotated to `perf-trace.1.jsonl` when it
  would pass 256 KiB. Exactly one previous file is kept.

The panel always shows the real log path, and reports a write failure or a
no-change honestly instead of claiming the switch moved.

## Privacy

Every event is reduced to the per-kind allowlist above before it is written, and
`run` is assigned by the writer from its own module constant, so no caller can
replace it. The trace never records prompt text, tool output, file contents,
rendered lines, paths, pane ids, issue titles, credentials or tokens —
`daemon.tokens` is a count, not the names, and `tuiMode` is one of two fixed
strings. A line that would exceed 2 KiB is replaced by a truncated stub that
says so (keeping `at`, `kind` and `run`), so an oversized event is visible as a
loss rather than silently dropped.

## Cross-process behaviour

The panel (in Pi) writes the flag; the daemon is a separate process. The daemon
re-reads the flag on every frame, so toggling the trace takes effect on the next
frame with no daemon restart. In-process reads are cached against the flag
file's identity (inode, size, mtime), so a write from another process is noticed
too.

## Measuring the observer's own overhead

The observer cost is measurable without claiming anything about Pi: run the same
in-process frame loop twice, once with tracing OFF (no wrapper, no clock read, no
write per frame) and once with the frame observer writing to a scratch state
directory, and compare microseconds per frame. Report it as **this package's
trace overhead** — two trace write paths (including flag checks, serialization
and append) plus a host-counter and `eventLoopUtilization` read per traced frame —
never as full-TUI performance.
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
  a benchmark of Pi and not evidence that any switch speeds the TUI up or down.

## Where the code lives

- `lib/perf-trace.js` — the flag, the allowlist, the run id, the writer, the
  session snapshot (including pid/uptime/tui mode) and the per-frame observer
  (host capability probe, event-loop interval, trailing append cost, process
  resource samples).
- `lib/perf-analyze.js` — the pure reader: `analyzeLog(text)` per-run summaries
  and `compareRuns(a, b)` with its four comparability guards. No fs, no clock.
- `lib/pi-perf-support.js` — the installed-Pi scan behind `support`.
- `lib/pi-perf-settings.js` — the settings writer and `readHostValues()`, the
  read-only tui-mode reader.
- `lib/customize-perf-rows.js` — the panel rows, including the trace option.
- `extensions/gentle-worktree-tools.ts` — the session snapshot hook and the
  frame observer wired around the view factories (`perfTraceView`); with the
  trace off it returns the component unwrapped.
- `herdr-plugin/bin/gentle-perf-report.js` — the read-only report CLI.
- `herdr-plugin/bin/gentle-status.js` — the daemon frame event.
