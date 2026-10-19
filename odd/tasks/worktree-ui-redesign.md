# Worktree UI redesign — one-line keys, bottom-panel warp, full-screen detail

Feature branch `feat/worktree-ui-redesign`. One thread: the warp surface, the
worktree detail, the issues/odd viewers and the worktree data model.

## Specs

S1. `/herdr-gentle:issues` must be discoverable and must open without error.
Verbatim: "el comando de issues no aparece, hay un error ahi."

S2. Every key legend/hotkey line in every surface occupies exactly ONE terminal
row. Verbatim: "las hotkeys en todas las opciones y vista debe sear en una linea
no en 2 ni 3. Arregla eso en todo, customize, odd, issues, warp." A legend that
does not fit is compacted/truncated on that one row; it never wraps to rows 2-3.

S3. The warp is no longer a popup. Verbatim: "ya no sera un popup, lo
revertiremos a lo de antes recuerdas? que aparecia abajo." It renders as a
bottom panel like gentle-shell's YOLO option.

S4. Warp panel layout, verbatim:

```
warp
<current worktre>
<data current worktree>

wortree 1
worktree 2
...
worktre 5
view all worktrees (optional)

<data focus worktree>
<hotkeys>
```

S4a. Line 1 is the title `Warp`. Line 2 is the current session's worktree. Line
3 is that worktree's data (branch, changes, commits ahead/behind, created,
modified). Verbatim: "arriba saladra que es (Warp) seguido de la current session
(el worktree actual) y abajo en otra linea su info (branch, changes, commits
adelanteo/atrasado, created, modified)."

S4b. The list shows at most 5 entries, most recently modified first, with the
principal always first when it is not the current worktree. Verbatim: "muestra
maximo 5 (los mas actuales modificados, con el principal siempre primero si no
es el current)."

S4c. A final `view all worktrees` row appears only when at least one worktree is
not shown in the list; when every worktree fits, neither the row nor its hotkey
appears. Verbatim: "Si hay mas de 6 se agrega la opcion al final de view all (si
son 5 o menos no aparece opcion ni su hotkey/atajo abajo)."

S4d. Below the list, the focused worktree's data, then the hotkeys.

S5. `view all` opens the full list with an always-active search, the same
interaction as gentle-shell's `/command`. It lists every worktree. Verbatim:
"que cambia donde vemos todos en el cual tiene un search auto (como el de
/command de gentle shell), ahi saldrian todo los worktrees (hay que ver si lo
paginamos segun la cantidad de a 5 o si es posible un scroll infinito, mostrar 6
y con scroll ir alternando)."

S6. Creating a worktree is a hotkey (`c`), not a list option, and it happens in
the same bottom panel. It asks for the change type (feat, fix, ...), then the
change name, then creates. Issue and ODD selection are removed from this UI.
Verbatim: "Tambien cambiaremos create worktree, no sera una opcion sino que sera
con hotkey, la c diria, y seria como antes que aparece abajo igual, con pasos,
primero elegimos el tipo de cambio (feat, fix, etc) y luego ingresamos el name
del change y se crea (lo de elegir issues y odd lo sacaremos de esa ui, solo tipo
y nombre para crear)."

S7. Detail/edit is a hotkey (`e`) on the focused worktree inside the warp, and it
is full screen, never a popup. Verbatim: "Y para ver detalle/editar sera con
hotkey igual e dentro del warp en el focus y aqui ya no abrira un popup sino que
sera fullscreen el detalle del worktree."

S7a. Shape: the same surface as the issues view, with two tabs. Verbatim: "sera
igual que la vista de issues. Con los 'tabs' solo que env vez de mi issues,
assiggned sera 'issues' y 'odd', donde izquierda el listado y derecha la
preview."

S7b. Header: worktree name, path, and its data (current branch, changes,
commits, created, modified). Verbatim: "Arriba saldra el nombre del worktree,
path y los datos (brach actual, changes, commits, created, modified)."

S7c. The issues tab offers a toggle; selected issues come first, then the rest in
descending issue-number order, and only open issues are listed. Verbatim:
"Ademas de dar la opcion de toogle para las issues (en esta parte de las issues
seleecionada aparecen primero y luego en orden de numeracion de las mas
reciente, ademas solo aparecen las abierta)."

