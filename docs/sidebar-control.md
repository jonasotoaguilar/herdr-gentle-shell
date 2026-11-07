# Sidebar control (`node bin/gentle-sidebar.js`)

Switch the Herdr Agents-panel integration between OUR sidebar and the native
Herdr sidebar. This controls sidebar wiring only, never Pi subagent execution.

```bash
node bin/gentle-sidebar.js (enable|disable|status|toggle) [--json]
```

Exit codes: `0` success, `1` operational failure, `2` usage failure. The
isolated form points every path at temp files:

```bash
GENTLE_STATUS_STATE_DIR=/tmp/s PI_CODING_AGENT_DIR=/tmp/a \
HERDR_CONFIG_PATH=/tmp/c.toml node bin/gentle-sidebar.js status
```

| Verb | Meaning |
| --- | --- |
| `enable` | Use OUR sidebar. |
| `disable` | Use the NATIVE sidebar. |
| `status` | Report the current mode; writes nothing. |
| `toggle` | Flip to the other mode. |

## What enable and disable do

- **Enable (ours):** resolves the installed plugin root through the
  read-only `herdr plugin list` lookup, runs that install's
  `bin/configure.js --apply --reload` synchronously, and re-reads the
  Herdr config to verify the managed pi-only rows are present. Only then
  it records the plugin-owned exclusion of the native integration
  (`-extensions/herdr-agent-state.ts` in the Pi `settings.json`
  `extensions` list, with the ownership marker from the installer) and
  writes the shared mode file
  (`gentle-sidebar-mode.json`, `{version:1,enabled:true}`). A zero exit
  alone never commits state: without the verified row effect the apply
  fails with mode and exclusion unchanged.
- **Disable (native):** same proof in reverse (`--uninstall`, rows must
  be absent), then removes only the plugin-owned exclusion (a
  pre-existing user entry and any foreign/misbound record are preserved)
  and writes `{version:1,enabled:false}` so the producer stops publishing
  and the native sidebar renders again.

Unrelated settings, user exclusions, and the user-owned
`[ui.sidebar.agents]` table are never touched. The native base file is
never read, written, or deleted.

## Reload rule

Row changes apply to Herdr through the synchronous configure run. The Pi
settings exclusion and the native sidebar only take effect on the next
extension load, so a running Pi session needs `/reload` after a switch —
success is reported once the managed-row effect is verified, never on a
queued acceptance.

## Mode file

Shared flag under the existing resolved state directory
(`$GENTLE_STATUS_STATE_DIR`, else the Herdr plugin state dir):
`gentle-sidebar-mode.json` containing exactly
`{version:1,enabled:boolean}`. Missing means **enabled** (current
installs keep working with no file). A malformed file is reported, never
silently treated as enabled, and the disabled producer publishes nothing:
no gentle tokens, no native `report_agent`/`report_agent_session`
claims, no `herdr:blocked` labels. The daemon gate and clear live with
the lifecycle owner (`herdr-plugin/bin/gentle-status.js`); the producer just stops.

## Recovery

Every failure names the recoverable next step: fix the cause, then
re-run the same verb to converge. Completion runs before any local
mutation, so a failed configure leaves mode and exclusion untouched; if
rows were stranded by a failed reload they are restored through the
marker-scoped reverse operation (only our own markers are ever removed,
so user tables and concurrent edits outside them survive). If the mode
file itself cannot be written after the rows already flipped, the message
says exactly that. When the ownership
record names another entry or another settings file, resolve it
manually (delete the record or the entry) — neither verb adopts it.

## Implementation

`bin/gentle-sidebar.js` is the CLI; `lib/gentle-sidebar.js` holds the
contract (mode file, owned exclusion through
`lib/pi-extension-exclusion.js`, and the installed plugin's
`bin/configure.js` with the same rollback discipline). The Pi producer
extension reads only the mode file, so the switch and the producer never
disagree about which sidebar is active.
