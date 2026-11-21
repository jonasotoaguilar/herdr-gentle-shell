# Theme sync fix — make Herdr theme sync work and rebuild the customize panel after Gentle Shell

Follow-up of `odd/tasks/theme-sync.md` (shipped as 1.8.0). Branch `fix/theme-sync-panel`, worktree
`herdr-gentle-shell-worktrees/theme-sync-fix`. The shipped feature passed 970 tests but never ran against a real
Herdr config or the real Gentle Shell panel; the user reports it does not work and that the panel is wrong.

## Specs

S1 — The customize panel behaves like Gentle Shell's own: options are navigated, the focus highlights an option,
and only Enter confirms. Not a fixed button.
Quote: "de partida deberia ser como en gentle shell el panel de opciones donde las opciones se navega, no es un boton fijo y al anvega la focus se resalta opcion y con enter recien se confirma."

S2 — The theme list is obtained automatically from Pi and shown as an inline list of options; a list that does not
fit scrolls sideways (the user picked the second alternative, the lateral scroll).
Quote: "el listado de temas deberia obtenerlo automaticamente y mostrarlo asi, en listas, si es muy extensa se pondria mas filas o un scroll lateral, diria que segundo."

S3 — Theme sync really syncs, and assigning a theme really assigns it.
Quote: "no funciona para nada lo de temas con herdr, sincronizar temas no sincroniza ni asignar tampoco."

S4 — The reference implementation is `/home/jona/dev/upstream/gentle-herdr`; find the same error against it and fix it.
Quote: "TE pase un ejemplo listo y lo implementas mal igual /home/jona/dev/upstream/gentle-herdr, encuentra este error igual y arreglalo."

S5 — The whole Herdr customize panel is fixed, not only the theme rows.
Quote: "Y arregla todo el panel de customize herdr"

S6 — The preview matches Gentle Shell's format and follows the Gentle Shell theme, with a title and a description.
Quote: "Otro punto es la preview, mira el ejemplo, no se parecen ni en formato ni sigue el tema de gentle shell, como con titul oy descripcion"

S7 — Carried from the original feature, still binding: the sync is off by default; the theme selection is only
available while the sync is off; Herdr keeps the last palette when Pi closes.
Quote: "el sync de tema vendra apagado por defecto" / "la seleccion de tema solo deberia dejar/habilitarse si sync esta desactivado claro" / "La paleta se mantendria supongo la ultima seleccionada si cierro pi"

## Evidence (proven on the user's machine, 2026-11-19)

E1 — The user's real `~/.config/herdr/config.toml` already owns a `[theme]` table (`name = "catppuccin"`,
`auto_switch = false`) and a `[theme.custom]` synced from DMS/Niri. The shipped writer refuses any theme table
outside its markers: run against a COPY of that file it exits 2, config bytes unchanged. The managed block is absent
from the real config, so the writer never ran successfully.

E2 — The installed Herdr plugin is `Herdr Gentle Shell 1.7.0`, which has no `configure-theme.js`; the Pi package is
1.8.0. The shipped follower depends on a file of a separately installed artifact, so a Pi-only update breaks it.
The reference does everything in-process in Pi.

E3 — The state store (`~/.local/state/herdr/plugins/herdr-gentle-agents/gentle-theme.json`) holds
`{"sync": false, "theme": "TokyoNight"}`: the panel wrote the assignment, the follower never produced a result.

## Tasks

| ID | What | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Map the reference planner/apply and the real panel | S3, S4, S1, S6 | explorers | — |
| T2 | In-process writer in the Pi package: adopt an existing `[theme]`, safe write, reload, child/remote guards | S3, S4 | writer | — |
| T3 | Follower on the in-process writer, projection aligned to the reference, visible failure notices | S3, S4, S7 | writer | — |
| T4 | Panel rebuilt after Gentle Shell: option rows, focus, Enter confirms, horizontal scroll, Preview block, auto theme list | S1, S2, S5, S6, S7 | writer | — |
| T5 | Remove the plugin-side `configure-theme` CLI and fix docs | S3 | inline | — |
| T6 | Verification against a copy of the real config, full suite, differential | S1-S7 | parent | — |