S7d. A worktree can never keep a closed issue assigned. On entering the list the
assigned issues are re-verified; a closed or deleted issue is dropped from the
assignment. Entering that worktree's detail re-checks again. Verbatim: "Los
worktree no puede tener una issue close asignada al entrar el listado se asegura
que sus issue asignada esten open, si alguna paso a close o se elimino lo saca
de sus asignada (al entrar al detalle se comprueba eso denuevo para ese worktree
por si cambio)."

S8. A worktree has exactly one associated ODD document, never several. Verbatim:
"los worktree solo pueden tener 1 odd asociado no varios, pues la idea es que era
un worktree por odd a trabajar, si cambia se deberia actualizar el worktree a
otro odd pero no ponerle varios a la vez." Editing uses a select of the active
ODD, not a toggle: "en edit de wortree igual no seria un toggle sino como un
select para cambiar el odd activo si desea."

S8a. The agent tool `worktree_upsert` accepts only one ODD file. Verbatim: "La
tool del agente de worktree upsert igual solo permite un archivo odd claro."

S9. Worktree listings order: principal path first, then the current worktree,
then the rest. Verbatim: "La del listado de worktree debe mostrar siempre primero
el worktree o mas bien path principal, seguido del current y luego los demas
(aunque si el current es el principal por obiedad se pone ahi al principal
current)."

S10. Issues caching. At session start all open issues load into a cache (used to
validate worktree assignments); each `/herdr-gentle:issues` open fetches only the
newest margin (last 10-20) and merges into the cache. Verbatim: "podriamos hacer
que al inciar cargue y cachee todas las abiertas (se usaran para ver si cerro
alguna de la lista de worktree), luego cada que se abree el comando /issues se
buscan nuevas no todas (quizas un margen de las ultimas 10 o 20) y se combinan
con las que teniamos en cache para tenerlas todas y actualizar cache (asi se
reduce carga consulta y aumenta velocidad)."

S10a. The issues view shows only open issues; the open/closed toggle is removed.
Verbatim: "en vista issue quita lo de ver o alternar a cerrada, sera solo para ver
las abiertas."

S10b. Issues and odd views are read-only with respect to worktree association: no
toggle/select related to worktrees. Verbatim: "Tambien en vista issue y odd quita
lo de toggle/select relacionado a worktree, seran solo de lectura (con issues
tiene mas claro, como comentar, etc)."

S11. New command `/herdr-gentle:worktree` opens the S7 detail for the current
worktree. Verbatim: "Agregar un nuevo comando de /herdr-gentle:worktree. Que nos
abrira la opcion de edit que agregamos al warp pero del worktree actual/current."

S12. `created` and `modified` must be derived honestly and rendered as relative
ages (`1d`, `2hr`, `1w`, `1m`), never absolute dates. Verbatim: "el principal
podria ser cuando comenzo el proyecto git, y modified el ultimo commit), y en
worktrees (cuando se creo ese worktree, nose si hay registro git de eso o deberia
ser la carpeta, y modified cuando se modifico/trabajo por ultima vez se modifico
un archivo, creo, etc). No en formato fecha sino hace cuanto, hace 1d, 2hr, 1w,
1m."

S13. The odd view must stop repeating the same data. Verbatim: "se repite misma
data, basta con una vez, dicer 6 documents 2 veces, se repite arriba y abajo que
T es para seearch, dentro de search luego se repite que salir es con esc. Se
repite el nombre arriba del focus, podria ir arriba del todo a la derecha de odd
o sacarlo pues esta el focus. Revisa detalles asi igual en issues comando."

S14. Changes must carry tests and docs alongside the behavior, and must keep the
existing suite green.

S15. Scrolling the preview with `ctrl+j`/`ctrl+k` must work, and a platform
variant must exist when the terminal does not deliver those keys. Verbatim:
"el scroll con tecla ctrl jk no sirve, en gentle shell changes lo tenia, revislao.
Podria ser por linux igual quizas, podriamos como con ctrl f y ctrl shift f,
quizas revisarlo y si es eso agregar variante para linux".

## Tasks

