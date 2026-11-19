// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The switch picture (#2375, FR-SHELL-082, FR-SHELL-112): a switch of workspace or of view never shows an empty frame
// and starts at the instant the user acts. Every view leaves a picture of itself behind when it is left; the next
// switch to it cross-fades the window to that picture at once, while the target's view attaches. The target is put on
// screen at the same time as before, wearing the same picture, which dissolves into the live content once its panels
// are mounted and have painted. Wave and #68 cut from the view being left to a target that had not painted, and the
// pending state covered the panels first (measured: a blank panel area with a domino at +69 ms, the target's stale
// last frame at +86 ms, its panels restarting at opacity 0 at +130 ms, full opacity at +300 ms).
//
// Everything runs in Electron main: the views' own bundles carry nothing of it (the startup JS budget has no room),
// scripts are run in them with executeJavaScript, as the paint check of #223 does. The pictures stay in this module's
// memory: never written to the disk, never logged.
//
// This file holds the rules apart from Electron (the store, the scripts, the choreography of one window's switch) so
// they are tested with a fake clock; moltenterm-switch-picture-live.ts puts them on real views.

// The motion tokens of frontend/moltenterm-shell/tokens.css, for a page that cannot answer them (the scripts read the
// page's own values first): the cross-fade in --mt-duration-base and the dissolve in --mt-duration-fast, with
// --mt-ease. switch-picture.test.ts fails when they drift apart.
export const SwitchMotion = {
    fadeInMs: 180,
    dissolveMs: 120,
    easing: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

// The domino shows over the picture once the wait passes this; a switch without a picture keeps the pending state's
// own grace (emain/moltenterm-view-pending.ts).
export const SwitchWaitingGraceMs = 400;
// After the target is on screen, the picture stays at most this long for its panels to mount and paint.
export const SwitchSettleMaxMs = 600;
export const SwitchSettlePollMs = 40;
// A picture handed to a page ahead of the click stays there, decoded, this long.
export const SwitchArmedMs = 10000;
// After the target's reinit is done, a cover still decoding is waited for this long at most: the target never comes on
// screen later than before because of its picture (measured: the decode of a 1280 px PNG takes about 45 ms).
export const SwitchCoverGraceMs = 8;
// A switch that never reached its target (its action died without a word) lets the picture go after this.
export const SwitchHoldMaxMs = 15000;
// A cover its switch never took off (its action died without a word) goes by itself after this: a reinit is waited
// for 400 ms at most and the panels for SwitchSettleMaxMs, so a live switch is done long before, and a stuck cover is
// not left over a view in use for as long as the leaver's hold.
export const SwitchCoverMaxMs = 3000;
// The capture of a view being left is encoded once the switch has landed: the resize and the JPEG are the one slow
// step, and the swap and the first frames of the target must not wait for them.
export const SwitchEncodeDelayMs = 400;
// The encode blocks the main process for about 100 ms: it never runs within this long of an intent or a switch (a click
// can follow a hover by any delay), it waits for the user to settle.
export const SwitchEncodeQuietMs = 1500;

// What is left to wait before an encode may run, given the end of the quiet window an intent or a switch opened.
export function encodeWaitMs(now: number, quietUntil: number): number {
    return Math.max(0, quietUntil - now);
}

// The end of the quiet window an intent or a switch at `now` opens: it only ever moves later.
export function quietUntilAfter(now: number, current: number): number {
    return Math.max(current, now + SwitchEncodeQuietMs);
}
// Each capture waiting to be encoded holds a whole bitmap (about 59 MB on a 5K HiDPI display): two at most wait.
export const SwitchEncodeQueueMax = 2;
// A view's picture is not taken again within this long of the last one.
export const SwitchPictureMinGapMs = 3000;

export const SwitchPictureLimits = {
    maxEntries: 6,
    maxAgeMs: 30 * 60 * 1000,
    maxWidthPx: 1600,
    // A PNG costs more to encode and to keep: a see-through view's picture is smaller.
    maxTranslucentWidthPx: 960,
    jpegQuality: 72,
    // The window's size when the picture was taken, in CSS pixels: a window resized since shows no picture.
    sizeTolerancePx: 1,
} as const;

export type SwitchPicture = {
    tabId: string;
    workspaceId: string;
    width: number;
    height: number;
    at: number;
    // The encoded image, sent to a page as binary: a picture inlined in a script costs the page tens of milliseconds
    // of parsing on its main thread, which a reinit waits behind (measured: +35 ms on the time to usable).
    mime: string;
    bytes: Uint8Array;
    // Taken of a view that lets the desktop through: a PNG that keeps its alpha, and its live content stays out of
    // sight under it, so the two layers never add up their see-through.
    translucent: boolean;
};

// What a switch goes to: a workspace (its active view) or one view.
export type SwitchTarget = { workspaceId?: string; tabId?: string };

export class SwitchPictureStore {
    private entries = new Map<string, SwitchPicture>();

    constructor(
        readonly maxEntries: number = SwitchPictureLimits.maxEntries,
        readonly maxAgeMs: number = SwitchPictureLimits.maxAgeMs
    ) {}

    get size(): number {
        return this.entries.size;
    }

    put(picture: SwitchPicture) {
        this.entries.delete(picture.tabId);
        this.entries.set(picture.tabId, picture);
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            this.entries.delete(oldest);
        }
    }

    forTab(tabId: string, now: number): SwitchPicture {
        const picture = this.entries.get(tabId);
        if (picture == null) {
            return null;
        }
        if (now - picture.at > this.maxAgeMs) {
            this.entries.delete(tabId);
            return null;
        }
        return picture;
    }

    // The latest picture of a workspace: the view it showed when it was left, which is the one it shows again.
    forWorkspace(workspaceId: string, now: number): SwitchPicture {
        let best: SwitchPicture = null;
        for (const picture of Array.from(this.entries.values())) {
            if (picture.workspaceId !== workspaceId) {
                continue;
            }
            if (now - picture.at > this.maxAgeMs) {
                this.entries.delete(picture.tabId);
                continue;
            }
            if (best == null || picture.at > best.at) {
                best = picture;
            }
        }
        return best;
    }

    forTarget(target: SwitchTarget, now: number): SwitchPicture {
        if (target?.tabId != null) {
            return this.forTab(target.tabId, now);
        }
        return target?.workspaceId != null ? this.forWorkspace(target.workspaceId, now) : null;
    }

    dropTab(tabId: string) {
        this.entries.delete(tabId);
    }

    dropWorkspace(workspaceId: string) {
        for (const picture of Array.from(this.entries.values())) {
            if (picture.workspaceId === workspaceId) {
                this.entries.delete(picture.tabId);
            }
        }
    }

    // The tabs that still exist keep their pictures; the others go.
    keepOnly(tabIds: ReadonlySet<string>) {
        for (const tabId of Array.from(this.entries.keys())) {
            if (!tabIds.has(tabId)) {
                this.entries.delete(tabId);
            }
        }
    }

    tabIds(): string[] {
        return Array.from(this.entries.keys());
    }

    clear() {
        this.entries.clear();
    }
}

