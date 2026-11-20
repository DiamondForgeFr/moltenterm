// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The remembered layout on screen (FR-SHELL-082, #2407). Two layers, both plain DOM appended to the body (outside the
// React root, which a reinit may render again), both letting every click through:
// - the leave layer, in the view being left: the next workspace's panel frames over the content area, faded in while
//   the content fades out, by the swipe's progress or eased for a dot or a key;
// - the arrival layer, in the view that shows the next workspace: the same frames, worn before the view is first on
//   screen, a domino in each one still waiting, each frame dissolving into its live panel as soon as that panel is ready.
// Neither ever outlives its switch: each has a deadline, and leaving the screen takes it off at once.

import * as WOS from "@/app/store/wos";
import { prefersReducedMotion } from "../molten-motion";
import { snapToCycle } from "../suite/suite";
import { Box, contentBoxFor, RememberedLayout, scaleLayout } from "./layout-memory";
import { loadLayout } from "./layout-store";
import { panelWaiting } from "./panel-ready";
import "./switch-layout.css";

export const LeaveLayerId = "mt-switch-layout-leave";
export const ArrivalLayerId = "mt-switch-layout-arrival";
// The id of the leave's cross-fade, so Electron main's landing check (#2419) cancels only it.
export const LeaveAnimationId = "mt-switch-layout-leave";
// The motion tokens (tokens.css), read from the page first.
const FallbackFadeMs = 180;
const FallbackDissolveMs = 120;
const FallbackEase = "cubic-bezier(0.2, 0, 0, 1)";
// An arrival layer goes at the latest this long after it was put on, whatever its panels did. Long enough for a slow
// page or a terminal's reconnection to keep its loader (#2438), short enough that no loader stays.
export const ArrivalMaxMs = 10000;
// Once on screen, a panel that never comes (the layout was out of date) or never says it is ready lets its frame go
// after this.
export const ArrivalPanelMaxMs = 8000;
// A page that runs no animation frame (hidden again meanwhile) lets its frames go after this.
export const ArrivalHiddenMaxMs = 1500;
// A leave layer left on a view still on screen (a switch the main process refused) goes after this.
export const LeaveMaxMs = 4000;

// MOLTENTERM_SWITCHPICTURE=0 restores the switch before #2375, =picture the #2390 one: no remembered layout in either.
let switchLayoutFlag: boolean = null;

export function switchLayoutOn(read: (name: string) => string = readEnv): boolean {
    if (switchLayoutFlag == null) {
        const v = read("MOLTENTERM_SWITCHPICTURE");
        switchLayoutFlag = v !== "0" && v !== "picture";
    }
    return switchLayoutFlag;
}

export function resetSwitchLayoutFlag() {
    switchLayoutFlag = null;
}

function readEnv(name: string): string {
    try {
        return (globalThis as any).api?.getEnv?.(name) ?? null;
    } catch {
        return null;
    }
}

function cssMs(name: string, fallback: number): number {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const m = /^(-?[\d.]+)(ms|s)$/.exec(v);
    if (m == null) {
        return fallback;
    }
    return m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
}

export function switchFadeMs(): number {
    return prefersReducedMotion() ? 0 : cssMs("--mt-duration-base", FallbackFadeMs);
}

function dissolveMs(): number {
    return prefersReducedMotion() ? 0 : cssMs("--mt-duration-fast", FallbackDissolveMs);
}

function ease(): string {
    return getComputedStyle(document.documentElement).getPropertyValue("--mt-ease").trim() || FallbackEase;
}

export function contentElement(): HTMLElement {
    return document.querySelector<HTMLElement>(".mt-frame-content");
}

