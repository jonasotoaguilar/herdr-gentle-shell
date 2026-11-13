// @ts-nocheck
// herdr-session-open.ts — `herdr_session_open`, the Herdr session opener
// (odd/tasks/split-odd-worktree.md S8/T7).
//
// It opens a Herdr panel running a Pi session AT A PATH:
//   * the path is a linked Git worktree  -> a WORKTREE panel
//     (`herdr worktree open --path … --cwd …`), reusing the workspace Herdr
//     already has for that checkout when there is one. The target is passed as
//     `--cwd` as well because herdr resolves a worktree against the
//     repository of the FOCUSED workspace, not against the process cwd, so a
//     worktree of ANOTHER repository resolves instead of answering
//     `worktree_not_found`. When herdr still answers `worktree_not_found` for
//     a path git proves is a linked worktree, the panel falls back to a NORMAL
//     one at the same path and the result says so;
//   * the path is a repository's primary checkout, any other directory, or a
//     subdirectory of a checkout -> a NORMAL panel
//     (`herdr workspace create --cwd …`).
// Panel kind is decided from git itself, never guessed: a path git does not
// report as its own checkout root is never treated as a worktree.
//
// Every opened panel is verified before Pi starts in it — the pane must belong
// to the workspace Herdr named and its cwd must be the requested path or inside
// it — and every herdr call is a fixed argv from lib/herdr-session-open.js, so
// a path can never become a command. `--trust-repository` and `--focus` are not
// reachable from here.
//
// The file is plain JavaScript with a .ts extension (// @ts-nocheck, no type
// annotations), exactly like extensions/gentle-herdr-state.ts, so the test
// copy-to-.mjs loading pattern keeps working under plain node.

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const TOOL_NAME = "herdr_session_open";
const AGENT_START_TIMEOUT_MS = 120000;

// Package-side helpers live in lib/. Tests point the override at the real lib
// dir before importing the copied module; production resolves relative to this
// file.
function libRequire(name) {
  const override = process.env.GENTLE_HERDR_SESSION_LIB_DIR;
  const dir = typeof override === "string" && override.length > 0
    ? override
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
  return require(path.join(dir, name));
}

function openLib() {
  return libRequire("herdr-session-open.js");
}

function notifyLib() {
  try {
    return libRequire("herdr-session-notifications.js");
  } catch {
    return null;
  }
}

// The herdr binary. Resolving it can THROW on purpose: under a test harness a
// possible live binary is refused instead of being spawned (the guard lives in
// lib/herdr-session-open.js, so no fallback here may re-decide it).
function herdrBinary() {
  return openLib().resolveHerdrBinary(process.env);
}

function toolCwd(ctx) {
  if (ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0) return ctx.cwd;
  return process.cwd();
}

function opt(schema) {
  if (Type && typeof Type.Optional === "function") return Type.Optional(schema);
  return schema;
}

function textResult(text, details, isError) {
  const result = { content: [{ type: "text", text }], details };
  if (isError) result.isError = true;
  return result;
}

function errorResult(text, details) {
  return textResult(text, details || {}, true);
}

