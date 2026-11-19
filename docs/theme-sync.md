# Theme sync (Herdr palette follows the active Pi theme)

Herdr's palette follows the theme active in Gentle Shell / Pi, or one theme
pinned while the sync is off. This page covers the switch, the one state file,
the managed `[theme]` block, the writer CLI and the limits. Protocol context is
in [DESIGN.md](../DESIGN.md) §12; the switch is described beside the sidebar and
Moshi switches in [README.md](../README.md).

## The switch

`/herdr-gentle:customize` → `Herdr Theme` holds two rows. The row's note and
the extension's refusal carry the same words, so the panel and the apply path
cannot tell you different things.

- `Theme sync` is a pill toggle and is **OFF by default**. `On` makes Herdr's
  palette the palette of the theme Pi is showing, and it follows a change of
  the active theme while Pi keeps running. Turning the sync off stops following and leaves
  Herdr with the palette it already has: nothing is removed from Herdr's
  config, so the last applied palette survives Pi closing.
- `Gentle Shell theme` is the card's only non-toggle row (`Select…`): it opens
  the host's theme list plus the unassign entry `Off (no theme assigned)`, which shifts
  by a numeric suffix if a theme literally carries that spelling. It is painted dim, denied the selection
  band and refused while the sync is on, with
  `Turn Theme sync off to pick a specific theme.` Picking `Off` clears the pin
  (`theme: null`); picking a name stores it. The stored pin is carried across a
  sync toggle untouched, so turning the sync off restores that choice instead of
  unassigning it.
- Esc, a cancelled menu, an unknown argument and a host without
  `getAllThemes()` all write nothing. The plain two-step menu stays as the
  fallback when the TUI helpers or `ctx.ui.custom` are unavailable, and offers
  the same two rows.

The notices are fixed strings:

| Action | Notice |
| --- | --- |
| Sync turned on | `Theme sync on; Herdr's palette follows the theme active in Pi.` |
| Sync turned off | `Theme sync off; Herdr keeps the palette it was last given.` |
| Toggle already in that state | `Theme sync already on/off; nothing was changed.` |
| Theme row while the sync is on | `Turn Theme sync off to pick a specific theme.` |
| Theme assigned | `Gentle Shell theme set to <name>.` |
| Pin cleared | `Gentle Shell theme set to Off; Herdr keeps the palette it was last given.` (the stored value and the row read `Off`; only the picker entry is spelled `Off (no theme assigned)`) |
| Host exposes no theme list | `Could not read Pi's theme list (this host exposes no getAllThemes()); nothing was changed.` |
| Theme store missing | `Could not reach the theme store (lib/theme-store.js is unavailable); nothing was changed.` |
| State file not writable | `Could not write the theme store: <detail>; nothing was changed.` |

`/herdr-gentle:customize status` prints one read-only line and writes nothing:

```text
customize status: sidebar=<on|off|unknown> moshi=<on|off> theme-sync=<on|off|unknown> theme=<name|none|unknown>
```

## State file

One document is the only persisted truth: `gentle-theme.json`.

```json
{
  "sync": true,
  "theme": null,
  "updatedAt": "2026-09-19T10:00:00.000Z"
}
```

It lives in the directory `gentle-moshi.json` already uses: `GENTLE_STATUS_STATE_DIR`
when set, else `$XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents` (else
`~/.local/state/herdr/plugins/herdr-gentle-agents`), unless the stored
directory holds no file of ours and the newer `herdr-gentle-shell` directory
does — then that one is used. `sync` is the switch, `theme` is the pinned name
or `null`, and `updatedAt` is stamped by the writer — a caller cannot record a
timestamp it made up. Writes are atomic (temporary file in the same directory,
then rename), preserve an existing file's mode and create a new one as `0600`.

- **Missing file** is an inert document (`sync: false`, `theme: null`): a fresh
  install writes nothing, so nothing is what it reads.
- **Unreadable or unparsable file** is a refusal, never a guess: the sync row
  reads `Unknown`, no theme name is shown, and the follower does nothing. It is
  written over only when you act — toggling the sync writes a fresh document,
  and the pinned-theme row is refused only by a *stored* `sync: true`.
- **`sync: false` with `theme: null`** is the default install: the follower
  spawns nothing, writes nothing and removes nothing (S7).
- A blank or non-string `theme` normalises to `null`; nothing is trimmed into a
  theme name that no install has.

## What gets written

The writer owns one marker-delimited block in Herdr's config
(`$HERDR_CONFIG_PATH`, else `<XDG_CONFIG_HOME>/herdr/config.toml`, else
`~/.config/herdr/config.toml`; `%APPDATA%\herdr\config.toml` on Windows):

```toml
# BEGIN herdr-gentle-theme (managed; do not edit)
[theme]
name = "one-dark"

[theme.custom]
accent = "#89b4fa"
text = "#cdd6f4"
red = "#f38ba8"
green = "#a6e3a1"
subtext0 = "#7c7f93"
overlay0 = "#7c7f93"
overlay1 = "#9399b2"
mauve = "#cba6f7"
yellow = "#f9e2af"
blue = "#89b4fa"
teal = "#94e2d5"
# END herdr-gentle-theme
```