T1 — S1. Reproduce and fix the `/herdr-gentle:issues` failure. Commit: see Log.
T2 — S2. One-row key legends in customize, odd, issues and warp. Commit: see Log.
T3 — S3/S4. Warp as a bottom panel with the S4 layout. Commit: see Log.
T4 — S5. `view all` list with always-active search. Commit: see Log.
T5 — S6. Create by `c` hotkey with type + name steps only. Commit: see Log.
T6 — S7/S7a/S7b. Full-screen worktree detail with issues/odd tabs. Commit: see Log.
T7 — S7c/S7d/S10. Open-issues cache, assignment revalidation, open-only listing. Commit: see Log.
T8 — S8/S8a. Single ODD association in the registry, the select, and `worktree_upsert`. Commit: see Log.
T9 — S9/S12. Listing order and relative created/modified. Commit: see Log.
T10 — S11. `/herdr-gentle:worktree` command. Commit: see Log.
T11 — S13. Odd/issues duplicated-data cleanup. Commit: see Log.
T12 — S14. Full suite and docs.
T13 — S15. Preview scrolling works with `ctrl+j`/`ctrl+k` plus a platform
variant. Commit: see Log.

## Delivery

This feature is far larger than one review slice, so it ships as a chain of
PR slices on `feat/worktree-ui-redesign`; each slice is a small group of
tasks, each task is one work-unit commit, and a slice closes when its tests
and docs are in.

- Slice 1 — T1/S1, T2/S2, T13/S15: key legends, the issues gate message,
  preview scroll variants. (commits: 04e18de, 4d9c643, 3c023f6, plus T1 and
  T13)
- Slice 2 — T3/S3-S4, T4/S5: warp as a bottom panel and the `view all` list.
- Slice 3 — T5/S6, T10/S11: create by hotkey, `/herdr-gentle:worktree`.
- Slice 4 — T6/S7-S7b: the full-screen worktree detail with issues/odd tabs.
- Slice 5 — T7/S7c-S7d, S10: the open-issues cache and assignment
  revalidation.
- Slice 6 — T8/S8-S8a, T9/S9, S12: one ODD per worktree, listing order,
  relative ages.
- Slice 7 — T11/S13, T12/S14: duplicated data, docs, and the shared
  `legendText` consolidation.

## Log

L1. Verbatim request:

"""
el comando de issues no aparece, hay un error ahi.

primero las hotkeys en todas las opciones y vista debe sear en una linea no en 2 ni 3. Arregla eso en todo, customize, odd, issues, warp.

haremos varios cambios a warp, primero ya no sera un popup, lo revertiremos a lo de antes recuerdas? que aparecia abajo. /tmp/gpuAirSF/pi-clipboard-78edf443-5d81-48c0-bfc2-7394793685de.png /tmp/gpuAirSF/pi-clipboard-cb77f977-f76c-44ec-8235-344c478c3f67.png coo la opcion de yolo de gentle-shell.  Primero funcionara parecido, arriba saladra que es (Warp) seguido de la current session (el worktree actual) y abajo en otra linea su info (branch, changes, commits adelanteo/atrasado, created, modified). muestra maximo 5 (los mas actuales modificados, con el principal siempre primero si no es el current). Si hay mas de 6 se agrega la opcion al final de view all (si son 5 o menos no aparece opcion ni su hotkey/atajo abajo), que cambia donde vemos todos en el cual tiene un search auto (como el de /command de gentle shell), ahi saldrian todo los worktrees (hay que ver si lo paginamos segun la cantidad de a 5 o si es posible un scroll infinito, mostrar 6 y con scroll ir alternando).

warp
<current worktre>
<data current worktree>

wortree 1
worktree 2
...
worktre 5
view all worktrees (optional)

<data focus worktree>
<hotkeys>

Tam bien cambiaremos create worktree, no sera una opcion sino que sera con hotkey, la c diria, y seria como antes que aparece abajo igual, con pasos, primero elegimos el tipo de cambio (feat, fix, etc) y luego ingresamos el name del change y se crea (lo de elegir issues y odd lo sacaremos de esa ui, solo tipo y nombre para crear).

Y para ver detalle/editar sera con hotkey igual e dentro del warp en el focus y aqui ya no abrira un popup sino que sera fullscreen el detalle del worktree y sera igual que la vista de issues. Con los "tabs" solo que env vez de mi issues, assiggned sera "issues" y "odd", donde izquierda el listado y derecha la preview. Arriba saldra el nombre del worktree, path y los datos (brach actual, changes, commits, created, modified). Ademas de dar la opcion de toogle para las issues (en esta parte de las issues seleecionada aparecen primero y luego en orden de numeracion de las mas reciente, ademas solo aparecen las abierta). Los worktree no puede tener una issue close asignada al entrar el listado se asegura que sus issue asignada esten open, si alguna paso a close o se elimino lo saca de sus asignada (al entrar al detalle se comprueba eso denuevo para ese worktree por si cambio).

Otro cambio es que los worktree solo pueden tener 1 odd asociado no varios, pues la idea es que era un worktree por odd a trabajar, si cambia se deberia actualizar el worktree a otro odd  pero no ponerle varios a la vez. Asi que en edit de wortree igual no seria un toggle sino como un select para cambiar el odd activo si desea.

La tool del agente de worktree upsert igual solo permite un archivo odd claro. La del listado de worktree debe mostrar siempre primero el worktree o mas bien path principal, seguido del current y luego los demas (aunque si el current es el principal por obiedad se pone ahi al principal current).

Mejora igual las issues y su lista, podriamos hacer que al inciar cargue y cachee todas las abiertas (se usaran para ver si cerro alguna de la lista de worktree), luego cada que se abree el comando /issues se buscan nuevas no todas (quizas un margen de las ultimas 10 o 20) y se combinan con las que teniamos en cache para tenerlas todas y actualizar cache (asi se reduce carga consulta y aumenta velocidad). Ademas que en vista issue quita lo de ver o alternar a cerrada, sera solo para ver las abiertas. Tambien en vista issue y odd quita lo de toggle/select relacionado a worktree, seran solo de lectura (con issues tiene mas claro, como comentar, etc). Y agregar un nuevo comando de /herdr-gentle:worktree. Que nos abrira la opcion de edit que agregamos al warp pero del worktree actual/current.

Tambien revisa bien en detalle de worktree el tema de created y modifidied como obtener esos datos y mostrarlos (el principal podria ser cuando comenzo el proyecto git, y modified el ultimo commit), y en worktrees (cuando se creo ese worktree, nose si hay registro git de eso o deberia ser la carpeta, y modified cuando se modifico/trabajo por ultima vez se modifico un archivo, creo, etc). No en formato fecha sino hace cuanto, hace 1d, 2hr, 1w, 1m.

En vista odd igual /tmp/gpuAirSF/pi-clipboard-8fe3ca6a-f46d-4b78-8d3e-153392d5ce83.png se repite misma data, basta con una vez, dicer  6 documents 2 veces, se repite arriba y abajo que T es para seearch, dentro de search luego se repite que salir es con esc. Se repite el nombre arriba del focus, podria ir arriba del todo a la derecha de odd o sacarlo pues esta el focus. REvisa detalles asi igual en issues comando
"""

