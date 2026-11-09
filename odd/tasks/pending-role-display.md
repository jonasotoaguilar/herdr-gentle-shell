# Show the running role while a synchronous subagent call blocks the session

Render the in-flight blocking delegate's role instead of generic `gentle`, without letting a background delegate change the principal's own display.

Changed areas: the producer token contract (`extensions/gentle-herdr-state.ts`, new `gentle_pending_v1`) and the consumer precedence (`herdr-plugin/lib/gentle-tokens.js`).

## Specs

S1. «con agentes que no son en background lo marca como gentle … ahi deberia salir status igual worker» — while a blocking `subagent_run` / `subagent_continue` call is in flight, the sidebar renders the child's role (e.g. `worker`), never the generic `gentle`.

S2. The fix is evidence-based, not precedence guesswork: the producer publishes a dedicated marker for the in-flight blocking call (`gentle_pending_v1`), so a queued or running background delegate never changes the principal's own display.

S3. Background behavior is unchanged: with a working principal and a running background delegate the row still reads `gentle` (the existing pinned expectation `a working principal with one running explorer shows gentle` in `tools/gentle-tokens.test.js` stays true, unrewritten).

S4. The pending marker never outranks `error`, `ask`, `review` or `done`, expires with the same mechanism as the other producer tokens, and is cleared when the tool call settles, the agent settles, or the session resets.

## Tasks

T1 · S2,S4 · extensions/gentle-herdr-state.ts |
T2 · S1,S3 · herdr-plugin/lib/gentle-tokens.js |
T3 · S1-S4 · tools/gentle-tokens.test.js, tools/gentle-herdr-state.test.js, tools/herdr-cleanup-surface.test.js |
T4 · S1,S3 · DESIGN.md |

## Log

L1: «igual ahi detecte otr oerror y es que con agentes que no son en background lo marca como gentle, esto porque la session sigue activa pero esperando que termine el subagente, como ejecturanto el tool y esperando respuesta, no queda idle ahi, [Image#5] pero ahi deberia salir status igual worker, pues esta trabajando el y gentle aunque en proceso aun esta esperando output noams del agente»