The hex values above are illustrative; the token set, their order and the base
theme name are not. Tokens are emitted in Herdr's own order (`accent`, `text`,
`red`, `green`, `subtext0`, `overlay0`, `overlay1`, `mauve`, `yellow`, `blue`,
`teal`) and lower-cased, so the same palette always renders the same bytes and a
re-apply of the same palette is a no-op (`current`, no write, no reload). A
`[theme.custom]` table is omitted entirely when no token survives conversion:
an empty table would still be an override.

The projection is exactly `HERDR_ROLE_SOURCES` in `lib/theme-projection.js`:

| Herdr token | Pi theme token |
| --- | --- |
| `accent` | `accent` |
| `text` | `text` |
| `red` | `error` |
| `green` | `success` |
| `yellow` | `warning` |
| `blue` | `mdLink` |
| `teal` | `syntaxType` |
| `subtext0` | `muted` |
| `overlay0` | `muted` |
| `overlay1` | `thinkingText` |
| `mauve` | `borderAccent` |

`muted` paints two Herdr surfaces on purpose: they are converted once and always
emitted together, never half-applied. Herdr's surface tokens — `sidebar_bg`,
`panel_bg`, `active_row_bg`, `selection_bg`, `surface0`, `surface1`,
`surface_dim` — and `peach` are **never written**: backgrounds and status
colours stay with the Herdr base theme (`one-dark`) because a Pi theme names
foregrounds and accents, not panel surfaces, and a guessed background would
paint a colour nobody chose. A Pi token that is empty (Pi's "terminal default",
which has no hex spelling) or that does not convert to `#rrggbb` is dropped for
that apply; the rest of the palette still lands.

The block is a *second* managed block, distinct from the sidebar override's
`herdr-gentle-agents` block, with its own backup file
`<config>.herdr-gentle-theme.bak`. The two writers share no marker bytes and no
backup, so each can only ever rewrite its own block.

## The writer CLI

```bash
node herdr-plugin/bin/configure-theme.js [--apply | --remove | --check] [--reload] [--json]
```

`--apply` is the default verb. It reads a payload on stdin
(`{"theme":{"name":"<herdr-theme>","custom":{"<token>":"#rrggbb"}}}`); the Pi
follower sends exactly that, and a terminal stdin (no pipe) reads as "no
payload". Accepted names are `catppuccin`, `terminal`, `tokyo-night`, `dracula`,
`nord`, `gruvbox`, `one-dark`, `solarized`, `kanagawa`, `rose-pine`, `vesper`;
accepted tokens are the nineteen in
`herdr-plugin/lib/gentle-theme-config.js` `CUSTOM_TOKENS`.

| Verb | Meaning |
| --- | --- |
| `--apply` | Validate the payload and write (or repair) the managed block. |
| `--remove` | Remove the managed block; absent means nothing to do, and a foreign table is left alone. |
| `--check` | Read-only: `0` when the block is present and current, or absent, `1` when it is stale, `2` when refused. Never writes. Without a payload it round-trips the block on its own; a block that does not match the rendered form is `stale`. |
| `--reload` | Run `herdr server reload-config` — only after a write. |
| `--json` | One JSON line on stdout (`op`, `status`, `file`, `theme`, `changed`, plus `reloaded` under `--reload` and `error` on a refusal) instead of a sentence. |

Exit codes: `0` applied/current/removed/absent (and `--check` current or
absent), `1` `--check` found a stale block **or** a requested reload failed
after a successful write, `2` refused or bad argv. A payload or config refusal
prints exactly one `configure-theme: …` line on stderr, in every output mode
(an argv error adds the usage block), and it **guarantees no write, no reload
and config bytes unchanged**. Node 18 or newer is required; older runtimes exit
`1` before reading anything.

## Refusals

Every one of these exits `2` with the config untouched:

- **A `[theme]` or `[theme.custom]` table outside the markers** is user config:
  `refusing --apply: a [theme] or [theme.custom] table already exists outside
  the managed markers. This tool only manages its marked block; move or delete
  that table, then re-run.` It is never adopted, merged or overwritten. A bare
  `theme = …` key inside another table is a different key path and is not
  matched.
- **Malformed markers** — a lone begin, a lone end, end before begin, or a
  second pair — refuse instead of guessing where the block ends:
  `refusing --<verb>: managed theme markers are malformed (unterminated); fix
  them manually.`
- **An unknown theme name**, an unknown custom token, a non-`#rrggbb` value, an
  extra top-level key or an unknown `theme` key:
  `refusing malformed payload: …`, naming the exact problem.
- **No payload** for `--apply`, or invalid JSON on stdin.
- **An unreadable or unwritable config**: `cannot read <file>: …`, or
  `write failed, original untouched: …`.
- **Argv**: an unknown flag, or more than one verb
  (`choose exactly one of --apply, --remove, --check`).