## Log

L1 (user, verbatim, the original feature request): "/home/jona/dev/upstream/gentle-herdr me gustaria integrar una nueva funcionaldidad la cual lo que haga sea sincronizar la paleta de colores actual de herdr con la que tengo activa en gentle shell/pi. (La paleta se mantendria supongo la ultima seleccionada si cierro pi). AHi te mande un ejemplo, quiero intregrarla en este repo/plugin, ademas de que venga con un swithc en /herdr-gentle:custimize para apagar/prender esta sincronizacion o para asignarle un tema especifico de los de gentle shell -pi (la seleccion de tema solo deberia dejar/habilitarse si sync esta desactivado claro), el sync de tema vendra apagado por defecto"

L2 (user, verbatim, the bug report): "[Image#1] esta todo mal /home/jona/dev/upstream/gentle-shell de partida deberia ser como en gentle shell el panel de opciones [Image#2] donde las opciones se navega, no es un boton fijo y al anvega la focus se resalta opcion y con enter recien se confirma. LO segun es que como el ejemplo el listado de temas deberia obtenerlo automaticamente y mostrarlo asi, en listas, si es muy extensa se pondria mas filas o un scroll lateral, diria que segundo. Otro punto es que no funciona para nada lo de temas con herdr, sincronizar temas no sincroniza ni asignar tampoco. TE pase un ejemplo listo y lo implementas mal igual /home/jona/dev/upstream/gentle-herdr, encuentra este error igual y arreglalo. Y arregla todo el panel de customize herdr"

L3 (user, verbatim, mid-turn addition): "[Image#3] Otro punto es la preview, mira el ejemplo, no se parecen ni en formato ni sigue el tema de gentle shell, como con titul oy descripcion"

L4 (parent, delivery record). Commits on `fix/theme-sync-panel`: `ba7528e` in-process writer (planner + apply + six test files), `f192b70` follower in process + projection aligned + plugin CLI deleted, `f15ef5f` customize panel rebuilt after Gentle Shell, `1c1e96c` docs, then `chore(release): 1.8.1`. Issue #137. The slice exceeds the 800-line budget (about 10.7k changed lines, roughly 60% tests); `size:exception` requested for the same reason as #136: the libraries cannot land without the extension that consumes them.

L5 (parent, verification evidence). Full suite `node --test tools/*.test.js` with a surviving TMPDIR: 1183 tests, 201 suites, 1183 pass, 0 fail, `NODE_EXIT=0`. End to end on a COPY of the reporter's real `~/.config/herdr/config.toml` (a `[theme]` with `name = "catppuccin"` and `auto_switch = false`, a DMS-synced `[theme.custom]`), with a recording fake `herdr`: five applies (Gentleman-Sexy, TokyoNight, TokyoNight again, Sexy, name-only) gave requested, requested, unchanged, requested, requested with exactly four reloads; the final file parses with tomllib, the user's own `[theme.custom]` values are back, no stale surface token remains, `[terminal]`/`[ui]`/`onboarding` are identical, `auto_switch = false` is kept, and the only textual difference from the original is the name line plus its `was` comment. Five independent adversarial verifications (own corpora of up to 7,141 accepted outputs checked with tomllib, 2,133 mutations, 1,600 four-step sequences) disproved four earlier designs and then the final one on five point defects (E1-E5), all fixed with regression tests; a sixth verification was waived by the maintainer's explicit choice ("one last narrow pass, then publish"). Not proven: a real Pi TUI, a live `herdr server reload-config`, and the exact panel rendering in the reporter's terminal (the panel was rendered through its own module at several widths).

Known limits shipped: not a TOML validator (invalid TOML outside the theme tables is left as is), the window between the final compare and the rename cannot be closed without locking, a pre-existing truncated backup is kept, and there is no full-clear operation distinct from an empty custom projection (an inserted name line stays).
