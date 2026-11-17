// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The annotated image of #2327: the page's capture with each zone framed and numbered, the picture the agent is pointed
// to. The drawing takes a small context interface so a test can record it; composeAnnotatedImage is the one place that
// needs a canvas.

import type { Size, Zone } from "./annotate-model";

export type Paint2D = {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    font: string;
    textAlign: string;
    textBaseline: string;
    globalAlpha: number;
    fillRect(x: number, y: number, w: number, h: number): void;
    strokeRect(x: number, y: number, w: number, h: number): void;
    beginPath(): void;
    arc(x: number, y: number, r: number, from: number, to: number): void;
    fill(): void;
    stroke(): void;
    fillText(text: string, x: number, y: number): void;
};

// A zone's frame is drawn in the action colour of the theme: the canvas cannot read a CSS variable by itself, so the
// colour is read from the page, and the image's ink is a plain white, which reads on any page.
const FallbackColor = "orange";
const BadgeInk = "white";
// The image is sent over the websocket (10 MB) as base64: its PNG stays under about 3 MiB, wavesrv's limit is 4.
const MaxImageChars = 4_000_000;
const MaxSide = 1600;
const ShrinkStep = 0.75;
const MaxAttempts = 5;

export function annotateColor(): string {
    if (typeof document === "undefined") {
        return FallbackColor;
    }
    const value = getComputedStyle(document.documentElement).getPropertyValue("--mt-action").trim();
    return value || FallbackColor;
}

// paintZones: each zone's frame and its number badge on the corner, sized with the image so they read at any scale.
export function paintZones(ctx: Paint2D, zones: Zone[], size: Size, color: string): void {
    const unit = Math.max(1, size.w / 1000);
    zones.forEach((zone, i) => {
        const x = zone.x * size.w;
        const y = zone.y * size.h;
        const w = zone.w * size.w;
        const h = zone.h * size.h;
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, 3 * unit);
        ctx.strokeRect(x, y, w, h);
        const r = Math.max(11, 13 * unit);
        const cx = Math.min(size.w - r - 1, Math.max(r + 1, x));
        const cy = Math.min(size.h - r - 1, Math.max(r + 1, y));
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
        ctx.fillText(String(i + 1), cx, cy + 1);
    });
}

// fitSize: the image's size at most maxSide on its longer side.
export function fitSize(width: number, height: number, maxSide: number): Size {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("the capture could not be read"));
        img.src = src;
    });
}

// composeAnnotatedImage: the capture with its zones drawn in, as a PNG data URL small enough to send. A capture of a
// large panel on a dense display is scaled down, and again while its PNG is too large.
export async function composeAnnotatedImage(
    capture: string,
    zones: Zone[]
): Promise<{ dataUrl: string; width: number; height: number }> {
    const img = await loadImage(capture);
    let side = MaxSide;
    for (let attempt = 0; attempt < MaxAttempts; attempt++) {
        const size = fitSize(img.naturalWidth, img.naturalHeight, side);
        const canvas = document.createElement("canvas");
        canvas.width = size.w;
        canvas.height = size.h;
        const ctx = canvas.getContext("2d");
        if (ctx == null) {
            throw new Error("the capture could not be drawn");
        }
        // A page without a background of its own is transparent in its capture, which a viewer would show black.
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, size.w, size.h);
        ctx.drawImage(img, 0, 0, size.w, size.h);
        paintZones(ctx as unknown as Paint2D, zones, size, annotateColor());
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length <= MaxImageChars) {
            return { dataUrl, width: size.w, height: size.h };
        }
        side = Math.round(Math.max(size.w, size.h) * ShrinkStep);
    }
    throw new Error("the annotated image is too large");
}