// A tab closed by any path (the window, the backend, an agent, `wsh`) leaves no picture behind: the pictures' tabs are
// asked of the backend and the ones it no longer has go. A backend that does not answer drops nothing.
export async function prunePictures(
    store: SwitchPictureStore,
    existingTabIds: (tabIds: string[]) => Promise<ReadonlySet<string>>
): Promise<number> {
    const before = store.tabIds();
    if (before.length === 0) {
        return 0;
    }
    let existing: ReadonlySet<string>;
    try {
        existing = await existingTabIds(before);
    } catch (e) {
        return 0;
    }
    // A picture put while the backend answered belongs to a tab it was not asked about: it stays.
    const asked = new Set(before);
    const gone = before.filter((id) => !existing.has(id));
    store.keepOnly(new Set(store.tabIds().filter((id) => existing.has(id) || !asked.has(id))));
    return gone.length;
}

export function pictureFits(picture: SwitchPicture, width: number, height: number): boolean {
    if (picture == null) {
        return false;
    }
    const tol = SwitchPictureLimits.sizeTolerancePx;
    return Math.abs(picture.width - width) <= tol && Math.abs(picture.height - height) <= tol;
}

// What the keys of the view being left may do while the screen shows the target: only what cannot reach its terminal.
// A shortcut (Cmd, Alt, Ctrl with Shift) goes on, so a second switch, a quit or a menu still work; anything typed is
// held back, so nothing lands in the workspace the screen no longer shows.
export type SwitchKeyInput = { control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean };

export function swallowsKey(input: SwitchKeyInput): boolean {
    if (input == null) {
        return false;
    }
    if (input.meta || input.alt) {
        return false;
    }
    return !(input.control && input.shift);
}

// --- the scripts run in the views

const OverlayId = "mt-switch-overlay";
const WaitId = "mt-switch-wait";
const CoverId = "mt-switch-cover";
// The app's React root: what a see-through view's own content is, kept out of sight under its picture.
const RootId = "main";
export const CoverAttribute = "data-mt-cover";
// The value that hides the root (moltenterm-shell.css holds the rule); "opaque" only marks that a cover is on.
export const CoverHidesRoot = "translucent";
// On the overlay of a view whose page background went for the switch: the inline backgrounds to give back.
const ThroughAttribute = "data-mt-through";
// How a picture reaches a page: main sends its bytes on this channel, the preload makes a blob URL of them and puts it
// on the page's root under this attribute, and the scripts below read it.
export const PictureChannel = "moltenterm-switch-picture";
export const PictureAttribute = "data-mt-picture";

