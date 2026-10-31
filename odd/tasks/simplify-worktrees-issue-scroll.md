# Simplify worktrees and issue browsing

Track the requested worktree simplification and list responsiveness.

## Specs

- S1: «los worktrees del plugin ya no resiviran ni issues ni odd. por lo que se elimina el panel de editar worktree y la tool del agente upsert ahora sera create y sirve solo para crear, nada de update pues ahora para crealo es solo la rama en la tool y para el comando / es type y nombre como estaba.»
- S2: «en comando issues investiga alguna tecnica o patron para ver la carga, refresco/actualizacion para que no demore tanto. Las primeras 3 tabs se relacionan a issues solo mias por lo que en general cargan mas rapido, el problema es el tab de "All" que las revisa todas las open, e ir refrescandolas en proyectos grandes igual es arto hay que ver si lo sacamos o como optimizamos mejoramos velocidad/carga.»
- S3: «tambien en comandos issues y odd haz el panel izquierdo mas pequdo, que quedo 30/70 la division. Y quita en ambos los de las pages y en su lugar haz un scroll infinito, nose si con cursor/paignacion o si deben ser todos para saber total o el total se obiente con otra consulta, igual debe terner todo para el tema de la busqueda, pero quizas con cache y refrezcar cada tanto o cuando se modifique, pues no se consulta a cada rato el comando.»
- S4: «por lo que en comando warp igual saca el edit claro, se va la vista de eliminar worktree»
- S5: «el comando herdr worktree igual se elimina, ya no sirve tampoco pues lo worktrees no se modifican»
- S6: «a worktree create igual hay que sacarle lo de issue y odd, pero agregarle codegraph (si quedo inicializado).» «el outcome igual quedo demas, si siempre es create ahora

si falla la creacion la tool es failed asi que no es necesario outcome tampco»
- S7: «falta muchas cosas. Por ejemplo no esta ahi si se registro el worktree.» The create result must report whether the worktree was registered in the registry (registry write outcome), without reintroducing issue/ODD associations or the removed created/updated outcome.
- S8: «el name y branch estan demas, el name sale en el path y la branch es el campo que entra.» «en la version colapsada deberia salir status nomas.» The expanded create card must drop the redundant `name:` and `branch:` rows (name is implied by the path, branch is the tool input); the collapsed create card must show only the status row.
- S9: «cuando ahi recien lo habia creado» «...y no inicializo codegraph» A thread may own more than one worktree: `worktree_create` must create the requested branch and register it even when the thread already owns another checkout. «solo aparece que ya existe si intenta crear de una rama que ya tiene un worktree creado» — the already-exists answer is scoped to the REQUESTED BRANCH already having a worktree; any other owned checkout never blocks or substitutes for the requested branch.
- S10: «en issue no tiene sentido scroll con izq/der, deberia ser como el tab para cambiar tab» In the issues reader, `←`/`→` switch tabs like `tab`; list scrolling keeps its other keys.
- S11: «ademas en ninguna estan los colores para distinguir tecla de texto con la paleta» Every reader/panel footer must render shortcut keys with a distinct theme color from their descriptions.
- S12: «en odd agrega que se muestre en orden de modificacion, que los mas reciente primero, y agregar un atajo para alternar el orden. (recientes, alfabetico)» The ODD list defaults to newest-modified first and has a shortcut to toggle between recency and alphabetical order.
- S13: «en modificacion hay que considerar que puede ser proyecto clonado, por lo que habria que ver como detectar modificardo, algo como archivo, ultimo commit, ver prioidades de que examinar» Recency must be meaningful in a fresh clone: prefer a file's last commit time, treat an uncommitted local edit as newer, and fall back to mtime when git or history is unavailable.
- S14: «alguna key generidad como el page o half estan demas (nose para que es)» Footer legends must not list redundant or ambiguous shortcut tokens: document-scroll hints collapse to one clearly-labelled token, and bindings stay documented even when their hint is dropped.

## Tasks

- T1 [S1,S4] Simplify worktree creation and remove warp edit/delete views; independent verification found remaining issue/ODD assignment paths; correction pending; commit pending.
- T2 [S2] Investigate and improve issue loading and refresh; worker timed out after 30 minutes in bash; changes and checks are incomplete, awaiting user decision; commit pending.
- T3 [S3] Adjust issues/ODD layout and scrolling while preserving search; UI implementation and 161 focused tests passed; complete search depends on T2; commit pending.
- T4 [S1-S5] Verify behavior, shared contracts, and review requirements; route verify where applicable; commit pending.
- T5 [S5] Confirm `/herdr-gentle:worktree` is already removed; existing tests assert absence; no implementation needed.
- T6 [S6] Remove issue/ODD from worktree creation output and report actual CodeGraph initialization status; route and commit pending.

