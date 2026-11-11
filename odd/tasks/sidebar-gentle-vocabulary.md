# Feature: one pink `gentle` — the principal session's working and generic status

Branch `feat/gentle-vocabulary` (worktree `../herdr-gentle-shell-worktrees/feat-gentle-vocabulary`). Reducer vocabulary only: the sidebar keeps exactly one user-facing `gentle`, never amber, never on an idle session.

## Specs

S1. Exactly one user-facing `gentle` may exist: the pink one (display `orchestrating`, `#f5c2e7`). The amber display `working` (`#f9e2af`) must never render the word `gentle`.
> «no deberia existir otro gentle, es esolo el gentle rosa.»

S2. `gentle` must never appear on an idle session.
> «Y no deberia aparecer cuando esta idle.»

S3. A recognized gentle role keeps its abbreviation: `gentle-explorer` renders `explorer`, and likewise `worker`, `verify`, `judge`.
> «si nuetros status personlizos son abrevaitures como de gentle-explorer lo pone explorer»

S4. A subagent with no predefined role (non-contemplated) renders its own generic name in amber, when the producer can resolve one.
> «pero para los demas pone el nobmaje del subagente, si sabe reconocerlos»
>
> «para los que no tenemos contemplados»

S5. With no resolvable name, the fallback is the pink `gentle`: it is the principal session's working status and its generic status. No delegate ever renders `gentle`.
> «sin nombre resoluble, como fallback lo deja gentle rosa, que es el estado "working"»
>
> «es el status principal de trabajando y generico de la sesion principal»

## Tasks

| ID | Specs | Route | Change | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S2, S5 | worker | Reducer (`herdr-plugin/lib/gentle-tokens.js`): the generic-activity legs stop returning display `working` with label `gentle`. `:950` (principal active, no fresh marker) and `:973` (`work.count > 0` with no recognized role word) become `orchestrating` (the pink fallback); `:977` (`work.count === 0` and native status neither `done` nor `idle`) becomes `idle`. The amber `working` display keeps exactly one producer: the passthrough path (`roleToDisplay` -> `outRole('working', slug)`) that carries a non-contemplated subagent's name. `configure.js` needs no change: the amber cell stays wired to `$gentle_title_working`, whose value becomes that name. | pending |
| T2 | S2, S5 | worker | Producer (`extensions/gentle-herdr-state.ts`): a native status must not freeze at `working`, and the beat must not run forever without a settle, so a failed or aborted run reaches `idle` instead of pinning the row. Covers the `computeNativeState` undefined hole, the `ensureBeat` settle gate, and the `nativeSettledPending` latch. | pending |
| T3 | S1-S5 | worker | Docs whose vocabulary says generic activity reads `gentle`: `DESIGN.md` (~628-634 and neighbors) and `README.md` (~253-256 and neighbors). State the new routing: pink `gentle` = principal session working/generic, amber = a non-contemplated subagent's name, abbreviations for gentle roles, never `gentle` on idle. | pending |
| T4 | all | verify | Independent verification of T1-T3 against S1-S5 plus the full `node --test tools/*.test.js` suite. | pending |

## Log

L1. «encontre otro bug, queda en estado gentle, lo raro es que cuando le hablo pasa a este gentle color rosa y cuando termina pasa a done, pero luego pasa a gentle amarrillo en vez de idle, nose si es producto de que el agente fallo y quedo ahi» — followed by «investiga».

L2. «no deberia existir otro gentle, es esolo el gentle rosa. Y no deberia aparecer cuando esta idle.»

L3. «si nuetros status personlizos son abrevaitures como de gentle-explorer lo pone explorer, pero para los demas pone el nobmaje del subagente, si sabe reconocerlos»

L4. «para los que no tenemos contemplados»

L5. «sin nombre resoluble, como fallback lo deja gentle rosa, que es el estado "working"»

L6. «es el status principal de trabajando y generico de la sesion principal»

E1. Root cause of L1, investigated in the main checkout before this worktree existed. The second `gentle` is produced by three reducer legs that return display `working`, whose `DISPLAY_LABELS.working` value is `gentle` (`herdr-plugin/lib/gentle-tokens.js:320-321`): `:950` (principal active with no fresh root marker), `:973` (fresh work token, positive count, no recognized role word), `:977` (fresh work token, count 0, native status neither `done` nor `idle`). The third leg is what pins the row: `computeNativeState` returns `undefined` when nothing is active and `settled` is false (`extensions/gentle-herdr-state.ts:1150-1180`), so `desiredNativeReport` publishes no native state (`:3396-3419`) and the host keeps the last native `working`; `ensureBeat` skips arming only when `!interesting() && settled` (`:3370-3375`), so an inactive-but-unsettled producer beats every 15 s forever, republishing a fresh count-0 `gentle_work_v1`. `settled` flips only in `agent_settled`, which early-returns unless `ctx.isIdle() === true` (`:4219-4223`). No bound clears it without a new turn. Secondary latch: `nativeSettledPending` (`:2855`, set `:4226`, published as `pendingCount` `:3410`, cleared only at `:3776`/`:4016`/`:4213`) keeps the native report at `working` after a settle with tool calls in flight, which is the `done` -> amber order the user observed.

E2. Blast radius measured before the feature doc existed: `DISPLAY_LABELS.working` has no consumer outside tests; `herdr-plugin/bin/configure.js:141-152` needs no change because the amber cell is wired to `$gentle_title_working` and will carry the subagent name; `lib/gentle-sidebar.js`, `bin/gentle-sidebar.js`, `lib/customize-panel.js` and `herdr-plugin/bin/gentle-whois.js` contain no reference to `working` or the amber cell; `herdr-plugin/lib/gentle-diagnostics.js:56-58` keeps working as long as `working` stays a display key.

E3. Delegate name availability: `rolesCsv` (`extensions/gentle-herdr-state.ts:3167-3180`) drops every entry `agentToRole` cannot resolve, so `gentle_work_v1` count > 0 with an empty roles CSV is reachable when a task record carries no `agent`, when the name sanitizes to nothing, when the slug is the banned `working`/`subagent`, or when the slug starts with `_`. Those are exactly the S5 no-name inputs; a resolvable non-contemplated name already travels as a passthrough slug (`herdr-plugin/lib/gentle-tokens.js:683-693`).

E4. Test blast radius: `tools/gentle-tokens.test.js` pins the old vocabulary at ~347-349, 405-408, 613-615, 644-653, 1240-1262, 1299-1336, 1344-1358, 1406-1416, 1473, 1490-1492, 1625-1626; `tools/gentle-herdr-done.test.js:674` pins the settled job wait on the amber/pink generic; producer-side expectations live in `tools/gentle-herdr-state.test.js` (~2526, 2818, 2852, 4047-4058, 4163-4192, 4237-4250).
