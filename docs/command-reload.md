# Command registration after reload

`/herdr-gentle:odd` and `/herdr-gentle:issues` register during every extension
load, each one following its own toggle in the customize panel's `Plugin tools`
section (`ODD command`, `Issues command`). Both toggles default to enabled and
are stored in `gentle-plugin-tools.json`; missing means enabled, malformed never
enables either one.

The document has ONE shared canonical source: `GENTLE_STATUS_STATE_DIR` when it
is set, otherwise the stored `herdr-gentle-agents` state dir under
`XDG_STATE_HOME`. That path is computed the same way by every session — an
ordinary Pi session and one running under Herdr — because it never consults
`HERDR_PLUGIN_STATE_DIR`. A flip with no copy yet therefore creates the
canonical file instead of a copy in Herdr's injected dir: a copy written there
would be invisible to a plain session, whose missing toggle file means enabled,
so the user's Disabled choice would read back as enabled (a silent re-enable).

A copy an older writer left in the injected dir is still **read**, so a Disabled
value stored there is never lost or re-enabled, and it is kept in step by the
sessions that can see it — the canonical file is created beside it, adopting its
values on the first flip, and it is never deleted. Copies that disagree fail
closed for the disputed key (see `docs/worktree-tools.md`): the panel and
`customize status` carry a diagnostic naming both files and their values,
flipping *that* key is refused and writes nothing (the flip would overwrite a
value the session cannot prove stale), while flipping the other key still
applies and each copy keeps its own value for the disputed one. Reconciling the
pair stays the user's decision.

A flip changes only the keys it names. Every other key keeps the value the read
reported for that copy — so a copy that does not parse, which reads as both
toggles **disabled**, stays disabled for the toggle the user did not touch:
turning `ODD command` on in an unreadable document writes `issues: false`, never
the `missing means enabled` default. The one exception is a first flip that finds
no copy at all: it creates the canonical file from the documented enabled
default, which is exactly what a fresh install reads.

Exact limitation, stated rather than papered over: a plain Pi session **cannot
discover an arbitrary Herdr-injected dir**, so a copy left there by an older
writer is invisible to it — its read sees "missing" (enabled), and its first
flip creates the canonical file from that default instead of adopting the legacy
values. Nothing is destroyed (the legacy file is never written, moved or deleted
by that session), and every session that can see both then reports the mismatch
and fails closed on that key. The conservative remedies are the user's: while no
canonical file exists yet, running one flip from a session that can see both
copies migrates the legacy values into it; afterwards, point
`GENTLE_STATUS_STATE_DIR` at the legacy dir, make the two files identical, or
delete the copy that should not exist.

A flip is a serialized read-merge-write of one key under the canonical lock plus
the lock of every legacy copy it will write, taken in one deterministic order
and released in reverse, so two sessions flipping different toggles at the same
time keep both flips and no two sessions can wait on each other. Writing stays
asynchronous — the lock is polled with a jittered `setTimeout`, never a
synchronous sleep — and a lock is only broken on evidence that its owner is
gone. A write that fails after another copy was already written names that copy
instead of claiming nothing changed, and a flip that repairs an unparseable
duplicate names the file it overwrote. GitHub authentication is separate: it
gates opening the issues reader, not whether the command exists.

Changing configuration may rebuild Pi's command registry while keeping an
extension module alive. A module-level “already registered” flag therefore
cannot prove that the current runtime has the command. Registration is performed
by the extension entry point on each load; a session-start check never tries to
register it again later. The extension's own reload predicate compares the
requested value with what THIS load actually registered, so a toggle reloads
only when the runtime would otherwise keep the wrong surface.

## When a reload is not available

The stored flags are also re-read at every gated invocation:

- `/herdr-gentle:odd` and `/herdr-gentle:issues` refuse to open while their
  toggle reads disabled, naming the `Plugin tools` row that turns them back on
  — and, when the disabled value comes from a fail-closed read rather than a
  user choice, the refusal carries that diagnostic too (two copies that
  disagree, or a copy that does not parse);
- every worktree tool and `/herdr-gentle:warp` refuse while `Worktree tools`
  reads disabled.

So a stale runtime — no `ctx.reload`, or a host that refuses the reload — never
keeps working against the user's choice. The toggle notification says the change
applies from the next session, and the command surface disappears at the
following load. The Issues command's session-start `gh` probe is skipped while
its toggle is off, so a disabled command spawns nothing.

The regression tests reuse the same module with a new API, rebuild the registry
on that API, and cover the disabled-at-load and disabled-after-load paths for
both commands. Interactive reload still needs verification in the running host;
the tests establish the lifecycle and gating behaviour without treating a
successful unit test as terminal input evidence.
