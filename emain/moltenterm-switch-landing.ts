// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The end of a switch (#2419, FR-SHELL-082): a switch always ends on its view, visible and opaque. The gold once ended a
// view switch on a window that showed nothing but its own material, the view attached, its panels mounted and its
// renderer drawing frames, until the window was closed; the log could not tell that switch from a good one, and the case
// was not reproduced. So once a switch has landed and the window is idle, main looks at the view it ended on, on its own
// side (in the window, on screen, visible, under no other view, its background the one its look asks for) and in its
// page (the switch's marks, overlays and covers, an opacity of 0 on the page, its root or its panels, a hidden body, a
// page hidden to itself in a window that shows it), then, in a window that shows it, reads a thin band of one frame back:
// a band with nothing painted at all is a view the user cannot see. Whatever is stuck is put back and looked at again,
// and one line names it; a switch that landed well logs one line too, so the next occurrence shows in the log.
//
// The check never touches a view a newer switch is using: it gives up while the window runs an action, and a switch
// that starts cancels it.
//
// The rules live here, apart from Electron, and are tested with a fake clock; moltenterm-switch-landing-live.ts runs
// them on real views.

import {
    CoverAttribute,
    CoverId,
    OverlayId,
    OverlayToken,
    RootId,
    SwitchFadeId,
    ThroughAttribute,
    WaitId,
} from "./moltenterm-switch-picture";

// After the view is on screen: the settle (600 ms at most), the dissolve (120 ms) and main's last clear of the switch
// (#2390, 1 s after it ended) are over by then, so nothing a switch still legitimately holds is taken for stuck.
export const SwitchLandingCheckMs = 2000;
// A window running another action is looked at again this much later, a few times; still busy after that, the check
// gives up: that action is a newer switch, whose own landing is checked.
export const SwitchLandingRetryMs = 500;
export const SwitchLandingMaxTries = 8;
// A page or a readback that does not answer within this long is taken as no answer: the check goes on without it.
export const SwitchLandingAnswerMs = 1500;
// Below this, an opacity is a page the user cannot see.
export const InvisibleOpacity = 0.05;
// The band of the frame read back for the pixel test: the window's whole width (the sidebar and the panels), this many
// CSS pixels high at mid-height. A few hundred kilobytes, against megabytes for a whole frame.
export const LandingBandHeightPx = 24;
// A band where fewer pixels than this share hold anything (alpha) shows nothing but what lies behind the window. Only
// transparency counts: a dark, nearly flat view (an empty terminal, the sidebar folded) is drawn.
export const LandingPaintedShare = 0.02;

// The remembered layout's layer over a view being left (#2407, frontend/moltenterm-shell/switch-layout/layout-frames.ts):
// while it shows, the panels fade on purpose; one older than LeaveMaxMs was left over. Its cross-fade's id, so only it is
// cancelled. switch-landing.test.ts fails when these drift from the page's.
export const LeaveLayerId = "mt-switch-layout-leave";
export const LeaveAnimationId = "mt-switch-layout-leave";
export const LeaveMaxMs = 4000;
const ContentSelector = ".mt-frame-content";

export type LandingPageReport = {
    html: number;
    body: number;
    bodyVisibility: string;
    main: number;
    // The panels' area, when the page has one.
    content: number;
    coverMark: boolean;
    overlay: boolean;
    cover: boolean;
    // The age of the layout's leave layer, null when there is none.
    leaveAgeMs: number;
    // The page believes it is shown (document.visibilityState).
    shown: boolean;
};

export type LandingMainState = {
    inWindow: boolean;
    onScreen: boolean;
    visible: boolean;
    // Another of the window's views sits on screen over it.
    covered: boolean;
    background: string;
    // The view's look lets the desktop through, so a cleared background is its own.
    wantsClear: boolean;
    // The window can show the view's frames: visible, not minimised, focused (so not covered by another window). A
    // page of such a window that believes it is hidden draws nothing on screen, and a readback, which shows the page for
    // its own frame, cannot tell.
    windowShows: boolean;
};