// Shared by the scripts: the page's own tokens first (the page is the one source of the motion), the constants of
// this file when it cannot answer, and the reduced-motion rule of molten-motion.ts (the app's setting or the system's).
const Prelude = `
var d = document, root = d.documentElement;
var reduced = !!d.querySelector(".prefers-reduced-motion") || !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
var cs = getComputedStyle(root);
function cssMs(name, fallback) {
  var v = (cs.getPropertyValue(name) || "").trim(), m = /^(-?[\\d.]+)(ms|s)$/.exec(v);
  if (!m) return fallback;
  return m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
}
var ease = (cs.getPropertyValue("--mt-ease") || "").trim() || ${JSON.stringify(SwitchMotion.easing)};
var fadeMs = cssMs("--mt-duration-base", ${SwitchMotion.fadeInMs});
var dissolveMs = cssMs("--mt-duration-fast", ${SwitchMotion.dissolveMs});
function fade(el, from, to, ms, done) {
  if (reduced || !(ms > 0) || !el.animate) { el.style.opacity = String(to); if (done) done(); return; }
  el.style.opacity = String(to);
  var a = el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: ease });
  if (done) { a.onfinish = done; a.oncancel = done; }
}
// The picture's blob URL, made by the preload from the bytes main sent. A message sent just before this script may still
// be in the queue: the script yields to it a few times (a message channel is never throttled, a timer in a hidden page is).
function pictureUrl(tries, cb) {
  var u = root.getAttribute(${JSON.stringify(PictureAttribute)});
  if (u || tries <= 0) { cb(u); return; }
  var ch = new MessageChannel();
  ch.port1.onmessage = function () { ch.port1.close(); pictureUrl(tries - 1, cb); };
  ch.port2.postMessage(0);
}
function forgetPicture() {
  var u = root.getAttribute(${JSON.stringify(PictureAttribute)});
  if (u) { URL.revokeObjectURL(u); root.removeAttribute(${JSON.stringify(PictureAttribute)}); }
}
`;

function layerStyle(): string {
    return "position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:fill;user-select:none;-webkit-user-drag:none;opacity:0;will-change:opacity";
}

// Puts the picture over the view being left, cross-fading from what shows (or from the picture already there, when a
// newer switch changes the target). The overlay takes the pointer: a click on a picture must not land in the old view.
// fadeRoot: the picture lets the desktop through, and so does the view (its own look, or its background cleared for the
// switch, #2390), so the view's own content fades out as the picture fades in, added to it (plus-lighter, a
// cross-dissolve of premultiplied colours), instead of the two layers adding up their see-through and the window turning
// more or less opaque half-way. An opaque page's own background goes for the switch, so the desktop comes through with
// the cross-fade; the overlay's removal gives it back.
export function showPictureScript(fadeRoot: boolean): string {
    return `(function () { try {${Prelude}
var ov = d.getElementById(${JSON.stringify(OverlayId)});
var layer = d.createElement("img");
layer.alt = ""; layer.decoding = "async"; layer.setAttribute("aria-hidden", "true");
layer.style.cssText = ${JSON.stringify(layerStyle())};
var go = function () {
  var below = [];
  if (!ov) {
    ov = d.createElement("div"); ov.id = ${JSON.stringify(OverlayId)}; ov.setAttribute("aria-hidden", "true");
    ov.style.cssText = "position:fixed;inset:0;z-index:2147483000;overflow:hidden;cursor:default";
    d.body.appendChild(ov);
    var m = ${JSON.stringify(fadeRoot)} ? d.getElementById(${JSON.stringify(RootId)}) : null;
    if (m) {
      ov.style.mixBlendMode = "plus-lighter";
      ov.setAttribute(${JSON.stringify(ThroughAttribute)}, (root.style.background || "") + "|" + (d.body.style.background || ""));
      root.style.background = "transparent"; d.body.style.background = "transparent";
      fade(m, 1, 0, fadeMs);
    }
  } else { below = Array.prototype.slice.call(ov.children).filter(function (c) { return c.tagName === "IMG"; }); ov.style.opacity = ""; }
  ov.appendChild(layer);
  fade(layer, 0, 1, fadeMs, function () { below.forEach(function (b) { b.remove(); }); });
};
pictureUrl(40, function (u) { if (!u) return; layer.src = u; layer.decode().then(go, go); });
return "ok";
} catch (e) { return "error:" + e; } })()`;
}

// Decodes a picture ahead of the click, off screen: the show that follows finds it in the image cache.
export function armPictureScript(): string {
    return `(function () { try {${Prelude}
pictureUrl(40, function (u) {
  if (!u) return;
  var img = new Image(); img.decoding = "async"; img.src = u;
  window.__mtSwitchArmed = img; img.decode().catch(function () {});
});
return "armed";
} catch (e) { return "error:" + e; } })()`;
}

