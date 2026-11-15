# ui-prompt-ask-origin

A Gentle Shell slash command that renders an option menu while the agent is working must not publish the
`ask` session label. The `ask` label means "the agent asked you something and needs your answer"; today
every `ui_prompt_start` with `kind !== "custom"` counts while a tool is in flight, so command menus
(`/rdd` and its siblings, `/warp` list, the `customize` fallback) fake a question.

Worktree: `/home/jona/dev/projects/herdr-gentle-shell-worktrees/ui-prompt-ask-origin` (branch `fix/ui-prompt-ask-origin`).

## Specs

S1. «cuando uso ciertos comandos de opciones como /rdd de gentle shell con el agente corriendo/trabajando me cambia el status a ask, como si me hubiera hecho una pregunta, lo cual es erroneo»

S2. «probe el mismo en sesion detenida y no pasa, solo pasa cuando esta trabajando»

S3. «que sea solo cuando realmente me pregunta/ask/choice y necesito responderle»

S4. «no solo ese comando son varios asi»

S5. «hay que investigar como es (no solo ese comando son varios asi) y ver porque lo toma como ask y prevenirlo para los /comandos»

S6. «requiere intervercion real»

## Tasks

- T1 — Withdraw the generic UI-prompt ask leg as soon as the agent proves it is not blocked on it; keep every existing ask leg intact. Route: inline parent + `gentle-ai-worker`. Commit: 679a22d (`fix(status): stop a command menu from faking the ask label`). Done.
- T2 — Independent verification of the `ask` contract change (risk item 3: the label other, unrequested paths consume). Route: `gentle-ai-verify`. Done: first verdict `fail (1 blocking finding)` — nested-start false negative (L5), corrected under T1; re-check verdict `pass with notes`, notes applied.

## Log

L1 (human, verbatim): «encontre un bug y es que cando uso ciertos comandos de opciones como /rdd de gentle shell con el agente corriendo/trabajando me cambia el status a ask, como si me hubiera hecho una pregunta, lo cual es erroneo. probe el mismo en sesion detenida y no pasa, solo pasa cuando esta trabajando. Hay ciertos comandos de gentle shell que usa para preguntar, quizas es el mismo componetne o similar (es el mismo diseno) asi que habria que investigar como es (no solo ese comando son varios asi) y ver porque lo toma como ask y prevenirlo para los /comandos y que sea solo cuando realmente me pregunta/ask/choice y necesito responerle, requiere intervercion real»

L2 (evidence, explorer handoff 1). The `ask` label has independent legs in `extensions/gentle-herdr-state.ts` (`askActiveNow()` ~:3261): `choiceActive`, `questionActive`, `questionnaireActive`, `permissionPending`, `askToolCalls` (`ASK_TOOLS = ask_user_question|ask_user_choice`, :870), and the generic `uiPromptActive` leg from `pi.on("ui_prompt_start")` ~:4451, which enters only when `runningTools.size > 0` and `event.kind !== "custom"`. Tests pinning today's behavior: `tools/gentle-herdr-state.test.js:103` (prompt during a tool call enters ask), `:126` (no tool in flight never asks), `:136` (a `custom` panel never asks mid-execution, but a `confirm` still does), `:160`, `:172`, `:187`, `:210`, and `:4399` (real UI prompt outranks live review). Documented contract: `DESIGN.md:211` (ask row: tool-gated `ui_prompt` spans with `kind` other than `custom`; a panel or overlay never counts).

L3 (evidence, explorer handoff 2 — root cause). The Pi host decides `kind` from which `ctx.ui.*` the caller awaits and emits `{ reason: "ui_prompt", kind: "select"|"confirm"|"input"|"editor"|"custom", title? }` only (`dist/core/extensions/types.d.ts:828-840`, `dist/core/extensions/runner.js:356-373`). There is **no origin signal**: no field distinguishes a command handler's prompt from a tool's prompt, the `uiContext` is shared for all callers, no command start/end event exists (`types.d.ts:1229-1269`), and `ctx.isIdle()` is not usable because a command handler runs concurrently with an active run while `isIdle()` stays `false` during that run. So `kind` alone cannot separate the two, and the offending commands (`/rdd`, `/warp`, `customize` fallback) reach a menu through `ctx.ui.select` → `kind: "select"`, the very kind the contract counts as a question. `/rdd` is defined in the installed gentle-pi package, outside this checkout.

L4 (decision). Since no origin signal exists, the leg withdraws on the one asymmetry that cannot lie: a run genuinely blocked awaiting a dialog cannot also start new tool executions or finish assistant messages. While a generic `ui_prompt` span is open, a `tool_execution_start` or an assistant `message_end` proves the agent was never waiting on that prompt → the span stops contributing to `ask` until `ui_prompt_end`. Entry stays immediate (no missed real asks), every dedicated ask leg is untouched, and the rule keys on signals, never on a command-name list (S4).

L5 (verification finding, blocking, corrected). `gentle-ai-verify` reproduced with the installed host that codemode's `ctx.executeTool` emits a nested `tool_execution_start` immediately, even before its own queue wait (`dist/core/nested-tool-calls.js:111-127`, forwarded at `core/agent-session.js:442-470`), while a sibling tool's dialog is still awaited. Withdrawal on every start therefore hid a genuinely awaited confirmation (labels went `ask:...` → `{active:false}` with the dialog still open), contradicting S3/S6. Direct model-issued siblings are safe (`pi-agent-core/dist/agent-loop.js:417-459` emits all starts before `Promise.all`), and assistant `message_end` has no false-negative path. Correction: withdrawal on execution starts is gated on `event.parentToolCallId === undefined` (top-level only); nested starts never withdraw. The verifier's regression was appended as `nested sibling execution cannot hide an awaited generic question`, and the guarantee was requalified to "top-level" in the extension comments, `DESIGN.md:211` and `README.md`.

L6 (evidence, post-correction). `node --test tools/gentle-herdr-state.test.js` exit 0, 132 tests, fail 0 (41.8 s). `node --test tools/*.test.js` exit 0, tests 846, suites 125, pass 846, fail 0, skip 0 (80.0 s) — one more than the pre-fix 845: the new nested-start regression. The ten pre-existing prompt/ask tests (`tools/gentle-herdr-state.test.js:103`, `:126`, `:136` both halves, `:160`, `:172`, `:187`, `:210`, `:4399`) are byte-identical (zero deletions in the test diff).
