# Performance trace (S16/S16a)

`/herdr-gentle:customize` → **Performance** → **Performance trace** turns on a
JSONL log so a run with the optimizations OFF can be compared with a run with
them ON. It is **OFF by default**.

The switch is a small flag file, and the log is written by the parts of this
package that can actually observe themselves. Nothing here instruments Pi's own
renderer.

## What the trace records — and what it cannot

Three event kinds, one JSON object per line:

| kind | fields | what it measures |
| --- | --- | --- |
| `session` | `piVersion`, `perf`, `support` | the four-switch snapshot in effect and, per key, whether the installed Pi package declares that setting |
| `render` | `view`, `ms`, `width`, `height`, `rows` | one frame of one of **this package's** views (`warp`, `odd`, `issues`, `create`) |
| `daemon` | `ms`, `panes`, `tokens` | one sidebar-daemon frame: its duration, the owned panes it reduced, and how many token names it published |

**Limits, stated plainly:**

- This measures **this package's views and its sidebar daemon**. It does **not**
  measure Pi's transcript rendering, so it cannot show that a Pi optimization
  made the TUI faster. `heightIndex`, `evictOffscreenLines`,
  `expandRecentToolOutput` and `incrementalSearchCorpus` are Pi settings; this
  package only writes them.
- `support` is **evidence, not a verdict**. `declared` means some shipped file
  of the installed Pi package mentions the setting; `absent` means the whole
  package was inspected and nothing mentions it; `unknown` means the scan could
  not look (no package, unparsable metadata, file/byte budget, unreadable
  path). A minified bundle could rename a setting internally while still
  reading it, so `absent` never means "this optimization does not work", and no
  keyword scan proves execution or speedup.
- A missing setting in `settings.json` is the OFF default and is recorded as
  `false`, so two runs are comparable field by field.
- `render` covers the create **and** edit panel (one component). It does not
  cover the customize panel itself.

## Running an A/B comparison

1. Turn **Performance trace** ON. The snapshot for the run is written
   immediately, so no restart is needed.
2. Leave tracing **ON** for **both** runs. Turning it off for the baseline
   would make the two runs incomparable — the whole point is one switch at a
   time.
3. Run once with the three optimization rows OFF (their default).
4. Turn the rows ON and run again. Every switch change writes a new `session`
   snapshot, so each run in the log is identified by the snapshot before it:
   the last `session` line before a `render`/`daemon` line describes the
   switches that were in effect.
5. Turn tracing OFF when you are done. The log is kept, not deleted.

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

Every event is reduced to the per-kind allowlist above before it is written. The
trace never records prompt text, tool output, file contents, rendered lines,
paths, pane ids, issue titles, credentials or tokens — `daemon.tokens` is a
count, not the names. A line that would exceed 2 KiB is replaced by a truncated
stub that says so, so an oversized event is visible as a loss rather than
silently dropped.

## Cross-process behaviour

The panel (in Pi) writes the flag; the daemon is a separate process. The daemon
re-reads the flag on every frame, so toggling the trace takes effect on the next
frame with no daemon restart. In-process reads are cached against the flag
file's identity (inode, size, mtime), so a write from another process is noticed
too.

## Where the code lives

- `lib/perf-trace.js` — the flag, the allowlist, the writer, the session
  snapshot.
- `lib/pi-perf-support.js` — the installed-Pi scan behind `support`.
- `lib/customize-perf-rows.js` — the panel rows, including the trace option.
- `extensions/gentle-worktree-tools.ts` — the session snapshot hook and the
  render wrappers around the four view factories.
- `herdr-plugin/bin/gentle-status.js` — the daemon frame event.
