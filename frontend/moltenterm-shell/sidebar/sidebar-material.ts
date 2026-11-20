// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The neighbour's sidebar capture without the window's material (FR-SHELL-082, #2407). The capture is of the screen's
// pixels: they hold the window's material (the frame's tint, at its alpha on a see-through look, and its texture) under
// the sidebar's content. The swipe draws the capture over the material of the view on screen, so the material counted
// twice (the incoming sidebar came in darker), or slid in with the capture (a texture moving with the sidebar). The
// capturing view knows its own material, so it takes it out, and what slides in is the sidebar's content alone, over a
// material that stays still, whatever look the neighbour has. Loaded only when a capture is taken.

import { switchLayoutOn } from "../switch-layout/layout-frames";

// Within this many levels per channel, an opaque pixel is the material itself (the canvas and the compositor round the
// tint and the texture alike, give or take a level).
export const MaterialTolerance = 3;

// With P the captured pixel and B the material, both with straight alpha, P is the content C over B.
// - Where the material lets the desktop through (aB < 1), C's alpha is (aP - aB) / (1 - aB) and its premultiplied colour
//   P·aP - B·aB·(1 - aC): exact.
// - Where it is opaque, C cannot be told from the material under it: a pixel that is the material is the empty sidebar
//   and goes; any other keeps its colour, the material under the content's edges included.
export function uncomposite(pixels: Uint8ClampedArray, material: Uint8ClampedArray): void {
    for (let i = 0; i + 3 < pixels.length; i += 4) {
        const ab = material[i + 3] / 255;
        if (ab >= 0.999) {
            const same =
                pixels[i + 3] >= 254 &&
                Math.abs(pixels[i] - material[i]) <= MaterialTolerance &&
                Math.abs(pixels[i + 1] - material[i + 1]) <= MaterialTolerance &&
                Math.abs(pixels[i + 2] - material[i + 2]) <= MaterialTolerance;
            if (same) {
                pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
            }
            continue;
        }
        const ap = pixels[i + 3] / 255;
        const ac = Math.max(0, Math.min(1, (ap - ab) / (1 - ab)));
        if (ac <= 0.002) {
            pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
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

// Where the frame's corner lies in the capture, in CSS pixels: the capture's rectangle is the viewport's, rounded.
export function materialOffset(frame: { left: number; top: number }, viewport: { left: number; top: number }) {
    return { x: Math.round(frame.left) - Math.round(viewport.left), y: Math.round(frame.top) - Math.round(viewport.top) };
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
    const off = materialOffset(fr, viewport.getBoundingClientRect());
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.translate(off.x, off.y);
    ctx.fillStyle = cs.backgroundColor;
    ctx.fillRect(0, 0, fr.width, fr.height);
    const tileUrl = textureUrl(cs.backgroundImage);
    if (tileUrl == null) {
        return;
    }
    const tile = await loadImage(tileUrl);
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

// The computed value quotes its URL, and an SVG tile holds parentheses of its own.
function textureUrl(backgroundImage: string): string {
    const m = /^url\("(.+)"\)$/.exec((backgroundImage ?? "").trim());
    return m == null ? null : m[1];
}

// The capture with the window's material taken out (see uncomposite). The capture as it was when the frame is one
// opaque colour (the capture over it is already itself), with the layout switched off (MOLTENTERM_SWITCHPICTURE), or
// when anything fails.
export async function withoutMaterial(url: string, viewport: HTMLElement): Promise<string> {
    const frame = viewport?.closest<HTMLElement>(".mt-sb-frame");
    if (frame == null || !switchLayoutOn()) {
        return url;
    }
    const translucent = document.documentElement.classList.contains("mt-translucent");
    if (!translucent && textureUrl(getComputedStyle(frame).backgroundImage) == null) {
        return url;
    }
    try {
        const img = await loadImage(url);
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const scale = w / Math.max(1, Math.round(viewport.getBoundingClientRect().width));
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
