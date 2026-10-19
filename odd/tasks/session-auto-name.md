# Automatic session naming from the ODD work in progress

Feature idea, deferred by the user until the pi fullscreen performance work closes. Nothing here is
approved for implementation yet: this document records the idea, the three problems it has as
stated, and the decisions that must be taken first.

## Specs

S1. User request, verbatim: "otro cambio que se me ocurrio es que renombrar la session de manera automatica (excepto principal/main solo las fork de worktree) y se renombran en base al ultimo archivo odd escrito/modificado/leido, asi se en que consiste la sesion."

S2. User's own open questions, verbatim: "hay que ver que no se duplique y hacer que lo evalue renombra cada que lee modifica odd, con una vez basta, y si cierro la session y vuelvo? lo hara djuebo o quizas alla otra manera de manejarlo".

S3. Goal: a human looking at a list of sessions can tell what each one is about without opening it, for worktree forks only (the principal/main session keeps its name).

## Problems the idea has as stated

P1. "el ultimo archivo odd leido" is a bad signal. Reading is not working: an agent reads many ODD
documents for context (the whole spec set, a sibling feature for comparison), so the name would jump
to whatever was read last rather than to what the session is doing. Writing and the task in progress
are the signals that mean "this is the work".

P2. "renombra cada que lee modifica odd, con una vez basta" contradicts itself. Evaluating on every
access renames constantly; evaluating once never follows the work when it moves to another feature.
The rule has to say WHICH event re-derives the name, not both.

P3. A human rename must never be overwritten. If the user named a session by hand, the automation
must leave it alone — the same never-clobber rule the customize panel already follows.

## The shape this should probably take

D1. Write the SUBJECT (task alias), not the human session name. The host already separates them:
`orchestrator_session_id(subject)` updates task aliases and names an unnamed session, while the human
name is preserved and is the user's. Automating the alias removes P3 by construction instead of by a
guard.

D2. Derive from the ODD document that is being WRITTEN, or from the task marked in progress, and take
the feature name from the document (`odd/tasks/<feature>.md` → `<feature>`). A one-line summary of
its first spec is a candidate for a longer label; the document's own heading is the honest source.

D3. Fix the name once per unit of work and re-derive only on an ODD phase transition (the
`gentle_odd_phase` tool already marks them), not on every file access. That answers S2's "con una vez
basta" without losing the ability to follow the work when it changes feature.

D4. Desambiguate collisions: two forks working the same feature must not carry the same label. A
suffix from the branch is the natural discriminator, since the worktree branch is already unique.

D5. Resuming after a close: the name lives in the session's own state, so a resumed session must
either remember the derived name or recompute it from the document it was working. Recomputing is
preferable because the document may have been renamed since.

D6. Only sessions that own a registered worktree are renamed; the principal checkout session and any
session without a worktree are out of scope.

D7. REVISED, because T2's step-zero investigation found no subject channel. Pi exposes exactly ONE
session-identity write, `pi.setSessionName` (`dist/core/extensions/types.d.ts:1274`), and the session
record carries a single `name` with no subject, alias or label field; the subject D1 pointed at lives
in gentle-pi's private branch-local cache, reachable only through `ctx.executeTool`, which exists on
the tool `ExecuteToolContext` (`types.d.ts:270-280`) and NOT on the `ExtensionContext` an event handler
receives (`types.d.ts:1170`). So D1 is not implementable, and the NAME is the channel that does exist.
D1's guarantee survives through a different mechanism: the plugin owns the name ONLY while it matches
the pattern the plugin itself writes (`<feature>` or `<feature> @ <branch>`). A name that does not
match was chosen by a human and is never touched again. That keeps P3 — a manual rename is never
overwritten — without needing a guard somebody can forget to call, and it does the right thing for an
unnamed session too. Two consequences to accept explicitly: the label is the session NAME rather
than a hidden alias, which is what the user asked for in S1 anyway; and "is this name ours" is
decided by pattern, so a human who names a session exactly like a feature name simply gets a name the
plugin may later update, which is indistinguishable from the intent they typed.

WHAT ALREADY EXISTS, so T2 is smaller than it looks: `captureOddFromToolEvent`
(`extensions/gentle-worktree-tools.ts:4564`) already runs on both `tool_call` and `tool_result`
(registered at `:7832-7833`), already resolves the owning registered worktree and already returns
principal-cwd calls as "no entry" (`:4419-4450`) — which is D6, implemented. `oddRelFor` (`:4485`)
already maps a touched path to `odd/tasks/<feature>.md` — which is D2. Only the naming call is missing.

## Tasks

T1 | S1,S2,D1-D6 | decide | done | DECIDED after the user answered the recommendation with "adelante". The trigger is a WRITE to an ODD document under `odd/tasks/`: the alias becomes that document's feature name. A READ never triggers, because reading is context gathering and would make the name jump to whatever was opened last. One exception, deliberate: a transition of ODD phase re-derives, so the alias follows the work when it genuinely moves to another feature. The write is IDEMPOTENT — writing the same alias again is a no-op, so it does not spam the session. The alias goes through the host's SUBJECT channel and never the human session name, so a rename by hand is never overwritten, and that is a property of the channel rather than a guard someone can forget. A collision between concurrent forks gets the branch as a suffix, since the branch is already unique per worktree. A resumed session recomputes from the document it was working instead of remembering, because the document may have been renamed since. Only sessions that own a registered worktree are touched; the principal session never is.

