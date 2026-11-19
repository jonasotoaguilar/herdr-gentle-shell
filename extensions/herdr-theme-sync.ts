// @ts-nocheck
// herdr-theme-sync.ts — Herdr's palette follows the active Gentle Shell / Pi
// theme (odd/tasks/theme-sync.md T3b over S3/S4/S5/S7).
//
// This is a Pi extension of its own rather than a section of
// extensions/gentle-herdr-state.ts for one concrete reason: turning a Pi theme
// colour into a Herdr hex value needs `colorToHex` from
// @earendil-works/pi-tui, and the state sidecar is loaded by every suite as a
// renamed copy with its single package import stubbed — a second host import
// there would mean a second stub in six test files. The sidecar also owns the
// pane-scoped session state machine; following a theme is independent of it.
//
// In one sentence: every tick the follower reads the persisted switch, and when
// the palette it asks for differs from the one it last applied, it pipes the
// projection to the plugin's own bin/configure-theme.js.
//
// The rules the code keeps, each of them a spec:
//   S3  sync ON  -> Herdr's palette is the palette of the theme Pi is showing
//                   right now, and a theme recoloured in place (same name, new
//                   colours) is noticed without restarting the session;
//   S4  sync OFF -> the one theme the user assigned, resolved by name; a name
//                   this install does not have applies nothing;
//   S5  turning the sync off keeps the palette Herdr already has: nothing here
//                   ever removes a managed block;
//   S7  the default install (sync off, no theme) spawns nothing and writes
//                   nothing.
//
// There is deliberately NO Herdr pane gate. Herdr's config is the user's own and
// outlives any pane, so a Pi session started outside Herdr still keeps Herdr's
// palette in sync; gating on HERDR_ENV would make the feature work only in the
// one pane the user already has open.
//
// Plain JavaScript with a .ts extension (// @ts-nocheck, no type annotations),
// exactly like the other extensions, so the rename-and-stub test loading works
// under plain node.

import { colorToHex } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute as pathIsAbsolute, resolve as resolvePath } from "node:path";

const require = createRequire(import.meta.url);

const TICK_MS = 500;
const APPLY_TIMEOUT_MS = 60000;
const PLUGIN_LIST_TIMEOUT_MS = 15000;
// A refusal is explained in one line; anything longer is noise in a transcript.
const FAILURE_TAIL_MAX = 300;

const HERDR_PLUGIN_ACTIVE_ID = "herdr-gentle-shell";
const HERDR_PLUGIN_LEGACY_ID = "herdr-gentle-agents";
const CONFIGURE_BASENAME = "configure.js";
const THEME_CONFIGURE_BASENAME = "configure-theme.js";

// Package-side helpers live in lib/. Tests copy this file out of the repository,
// so the override points at the real lib/ exactly like GENTLE_CUSTOMIZE_LIB_DIR
// does for the state sidecar; production resolves relative to this file.
function libRequire(name) {
  const override = process.env.GENTLE_THEME_SYNC_LIB_DIR;
  const dir = typeof override === "string" && override.length > 0
    ? override
    : join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
  return require(join(dir, name));
}

function themeStore() {
  return libRequire("theme-store.js");
}

function themeProjection() {
  return libRequire("theme-projection.js");
}

/* --------------------------------------------------------- script lookup */

// bin/configure-theme.js lives in the Herdr plugin (installed as its own
// package), so the Pi side resolves that root exactly like
// lib/gentle-sidebar.js and the state sidecar do: a read-only
// `herdr plugin list --json`, with GENTLE_HERDR_PLUGIN_ROOT as the documented
// override for isolated runs. The active (renamed) id is queried first; a zero
// match falls through to one explicit lookup by the retired id. Ambiguous roots
// fail closed on either id.
function herdrPluginRoots(id) {
  let result;
  try {
    result = spawnSync(
      process.env.HERDR_BIN_PATH || "herdr",
      ["plugin", "list", "--plugin", id, "--json"],
      { encoding: "utf8", timeout: PLUGIN_LIST_TIMEOUT_MS, windowsHide: true },
    );
  } catch (error) {
    return { ok: false, note: `could not resolve the installed plugin root: ${error?.message ?? error}.` };
  }
  if (result.error) {
    return { ok: false, note: `could not resolve the installed plugin root: ${result.error.message}.` };
  }
  if (result.status !== 0) {
    return { ok: false, note: `could not resolve the installed plugin root (plugin list exited ${result.status}).` };
  }
  try {
    const doc = JSON.parse(result.stdout || "");
    const arr = (doc && doc.result && doc.result.plugins) || doc.plugins || [];
    if (!Array.isArray(arr)) throw new Error("no plugins array");
    const hits = arr.filter((p) => p && (p.plugin_id === id || p.id === id));
    const roots = [...new Set(hits.map((hit) => hit.plugin_root).filter((root) => typeof root === "string" && root.length > 0))];
    return { ok: true, roots };
  } catch (error) {
    return { ok: false, note: `could not resolve the installed plugin root: malformed plugin list (${error?.message ?? error}).` };
  }
}

