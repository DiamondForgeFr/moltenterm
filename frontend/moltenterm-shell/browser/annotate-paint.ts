// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The images of #2422: what the panel's layer takes of the live page at send time (a region around each mark, the
// whole page) with each mark framed and numbered on it, written small enough for one report. The drawing takes a
// small context interface so a test can record it; the canvases come from a factory so that nothing here needs a DOM.

import { type Box, type MarkKind, type Point, type Size } from "./annotate-wire";

export type Paint2D = {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    font: string;
    textAlign: string;
    textBaseline: string;
    globalAlpha: number;
    lineJoin?: string;
    lineCap?: string;
    fillRect(x: number, y: number, w: number, h: number): void;
    strokeRect(x: number, y: number, w: number, h: number): void;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    arc(x: number, y: number, r: number, from: number, to: number): void;
    fill(): void;
    stroke(): void;
    fillText(text: string, x: number, y: number): void;
};

export type CanvasLike = {
    width: number;
    height: number;
    getContext(
        type: "2d"
    ): (Paint2D & { drawImage(img: unknown, x: number, y: number, w: number, h: number): void }) | null;
    toDataURL(type?: string, quality?: number): string;
};

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export type ImageLike = { naturalWidth: number; naturalHeight: number };

// A mark to draw: its number, its kind, its box and, for an outline, its points, all in the canvas' pixels.
export type PaintMark = { n: number; kind: MarkKind; box: Box; path: Point[] };

// A frame's colour is the theme's action colour: the canvas cannot read a CSS variable by itself, so the colour is read
// from the page, and the badge's ink is a plain white, which reads on any page.
const FallbackColor = "orange";
const BadgeInk = "white";

export function annotateColor(): string {
    if (typeof document === "undefined") {
        return FallbackColor;
    }
    const value = getComputedStyle(document.documentElement).getPropertyValue("--mt-action").trim();
    return value || FallbackColor;
}