T2 | D2-D7 | implement | done | Derive the alias from the ODD document being WRITTEN and set it as
the session NAME through `pi.setSessionName`, since D7 established that no subject channel exists. Write
only when the session owns a registered worktree AND the current name is either empty or matches the
pattern the plugin itself writes; a name that matches nothing the plugin writes was set by a human and
must never be touched. Reuse `captureOddFromToolEvent`/`oddRelFor`, which already do the worktree
decision and the path mapping. Tests must pin: a read does not trigger, a write does, the write is
idempotent, the principal session is untouched, a human-chosen name is untouched, a collision takes
the branch suffix, and a resume recomputes when the document changed.

## Log

L1. User request, verbatim: "otro cambio que se me ocurrio es que renombrar la session de manera automatica (excepto principal/main solo las fork de worktree) y se renombran en base al ultimo archivo odd escrito/modificado/leido, asi se en que consiste la sesion. Te parece buena idea? o deberiamos hacer detector de otra forma (hay que ver que no se duplique y hacer que lo evalue renombra cada que lee modifica odd, con una vez basta, y si cierro la session y vuelvo? lo hara djuebo o quizas alla otra manera de manejarlo) que piensas de la idea? ve esto una vez termines todo lo deoptimizacion que estas viendo, dejalo anotado nomas"
L2. Decision taken when the performance work closed and the user said "adelante": the trigger is a write to an ODD document under `odd/tasks/` plus a re-derivation on an ODD phase transition, never a read; the channel is the session SUBJECT, never the human name; the write is idempotent; collisions take a branch suffix; a resume recomputes. Each of these answers one of the questions S2 posed, so none of them is left to the implementer's taste.
L3. Step-zero verdict of the T2 investigation, which the worker reported instead of inventing a channel as instructed: Pi 1.3.0 exposes no subject/alias write. `setSessionName`/`getSessionName` (`dist/core/extensions/types.d.ts:1274,1276`) are the only session-identity writes and they write the human name; the session record carries a single `name` (`docs/session-format.md:201`); a grep for subject/alias/task-alias fields returns nothing, and the CHANGELOG has no such entry, so the absence looks structural rather than recent. The subject is gentle-pi's own branch-local cache (`lib/orchestrator-state.ts:86-110`, validated by `lib/orchestrator-alias.ts`), and the only supported way to reach another extension's tool is `ctx.executeTool`, which exists on `ExecuteToolContext` (`types.d.ts:270-280`) and not on the `ExtensionContext` of an event handler (`types.d.ts:1170`). Two routes were rejected on the record: forging `gentle-agents.published-state` with `appendEntry` would write another package's private schema AND be discarded by its in-memory cache on the next publish; and `setSessionName`/`herdr agent rename` write the human name. `gentle_odd_phase` is likewise a gentle-pi tool, observable only as a `tool_result`, not a host event. Hence D7.
L4. T2 implementation record. The label is `<feature> @ <branch>` (`lib/session-auto-name.js` derives it from the `odd/tasks/<feature>.md` rel the existing `oddRelFor` already produces; the extension only calls `pi.setSessionName`). Ownership is the pattern the plugin writes: a name is writable when it is empty or matches `<feature>` (dot-separated `[A-Za-z0-9._-]` segments) or `<feature> @ <branch>` (branch any whitespace-free token, so an unusual-but-legal branch character cannot freeze a resumed session). A name outside that pattern was typed by a human and is never touched, including a rename done after an automatic one. Collisions: the host exposes NOTHING that enumerates the live sessions of a clone (the only list, `SessionManager.list`, is an async read of on-disk session files, not peers, and would report historical sessions as collisions), so the conservative behaviour is taken — the branch suffix is ALWAYS applied, not only when a peer is seen. That satisfies D4 unconditionally (the branch is unique per worktree), it stays idempotent because a given worktree always derives the same label, and it costs only a longer name. A resumed session re-derives on the next write through the same ownership test, so it follows a renamed document and still leaves a human name alone.
L5. Second half of D3, plus the user's heading requirement, implemented as one unit. The label head is now the document's first level-1 heading (trimmed, inner whitespace collapsed, truncated to 48 characters on a word boundary), with the filename slug only as the fallback when there is no readable heading, so the name says what the ODD document says (D2) instead of spelling the filename. The phase trigger is wired to the `tool_result` of `gentle_odd_phase` (L3: that tool is guessable only as a tool result, and it names the phase, never the feature), so the module remembers the last label derived from an ODD write, per session id, and re-applies it through the same ownership test; a session that never wrote an ODD document re-applies nothing. Because a heading carries spaces, ownership was widened: a name counts as the plugin's own when it is the label that session already applied, ends with ` @ <this worktree's branch>`, is the plain filename slug, or is the document's current heading; an empty or absent name stays adoptable, and anything else stays human. Toggle guarantee verified, with one correction to the handoff's premise: the naming hooks are registered under `if (typeof pi?.on === "function")`, NOT under `if (toolsRegistered)` — the toggle is enforced at runtime by `captureOddFromToolEvent`'s `readMode().enabled !== true` early return, which is one shared precondition for both triggers. The pinned test therefore asserts the behavioral guarantee (mode off writes no name, mode on lets both triggers through) instead of asserting a registration the code does not perform. Two cases stay unhandled by the phase trigger and are left to the write path: a session resumed in a NEW process that reports a phase before its first ODD write has no in-process memory yet, and neither does a session whose name no longer matches any of the four owned shapes — in both the phase has no feature to re-apply, and inventing one is refused.