// The view being left, its overlay no longer wanted: gone at once (the view is off screen) or faded out (the switch
// ended without a target, the view stays).
export function removeOverlayScript(fadeOut: boolean): string {
    return `(function () { try {${Prelude}
window.__mtSwitchArmed = null;
forgetPicture();
var ov = d.getElementById(${JSON.stringify(OverlayId)});
if (!ov) return "none";
var w = d.getElementById(${JSON.stringify(WaitId)}); if (w) w.remove();
var m = d.getElementById(${JSON.stringify(RootId)});
var held = !!m && m.style.opacity === "0";
var through = ov.getAttribute(${JSON.stringify(ThroughAttribute)});
if (through != null) { var bg = through.split("|"); root.style.background = bg[0]; d.body.style.background = bg[1] || ""; }
var gone = function () { ov.remove(); };
if (${JSON.stringify(fadeOut)}) {
  fade(ov, 1, 0, dissolveMs, gone);
  if (held) fade(m, 0, 1, dissolveMs, function () { m.style.opacity = ""; });
} else { gone(); if (held) m.style.opacity = ""; }
return "ok";
} catch (e) { return "error:" + e; } })()`;
}

export type WaitingState = { phase: string; name: string; caption: string } | null;

// The caption's key (the dictionary of the interface language, the same words as the pending state's own).
export function waitingCaptionKey(phase: string): string {
    return phase === "retrying" ? "shell.pending.stillOpening" : "shell.pending.opening";
}

// The wait over the picture: the suite's dominoes (the page's own df-dominos rules), the workspace's name and the
// caption main translated, only once the grace passed.
export function waitingScript(state: WaitingState): string {
    return `(function () { try {
var d = document, host = d.getElementById(${JSON.stringify(OverlayId)}) || d.getElementById(${JSON.stringify(CoverId)});
var old = d.getElementById(${JSON.stringify(WaitId)});
var s = ${JSON.stringify(state)};
if (!s || !host) { if (old) old.remove(); return "none"; }
if (!old) {
  old = d.createElement("div"); old.id = ${JSON.stringify(WaitId)}; old.setAttribute("role", "status"); old.setAttribute("aria-live", "polite");
  old.style.cssText = "position:absolute;left:50%;bottom:12%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 18px;border-radius:10px;background:color-mix(in srgb, var(--color-background, #1f1f1f) 82%, transparent);color:var(--color-primary, #f7f7f7);text-align:center;max-width:360px";
  var name = d.createElement("div"); name.className = "mt-sw-name"; name.style.cssText = "font-weight:600;font-size:13px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  var dom = d.createElement("span"); dom.className = "df-dominos"; dom.setAttribute("aria-hidden", "true");
  for (var i = 0; i < 8; i++) dom.appendChild(d.createElement("span"));
  var cap = d.createElement("p"); cap.className = "mt-sw-caption"; cap.style.cssText = "margin:0;font-size:12px;opacity:.7";
  old.appendChild(name); old.appendChild(dom); old.appendChild(cap); host.appendChild(old);
}
old.querySelector(".mt-sw-name").textContent = s.name || "";
old.querySelector(".mt-sw-caption").textContent = s.caption || "";
return "ok";
} catch (e) { return "error:" + e; } })()`;
}

// The same picture on the target before it is shown, so that nothing but the picture shows on its first frames. It does
// not take the pointer: the target is usable the moment it is on screen. In two steps, so that the target's reinit never
// shares its page with a full-window picture: the picture is decoded off to the side (prepareCoverScript, as early as the
// view is known) and goes on only just before the view is shown (attachCoverScript, a few milliseconds).
// Until the picture is decoded the page shows what it has; a page given up (giveUpCoverScript) never gets it.
export function prepareCoverScript(): string {
    return `(function () { try {${Prelude}
window.__mtCoverGiveUp = false;
window.__mtCover = null;
var old = d.getElementById(${JSON.stringify(CoverId)});
if (old) old.remove();
return new Promise(function (resolve) {
  pictureUrl(40, function (u) {
    if (!u) { resolve("missing"); return; }
    var img = new Image(); img.alt = ""; img.decoding = "async";
    img.style.cssText = ${JSON.stringify(layerStyle().replace("opacity:0", "opacity:1"))};
    img.src = u;
    img.decode().then(function () { window.__mtCover = img; resolve("ready"); }, function () { resolve("undecoded"); });
  });
});
} catch (e) { return "error:" + e; } })()`;
}

// hidesRoot: the picture lets the desktop through, so the page's own content stays out of sight under it (the rule of
// moltenterm-shell.css) until the picture dissolves.
export function attachCoverScript(hidesRoot: boolean): string {
    return `(function () { try {
var d = document, root = d.documentElement, img = window.__mtCover;
if (!img || window.__mtCoverGiveUp) return "not-ready";
window.__mtCover = null;
var c = d.createElement("div"); c.id = ${JSON.stringify(CoverId)}; c.setAttribute("aria-hidden", "true");
c.style.cssText = "position:fixed;inset:0;z-index:2147483000;overflow:hidden;pointer-events:none";
c.appendChild(img); d.body.appendChild(c);
root.setAttribute(${JSON.stringify(CoverAttribute)}, ${JSON.stringify(hidesRoot ? CoverHidesRoot : "opaque")});
setTimeout(function () { if (c.isConnected) { c.remove(); root.removeAttribute(${JSON.stringify(CoverAttribute)}); } }, ${SwitchCoverMaxMs});
return "ok";
} catch (e) { return "error:" + e; } })()`;
}

