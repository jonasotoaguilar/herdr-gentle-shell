# Theme sync — Herdr palette follows the active Gentle Shell / Pi theme

Feature branch `feat/theme-sync`, worktree `herdr-gentle-shell-worktrees/theme-sync`.
Behaviour lives in the Pi extension (`lib/`, `extensions/`) and in the Herdr plugin's config writer
(`herdr-plugin/lib/`, `herdr-plugin/bin/`); the switch lives in `/herdr-gentle:customize`.

## Specs

S1 — A switch in `/herdr-gentle:customize` turns the theme synchronisation on and off.
Quote: "venga con un swithc en /herdr-gentle:custimize para apagar/prender esta sincronizacion".

S2 — The sync comes turned OFF by default.
Quote: "el sync de tema vendra apagado por defecto".

S3 — With the sync ON, Herdr's palette is the palette of the theme that is active in Gentle Shell / Pi,
and it follows a change of the active theme while Pi keeps running.
Quote: "sincronizar la paleta de colores actual de herdr con la que tengo activa en gentle shell/pi".

S4 — With the sync OFF the user can assign one specific theme from the Gentle Shell / Pi themes; the
theme selection is only available while the sync is off.
Quote: "para asignarle un tema especifico de los de gentle shell -pi (la seleccion de tema solo deberia dejar/habilitarse si sync esta desactivado claro)".

S5 — Herdr keeps the last palette that was applied when Pi closes.
Quote: "(La paleta se mantendria supongo la ultima seleccionada si cierro pi)".

S6 — The feature is integrated in this repository and its plugin (not a second package).
Quote: "quiero intregrarla en este repo/plugin".

S7 — Derived from S1/S2: with the sync off and no theme assigned, the package writes nothing to Herdr's
theme configuration, so the default install leaves Herdr's palette untouched.

## Tasks

| ID | What | Specs | Route |
| --- | --- | --- | --- |
| T1 | Pi-side theme catalogue + Herdr palette projection (`lib/theme-projection.js`, `tools/theme-projection.test.js`) | S3, S4 | writer |
| T2 | Herdr plugin managed `[theme]` block writer (`herdr-plugin/lib/gentle-theme-config.js`, `herdr-plugin/bin/configure-theme.js`, `tools/gentle-theme-config.test.js`) | S3, S5 | writer |
| T3 | `/herdr-gentle:customize` category + extension apply path + theme watch (`lib/customize-panel.js`, `lib/theme-sync.js`, `extensions/gentle-herdr-state.ts`, `tools/gentle-customize-command.test.js`, `tools/customize-panel.test.js`) | S1-S5, S7 | inline |
| T4 | Docs: README, DESIGN.md, `docs/theme-sync.md` | S6 | inline |

## Log

L1 (user, verbatim): "/home/jona/dev/upstream/gentle-herdr me gustaria integrar una nueva funcionaldidad la cual lo que haga sea sincronizar la paleta de colores actual de herdr con la que tengo activa en gentle shell/pi. (La paleta se mantendria supongo la ultima seleccionada si cierro pi). AHi te mande un ejemplo, quiero intregrarla en este repo/plugin, ademas de que venga con un swithc en /herdr-gentle:custimize para apagar/prender esta sincronizacion o para asignarle un tema especifico de los de gentle shell -pi (la seleccion de tema solo deberia dejar/habilitarse si sync esta desactivado claro), el sync de tema vendra apagado por defecto"
