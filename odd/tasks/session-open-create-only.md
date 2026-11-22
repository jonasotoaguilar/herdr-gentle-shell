# herdr_session_open: create only

Two corrections in one request. The finish subscription lied — it reported
`herdr session never started` about a delegate that was working — so it is
removed entirely. The success text carries routing ids nobody reads, so it is
trimmed to what the caller actually needs.

## Specs

**S1 — the finish subscription is gone.** No watcher, no `notify` parameter, no
`herdr agent get` polling, no `pi.sendMessage({ customType:
"herdr-agent-sessions.finished" })` follow-up, and no
`lib/herdr-session-notifications.js`. Opening a session opens a session; the
caller reads real state with `orchestrator_list` / `herdr agent get` itself.
The human's words: «puede uqe ni sea necesario realmente pues tiene orchestator
list, quizas la funcion de crear session herdr lo dejaria en solo crear sin
ectras de recordatorios o alerta».

**S2 — the success text is three rows, in this order**, each only when it has a
value: `path`, `branch`, `session`. No `outcome`, no `panel`, no `workspace`, no
`pane`, no `agent`. The human's words: «datos como workspace, pane no le sirven
para nada, agent tampoco, solo necesita la sesison id y los demas datos, el PEN:
outcome: opened igual esta demas, si fue exitoso esta abierto, es redundante».
`fallback: normal panel after herdr reported <code>` still appears when a
worktree open fell back to a normal panel: that is a fact about what was
opened, not a routing id.

**S3 — error text keeps its ids.** Failure messages still name the pane and/or
workspace (`... for agent 'x' in pane 'w1:p1'`): an error without the id that
failed is useless. Only the SUCCESS rows lose them.

**S4 — `details` keeps the machine facts.** `path`, `kind`, `branch`,
`fallback`, `paneId`, `workspaceId`, `sessionId`, `resumed`, `agentName` stay in
`details`; `notify` is removed from it. `details` is not the model-facing text.

**S5 — the herdr allowlist stays closed.** `herdrArgv` must not keep an
operation nothing calls any more: remove `agent-get` from the allowlist and from
its tests only if no remaining code path uses it (it becomes dead surface the
moment S1 lands). Do not remove an operation still in use.

**S6 — docs and help text describe only what exists.** `docs/herdr-session-open.md`
(step 6, the result-rows paragraph, the parameters table, the
`The finish notification` section, and the lib inventory line naming
`lib/herdr-session-notifications.js`), the tool `description` string, and the
`herdr_session_open` paragraph of `README.md` must not promise a notification, a
`notify` parameter, or an `outcome`/`panel`/`workspace`/`pane`/`agent` row. That
README paragraph is in scope because it named `notify: false` and
`panel: normal` when this spec was written (see L4); no other README paragraph
is touched, and DESIGN.md carries no reference to them — leave it alone.

## Tasks

T1 · S1, S2, S5 — RED first: in `tools/herdr-session-open.test.js`, replace the
finish-notification tests with the new contract (no `notify` in
`params.properties`; success text exactly `path`/`branch`/`session`; no
`agent get` line ever spawned; `details` has no `notify`), watch them fail, then
make them pass.
T2 · S1, S3, S4, S6 — implementation: delete the notifications lib, strip the
wiring and the parameter from `extensions/herdr-session-open.ts`, trim
`sessionOpenRows` in `lib/herdr-session-open.js`, rewrite the docs and the tool
description.
T3 · S2, S3, S5 — final checks: the four node:test suites below pass, and no
surviving reference to the removed names exists anywhere in the repo.

## Log

L1 — user request, verbatim:

> eso es de una sesion anterio, pero es un bug pues abrio la session pero nunca
> se detuvo ... her sessions finished esta funcionando mal, puede uqe ni sea
> necesario realmente pues tiene orchestator list, quizas la funcion de crear
> session herdr lo dejaria en solo crear sin ectras de recordatorios o alerta,
> igual resaroia el output de la tool.
>
> │ OPEN: outcome: opened ...
>
> datos como workspace, pane no le sirven para nada, agent tampoco, solo necesita
> la sesison id y los demas datos, el PEN: outcome: opened igual esta demas, si
> fue exitoso esta abierto, es redundante

L2 — the reported defect, verbatim from the delivered message:

> herdr session never started: /home/jona/dev/projects/gentle-shell-bridge
> 98ece5fd-279f-4e44-9ed1-22438c100c65 in pane wPJ:p1 went idle without ever
> reporting working (the published state is another process's view, so "never
> started" and "never reported anything" are indistinguishable)

The delegate was in fact working at that moment. Root cause is not chased: the
mechanism is removed, so no claim about a finish survives to be wrong.

L3 — decisions taken with the human:
- The finish subscription is removed, not repaired (`notify` and the watcher go).
- The success rows are `path`, `branch`, `session` — `panel` is dropped too.

L4 — parent decision, extending the edit surface by one file. S6 claimed README
carried no reference to the removed surface, but the T3 grep proved its
`herdr_session_open` paragraph still promised `notify: false` / "the caller is
woken when that session really finishes" and a `panel: normal` row. The human's
original request (L1) already requires that nothing promises the removed
notification, so the parent authorized editing exactly that README paragraph
(~618-634) plus this entry; no other README paragraph and nothing in DESIGN.md
is touched.

L5 — parent verification (independent of the worker's report): in this worktree,
`node --test tools/herdr-session-open.test.js tools/herdr-session-open-paths.test.js
tools/herdr-packaged-surface.test.js tools/herdr-cleanup-surface.test.js` →
`tests 83 / suites 19 / pass 83 / fail 0` (exit 0). Diff inspected by the parent:
`sessionOpenRows` returns `path`, `fallback`, `branch`, `session`; the extension
returns `textResult(...)` directly, exports only `default`/`executeSessionOpen`/
`sessionOpenTool`, and `details` no longer carries `notify`; the `agent-get`
allowlist entry is gone; `lib/herdr-session-notifications.js` is deleted. Left
UNCOMMITTED in the worktree on purpose: committing, pushing and opening the PR
are the human's decisions.
