// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The neighbour's exact sidebar for the workspace swipe (FR-SHELL-082, DS-SHELL-130, #1261). Each workspace lives in
// its own tab view, so the view on screen cannot draw another workspace's sidebar: its likeness (sidebar-ghost.tsx)
// differed from the real one (another header height, other rows), and the swipe jumped when the real view replaced
// it. Each view now captures its own sidebar's page at rest (the Electron API's captureScreenshot, of its own view)
// and shares it through localStorage, which every view of the app reads and is told about by a storage event. The
// swipe slides that capture in and lands on it; the view that appears shows the same pixels, unless the workspace
// changed while it was hidden.

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

function writeKey(key: string, value: string) {
    try {
        if (value == null) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, value);
        }
    } catch {
        // A full storage keeps the likeness.
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
    // The page shows the workspace at rest: no swipe, no slide, no other page over it, the sidebar on screen.
    atRest(): boolean;
};

// Captures this view's sidebar once it stays still on screen, after each change. A change of restKey (something
// drawn over the sidebar outside it, like the library) asks for a capture too: what covered it is gone.
export function useSidebarCapture(workspaceId: string, source: SnapshotSource, restKey?: unknown) {
    useEffect(() => {
        const viewport = source.viewport();
        if (!workspaceId || viewport == null || getApi()?.captureScreenshot == null) {
            return;
        }
        let timer: ReturnType<typeof setTimeout> = null;
        let lastAt = 0;
        let alive = true;
        const capture = async () => {
            timer = null;
            if (!alive || document.visibilityState !== "visible") {
                return;
            }
            const wait = lastAt + SnapshotMinGapMs - Date.now();
            if (wait > 0 || !source.atRest()) {
                schedule(Math.max(wait, SnapshotSettleMs));
                return;
            }
            const r = viewport.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) {
                return;
            }
            lastAt = Date.now();
            const rect = {
                x: Math.round(r.left),
                y: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height),
            };
            try {
                const url = await getApi().captureScreenshot(rect);
                // The page moved while the capture ran: it may show a half-slid frame, so it waits for the next rest.
                if (!alive || !source.atRest() || !url || url.length > SnapshotMaxChars) {
                    return;
                }
                const snap: SidebarSnapshot = { url, width: rect.width, height: rect.height, at: Date.now() };
                writeKey(snapshotKey(workspaceId), JSON.stringify(snap));
            } catch {
                // The likeness stays.
            }
        };
        const schedule = (ms = SnapshotSettleMs) => {
            clearTimeout(timer);
            timer = setTimeout(capture, ms);
        };
        const observer = new MutationObserver(() => schedule());
        observer.observe(viewport, { subtree: true, childList: true, attributes: true, characterData: true });
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
    }, [workspaceId, source, restKey]);
}