## Delivery

`feat/simplify-worktrees-reconciled` is a long-lived branch: it already carries
the earlier issue/ODD reader work, so the ~35k authored lines since `origin/main`
are split into review slices here rather than re-cut into new commits. Slices
land in this order; each commit is a review unit of its own and the branch as a
whole is the PR body's scope.

- Slice 1 (commit `2c0808e`): worktrees carry no association, `worktree_create`
  is create-only, the detail view and dead association modules are deleted.
- Slice 2: shared palette across every reader and panel (`lib/tui-paint.js`).
- Slice 3: issues paged loading with an uncapped `All` bucket.
- Slice 4: ODD recency ordering with a HEAD-keyed commit-time memo, and reader
  footers that name each scroll target once.
- Slice 5: the herdr harness guard refuses a live binary under test.
- Slice 6: the feature document and the remaining documentation.

The final tree is the verified one (2229 tests pass, 0 fail); intermediate
commits are slices of that tree, not independently re-verified checkpoints.

## Log

- L1: «vamos a modificar como funciona los worktrees, simplificarlo.

los worktrees del plugin ya no resiviran ni issues ni odd. por lo que se elimina el panel de editar worktree y la tool del agente upsert ahora sera create y sirve solo para crear, nada de update pues ahora para crealo es solo la rama en la tool y para el comando / es type y nombre como estaba.

en comando issues investiga alguna tecnica o patron para ver la carga, refresco/actualizacion para que no demore tanto. Las primeras 3 tabs se relacionan a issues solo mias por lo que en general cargan mas rapido, el problema es el tab de "All" que las revisa todas las open, e ir refrescandolas en proyectos grandes igual es arto hay que ver si lo sacamos o como optimizamos mejoramos velocidad/carga.

