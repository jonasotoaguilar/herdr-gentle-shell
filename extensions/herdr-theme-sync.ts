// @ts-nocheck
// herdr-theme-sync.ts — Herdr's palette follows the active Gentle Shell / Pi
// theme (odd/tasks/theme-sync-fix.md T3 over S3/S4/S7).
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
// the palette it asks for differs from the one it last asked for, it applies the
// projection IN PROCESS through lib/herdr-theme-apply.js.
//
// Why in process, and why that is the whole fix (evidence E1/E2): the shipped
// follower spawned the theme writer CLI of the INSTALLED Herdr plugin, found
// through `herdr plugin list`. A Pi-only update therefore kept running the old
// plugin's writer (which the user's install did not even have), and that writer
// refused the user's real config. The reference implementation
// (/home/jona/dev/upstream/gentle-herdr) applies from Pi itself, so this file now
// does the same and owns no knowledge of plugin roots, child processes or CLIs.
//
// The rules the code keeps, each of them a spec:
//   S3  sync ON  -> Herdr's palette is the palette of the theme Pi is showing
//                   right now, and a theme recoloured in place (same name, new
//                   colours) is noticed without restarting the session;
//   S4  sync OFF -> the one theme the user assigned, resolved by name; a name
//                   this install does not have applies nothing;
//   S7  the default install (sync off, no theme) writes nothing at all, and
//                   turning the sync off keeps the palette Herdr already has.
//
// There is deliberately NO Herdr pane gate here: availability (Herdr pane,
// remote session, unsupported binary, subagent child) is decided once, by
// `applyHerdrTheme`, so the follower can never disagree with the writer about who
// may write. The child guard below is the one exception, and it is about
// registration, not about availability: a subagent's Pi must not even start this.
//
// Plain JavaScript with a .ts extension (// @ts-nocheck, no type annotations),
// exactly like the other extensions, so the rename-and-stub test loading works
// under plain node.

import { colorToHex } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const TICK_MS = 500;

// What the user is told when the writer refuses to touch this environment, keyed
// by the reason `applyHerdrTheme` returns. `child` is absent on purpose: a child
// never registers this extension at all.
const UNAVAILABLE_NOTICES = Object.freeze({
  "not-herdr": "Herdr theme sync is inactive: this Pi session is not inside a Herdr pane.",
  remote: "Herdr theme sync is inactive: this is a remote session and Herdr reads its config on another machine.",
  unsupported: "Herdr theme sync is not supported in this environment.",
});

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