// The target is shown without its cover: if the cover is still decoding, it never goes on (it would hide a view in use),
// and if it is on, it goes.
export function giveUpCoverScript(): string {
    return `(function () { try {${Prelude}
window.__mtCoverGiveUp = true;
window.__mtCover = null;
forgetPicture();
var c = d.getElementById(${JSON.stringify(CoverId)});
if (c) c.remove();
root.removeAttribute(${JSON.stringify(CoverAttribute)});
return "gave-up";
} catch (e) { return "error:" + e; } })()`;
}

// A cover that will not be used (its switch went to another target, or failed): gone at once, the view being off screen.
export function removeCoverScript(): string {
    return `(function () { try {${Prelude}
forgetPicture();
var c = d.getElementById(${JSON.stringify(CoverId)});
if (c) c.remove();
var w = d.getElementById(${JSON.stringify(WaitId)}); if (w) w.remove();
root.removeAttribute(${JSON.stringify(CoverAttribute)});
return "ok";
} catch (e) { return "error:" + e; } })()`;
}

// The cover dissolves into the live content, then goes. Resolves once it is gone. A page that was kept out of sight
// fades in as the cover fades out, so the see-through stays the same all the way.
export function uncoverScript(): string {
    return `(function () { try {${Prelude}
var c = d.getElementById(${JSON.stringify(CoverId)});
var w = d.getElementById(${JSON.stringify(WaitId)}); if (w) w.remove();
var m = d.getElementById(${JSON.stringify(RootId)});
var hidden = root.getAttribute(${JSON.stringify(CoverAttribute)}) === ${JSON.stringify(CoverHidesRoot)} && !!m;
if (hidden) m.style.opacity = "0";
root.removeAttribute(${JSON.stringify(CoverAttribute)});
if (hidden) { if (c) c.style.mixBlendMode = "plus-lighter"; fade(m, 0, 1, dissolveMs, function () { m.style.opacity = ""; }); }
if (!c) { forgetPicture(); return Promise.resolve("none"); }
return new Promise(function (resolve) { fade(c, 1, 0, dissolveMs, function () { c.remove(); forgetPicture(); resolve("ok"); }); });
} catch (e) { return "error:" + e; } })()`;
}

export type SettleReport = { blocks: number; visible: boolean };

// Whether the target's panels are mounted (the block frames of the page, counted once each) after two animation
// frames, which only run for a page on screen.
export function settleProbeScript(): string {
    return `new Promise(function (resolve) {
var n = 0, done = false;
function finish(blocks) { if (done) return; done = true; resolve({ blocks: blocks, visible: document.visibilityState === "visible" }); }
function count() { var ids = {}; document.querySelectorAll(".block[data-blockid]").forEach(function (e) { ids[e.getAttribute("data-blockid")] = 1; }); return Object.keys(ids).length; }
function tick() { n++; if (n < 2) { requestAnimationFrame(tick); return; } finish(count()); }
requestAnimationFrame(tick);
setTimeout(function () { finish(-1); }, 250);
})`;
}

// The panels a page has mounted, read from its DOM alone: a view off screen runs no animation frame (#2390).
export function mountedBlocksScript(): string {
    return `(function () { var ids = {}; document.querySelectorAll(".block[data-blockid]").forEach(function (e) { ids[e.getAttribute("data-blockid")] = 1; }); return Object.keys(ids).length; })()`;
}

// A new view with no picture to wear is put on screen once its panels are mounted, so it never appears half-drawn
// (#2390): the view being left stays meanwhile, at most this long past the view's first render.
export const PanelsMountMaxMs = 400;
export const PanelsMountPollMs = 20;

// Waits until the page has mounted the panels its tab holds (or a count that stopped changing for StableProbes looks),
// at most maxMs. Resolves with whether it did.
export async function waitPanelsMounted(
    count: () => Promise<number>,
    expected: number,
    now: () => number,
    sleep: (ms: number) => Promise<void>,
    maxMs: number = PanelsMountMaxMs
): Promise<boolean> {
    const start = now();
    let last = -1;
    let stableFor = 0;
    while (now() - start < maxMs) {
        const blocks = await count().catch((): number => -1);
        stableFor = blocks === last ? stableFor + 1 : 0;
        last = blocks;
        if (isSettled({ blocks, visible: true }, expected, stableFor)) {
            return true;
        }
        await sleep(PanelsMountPollMs);
    }
    return false;
}

