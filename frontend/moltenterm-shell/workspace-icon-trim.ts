// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every image badge at the same visual size (#522): a logo drawn with a wide transparent margin looked tiny next to
// one drawn edge to edge, and the badge's box sized the file, not what it shows. Once per image and run, the visible
// content (its non-transparent pixels) is measured, the margin trimmed and the content centred in a square with the
// same inner padding for every logo. An opaque image has no margin to trim: it is only made square, never cropped.

// Below this alpha a pixel is antialiasing or a shadow's tail, not content.
const AlphaThreshold = 16;

// The share of the square the content of a transparent logo fills: the same breathing room for every one.
export const ContentShare = 0.86;

// No need to draw larger: the badge is at most 48 px, twice that for a Retina screen.
const MaxSide = 128;

export type ContentBox = { x: number; y: number; w: number; h: number; transparent: boolean };

// The bounding box of the pixels at or above the threshold, from RGBA data; null when nothing is visible.
export function contentBox(data: ArrayLike<number>, width: number, height: number): ContentBox {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let transparent = false;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const alpha = data[(y * width + x) * 4 + 3];
            if (alpha < 255) {
                transparent = true;
            }
            if (alpha < AlphaThreshold) {
                continue;
            }
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
    }
    if (maxX < 0) {
        return null;
    }
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, transparent };
}

export type TrimLayout = {
    // The square canvas side.
    side: number;
    // Where the content is drawn in it, and at what size.
    dx: number;
    dy: number;
    dw: number;
    dh: number;
};

// The square the content goes into: a transparent logo gets the padding of ContentShare, an opaque image fills the
// square on its long side (letterboxed, never cropped).
export function trimLayout(box: ContentBox, maxSide: number = MaxSide): TrimLayout {
    const long = Math.max(box.w, box.h);
    const share = box.transparent ? ContentShare : 1;
    const side = Math.max(1, Math.min(maxSide, Math.round(long / share)));
    const scale = (side * share) / long;
    const dw = box.w * scale;
    const dh = box.h * scale;
    return { side, dx: (side - dw) / 2, dy: (side - dh) / 2, dw, dh };
}

const Trimmed = new Map<string, Promise<string>>();

async function trim(url: string): Promise<string> {
    const resp = await fetch(url);
    if (!resp.ok) {
        return null;
    }
    const blob = await resp.blob();
    // An SVG has no pixels to measure before it is drawn at some size: it is drawn, measured and trimmed like the rest.
    const bitmap = await createImageBitmap(blob, { resizeWidth: 256, resizeQuality: "high" }).catch(() =>
        createImageBitmap(blob)
    );
    const probe = new OffscreenCanvas(bitmap.width, bitmap.height);
    const probeCtx = probe.getContext("2d");
    probeCtx.drawImage(bitmap, 0, 0);
    const box = contentBox(probeCtx.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
    if (box == null) {
        bitmap.close();
        return null;
    }
    const layout = trimLayout(box);
    const out = new OffscreenCanvas(layout.side, layout.side);
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, box.x, box.y, box.w, box.h, layout.dx, layout.dy, layout.dw, layout.dh);
    bitmap.close();
    return URL.createObjectURL(await out.convertToBlob({ type: "image/png" }));
}

// The trimmed copy of an image, as an object URL, made once per key for the run (the URL and the workspace's
// revision: an image imported again under the same name is measured again); null when it cannot be made (the badge
// then shows the file as it is, fitted).
export function trimmedIconUrl(url: string, key: string = url): Promise<string> {
    let pending = Trimmed.get(key);
    if (pending == null) {
        pending = trim(url).catch((): string => null);
        Trimmed.set(key, pending);
    }
    return pending;
}
