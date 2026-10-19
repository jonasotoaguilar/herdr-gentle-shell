# Worktree tool rename: `worktree_create` becomes `worktree_upsert`

The tool creates a worktree when the name is new and updates it when it exists, so its name must say so. Rename the public tool name and every living surface that names it, in one work unit.

Branch: `feat/odd-viewer` (same thread as the odd viewer; this is a second, independent unit inside it). Worktree: `/home/jona/mnt/sv-home/dev/projects/herdr-gentle-shell-worktrees/feat-odd-viewer`. Base: `main` 10aa5f2.
Delivery: `single-pr`, with the odd viewer's commit as the preceding slice; the rename is mechanical and cannot land as a separate PR without duplicating the same branch. Push, PR and merge stay with the user.

## Specs

S1. User request, verbatim: "tambien cambia el nombre de la tool de worktree_create a worktree_upsert (pues es para crear y actualizar esa tool)".

S2. Scope of the rename: the tool's registered NAME (`worktree_create` -> `worktree_upsert`), its visible label, its description when that description still implies creation only, and every living surface that names the old name — the extension, the `lib/` modules that emit or match it, `rules/`, `README.md`, `DESIGN.md`, `docs/worktree-tools.md`, and the test suites. No alias, no compatibility shim: the old name stops existing, exactly as the removed customize commands did (S7 of `customize-command.md`).

S3. Historical records are not rewritten: `odd/tasks/worktree-tools.md` and `odd/tasks/customize-command.md` keep their quoted specs, task rows and log entries verbatim, because requirement documents are the record of what was asked when it was asked.

S4. Internal identifiers are out of scope: TypeScript/JavaScript function and variable names (`executeWorktreeCreate`, `worktreeCreateTool`, the warp-create pickers and their test files) keep their names, so the diff stays the size of the contract change instead of a codebase-wide rename.

S5. Behavior is otherwise untouched: parameters, validation, messages, registry writes, hooks, symlinks, output text and every other observable effect of the tool stay byte-identical apart from the name itself.

## Tasks

T1 | S1,S2 | reconnaissance | done | Inventory every living reference to `worktree_create` and classify it: contract surface to rename, historical record to preserve, or internal identifier to leave alone. Result: 19 living surfaces plus the new contract test; two historical odd documents preserved; internal identifiers left alone. Commit: 8eea0a9.
T2 | S2,S3,S4,S5 | implement | done | Rename applied across the living surfaces (extension, four `lib/` modules, `rules/worktrees.md`, README, DESIGN, `docs/worktree-tools.md`, ten test suites) with every internal identifier and historical document untouched. The card HEADER also follows the new name (`lib/worktree-card.js` TITLE value), corrected by the parent after the first pass left it reading `worktree create`. Commit: 8eea0a9.
T3 | S2 | verify | done | `tools/worktree-upsert-rename.test.js` pins the contract: the tool registers as `worktree_upsert` with its label and create-or-update description, is absent under the old name, and no living surface still names it. Full suite `LC_ALL=C node --test tools/*.test.js`: 1299 tests, 1298 pass, 1 fail — the pre-existing environmental `worktree-hooks` failure caused by the machine's global `core.excludesFile`. Commit: 8eea0a9.

## Log

L1. User request, verbatim: "tambien cambia el nombre de la tool de worktree_create a worktree_upsert (pues es para crear y actualizar esa tool)".
L2. Parent inventory before any edit, from a repository-wide grep excluding `.codegraph` and the historical odd documents: 20 living files name the old name — `extensions/gentle-worktree-tools.ts` (9), `tools/worktree-card-render.test.js` (24), `tools/worktree-create.test.js` (7), `docs/worktree-tools.md` (7), `tools/worktree-hooks.test.js` (6), `lib/worktree-card.js` (6), `tools/worktree-odd-update.test.js` (5), `tools/worktree-session.test.js` (3), `tools/worktree-capture-gating.test.js` (3), `tools/customize-panel.test.js` (3), `README.md` (2), `DESIGN.md` (2), `rules/worktrees.md` (2), `lib/worktree-odd.js` (2), `tools/worktree-close.test.js` (2), `tools/customize-warp.test.js` (2), `tools/worktree-hardening.test.js` (1), plus the two historical odd documents that stay as they are.
L3. Parent review of the delivered rename, after the suite ran green: the visible card HEADER still read `worktree create` for the renamed tool, because the worker kept the display VALUE to preserve output text. The header names the tool, so it now reads `worktree upsert` and its test asserts that value (not the fixture text that used to satisfy the old assertion by accident). Three sorted-order literals were re-sorted because `worktree_upsert` sorts after `worktree_session_open`; nothing else moved. Output text produced by the tool (`created:` / `updated:` lines) is unchanged, as S5 requires.