// A page that mounts every panel its tab holds is settled; one that shows fewer (a layout that draws only some of
// them) is settled once its count stopped changing for StableProbes looks.
export const StableProbes = 3;

export function isSettled(report: SettleReport, expectedBlocks: number, stableFor: number): boolean {
    if (report == null || !report.visible || report.blocks < 0) {
        return false;
    }
    return report.blocks >= expectedBlocks || (report.blocks > 0 && stableFor >= StableProbes);
}

// --- one window's switch

export type SwitchView = {
    readonly id: string;
    isLive(): boolean;
    // The picture's bytes go to the page (the preload turns them into a blob URL the scripts read).
    sendPicture(picture: SwitchPicture): void;
    run(script: string): Promise<unknown>;
};

export type SwitchPictureDeps = {
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    log(msg: string): void;
    enabled(): boolean;
    store: SwitchPictureStore;
    // Whether this view's look lets the desktop through.
    translucent(view: SwitchView): boolean;
    // Clears an opaque view's background so it can let the desktop through for the switch; false when the window cannot
    // (#2390). restoreLook gives it its own background back.
    letThrough(view: SwitchView): boolean;
    restoreLook(view: SwitchView): void;
    windowSize(): { width: number; height: number };
    captureLeaver(view: SwitchView, tabId: string, workspaceId: string): void;
    // The window's live view of a tab, when it has one: a warm target gets its picture ahead of the click.
    viewOfTab(tabId: string): SwitchView;
    // The keys of the view being left, held back while its overlay shows.
    holdKeys(view: SwitchView, hold: boolean): void;
    expectedBlocks(tabId: string): Promise<number>;
};

type ActiveSwitch = {
    token: number;
    picture: SwitchPicture;
    leaver: SwitchView;
    holdTimer: unknown;
    // The views that wear the picture before they show: one that is not the target in the end takes it off.
    covered: Set<SwitchView>;
    // The views whose page decoded the picture, ready to wear it.
    prepared: Set<string>;
    // The views that wear it.
    worn: Set<string>;
    // The leaver's background was cleared for the switch: a cancel gives it back.
    through: boolean;
};

function fire(view: SwitchView, script: string) {
    view.run(script).catch((): void => null);
}

// The choreography of one window's switch: begin (the action), cover (just before the target is shown), arrived (the
// target is on screen), cancel (it never will be).
export class WindowSwitchPicture {
    private current: ActiveSwitch = null;
    private tokens = 0;
    // The picture each view's page holds (by the view's tab id): sent once, whether ahead of the click or at it.
    private held = new Map<string, { key: string; at: number }>();
    // The target pages that decoded their picture ahead of the click (the key of that picture): at the click, nothing is
    // left to run in a target that is busy with its reinit.
    private preparedAhead = new Map<string, string>();
    // The switch (its token) a view's cover belongs to: A to B, B to A and A to B again within the first one's wait for
    // the panels must not have that wait take the third switch's cover off.
    private owners = new Map<string, number>();

    constructor(readonly deps: SwitchPictureDeps) {}

    private holds(view: SwitchView, picture: SwitchPicture): boolean {
        const held = this.held.get(view.id);
        return held != null && held.key === pictureKey(picture) && this.deps.now() - held.at < SwitchArmedMs;
    }

    // A page that already holds the picture is not sent it again: the bytes are the one cost of a switch that grows
    // with the picture, and a pointer crossing the dots asks for the same picture again and again.
    private send(view: SwitchView, picture: SwitchPicture) {
        if (this.holds(view, picture)) {
            return;
        }
        view.sendPicture(picture);
        this.held.set(view.id, { key: pictureKey(picture), at: this.deps.now() });
    }

    private forget(view: SwitchView) {
        this.held.delete(view.id);
        this.preparedAhead.delete(view.id);
    }

    private prepareAhead(view: SwitchView, picture: SwitchPicture) {
        const key = pictureKey(picture);
        view.run(prepareCoverScript())
            .then((answer) => {
                if (answer === "ready" && this.held.get(view.id)?.key === key) {
                    this.preparedAhead.set(view.id, key);
                }
            })
            .catch((): void => null);
    }

    isActive(): boolean {
        return this.current != null;
    }