function boxOf(el: Element): Box {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function place(el: HTMLElement, r: Box) {
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
}

// The suite's dominoes (DominoLoader's markup), on the one clock every chain falls on (suite.tsx snapToCycle): each bar's
// fall is put back on the last whole cycle when it starts. The chain's own fade-in is left alone.
function dominoes(): HTMLElement {
    const d = document.createElement("span");
    d.className = "df-dominos df-dominos-card";
    d.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 8; i++) {
        d.appendChild(document.createElement("span"));
    }
    d.addEventListener("animationstart", (e) => {
        if (e.target === d) {
            return;
        }
        for (const anim of (e.target as Element).getAnimations?.() ?? []) {
            anim.ready.then(() => snapToCycle(anim)).catch((): void => null);
        }
    });
    return d;
}

// One layer of frames, fixed over the window: each frame at its panel's place in the given content area.
export function buildFrames(id: string, layout: RememberedLayout, box: Box, waiting: boolean): HTMLElement {
    const layer = document.createElement("div");
    layer.id = id;
    layer.className = "mt-sl-layer";
    layer.setAttribute("aria-hidden", "true");
    layer.dataset.workspaceId = layout.workspaceId;
    for (const p of scaleLayout(layout, box)) {
        const frame = document.createElement("div");
        frame.className = "mt-sl-frame";
        frame.dataset.panel = p.id;
        frame.dataset.kind = p.kind;
        place(frame, p.rect);
        if (waiting) {
            frame.appendChild(dominoes());
        }
        layer.appendChild(frame);
    }
    return layer;
}

// --- the view being left

type Leave = { layer: HTMLElement; content: HTMLElement; timer: ReturnType<typeof setTimeout>; progress: number };
let leave: Leave = null;

// The view a workspace shows now, as far as this view's objects tell (empty when they do not know).
function activeTabOf(workspaceId: string): string {
    try {
        return WOS.getObjectValue<Workspace>(WOS.makeORef("workspace", workspaceId))?.activetabid ?? "";
    } catch {
        return "";
    }
}

// The next workspace's frames over this view's content, not shown yet. False when there is nothing to draw, or when
// the layout is of another view than the one the workspace shows now: the view reached would refuse to wear it, and
// the leave would end on frames the switch then drops at once.
export function prepareLeave(workspaceId: string, layout: RememberedLayout = loadLayout(workspaceId)): boolean {
    clearLeave();
    if (!switchLayoutOn() || layout == null || layout.panels.length === 0) {
        return false;
    }
    const active = activeTabOf(workspaceId);
    if (active && layout.tabId && layout.tabId !== active) {
        return false;
    }
    const content = contentElement();
    if (content == null) {
        return false;
    }
    const layer = buildFrames(LeaveLayerId, layout, boxOf(content), false);
    layer.style.opacity = "0";
    // Electron main's landing check of a switch (#2419) tells a leave in progress from one left over by its age.
    layer.dataset.at = String(Date.now());
    document.body.appendChild(layer);
    leave = { layer, content, timer: null, progress: 0 };
    return true;
}

export function leaving(): boolean {
    return leave != null;
}

// How far the switch has gone (0 to 1): the frames fade in as the content fades out, two opacities the compositor runs.
export function leaveProgress(p: number) {
    if (leave == null) {
        return;
    }
    const v = Math.max(0, Math.min(1, p));
    leave.progress = v;
    cancelAnimations(leave.layer);
    cancelAnimations(leave.content);
    leave.layer.style.opacity = String(v);
    leave.content.style.opacity = String(1 - v);
}

function cancelAnimations(el: HTMLElement) {
    el.getAnimations?.().forEach((a) => a.cancel());
}

// The eased cross-fade of a dot or a key, from where it stands to the end. Resolves once it is over, with whether it
// ended on its own leave: a leave cleared or replaced meanwhile (a swipe, another dot) answers false, and its switch
// must not be asked.
export function playLeave(ms: number = switchFadeMs()): Promise<boolean> {
    const l = leave;
    if (l == null) {
        return Promise.resolve(false);
    }
    const from = l.progress;
    leaveProgress(1);
    if (!(ms > 0) || l.layer.animate == null) {
        return Promise.resolve(leave === l);
    }
    const opts = { duration: ms * (1 - from), easing: ease(), id: LeaveAnimationId };
    const a = l.layer.animate([{ opacity: from }, { opacity: 1 }], opts);
    l.content.animate([{ opacity: 1 - from }, { opacity: 0 }], opts);
    return new Promise((resolve) => {
        a.onfinish = () => resolve(leave === l);
        a.oncancel = () => resolve(false);
    });
}