function checkConfigureScript(roots) {
  if (roots.length !== 1 || !pathIsAbsolute(roots[0])) {
    const why = roots.length === 0 ? "no match" : "ambiguous or non-absolute";
    return { ok: false, note: `could not resolve the installed plugin root (${why}).` };
  }
  const script = join(roots[0], "bin", CONFIGURE_BASENAME);
  if (!existsSync(script)) {
    return { ok: false, note: `could not resolve the installed plugin root (${roots[0]} has no bin/${CONFIGURE_BASENAME}).` };
  }
  return { ok: true, script };
}

function resolveConfigureScript() {
  const override = process.env.GENTLE_HERDR_PLUGIN_ROOT;
  if (typeof override === "string" && override.length > 0) {
    return { ok: true, script: join(resolvePath(override), "bin", CONFIGURE_BASENAME) };
  }
  const active = herdrPluginRoots(HERDR_PLUGIN_ACTIVE_ID);
  if (!active.ok) return active;
  if (active.roots.length > 0) return checkConfigureScript(active.roots);
  const legacy = herdrPluginRoots(HERDR_PLUGIN_LEGACY_ID);
  if (!legacy.ok) return legacy;
  if (legacy.roots.length > 0) return checkConfigureScript(legacy.roots);
  return {
    ok: false,
    note: `could not resolve the installed plugin root (no match for ${HERDR_PLUGIN_ACTIVE_ID} or ${HERDR_PLUGIN_LEGACY_ID}).`,
  };
}

// The theme writer is the sidebar writer's SIBLING, not the same file: each owns
// a different managed block, so the resolved path only tells us where the plugin
// lives. Swapping the last segment keeps the override and both id lookups on one
// code path instead of re-deriving the root three times.
function resolveThemeScript() {
  const resolved = resolveConfigureScript();
  if (!resolved.ok) return resolved;
  return { ok: true, script: join(dirname(resolved.script), THEME_CONFIGURE_BASENAME) };
}

/* ------------------------------------------------------------ projection */

// Pi's `Theme.colors` resolves every token to a `Color` (the terminal default is
// already substituted), so `colorToHex` is the whole conversion. Anything that is
// not a concrete hex afterwards is dropped rather than defaulted: projectPalette
// omits it, and Herdr keeps the base-theme colour for that surface instead of
// painting a guess.
function convertColors(colors, projection) {
  const converted = {};
  // `muted` paints two Herdr tokens (subtext0 and overlay0), so the source roles
  // are visited once each: one conversion, one emitted pair, never half-applied.
  for (const piToken of new Set(Object.values(projection.HERDR_ROLE_SOURCES))) {
    let raw;
    try {
      raw = colors[piToken];
    } catch {
      continue;
    }
    // "" is Pi's "terminal default" in a theme document: it has no hex spelling.
    if (raw === "" || raw === undefined || raw === null) continue;
    let hex;
    try {
      hex = colorToHex(raw);
    } catch {
      // One unconvertible token must not cost the rest of the palette.
      continue;
    }
    if (projection.isConcreteHex(hex)) converted[piToken] = hex;
  }
  return converted;
}

// A theme whose palette cannot be read at all is NOT evidence that the user has
// no palette, so the tick is skipped instead of stripping Herdr's custom block.
function themeColors(theme) {
  if (!theme || typeof theme !== "object") return null;
  let colors;
  try {
    colors = theme.colors;
  } catch {
    return null;
  }
  if (!colors || typeof colors !== "object") return null;
  return colors;
}

// The last non-empty stderr line, capped: the CLI names its refusal there, and a
// tick-by-tick wall of text is exactly what must not happen.
function stderrTail(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  return lines[lines.length - 1].slice(0, FAILURE_TAIL_MAX);
}

/* ---------------------------------------------------------------- factory */

