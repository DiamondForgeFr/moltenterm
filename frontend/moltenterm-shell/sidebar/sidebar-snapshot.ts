// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The neighbour's exact sidebar for the workspace swipe (FR-SHELL-082, DS-SHELL-130, #1261). Each workspace lives in
// its own tab view, so the view on screen cannot draw another workspace's sidebar: its likeness (sidebar-ghost.tsx)
// differed from the real one (another header height, other rows), and the swipe jumped when the real view replaced
// it. Each view now captures its own sidebar's page at rest (the Electron API's captureScreenshot, of its own view)
// and shares it through localStorage, which every view of the app reads and is told about by a storage event. The
// swipe slides that capture in and lands on it; the view that appears shows the same pixels. A hidden view keeps
// capturing after each change (#2438), and one whose capture is still behind fades its sidebar in on landing.

import { getApi } from "@/app/store/global";
import { useEffect, useState } from "react";

export const SnapshotKeyPrefix = "moltenterm:sidebar-snap:";
// A view captures once its sidebar stayed still this long, and at most this often (a sidebar that keeps changing,
// an agent's status for one, costs a capture every few seconds, not one per change).
export const SnapshotSettleMs = 700;
export const SnapshotMinGapMs = 5000;
// A capture over this size is not kept: localStorage is small and shared by every view.
export const SnapshotMaxChars = 1_500_000;

export type SidebarSnapshot = { url: string; width: number; height: number; at: number };

export function snapshotKey(workspaceId: string): string {
    return SnapshotKeyPrefix + workspaceId;
}

export function parseSnapshot(raw: string): SidebarSnapshot {
    if (!raw) {
        return null;
    }
    try {
        const v = JSON.parse(raw);
        if (typeof v?.url !== "string" || !v.url.startsWith("data:image/")) {
            return null;
        }
        if (!(v.width > 0) || !(v.height > 0)) {
            return null;
        }
        return { url: v.url, width: v.width, height: v.height, at: Number(v.at) || 0 };
    } catch {
        return null;
    }
}

// A capture fits the neighbour's slot only when the sidebar has the same size: a window resized since shows the
// likeness instead of a stretched picture.
export function snapshotFits(snap: SidebarSnapshot, width: number, height: number): boolean {
    return snap != null && Math.abs(snap.width - width) <= 1 && Math.abs(snap.height - height) <= 1;
}

// The keys of workspaces that no longer exist, to drop.
export function staleSnapshotKeys(keys: readonly string[], workspaceIds: readonly string[]): string[] {
    const live = new Set(workspaceIds.map(snapshotKey));
    return keys.filter((k) => k.startsWith(SnapshotKeyPrefix) && !live.has(k));
}

function readKey(key: string): string {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeKey(key: string, value: string): boolean {
    try {
        if (value == null) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, value);
        }
        return true;
    } catch {
        // A full storage keeps the likeness.
        return false;
    }
}

export function readSnapshot(workspaceId: string): SidebarSnapshot {
    return workspaceId ? parseSnapshot(readKey(snapshotKey(workspaceId))) : null;
}

export function pruneSnapshots(workspaceIds: readonly string[]) {
    try {
        const keys = Object.keys(window.localStorage);
        for (const key of staleSnapshotKeys(keys, workspaceIds)) {
            writeKey(key, null);
        }
    } catch {
        // Nothing to prune without storage.
    }
}