// The switch was asked: the layer stays until this view leaves the screen. Anything that says the switch will not come
// takes it off at once (main's answer, the window losing the focus, the next press or key), LeaveMaxMs at the latest.
export function holdLeave() {
    if (leave == null) {
        return;
    }
    clearTimeout(leave.timer);
    leave.timer = setTimeout(() => clearLeave(), LeaveMaxMs);
    document.addEventListener("visibilitychange", onLeaveVisibility);
    window.addEventListener("blur", onLeaveInput);
    window.addEventListener("pointerdown", onLeaveInput, true);
    window.addEventListener("keydown", onLeaveInput, true);
}

function onLeaveVisibility() {
    if (document.visibilityState === "hidden") {
        clearLeave();
    }
}

function onLeaveInput() {
    clearLeave();
}

// Electron main answers a switch it did not make in this window (it only focused the window that shows the workspace,
// opened another window, or the developer kept the workspace): the view stays, its content comes back at once.
export function switchRefused() {
    clearLeave();
}

(globalThis as any).__mtSwitchLayoutRefused = switchRefused;

// Everything back as it was: the frames gone, the content's own opacity.
export function clearLeave() {
    const l = leave;
    leave = null;
    document.removeEventListener("visibilitychange", onLeaveVisibility);
    window.removeEventListener("blur", onLeaveInput);
    window.removeEventListener("pointerdown", onLeaveInput, true);
    window.removeEventListener("keydown", onLeaveInput, true);
    if (l == null) {
        document.getElementById(LeaveLayerId)?.remove();
        return;
    }
    clearTimeout(l.timer);
    cancelAnimations(l.layer);
    cancelAnimations(l.content);
    l.content.style.opacity = "";
    l.layer.remove();
}

// --- the view that shows the next workspace

type Arrival = {
    layer: HTMLElement;
    pending: Map<string, HTMLElement>;
    wornAt: number;
    shownAt: number;
    frame: number;
    deadline: ReturnType<typeof setTimeout>;
    fallback: ReturnType<typeof setTimeout>;
    // A panel seen ready on this many animation frames in a row is drawn: its content has painted.
    ready: Map<string, number>;
};
let arrival: Arrival = null;

function windowSize(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
}

// Worn before the view is on screen (the start of its reinit, or before its first render): its first frame on screen
// shows the frames, each with its domino. False when this view has no layout to wear.
export function wearArrival(layout: RememberedLayout, tabId: string): boolean {
    clearArrival();
    if (!switchLayoutOn() || layout == null || layout.panels.length === 0) {
        return false;
    }
    if (layout.tabId && tabId && layout.tabId !== tabId) {
        return false;
    }
    const content = contentElement();
    const box = content != null ? boxOf(content) : contentBoxFor(layout, windowSize());
    const layer = buildFrames(ArrivalLayerId, layout, box, true);
    document.body.appendChild(layer);
    const pending = new Map<string, HTMLElement>();
    layer.querySelectorAll<HTMLElement>(".mt-sl-frame").forEach((f) => pending.set(f.dataset.panel, f));
    arrival = {
        layer,
        pending,
        wornAt: Date.now(),
        shownAt: 0,
        frame: 0,
        deadline: setTimeout(() => clearArrival(), ArrivalMaxMs),
        fallback: setTimeout(() => arrivedOnScreen(), ArrivalOnScreenFallbackMs),
        ready: new Map(),
    };
    document.addEventListener("visibilitychange", onArrivalVisibility);
    return true;
}

