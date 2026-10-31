# Manual UI check for the worktree tools

Manual-only validation for the `/herdr-gentle:*` feedback work (T10). The checklist
remains open until you record results: this guide is not UI acceptance, and the
automated suite is not a substitute for real terminal input. Shortcut authority is
[Key map](keys.md); registered commands are `/herdr-gentle:warp`,
`/herdr-gentle:odd`, `/herdr-gentle:issues` and `/herdr-gentle:customize`.
`/herdr-gentle:worktree` is gone: worktrees no longer take an issue or ODD
association, so the panel that command drove no longer exists. The full-screen
worktree detail, its edit view and the delete view are gone with it (S4): the
warp popup only warps or creates, and `e`/`ctrl+d` are not bindings there.

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

- [ ] Autocomplete lists `/herdr-gentle:warp`, `/herdr-gentle:odd`,
      `/herdr-gentle:issues` and `/herdr-gentle:customize` and never
      `/herdr-gentle:worktree`: no command opens a worktree detail or edit
      surface, because there is none any more.

- [ ] Warp popup keys: `c` opens create, `v` opens the extended list, `r`
      reloads and `esc` closes. `e` and `ctrl+d` do nothing at all — no edit
      panel, no detail, no delete confirmation, no checkout or registry change
      — and the footer legend names neither key.

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
- [ ] The search row carries no page marker: the Issues and ODD lists are ONE
      continuously scrolling window, so there is no `page n/m` to check and no
      boundary that could skip an item.
- [ ] The Issues/ODD frames use the same 30/70 left/right split, and the left
      rows wrap complete titles/names (hyphenated ODD names break at the hyphen,
      never mid-word).
- [ ] Issues/ODD lists scroll with `←`/`→` a screenful over a real long list
      without skipping items, the focused row follows the window, and `tab`
      never scrolls.
- [ ] After a configuration change and `/reload`, `/herdr-gentle:issues` still opens.
- [ ] The Issues viewer still opens on `tab` over four buckets (My issues,
      Assigned, Involved, All); `All` lists the repository's open issues through
      its own connection read, so a large repository keeps paging instead of
      stopping at the search cap.
- [ ] While a read is pending, Issues/ODD name it (`loading issues…`,
      `loading odd documents…`) instead of showing an empty list or a zero count.
- [ ] Warp `c`: compact bottom flow, not a centered popup, with `Type` and `Name`
      tabs where only the active field takes typing/editing and a creation offers
      no issue or ODD field at all; branch/path preview
      above stays neutral and shows `-` (never a red incomplete-form error) until
      both fields derive a value; `tab`/`←`/`→` switch tabs, `↑`/`↓` choose the
      type, `esc` cancels with no branch or checkout created.
- [ ] With a known read-only repository, `l`/`L` and `a` (and their footer hints)
      are absent and cannot enter the editors.

The two list-scrolling checks need a list that genuinely spans more than one
window; mark them NOT EXERCISED otherwise instead of creating issues only to
reach a row count. Do not change repository roles to test the permission item.

## Safe cancel and out-of-scope writes

Do not initiate remote mutations or destructive actions: cancel every editor
with `esc`, do not `ctrl+s` a label/assignee change, do not post a comment and
do not close an issue. No surface reconciles a worktree association any more —
worktrees carry no issues or ODD documents — so reading Issues/ODD writes
nothing. Comment posting, label/assignee application and issue closing stay out
of scope here — a comment is published for real and cannot be simulated as a
read-only check, and no worktree or branch may be deleted while checking.
Read-only pending/loading states are still checkable from the initial load and
`r`.

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
