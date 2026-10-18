# Issues viewer: read, triage and act on the project's GitHub issues

Add `/herdr-gentle:issues`: a full-screen three-page overlay (My issues / Assigned / Involved) that lists the repository's issues with a search box, shows the selected issue in full on the right (body, labels, state, author, dates, reactions, comments), and lets the reader act — assign the issue to the session checkout, edit its labels, comment, close or reopen, open it in the browser.

Branch: `feat/odd-viewer` (same thread). Worktree: `/home/jona/mnt/sv-home/dev/projects/herdr-gentle-shell-worktrees/feat-odd-viewer`. Base: `main` 10aa5f2.
Delivery: `single-pr`, decided when the units landed and recorded before the last commit: this branch carries three features (odd viewer, worktree tool rename, issues viewer plus the key-consistency retrofit) in a single PR, because they share the same extension file and the same working branch, and because each feature's units are mutually dependent — the renderer has no consumer without the view, the view has no entry point without the command. Expected label: `size:exception` with this rationale; the user may instead ask for a recut chain, which would have to split the shared extension file. Runner: `node --test tools/*.test.js` (what CI runs). Push, PR creation and merge stay with the user.

## Specs

S1. Original request, verbatim: "tambien agrega un nuevo comando que sera para ver la issues del proyecto /herdr-gentle:issues. /tmp/gp279byI/pi-clipboard-e527c182-35af-413e-98e8-cd691bd43817.png. que sera similar a changes y las demas con el panel fullscreen basado en el ejemplo de la imagen pero adaptado a nuestro diseno de paneles como el de /changes y /customizatio, la estetica de gentle-shell."

S2. User requirement, verbatim: "en la vista de issues sera 3 pagina (que se cambian con tab o quizas flechas izq/der), que sera my issues para ver todas las issues con un buscardor arribar para filtrar (debe funcionar igual que issues, con filtro usruario con @ numero, titulo y demas), en la siguiente asiggme para ver las que me asignaron y por ultimo la de involved. A la derecha debe apararecer la issue con la opcion para hacerle scroll y verla completa. (para todo esto se requiere gh cli y usuario auth asi que se debe comprobar al inicio de pi diria para habilitar la tool, para lo de create worktree igual pedia issue y buscaba requeria gh cli ahi si no esta gh cli se saltaba selector de issue creo que ya estaba asi). En la derecha como en la imagen tambien sale los comentrario separadaos (por si tiene varios). Arriba debe salir las tags que tienie y demas datos a la derecha."

S3. User requirement, verbatim: "Tambien agrega la opcion con una atajo de tecla para modificar las tag (que al darle editar apazcan el lista de las tags todas las del repo con un toggle para activar desactivar o al final para crear una nueva, tras hacer los cambios se guardan con ctrls s o algo asi y ahi se aplican con gh). Tambien una atajo para agregarle un comentario a la issue."

S4. User requirement, verbatim: "Otra aspecto es que deberian estar paginadas diria, por si son demasiadas, y que arriba u abajo salga el total. Por defecto muestra solo las abiertas, con un atajo o filtro alternas para ver las cerradas. Tambien debe estar la opcion para cerrar una issues (o para reabrira una cerrada). Igual que el ejemplo debe estar los datos como comentarios, likes y demas. cunado se creo y modifico en horas, la ultima modificacion, creador."

The list total is a bounded count: when the fetch bound is reached the totals line renders it as `N+`.

S5. User requirement, verbatim: "Tambien debe destacar las que esten relacionadas al checkpout actual (igual que odd list de worktree deja asignar varias issues o ningina) se debe destacar con icono o algo que esa esta asigna/relacionada al checkout actual, con la opcion de agregarla/quitarla y guarda cambios (igual que lo de odd). /tmp/gp279byI/pi-clipboard-80cfedbc-bc27-4816-8811-96ee32a178af.png recuerda que es un ejemplo de otra app, es una buena basse pero hay que disenarla a como esta gentle-shell. /tmp/gp279byI/pi-clipboard-8183e411-eece-4bd9-9ba9-6cf060799016.png igual debe estar para abrir la issue en el navegador entre otros atajos que tiene el ejemplo utiles."

S6. Key consistency, verbatim: "Igual revisar las diferentes vistas y atajos que usa gentle shell, como en vista customize, changes, models, agents. Para darte una idea de las keybind a usar. Igual revisa si las nuestras como cmuestetro herdr customize, /herdr-warp (y su opcion de create tambien que es como aparte dentro), /herdr-odd. Que sigan la misma combinaciones, que haya consistencia entre todas."

S7. Comment reference: the user supplied `/tmp/gp279byI/pi-clipboard-cb8e53ba-7e07-43e0-b479-7d97b4429a33.png` ("aho in ejemplo para agregar comentario, podria servir para una idea"): the reference renders an inline "Leave a comment..." block with a caret line and a key hint row. Ours is the same idea in this package's frame: a multiline input with `Enter` inserting a line, `ctrl+s` posting, `esc` discarding.

