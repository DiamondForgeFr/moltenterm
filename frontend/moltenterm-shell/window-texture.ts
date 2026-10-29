// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace's texture (#1294, FR-SHELL-091, DS-SHELL-131): a quiet grain or pattern over the frame's tint and under
// the content. Each texture is a small SVG tile written here (a fractal-noise filter or a few shapes), no image file and
// no animation; the browser rasterises a tile once and repeats it, and the same settings always give the same string,
// kept in a cache, so a resize or a workspace switch never builds it again.

export const TextureKinds = ["none", "grain", "dots", "lines", "paper"] as const;
export type TextureKind = (typeof TextureKinds)[number];

// Light ink on an opaque frame; dark ink on a translucent one, where what is behind can be white: dark ink only ever
// raises the light sidebar text's contrast, so the 4.5:1 minimum of the opacity (#1281) holds unchanged.
export type TextureTone = "light" | "dark";

export const MinTextureIntensity = 0.2;
export const TextureIntensityStep = 0.1;
export const DefaultTextureIntensity = 0.5;

// The ink's highest alpha at full intensity: no pixel of a tile is more opaque than this. The light values keep the
// sidebar's text at 4.5:1 or more over the lightest workspace tint (window-texture.test.ts computes it).
export const MaxInk: Record<Exclude<TextureKind, "none">, Record<TextureTone, number>> = {
    grain: { light: 0.16, dark: 0.24 },
    dots: { light: 0.12, dark: 0.16 },
    lines: { light: 0.07, dark: 0.1 },
    paper: { light: 0.1, dark: 0.14 },
};

const TileSize: Record<Exclude<TextureKind, "none">, number> = {
    grain: 128,
    dots: 6,
    lines: 8,
    paper: 192,
};

const Ink: Record<TextureTone, string> = { light: "#ffffff", dark: "#000000" };

export function isTextureKind(value: any): value is TextureKind {
    return typeof value === "string" && (TextureKinds as readonly string[]).includes(value);
}

// The intensity the slider can hold: 20 % to 100 % in 10 % steps; the default when it is not a number.
export function clampTextureIntensity(value: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DefaultTextureIntensity;
    }
    const stepped = Math.round(value / TextureIntensityStep) * TextureIntensityStep;
    return Math.round(Math.min(1, Math.max(MinTextureIntensity, stepped)) * 100) / 100;
}

// The ink's highest alpha: only the grain follows the intensity; the patterns keep their tuned value.
export function inkAlpha(kind: TextureKind, intensity: number, tone: TextureTone): number {
    if (kind === "none") {
        return 0;
    }
    const max = MaxInk[kind][tone];
    const scale = kind === "grain" ? clampTextureIntensity(intensity) : 1;
    return Math.round(max * scale * 1000) / 1000;
}

// Fractal noise turned into ink whose alpha is `alpha * (gain * noise + bias)`, gain + bias = 1, so the brightest noise
// gives exactly `alpha` and nothing is more opaque. A fixed seed: the same tile every time.
function noiseTile(
    size: number,
    frequency: string,
    octaves: number,
    gain: number,
    alpha: number,
    tone: TextureTone
): string {
    const c = tone === "light" ? 1 : 0;
    const a = (alpha * gain).toFixed(4);
    const b = (alpha * (1 - gain)).toFixed(4);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        `<filter id="t" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
        `<feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="${octaves}" seed="7" stitchTiles="stitch"/>` +
        `<feColorMatrix type="matrix" values="0 0 0 0 ${c} 0 0 0 0 ${c} 0 0 0 0 ${c} ${a} 0 0 0 ${b}"/>` +
        `</filter>` +
        `<rect width="100%" height="100%" filter="url(#t)"/>` +
        `</svg>`
    );
}

function tileSvg(kind: Exclude<TextureKind, "none">, alpha: number, tone: TextureTone): string {
    const ink = Ink[tone];
    const size = TileSize[kind];
    switch (kind) {
        case "grain":
            return noiseTile(size, "0.8", 2, 2, alpha, tone);
        case "paper":
            return noiseTile(size, "0.045", 5, 1.6, alpha, tone);
        case "dots":
            return (
                `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
                `<circle cx="3" cy="3" r="0.75" fill="${ink}" fill-opacity="${alpha}"/>` +
                `</svg>`
            );
        case "lines":
            return (
                `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
                `<path d="M-1 1L1 -1M0 8L8 0M7 9L9 7" stroke="${ink}" stroke-opacity="${alpha}" stroke-width="0.75"/>` +
                `</svg>`
            );
    }
}

export type TextureBackground = { image: string; size: string };

const cache = new Map<string, TextureBackground>();

// The CSS background of a texture, built once per kind, intensity and tone; null for none.
export function textureBackground(kind: TextureKind, intensity: number, tone: TextureTone): TextureBackground {
    if (!isTextureKind(kind) || kind === "none") {
        return null;
    }
    const alpha = inkAlpha(kind, intensity, tone);
    const key = `${kind}:${alpha}:${tone}`;
    const cached = cache.get(key);
    if (cached != null) {
        return cached;
    }
    const svg = tileSvg(kind, alpha, tone);
    const size = TileSize[kind];
    const background = {
        image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
        size: `${size}px ${size}px`,
    };
    cache.set(key, background);
    return background;
}
