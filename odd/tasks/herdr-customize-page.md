# Herdr customize page — serve the four options from Gentle Shell's own `/gentle:customize`

When gentle-shell-bridge is present, the four Herdr settings stop living behind a private command and
become a page the user already opens. Without the bridge everything stays as it is today.

Read this whole document, including `## Log`, before starting a task. Specs are the source of truth;
tasks are the slices that make them true.

## Specs

When gentle-shell-bridge is present, the four Herdr settings also appear on a page the user already
opens, next to the command that keeps working. Without the bridge everything stays exactly as it was.

Read this whole document, including `## Log`, before starting a task. Specs are the source of truth;
tasks are the slices that make them true.

## Specs

- **S1.** `/herdr-gentle:customize` is ALWAYS registered, at factory time, exactly as on `865d360`.
  When gentle-shell-bridge answers its handshake (handshake, not package presence), the extension
  ALSO contributes one page titled `Herdr` to gentle-shell's `/gentle:customize` menu holding exactly
  the four options: `herd agents`, `moshi`, `theme sync`, `select theme`. Two surfaces coexisting is
  by design: the page never replaces the command, and no user can ever end up with none.
- **S2.** Without the bridge, today's surface is unchanged and byte-identical to `865d360`:
  `/herdr-gentle:customize` registered in the factory, the floating panel from
  `lib/customize-panel.js` via `ctx.ui.custom`, the `ctx.ui.select` fallback, `customize status`, and
  every message spelling untouched.
- **S3.** Each of the four rows keeps the effect and the refusal semantics of the command it
  replaces — same apply path, same writes, same "a refusal writes nothing" promise — and nothing
  else changes: `herd agents` drives the Herdr plugin's `bin/configure.js` (`--check`,
  `--apply --reload`, `--uninstall --reload`) and re-reads `--check` as proof; `moshi` runs the
  `moshi-hook` prerequisite gate before enabling and writes nothing on refusal; `theme sync` writes
  `lib/theme-store.js` and needs no Pi reload; `select theme` lists Pi's own themes plus the
  `Off (no theme assigned)` entry and is only available while sync is off.
- **S4.** No message may point at a surface that may be absent. `/herdr-gentle:customize` always
  exists, so every user-facing string keeps naming it, byte-identical to `865d360`, with no
  surface-dependent wording.
## Bridge contract facts (already established — do not re-explore)

- A customize **page is a row `category`**, not `registerSection`. `registerSection` adds a sidebar
  card plus a `Sections` toggle and carries no settings rows. Use
  `registerRows({ id, category: "Herdr", rows: () => [...] })`.
- A **toggle row** carries `choice: { setting, value, current(), hint?, applyOnMove? }`; one row per
  value; consecutive rows sharing `choice.setting` render as one line and `←/→` moves the cursor.
  The bridge forces `applyOnMove: false` on every row it contributes, so **Enter applies**.
- The row's `action(inline)` runs on Enter/Space. Its only argument is
  `InlineHelpers = { input, confirm, capture }` — **no host UI handle and no reload**.
- `preview?: () => { title, sample }` is rendered by the host, so theme swatches survive.
- `visible?: () => boolean` hides a row (a throw fails closed) — use it instead of an in-panel
  refusal where hiding is the honest answer.
- `rows()` runs at every menu build, so `current()` is read live; the host repaints after `action`.
- A thrown/rejected `action` is reported once through `ui.notify` and recorded in `/bridge-status`;
  that is the refusal channel.
- `label` must be one to three plain words with no arrow, colon, dot, pipe, slash or bracket, or the
  row is refused and reported verbatim. `Keymaps` is the only reserved category.
- Detection: `Symbol.for("gentle-shell-bridge/api/v1")`, an `isBridgeApi` gate, and
  `onBridgeApi(handler)` which runs immediately if the API is already published, otherwise
  subscribes to `BRIDGE_READY_EVENT = "gentle-shell-bridge:ready"`. Worked inline pattern:
  `examples/bash-card.ts:1214-1234` (+ `:1519-1524`).
