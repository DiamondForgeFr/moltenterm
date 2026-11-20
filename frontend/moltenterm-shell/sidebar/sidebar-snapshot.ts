// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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

// The capture is of the screen's pixels: on a see-through look they hold the window's material (the frame's tint at
// its alpha, its texture) under the sidebar's content. The swipe draws the capture over the same material, so the
// material counted twice and the incoming sidebar came in darker than it is (#2407). The capturing view knows its own
// material, so it takes it out: with P the captured pixel and B the material, both with straight alpha, P is the
// content C over B, so C's alpha is (aP - aB) / (1 - aB) and its premultiplied colour P·aP - B·aB·(1 - aC). Where the
// material is opaque nothing can be taken out, and nothing needs to be: an opaque pixel over an opaque frame is itself.
export function uncomposite(pixels: Uint8ClampedArray, material: Uint8ClampedArray): void {
    for (let i = 0; i + 3 < pixels.length; i += 4) {
        const ab = material[i + 3] / 255;
        if (ab >= 0.999) {
            continue;
        }
        const ap = pixels[i + 3] / 255;
        const ac = Math.max(0, Math.min(1, (ap - ab) / (1 - ab)));
        if (ac <= 0.002) {
            pixels[i] = 0;
            pixels[i + 1] = 0;
            pixels[i + 2] = 0;
            pixels[i + 3] = 0;
            continue;
        }
        const keep = ab * (1 - ac);
        for (let c = 0; c < 3; c++) {
            const premul = (pixels[i + c] / 255) * ap - (material[i + c] / 255) * keep;
            pixels[i + c] = Math.round(Math.max(0, Math.min(1, premul / ac)) * 255);
        }
        pixels[i + 3] = Math.round(ac * 255);
    }
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("image"));
        img.src = src;
    });
}

// The frame's material under the viewport, drawn as the page draws it: the tint, then the texture's tile repeated from
// the frame's corner at its CSS size.
async function drawMaterial(
    ctx: CanvasRenderingContext2D,
    frame: HTMLElement,
    viewport: HTMLElement,
    scale: number
): Promise<void> {
    const cs = getComputedStyle(frame);
    const fr = frame.getBoundingClientRect();
    const vr = viewport.getBoundingClientRect();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.translate(fr.left - vr.left, fr.top - vr.top);
    ctx.fillStyle = cs.backgroundColor;
    ctx.fillRect(0, 0, fr.width, fr.height);
    // The computed value quotes its URL, and an SVG tile holds parentheses of its own.
    const m = /^url\("(.+)"\)$/.exec((cs.backgroundImage ?? "").trim());
    if (m == null) {
        return;
    }
    const tile = await loadImage(m[1]);
    const [w, h] = (cs.backgroundSize || "").split(" ").map((v) => parseFloat(v));
    const tw = w > 0 ? w : tile.naturalWidth;
    const th = h > 0 ? h : tw;
    const tileCanvas = document.createElement("canvas");
    tileCanvas.width = Math.max(1, Math.round(tw * scale));
    tileCanvas.height = Math.max(1, Math.round(th * scale));
    tileCanvas.getContext("2d").drawImage(tile, 0, 0, tileCanvas.width, tileCanvas.height);
    const pattern = ctx.createPattern(tileCanvas, "repeat");
    pattern.setTransform(new DOMMatrix().scale(1 / scale));
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, fr.width, fr.height);
}

// The capture with the window's material taken out (see uncomposite). The capture as it was when the view lets nothing
// through, or when anything fails.
export async function withoutMaterial(url: string, viewport: HTMLElement): Promise<string> {
    const frame = viewport?.closest<HTMLElement>(".mt-sb-frame");
    if (frame == null || !document.documentElement.classList.contains("mt-translucent")) {
        return url;
    }
    try {
        const img = await loadImage(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const scale = w / Math.max(1, viewport.getBoundingClientRect().width);
        const shot = document.createElement("canvas");
        shot.width = w;
        shot.height = h;
        const sctx = shot.getContext("2d", { willReadFrequently: true });
        sctx.drawImage(img, 0, 0);
        const back = document.createElement("canvas");
        back.width = w;
        back.height = h;
        const bctx = back.getContext("2d", { willReadFrequently: true });
        await drawMaterial(bctx, frame, viewport, scale);
        const pixels = sctx.getImageData(0, 0, w, h);
        uncomposite(pixels.data, bctx.getImageData(0, 0, w, h).data);
        sctx.putImageData(pixels, 0, 0);
        return shot.toDataURL("image/png");
    } catch {
        return url;
    }
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
                const captured = await getApi().captureScreenshot(rect);
                const url = captured ? await withoutMaterial(captured, viewport) : captured;
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