// The capture of a workspace's sidebar, kept up to date as other views write it.
export function useSidebarSnapshot(workspaceId: string): SidebarSnapshot {
    const [snap, setSnap] = useState<SidebarSnapshot>(() => readSnapshot(workspaceId));
    useEffect(() => {
        setSnap(readSnapshot(workspaceId));
        if (!workspaceId) {
            return;
        }
        const key = snapshotKey(workspaceId);
        const onStorage = (e: StorageEvent) => {
            if (e.key === key) {
                setSnap(parseSnapshot(e.newValue));
            }
        };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, [workspaceId]);
    return snap;
}

export type SidebarRestFacts = {
    hidden: boolean;
    // A page drawn in the sidebar's place: a pin's draft, a project page, the new-workspace page.
    pageOver: boolean;
    libraryOpen: boolean;
    swiping: boolean;
    animating: boolean;
};

// The capture is of the screen's pixels, not of the sidebar's DOM: the library, a fixed layer over the whole window,
// would be captured as this workspace's sidebar and slide in on every swipe toward it (#1392).
export function sidebarAtRest(f: SidebarRestFacts): boolean {
    return !f.hidden && !f.pageOver && !f.libraryOpen && !f.swiping && !f.animating;
}

export type SnapshotSource = {
    // The sidebar's page area, captured whole.
    viewport(): HTMLElement;
    // The rows' page inside it, whose changes ask for a capture: the neighbours' captures parked beside it (the ghosts)
    // are other views' rows, and a change of theirs is none of this view's (#2438). The viewport when absent.
    rows?(): HTMLElement;
    // The page shows the workspace at rest: no swipe, no slide, no other page over it, the sidebar on screen.
    atRest(): boolean;
};

// What this view knows of its own sidebar's capture (#2438): when its rows last changed, and when the capture it last
// wrote was taken. A view starts with its rows just drawn and no capture of its own.
type CaptureClock = { changedAt: number; capturedAt: number };
const clocks = new Map<string, CaptureClock>();

function clockOf(workspaceId: string): CaptureClock {
    let c = clocks.get(workspaceId);
    if (c == null) {
        c = { changedAt: Date.now(), capturedAt: 0 };
        clocks.set(workspaceId, c);
    }
    return c;
}

export function noteSidebarChanged(workspaceId: string, at: number = Date.now()) {
    clockOf(workspaceId).changedAt = at;
}

export function noteSidebarCaptured(workspaceId: string, takenAt: number) {
    clockOf(workspaceId).capturedAt = takenAt;
}

// The capture the switch slid in shows what the sidebar shows now: one that fits, taken after its last change.
export function sidebarCaptureCurrent(workspaceId: string, width: number, height: number): boolean {
    if (!snapshotFits(readSnapshot(workspaceId), width, height)) {
        return false;
    }
    const c = clockOf(workspaceId);
    return c.capturedAt > 0 && c.capturedAt >= c.changedAt;
}

export function resetSidebarClocks() {
    clocks.clear();
}

const FallbackLandMs = 120;

function landMs(): number {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--mt-duration-fast").trim();
    const m = /^([\d.]+)(ms|s)$/.exec(v);
    if (m == null) {
        return FallbackLandMs;
    }
    return m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
}

function reducedMotion(): boolean {
    return (
        document.documentElement.classList.contains("prefers-reduced-motion") ||
        (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
    );
}

export const LandingPictureClass = "mt-sb-landing-picture";

// A switch landed on this view (#2438): the side panel the switch slid in was its capture. When that capture is not
// what the sidebar shows now (missing, of another size, older than its last change), the real sidebar comes in by a
// short fade, from the capture when one fits, so no row pops in. The picture lies inside the rows' page (content), so
// it moves with the arrival's slide; it goes as soon as the view leaves the screen, never to be captured. Returns how
// it came in.
export function landSidebar(
    viewport: HTMLElement,
    content: HTMLElement,
    workspaceId: string
): "current" | "picture" | "fade" | "none" {
    if (viewport == null || content == null || !workspaceId) {
        return "none";
    }
    const r = viewport.getBoundingClientRect();
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    if (sidebarCaptureCurrent(workspaceId, width, height)) {
        return "current";
    }
    if (reducedMotion()) {
        return "none";
    }
    const ms = landMs();
    const snap = readSnapshot(workspaceId);
    if (snapshotFits(snap, width, height)) {
        const img = document.createElement("img");
        img.className = LandingPictureClass;
        img.src = snap.url;
        img.alt = "";
        img.setAttribute("aria-hidden", "true");
        img.draggable = false;
        // The capture's corner is the viewport's: placed in the content's own coordinates (layout offsets, which the
        // slide's transform does not change), scrolled as the content is.
        Object.assign(img.style, {
            position: "absolute",
            top: `${content.scrollTop - content.offsetTop}px`,
            left: `${content.scrollLeft - content.offsetLeft}px`,
            width: `${snap.width}px`,
            height: `${snap.height}px`,
            maxWidth: "none",
            pointerEvents: "none",
            zIndex: "5",
        });
        const position = content.style.position;
        if (getComputedStyle(content).position === "static") {
            content.style.position = "relative";
        }
        content.appendChild(img);
        const done = () => {
            document.removeEventListener("visibilitychange", onHidden);
            img.remove();
            content.style.position = position;
        };
        const onHidden = () => {
            if (document.visibilityState === "hidden") {
                done();
            }
        };
        document.addEventListener("visibilitychange", onHidden);
        if (img.animate == null) {
            done();
            return "picture";
        }
        img.style.opacity = "0";
        const a = img.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "linear" });
        a.onfinish = done;
        a.oncancel = done;
        return "picture";
    }
    content.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "linear" });
    return "fade";
}