// Read in the view's page: what of the page is drawn, and what of a switch it still holds.
export function landingProbeScript(): string {
    return `(function () { try {
var d = document, root = d.documentElement, m = d.getElementById(${JSON.stringify(RootId)}), c = d.querySelector(${JSON.stringify(ContentSelector)});
function op(e) { if (!e) return null; var v = parseFloat(getComputedStyle(e).opacity); return isNaN(v) ? 1 : v; }
var lv = d.getElementById(${JSON.stringify(LeaveLayerId)}), at = lv && lv.dataset ? parseFloat(lv.dataset.at) : NaN;
return {
  html: op(root), body: op(d.body), bodyVisibility: d.body ? getComputedStyle(d.body).visibility : "visible",
  main: op(m), content: op(c),
  coverMark: root.hasAttribute(${JSON.stringify(CoverAttribute)}),
  overlay: !!d.getElementById(${JSON.stringify(OverlayId)}), cover: !!d.getElementById(${JSON.stringify(CoverId)}),
  leaveAgeMs: lv ? (isNaN(at) ? ${LeaveMaxMs + 1} : Date.now() - at) : null,
  shown: d.visibilityState === "visible"
};
} catch (e) { return null; } })()`;
}

function invisible(opacity: number): boolean {
    return opacity != null && opacity < InvisibleOpacity;
}

function leaveLeftOver(r: LandingPageReport): boolean {
    return r.leaveAgeMs != null && r.leaveAgeMs > LeaveMaxMs;
}

// The page's states that leave the view invisible, or covered by a switch's leftover, in the words of the log.
export function stuckPageStates(r: LandingPageReport): string[] {
    if (r == null) {
        return [];
    }
    const stuck: string[] = [];
    if (r.coverMark) {
        stuck.push("cover mark (panels hidden under a picture)");
    }
    if (r.overlay) {
        stuck.push("picture overlay");
    }
    if (r.cover) {
        stuck.push("picture cover");
    }
    if (leaveLeftOver(r)) {
        stuck.push("layout leave layer left over");
    }
    if (invisible(r.html)) {
        stuck.push("page at opacity 0");
    }
    if (invisible(r.body)) {
        stuck.push("body at opacity 0");
    }
    if (r.bodyVisibility === "hidden") {
        stuck.push("body hidden");
    }
    if (invisible(r.main)) {
        stuck.push("content at opacity 0");
    }
    // A view being left fades its panels under the next workspace's layout on purpose (#2407), for LeaveMaxMs at most.
    if (invisible(r.content) && (r.leaveAgeMs == null || leaveLeftOver(r))) {
        stuck.push("panels at opacity 0");
    }
    return stuck;
}

// Puts the page back to visible and opaque: every switch leftover goes without a fade, a switch's animation holding an
// opacity is cancelled (never the page's own), and an inline opacity or visibility goes. Answers the parts it took off.
export function restoreLandingScript(): string {
    return `(function () { try {
var d = document, root = d.documentElement, found = [];
window.${OverlayToken} = (window.${OverlayToken} || 0) + 1;
window.__mtCoverGiveUp = true; window.__mtCover = null;
var ov = d.getElementById(${JSON.stringify(OverlayId)});
if (ov) {
  found.push("overlay");
  var through = ov.getAttribute(${JSON.stringify(ThroughAttribute)});
  if (through != null) { var bg = through.split("|"); root.style.background = bg[0]; d.body.style.background = bg[1] || ""; }
  ov.remove();
}
var c = d.getElementById(${JSON.stringify(CoverId)}); if (c) { found.push("cover"); c.remove(); }
var w = d.getElementById(${JSON.stringify(WaitId)}); if (w) { found.push("wait"); w.remove(); }
if (root.hasAttribute(${JSON.stringify(CoverAttribute)})) { found.push("cover-mark"); root.removeAttribute(${JSON.stringify(CoverAttribute)}); }
var lv = d.getElementById(${JSON.stringify(LeaveLayerId)}), at = lv && lv.dataset ? parseFloat(lv.dataset.at) : NaN;
var leaveOld = !!lv && (isNaN(at) || Date.now() - at > ${LeaveMaxMs});
if (leaveOld) { found.push("leave-layer"); lv.remove(); lv = null; }
function ours(a) { return a.id === ${JSON.stringify(SwitchFadeId)} || a.id === ${JSON.stringify(LeaveAnimationId)}; }
function show(e, name) {
  if (!e) return;
  var faded = parseFloat(getComputedStyle(e).opacity) < ${InvisibleOpacity};
  if (!faded) return;
  found.push(name);
  (e.getAnimations ? e.getAnimations() : []).forEach(function (a) { if (ours(a)) a.cancel(); });
  e.style.opacity = "";
}
show(root, "page-opacity");
show(d.body, "body-opacity");
if (d.body && d.body.style.visibility === "hidden") { found.push("body-hidden"); d.body.style.visibility = ""; }
show(d.getElementById(${JSON.stringify(RootId)}), "content-opacity");
if (!lv) show(d.querySelector(${JSON.stringify(ContentSelector)}), "panels-opacity");
return found.length ? found.join(",") : "clean";
} catch (e) { return "error:" + e; } })()`;
}