`--remove` on a config with no managed block is `absent` and exits `0` even when
a foreign `[theme]` table exists: there is nothing of ours to take away, and an
uninstall must not touch user config.

## Failure modes and notices

The Pi follower (`extensions/herdr-theme-sync.ts`) applies the palette; it never
reports success, only failures:

- **Plugin root unresolvable** — no `herdr plugin list --json` match, an
  ambiguous or non-absolute root, or no `bin/configure.js` there — notifies
  once per session: `Could not apply the palette to Herdr: <reason> The palette
  Herdr has was left untouched.` and retries on later ticks silently.
- **Assigned theme not installed** — `ctx.ui.getTheme(name)` returns nothing —
  notifies once per session: `The Pi theme "<name>" is not installed, so Herdr's
  palette was left unchanged; pick an installed theme in /herdr-gentle:customize.`
  A later install of that exact theme is picked up without a restart.
- **CLI failure** — non-zero exit, a spawn failure or a start error — notifies
  `Could not apply the palette to Herdr: configure-theme exited <status>[: <last
  stderr line>]` (or `<script> could not start (<detail>)`), once per distinct
  message. A success clears the memo, so the same refusal after a good apply is
  reported again. The last stderr line is capped at 300 characters.
- **A failed apply is never retried automatically.** The observation is recorded
  *before* the spawn, so the next tick acts only on a new palette (or a new
  failure text). One apply is in flight at a time, and a spawn is capped at 60 s.
- **A theme whose colours cannot be read at all** skips the tick instead of
  stripping Herdr's custom block: an unreadable palette is not evidence that you
  have no palette.

## Environment

- `HERDR_CONFIG_PATH` — the config file the writer edits and reports.
- `XDG_CONFIG_HOME` — default config directory (`<xdg>/herdr/config.toml`) when
  `HERDR_CONFIG_PATH` is unset.
- `HERDR_BIN_PATH` — Herdr binary (default `herdr`) for `plugin list --json`
  (plugin-root lookup) and `server reload-config` (the optional reload).
- `GENTLE_HERDR_PLUGIN_ROOT` — skip the `plugin list` lookup and name the
  installed plugin root directly (isolated runs).
- `GENTLE_STATUS_STATE_DIR` — state directory override for `gentle-theme.json`
  and every other file this package writes there.
- `GENTLE_THEME_SYNC_LIB_DIR` — the directory the follower requires
  `theme-store.js` and `theme-projection.js` from (defaults to this package's
  `lib/`).
- `GENTLE_CUSTOMIZE_LIB_DIR` — the directory the state sidecar loads the panel
  and the theme store from, so the switch and the follower read the same files.

## Limits

- **The observation tick is 500 ms**, because the host publishes no
  theme-change event: the palette is a pull-read of `ctx.ui.theme`, evaluated
  once immediately on session start and then every 500 ms. A change is noticed
  within one tick, and a theme recoloured in place (same name, new colours) is
  caught by the palette fingerprint, not only by its name. The timer is
  unreferenced, so an idle follower never keeps Pi alive.
- **Not proven against a live Pi TUI.** The automated evidence is a stubbed Pi
  host plus a real CLI stand-in on disk; no live-TUI run is recorded.
  `ctx.ui.theme`, `getTheme()`, `getAllThemes()`, `select()` and `notify()` are
  used as the host documents them, and a host that lacks one degrades to
  "nothing changed" rather than a guess.
- **Herdr keeps the last applied palette** when Pi closes: nothing on shutdown
  writes, removes or reloads. Backgrounds and status colours stay with the Herdr
  base theme, so the sync recolours a sidebar's text and accent surfaces, not
  the whole app chrome.
- **One machine.** A Herdr client on another host reads its own `config.toml`;
  the sync is local to the machine where Pi runs. There is no pane gate either:
  a Pi session started outside a Herdr pane still updates the config.
- **No automatic repair.** A `[theme]` table you also maintain by hand outside
  the markers is never reconciled — the writer refuses until you move or delete
  it. Managed markers you edit by hand become "malformed" and stop the writer
  until they are fixed.

## Implementation

| File | Role |
| --- | --- |
| `lib/theme-store.js` | The state document: directory resolution, normalized read, atomic write. |
| `lib/theme-projection.js` | The pure projection: theme names, token order, `HERDR_ROLE_SOURCES`, `projectPalette`, `paletteFingerprint`, the `Off` label. |
| `extensions/herdr-theme-sync.ts` | The follower: tick, fingerprint, one `configure-theme.js --apply --json --reload` per change, once-per-failure notices. |
| `extensions/gentle-herdr-state.ts` | The switch: `applyThemeSync`, `applyThemeSelection`, `customize status`. |
| `lib/customize-panel.js` | The `Herdr Theme` category and its two rows. |
| `herdr-plugin/lib/gentle-theme-config.js` | Payload validation, the managed block, refusals, backup and reload. |
| `herdr-plugin/bin/configure-theme.js` | The CLI verbs, exit codes and output modes. |