// Core of the tool. Exported so a test can drive it with a live-shaped context;
// the registered tool calls it with the Pi context it was given.
async function executeSessionOpen(params, ctx, watcherOptions) {
  const lib = openLib();
  const cwd = toolCwd(ctx);

  const rawPath = params ? params.path : undefined;
  const rawSession = params && typeof params.session === "string" && params.session.length > 0
    ? params.session
    : undefined;
  // A name that was PROVIDED is used as given, empty included, so an explicit
  // "" is refused by the agent-name guard instead of silently falling back to
  // the derived name.
  const nameProvided = params !== undefined && params !== null && params.name !== undefined && params.name !== null;
  const rawName = nameProvided
    ? typeof params.name === "string" ? params.name : String(params.name)
    : undefined;
  const notify = !(params && params.notify === false);
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return errorResult(
      "herdr_session_open requires a path: pass an existing directory (a Git worktree, a repository checkout, or any directory)",
      { path: rawPath },
    );
  }
  // A relative path resolves against the session's own cwd, never against an
  // arbitrary process cwd.
  let requested;
  try {
    requested = path.resolve(cwd, rawPath);
  } catch {
    return errorResult(`herdr_session_open requires an existing directory: ${rawPath}`, { path: rawPath });
  }
  // Identity is settled BEFORE any side effect: the canonical path is what every
  // comparison uses, and the requested spelling is only what a normal panel is
  // asked to open at. A path whose identity cannot be resolved is refused here,
  // never after a panel already exists.
  const canonical = lib.canonicalPath(requested);
  if (canonical === null) {
    return errorResult(`herdr_session_open requires an existing directory: ${requested}`, { path: requested });
  }

  let panel;
  try {
    panel = await lib.classifyPanel(canonical);
  } catch (err) {
    return errorResult(`herdr_session_open cannot read ${requested}: ${(err && err.message) || err}`, { path: requested });
  }
  if (panel.kind === "invalid") {
    return errorResult(`herdr_session_open requires an existing directory: ${requested}`, { path: requested });
  }
  if (panel.kind === "unproven") {
    // git reports a repository but cannot name its own directories, so whether
    // this is a linked worktree or a primary checkout is unknown. Opening
    // either kind would be a guess, so nothing is opened.
    return errorResult(
      `herdr session open failed: cannot prove whether ${requested} is a linked worktree or a primary checkout (git could not resolve its own directories); no panel was opened`,
      { path: canonical },
    );
  }
  const kind = panel.kind;
  const isWorktree = kind === "worktree";
  // The canonical identity: every path comparison (worktree listing, pane cwd)
  // uses it, so a symlinked spelling never reads as a second directory.
  const target = canonical;
  const branch = typeof panel.branch === "string" && panel.branch.length > 0 ? panel.branch : null;

  // The default name follows the caller's own spelling (for a normal panel) or
  // the branch (for a worktree panel); the canonical path stays the identity
  // every comparison uses.
  const agentName = nameProvided
    ? rawName
    : lib.agentNameForPath(requested, { branch: isWorktree ? branch : null });
  // The name becomes the pane's agent identity and Herdr's own documented
  // shape decides what it accepts; a name it would reject is refused here
  // instead of being tried and reported as a success.
  if (!lib.validAgentName(agentName)) {
    return errorResult(
      `herdr session open failed: invalid agent name "${agentName}": Herdr accepts lowercase letters, digits, dash and underscore, starting with a letter, at most 32 characters`,
      { path: target, kind },
    );
  }
  const resumed = rawSession !== undefined;
  const sessionId = resumed ? rawSession : randomUUID();
  const piArgs = resumed
    ? ["--name", agentName, "--session", sessionId]
    : ["--name", agentName, "--session-id", sessionId];

  const runHerdr = (operation, args, timeoutMs) => lib.runArgvAsync(
    herdrBinary(),
    lib.herdrArgv(operation, args),
    { cwd: target, timeoutMs },
  );

  let workspaceId = null;
  let paneId = null;
  let openedHere = false;
  const openCall = isWorktree ? "herdr worktree open" : "herdr workspace create";
  // The panel kind that was really OPENED. A worktree panel can degrade to a
  // normal panel on the one documented fallback, and both the rows and the
  // details state the kind that was opened, never the one that was classified.
  let openedKind = kind;
  // The herdr error code that forced that fallback, or null. It is present
  // only when a fallback really happened, so every existing result keeps its
  // exact key order.
  let fallbackCode = null;

  // One pane choice, used by the reuse path and by the create-then-list path.
  // Each refusal carries the details object the caller publishes, so every
  // refusal of this tool has the same key order: path, kind, branch, then the
  // pane before the workspace it belongs to.
  const paneRefusalBase = () => ({
    path: target, kind: openedKind, branch,
    ...(fallbackCode === null ? {} : { fallback: fallbackCode }),
  });
  const choosePane = async (note) => {
    const panes = await runHerdr("pane-list", { workspace: workspaceId }, 60000);
    if (panes.status !== 0) {
      return {
        refusal: `herdr session open failed: ${lib.herdrFailureText("herdr pane list", panes.status, panes.stderr || panes.error)} for workspace '${workspaceId}'${note}`,
        details: { ...paneRefusalBase(), workspaceId },
      };
    }
    const chosen = lib.selectSessionPane(panes.stdout, workspaceId, target, target);
    if (chosen.reason === "no-panes") {
      return {
        refusal: `herdr session open failed: 'herdr pane list' for workspace '${workspaceId}' reported no pane of that workspace${note}`,
        details: { ...paneRefusalBase(), workspaceId },
      };
    }
    if (chosen.reason === "cwd") {
      return {
        refusal: `herdr session open failed: the root pane '${chosen.paneId}' of workspace '${workspaceId}' has cwd ${chosen.paneCwd}, outside ${target}; a session started there would not be in that directory. Close that pane or open the panel in a fresh workspace`,
        details: { ...paneRefusalBase(), paneId: chosen.paneId, workspaceId },
      };
    }
    return { paneId: chosen.paneId };
  };

  // Verify the pair a successful open/create reply names, before anything is
  // started in it: the pane belongs to the workspace, the pane's own workspace
  // (when reported) agrees, and its cwd is the requested path or inside it.
  // `call` names the call that really produced the panel, so a fallback reply
  // is reported as the `herdr workspace create` it was.
  const verifyOpenedPair = (pair, call = openCall) => {
    if (pair.workspaceId === null || pair.paneId === null) {
      return `herdr session open failed: '${call}' for ${target} succeeded but its output named no workspace/pane; no session was started`;
    }
    if (!pair.paneId.startsWith(`${pair.workspaceId}:`)) {
      return `herdr session open failed: '${call}' named workspace '${pair.workspaceId}' but pane '${pair.paneId}', which does not belong to it; no session was started`;
    }
    if (pair.paneWorkspace !== null && pair.paneWorkspace !== pair.workspaceId) {
      return `herdr session open failed: '${call}' named workspace '${pair.workspaceId}' but its root pane reports workspace '${pair.paneWorkspace}'; no session was started`;
    }
    if (pair.paneCwd !== null) {
      const openedState = lib.checkoutState(pair.paneCwd, target);
      const openedReal = openedState.real !== null ? openedState.real : openedState.absolute;
      const inside = openedReal !== null && (openedReal === target || openedReal.startsWith(target + path.sep));
      if (!inside) {
        return `herdr session open failed: the pane '${pair.paneId}' '${call}' opened for ${target} has cwd ${pair.paneCwd}, outside ${target}; no session was started`;
      }
    }
    return null;
  };

  if (isWorktree) {
    // A worktree panel is keyed by the checkout path. Reuse the workspace
    // Herdr already has for it, so opening twice does not stack panels.
    const listed = await runHerdr("list", { cwd: target }, 60000);
    if (listed.status !== 0) {
      return errorResult(
        `herdr session open failed: ${lib.herdrFailureText("herdr worktree list", listed.status, listed.stderr || listed.error)}; no session was opened`,
        { path: target, kind, branch },
      );
    }
    const found = lib.worktreeWorkspaceId(listed.stdout, target, target);
    if (found.parseError) {
      return errorResult(
        "herdr session open failed: 'herdr worktree list' returned unparseable JSON; no session was opened",
        { path: target, kind, branch },
      );
    }
    if (found.conflict) {
      return errorResult(
        `herdr session open failed: 'herdr worktree list' names ${found.claimed} different workspaces for ${target}; resolve it by hand and retry; no session was opened`,
        { path: target, kind, branch },
      );
    }
    workspaceId = found.id;
  }

  if (workspaceId !== null) {
    // Reuse: the workspace's ROOT pane.
    const chosen = await choosePane("; no session was opened");
    if (chosen.refusal) return errorResult(chosen.refusal, chosen.details);
    paneId = chosen.paneId;
  } else {
    // Create the panel. `herdr worktree open` is not assumed idempotent: when
    // it fails, one fresh list decides whether the workspace appeared anyway.
    // A worktree panel opens at the canonical checkout; a normal panel keeps the
    // spelling the caller asked for, which is what their shell will show.
    //
    // The target travels as BOTH `--path` and `--cwd`: herdr resolves a
    // worktree against the repository of the FOCUSED workspace unless `--cwd`
    // names the resolution base, so only a target passed as `--cwd` can be
    // resolved when its repository is not the focused one.
    let reply = isWorktree
      ? await runHerdr("open", { path: target, cwd: target, noFocus: true }, 60000)
      : await runHerdr("workspace-create", { cwd: requested, noFocus: true }, 60000);
    let call = openCall;
    if (reply.status !== 0) {
      if (isWorktree) {
        const relisted = await runHerdr("list", { cwd: target }, 60000);
        const retry = relisted.status === 0
          ? lib.worktreeWorkspaceId(relisted.stdout, target, target)
          : { id: null, matched: 0, claimed: 0, conflict: false };
        if (retry.id !== null) workspaceId = retry.id;
      }
      if (workspaceId === null) {
        // The ONE fallback (S3): herdr answered `worktree_not_found` for a path
        // git still proves is a linked worktree, i.e. it could not resolve that
        // worktree's repository. A normal panel at the same path still opens.
        // Every other failure — and this code for a path that is no longer a
        // linked worktree — keeps the abort below, so an unrelated error is
        // never masked by a panel.
        const code = isWorktree ? lib.herdrErrorCode(reply) : null;
        if (code !== "worktree_not_found" || !(await lib.isLinkedWorktreePath(target))) {
          return errorResult(
            `herdr session open failed: ${lib.herdrFailureText(call, reply.status, reply.stderr || reply.error)} for ${target}; no session was opened`,
            { path: target, kind, branch },
          );
        }
        const fallback = await runHerdr("workspace-create", { cwd: target, noFocus: true }, 60000);
        if (fallback.status !== 0) {
          return errorResult(
            `herdr session open failed: ${lib.herdrFailureText("herdr workspace create", fallback.status, fallback.stderr || fallback.error)} for ${target} after 'herdr worktree open' reported ${code}; no session was opened`,
            { path: target, kind: "normal", branch, fallback: code },
          );
        }
        reply = fallback;
        call = "herdr workspace create";
        openedKind = "normal";
        fallbackCode = code;
      }
    }
    if (reply.status === 0 && workspaceId === null) {
      const pair = lib.openedWorkspace(reply.stdout);
      const refusal = verifyOpenedPair(pair, call);
      if (refusal) {
        return errorResult(refusal, {
          ...paneRefusalBase(),
          paneId: pair.paneId, workspaceId: pair.workspaceId,
        });
      }
      workspaceId = pair.workspaceId;
      paneId = pair.paneId;
      openedHere = true;
    }
    if (paneId === null && workspaceId !== null) {
      const chosen = await choosePane(
        openedKind === "worktree"
          ? `; the workspace '${workspaceId}' was opened by this call and no session was started in it`
          : `; the workspace '${workspaceId}' was created by this call and no session was started in it`,
      );
      if (chosen.refusal) return errorResult(chosen.refusal, chosen.details);
      paneId = chosen.paneId;
    }
  }

  // Start Pi in the pane. The pane belongs to the panel's own workspace and its
  // cwd is the requested path or inside it, so Pi's session directory is that
  // directory's: no `--session-dir`.
  const started = await runHerdr("agent-start", {
    name: agentName, kind: "pi", pane: paneId,
    timeout: String(AGENT_START_TIMEOUT_MS), agentArgs: piArgs,
  }, AGENT_START_TIMEOUT_MS + 60000);
  const details = {
    path: target, kind: openedKind, branch,
    ...(fallbackCode === null ? {} : { fallback: fallbackCode }),
    paneId, workspaceId, sessionId, resumed, agentName, notify,
  };
  if (started.status !== 0) {
    const createdNote = openedHere
      ? `; the workspace '${workspaceId}' was opened by this call and no session was started in it`
      : `; the workspace '${workspaceId}' already existed and no session was started in it`;
    return errorResult(
      `herdr session open failed: ${lib.herdrFailureText("herdr agent start", started.status, started.stderr || started.error)} for agent '${agentName}' in pane '${paneId}'${createdNote}`,
      details,
    );
  }
  const result = textResult(lib.sessionOpenRows(details).join("\n"), details, false);
  // Subscribing IS opening with `notify !== false`: one watcher for the pane
  // just opened, `notify: false` starts none. The watcher needs the host message
  // route; without it nothing is watched.
  const notifications = notifyLib();
  if (notify && notifications && typeof notifications.startAgentSessionWatcher === "function") {
    try {
      notifications.startAgentSessionWatcher(
        {
          paneId, path: target, kind: openedKind, branch, sessionId,
          agentName, workspaceId, repoRoot: target,
        },
        watcherOptions,
      );
    } catch {}
  }
  return result;
}