// Main's side of the view, in the words of the log.
export function stuckMainStates(s: LandingMainState, clearBackground: string): string[] {
    if (s == null) {
        return [];
    }
    const stuck: string[] = [];
    if (!s.inWindow) {
        stuck.push("not in the window");
    }
    if (!s.onScreen) {
        stuck.push("off screen");
    }
    if (!s.visible) {
        stuck.push("hidden");
    }
    if (s.covered) {
        stuck.push("under another view");
    }
    if (s.background === clearBackground && !s.wantsClear) {
        stuck.push("let through (background cleared on an opaque look)");
    }
    return stuck;
}

// Whether a band read back (BGRA, as NativeImage.toBitmap gives it) holds anything: a view drawn fully transparent lets
// only what lies behind the window show. Null when there is nothing to judge.
export function framePaints(bitmap: Uint8Array, size: { width: number; height: number }): boolean {
    const n = (size?.width ?? 0) * (size?.height ?? 0);
    if (bitmap == null || n <= 0 || bitmap.length < n * 4) {
        return null;
    }
    let drawn = 0;
    for (let i = 0; i < n; i++) {
        if (bitmap[i * 4 + 3] > 8) {
            drawn++;
        }
    }
    return drawn / n >= LandingPaintedShare;
}

export type SwitchLandingDeps = {
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    log(msg: string): void;
    // The view is still the window's active one, alive.
    stillLanded(): boolean;
    // The window runs an action (a newer switch): the check leaves the view alone.
    busy(): boolean;
    mainState(): LandingMainState;
    restoreMain(stuck: string[]): void;
    probePage(): Promise<LandingPageReport>;
    restorePage(): Promise<unknown>;
    // The pixel test of one band: false when nothing is painted, null when it cannot be told (the readback failed or
    // came back empty).
    paints(): Promise<boolean>;
    cycleVisibility(): void;
    clearBackground: string;
};

export type LandingOutcome = { stuck: string[]; remaining?: string[]; skipped?: string };

// A promise's value, or null once ms have passed.
function bounded<T>(deps: SwitchLandingDeps, p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve) => {
        let done = false;
        const timer = deps.setTimer(() => {
            if (!done) {
                done = true;
                resolve(null);
            }
        }, ms);
        p.then(
            (v) => {
                if (!done) {
                    done = true;
                    deps.clearTimer(timer);
                    resolve(v);
                }
            },
            () => {
                if (!done) {
                    done = true;
                    deps.clearTimer(timer);
                    resolve(null);
                }
            }
        );
    });
}

// Why the check must leave the view alone now, or null: it left the screen, or a newer switch is under way.
function interrupted(deps: SwitchLandingDeps): string {
    if (!deps.stillLanded()) {
        return "left";
    }
    return deps.busy() ? "busy" : null;
}