tambien en comandos issues y odd haz el panel izquierdo mas pequdo, que quedo 30/70 la division. Y quita en ambos los de las pages y en su lugar haz un scroll infinito, nose si con cursor/paignacion o si deben ser todos para saber total o el total se obiente con otra consulta, igual debe terner todo para el tema de la busqueda, pero quizas con cache y refrezcar cada tanto o cuando se modifique, pues no se consulta a cada rato el comando.»
- L2: «por lo que en comando warp igual saca el edit claro, se va la vista de eliminar worktree»
- L3: Read-only exploration found repeated issue fetches, 500-item fetch caps, and ODD list focus can leave the visible viewport. GitHub documents cursor pagination and totalCount; partial local caches cannot guarantee complete search.
- L4: T1 worker reported focused tests passing; parent updated four remaining tool-name assertions, and 160 customize tests passed. Independent verification is pending.
- L5: «el comando herdr worktree igual se elimina, ya no sirve tampoco pues lo worktrees no se modifican»
- L6: User clarified `/herdr-gentle:worktree`. It is already unregistered; tools/customize-warp.test.js:368 and tools/customize-panel.test.js:297 assert its absence.
- L7: Independent verifier found issue/ODD viewer assignment paths still mutate worktree associations, contrary to S1. T1 remains open for correction. Baseline locale-dependent close test failed identically.
- L8: T3 worker implemented 30/70 and continuous list windows; 161 focused tests passed. Loading and complete search remain dependent on T2.
- L9: Association write surfaces and listing displays removed while preserving legacy registry data. Focused checks passed; obsolete close/ODD assertions are being updated before independent verification.
- L10: Current /issues has only My issues, Assigned and Involved; there is no All tab. The existing loader limits returned lists to 30 after fetching up to 500; T2 must address completeness without reintroducing All.
- L11: T2 writer timed out after 30 minutes with bash still running, without a result or verification. Partial test edits exist; lib/gh-issues.js is not modified. No test retry or cleanup was attempted; independent T1 verification and final review remain pending.
- L12: «ahi sigue saliendo odd/issues, te dije quitarlo de todo, no exploraste?» The user screenshot shows worktree list output still displaying issues, odd, and available odd; investigate all remaining surfaces and correct T1.
- L13: Explorer reports the running extension comes from a sibling worktree and found an active ODD association event writer in this checkout. The writer removed capture, retained session naming and legacy data, and reports 165 + 377 isolated tests passing. Independent verification is running; runtime activation remains unverified.
- L14: T2 writer reports cursor paging for the active issue bucket and 140 focused tests passing. Independent verification must check search completeness, provider pagination limits, and the removed exported listIssues contract.
- L15: Independent T1 verifier reports S1 and S4 met in current checkout, 499 focused tests and 1616 passing / 10 skipped in isolated full suite. Live Pi runtime remains unverified; screenshot shows `/herdr-gentle:worktree` still registered in the running session.
- L16: Independent T2/T3 verifier reproduced false completeness at simulated search caps, cross-bucket failure stalling visible loading, repeated cursor loops, and removed listIssues export. Layout and continuous scrolling verified; live provider cap remains unverified.
- L17: Correction worker mvwobwma-7-o00w timed out without delivering a result. Its partial edits, if any, are not verified. Runtime settings access at /home/jona/.pi/agent/settings.json awaits explicit authorization.
- L18: «un pequeno detalle [Image#1] cambia explorer po "explore"» Changed the visible sidebar role label to explore, keeping its explorer machine key. RED observed; 100 token tests pass.
- L19: «a worktree create igual hay que sacarle lo de issue y odd, pero agregarle codegraph (si quedo inicializado).»
- L20: «el outcome igual quedo demas, si siempre es create ahora

si falla la creacion la tool es failed asi que no es necesario outcome tampco»
- L21: T6 implementation reports CodeGraph hook status without re-running initialization and omits the outcome/association fields. Independent verification passed core statuses; follow-up corrected renderer-load fallback and preserves the already-existing checkout indication, awaiting re-verification.
- L22: Independent T2 verification found concurrent cursor-shift omissions and duplicates. Writer replaced cursor walks with counted atomic creation-time windows; same-second overflow is explicitly incomplete, and refreshed data is not a snapshot. Re-verification found exactly 100 issues in one second prematurely bounds search; correction in progress.
- L23: Independent T6 re-verification passed status fallbacks and existing-checkout indication: 177 focused tests passed and isolated full suite 1655 passed / 10 skipped. Commit and live runtime activation remain pending.
- L24: Independent T2 re-verification passed exact-second boundary and prior concurrency probes: 217 focused tests passed / 3 skipped. Search remains explicitly incomplete for more than 100 matches created in one second, and live provider semantics were not verified.
- L25: Current diff spans 41 tracked files, 4458 additions and 6227 deletions, plus two intended untracked files. Slice explorer lacked git access; its proposed boundaries require direct diff confirmation before staging.
- L26: «claramente lo perdiste todo, en issues ya no sale lo de "All" y el worktree si lo tenia» Corrected discovery: base b8d4910 omitted 80 newer commits through 3602ac8; preserve All and existing newer features.
- L27: Following user authorization, preserved old work at refs/backup/simplify-worktrees-before-reconciliation (40077dba842f34e73a5c82460a4d9bd7741faede), then attempted switch; conflicts broke plugin. Following explicit restoration authorization, restored tracked checkout to 3602ac8; zero unresolved entries, all three stashes and two untracked files retained. Extension syntax and 180 focused tests pass. Reimplement S1-S6 on correct base; earlier verification applies only to old base.
- L28: Correct-base independent verification confirmed reader layout, continuous scrolling, All, and metadata; 320 focused tests passed / 8 skipped. It found failed typed queries showing stale rows; correction in progress. A missing two-repository cached-fallback isolation test was restored; writer reports 16/16 cache tests passing.
- L29: «falta muchas cosas. Por ejemplo no esta ahi si se registro el worktree.» Create output must state whether the checkout was registered, while keeping the no-association and no-outcome rules.
- L30: «el name y branch estan demas, el name sale en el path y la branch es el campo que entra.» «en la version colapsada deberia salir status nomas.»
- L31: «/home/jona/mnt/sv-home/dev/fork/gentle-shell-worktrees/feat-codegraph-worktree-param y no inicializo codegraph» Root cause: per-thread idempotency returned the session's existing checkout instead of creating the requested branch. User decision: allow multiple worktrees per session.
- L32: «solo aparece que ya existe si intenta crear de una rama que ya tiene un worktree creado» Already-exists must be keyed to the requested branch's own worktree, not to any other checkout the thread owns.
- L33: «en issue no tiene sentido scroll con izq/der, deberia ser como el tab para cambiar tab» «ademas en ninguna estan los colores para distinguir tecla de texto con la paleta»
- L34: «en odd agrega que se muestre en orden de modificacion, que los mas reciente primero, y agregar un atajo para alternar el orden. (recientes, alfabetico) y nos si otro mas»
- L35: «en modificacion hay que considerar que puede ser proyecto clonado, por lo que habria que ver como detectar modificardo, algo como archivo, ultimo commit, ver prioidades de que examinar»
- L36: «alguna key generidad como el page o half estan demas (nose para que es)»
