// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the review takes of the live page at send time (FR-BRW-017 AC26, #2422): for each comment of the page shown, the
// overlay hides, puts the mark in view and says where it is, the panel captures the region around it with the webview's
// own capturePage and draws the mark and its number on it; then the page's screens, set one under the other, give the
// overview where the page allows it; at the end the overlay and the page's scroll position come back, whatever happened.

import { cropRegion, sliceOffsets } from "./annotate-anchor";
import type { GuestLink } from "./annotate-guest-link";
import type { Zone } from "./annotate-model";
import { sameAddress } from "./annotate-model";
import type { CanvasFactory } from "./annotate-paint";
import { composeCrop, composeOverview, cropTier, type ImageLike, OverviewTier, type Slice } from "./annotate-paint";
import { type Box, MaxOverviewScreens, type OverviewMessage, type PreparedMessage, type Size } from "./annotate-wire";

// The margin around a mark in a capture, in CSS pixels, and the least a capture holds, so a small mark shows its
// surroundings.
export const CropPad = 120;
export const CropMin: Size = { w: 360, h: 240 };

// What the capture needs of the page's <webview>: the picture of a rectangle, given in the viewport's device-independent
// pixels (the page's CSS pixels times its zoom).
export type CaptureView = {
    capturePage(rect?: {
        x: number;
        y: number;
        width: number;
        height: number;
    }): Promise<{ isEmpty(): boolean; toDataURL(): string }>;
    getZoomFactor?(): number;
};

export type CaptureEnv = {
    link: GuestLink;
    view: CaptureView;
    // The address the page shows now: only the comments on it can be captured.
    address: string;
    color: string;
    // False once the review is left: nothing more is asked of the page.
    live: () => boolean;
    onProgress?: (done: number, total: number) => void;
    loadImage?: (dataUrl: string) => Promise<ImageLike>;
    make?: CanvasFactory;
};

export type Captured = {
    // The image of each comment's place, by comment id; a comment without one could not be captured.
    crops: Record<number, string>;
    overview: string;
    // Why there is no overview: "" when there is one.
    noOverview: "" | "none" | "tall" | "inner" | "failed";
};

export function loadImage(dataUrl: string): Promise<ImageLike> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("the capture could not be read"));
        img.src = dataUrl;
    });
}

function zoomOf(view: CaptureView): number {
    try {
        return view.getZoomFactor?.() || 1;
    } catch {
        return 1;
    }
}

// shoot: the picture of a region of the viewport (CSS pixels), null when the page gives none.
async function shoot(env: CaptureEnv, region: Box): Promise<ImageLike> {
    const zoom = zoomOf(env.view);
    try {
        const image = await env.view.capturePage({
            x: Math.round(region.x * zoom),
            y: Math.round(region.y * zoom),
            width: Math.max(1, Math.round(region.w * zoom)),
            height: Math.max(1, Math.round(region.h * zoom)),
        });
        if (image == null || image.isEmpty()) {
            return null;
        }
        return await (env.loadImage ?? loadImage)(image.toDataURL());
    } catch {
        return null;
    }
}

async function captureCrop(env: CaptureEnv, zone: Zone, n: number, count: number): Promise<string> {
    const prepared = await env.link.request<PreparedMessage>((reqId) => ({ type: "prepare", reqId, id: zone.id }));
    if (prepared == null || !prepared.ok) {
        return "";
    }
    const region = cropRegion(prepared.box, prepared.viewport, CropPad, CropMin);
    const shot = await shoot(env, region);
    if (shot == null) {
        return "";
    }
    try {
        return composeCrop(
            shot,
            region,
            { n, kind: zone.kind, box: prepared.box, path: prepared.path },
            cropTier(count),
            env.color,
            env.make
        ).dataUrl;
    } catch {
        return "";
    }
}

async function captureOverview(
    env: CaptureEnv,
    marks: OverviewMessage["marks"],
    info: OverviewMessage
): Promise<{ overview: string; why: Captured["noOverview"] }> {
    if (!info.whole) {
        return { overview: "", why: info.doc.h > info.viewport.h * MaxOverviewScreens ? "tall" : "inner" };
    }
    const offsets = sliceOffsets(info.doc.h, info.viewport.h, MaxOverviewScreens);
    if (offsets.length === 0) {
        return { overview: "", why: "tall" };
    }
    const slices: Slice[] = [];
    for (let i = 0; i < offsets.length; i++) {
        if (!env.live()) {
            return { overview: "", why: "failed" };
        }
        const at = await env.link.request<OverviewMessage>((reqId) => ({ type: "overview", reqId, slice: i }));
        if (at == null || !at.ok) {
            return { overview: "", why: "failed" };
        }
        const shot = await shoot(env, { x: 0, y: 0, w: at.viewport.w, h: at.viewport.h });
        if (shot == null) {
            return { overview: "", why: "failed" };
        }
        slices.push({ image: shot, scrollY: at.scroll.y, viewH: at.viewport.h });
    }
    try {
        return {
            overview: composeOverview(slices, info.doc, marks, OverviewTier, env.color, env.make).dataUrl,
            why: "",
        };
    } catch {
        return { overview: "", why: "failed" };
    }
}

// captureComments: zones is the whole list, in report order (a mark's number is its place in it); only those on the page
// shown are captured, the others have no image: their page is gone.
export async function captureComments(env: CaptureEnv, zones: Zone[]): Promise<Captured> {
    const here = zones.filter((z) => sameAddress(z.address, env.address));
    const result: Captured = { crops: {}, overview: "", noOverview: "none" };
    if (here.length === 0) {
        return result;
    }
    let done = 0;
    env.onProgress?.(done, here.length + 1);
    try {
        for (const zone of here) {
            if (!env.live()) {
                break;
            }
            const crop = await captureCrop(env, zone, zones.indexOf(zone) + 1, zones.length);
            if (crop !== "") {
                result.crops[zone.id] = crop;
            }
            env.onProgress?.(++done, here.length + 1);
        }
        if (env.live()) {
            const info = await env.link.request<OverviewMessage>((reqId) => ({ type: "overview", reqId, slice: -1 }));
            if (info == null || !info.ok) {
                result.noOverview = "failed";
            } else {
                const taken = await captureOverview(env, info.marks, info);
                result.overview = taken.overview;
                result.noOverview = taken.why;
            }
            env.onProgress?.(++done, here.length + 1);
        }
    } finally {
        await env.link.request((reqId) => ({ type: "restore", reqId }));
    }
    return result;
}
