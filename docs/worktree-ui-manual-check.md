# Manual UI check for the worktree tools

Manual-only validation for the `/herdr-gentle:*` feedback work (T10). The checklist
remains open until you record results: this guide is not UI acceptance, and the
automated suite is not a substitute for real terminal input. Shortcut authority is
[Key map](keys.md); registered commands are `/herdr-gentle:warp`,
`/herdr-gentle:worktree`, `/herdr-gentle:odd`, `/herdr-gentle:issues` and
`/herdr-gentle:customize`.

## Launch

```bash
cd /home/jona/mnt/sv-home/dev/projects/herdr-gentle-shell-worktrees/feat-worktree-ui-redesign
pi --no-extensions -e ./extensions/gentle-worktree-tools.ts
```

Use the normal user profile, this feature checkout, and no `.ui/` fixture: no
dummy provider, custom `HOME`, `GH_BIN_PATH` or model configuration. Answer any
trust prompt yourself; no `--approve` flag is expected.

Before running a slash command, confirm autocomplete lists it, especially
`/herdr-gentle:warp`. If a command is missing, do not submit the unknown slash
text as a model prompt. Worktree tools can be enabled through
`/herdr-gentle:customize` (apply the Worktree tools Enabled row), then `/reload`,
then check the registered commands again — never hand-write the config JSON.

## Checklist

For each item record command, terminal size, keys, expected/actual and a
screenshot, then mark PASS, FAIL or NOT EXERCISED.

- [ ] Preview paging: press what the footer actually names on this terminal —
      `ctrl+shift+j`/`ctrl+shift+k` if it says so, otherwise `Shift+J`/`Shift+K`
      — and check a preview taller than the pane pages by a full screen;
      `PgDn`/`PgUp` page too, and `ctrl+d`/`ctrl+u` move about half a screen.
- [ ] The paging footer claim matches what the terminal delivers: a terminal
      without the extended keyboard protocol is never told to press
      `ctrl+shift+j/k`, and no footer claims an OS-specific version.
- [ ] Bare `Enter` (and a legacy `Ctrl+J` byte from a terminal that sends one)
      never scrolls the preview: on the ODD tab it selects the focused document,
      and the preview stays where it was.
- [ ] Lowercase `j`/`k` move the list selection and never page the preview;
      a key RELEASE (releasing `J` without tapping a new key) changes nothing.
- [ ] With the search row open, typing `J`, `K`, `j` or `k` appends those
      characters to the query instead of paging or selecting.
- [ ] The page indicator (`page n/m`) sits beside Search on every screen — Issues,
      ODD and worktree detail — including a one-page and an empty list.
- [ ] The Issues/ODD/worktree-detail frames use the same 40/60 left/right split,
      and the left rows wrap complete titles/names (hyphenated ODD names break at
      the hyphen, never mid-word).
- [ ] Issues/ODD lists page with `←`/`→` over a real multipage list without
      skipping items, and `tab` never pages.
- [ ] After a configuration change and `/reload`, `/herdr-gentle:issues` still opens.
- [ ] Worktree detail shows three logical header rows (details, `issues: #…`,
      `odd: name`) when real assignments exist, with `-` for a missing one.
- [ ] Worktree detail `tab` switches Issues/ODD, `←`/`→` page the active list and
      never switch tabs.
- [ ] Worktree detail's issue preview shows the same metadata and the real
      comments Issues shows (assignees, projects, linked PRs, every comment).
- [ ] While a read is pending, detail names it (`loading issues…`,
      `loading odd documents…`, `save waits for …`) instead of showing an
      empty list or a zero count.
- [ ] Warp `c`: compact bottom flow, not a centered popup, with `Type` and `Name`
      tabs where only the active field takes typing/editing; branch/path preview
      above stays neutral and shows `-` (never a red incomplete-form error) until
      both fields derive a value; `tab`/`←`/`→` switch tabs, `↑`/`↓` choose the
      type, `esc` cancels with no branch or checkout created.
- [ ] With a known read-only repository, `l`/`L` and `a` (and their footer hints)
      are absent and cannot enter the editors.

The two list-paging checks need a list that genuinely spans pages; mark them NOT
EXERCISED otherwise instead of creating issues only to reach a row count. Do not
change repository roles to test the permission item.

## Safe cancel and out-of-scope writes

Do not initiate remote mutations or destructive actions: cancel every editor
with `esc`, do not `ctrl+s` a label/assignee change, do not post a comment and
do not close an issue. Opening detail can reconcile local registry assignments
when it proves an assigned issue closed or missing; this is not a write-free
sandbox. Use a checkout whose local reconciliation you intend to allow.
Comment posting, label/assignee application and issue closing stay out of scope
here — a comment is published for real and cannot be simulated as a read-only
check, and no worktree or branch may be deleted while checking. Read-only
pending/loading states are still checkable from the initial load and `r`.

## Earlier partial observations

Earlier automated and fixture runs observed the ODD reader's own keys and the
Issues assignee/label editors. That evidence is partial and must not be reported
as overall completion.

## Reporting limits

Passing automated tests are not full-TTY proof. Full Pi frame duration is not
measured here: a package render trace (`GENTLE_PERF_TRACE=1`) covers only this
plugin's own spans and does not prove a whole-host TUI speedup. The old
performance switches are gone from Customize — there is no performance toggle to
test, so do not report its effect as unknown. Do not change live flags, account
scopes or core configuration while checking.