    // The action of a switch: the leaver's picture is taken, the target's shown at once. Returns whether a picture shows.
    begin(leaver: SwitchView, leaverTabId: string, leaverWorkspaceId: string, target: SwitchTarget): boolean {
        const d = this.deps;
        if (!d.enabled() || leaver == null || !leaver.isLive()) {
            return false;
        }
        // The leaver is captured before anything covers it, and once: a newer switch finds its overlay on it.
        if (this.current == null && leaverTabId != null) {
            d.captureLeaver(leaver, leaverTabId, leaverWorkspaceId);
        }
        const size = d.windowSize();
        const picture = d.store.forTarget(target, d.now());
        // A switch whose target has no picture leaves the overlay of the switch before it where it is: the screen keeps
        // showing a picture until the new target is on screen, never the view being left again.
        if (picture == null || !pictureFits(picture, size.width, size.height)) {
            d.log(
                picture == null
                    ? "[#2375] no picture of the target yet, the switch shows none"
                    : `[#2375] the target's picture is ${picture.width}x${picture.height}, the window ${size.width}x${size.height}: none shown`
            );
            return false;
        }
        if (picture.tabId === leaverTabId) {
            return false;
        }
        const previous = this.current;
        if (previous != null) {
            this.clearTimers(previous);
            this.uncoverExcept(previous.covered, picture.tabId);
        }
        const token = ++this.tokens;
        const holdTimer = d.setTimer(() => this.cancel(token), SwitchHoldMaxMs);
        this.current = {
            token,
            picture,
            leaver: previous?.leaver ?? leaver,
            holdTimer,
            covered: previous?.covered ?? new Set<SwitchView>(),
            prepared: previous?.prepared ?? new Set<string>(),
            worn: previous?.worn ?? new Set<string>(),
            through: previous?.through ?? false,
        };
        d.holdKeys(this.current.leaver, true);
        this.send(this.current.leaver, picture);
        // A see-through target's picture over an opaque view: the view lets the desktop through for the switch, so the
        // window's see-through moves with the cross-fade instead of appearing at the swap (#2390). Decided once, by
        // the switch that put the overlay on.
        const shown = this.current.leaver;
        let fadeRoot = false;
        if (previous == null && picture.translucent) {
            if (d.translucent(shown)) {
                fadeRoot = true;
            } else if (d.letThrough(shown)) {
                fadeRoot = true;
                this.current.through = true;
            }
        }
        fire(shown, showPictureScript(fadeRoot));
        d.log(`[#2375] picture shown for ${picture.tabId} (${picture.width}x${picture.height})`);
        return true;
    }

    // Ahead of the click: the target's picture goes to the view on screen (its overlay) and to the target's own view, when
    // that is warm (its cover), and both decode it, off screen. The click then finds everything in place: the costly
    // steps of a switch, reading the view being left back and handing a picture to a page and decoding it, are paid
    // before the user acts.
    arm(leaver: SwitchView, target: SwitchTarget, leaverWorkspaceId?: string) {
        const d = this.deps;
        if (!d.enabled() || leaver == null || !leaver.isLive() || this.current != null) {
            return;
        }
        // The view on screen is read back now, while nothing else moves: at the click, that readback would slow down the
        // target's reinit (the click then finds a recent picture and takes none).
        d.captureLeaver(leaver, leaver.id, leaverWorkspaceId);
        const picture = d.store.forTarget(target, d.now());
        const size = d.windowSize();
        if (picture == null || picture.tabId === leaver.id || !pictureFits(picture, size.width, size.height)) {
            return;
        }
        const warm = d.viewOfTab(picture.tabId);
        const targetView = warm != null && warm.id !== leaver.id && warm.isLive() ? warm : null;
        if (this.holds(leaver, picture) && (targetView == null || this.holds(targetView, picture))) {
            return;
        }
        this.send(leaver, picture);
        fire(leaver, armPictureScript());
        if (targetView != null) {
            this.send(targetView, picture);
            this.prepareAhead(targetView, picture);
        }
    }

    // The target is going to be shown: its page gets the picture and decodes it off to the side (the first step of its
    // cover). Resolves once the picture is ready on the page, or could not be.
    async cover(target: SwitchView, tabId: string): Promise<boolean> {
        const cur = this.current;
        if (cur == null || target == null || !target.isLive()) {
            return false;
        }
        if (cur.picture.tabId !== tabId) {
            this.cancel(cur.token);
            return false;
        }
        cur.covered.add(target);
        this.owners.set(target.id, cur.token);
        if (this.holds(target, cur.picture) && this.preparedAhead.get(target.id) === pictureKey(cur.picture)) {
            cur.prepared.add(target.id);
            return true;
        }
        try {
            this.send(target, cur.picture);
            const answer = await target.run(prepareCoverScript());
            if (answer === "ready" && this.current === cur) {
                cur.prepared.add(target.id);
            }
        } catch (e) {
            this.cancel(cur.token);
            return false;
        }
        return this.current === cur && cur.prepared.has(target.id);
    }

    // The target is about to be shown, its reinit done: the decoded picture goes on it, so its first frame on screen
    // holds nothing else. A few milliseconds; false when there is no picture ready (the target then shows as it is).
    async attach(target: SwitchView): Promise<boolean> {
        const cur = this.current;
        if (cur == null || !cur.prepared.has(target.id) || !target.isLive()) {
            return false;
        }
        if (cur.worn.has(target.id)) {
            return true;
        }
        this.preparedAhead.delete(target.id);
        try {
            const worn = (await target.run(attachCoverScript(cur.picture.translucent))) === "ok";
            if (worn && this.current === cur) {
                cur.worn.add(target.id);
            }
            return worn;
        } catch (e) {
            return false;
        }
    }

