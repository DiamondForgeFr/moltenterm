// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The dominant colours of a workspace's image (#657), offered first in the editor's colour field. Computed here, from
// the image drawn small, and kept for the run per image: nothing leaves the app.

import { toHex } from "./accent";

// Below this alpha a pixel is antialiasing, a shadow or the background, not the logo.
const MinAlpha = 128;
// The logo's ink and paper are left out: a channel maximum this dark is near black, a minimum this light near white.
const NearBlackMax = 40;
const NearWhiteMin = 225;
// Neighbouring shades (an antialiased edge, a soft shading) count as one colour.
const MergeDistance = 24;
// Two colours offered side by side must look different.
const DistinctDistance = 36;
// A colour must cover this share of the logo's coloured pixels to be offered: a stray detail is not the brand.
const MinShare = 0.04;
// A logo with fewer coloured pixels than this share of its visible ones is black, white or grey: nothing to offer.
const MinColouredShare = 0.02;

export const MaxLogoColours = 4;
// Large enough for a logo's colours, small enough to count in a few milliseconds.
const SampleSide = 64;

type Cluster = { count: number; r: number; g: number; b: number };

function mean(c: Cluster) {
    return { r: c.r / c.count, g: c.g / c.count, b: c.b / c.count };
}

// "Redmean" distance: close to how different two colours look, at the cost of plain RGB.
function distance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
    const rm = (a.r + b.r) / 2;
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}

// The 0-4 dominant colours of RGBA pixels, most covering first, as lowercase #rrggbb.
export function extractPalette(data: ArrayLike<number>, maxColours: number = MaxLogoColours): string[] {
    const buckets = new Map<number, Cluster>();
    let visible = 0;
    let coloured = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
        if (data[i + 3] < MinAlpha) {
            continue;
        }
        visible++;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max < NearBlackMax || min > NearWhiteMin) {
            continue;
        }
        coloured++;
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
        bucket.count++;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        buckets.set(key, bucket);
    }
    if (coloured === 0 || coloured < visible * MinColouredShare) {
        return [];
    }
    const clusters: Cluster[] = [];
    for (const bucket of [...buckets.values()].sort((x, y) => y.count - x.count)) {
        const near = clusters.find((c) => distance(mean(c), mean(bucket)) < MergeDistance);
        if (near == null) {
            clusters.push({ ...bucket });
            continue;
        }
        near.count += bucket.count;
        near.r += bucket.r;
        near.g += bucket.g;
        near.b += bucket.b;
    }
    const picked: { r: number; g: number; b: number }[] = [];
    for (const cluster of clusters.sort((x, y) => y.count - x.count)) {
        if (picked.length >= maxColours || cluster.count < coloured * MinShare) {
            break;
        }
        const colour = mean(cluster);
        if (picked.every((p) => distance(p, colour) >= DistinctDistance)) {
            picked.push(colour);
        }
    }
    return picked.map(toHex);
}

async function drawSmall(blob: Blob): Promise<ImageData> {
    const canvas = new OffscreenCanvas(SampleSide, SampleSide);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let source: CanvasImageSource;
    let release = () => {};
    try {
        const bitmap = await createImageBitmap(blob);
        source = bitmap;
        release = () => bitmap.close();
    } catch {
        // Chromium does not decode an SVG into a bitmap: an image element draws it.
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.src = url;
        try {
            await img.decode();
        } finally {
            URL.revokeObjectURL(url);
        }
        source = img;
    }
    ctx.drawImage(source, 0, 0, SampleSide, SampleSide);
    release();
    return ctx.getImageData(0, 0, SampleSide, SampleSide);
}

async function loadPalette(url: string): Promise<string[]> {
    const resp = await fetch(url);
    if (!resp.ok) {
        return [];
    }
    const image = await drawSmall(await resp.blob());
    return extractPalette(image.data);
}

const Palettes = new Map<string, Promise<string[]>>();

// The colours of the image at url, computed once per image for the run; none when it cannot be read.
export function logoPalette(url: string): Promise<string[]> {
    if (!url) {
        return Promise.resolve([]);
    }
    let pending = Palettes.get(url);
    if (pending == null) {
        pending = loadPalette(url).catch((): string[] => []);
        Palettes.set(url, pending);
    }
    return pending;
}
