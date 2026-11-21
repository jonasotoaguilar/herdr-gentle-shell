# Theme sync (Herdr palette follows the active Pi theme)

Herdr's palette follows the theme active in Gentle Shell / Pi, or one theme
pinned while the sync is off. This page covers the switch, the one state file,
what the writer puts in your own `config.toml`, the refusals, the notices and
the limits. Protocol context is in [DESIGN.md](../DESIGN.md) §12; the switch is
described beside the sidebar and Moshi switches in [README.md](../README.md).

The writer runs **in process, inside this Pi package**:
`extensions/herdr-theme-sync.ts` calls `lib/herdr-theme-apply.js`, which plans
with `lib/herdr-theme-config.js` and rewrites the config file itself. **The
Herdr plugin is not involved in theme sync and needs no update for it.** The
1.8.0 design spawned a `bin/configure-theme.js` shipped by the *separately
installed* plugin, so a Pi-only update kept running the old plugin's writer, and
an install that never shipped that file broke the feature outright. Both halves
of that dependency are gone: there is no plugin-side `configure-theme.js`, no
plugin-side planner and no 1.8.0 managed block.

## The switch

The whole feature is two settings: `Theme sync` and `Select theme`. They are
served on whichever customize surface is live for the session — one surface,
never both: on the `Herdr` page of Gentle Shell's own `/gentle:customize` menu
when gentle-shell-bridge answers its handshake (its
`gentle-shell-bridge/api/v1` object is published on `globalThis`), and in
`/herdr-gentle:customize` → `Herdr Theme` when it does not, laid out like the
rest of the card (see [Panel](#panel)). The page's rows come from the same
model and the same apply path, so everything below holds on either:

- `Theme sync` is **OFF by default**. `On` makes Herdr's palette the palette of
  the theme Pi is showing, and it follows a change of the active theme while Pi
  keeps running. Turning the sync off stops following and leaves Herdr with the
  palette it already has: nothing is removed from Herdr's config, so the last
  applied palette survives Pi closing.
- `Gentle Shell theme` assigns one Gentle Shell / Pi theme by name from Pi's own
  list (`None` first, then the host's order). While the stored sync is on the
  setting is painted dim, never given the selection band, and pressing Enter on
  it writes nothing: the apply path refuses with
  `Turn Theme sync off to pick a specific theme.` Choosing `None` clears the pin
  (`theme: null`); choosing a name stores it. The stored pin is carried across a
  sync toggle untouched, so turning the sync off restores that choice instead of
  unassigning it.

Esc closes the card without writing, and the plain two-step menu stays as the
fallback when the TUI helpers or `ctx.ui.custom` are unavailable.

The notices are fixed strings:

| Action | Notice |
| --- | --- |
| Sync turned on | `Theme sync on; Herdr's palette follows the theme active in Pi.` |
| Sync turned off | `Theme sync off; Herdr keeps the palette it was last given.` |
| Toggle already in that state | `Theme sync already on/off; nothing was changed.` |
| Theme setting while the sync is on | `Turn Theme sync off to pick a specific theme.` |
| Theme assigned | `Gentle Shell theme set to <name>.` |
| Pin cleared | `Gentle Shell theme set to Off; Herdr keeps the palette it was last given.` (the stored value stays `null` and the inline list marks `None`; only this notice — and the `Off (no theme assigned)` entry of the fallback menu and of the Gentle Shell page — spell it `Off`) |
| Host exposes no theme list | `Could not read Pi's theme list (this host exposes no getAllThemes()); nothing was changed.` |
| Theme store missing | `Could not reach the theme store (lib/theme-store.js is unavailable); nothing was changed.` |
| State file not writable | `Could not write the theme store: <detail>; nothing was changed.` |

`/herdr-gentle:customize status` prints one read-only line and writes nothing.
The subcommand belongs to the command — the surface without the bridge; the
menu page offers no `status` operation:

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
- **Unreadable or unparsable file** is a refusal, never a guess: the sync
  setting marks no option and carries `state unknown; Enter turns the sync on`,
  the theme list marks nothing, and the follower does nothing. It is
  written over only when you act — toggling the sync writes a fresh document,
  and the theme setting is refused only by a *stored* `sync: true`.
- **`sync: false` with `theme: null`** is the default install: the follower
  asks for no palette at all, so nothing is written, nothing is reloaded and
  nothing is removed (S7).
- A blank or non-string `theme` normalises to `null`; nothing is trimmed into a
  theme name that no install has.

## What gets written

The writer edits **your own** `[theme]` and `[theme.custom]` tables in place, in
the config at `$HERDR_CONFIG_PATH`, else `<XDG_CONFIG_HOME>/herdr/config.toml`,
else `~/.config/herdr/config.toml`. The planner is a **line splicer, not a TOML
validator**: it finds table boundaries (a header only counts at a real line
start — never inside a multi-line string, a multi-line array, an inline table or
a comment) and treats every line outside those two tables as **opaque bytes**.
Those lines are never validated and never rewritten — the scanner only looks at
them far enough to know where a table starts and ends — so invalid TOML there is
your pre-existing breakage: Herdr already refuses to load such a file, and this
writer's only promise is that it does not touch those lines. Inside the two theme
tables it is strict (see [Refusals](#refusals)).

Everything it does not own is preserved byte for byte: other tables and keys,
comments, blank lines, ordering, indentation, spacing around `=`, trailing
comments on a rewritten line, CRLF or mixed line endings, a leading UTF-8 BOM
and a missing final newline. Before returning a plan the writer **enforces a
splice invariant in code**: the non-theme lines of its own output must be
byte-identical to the input's (plus at most the single line terminator needed to
append a table after an unterminated last line). A mismatch is an internal
error, never a silent edit.

There are exactly **two ownership classes**, and they are what make leaving a
theme safe:

**1. A value you already had is replaced in place** and remembered. One comment
line recording **the whole original line** goes directly above it — the first
original wins, so a later palette change reuses that comment instead of
stacking a second one:

```toml
[theme]
# herdr-gentle-shell: was name = "catppuccin"
name = "one-dark"

[theme.custom]
# herdr-gentle-shell: was accent = "#7aa2f7" # mine, keep the blue
accent = "#bb9af7"
```

The marker records the original line minus its indentation, so trailing spaces
and an inline comment are part of the record; restoring puts those bytes back
exactly — with one exception: **the latest edit wins**. If you changed the
inline comment after the planner wrote its value, a restore keeps the recorded
key/value and **your current trailing comment**, not the stale one the marker
remembers. A comment is only a marker when that text parses as a strict
`key = <string> [comment]` line naming the key under it (`# herdr-gentle-shell:
was blue = aba`, or a payload carrying a number, is your comment and stays as
it is). The marker may sit anywhere in the comment block directly above the key,
so a comment of your own in between does not produce a second one, and two
markers for the same key are a refusal. A value that already equals the
projection is not rewritten and gets no comment at all. Literal (single-quoted)
values and basic (double-quoted) values are compared by their decoded meaning —
basic strings are escape-decoded, literal strings are exactly the characters
between their quotes, so `'\u0023123456'` is not the colour `#123456`.

**2. A token you did not have lives in ONE marked block** at the end of
`[theme.custom]`, in Herdr's token order, regenerated on every plan:

```toml
# herdr-gentle-shell: begin
text = "#c0caf5"
subtext0 = "#565f89"
# herdr-gentle-shell: end
```

The closing line has one more spelling:
`# herdr-gentle-shell: end after a missing line ending`. The planner writes it
when placing the block also **added the file's missing final line ending** to
the line above it (an unterminated last line). The text alone cannot tell
whether that terminator was yours, so the block records the fact, and a later
clear takes back **only what the planner added** — never a byte you wrote.

When the planner also has to **create** the `[theme.custom]` table, the opening
line says so — `# herdr-gentle-shell: begin created` — and the table it created
is **removed again** when the block empties and the table holds nothing else, so
a cycle of projections ending in an empty custom projection gives your original
`[theme.custom]` back byte for byte (a `[theme]` table the planner created keeps
its `name` line: see [Limits](#limits)). A `[theme.custom]` header **you** wrote
is never removed, even when it ends up empty.

Removing or moving a block is refused when a comment **directly above** `begin`
would become adjacent to the token key under the block and would read as a
marker for it — `line N: ambiguous herdr-gentle-shell marker above the managed
block; no changes proposed.` Your ordinary comment stays the user's text; the
planner refuses instead of silently promoting it to ownership on the next run.

A block whose bytes already match the palette it needs is left where it is; one
that has to be rewritten is placed after the last key of `[theme.custom]`, or
right after its header when the table has no keys of its own (or at the end of
the file, creating the table, when `[theme.custom]` does not exist yet). Inside
the block only `<token> = "#rrggbb"` lines are allowed; anything else there — a
comment, a blank line, a malformed value — is a **refusal**, because rewriting
the block would delete bytes a human wrote.

**Leaving a projection never leaves a stale colour.** The plan reconciles
against what the previous palette owned:

- a token you had (so it carries our marker) that the new projection no longer
  carries — or carries again with the value the marker records — is **restored
  from that marker byte for byte** and the marker is dropped: your original
  line, quoting, spacing, trailing spaces and inline comment included (unless you
  edited that trailing comment since — see the exception above);
- a token that only ever lived inside our block simply disappears with the
  block, and when nothing is left to own, the block is removed entirely;
- a token you own with no marker is **never touched**, even when the projection
  stops carrying it: it was never ours.

Two more rules, stated because they are visible in the file:

- An **empty `[theme.custom]` header stays** unless the planner created it (see
  above): it cannot otherwise prove the line is its own, and deleting a line you
  may have written is a bigger intervention than this switch promises.
- A token that appears both in our block and as your own key in the same
  `[theme.custom]` table is a **refusal**: duplicate keys in one table are not
  valid TOML, so the planner refuses instead of picking a winner. Delete the
  block line to own that token yourself.

A key the plan must touch has to be a **strict single-line** form (see
[Refusals](#refusals)); a key it does not touch is left alone as long as the
scanner can tell where that line ends, so an untargeted multi-line value keeps
working. `name` is set to Herdr's base theme (`one-dark`) on the existing line,
or inserted right after the `[theme]` header when the table has none.
`auto_switch = false` is accepted and left untouched; every other `auto_switch`
value is a refusal.

### The golden example

This is the user's real config shape from the planner's test suite: an existing
`[theme]` with `auto_switch = false`, a `[theme.custom]` synced from DMS/Niri
that carries tokens the projection does not own (`panel_bg`, `blue`, `yellow`)
and a `[terminal]` table we have no business in. Applying the projection
`{name: "one-dark", custom: {accent, text, red, green, subtext0, overlay0,
overlay1, mauve}}` produces exactly these bytes (also asserted as valid TOML by
the suite's `python3 -m tomllib` oracle):

```toml
onboarding = false

[theme]
name = "catppuccin"

auto_switch = false
[theme.custom]
# TokyoNight Night and Moon — synced from DMS/Niri (source: ~/.config/DankMaterialShell/themes/tokyoNightNightMoon/theme.json)
panel_bg = "#1a1b26"
accent = "#7aa2f7"
green = "#9ece6a"
blue = "#7aa2f7"
red = "#f7768e"
yellow = "#e0af68"

[terminal]
new_cwd = "follow"
```

becomes:

```toml
onboarding = false

[theme]
# herdr-gentle-shell: was name = "catppuccin"
name = "one-dark"

auto_switch = false
[theme.custom]
# TokyoNight Night and Moon — synced from DMS/Niri (source: ~/.config/DankMaterialShell/themes/tokyoNightNightMoon/theme.json)
panel_bg = "#1a1b26"
# herdr-gentle-shell: was accent = "#7aa2f7"
accent = "#bb9af7"
# herdr-gentle-shell: was green = "#9ece6a"
green = "#00ff00"
blue = "#7aa2f7"
# herdr-gentle-shell: was red = "#f7768e"
red = "#ff0000"
yellow = "#e0af68"
# herdr-gentle-shell: begin
text = "#c0caf5"
subtext0 = "#565f89"
overlay0 = "#565f89"
overlay1 = "#a9b1d6"
mauve = "#7dcfff"
# herdr-gentle-shell: end

[terminal]
new_cwd = "follow"
```

Note what did not move: `panel_bg`, `blue` and `yellow` keep their bytes,
`auto_switch = false` and the DMS/Niri comment are untouched, the replaced lines
keep their positions, and only the tokens the user did not have are in the block.
Re-running the same projection over this output is a **no-op**: `changed: false`,
no write, no backup, no reload.

### Projection

Exactly the eight Herdr tokens in `HERDR_ROLE_SOURCES`
(`lib/theme-projection.js`) come from Pi roles:

| Herdr token | Pi theme token |
| --- | --- |
| `accent` | `accent` |
| `text` | `text` |
| `red` | `error` |
| `green` | `success` |
| `subtext0` | `muted` |
| `overlay0` | `muted` |
| `overlay1` | `thinkingText` |
| `mauve` | `borderAccent` |

`muted` paints two Herdr surfaces on purpose: it is converted once and the pair
is always emitted together, never half-applied. On top of that come the
per-theme fixed surfaces in `DOTS_FIXED`, which are the palette the user's own
Herdr profiles already use:

| Pi theme | Fixed tokens |
| --- | --- |
| `Gentleman-Cute` | `panel_bg #000000`, `surface0 #241822`, `surface1 #342230`, `surface_dim #20161E`, `overlay0 #B99AA9` |
| `Gentleman-Sexy` | Cute's surfaces plus `subtext0 #FF4F9A`, `mauve #B99AA9`, `active_row_bg #2E0F1F`, `selection_bg #2E0F1F` |
| `Gentle` | `panel_bg #06080f` |

Values are lower-cased, and the block's tokens follow Herdr's own
`HERDR_TOKEN_ORDER`, so the same palette always renders the same bytes for the
same file. A token whose Pi source is empty (Pi's "terminal default", which has
no hex spelling), absent or not `#rrggbb` is omitted for that apply; the rest of
the palette still lands. The projection carries no `[theme.custom]` table at all
when no token survives conversion (an empty table would still be an override), and
the follower refuses to apply a projection with no concrete token (see
[Failure modes and notices](#failure-modes-and-notices)).

Working/done status colours and notification colours stay with Herdr's base
theme: `yellow`, `peach`, `blue`, `teal` and the surface tokens above are part
of Herdr's vocabulary but not of this projection, so a status the user never
asked to repaint keeps its native colour.

### Ownership

The reference implementation this follows is
[gentle-herdr](https://github.com/MarsSall/gentle-herdr) (MIT License,
Copyright (c) MarsSall); the guard matrix, bounded snapshot, compare-and-swap
and reload call are that project's logic ported to plain CommonJS, and the
projection follows its role table. This package deliberately differs in two
places: it accepts `auto_switch = false` (the reference refuses that line
outright, which is why the user's real config was never written), and **the sync
owns its projected tokens** and gives them back.

That ownership rule is the honest one to spell out: while the sync is on, or a
theme is pinned, the package owns the `name` line and every token it projects.
The `was` comments and the marked block exist for a clean revert, not for
arbitration. Another tool that rewrites the same keys — a desktop-theme sync
such as DMS/Niri writing `[theme.custom]`, for example — will overwrite them on
its next run, and the next palette change here will overwrite them back. A token
the package never projected is never written, never merged and never repaired.

### Safe write

Writing is bounded and staged: the target must be an absolute, canonical path
whose parent directory is not a symlink, a regular single-link file of at most
256 KiB, strictly valid UTF-8 (a leading BOM is decoded as part of the text, not
consumed, so a changed write keeps it). The plan is refused **before anything is
written** if the document would grow past the same 256 KiB limit — a file we
could read but not write back would make the next run refuse its own output —
with `Herdr config would grow to <bytes> bytes, past the 262144-byte limit; no
changes proposed.`
The bytes are re-read and compared (device, inode, size, mtime, ctime, mode,
contents) before the backup and again immediately before the swap.

The new text is staged at a path chosen **before the file exists**, so every
failure — open, write, `fsync`, `fchmod` — leaves the writer able to remove it.
The staged file is exclusive `0600`, `fchmod`-ed to the original mode (`0o7777`,
so setuid, setgid and sticky bits survive), compared once more, then `rename`d
over the target.

Temporary cleanup is best-effort **and reported**: the writer retries the unlink
once and then force-removes, and a `.tmp` file that survives is never hidden.
If the **backup's** temp survives, the apply fails with `Herdr backup temporary
could not be removed: <path>`, so it can never report `requested` with a stray
file beside your config; if the **staged** temp survives a failed replace, the
`partial`/`config` error ends with `; temporary file left behind: <path>`.

**Cleanup only ever touches a path this call created.** The temp names are
random, but if something else already owns that exact name, the exclusive open
fails with `EEXIST` and the writer does **not** delete it: the apply answers
`partial` with `stage: 'config'` and that `EEXIST` text, and the foreign file is
left exactly as it was (the config and the backup are untouched).

The one-time backup `<config>.herdr-gentle-shell.bak` is **published atomically
and never overwritten**: it is written to a temp name and then hard-linked to
the backup name, so a crash or a full disk leaves no truncated `.bak` that a
later run would mistake for "already backed up". A regular file that already
sits at the backup path — whether it was there before this run or appeared in
the race — **is** the existing backup: it is accepted as it is, never compared
and never overwritten (it may legitimately be an older original from before you
edited the config). A backup path that is not a real file (a directory, a
symlink, a socket) is a refusal with the config untouched.

`unchanged` writes nothing and reloads nothing: Herdr already holds that
palette. A real write is followed by exactly one `herdr server reload-config`
through `execFile` with `HERDR_BIN_PATH` (default `herdr`), no shell, a 5 s
timeout and a 4096-byte output cap. `forceReload` is the one exception: it
reloads even when the plan is unchanged, and it exists for repairing a config
whose previous reload failed (see the follower below). A missing `config.toml`
is not created — that is a refusal, not a bootstrap.

## Refusals

Every refusal means **no write, no backup, no reload and config bytes
unchanged**, and it names the line it saw:
`line <n>: <reason>; no changes proposed.` (The one internal check that has no
line — the splice invariant — says `internal splice invariant violated; no
changes proposed.`.)

### What the planner guarantees, and what it does not

It guarantees:

- **table boundaries** for documents whose multi-line strings, arrays and inline
tables are terminated — a header is only a header at a real line start, never
inside a multi-line string, a multi-line array, an inline table or a comment;
- **every byte outside `[theme]` and `[theme.custom]` preserved**, modulo the one
  line terminator needed to append a table after an unterminated last line, and
  modulo the 1.8.0 markers it wrote itself (below) — checked in code by the
  splice invariant before a plan is returned;
- **only the strict line forms below inside the two theme tables**;
- **CRLF or mixed line endings, a leading BOM and a missing final newline**
  survive, and planning is **idempotent and reversible** (a cycle of projections
  ending in an empty custom projection gives the original bytes back, apart from
  the `name` line a cycle cannot remove — see [Limits](#limits)).

It does **not** guarantee — deliberately, because this is not a TOML validator:

- **nothing is validated outside the theme tables**, escapes included: in a
  single-line or multi-line string there, a backslash is only consumed with the
  character after it, so `note = """x\q"""` is not a refusal (whether that escape
  is legal TOML is a parser's job), and a run of **three or more quotes closes a
  multi-line string** — the boundary scan does not judge the leftover quotes. The
  scan only validates escapes where it must read a value back: a quoted key and a
  theme-table line it parses strictly. **Values, dates, numbers, keys, duplicate
  keys, duplicate tables, dotted-key redeclarations and array-of-tables on other
  tables are not checked** either: an input that is already invalid there is left
  exactly as it is, because Herdr already refuses to load such a file and
  rewriting it was never this writer's job;
- a projected palette is checked for **shape only** (a known token, `#rrggbb`),
  never for Herdr's own semantics;
- the config is never locked (see [Limits](#limits)).

The **strict grammar inside the theme tables** is: comment lines, blank lines,
and `key = value [comment]` where the value is a **single-line** string
(basic or literal), boolean, integer or float. Where the plan must **touch** a
key (`name`, a projected token, a line the projection is leaving) anything else
is refused with its line number; a key the plan does **not** touch is left byte
for byte whenever the scanner can tell where that line ends, so an untargeted
`yellow = """reset"""` or a multi-line value keeps working.

### Accepted on purpose

These are the inputs a real config can carry, and the planner must not reject
them:

- a **leading UTF-8 BOM**: skipped while scanning, put back byte for byte;
- a **trailing comment on the last line of a file with no final newline** (the
  comment is not swallowed into the value);
- **anything outside the theme tables**, valid or not, is preserved: multi-line
  strings, arrays, inline tables, dates and numbers, `[ui] theme = "system"`, an
  unquoted dotted key (`theme.custom.accent = …` inside `[other]`). Only a
  `theme` key at the **top level** is a conflict. The scanner only has to *find*
  boundaries there: a header-shaped line must parse and a multi-line construct
  must be terminated, otherwise the plan refuses — that is boundary detection,
  not validation;
- **`auto_switch = false`**, byte-exact;
- **quoted spellings of the same thing**: `["theme"]` and `['theme']` are
  `[theme]`; `"name"` / `'accent'` are the same keys; a `\uXXXX` escape in a
  quoted key names the same key. **Quoted segments are literal**:
  `["theme.custom"]` is a *different* root key named `theme.custom` — exactly as
  TOML says — so it is never edited and never confused with our
  `[theme.custom]` table (splitting that dot was the 1.8.0 bug);
- **literal strings are never escape-decoded**: `'\u0023123456'` is that text,
  not the colour `#123456`; basic (double-quoted) strings are decoded.

### Refused

| Cause | Message text |
| --- | --- |
| `auto_switch` with any value but `false` | `` `auto_switch` is only supported as `auto_switch = false` `` |
| `dark_name` / `light_name` in `[theme]` | `` `<key>` in `[theme]` is not supported `` |
| Top-level `theme` key | ``a top-level `theme` key is user configuration`` |
| Dotted `theme.custom.<token>` key at the top level | ``a dotted `theme` key cannot be adopted safely`` |
| A dotted key extending a key the planner owns inside `[theme]` (`name`, `custom`, `auto_switch`, `dark_name`, `light_name`) | ``a dotted key extending `[theme]` cannot be adopted safely`` |
| A dotted key extending a Herdr token inside `[theme.custom]` | ``a dotted key extending `[theme.custom]` cannot be adopted safely`` |
| `[theme]` or `[theme.custom]` twice | `` `[theme]` appears more than once `` (same for `[theme.custom]`) |
| A third `[theme.*]` table | `` `[theme.x]` is not a table this writer owns `` |
| `[[theme]]` / `[[theme.custom]]` array-of-tables | `` `[[<path>]]` array-of-tables is not supported `` |
| `name` or `auto_switch` repeated in `[theme]`, a token repeated in `[theme.custom]` | `` `<key>` appears more than once in `[<table>]` `` |
| A token in our block that is also your key | `` `<key>` appears more than once in `[theme.custom]` `` |
| Two markers for the same key above it | ``duplicate herdr-gentle-shell marker for `name` `` (per token: ``duplicate herdr-gentle-shell marker for `<token>` ``) |
| `custom = …` inside `[theme]` | `` `custom` in `[theme]` must be a `[theme.custom]` table `` |
| `name` or a user-owned token the plan must touch, written in any form but a strict single-line string | `` `name` value is not a plain single-line string `` (per token: `` `<token>` value is not a plain single-line string ``) |
| A key the plan must touch whose value spans lines (a multi-line string or array) | ``cannot record the original value of `<key>` safely`` |
| A control character, or a bare carriage return | `unsupported control character` / `a bare carriage return is not a line ending` |
| The block outside `[theme.custom]`, unterminated, a second begin, or an end with no begin | ``the `# herdr-gentle-shell` block is outside `[theme.custom]` `` / ``… is not terminated`` / ``the `# herdr-gentle-shell: begin` line appears more than once`` / ``the `# herdr-gentle-shell: end` line has no matching begin`` |
| A line inside our block that is not `<token> = "#rrggbb"` (a comment, a blank line, a malformed value, an unknown token) | `unexpected content inside the herdr-gentle-shell block` |
| Removing or moving a block whose `begin` is directly under a marker-shaped comment that would become adjacent to the token key below | `ambiguous herdr-gentle-shell marker above the managed block` |
| A table header the scanner cannot parse, or one with trailing content | `unterminated table header`, `unsupported table header`, `trailing content after the table header`, `unterminated array-of-tables header`, `a quoted key must be on one line`, `unterminated quoted key`, `unsupported escape in a quoted key` |
| A multi-line string, array or inline table the scanner cannot close (anywhere — boundaries depend on it) | `unterminated string` / `unterminated array or inline table` / `mismatched bracket or brace` |

A malformed *projection* (a name outside Herdr's set, an unknown token, a value
that is not `#rrggbb`, an unknown top-level key) is refused the same way with
`Invalid Herdr theme projection: …; no changes proposed.` and no line number —
that one is a package bug, not something your config can cause. So is a
**splice-invariant violation**: the planner re-derives the non-theme lines of
its own output and refuses rather than return a document that moved a byte it
promised not to touch.

At the file level the remaining refusals are: a symlinked or non-canonical
config path, a symlinked parent directory, a directory, hardlink or oversize
file, invalid UTF-8, a backup path that is not a regular file, a config that
changed between the snapshot and the replacement (`Herdr config changed before
replacement`), a planned document past the 256 KiB limit, a backup temp that
cannot be removed, and a failed rename.

### The 1.8.0 marker pair

A config written by 1.8.0 may still carry
`# BEGIN herdr-gentle-theme (managed; do not edit)` and
`# END herdr-gentle-theme`. The planner drops them **only** when they are the
nearest pair (a nested BEGIN is matched to the END that closes it) **and** that
pair encloses a `[theme]` or `[theme.custom]` table; a stale pair around
unrelated keys is your text and stays untouched. A pair that closes on an
unterminated last line migrates too: the surviving last line keeps its own
terminator state, so the file does not gain or lose a final newline.

## Failure modes and notices

The follower (`extensions/herdr-theme-sync.ts`) never reports success of a
no-op, and every user-visible outcome is a fixed string:

- **Applied** — a write and its reload: `Herdr theme applied: <name>; reload requested`
  (`info`). This is only shown when *the user* changed something (the switch or
  the pinned theme, including the first evaluation of a session); a palette-only
  change while the sync is on is silent.
- **Herdr already has it** (`unchanged`): silent, and an earlier failure memo is
  cleared.
- **Not available** (`info`, once per session): `Herdr theme sync is inactive:
  this Pi session is not inside a Herdr pane.`, `Herdr theme sync is inactive:
  this is a remote session and Herdr reads its config on another machine.`, or
  `Herdr theme sync is not supported in this environment.`
- **Pinned theme not installed**: `The Pi theme "<name>" is not installed, so
  Herdr's palette was left unchanged; pick an installed theme in the Gentle
  Shell customize menu.` — once per session; a later install of that exact
  theme is picked up without a restart. The notice names the menu, not the
  command, because the pinned theme is offered on both surfaces.
- **Nothing to project**: `Herdr theme not applied: <theme name> has no concrete
  colours to project.` (`the active theme` replaces the name when the active
  theme exposes none) — once per session, `warning`. A palette with no concrete
  token would still rewrite the theme name and announce a success that painted
  nothing, so the follower applies nothing at all: the config is not touched
  (not even the `name` line).
- **Refused or not written**: `Herdr theme not applied: <reason>` — once per
  distinct failure text. A success clears the memo, so the same refusal after a
  good apply is news again.
- **Written but not reloaded**: `Herdr theme written; Herdr reload failed:
  <reason>. Run 'herdr server reload-config' to apply it.` — the reason is
  trimmed and terminated by the follower, so a child-process message that ends
  in a newline still reads as one sentence, and an empty reason collapses to
  `Herdr theme written; Herdr reload failed. Run 'herdr server reload-config' to
  apply it.` The config is committed and Herdr's state is unknown.

The reload notice is not just prose. `partial/reload` sets an **owed reload** for
the rest of the session: the next apply attempt is sent with `forceReload`, so
the reload happens even though the plan is then unchanged, and a success pays
the debt off. It is session memory on purpose (a tick never reloads while the
debt stands, so Herdr is not reloaded every 500 ms), which is exactly why the
notice names the command that repairs it by hand after a restart.

Silent by design: a store this package cannot read (nothing is written), a theme
whose palette cannot be read at all (the tick is skipped rather than writing an
empty projection), and a subagent child session (`GENTLE_PI_AGENTS_CHILD=1`),
which never registers the follower at all.

A failed apply is never retried automatically: the observation is recorded
*before* the apply, so the next tick acts only on a new palette or a new switch
value. One apply is in flight at a time.

### The follower

There is no theme-change event in the host, so the palette is a pull-read:

- One evaluation immediately on `session_start`, then one every **500 ms** on an
  unreferenced timer, so an idle follower never keeps Pi (or a scripted session)
  alive. The timer is cleared on `session_shutdown` (and a shutdown that lands
  during the first evaluation wins: no tick is armed afterwards), and the
  per-session memo — last requested switch value, last palette fingerprint, last
  failure, once-per-session notices, the owed reload — is reset at session start.
- Each evaluation computes two identities — the requested `[sync, chosen]` and
  the palette fingerprint `[theme name, sorted token/hex pairs]` — and applies
  only when one differs, so a theme recoloured in place (same name, new colours)
  is noticed without a restart.
- With the sync off and no theme pinned the follower asks for nothing at all
  **and forgets what it applied**. That reset is what makes **re-enabling the
  sync always re-apply**: without it, the next `On` would look unchanged (same
  switch, same palette) and a config you repaired in between would never be
  written. If the config already matches, the writer answers `unchanged` — no
  write, no reload, no notice.
- With the sync on it reads `ctx.ui.theme`; with a theme pinned it reads
  `ctx.ui.getTheme(<name>)` and writes the name it was given as the label.
- Availability (a Herdr pane, not a subagent child, not an SSH session, a
  supported local Linux Herdr) is decided once, by `applyHerdrTheme`, so the
  follower can never disagree with the writer about who may write.

## Environment

The availability guard, in order — every one of these is a `unavailable` result
and none of them reads the config:

- `HERDR_ENV=1` **and** a non-empty `HERDR_PANE_ID` **and** a non-empty
  `HERDR_SOCKET_PATH` are what make this a Herdr pane.
- `GENTLE_PI_AGENTS_CHILD=1` is a subagent child: refused by the writer *and*
  the follower is not registered.
- `SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` set is a remote session.
- `HERDR_BIN_PATH` must not be a `herdr-dev` build, the platform must be
  `linux`, and `HERDR_SOCKET_PATH` and the resolved config path must be
  absolute.

Paths and binaries:

- `HERDR_CONFIG_PATH` — the config file the writer edits.
- `XDG_CONFIG_HOME`, then `HOME` — default config directory
  (`<xdg>/herdr/config.toml`, else `~/.config/herdr/config.toml`).
- `HERDR_BIN_PATH` — Herdr binary (default `herdr`) for
  `server reload-config`.

Tests and isolated runs:

- `GENTLE_THEME_SYNC_LIB_DIR` — the directory the follower requires
  `theme-store.js`, `theme-projection.js` and `herdr-theme-apply.js` from
  (defaults to this package's `lib/`).
- `GENTLE_CUSTOMIZE_LIB_DIR` — the directory the state sidecar loads the panel
  and the theme store from, so the switch and the follower read the same files.
- `GENTLE_STATUS_STATE_DIR`, `XDG_STATE_HOME`, `HERDR_PLUGIN_STATE_DIR` — the
  state directory for `gentle-theme.json` and every other file this package
  writes there.

## Limits

- **Not proven against a live Pi TUI in this repository's tests.** The automated
  evidence is a stubbed Pi host plus a real binary stand-in on disk; no
  live-TUI run is recorded. `ctx.ui.theme`, `getTheme()`, `getAllThemes()`,
  `notify()` and the panel's host component contract are used as the host
  documents them, and a host that lacks one degrades to "nothing changed" rather
  than to a guess.
- **The compare-and-swap has one unavoidable window.** The config is compared
  immediately before the rename, so an edit that lands earlier — during the
  snapshot, the plan, the backup or the staging — is detected and the replace
  aborts with `Herdr config changed before replacement`. An edit that lands
  between that final compare and the `rename` itself **cannot be detected
  without holding a lock on the config**, which this writer deliberately does
  not do; the window is as small as a compare followed by a rename.
- **The planner is a splicer, not a validator** (see
  [What the planner guarantees](#what-the-planner-guarantees-and-what-it-does-not)):
  invalid TOML outside the theme tables is left exactly as it is — Herdr already
  refuses such a file, and this writer never repairs it — while a theme-table line
  it must touch has to be the strict single-line form. Boundary scanning refuses
  only constructs it cannot close (an unterminated multi-line string, array or
  inline table), because table boundaries depend on them; escapes outside the
  theme tables are never validated, and a run of three or more quotes closes a
  multi-line string.
- **A pre-existing truncated backup is kept, not repaired.** A regular file at
  the backup path is accepted as the existing backup and is never compared or
  overwritten — it may legitimately be an older original — so a `.bak` damaged by
  something else stays damaged, and the `was` comments are the per-value revert
  path.
- **Remote sessions are inactive.** In SSH the Herdr client reads the config of
  the machine it runs on, so writing the server-side file would change nothing
  on screen; the guard refuses and says so once.
- **Two writers of the same keys fight.** The sync owns what it projects, so a
  desktop-theme sync and this feature overwrite each other's values on their next
  run. There is no merge, no lock and no arbitration — only the `was` comments,
  the marked block and the one-time backup for a clean revert.
- **One machine.** A Herdr client on another host reads its own `config.toml`;
  this is a local sync, not a fleet setting.
- **500 ms is the whole observation granularity.** A theme change is noticed
  within one tick and not sooner.
- **The revert is per token, not per file.** Restoration comes from the `was`
  markers and the block, plus the `begin created` table the planner removes
  again; a `[theme.custom]` header **you** wrote and the `name` line's marker stay
  behind (the header is yours, and the name is always projected).
- **There is no "full clear" distinct from an empty custom projection.** A
  projection always carries the theme name, so nothing can ask the planner to
  drop the `name` line: a name line it **inserted** (because `[theme]` had none)
  simply stays, while an existing name is restored to your original. Likewise a
  `[theme]` table the planner created is not removed — only the
  `[theme.custom]` table it created is, once its block empties.
- **The config must already exist.** A missing `config.toml` is refused, never
  created.

## Panel

`/herdr-gentle:customize` with no argument opens the card — the command's own
surface, since the page replaces the command only when gentle-shell-bridge
answers. It behaves like Gentle Shell's own: one left `CATEGORIES` list and one
right pane headed `<Category> · n/m`, with one line per setting and its options
inline — `●` the stored option, `›` the cursor while it sits elsewhere, `○`
the rest.

- The arrows move the option cursor and **only Enter applies**; Enter keeps the
  card open (only a Moshi settings change that needs a Pi reload closes it),
  Esc closes without a write, and
  `Tab` switches panes. `↑/↓` (or `j`/`k`) moves between settings.
- A click on an option applies exactly that option, a click on a setting's name
  only moves the focus, a click on a category selects it, and anything outside
  the panes is ignored (a press only captures the gesture, so a drag applies
  nothing).
- When a line's options do not fit, it scrolls sideways: a window that always
  contains the cursored option, muted `‹` / `›` marking hidden options and an
  `n/m` counter. If not even one option fits, the compact `‹ value ›` form takes
  over; a very narrow card drops the counter to keep the cursored value.
- The Preview block sits below the panes: `Preview · <option> · <title>` in the
  accent role, then the sample lines in the muted role, painted with the host
  theme. A theme option shows its own palette (`source palette` plus an `Aa
  sample text` swatch in that theme's colours); the other options carry a static
  sample. The block is 6, 3, 1 or 0 lines by card height, and the 1-line form
  reads `Preview omitted · enlarge terminal` (`→ controls · Esc close` in a
  narrow card's category list).
- Three footer legends follow what the keys do right now, after the `Click · `
  prefix, and compact instead of wrapping on a narrow card:
  `↑/↓ categories · → open · Esc close` in a narrow card's category list,
  `←/→ choose · Enter apply · ↑/↓ settings · Tab panes · Esc close` on an option
  row, and `←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close` elsewhere.
- The theme list is read automatically from the host (`ctx.ui.getAllThemes()`)
  in the host's own order, `None` first; a host that exposes no list shows one
  note (`Themes unavailable; use Pi /settings`) instead of an empty picker, and
  an unreadable store adds `state unknown; Enter pins a theme`.

When gentle-shell-bridge answers, this card is not registered at all: the same
two settings are the `Theme sync` and `Select theme` rows of the `Herdr` page in
Gentle Shell's own menu, painted by that host. One row per value, walked with
the arrows and applied with `Enter` (the bridge never applies on a cursor move),
the theme row keeps its own swatch, and the theme rows are simply not shown
while the sync is on instead of being refused in place. The notices are the
same fixed strings, and the sync needs no Pi reload on either surface.

## Implementation

| File | Role |
| --- | --- |
| `lib/theme-store.js` | The state document: directory resolution, normalized read, atomic write. |
| `lib/theme-projection.js` | The pure projection: theme names, token order, `HERDR_ROLE_SOURCES`, `DOTS_FIXED`, `projectPalette`, `paletteFingerprint`, the `Off` label. |
| `lib/herdr-theme-config.js` | The pure planner — a **line splicer**, not a TOML validator: table-boundary scanning, opaque bytes outside the two theme tables, a strict theme-table grammar, the whole-line `was` marker with byte-exact restoration (the user's latest trailing comment wins), the one regenerated block (`begin` / `begin created` … `end` / `end after a missing line ending`), the ambiguity refusal above a block being removed or moved, the 1.8.0 marker-pair migration, the BOM and the enforced splice invariant. |
| `lib/herdr-theme-apply.js` | The writer: availability guards, bounded snapshot, compare-and-swap, atomic non-overwriting backup (a regular existing file is accepted as is), retried temp cleanup that reports a survivor and never deletes a temp it did not create, growth limit, `forceReload`, reload. |
| `extensions/herdr-theme-sync.ts` | The follower: session-start evaluation, 500 ms tick, fingerprint, owed-reload repair, the notices. |
| `extensions/gentle-herdr-state.ts` | The switch: `applyThemeSync`, `writeThemeChoice`, `applyCustomizePanel`, `customize status`, and the two-surface registration (`registerCustomizeSurface`). |
| `lib/customize-panel.js` | The card: categories, option lines, sideways window, Preview block, legends, pointer hits. |
| `lib/customize-rows.js` | The page: the same model and settings translated into the four `Herdr` row lines Gentle Shell renders. |