L2. Interpretation decision: S4c's two thresholds ("mas de 6" / "5 o menos") are
reconciled as one rule — the `view all` row appears if and only if at least one
worktree is not shown in the list (current = 1 row + list = 5 rows = 6 shown).

L3. Verbatim request (S15):

"""
otro detalle que me falto mencionar es que el scroll con tecla ctrl jk no sirve, en gentle shell changes lo tenia, revislao. Podria ser por linux igual quizas, podriamos como con ctrl f y ctrl shift f, quizas revisarlo y si es eso agregar variante para linux
"""

L4. Evidence for S15: with the real `matchesKey` from `@earendil-works/pi-tui`
1.3.0, `lib/odd-view.js` does scroll for `\n` (ctrl+j), `\x0b` (ctrl+k) and the
Kitty CSI-u forms (`\x1b[106;5u`, `\x1b[107;5u`). The view is therefore not the
defect; the delivery of those bytes is terminal-specific, which is why S15 asks
for a variant rather than a repair.

L5. Baseline facts recorded before T3. Full suite on this branch: 1707 tests, 1704
pass, 3 fail. Two of those failures reproduce identically on `main` (b8d4910) and
are therefore pre-existing, not caused by this thread:
- `tools/worktree-hooks.test.js` "copies present+untracked candidates, refuses
  tracked / missing-source / existing-target"
- `tools/worktree-close.test.js` "a dirty checkout without force is refused with
  the repository reason"
The third (S15 scroll test) is T13's in-flight RED and clears when T13 lands.
T12's S14 verdict must report these two as pre-existing rather than green, or this
thread must fix them explicitly.

L6. S3 implementation decision. gentle-shell's YOLO option renders through
`ctx.ui.setWidget()`, which is persistent display-only content and cannot
receive keys; the warp must take keys (`↑↓`, `enter`, `c`, `e`, `v`, `esc`), so
it stays a `ctx.ui.custom()` overlay and only its geometry changes: anchored
`bottom-center` at full width instead of `center` at 70%. It therefore looks
like a bottom panel while remaining focusable. Recorded so T3 does not try to
rebuild it as a widget.
