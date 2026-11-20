// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The end of a switch (#2419, FR-SHELL-082): a switch always ends on its view, visible and opaque. The gold once ended a
// view switch on a window that showed nothing but its own material, the view attached, its panels mounted and its
// renderer drawing frames, until the window was closed: some state of the switch (the picture, its cover, the let-through
// background, the pour, the visibility cycle of #223) was never given back, and the log could not tell that switch from
// a good one. So once a switch has landed and the window is idle, main looks at the view it ended on, on its own side
// (in the window, on screen, visible, under no other view, its background the one its look asks for) and in its page
// (the switch's marks, overlays and covers, an opacity of 0 on the page, its root or its panels, a hidden body), then
// reads one frame of it back: a frame with nothing painted is a view the user cannot see. Whatever is stuck is put back,
// and one line names it; a switch that landed well logs one line too, so the next occurrence shows in the log.
//
// The rules live here, apart from Electron, and are tested with a fake clock; moltenterm-switch-landing-live.ts runs
// them on real views.

// After the view is on screen: the settle (600 ms at most), the dissolve (120 ms) and main's last clear of the switch
// (#2390, 1 s after it ended) are over by then, so nothing a switch still legitimately holds is taken for stuck.
export const SwitchLandingCheckMs = 2000;
// A window running another action (a newer switch) is looked at again this much later, a few times at most: the newer
// switch's own landing check takes over once it is the one on screen.
export const SwitchLandingRetryMs = 500;
export const SwitchLandingMaxTries = 8;
// A page or a readback that does not answer within this long is taken as no answer: the check goes on without it.
export const SwitchLandingAnswerMs = 1500;
// Below this, an opacity is a page the user cannot see.
export const InvisibleOpacity = 0.05;
// The width a frame is read back at for the pixel test: enough for the sidebar's text to tell a drawn view from an
// empty one, small enough to cost little.
export const LandingFrameWidthPx = 160;
// A frame where fewer pixels than this share hold anything (alpha) shows nothing but what lies behind the window.
export const LandingPaintedShare = 0.02;