function isLandingPicture(n: Node): boolean {
    return (n as Element)?.classList?.contains(LandingPictureClass) ?? false;
}

// A change of the rows: the landing picture coming and going is none.
function rowsChanged(records: MutationRecord[]): boolean {
    return records.some(
        (r) =>
            !isLandingPicture(r.target) &&
            !(
                r.type === "childList" &&
                [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].every(isLandingPicture)
            )
    );
}

// Captures this view's sidebar once it stays still, after each change, also while the view is hidden (#2438: a hidden
// workspace's agents and statuses change, and the switch to it slides in this capture). A change of restKey (something
// drawn over the sidebar outside it, like the library) asks for a capture too: what covered it is gone.
export function useSidebarCapture(workspaceId: string, source: SnapshotSource, restKey?: unknown) {
    useEffect(() => startSidebarCapture(workspaceId, source), [workspaceId, source, restKey]);
}

// The capture's loop, apart from React. Returns its stop.
export function startSidebarCapture(workspaceId: string, source: SnapshotSource): () => void {
    const viewport = source.viewport();
    if (!workspaceId || viewport == null || getApi()?.captureScreenshot == null) {
        return undefined;
    }
    let timer: ReturnType<typeof setTimeout> = null;
    let lastAt = 0;
    let alive = true;
    const capture = async () => {
        timer = null;
        if (!alive) {
            return;
        }
        const wait = lastAt + SnapshotMinGapMs - Date.now();
        // A landing's picture over the rows is no picture of them (a view hidden in the middle of its fade).
        if (wait > 0 || !source.atRest() || viewport.querySelector("." + LandingPictureClass) != null) {
            schedule(Math.max(wait, SnapshotSettleMs));
            return;
        }
        const r = viewport.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) {
            return;
        }
        const takenAt = Date.now();
        lastAt = takenAt;
        const rect = {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
        };
        try {
            const captured = await getApi().captureScreenshot(rect);
            // The window's material goes out of the capture (#2407, sidebar-material.ts, loaded only here).
            const url = captured
                ? await (await import("./sidebar-material")).withoutMaterial(captured, viewport)
                : captured;
            // The page moved while the capture ran: it may show a half-slid frame, so it waits for the next rest.
            if (
                !alive ||
                !source.atRest() ||
                viewport.querySelector("." + LandingPictureClass) != null ||
                !url ||
                url.length > SnapshotMaxChars
            ) {
                return;
            }
            const snap: SidebarSnapshot = { url, width: rect.width, height: rect.height, at: Date.now() };
            if (writeKey(snapshotKey(workspaceId), JSON.stringify(snap))) {
                noteSidebarCaptured(workspaceId, takenAt);
            }
        } catch {
            // The likeness stays.
        }
    };
    const schedule = (ms = SnapshotSettleMs) => {
        clearTimeout(timer);
        timer = setTimeout(capture, ms);
    };
    // The rows were just drawn (a view's first render, or a reinit in the same page): a capture from before is behind.
    noteSidebarChanged(workspaceId);
    const observer = new MutationObserver((records) => {
        if (!rowsChanged(records)) {
            return;
        }
        noteSidebarChanged(workspaceId);
        schedule();
    });
    observer.observe(source.rows?.() ?? viewport, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
    });
    const onVisibility = () => {
        if (document.visibilityState === "visible") {
            schedule();
        }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onVisibility);
    schedule();
    return () => {
        alive = false;
        clearTimeout(timer);
        observer.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("resize", onVisibility);
    };
}