- References, in `gentle-shell-bridge`: `docs/contract.md` §3, §4, §9; `src/types.ts:25-108`;
  `src/rows.ts:174-178`; `src/api.ts` (published object); `docs/architecture.md:51-59`.

## Tasks

- **T1** — `lib/customize-rows.js`: pure builder from the existing customize model to bridge rows
  (four settings, values, `current()`, theme preview, sync gating) plus its own test file.
  Specs: S1, S3. Route: worker. Commit: 17ce681 (folded into T2's commit: the shipped-surface
  invariant stays red until the extension references the new module, so T1 alone has no green
  commit).
- **T2** — extension wiring: bridge handshake, register the page when the bridge answers, skip the
  command registration in that case, keep the command path intact otherwise.
  Specs: S1, S2. Route: worker. Commit: `feat(customize): serve the Herdr settings from the Gentle
  Shell menu` = 17ce681.
- **T3** — row actions: map each row to the existing apply functions, refusal messages, the Moshi
  reload question, and the strings that named the removed command.
  Specs: S3, S4. Route: worker. Commit: 17ce681 (same unit as T2 — one behavior, one slice).
- **T4** — docs and tests for both surfaces: the page under the bridge, the untouched command
  without it.
  Specs: S1, S2, S3, S4. Route: worker. Commit: `docs(customize): document the Herdr menu page and
  its fallback`.
- **T5** — independent verification of the whole diff (Risk item 3: a published command is removed).
  Specs: S1-S4. Route: `gentle-ai-verify`. Commit: none.
- **T6** — feature close: reconciliation, Engram mirror, evidence in this document.
  Specs: all. Route: parent. Commit: none.

## Log

- **L1** (verbatim, user): «Bien, agregemos una nueva feacture y es que si se tiene el plugin
  /home/jona/dev/projects/gentle-shell-bridge en vez de crear comando /herdr customize lo que hace
  es agregar a customize de gentle la seccion "Herdr" y ahi pone las 4 opciones, herd agents, moshi,
  theme sync, select theme. Primero revisa si es viable»
- **L2** (decision, user, verbatim): «esto es adicional, si no tiene bridge el customize de herdr se
  mantiene» → the no-bridge surface is explicitly preserved: S2.
- **L3** (decision, user): chose «Reemplazar: la página Herdr es la única superficie» — with the
  handshake as the gate, so a bridge that never answers never removes the command.
- **L4** (evidence, parent): feasibility review found the page is a row `category`, not
  `registerSection`; the four options map 1:1 onto toggle rows over the model
  `customizePanelModel(ctx)` already produces (`extensions/gentle-herdr-state.ts:2217`), and the
  effects already live in `applyCustomizeSwitch` / `applyCustomizePanel` (`~:2735`, `~:2822`),
  independent of the panel. Only the renderer changes.
- **L5** (slice boundary, parent): T1-T3 landed as one commit, `17ce681` — 1423 insertions, past the
  ~400-line slice. The split is forced by `tools/herdr-packaged-surface.test.js`, which refuses a
  `lib/` module with no shipped referrer, and by S1 needing the rows and the command gate in the same
  tree: an intermediate commit would either be red or leave a bridge user with no surface at all.
  Delivery shape for publishing (single PR vs. stacked) is decided at publication, not here.
- **L6** (requirement change, user): «Comando siempre + página cuando el bridge responde». Chosen after
  the independent verification showed that Pi's extension load order cannot guarantee both "the page
  always appears" and "the command is always gone": the strict rule produced processes with zero
  surfaces (bridge answered, host menu absent) and processes with two (late bridge answer, second
  session_start). Consequences: S1, S2 and S4 rewritten — the command is unconditional, the page is
  additive, and every message keeps the `865d360` spelling because the command is always there. T2's
  exclusivity assertions are superseded by T7; the page's own apply path, row building and the
  Moshi restart notice are unchanged.