// paintMarks: each mark's frame (or outline) and its number badge on the top-left corner, sized with the canvas so they
// read at any scale. unit is the canvas' width in thousands of pixels, at least 1.
export function paintMarks(ctx: Paint2D, marks: PaintMark[], size: Size, color: string): void {
    const unit = Math.max(1, size.w / 1000);
    for (const mark of marks) {
        const { x, y, w, h } = mark.box;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        if (mark.kind === "freehand" && mark.path.length > 1) {
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(3, 3.5 * unit);
            ctx.beginPath();
            ctx.moveTo(mark.path[0].x, mark.path[0].y);
            for (const p of mark.path.slice(1)) {
                ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
        } else {
            ctx.globalAlpha = 0.14;
            ctx.fillStyle = color;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(2, 3 * unit);
            ctx.strokeRect(x, y, w, h);
        }
        const r = Math.max(11, 13 * unit);
        const anchor = mark.kind === "freehand" && mark.path.length > 0 ? mark.path[0] : { x, y };
        const cx = Math.min(size.w - r - 1, Math.max(r + 1, anchor.x));
        const cy = Math.min(size.h - r - 1, Math.max(r + 1, anchor.y));
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = BadgeInk;
        ctx.lineWidth = Math.max(1.5, 2 * unit);
        ctx.stroke();
        ctx.fillStyle = BadgeInk;
        ctx.font = `700 ${Math.round(r * 1.1)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(mark.n), cx, cy + 1);
    }
}

// How much is kept of a picture: the longer side and the size of its data URL at most. Tiers get smaller as comments
// get more numerous, so that one report always fits the websocket's 10 MB with its reference images.
export type Tier = { side: number; chars: number };

export function cropTier(count: number): Tier {
    if (count <= 6) {
        return { side: 1100, chars: 400_000 };
    }
    return count <= 12 ? { side: 900, chars: 240_000 } : { side: 700, chars: 140_000 };
}

// A page twelve screens tall is long and narrow in the overview: its longer side is allowed more.
export const OverviewTier: Tier = { side: 2200, chars: 1_000_000 };

const JpegQualities = [0.85, 0.7, 0.55];
const MaxAttempts = 5;
const ShrinkStep = 0.75;

export function defaultCanvas(width: number, height: number): CanvasLike {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as CanvasLike;
}

// fitScale: the factor that brings a picture of the given size within a longer side, never above 1.
export function fitScale(width: number, height: number, side: number): number {
    return Math.min(1, side / Math.max(width, height, 1));
}

// writeWithin: the canvas as a data URL no longer than the tier's: a PNG, else a JPEG of falling quality; "" when none fits.
function writeWithin(canvas: CanvasLike, chars: number): string {
    const png = canvas.toDataURL("image/png");
    if (png.length <= chars) {
        return png;
    }
    for (const quality of JpegQualities) {
        const jpeg = canvas.toDataURL("image/jpeg", quality);
        if (jpeg.length <= chars) {
            return jpeg;
        }
    }
    return "";
}

export type Composed = { dataUrl: string; width: number; height: number };

// compose: a picture drawn by draw on a canvas of the size, scaled down while its data URL stays too long.
function compose(
    size: Size,
    tier: Tier,
    make: CanvasFactory,
    draw: (ctx: NonNullable<ReturnType<CanvasLike["getContext"]>>, scale: number, out: Size) => void
): Composed {
    let scale = fitScale(size.w, size.h, tier.side);
    for (let attempt = 0; attempt < MaxAttempts; attempt++) {
        const out = { w: Math.max(1, Math.round(size.w * scale)), h: Math.max(1, Math.round(size.h * scale)) };
        const canvas = make(out.w, out.h);
        const ctx = canvas.getContext("2d");
        if (ctx == null) {
            throw new Error("the picture could not be drawn");
        }
        // A page without a background of its own is transparent in its capture, which a viewer would show black.
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, out.w, out.h);
        draw(ctx, scale, out);
        const dataUrl = writeWithin(canvas, tier.chars);
        if (dataUrl !== "") {
            return { dataUrl, width: out.w, height: out.h };
        }
        scale *= ShrinkStep;
    }
    throw new Error("the picture is too large");
}

const scaleBox = (box: Box, k: number): Box => ({ x: box.x * k, y: box.y * k, w: box.w * k, h: box.h * k });

// composeCrop: the capture of a region of the viewport with the mark drawn on it. region and mark are in the page's CSS
// pixels (the mark in the viewport's, as the page reported it); the picture is as sharp as the capture was, down to the
// tier's longer side.
export function composeCrop(
    shot: ImageLike,
    region: Box,
    mark: { n: number; kind: MarkKind; box: Box; path: number[] },
    tier: Tier,
    color: string,
    make: CanvasFactory = defaultCanvas
): Composed {
    const density = region.w > 0 ? shot.naturalWidth / region.w : 1;
    const size = { w: shot.naturalWidth, h: shot.naturalHeight };
    return compose(size, tier, make, (ctx, scale, out) => {
        ctx.drawImage(shot, 0, 0, out.w, out.h);
        const k = density * scale;
        const path: Point[] = [];
        for (let i = 0; i + 1 < mark.path.length; i += 2) {
            path.push({ x: (mark.path[i] - region.x) * k, y: (mark.path[i + 1] - region.y) * k });
        }
        const box = scaleBox({ x: mark.box.x - region.x, y: mark.box.y - region.y, w: mark.box.w, h: mark.box.h }, k);
        paintMarks(ctx, [{ n: mark.n, kind: mark.kind, box, path }], out, color);
    });
}

// A screen of the page as it was captured: its picture, where the page was scrolled, and the picture's density (pixels
// per CSS pixel).
export type Slice = { image: ImageLike; scrollY: number; viewH: number };

// composeOverview: the screens of a page set one under the other, and every mark of the page drawn on them, numbered. The
// last screen may overlap the one before (the page ends there): it is drawn where it belongs and covers it.
export function composeOverview(
    slices: Slice[],
    doc: Size,
    marks: { n: number; kind: MarkKind; box: Box; path: number[] }[],
    tier: Tier,
    color: string,
    make: CanvasFactory = defaultCanvas
): Composed {
    const first = slices[0];
    const density = first.image.naturalHeight / first.viewH;
    const size = { w: first.image.naturalWidth, h: Math.round(doc.h * density) };
    return compose(size, tier, make, (ctx, scale, out) => {
        for (const slice of slices) {
            const h = slice.image.naturalHeight * scale;
            ctx.drawImage(slice.image, 0, slice.scrollY * density * scale, out.w, h);
        }
        const k = density * scale;
        const painted: PaintMark[] = marks.map((m) => {
            const path: Point[] = [];
            for (let i = 0; i + 1 < m.path.length; i += 2) {
                path.push({ x: m.path[i] * k, y: m.path[i + 1] * k });
            }
            return { n: m.n, kind: m.kind, box: scaleBox(m.box, k), path };
        });
        paintMarks(ctx, painted, out, color);
    });
}
