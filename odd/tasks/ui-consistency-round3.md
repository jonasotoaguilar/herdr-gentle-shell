# UI consistency round 3 — user-tested corrections
Existing thread: feat/worktree-ui-redesign, base c3f2895. Preserve unrelated work; no host fork or live issue/deletion tests.
Delivery: auto-chain, feature-branch-chain (explicit user selection); coherent behavior slices on this lineage, no publishing. Tests: LC_ALL=C GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null node --test tools/*.test.js.

## Specs

S1. Verify the native Pi scroll binding before implementing it; one consistent effective binding and accurate footer across viewers, including search mode. Exact: "pero no habiamos dicho ctrl+shift j/k, asi lo hace pi nativo no? como lo para buscar file. Ademas que el keybinding sale siempre ctrl j/k y no segun el sistema, por lo que el usario no sabe cual es realmente a veces."

S2. Warp associations display names/ids, not counts. Exact: "Tambien en warp sale odd 1, y deberia salir el nombre del odd, no la cantidad." / "(En warp igual, no poner issues 0 u odd 0 sino que como -, seria como null por decirlo)."

S3. Worktree creation through command and agent tool uses symlinks from .agents/, .pi/, .claude/ and odd/ to principal/main ONLY when Git-ignored. Tracked entries already arrive via checkout; merely untracked nonignored entries are not eligible. Source and existing destination are preserved. Original exact: "Tambien al crear un worktree con comando o tool agente copia archivos como env, hay que agregar que si existen en main copie tambien .agents/ y .pi/ ." Intermediate correction exact: "nada de symlinks, sera copias, .claude igual. ademas esto es solo si esta git ignoradas claro, pues sino al crearlo ya se llevan". Superseding explicit selected answer: "Las cuatro como symlinks hacia main". No independent directory-copy implementation remains in scope.

S4. Warp keyboard deletion ALWAYS requests human confirmation and discloses uncommitted changes and commits ahead of main. Reproduce without deleting real user data; cancellation never deletes. Exact: "En warp, la tool de borrar con keybinding es instantaneo y habiamos dicho que siempre debe pedir confiormacion, no recuerdas? ademas de que en caso de tener cambios sin comitear o commits adelantedso a main lo mencione en el mensaje de confimacion."

S5. Shared 40/60 left/right geometry for fullscreen Issues, ODD and worktree/edit; full titles wrap over as many rows as needed. Exact: "[Image#1] tambien revisar tamanos de comando issues, odd y worktree edit. QUe sean consistente todos mismo tamano izq/der. La der debe ser mas grande diria que 40/60, y recordando que en listado izquierod siempre se vea titulo completo, si no alcanza en uan linea se extiene a 2 ese campo del listado."

S6. Worktree header order: details, issues, ODD. ODD is name only (no path); associations use colons, issue numbers use #; missing values use -. Exact: "[Image#2] en detalle de worktree el odd solo debe ser el nombre no el path. En listado de issues, la issues van con #, serai #76, #77. Tambien con :, seria odd: nombre, o issues: #76, $78." / "Y hamos dicho que issue es la segunda linea y odd la tercera. Si no tiene issues u odd queda con - . (En warp igual, no poner issues 0 u odd 0 sino que como -, seria como null por decirlo)."

S7. Create uses Type|Name tabs rather than both fields together. Preview stays neutral/empty until the fields derive a valid branch/path, not red incomplete-form errors. Exact: "[Image#3] en create dijimos que seria como worktree, con tab de type|name, y los pusiste juntos. [Image#4] y en la preview no lo pongas en rojo, ponlo vacio y que aparezca cual seria tras complentar ambos campos type y name."

S8. Derive page capacity from real available viewport rows and wrapped list entries, not fixed20 or a guessed count. Explain the actual calculation. Exact: "en los comandos fullscreen odd, issues y worktree/edit por lo que se ve en la imagen caben mucho mas de 20 por page, cuantos definiste por page? como lo calculaste? necesitamos un valor real para que calce bien con el taamno cuando este completo, no un valor adivinado o aleatorio."

S9. Explain and correct loading/pagination/cache/refresh/search over the complete eligible dataset, not only the loaded page. Exact: "Tambien como se cargan la issues y odd cuando son muchos, si las carga todas, por paginas, cache. Como las mantiene actualizdas/refresca. COmo seria con el search en esas, si no estan todas cargadas como busca bien?"

S10. Mutations enter a visible saving state immediately and prevent navigation/duplicate save while pending; clear/error/success honestly on settle. Exact: "en issues cuando modifico labels, assing, comment, etc. cuando le doy guardar no es instantaneo, o sea, le doy al tajo y me deja serguir moviendo e intereactuando, da mal ux al usuario, no sabe si esta cargando y piensa que no funciono al poder moverse, esta terrible."

S11. Comment editor displays its focus/caret at the insertion position. Exact: "[Image#5] el commenct dijomos que le faltaba un focus, como este [Image#6] sino como sabra donde estap osicioando el texto."

S12. Audit all package agent tools' compact/expanded renderings and model-facing content. Compact shows only necessary action/success; expanded is formatted readable multiline detail; model content includes useful data, not redundant dumps. Preserve consumed result contracts unless an intended output change requires migration. Exact: "[Image#7] tambien hay que revisar el formato de las salidas de todas las tools del agente en formato compacto y extendido. En compacto debe mostar solo lo preciso para saber que funciono y que hizo, en extendido el detalle y ordenando con formato, salto de lineas, que sea legible no como en la imagen, y esa solo era una tool hay que revisar y corregira todas. Ademas de msotrar solo la info necesaria para el agente, para optimizar token, si no aporta valor al agente o no le sirve/usara esta demas."

S13. Switching loaded Issues tabs reuses data rather than refetching and flashing Loading every switch; explicit refresh still refreshes the current page. Exact: "EN issue igua,l no entiendo porque cada que hago un tab entre issues, assign , involved, vuelve a refrescar y sale loading, entorpece la ux y es lentismo."

S14. Page indicator stays fixed alongside Search consistently across Issues, ODD and worktree/edit, including one-page lists, using the user's LAST positioning instruction. Search-active footer shows actual search actions consistently. Exact earlier reports: "[Image#8] tampoco entiendpo que la page sale ahi, no tieen sentido, las page irian fijas, o abajo del todo (arriba de keybinding). esto en todo, issues, odd, worktree, es diseno basico." / "[Image#9] en odd ni sale las page, pero si esta paginada, asi que hay que arregarlo y revisar las otras, que salga siempre abajo las pages." Superseding placement: "[Image#11] de hecho puede dejar page arriba, al lado de search como en edit worktree, asi queda fija en todas, sigue un estilo, nose porque lo haces diferentes, debe ser consistente todos los comandos. en worktrre igual cuando esta en search no se actualiza abajo las teclas como en issues, cero consitencia en disenos. revisa todo puede haver mas errores asi u de otros tipos, pero que sean consistentes."

S15. Add fourth Issues tab All, listing all OPEN repository issues; no inferred exclusion/deduplication against other tabs. Exact: "Tambien en comando issues agrega un 4 tab al final que sea \"All\" que muestre todas las issues open, listado."

S16. Worktree/edit issue preview has the same metadata/comments as Issues. Exact: "En vista edit worktrre igual la preview de issue esta imcompleta, debe ser igual a issues, con el assign, comentarios y los datos que tenga. (por lo que vi faltan los comentarios)."

S17. ODD labels wrap at hyphens/word boundaries before splitting a word, consistently in ODD and worktree/edit. Exact: "[Image#10] en odd tunea el listado, como es separada con - ya tienes un formato para diferenciar, tambien asi mejora el salto de linea y no corta frase/palbras a la mitad cuando son muy extensas. (en odd y edit worktree claro)"

S18. Investigate and improve opening latency in large repositories for own plugin commands, with bounded evidence and no host tuning. Exact: "tambien en repos enorme demora mucho abrir comandos como odd, warp, issues, worktree. Hay que ver eso igual."

## Tasks

T1 | S4 | route: RED6, GREEN61/61+49/49; parent source/docs; independent110/110+108checks no blockers, keyboard always-confirm/dirty+ahead/cancel-safe; physical dialog and scoped native/delivery tracked T10 | status: done | commit: pending isolated safety slice
T2 | S3 | route: delivered118/118 but extra historical .odd and duplicate extension hook not accepted; correction mvlk9si4-g-elm1 removes fifth spelling; parent integration and independent filesystem verification pending | status: in_progress | commit: none
T3 | S1,S5,S8,S14,S17 | route: shared geometry/wrap + ODD delivered RED14 then GREEN77/77, parent77/77; Issues/detail/keys integration and doc updates pending, not whole-task done | status: in_progress | commit: none
T4 | S9,S13,S15 | route: view delivered112/112, parent reviewed; continuation mvljthdx-e-hpth owns public command All/query, debounce, fixed empty marker and shared preview integration; no integrated GREEN yet | status: in_progress | commit: none
T5 | S10,S11 | route: view worker112/112 includes immediate saving gate and caret; preserve through continuation mvljthdx-e-hpth, parent integration/async verification pending | status: in_progress | commit: none
T6 | S2,S6,S16 | route: view delivered129/129 repeated by parent; headers/warp ids+names/comments helper; actual Issues helper reuse/includeMetadata wiring assigned to mvljthdx-e-hpth, not end-to-end verified | status: in_progress | commit: none
T7 | S7 | route: RED5 then GREEN46/46; parent source readback + public integration98/98 (create/cancel/bottom mount), docs updated; physical host proof remains T10 | status: done | commit: pending behavior slice
T8 | S12 | route: renderer5-tool matrix delivered111/111 repeated by parent; model-facing content, assigned-vs-discovered ODD contract and docs still pending; not wholeS12 done | status: in_progress | commit: none
T9 | S18 | route: map found serial pre-mount detail waits; worker mvlk4vcp-f-emtv adds view apply/loading/lifetime seam; extension progressive wiring waits for Issues owner, no latency result yet | status: in_progress | commit: none
T10 | S1-S18 | route: integrate, spec-by-spec checks, independent high-risk verification, full suite and real-host proof where available | status: pending | commit: none

## Log

L1. Original user request, verbatim (screenshots supplied inline as Image#1–Image#11):

pero no habiamos dicho ctrl+shift j/k, asi lo hace pi nativo no? como lo para buscar file. Ademas que el keybinding sale siempre ctrl j/k y no segun el sistema, por lo que el usario no sabe cual es realmente a veces.

Tambien en warp sale odd 1, y deberia salir el nombre del odd, no la cantidad.

Tambien al crear un worktree con comando o tool agente copia archivos como env, hay que agregar que si existen en main copie tambien .agents/ y .pi/ .

En warp, la tool de borrar con keybinding es instantaneo y habiamos dicho que siempre debe pedir confiormacion, no recuerdas? ademas de que en caso de tener cambios sin comitear o commits adelantedso a main lo mencione en el mensaje de confimacion.

[Image#1] tambien revisar tamanos de comando issues, odd y worktree edit. QUe sean consistente todos mismo tamano izq/der. La der debe ser mas grande diria que 40/60, y recordando que en listado izquierod siempre se vea titulo completo, si no alcanza en uan linea se extiene a 2 ese campo del listado.

[Image#2] en detalle de worktree el odd solo debe ser el nombre no el path. En listado de issues, la issues van con #, serai #76, #77. Tambien con :, seria odd: nombre, o issues: #76, $78.
Y hamos dicho que issue es la segunda linea y odd la tercera. Si no tiene issues u odd queda con - . (En warp igual, no poner issues 0 u odd 0 sino que como -, seria como null por decirlo).

[Image#3] en create dijimos que seria como worktree, con tab de type|name, y los pusiste juntos. [Image#4] y en la preview no lo pongas en rojo, ponlo vacio y que aparezca cual seria tras complentar ambos campos type y name.

en los comandos fullscreen odd, issues y worktree/edit por lo que se ve en la imagen caben mucho mas de 20 por page, cuantos definiste por page? como lo calculaste? necesitamos un valor real para que calce bien con el taamno cuando este completo, no un valor adivinado o aleatorio.

Tambien como se cargan la issues y odd cuando son muchos, si las carga todas, por paginas, cache. Como las mantiene actualizdas/refresca. COmo seria con el search en esas, si no estan todas cargadas como busca bien?

en issues cuando modifico labels, assing, comment, etc. cuando le doy guardar no es instantaneo, o sea, le doy al tajo y me deja serguir moviendo e intereactuando, da mal ux al usuario, no sabe si esta cargando y piensa que no funciono al poder moverse, esta terrible.

[Image#5] el commenct dijomos que le faltaba un focus, como este [Image#6] sino como sabra donde estap osicioando el texto.

no entiendo si redactaste mal los odd o revistaste mal que se te paso todo esto mal siendo que lo definimos.

[Image#7] tambien hay que revisar el formato de las salidas de todas las tools del agente en formato compacto y extendido. En compacto debe mostar solo lo preciso para saber que funciono y que hizo, en extendido el detalle y ordenando con formato, salto de lineas, que sea legible no como en la imagen, y esa solo era una tool hay que revisar y corregira todas. Ademas de msotrar solo la info necesaria para el agente, para optimizar token, si no aporta valor al agente o no le sirve/usara esta demas.
 
EN issue igua,l no entiendo porque cada que hago un tab entre issues, assign , involved, vuelve a refrescar y sale loading, entorpece la ux y es lentismo. [Image#8] tampoco entiendpo que la page sale ahi, no tieen sentido, las page irian fijas, o abajo del todo (arriba de keybinding). esto en todo, issues, odd, worktree, es diseno basico.

tambien en repos enorme demora mucho abrir comandos como odd, warp, issues, worktree. Hay que ver eso igual.

[Image#9] en odd ni sale las page, pero si esta paginada, asi que hay que arregarlo y revisar las otras, que salga siempre abajo las pages.

Tambien en comando issues agrega un 4 tab al final que sea "All" que muestre todas las issues open, listado.

En vista edit worktrre igual la preview de issue esta imcompleta, debe ser igual a issues, con el assign, comentarios y los datos que tenga. (por lo que vi faltan los comentarios).

[Image#10] en odd tunea el listado, como es separada con - ya tienes un formato para diferenciar, tambien asi mejora el salto de linea y no corta frase/palbras a la mitad cuando son muy extensas. (en odd y edit worktree claro)

[Image#11] de hecho puede dejar page arriba, al lado de search como en edit worktree, asi queda fija en todas, sigue un estilo, nose porque lo haces diferentes, debe ser consistente todos los comandos. en worktrre igual cuando esta en search no se actualiza abajo las teclas como en issues, cero consitencia en disenos. revisa todo puede haver mas errores asi u de otros tipos, pero que sean consistentes.

L2. Exploration (source evidence, not runtime reproduction): shared paneWidths is50/50 while ODD bypasses it with32%/34-column cap. wrapLabel splits only whitespace then hard-cuts hyphenated names. Issues page marker is appended to list; tab switch always refetches despite loaded flag. Search only filters current loaded page and request.query is ignored by wiring. Mutation functions have no pending gate/caret. Worktree issue detail lacks comments/metadata; header order/path/counts contradict request. Creation renders both fields and red incomplete previews. Native Ctrl+Shift binding unverified in repository dependency; do not infer OS behavior. No source changes yet. Separate safety/hooks/tool-output map pending.

L3. User correction, verbatim: "nada de symlinks, sera copias, .claude igual. ademas esto es solo si esta git ignoradas claro, pues sino al crearlo ya se llevan". S3 and T2 reopened/updated before accepting any prior result: .agents/.pi/.claude copy only when Git-ignored, independent destination, never overwrite; no symlink retention for those dirs. ODD shared-storage policy is an unresolved scope question, not silently changed. No task from this round has passed verification yet.

L4. Follow-up user text verbatim: "no, mejor si dejemosla como symlinks, no lo modifiques, .agents, .pi. .claude, odd/ todos sin symlinks de main, solo cuando esten git ignoradas". Parent asked a closed clarification because first/last clauses conflicted. User explicitly selected: "Las cuatro como symlinks hacia main". Final S3 applies to .agents/, .pi/, .claude/, odd/: symlink to principal only when Git-ignored; no copies, no overwrite of existing destinations. T2 worker paused with zero edits and no tests; reanudation must implement this final contract, not any earlier copy policy.

L5. Verified intermediate evidence, not overall acceptance: T7 Type/Name tabs+neutral preview parent integration98/98 exit0 (panel, warp selector, detail command); docs/warp-create-feedback.md updated. T3 shared40/60/hyphen wrap+ODD page marker parent77/77; detail/Issues/keys still incomplete. T1 keyboard always-confirm delivered61/61 and direct-agent-close49/49 preserve; parent read source; risk item1 deletion requires independent verifier mvljnjzz-b-poid (running). Native assess unavailable for mixed/untracked worktree; no native approval/receipt. Source-counts/tests are not real-host screenshot evidence.

L6. Read-only T9 map: openWorktreeDetail serially awaits assignment verification/persistence, whole open-issue snapshot prime, checkout facts and TUI import before custom mounts; cold detail is the primary contained opening-latency candidate. Warp facts enrichment and Issues first-page fetch are already after mount; do not reimplement them. Proposed T9 fix: mount stored/local/cache-only data, honest loading status, then progressive independent enrichment guarded by view lifetime; disable unsafe save until initial association/list evidence settles and preserve hidden assignments. No live timings or speed percentage measured. Coordinate after T6 view and T4 extension writers return. Official public Pi keybinding docs (https://pi.dev/docs/latest/keybindings) list fullscreen PgUp/PgDn, Ctrl+J newline, not CtrlShiftJ/K default; shared keyboard implementation remains pending.

L7. Plan reconciliation after deliveries: T6 source/helper read and parent129/129 focused (detail, warp-view, shared-preview); issue-preview helper is not yet actually reused by Issues, so T6/S16 remains open. T4 continuation owns actual includeMetadata and shared helper integration alongside All/query/debounce. T8 rendering half parent111/111 and source read: compact/expanded all5 tools covered, model text still raw and list details odd remains AVAILABLE docs, not assigned; do not mark allS12 complete or invent assigned odd from first discovered item. T9 followup worker mvlk4vcp-f-emtv implements ONLY view apply/loading/lifetime contract; extension serial waits still present until next integration. No overall unit commits or real-host acceptance in this round yet.

L8. T1 independent verifier mvljnjzz-b-poid: MET, no blockers; isolated110/110 tests plus108/108 public command/helper checks, baseline c3f2895 reproduced both keyboard YOLO bypasses and missing ahead warning. Candidate always asks both routes; cancel/missingUI/helper/unreadable evidence never deletes; localmain explicit (origin/main not silently substituted); dirty+ahead both disclosed; one dialog and one guarded close after Yes; protected/current/principal/unregistered safe. Agent direct close unchanged. Malformed helper values outside actual production contracts are advisory only, not a correction task. No real-host dialog/visual claim. Risk item1 verified independently; unit commit and scoped native assessment remain in T10, previous mixed/untracked assessment was unavailable and not approval.

L9. Delivery shape explicitly selected by user: "Cadena desde una rama de feature (recomendado)". delivery_strategy=auto-chain; chain_strategy=feature-branch-chain; no push/PR/merge authorized by this shape. One cohesive behavior per slice with tests/docs: creation tabs; layout+ODD; deletion safety; ignored project links; Issues dataset/mutations; worktree preview/progressive loading; tool output. Shared-file changes assigned to their owning unit, not mixed into arbitrary commits. Some connected units exceed ~400 authored lines (tests included); keep smallest honest split and report sizes rather than omit coverage or compress code. Verify actual default before building branch stack.

L10. T2 delivered118/118 on shared hooks, but final S3 remains open: worker retained .odd as unsolicited fifth compatibility spelling and existing extension step(k) still duplicates new hook. Followup mvlk9si4-g-elm1 removes .odd (final four .agents/.pi/.claude/odd), then parent removes duplicate invocation/obsolete details plumbing after Issues writer frees extension. No legacy aliases, destructive occupied-target replacement or directory-copy implementation accepted. Independent filesystem verification follows final integration.
