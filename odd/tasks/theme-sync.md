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

| ID | What | Specs | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Pi-side theme catalogue + Herdr palette projection (`lib/theme-projection.js`, `lib/theme-store.js`) | S3, S4, S7 | writer | 681ae7a |
| T2 | Herdr plugin managed `[theme]` block writer (`herdr-plugin/lib/gentle-theme-config.js`, `herdr-plugin/bin/configure-theme.js`) | S3, S5 | writer | 9c77445 |
| T3a | `/herdr-gentle:customize` `Herdr Theme` category + state wiring (`lib/customize-panel.js`, `extensions/gentle-herdr-state.ts`) | S1, S2, S4, S7 | writer | 61b35ca |
| T3b | Follower extension (`extensions/herdr-theme-sync.ts`, `package.json`) | S3, S4, S5, S7 | writer | c1459d4 |
| T3c | Verifier findings: quoted `["theme"]` refusal, `Off`-named theme pinnable, real-writer S7/S5 proofs | S3, S4, S5, S7 | writer | 61b35ca, c1459d4 (same slices) |
| T4 | Docs: README, DESIGN.md, `docs/theme-sync.md` | S6 | writer | b79e10d |

Slice boundary: the feature is 4548 authored changed lines across the five commits above,
which is past the ~400-line review slice. The bounded slices are the five commits
themselves; T2's `configure.js` change and T3a's shared renderer change are each alone
inside their commit so review can take them separately. Delivery shape (one PR or a
chain) is the human's decision at publish time.

Evidence: `node --test tools/*.test.js` -> 970 tests, 152 suites, 970 pass, 0 fail,
`NODE_EXIT=0`. Differential against `main@39bc045`: 48 CLI cases and 24 panel renders,
0 differences. Independent verifier (`gentle-ai-verify`) could not execute its probes
in this environment (its preparer refuses a linked worktree); its inspection findings
were fixed in T3c and its own regression sketches were added as tests.

## Log

L1 (user, verbatim): "/home/jona/dev/upstream/gentle-herdr me gustaria integrar una nueva funcionaldidad la cual lo que haga sea sincronizar la paleta de colores actual de herdr con la que tengo activa en gentle shell/pi. (La paleta se mantendria supongo la ultima seleccionada si cierro pi). AHi te mande un ejemplo, quiero intregrarla en este repo/plugin, ademas de que venga con un swithc en /herdr-gentle:custimize para apagar/prender esta sincronizacion o para asignarle un tema especifico de los de gentle shell -pi (la seleccion de tema solo deberia dejar/habilitarse si sync esta desactivado claro), el sync de tema vendra apagado por defecto"