// The in-process writer: it owns the availability guard, the bounded read, the
// safe write and the reload. Loading it lazily keeps this file's import surface
// to the single host package the stub pattern needs.
function themeApply() {
  return libRequire("herdr-theme-apply.js");
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
// no palette, so the tick is skipped instead of writing an empty projection.
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

/* ---------------------------------------------------------------- factory */

export default function (pi) {
  if (!pi || typeof pi.on !== "function") return;
  // CHILD GUARD, before anything is registered: a subagent's "active theme" is
  // not the palette the user is looking at, so its Pi must never write the user's
  // Herdr config. Skipping registration entirely (rather than refusing later) also
  // means no timer runs in a child for the whole session.
  if (process.env.GENTLE_PI_AGENTS_CHILD === "1") return;

  // Everything the follower remembers for ONE session. The notices are
  // per-session: a tick must never nag, and a new session is a new conversation.
  const seen = {
    stateKey: null, // the last requested {sync, theme} that was acted on
    fingerprint: null, // the last palette that was acted on
    failure: null, // the last failure text already reported
    missingTheme: false, // the unavailable-theme notice was shown
    unavailable: false, // the environment notice was shown
    noColours: false, // the "nothing to project" notice was shown
    busy: false, // an apply is in flight
  };
  let timer = null;
  // F4: a shutdown can land while the initial evaluation is awaiting the writer.
  // The flag makes "this session is over" observable after that await, so the
  // start path can no longer arm a tick that keeps writing the user's config for a
  // session nobody is looking at.
  let stopped = false;
  // F2: `partial/reload` means the config was written but Herdr was not told. The
  // flag survives until a reload actually succeeds and is honoured on the next
  // apply attempt of THIS session. It is session memory on purpose (a restart
  // forgets it), which is why the notice names the manual command.
  let reloadOwed = false;

  function notify(ctx, message, level = "warning") {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.notify === "function") ctx.ui.notify(message, level);
    } catch {
      // A UI that cannot notify must not break the follower.
    }
  }

  // The writer repeats its refusal on every attempt; the user is told once per
  // distinct failure. `seen.failure` is cleared by a success, so the same refusal
  // after a good apply is news again.
  function reportFailure(ctx, text) {
    if (seen.failure === text) return;
    seen.failure = text;
    notify(ctx, text);
  }

  // One sentence, always terminated. A child-process message ends in a newline (or
  // in its own period), and the reload notice must read as prose plus the command
  // that repairs it by hand.
  function sentence(text) {
    const trimmed = String(text ?? "").trim().replace(/\.+$/, "");
    return trimmed === "" ? "" : `${trimmed}.`;
  }

  function reloadNotice(error) {
    const reason = sentence(error);
    const repair = "Run 'herdr server reload-config' to apply it.";
    return reason === ""
      ? `Herdr theme written; Herdr reload failed. ${repair}`
      : `Herdr theme written; Herdr reload failed: ${reason} ${repair}`;
  }

  // Every outcome of a change the USER made must be visible: before this, an
  // apply that never happened looked exactly like one that worked.
  function reportResult(ctx, result, label, userInitiated) {
    const status = result && result.status;
    if (status === "requested") {
      seen.failure = null;
      // A reload actually happened (with or without a write), so an owed one is
      // paid off.
      reloadOwed = false;
      // A palette-only change (the Pi theme recoloured while the sync is on) is
      // not a user action, so it stays silent; a switch the user flipped is news.
      if (userInitiated) notify(ctx, `Herdr theme applied: ${label}; reload requested`, "info");
      return;
    }
    if (status === "unchanged") {
      // Herdr already holds this palette: nothing was written and nothing needs
      // saying, but an earlier failure is over.
      seen.failure = null;
      return;
    }
    if (status === "unavailable") {
      // Reached only when the user opted in (sync on or a theme pinned, which is
      // the only way this follower asks for an apply). It is a state of the
      // environment, not an error, hence `info` and once per session.
      const text = UNAVAILABLE_NOTICES[result.reason];
      if (text === undefined || seen.unavailable) return;
      seen.unavailable = true;
      notify(ctx, text, "info");
      return;
    }
    if (status === "partial") {
      if (result.stage === "reload") {
        // The write is committed and Herdr was not told: remember the debt so the
        // next apply attempt still asks for the reload, and tell the user the
        // command that repairs it even if they restart Pi.
        reloadOwed = true;
        reportFailure(ctx, reloadNotice(result.error));
        return;
      }
      reportFailure(ctx, `Herdr theme not applied: ${result.error}`);
    }
  }

  // One evaluation: read the switch, decide what palette it asks for, and apply it
  // only when that answer is new.
  async function step(ctx) {
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
    // S7: sync off with nothing assigned is the default install. No write, no
    // apply call, no removal — Herdr keeps the palette it already has. F1: it must
    // also FORGET what was applied, because turning the sync off (or clearing the
    // pin) is the user saying "stop touching Herdr". Without that reset the next
    // "on" looks unchanged — same sync+theme, same palette — and a config the user
    // repaired in between would never be written.
    if (!sync && chosen === null) {
      seen.stateKey = null;
      seen.fingerprint = null;
      return;
    }

    let theme;
    let label;
    if (sync) {
      theme = ctx && ctx.ui ? ctx.ui.theme : undefined;
      label = theme && typeof theme.name === "string" ? theme.name : null;
    } else {
      // The selected name IS the label: the assigned theme is what the user asked
      // for, whether or not this install has it.
      label = chosen;
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
            // S4 (odd/tasks/herdr-customize-page.md): `/herdr-gentle:customize`
            // is registered unconditionally, so it is the one surface this notice
            // can name — the Herdr page of Gentle Shell's customize menu sits
            // beside it, never instead of it.
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
    const fingerprint = projection.paletteFingerprint({ name: label, colors });
    // "User-initiated" is exactly a change of the stored {sync, theme}: a first
    // evaluation in a session is one too, because the user set the switch before
    // Pi started or through the customize panel.
    const userInitiated = observed !== seen.stateKey;
    const changed = userInitiated || fingerprint !== seen.fingerprint;
    // Recorded BEFORE the apply on purpose: a failed or refused apply must not be
    // retried on the next tick, and it must not block the next observed change
    // either, which is exactly what "the last observed request" means.
    seen.stateKey = observed;
    seen.fingerprint = fingerprint;
    if (!changed) return;

    let projected;
    try {
      projected = projection.projectPalette({ name: label, colors });
    } catch {
      // projectPalette only throws on a malformed input this file built; there is
      // nothing honest to apply, and guessing would paint a palette nobody chose.
      return;
    }

    // F3: a projection without a single concrete token would still rewrite the
    // theme name to one-dark and announce success — a change the user never chose
    // and no palette at all. Apply nothing and say why, once per session.
    if (projected.theme.custom === undefined) {
      if (!seen.noColours) {
        seen.noColours = true;
        notify(ctx, `Herdr theme not applied: ${label ?? "the active theme"} has no concrete colours to project.`);
      }
      return;
    }

    // F2: an owed reload rides along with this attempt. It is only ever sent on a
    // real apply attempt (never on an unchanged tick), so Herdr is not reloaded
    // every 500 ms while one is pending.
    const options = { projection: projected.theme };
    if (reloadOwed) options.forceReload = true;

    let result;
    try {
      result = await themeApply().applyHerdrTheme(options);
    } catch (error) {
      // `applyHerdrTheme` reports its own refusals and failures as a status; a
      // throw is unexpected, and it must not escape into the tick's caller.
      reportFailure(ctx, `Herdr theme not applied: ${error?.message ?? error}`);
      return;
    }
    reportResult(ctx, result, label ?? "the active theme", userInitiated);
  }

  async function evaluate(ctx) {
    if (seen.busy) return; // never stack applies
    seen.busy = true;
    try {
      await step(ctx);
    } catch {
      // A tick runs from a timer: an escaping error would take Pi down with it.
    } finally {
      seen.busy = false;
    }
  }

  function stop() {
    // F4: marking the session stopped is what the start path checks after its one
    // await; clearing the timer is what makes the next session (or the end of this
    // one) quiet.
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  pi.on("session_start", async (event, ctx) => {
    stop();
    seen.stateKey = null;
    seen.fingerprint = null;
    seen.failure = null;
    seen.missingTheme = false;
    seen.unavailable = false;
    seen.noColours = false;
    seen.busy = false;
    reloadOwed = false;
    // This session is live again from here on.
    stopped = false;
    // One immediate evaluation, so the palette is right before the first tick
    // instead of up to half a second later — or never, in a short-lived session.
    await evaluate(ctx);
    // The evaluation above awaited a child process; a shutdown may have landed in
    // that window. Arming a tick now would keep writing the user's config for a
    // session that is already over.
    if (stopped) return;
    timer = setInterval(() => {
      // A tick is asynchronous (the reload is a child process). The promise is
      // RETURNED rather than discarded so a driver can await one tick; `evaluate`
      // swallows every error, so it can never reject into the timer.
      return evaluate(ctx);
    }, TICK_MS);
    // An idle follower must never keep Pi (or a scripted session) alive.
    if (timer && typeof timer.unref === "function") timer.unref();
  });

  pi.on("session_shutdown", () => {
    stop();
  });
}