// One look at a landed view: what is stuck is restored and looked at again, and the outcome logged. Each step that
// changes the view first makes sure no newer switch has started.
export async function checkSwitchLanding(tabId: string, deps: SwitchLandingDeps): Promise<LandingOutcome> {
    const skip = (why: string): LandingOutcome => ({ stuck: [], skipped: why });
    let why = interrupted(deps);
    if (why != null) {
        return skip(why);
    }
    const main = deps.mainState();
    const mainStuck = stuckMainStates(main, deps.clearBackground);
    if (mainStuck.length > 0) {
        deps.restoreMain(mainStuck);
    }
    const report = await bounded(deps, deps.probePage(), SwitchLandingAnswerMs);
    if ((why = interrupted(deps)) != null) {
        return skip(why);
    }
    const pageStuck = stuckPageStates(report);
    if (pageStuck.length > 0) {
        await bounded(deps, deps.restorePage(), SwitchLandingAnswerMs);
    }
    // Shown by main, in a window that shows it, yet hidden to itself: only a real visibility cycle makes it draw.
    const hiddenPage = report != null && report.shown === false && mainStuck.length === 0 && main?.windowShows === true;
    // Read back only when nothing else was found (a restored page draws its next frame after this one), and only in a
    // window that shows its frames.
    let paints: boolean = null;
    if (mainStuck.length === 0 && pageStuck.length === 0 && !hiddenPage && main?.windowShows === true) {
        if ((why = interrupted(deps)) != null) {
            return skip(why);
        }
        paints = await bounded(deps, deps.paints(), SwitchLandingAnswerMs);
    }
    if (hiddenPage || paints === false) {
        if ((why = interrupted(deps)) != null) {
            return skip(why);
        }
        deps.cycleVisibility();
    }
    const stuck = [
        ...mainStuck,
        ...pageStuck,
        ...(hiddenPage ? ["page hidden while on screen"] : []),
        ...(paints === false ? ["nothing painted"] : []),
    ];
    if (stuck.length === 0) {
        const content = report == null ? "unknown (the page did not answer)" : String(report.main ?? "none");
        deps.log(
            `[#2419] switch to ${tabId} landed: on screen, visible, background ${main?.background ?? "unknown"}, content opacity ${content}${paints === true ? ", painted" : ""}`
        );
        return { stuck };
    }
    // Looked at again: the line says whether the restore took.
    let remaining: string[] = [];
    if (mainStuck.length > 0 || pageStuck.length > 0) {
        if ((why = interrupted(deps)) != null) {
            return { stuck, skipped: why };
        }
        const again = await bounded(deps, deps.probePage(), SwitchLandingAnswerMs);
        remaining = [...stuckMainStates(deps.mainState(), deps.clearBackground), ...stuckPageStates(again)];
    }
    deps.log(
        remaining.length === 0
            ? `[#2419] the view ${tabId} was left invisible after its switch (${stuck.join("; ")}): restored to visible and opaque`
            : `[#2419] the view ${tabId} was left invisible after its switch (${stuck.join("; ")}): still stuck: ${remaining.join("; ")}`
    );
    return { stuck, remaining };
}

// Watches one landed switch: the check runs SwitchLandingCheckMs after the view is on screen, put off while the window
// runs an action, and given up when it stays busy. Returns the cancel, which a switch that starts, a newer landing and
// the window's close call; a cancelled check stops before its next step.
export function watchSwitchLanding(
    tabId: string,
    deps: SwitchLandingDeps,
    done?: (outcome: LandingOutcome) => void
): () => void {
    let timer: unknown = null;
    let cancelled = false;
    let tries = 0;
    const live: SwitchLandingDeps = {
        ...deps,
        stillLanded: () => !cancelled && deps.stillLanded(),
        busy: () => cancelled || deps.busy(),
    };
    const run = () => {
        timer = null;
        if (cancelled) {
            return;
        }
        if (!deps.stillLanded()) {
            done?.({ stuck: [], skipped: "left" });
            return;
        }
        if (deps.busy()) {
            if (tries >= SwitchLandingMaxTries) {
                done?.({ stuck: [], skipped: "busy" });
                return;
            }
            tries++;
            timer = deps.setTimer(run, SwitchLandingRetryMs);
            return;
        }
        checkSwitchLanding(tabId, live)
            .then((outcome) => done?.(outcome))
            .catch((e) => {
                deps.log(`[#2419] the landing check of ${tabId} failed: ${String((e as Error)?.message ?? e)}`);
                done?.({ stuck: [], skipped: "failed" });
            });
    };
    timer = deps.setTimer(run, SwitchLandingCheckMs);
    return () => {
        cancelled = true;
        if (timer != null) {
            deps.clearTimer(timer);
            timer = null;
        }
    };
}
