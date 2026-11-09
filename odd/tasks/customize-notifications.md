# Customize: separate the Moshi channel from Herdr agent notifications

Stop the `Herdr Sidebar` category from carrying a second `Notifications` row that writes the Moshi channel's flag, and keep a single Pi command.

Changed areas: `lib/customize-panel.js` (panel categories and layout) and `README.md` / `DESIGN.md` (documented panel shape), with the command surface pinned by the test suite.

## Specs

S1. «herdr moshi esta demas, nunca lo pedi» — the package registers exactly one Pi command, `herdr-gentle:customize`. No `herdr-gentle:moshi` command exists in this repository and none is reintroduced; a test pins this.

S2. «no confunfas/mezlces notificaciones de moshi con las de los agentes de herdr para done/ask, ahi al desactivar notificacione agentes apaga las de moshi» — the `Herdr Sidebar` category of the customize panel shows exactly one switch, `Sidebar agent rows`. It has no notification row, and applying that switch neither reads nor writes the Moshi flag file `gentle-moshi.json`.

S3. The only Moshi switch lives in the `Moshi notifications` category, keeps writing `<state dir>/gentle-moshi.json` (`{"enabled":bool,"updatedAt":iso}`), keeps the existing enable gate and Pi `extensions` exclusion behavior, and never touches the managed sidebar rows. Default stays Off.

S4. The description/help line for the `Herdr Sidebar` category describes managed agent rows only and mentions no Moshi channel.

## Tasks

T1 · S2,S4 · lib/customize-panel.js · <commit>
T2 · S1,S2,S3 · tools/*.test.js · <commit>
T3 · S2,S4 · README.md, DESIGN.md · <commit>

## Log

L1: «[Image#1] sigue mal, no arreglaste lo que te pedi, primero es herdr moshi esta demas, nunca lo pedi. [Image#2] [Image#3] segundo y te lo repetdi varias veces que no confunfas/mezlces notificaciones de moshi con las de los agentes de herdr para done/ask, ahi al desactivar notificacione agentes apaga las de moshi, nada que ver, y te lo repeti, no recuerdas?»

L2: «sigue mal las notificaiones»