S8. Fixed key map (S6 applied to the consolidated survey of gentle-shell's changes/agents/palette/customize/stats views and this package's customize/warp/odd views). Reading keys follow the existing conventions, action keys follow the reference example where this package has no convention yet:

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | move the selection in the list |
| `tab` / `→`, `shift+tab` / `←` | next / previous page (My issues, Assigned, Involved — the `stats-view` convention) |
| `ctrl+j`/`ctrl+k`, `pgDn`/`pgUp` | scroll the issue pane |
| `home`/`end` | first / last issue in the current page |
| `[` / `]` | previous / next list page, with the totals line showing `page n/m · N issues` |
| `T` (also `/`) | open the search box above the list; typing filters live (author `@user`, `#number`, title words); `Enter`/`Esc` leave the box keeping the filter |
| `f` | toggle the state filter open <-> all/closed (S4) |
| `space` | toggle "assigned to this checkout" (S5), applied only on save |
| `ctrl+s` | save the pending assignment through the worktree registry `issues[]`, exactly the odd viewer's path and guards |
| `L` | open the label editor (S3) |
| `n` | create a new label inside the label editor |
| `c` | open the comment input (S7) |
| `x` / `X` | close / reopen the issue (S4), after the host's own confirm |
| `o` | open the issue in the browser (S5) |
| `r` | reload the current page from `gh` |
| `?` | key help overlay |
| `esc`/`ctrl+c`/`q` | close (discarding unsaved toggles, like the odd viewer) |

Reserved keys this view must not steal: `ctrl+c`, `ctrl+u`, `ctrl+d`, `alt+*` shortcuts registered elsewhere.

S9. `gh` availability is checked at session start (S2): `gh` must resolve and report an authenticated user. Without both, the command is NOT registered and one notification per session names what is missing and the command that fixes it. With them, the viewer opens. Nothing in this view may run `gh` through a shell, echo a token, or write user config. When `gh` is available, `worktree_upsert`'s optional issue picker keeps its current behavior (it already skips itself when `gh` is unavailable).

S10. Read-only versus writing: listing, search, paging, filtering, scrolling and help never write anything. Only three actions write, each after an explicit key and each reported honestly: the assignment save (registry `issues[]`), the label editor (`gh issue edit --add-label/--remove-label`, plus `gh label create` for a new label), the comment (`gh issue comment`), and the state change (`gh issue close`/`reopen`). A failed action leaves the local state unchanged and shows the error; nothing claims success.

## Module contract (fixed before implementation, so the units can land independently)

`lib/gh-issues.js` — the only place that runs `gh`. CommonJS, injectable runner, fixed argv (never a shell string), JSON parsed, never throws; every call returns `{ok:true, ...}` or `{ok:false, error}`.
- `ghStatus(opts)` -> `{ok, login, nameWithOwner}`.
- `repoInfo(opts)` -> `{ok, nameWithOwner, viewer}`.
- `listIssues({query, page, pageSize}, {fetchMax, ...opts})` -> `{ok, issues, total, truncated, page, pageSize}` (`truncated` is true exactly when the fetched count reached the `fetchMax`/`LIST_FETCH_MAX` bound); each issue `{number, title, state, stateReason, author, authorAssociation, labels:[{name,color,description}], createdAt, updatedAt, commentsCount, reactions:{total,plusOne}, url, body, isPullRequest}`.
- `getIssue(number, opts)` -> `{ok, issue, comments:[{id, author, createdAt, body, reactions:{total,plusOne}}]}`.
- `listLabels(opts)` -> `{ok, labels:[{name,color,description}]}`; `createLabel({name,color,description}, opts)` -> `{ok, label}`.
- `editLabels(number, {add, remove}, opts)`, `commentIssue(number, body, opts)`, `setIssueState(number, state, opts)` -> `{ok}` or `{ok:false,error}`.

`lib/issues-view.js` — the pure view, no `gh` and no registry: `createIssuesView({pages, issues, loadIssue, assigned, saveAssignment, actions, helpers, theme, rowsAvailable, requestRender, done})` returning the Pi component `{render(width), handleInput(data), invalidate()}` plus its state, in the same shape as `lib/odd-view.js`.

## Tasks

P1 | S1,S2,S9,S10 | implement | pending | `lib/gh-issues.js`: the whole `gh` surface above, with an injectable runner, fixed argv, JSON parsing, and honest failure shapes; unit tests over captured real `gh` JSON fixtures for every call, including unauthenticated, empty results, paging, malformed JSON and a failing runner.
P2 | S2,S3,S4,S5,S8 | implement | pending | `lib/issues-view.js`: the three-page framed view with the search box, the paginated list with a totals line, the scrolling issue pane (labels, state, author, dates, reactions, separated comments), the assignment marks, the label editor, the comment input, the confirmations, the help overlay, and the states (empty, error, gh unavailable); unit tests per rule, rendered headlessly.
P3 | S1,S9 | implement | pending | `/herdr-gentle:issues` in `extensions/gentle-worktree-tools.ts`: the startup `gh` check that gates registration, the lazy TUI seam, the full-screen overlay wiring, the registry read/save for `issues[]` (reusing the odd viewer's guarded saver), and the action callbacks; command tests over fixtures.
P4 | S3,S4,S5,S10 | implement | pending | The four writing actions end to end: label edit with create-new, comment, close/reopen, and the assignment save; each with its failure path pinned, and no write reachable without its explicit key.
P5 | S1,S6 | docs | pending | `docs/issues-viewer.md` plus the README surface row, README feature bullet and the DESIGN command enumeration; record the key map and the `gh` requirement.
P6 | S1-S10 | verify | pending | Independent verification of the writing paths (labels, comment, state, assignment) and the end-to-end read path over a real repository, plus the full suite.

## Log

L1. User request, verbatim: "tambien agrega un nuevo comando que sera para ver la issues del proyecto /herdr-gentle:issues. /tmp/gp279byI/pi-clipboard-e527c182-35af-413e-98e8-cd691bd43817.png. que sera similar a changes y las demas con el panel fullscreen basado en el ejemplo de la imagen pero adaptado a nuestro diseno de paneles como el de /changes y /customizatio, la estetica de gentle-shell."
