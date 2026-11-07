// @ts-nocheck
// herdr-session-open.ts — `worktree_session_open`, the ONE worktree tool that
// stays in this package (odd/tasks/split-odd-worktree.md S6/T5).
//
// It opens a Pi session inside a REGISTERED agent worktree through Herdr:
// resolve the name against the worktree registry, prove the checkout is live
// and is not the principal, find (or open) that worktree's Herdr workspace,
// pick its root pane after verifying the pane really belongs to that
// workspace and really sits in the worktree, then start Pi there. The other
// four worktree tools, the Customize panel and its plugin-tools mode gate are
// gone; this one is not gated, because there is no toggle left to read.
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

const TOOL_NAME = "worktree_session_open";
const AGENT_START_TIMEOUT_MS = 120000;

// Package-side helpers live in lib/. Tests point the override at the real lib
// dir before importing the copied module; production resolves relative to
// this file.
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

// Core of the tool. Exported so a test can drive it with a live-shaped
// context; the registered tool calls it with the Pi context it was given.
async function executeSessionOpen(params, ctx, watcherOptions) {
  const lib = openLib();
  const cwd = toolCwd(ctx);

  const rawWorktree = params ? params.worktree : undefined;
  const rawSession = params && typeof params.session === "string" && params.session.length > 0
    ? params.session
    : undefined;
  // A name that was PROVIDED is used as given, empty included, so an explicit
  // "" is refused by the agent-name guard instead of silently falling back to
  // the worktree name.
  const nameProvided = params !== undefined && params !== null && params.name !== undefined && params.name !== null;
  const rawName = nameProvided
    ? typeof params.name === "string" ? params.name : String(params.name)
    : undefined;
  const notify = !(params && params.notify === false);
  // The same field accepts a worktree NAME or a PATH: the name first, then the
  // path. A path resolves only when it exists and belongs to this project's
  // worktrees; anything else keeps the name refusal.
  if (typeof rawWorktree !== "string" || rawWorktree.length === 0) {
    return errorResult(
      "worktree_session_open requires a worktree name: pass the NAME 'worktree list' prints (or a branch name), not a path",
      { worktree: rawWorktree },
    );
  }

  let repo;
  try {
    repo = await lib.repoIdentity(cwd);
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { worktree: rawWorktree });
  }
  const read = lib.readRegistry(repo.commonDir);
  if (!read.ok) {
    return errorResult(`cannot read worktree registry: ${read.error}`, { worktree: rawWorktree });
  }
  let live;
  try {
    live = await lib.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { worktree: rawWorktree },
    );
  }
  // The ONE name resolver: a branch spelling resolves through its flattened
  // slug, and a value that resolves neither way but carries a separator is a
  // path, refused with the actionable message.
  const principal = lib.principalForName(repo, live);
  let resolved = lib.resolveCheckoutByName(rawWorktree, { read, principal, live, repoRoot: repo.root });
  if (!resolved.ok) {
    let slug = null;
    try {
      slug = lib.slugifyBranch(rawWorktree);
    } catch {
      slug = null;
    }
    if (typeof slug === "string" && slug.length > 0 && slug !== rawWorktree) {
      const viaSlug = lib.resolveCheckoutByName(slug, { read, principal, live, repoRoot: repo.root });
      if (viaSlug.ok) resolved = viaSlug;
    }
  }
  if (!resolved.ok && lib.looksLikePath(rawWorktree)) {
    const pathEntry = lib.resolveRegisteredPathEntry(rawWorktree, read, live, repo.root);
    if (pathEntry) {
      let entryName = null;
      try {
        entryName = lib.slugifyBranch(pathEntry.branch);
      } catch {
        entryName = null;
      }
      resolved = {
        ok: true, kind: "agent",
        name: entryName || pathEntry.branch,
        path: pathEntry.path, branch: pathEntry.branch, entry: pathEntry,
      };
    }
  }
  if (!resolved.ok && lib.looksLikePath(rawWorktree)) {
    return errorResult(lib.pathRefusal(rawWorktree), { worktree: rawWorktree });
  }
  if (!resolved.ok) {
    return errorResult(resolved.error, { worktree: rawWorktree, candidates: resolved.candidates });
  }
  if (resolved.kind === "principal") {
    return errorResult(
      `cannot open a session in the principal checkout at ${resolved.path}: worktree_session_open only opens sessions in a registered agent worktree (a session in the principal delegates nothing); pass the NAME 'worktree list' prints`,
      { worktree: rawWorktree, path: resolved.path, branch: resolved.branch },
    );
  }
  // Only a registered, LIVE worktree of THIS repository is acceptable: the
  // consolidated liveness predicate (exists AND is-a-directory AND
  // resolved-identity membership), so a hand-deleted checkout git still
  // records is stale and refused here.
  const entryState = lib.checkoutState(resolved.path, repo.root);
  const targetCwd = entryState.real !== null ? entryState.real
    : entryState.absolute !== null ? entryState.absolute
    : path.resolve(resolved.path);
  const entryId = entryState.real !== null ? entryState.real : entryState.absolute;
  const isLive = entryState.exists && entryState.isDirectory && entryId !== null
    && lib.liveIdentities(live, repo.root).has(entryId);
  if (!isLive) {
    return errorResult(
      `no live worktree for "${resolved.name}" at ${resolved.path}: the registry entry is stale (the checkout is missing or git no longer records it); recreate the worktree and retry`,
      { worktree: resolved.name, branch: resolved.branch, path: resolved.path },
    );
  }
  const branch = resolved.entry ? resolved.entry.branch : resolved.branch;
  const agentName = nameProvided ? rawName : resolved.name;
  // Herdr reads the positional name as an option when it starts with a dash:
  // `herdr agent start --help` exits 0 and prints help without starting
  // anything, which would be reported as a successful open and then
  // subscribed to. The name also becomes the pane's agent identity, so it
  // stays a plain word.
  if (agentName.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(agentName)) {
    return errorResult(
      `worktree session open failed: invalid agent name "${agentName}": use letters, digits, dot, underscore or dash, and do not start with a dash`,
      { worktree: resolved.name, branch, path: targetCwd },
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
    { cwd: repo.root, timeoutMs },
  );

  // (a) The worktree's Herdr workspace: `herdr worktree list --cwd <root>`,
  // reading `open_workspace_id` for that branch/path.
  const listed = await runHerdr("list", { cwd: repo.root }, 60000);
  if (listed.status !== 0) {
    return errorResult(
      `worktree session open failed: ${lib.herdrFailureText("herdr worktree list", listed.status, listed.stderr || listed.error)}; no session was opened`,
      { worktree: resolved.name, branch, path: targetCwd },
    );
  }
  const found = lib.sessionWorkspaceId(listed.stdout, repo.root, branch, targetCwd);
  if (found.parseError) {
    return errorResult(
      "worktree session open failed: 'herdr worktree list' returned unparseable JSON; no session was opened",
      { worktree: resolved.name, branch, path: targetCwd },
    );
  }
  let workspaceId = found.id;
  let paneId = null;
  let openedHere = false;

  // One pane choice, used by the reuse path and by the create-then-list path.
  // Each refusal carries the details object the caller publishes: the cwd
  // refusal names the pane it rejected, and every field keeps the order a
  // caller reads (worktree, branch, path, then paneId before workspaceId).
  const paneRefusalBase = () => ({ worktree: resolved.name, branch, path: targetCwd });
  const choosePane = async (note) => {
    const panes = await runHerdr("pane-list", { workspace: workspaceId }, 60000);
    if (panes.status !== 0) {
      return {
        refusal: `worktree session open failed: ${lib.herdrFailureText("herdr pane list", panes.status, panes.stderr || panes.error)} for workspace '${workspaceId}'${note}`,
        details: { ...paneRefusalBase(), workspaceId },
      };
    }
    const chosen = lib.selectSessionPane(panes.stdout, workspaceId, targetCwd, repo.root);
    if (chosen.reason === "no-panes") {
      return {
        refusal: `worktree session open failed: 'herdr pane list' for workspace '${workspaceId}' reported no pane of that workspace${note}`,
        details: { ...paneRefusalBase(), workspaceId },
      };
    }
    if (chosen.reason === "cwd") {
      return {
        refusal: `worktree session open failed: the root pane '${chosen.paneId}' of workspace '${workspaceId}' has cwd ${chosen.paneCwd}, outside the worktree ${targetCwd}; a session started there would not be in the worktree. Close that pane or open the worktree in a fresh workspace`,
        details: { ...paneRefusalBase(), paneId: chosen.paneId, workspaceId },
      };
    }
    return { paneId: chosen.paneId };
  };

  if (workspaceId !== null) {
    // Reuse: the workspace's ROOT pane.
    const chosen = await choosePane("; no session was opened");
    if (chosen.refusal) return errorResult(chosen.refusal, chosen.details);
    paneId = chosen.paneId;
  } else if (found.conflict) {
    // Two different workspace ids claim this worktree: fail closed rather
    // than opening a second workspace blindly.
    return errorResult(
      `worktree session open failed: 'herdr worktree list' names ${found.claimed} different workspaces for '${branch}'; resolve it by hand and retry; no session was opened`,
      { worktree: resolved.name, branch, path: targetCwd },
    );
  } else {
    // Creation: open the workspace, then use its root pane. Opening an
    // ALREADY-OPEN worktree is deliberately not assumed idempotent: when it
    // fails, one fresh list decides whether a workspace appeared anyway
    // (proceed through reuse) or the failure stands.
    const opened = await runHerdr("open", { branch, cwd: repo.root, noFocus: true }, 60000);
    if (opened.status !== 0) {
      const relisted = await runHerdr("list", { cwd: repo.root }, 60000);
      const retry = relisted.status === 0
        ? lib.sessionWorkspaceId(relisted.stdout, repo.root, branch, targetCwd)
        : { id: null, matched: 0, claimed: 0, conflict: false };
      if (retry.id !== null) {
        workspaceId = retry.id;
      } else {
        return errorResult(
          `worktree session open failed: ${lib.herdrFailureText("herdr worktree open", opened.status, opened.stderr || opened.error)} for branch '${branch}'; no session was opened`,
          { worktree: resolved.name, branch, path: targetCwd },
        );
      }
    } else {
      const pair = lib.openedWorkspace(opened.stdout);
      if (pair.workspaceId === null || pair.paneId === null) {
        return errorResult(
          `worktree session open failed: 'herdr worktree open' for branch '${branch}' succeeded but its output named no workspace/pane; no session was started`,
          { worktree: resolved.name, branch, path: targetCwd },
        );
      }
      // The pane Herdr just opened must belong to the workspace it named (a
      // pane id carries its workspace), and its cwd — when the reply reports
      // one — must be the worktree or inside it. Trusting the reply is what
      // would start Pi somewhere else on a reply that names another pane.
      if (!pair.paneId.startsWith(`${pair.workspaceId}:`)) {
        return errorResult(
          `worktree session open failed: 'herdr worktree open' named workspace '${pair.workspaceId}' but pane '${pair.paneId}', which does not belong to it; no session was started`,
          { worktree: resolved.name, branch, path: targetCwd, workspaceId: pair.workspaceId, paneId: pair.paneId },
        );
      }
      if (pair.paneWorkspace !== null && pair.paneWorkspace !== pair.workspaceId) {
        return errorResult(
          `worktree session open failed: 'herdr worktree open' named workspace '${pair.workspaceId}' but its root pane reports workspace '${pair.paneWorkspace}'; no session was started`,
          { worktree: resolved.name, branch, path: targetCwd, workspaceId: pair.workspaceId, paneId: pair.paneId },
        );
      }
      if (pair.paneCwd !== null) {
        const openedState = lib.checkoutState(pair.paneCwd, repo.root);
        const openedReal = openedState.real !== null ? openedState.real : openedState.absolute;
        const openedInside = openedReal !== null
          && (openedReal === targetCwd || openedReal.startsWith(targetCwd + path.sep));
        if (!openedInside) {
          return errorResult(
            `worktree session open failed: the pane '${pair.paneId}' Herdr opened for branch '${branch}' has cwd ${pair.paneCwd}, outside the worktree ${targetCwd}; no session was started`,
            { worktree: resolved.name, branch, path: targetCwd, workspaceId: pair.workspaceId, paneId: pair.paneId },
          );
        }
      }
      workspaceId = pair.workspaceId;
      paneId = pair.paneId;
      openedHere = true;
    }
    if (paneId === null && workspaceId !== null) {
      const chosen = await choosePane(`; the workspace '${workspaceId}' was opened by this call and no session was started in it`);
      if (chosen.refusal) return errorResult(chosen.refusal, chosen.details);
      paneId = chosen.paneId;
    }
  }

  // (b) Start Pi in the pane. The pane belongs to the worktree's own
  // workspace and its cwd is inside the worktree, so Pi's session directory is
  // the worktree's: no `--session-dir`.
  const started = await runHerdr("agent-start", {
    name: agentName, kind: "pi", pane: paneId,
    timeout: String(AGENT_START_TIMEOUT_MS), agentArgs: piArgs,
  }, AGENT_START_TIMEOUT_MS + 60000);
  const details = {
    worktree: resolved.name, branch, path: targetCwd,
    paneId, workspaceId, sessionId, resumed, agentName, notify,
  };
  if (started.status !== 0) {
    const createdNote = openedHere
      ? `; the workspace '${workspaceId}' was opened by this call and no session was started in it`
      : `; the workspace '${workspaceId}' already existed and no session was started in it`;
    return errorResult(
      `worktree session open failed: ${lib.herdrFailureText("herdr agent start", started.status, started.stderr || started.error)} for agent '${agentName}' in pane '${paneId}'${createdNote}`,
      details,
    );
  }
  const result = textResult(lib.sessionOpenRows(details).join("\n"), details, false);
  // Subscribing IS opening with `notify !== false`: one watcher for the pane
  // just opened, `notify: false` starts none. The watcher needs the host
  // message route; without it nothing is watched.
  const notifications = notifyLib();
  if (notify && notifications && typeof notifications.startAgentSessionWatcher === "function") {
    try {
      notifications.startAgentSessionWatcher(
        {
          paneId, worktree: resolved.name, branch, sessionId,
          agentName, workspaceId, path: targetCwd, repoRoot: repo.root,
        },
        watcherOptions,
      );
    } catch {}
  }
  return result;
}

const sessionOpenTool = defineTool({
  name: TOOL_NAME,
  label: "Worktree Session Open",
  exposure: "codemode",
  description: "Open a Pi session inside a registered agent worktree via Herdr (workspace only, never a path): pass the worktree NAME 'worktree list' prints (or a branch name) and optionally a session id to resume. A new session id is minted when resuming is not asked. Unless notify:false is passed, the creator is notified when that session really finishes.",
  parameters: Type.Object({
    worktree: Type.String({ description: "Name of the registered worktree to open the session in (the flattened branch slug, or a branch name)" }),
    session: opt(Type.String({ description: "Pi session id or path to resume; absent means a new session" })),
    name: opt(Type.String({ description: "Agent/pane name; defaults to the worktree name" })),
    notify: opt(Type.Boolean({ description: "Subscribe the creator to the delegate finish notification (default true)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    try {
      return await executeSessionOpen(params, ctx);
    } catch (err) {
      const lib = openLib();
      // A binary refusal says the RESOLUTION failed, not that the tool
      // crashed: answer it with its own text and `isError`. Every other
      // exception is the tool's bug and escapes untouched.
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