export function arriving(): boolean {
    return arrival != null;
}

// A view parked off screen is still "visible" to its page, so the page cannot tell when it comes on screen: Electron
// main says so (finishArrivingView). A main that never does (an older path) still lets the frames go after this.
export const ArrivalOnScreenFallbackMs = 1000;

// The view is on screen: its panels' frames dissolve as each panel is ready.
export function arrivedOnScreen() {
    const a = arrival;
    if (a == null || a.shownAt > 0) {
        return;
    }
    clearTimeout(a.fallback);
    a.shownAt = Date.now();
    a.frame = requestAnimationFrame(revealStep);
    // A page that runs no animation frame (hidden meanwhile) still lets its frames go.
    setTimeout(() => {
        if (arrival === a && a.pending.size > 0 && document.visibilityState !== "visible") {
            clearArrival();
        }
    }, ArrivalHiddenMaxMs);
}

// Electron main hides and shows a view again within a few milliseconds while it puts it on screen: only a view that
// stays hidden this long has left the screen.
const HiddenForMs = 400;

function onArrivalVisibility() {
    const a = arrival;
    if (a == null || a.shownAt === 0 || document.visibilityState === "visible") {
        return;
    }
    setTimeout(() => {
        if (arrival === a && document.visibilityState !== "visible") {
            clearArrival();
        }
    }, HiddenForMs);
}

// Worn for a switch that is still on its way: not on screen yet, put on moments ago.
export function arrivalPending(): boolean {
    return arrival != null && arrival.shownAt === 0 && Date.now() - arrival.wornAt < ArrivalOnScreenFallbackMs;
}

(globalThis as any).__mtSwitchLayoutOnScreen = arrivedOnScreen;

// A panel is ready once it is mounted with a size, a terminal once its screen exists, and its content says it is
// there (panel-ready.ts, #2438): seen so on two frames in a row.
export function panelReady(block: Element, kind: string): boolean {
    if (block == null) {
        return false;
    }
    const r = block.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
        return false;
    }
    if (kind === "term" && block.querySelector(".xterm-screen") == null) {
        return false;
    }
    return !panelWaiting(block);
}

function blockOf(id: string): HTMLElement {
    return document.querySelector<HTMLElement>(`.block[data-blockid="${CSS.escape(id)}"]`);
}

function revealStep() {
    const a = arrival;
    if (a == null) {
        return;
    }
    const late = Date.now() - a.shownAt >= ArrivalPanelMaxMs;
    for (const [id, frame] of Array.from(a.pending.entries())) {
        const block = blockOf(id);
        const ok = panelReady(block, frame.dataset.kind);
        const seen = ok ? (a.ready.get(id) ?? 0) + 1 : 0;
        a.ready.set(id, seen);
        if (seen < 2 && !late) {
            continue;
        }
        a.pending.delete(id);
        if (block != null) {
            place(frame, boxOf(block));
        }
        dissolve(frame);
    }
    if (a.pending.size === 0) {
        setTimeout(() => {
            if (arrival === a) {
                clearArrival();
            }
        }, dissolveMs() + 32);
        return;
    }
    a.frame = requestAnimationFrame(revealStep);
}

function dissolve(frame: HTMLElement) {
    const ms = dissolveMs();
    if (!(ms > 0) || frame.animate == null) {
        frame.remove();
        return;
    }
    frame.style.opacity = "0";
    const anim = frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: ease() });
    anim.onfinish = () => frame.remove();
    anim.oncancel = () => frame.remove();
}

export function clearArrival() {
    const a = arrival;
    arrival = null;
    document.removeEventListener("visibilitychange", onArrivalVisibility);
    if (a == null) {
        document.getElementById(ArrivalLayerId)?.remove();
        return;
    }
    cancelAnimationFrame(a.frame);
    clearTimeout(a.deadline);
    clearTimeout(a.fallback);
    a.layer.remove();
}
