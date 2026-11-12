# Running count fidelity — the sidebar counts only what is actually running

Worktree: `herdr-gentle-shell-worktrees/fix-running-count`
Branch: `fix-running-count` (from `main` @ `1dc5116`)

## Specs

S1. «detecte otro error mientras corregias, mnira me sale (3) pero solo hay 1 running» — the `(n)` suffix and the role words must count only runs that are actually running. A run that has finished contributes no name, no role word and no count, whatever the producer's local task map still says.

S2. «al parar volvio a verify (3), se quedo como trabado porque incluso ahora estas con un explore no un verify» — an idle session must read `idle` even when one local record never finalizes, and the row must follow the live run rather than a stale one.

S3. «lo raro es que paso en esta nomas, debe ser un error muy puntual» — the leak is a narrow event-sequencing trigger, so the fix must not assume every record finalizes. It has to stay correct when a record is stranded.

## Tasks

T1 · S1,S2,S3 · protected count source — the produced count, role words and names derive from the authoritative presence snapshot, not from the producer's own possibly-stale map · route worker · commit `pending`
T2 · S1,S3 · stop the leak at its source — do not bump the execution epoch for a resume result carrying a final status, and allow witness capture for a record the current snapshot lists active · route worker · commit `pending`
T3 · S1,S2,S3 · independent verification of the protected count source, the fallback path and the surviving parity tests · route verify

## Log

L1: «detecte otro error mientras corregias, mnira me sale (3) pero solo hay 1 running»

L2: «al parar volvio a verify (3), se quedo como trabado porque incluso ahora estas con un explore no un verify»

L3: «lo raro es que paso en esta nomas, debe ser un error muy puntual»

E1: Root cause (traced with `path:line` evidence on `extensions/gentle-herdr-state.ts`). A `subagent_continue` resume reuses the task id (`:3957-3960`, completion keyed at `:4096`) and bumps the execution epoch even when the result is final (`:4102` → `taskEpochFor`/`isResume`, `:890-897`). Completion requires a witnessed generation with an equal epoch (`:641`, `:686`, `:710`), and witnesses are only captured for ids a presence snapshot lists active at beat time (`:692-698`). The presence store never lists a finished task again, so a record whose epoch advanced after its last witnessed generation can never finalize. A completion that never arrives is never re-read: one delivery path only (`message_end`, `customType === "gentle-agents.result"`, `:4126-4166`). Consequence: an idle session reads a stale role word and count instead of `idle`, and it never recovers.

E2: Engineering constraint — when no valid snapshot is available (freshness `:534`, generation equality `:566`, counts consistency `:588`), the producer falls back to its own local map (`runningSubs()`), never to zero. A zero fallback would flip the consumer's `done` gate (`herdr-plugin/lib/gentle-tokens.js:913-919`) and force the generic activity leg (`:973-976`), hiding real running work.

E3: Why a consumer-side TTL cannot catch this. The role leg must render a genuinely running background delegate (`herdr-plugin/lib/gentle-tokens.js:952-971`), and that delegate is legitimately long-lived between beats, so expiring the role evidence in the consumer would hide real work. The correction has to happen where the evidence is authoritative: the producer's beat, against the presence snapshot.