    // Whether the view wears this switch's picture: then its panels may still mount under it.
    wears(target: SwitchView): boolean {
        return this.current?.worn.has(target.id) === true;
    }

    // Whether the target's page decoded the picture of this switch before the click: it can then wear it before its
    // reinit starts, which the page cannot do in time when it has to decode it first.
    isPreparedAhead(target: SwitchView, tabId: string): boolean {
        const cur = this.current;
        return (
            cur != null &&
            cur.picture.tabId === tabId &&
            this.holds(target, cur.picture) &&
            this.preparedAhead.get(target.id) === pictureKey(cur.picture)
        );
    }

    // The target is shown without its cover (the picture was not on it in time): nothing may put it on late, over a view
    // the user is already using.
    giveUpCover(target: SwitchView) {
        const cur = this.current;
        cur?.covered.delete(target);
        cur?.prepared.delete(target.id);
        cur?.worn.delete(target.id);
        this.forget(target);
        if (target.isLive()) {
            fire(target, giveUpCoverScript());
        }
    }

    // The target is on screen: the leaver's overlay goes (it is off screen now), the keys are free, and the cover
    // dissolves once the panels are mounted and have painted.
    arrived(target: SwitchView, tabId: string): Promise<void> {
        const cur = this.current;
        if (cur == null) {
            return Promise.resolve();
        }
        this.clearTimers(cur);
        this.deps.holdKeys(cur.leaver, false);
        this.forget(cur.leaver);
        if (cur.leaver.isLive()) {
            fire(cur.leaver, removeOverlayScript(false));
        }
        this.current = null;
        this.uncoverExcept(cur.covered, cur.picture.tabId === tabId ? tabId : null);
        if (cur.picture.tabId !== tabId) {
            return Promise.resolve();
        }
        this.owners.set(target.id, cur.token);
        return this.settle(target, tabId, cur.token);
    }

    // The switch ended without a target on screen: the leaver is where it was, the picture fades out.
    cancel(token?: number) {
        const cur = this.current;
        if (cur == null || (token != null && cur.token !== token)) {
            return;
        }
        this.clearTimers(cur);
        this.deps.holdKeys(cur.leaver, false);
        this.forget(cur.leaver);
        if (cur.leaver.isLive()) {
            fire(cur.leaver, removeOverlayScript(true));
            if (cur.through) {
                this.deps.restoreLook(cur.leaver);
            }
        }
        this.current = null;
        this.uncoverExcept(cur.covered, null);
    }

    private uncoverExcept(covered: Set<SwitchView>, keepTabId: string) {
        for (const view of Array.from(covered)) {
            if (view.id === keepTabId) {
                continue;
            }
            covered.delete(view);
            this.forget(view);
            if (view.isLive()) {
                fire(view, removeCoverScript());
            }
        }
    }

    // The waiting state of the pending controller (emain/moltenterm-view-pending.ts), drawn over the picture.
    showWaiting(state: WaitingState) {
        const cur = this.current;
        if (cur == null || !cur.leaver.isLive()) {
            return;
        }
        fire(cur.leaver, waitingScript(state));
    }

    private clearTimers(cur: ActiveSwitch) {
        if (cur.holdTimer != null) {
            this.deps.clearTimer(cur.holdTimer);
            cur.holdTimer = null;
        }
    }

    private async settle(target: SwitchView, tabId: string, token: number) {
        const d = this.deps;
        const owns = () => this.owners.get(target.id) === token;
        const expected = await d.expectedBlocks(tabId).catch((): number => 0);
        const start = d.now();
        let settled = false;
        let last = -1;
        let stableFor = 0;
        while (owns() && target.isLive() && d.now() - start < SwitchSettleMaxMs) {
            const report = (await target.run(settleProbeScript()).catch((): unknown => null)) as SettleReport;
            stableFor = report != null && report.blocks === last ? stableFor + 1 : 0;
            last = report?.blocks ?? -1;
            if (isSettled(report, expected, stableFor)) {
                settled = true;
                break;
            }
            await new Promise<void>((resolve) => d.setTimer(resolve, SwitchSettlePollMs));
        }
        // A newer switch owns the view's cover now: it takes it off itself, and this wait must leave it alone
        if (!owns() || !target.isLive()) {
            return;
        }
        if (!settled) {
            d.log(`[#2375] panels not all mounted after ${SwitchSettleMaxMs} ms, the picture goes anyway`);
        }
        await target.run(uncoverScript()).catch((): unknown => null);
        if (owns()) {
            this.owners.delete(target.id);
            this.forget(target);
        }
    }
}

function pictureKey(picture: SwitchPicture): string {
    return `${picture.tabId}:${picture.at}`;
}