const OverlayId = "mt-switch-overlay";
const CoverId = "mt-switch-cover";
const WaitId = "mt-switch-wait";
const CoverAttribute = "data-mt-cover";
const ThroughAttribute = "data-mt-through";
// The remembered layout's layer over a view being left (#2407): while it shows, the panels fade on purpose.
const LeaveLayerId = "mt-switch-layout-leave";
const RootId = "main";
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
    leaving: boolean;
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
return {
  html: op(root), body: op(d.body), bodyVisibility: d.body ? getComputedStyle(d.body).visibility : "visible",
  main: op(m), content: op(c),
  coverMark: root.hasAttribute(${JSON.stringify(CoverAttribute)}),
  overlay: !!d.getElementById(${JSON.stringify(OverlayId)}), cover: !!d.getElementById(${JSON.stringify(CoverId)}),
  leaving: !!d.getElementById(${JSON.stringify(LeaveLayerId)}),
  shown: d.visibilityState === "visible"
};
} catch (e) { return null; } })()`;
}

function invisible(opacity: number): boolean {
    return opacity != null && opacity < InvisibleOpacity;
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
    // A view being left on purpose fades its panels under the next workspace's layout (#2407): that is not stuck.
    if (invisible(r.content) && !r.leaving) {
        stuck.push("panels at opacity 0");
    }
    return stuck;
}

// Puts the page back to visible and opaque: every switch leftover goes without a fade, an animation holding an opacity
// is cancelled and an inline opacity or visibility goes. Answers the parts it took off.
export function restoreLandingScript(): string {
    return `(function () { try {
var d = document, root = d.documentElement, found = [];
window.__mtOverlayWant = (window.__mtOverlayWant || 0) + 1;
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
function show(e, name) {
  if (!e) return;
  var anims = e.getAnimations ? e.getAnimations() : [];
  var faded = parseFloat(getComputedStyle(e).opacity) < ${InvisibleOpacity};
  if (!faded && (e.style.opacity === "" || e.style.opacity == null)) return;
  if (faded) found.push(name);
  anims.forEach(function (a) { a.cancel(); });
  e.style.opacity = "";
}
show(root, "page-opacity");
show(d.body, "body-opacity");
if (d.body && d.body.style.visibility === "hidden") { found.push("body-hidden"); d.body.style.visibility = ""; }
show(d.getElementById(${JSON.stringify(RootId)}), "content-opacity");
if (!d.getElementById(${JSON.stringify(LeaveLayerId)})) show(d.querySelector(${JSON.stringify(ContentSelector)}), "panels-opacity");
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

// Whether a frame read back (BGRA, as NativeImage.toBitmap gives it) holds anything: a view drawn fully transparent
// lets only what lies behind the window show. A flat frame of one colour is no drawn view either.
export function framePaints(
    bitmap: Uint8Array,
    size: { width: number; height: number },
    isFlat: (bitmap: Uint8Array, size: { width: number; height: number }) => boolean
): boolean {
    const n = (size?.width ?? 0) * (size?.height ?? 0);
    if (bitmap == null || n <= 0 || bitmap.length < n * 4) {
        return false;
    }
    let drawn = 0;
    for (let i = 0; i < n; i++) {
        if (bitmap[i * 4 + 3] > 8) {
            drawn++;
        }
    }
    if (drawn / n < LandingPaintedShare) {
        return false;
    }
    return !isFlat(bitmap, size);
}

export type SwitchLandingDeps = {
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    log(msg: string): void;
    // The view is still the window's active one, alive.
    stillLanded(): boolean;
    // The window runs an action (a newer switch): the check waits.
    busy(): boolean;
    mainState(): LandingMainState;
    restoreMain(stuck: string[]): void;
    probePage(): Promise<LandingPageReport>;
    restorePage(): Promise<unknown>;
    // The pixel test of one frame: false when nothing is painted, null when it cannot be told (the window hidden or
    // minimised, the readback failed).
    paints(): Promise<boolean>;
    cycleVisibility(): void;
    clearBackground: string;
};

export type LandingOutcome = { stuck: string[]; skipped?: string };

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

// One look at a landed view: what is stuck is restored, and the outcome logged.
export async function checkSwitchLanding(tabId: string, deps: SwitchLandingDeps): Promise<LandingOutcome> {
    if (!deps.stillLanded()) {
        return { stuck: [], skipped: "left" };
    }
    const main = deps.mainState();
    const mainStuck = stuckMainStates(main, deps.clearBackground);
    if (mainStuck.length > 0) {
        deps.restoreMain(mainStuck);
    }
    const report = await bounded(deps, deps.probePage(), SwitchLandingAnswerMs);
    if (!deps.stillLanded()) {
        return { stuck: [], skipped: "left" };
    }
    const pageStuck = stuckPageStates(report);
    if (pageStuck.length > 0) {
        await bounded(deps, deps.restorePage(), SwitchLandingAnswerMs);
    }
    // Shown by main, in a window that shows it, yet hidden to itself: only a real visibility cycle makes it draw.
    const hiddenPage = report != null && report.shown === false && mainStuck.length === 0 && main?.windowShows === true;
    // Read back only when nothing was found: a restored page draws its next frame after this one.
    let paints: boolean = null;
    if (mainStuck.length === 0 && pageStuck.length === 0 && !hiddenPage) {
        paints = await bounded(deps, deps.paints(), SwitchLandingAnswerMs);
    }
    if ((hiddenPage || paints === false) && deps.stillLanded()) {
        deps.cycleVisibility();
    }
    const stuck = [
        ...mainStuck,
        ...pageStuck,
        ...(hiddenPage ? ["page hidden while on screen"] : []),
        ...(paints === false ? ["nothing painted"] : []),
    ];
    if (stuck.length > 0) {
        deps.log(
            `[#2419] the view ${tabId} was left invisible after its switch (${stuck.join("; ")}): restored to visible and opaque`
        );
        return { stuck };
    }
    const content = report == null ? "unknown (the page did not answer)" : String(report.main ?? "none");
    deps.log(
        `[#2419] switch to ${tabId} landed: on screen, visible, background ${main?.background ?? "unknown"}, content opacity ${content}${paints === true ? ", painted" : ""}`
    );
    return { stuck };
}

// Watches one landed switch: the check runs SwitchLandingCheckMs after the view is on screen, put off while the window
// runs an action. Returns the cancel, which a newer landing of the same window calls.
export function watchSwitchLanding(
    tabId: string,
    deps: SwitchLandingDeps,
    done?: (outcome: LandingOutcome) => void
): () => void {
    let timer: unknown = null;
    let cancelled = false;
    let tries = 0;
    const run = () => {
        timer = null;
        if (cancelled) {
            return;
        }
        if (!deps.stillLanded()) {
            done?.({ stuck: [], skipped: "left" });
            return;
        }
        if (deps.busy() && tries < SwitchLandingMaxTries) {
            tries++;
            timer = deps.setTimer(run, SwitchLandingRetryMs);
            return;
        }
        checkSwitchLanding(tabId, deps)
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