export default function (pi) {
  if (!pi || typeof pi.on !== "function") return;

  // Everything the follower remembers for ONE session. The notices are
  // per-session: a tick must never nag, and a new session is a new conversation.
  const seen = {
    stateKey: null, // the last requested {sync, theme} that was acted on
    fingerprint: null, // the last palette that was acted on
    failure: null, // the last failure text already reported
    missingTheme: false, // the unavailable-theme notice was shown
    unresolvable: false, // the plugin-root refusal was shown
    busy: false, // an apply is in flight
  };
  let timer = null;

  function notify(ctx, message, level = "warning") {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.notify === "function") ctx.ui.notify(message, level);
    } catch {
      // A UI that cannot notify must not break the follower.
    }
  }

  // The CLI repeats its refusal on every attempt; the user is told once per
  // distinct failure. `seen.failure` is cleared by a success, so the same refusal
  // after a good apply is news again.
  function reportFailure(ctx, text) {
    if (seen.failure === text) return;
    seen.failure = text;
    notify(ctx, text);
  }

  function applyPalette(ctx, projection, paletteInput) {
    let payload;
    try {
      payload = projection.projectPalette(paletteInput);
    } catch {
      // projectPalette only throws on a malformed input this file built; there is
      // nothing honest to apply, and guessing would paint a palette nobody chose.
      return;
    }
    const resolved = resolveThemeScript();
    if (!resolved.ok) {
      if (!seen.unresolvable) {
        seen.unresolvable = true;
        notify(ctx, `Could not apply the palette to Herdr: ${resolved.note} The palette Herdr has was left untouched.`);
      }
      return;
    }
    let result;
    try {
      result = spawnSync(process.execPath, [resolved.script, "--apply", "--json", "--reload"], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: APPLY_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      reportFailure(ctx, `Could not apply the palette to Herdr: ${resolved.script} could not start (${error?.message ?? error}).`);
      return;
    }
    if (result.error) {
      reportFailure(ctx, `Could not apply the palette to Herdr: ${resolved.script} could not start (${result.error.message}).`);
      return;
    }
    if (result.status !== 0) {
      const tail = stderrTail(result.stderr);
      reportFailure(ctx, `Could not apply the palette to Herdr: configure-theme exited ${result.status}${tail ? `: ${tail}` : "."}`);
      return;
    }
    seen.failure = null;
  }

  // One evaluation: read the switch, decide what palette it asks for, and apply it
  // only when that answer is new.
  function step(ctx) {
    const store = themeStore();
    let snapshot;
    try {
      snapshot = store.readThemeState(process.env);
    } catch {
      return;
    }
    // A switch this package cannot read is a refusal (an unparsable or
    // unreadable document): do nothing, and never write.
    if (!snapshot || snapshot.ok !== true) return;

    const projection = themeProjection();
    const sync = snapshot.sync === true;
    const chosen = sync ? null : projection.normalizeThemeName(snapshot.theme);
    // S7 + S5: sync off with nothing assigned is the default install. No spawn, no
    // write, no removal — Herdr keeps the palette it already has.
    if (!sync && chosen === null) return;

    let theme;
    let name;
    if (sync) {
      theme = ctx && ctx.ui ? ctx.ui.theme : undefined;
      name = theme && typeof theme.name === "string" ? theme.name : null;
    } else {
      name = chosen;
      theme = undefined;
      try {
        theme = ctx && ctx.ui && typeof ctx.ui.getTheme === "function" ? ctx.ui.getTheme(chosen) : undefined;
      } catch {
        theme = undefined;
      }
      if (!theme) {
        // S4: a selection for a theme this install does not have applies nothing.
        // Recording nothing keeps the tick cheap and lets a later install of that
        // exact theme be picked up without a restart, while the notice is once.
        if (!seen.missingTheme) {
          seen.missingTheme = true;
          notify(
            ctx,
            `The Pi theme "${chosen}" is not installed, so Herdr's palette was left unchanged; pick an installed theme in /herdr-gentle:customize.`,
          );
        }
        return;
      }
    }

    const rawColors = themeColors(theme);
    if (rawColors === null) return;

    const colors = convertColors(rawColors, projection);
    const observed = JSON.stringify([sync, chosen]);
    const fingerprint = projection.paletteFingerprint({ name, colors });
    const changed = observed !== seen.stateKey || fingerprint !== seen.fingerprint;
    // Recorded BEFORE the apply on purpose: a failed or refused apply must not be
    // retried on the next tick, and it must not block the next observed change
    // either, which is exactly what "the last observed request" means.
    seen.stateKey = observed;
    seen.fingerprint = fingerprint;
    if (!changed) return;
    applyPalette(ctx, projection, { name, colors });
  }

  function evaluate(ctx) {
    if (seen.busy) return; // never stack applies
    seen.busy = true;
    try {
      step(ctx);
    } catch {
      // A tick runs from a timer: an escaping error would take Pi down with it.
    } finally {
      seen.busy = false;
    }
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  pi.on("session_start", (event, ctx) => {
    stop();
    seen.stateKey = null;
    seen.fingerprint = null;
    seen.failure = null;
    seen.missingTheme = false;
    seen.unresolvable = false;
    seen.busy = false;
    // One immediate evaluation, so the palette is right before the first tick
    // instead of up to half a second later — or never, in a short-lived session.
    evaluate(ctx);
    timer = setInterval(() => evaluate(ctx), TICK_MS);
    // An idle follower must never keep Pi (or a scripted session) alive.
    if (timer && typeof timer.unref === "function") timer.unref();
  });

  pi.on("session_shutdown", () => {
    stop();
  });
}