const sessionOpenTool = defineTool({
  name: TOOL_NAME,
  label: "Herdr Session Open",
  exposure: "codemode",
  description: "Open a Herdr panel running a Pi session at a path: a linked Git worktree opens as a worktree panel, a repository's primary checkout or any other directory opens as a normal panel. Pass an optional session id to resume; a new session id is minted when resuming is not asked. Unless notify:false is passed, the creator is notified when that session really finishes.",
  parameters: Type.Object({
    path: Type.String({ description: "Directory to open the panel in (absolute, or relative to the session cwd): a Git worktree, a repository checkout, or any other directory" }),
    session: opt(Type.String({ description: "Pi session id to resume; absent means a new session" })),
    name: opt(Type.String({ description: "Agent/pane name; defaults to a name derived from the path (lowercase letters, digits, dash, underscore)" })),
    notify: opt(Type.Boolean({ description: "Subscribe the creator to the delegate finish notification (default true)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    try {
      return await executeSessionOpen(params, ctx);
    } catch (err) {
      const lib = openLib();
      // A binary refusal says the RESOLUTION failed, not that the tool crashed:
      // answer it with its own text and `isError`. Every other exception is the
      // tool's bug and escapes untouched.
      if (!lib.isHerdrRefusal(err)) throw err;
      return errorResult(`${TOOL_NAME}: ${err.message}`, { tool: TOOL_NAME, herdrRefused: true });
    }
  },
});

export default function (pi) {
  // The delivery route for the finish subscription started by the tool.
  const notifications = notifyLib();
  if (notifications && typeof notifications.setSessionNotifier === "function") {
    try {
      notifications.setSessionNotifier(pi);
    } catch {}
  }
  pi.registerTool(sessionOpenTool);
}

export { executeSessionOpen, sessionOpenTool, clearSessionWatchers };

// Stop every finish watcher this process started: the test seam for the
// pane-keyed registry, and the shutdown path for a host that wants one.
function clearSessionWatchers() {
  const notifications = notifyLib();
  if (notifications && typeof notifications.clearSessionWatchers === "function") {
    notifications.clearSessionWatchers();
  }
}
