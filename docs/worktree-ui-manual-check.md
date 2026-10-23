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

- [ ] Issues: `ctrl+j`/`ctrl+k` scroll a preview taller than the pane; lowercase `j`/`k` still move list rows.
- [ ] Issues/ODD lists wrap complete titles/names; `←`/`→` page a real multipage list without skipping items.
- [ ] After a configuration change and `/reload`, `/herdr-gentle:issues` still opens.
- [ ] Worktree detail shows three logical header rows (details, assigned ODD, assigned issue numbers) when real assignments exist.
- [ ] Worktree detail: `tab` switches Issues/ODD, `←`/`→` page the active list and never switch tabs.
- [ ] Warp `c`: compact bottom flow, not a centered popup, with `type` and `name` fields plus branch/path preview above; `tab`/`←`/`→` move between fields, `↑`/`↓` choose the type, `esc` cancels with no branch or checkout created.
- [ ] With a known read-only repository, `l`/`L` and `a` (and their footer hints) are absent and cannot enter the editors.

The two list-paging checks need a list that genuinely spans pages; mark them NOT
EXERCISED otherwise instead of creating issues only to reach a row count. Do not
change repository roles to test the permission item.

## Safe cancel and optional writes

Cancel label and assignee editors with `esc` only; do not `ctrl+s` and do not
close an issue unless you intend a real change. Commenting is optional and
publishes a real comment: label it clearly as such, it cannot be simulated as a
read-only check.

## Earlier partial observations

Earlier automated and fixture runs observed ODD `ctrl+j`/`ctrl+k` scrolling, ODD
`Delete`, and the Issues assignee/label editors. That evidence is partial and
must not be reported as overall completion.

## Reporting limits

The 1975 passing automated tests are not full-TTY proof. Full Pi frame duration
and the effect of the performance switches remain unknown: no public host hook
exposes them, so a package render trace does not prove a TUI speedup. Do not
change live flags, account scopes or core configuration while checking.
