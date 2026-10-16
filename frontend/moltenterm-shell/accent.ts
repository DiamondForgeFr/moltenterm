// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Workspace accent colours (FR-SHELL-004, DS-SHELL-005). Every accent token in moltenterm-shell.css derives from
// --mt-accent; this module sets it from the colour of the window's active workspace, with a readable text colour
// for content drawn on the accent (NFR-SHELL-003).

import { globalStore } from "@/app/store/jotaiStore";
import type { Atom } from "jotai";

export const MoltentermDefaultAccent = "#FF7C0D";

type Rgb = { r: number; g: number; b: number };

export function parseColor(color: string): Rgb {
    if (color == null) {
        return null;
    }
    const value = color.trim();
    let match = /^#([0-9a-f]{3})$/i.exec(value);
    if (match) {
        const [r, g, b] = match[1].split("").map((c) => parseInt(c + c, 16));
        return { r, g, b };
    }
    match = /^#([0-9a-f]{6})$/i.exec(value);
    if (match) {
        const n = parseInt(match[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
    if (match) {
        return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    }
    return null;
}

function channel(c: number): number {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }: Rgb): number {
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// Black or white, whichever reads better on the accent.
export function accentForeground(accent: Rgb): string {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    return contrastRatio(accent, black) >= contrastRatio(accent, white) ? "#000000" : "#ffffff";
}

// CSS `color-mix(in srgb, a pct%, b)` for opaque colours: the warm neutrals of moltenterm-shell.css (FR-SHELL-014).
export function mixColor(a: Rgb, b: Rgb, pct: number): Rgb {
    const p = pct / 100;
    const mix = (x: number, y: number) => Math.round(x * p + y * (1 - p));
    return { r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b) };
}

// Black or white, whichever has the better worst case over every stop of a gradient: text drawn across it stays
// readable wherever it lands.
export function gradientForeground(stops: Rgb[]): string {
    const usable = (stops ?? []).filter((s) => s != null);
    if (usable.length === 0) {
        return "#000000";
    }
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    const worst = (fg: Rgb) => Math.min(...usable.map((s) => contrastRatio(s, fg)));
    return worst(black) >= worst(white) ? "#000000" : "#ffffff";
}

// The keyboard focus ring (#751): the workspace accent, lightened toward white until it reads at 3:1 (WCAG 1.4.11) on
// the lightest surface a ring is drawn on (a key cap or a hovered row, ~rgb(60,60,60)). A dark accent (navy, a deep red)
// would otherwise vanish on the dark panels; a light one is kept as it is.
const FocusRingSurface: Rgb = { r: 60, g: 60, b: 60 };
export const FocusRingMinContrast = 3;

export function focusRingColor(accent: Rgb): Rgb {
    const white = { r: 255, g: 255, b: 255 };
    for (let pct = 100; pct > 0; pct -= 5) {
        const ring = mixColor(accent, white, pct);
        if (contrastRatio(ring, FocusRingSurface) >= FocusRingMinContrast) {
            return ring;
        }
    }
    return white;
}

export function toHex({ r, g, b }: Rgb): string {
    return (
        "#" +
        [r, g, b]
            .map((c) =>
                Math.max(0, Math.min(255, Math.round(c)))
                    .toString(16)
                    .padStart(2, "0")
            )
            .join("")
    );
}

// A workspace's colour (#657): `color` keeps a flat colour, the first stop of a gradient, which every surface that
// knows only `color` (Wave's switcher included) shows; the gradient's stops live in this meta key, as "#a,#b[,#c]".
// The gradient counts only while its first stop is `color`: a colour set elsewhere, which leaves the key behind, wins.
export const WorkspaceGradientMetaKey = "molten:workspacegradient";
export const MaxGradientStops = 3;

// "#a" or "#a,#b[,#c]" as lowercase #rrggbb stops, or "" when a stop is not a hex colour.
export function normaliseColourChoice(choice: string): string {
    if (typeof choice !== "string" || choice.trim() === "") {
        return "";
    }
    const parts = choice.split(",").map((s) => s.trim());
    if (parts.length > MaxGradientStops || parts.some((p) => !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(p))) {
        return "";
    }
    return parts.map((p) => toHex(parseColor(p))).join(",");
}

// The stops a workspace shows: one for a flat colour, 2-3 for a gradient, none without a colour.
export function workspaceColourStops(ws: { color?: string; meta?: unknown }): string[] {
    const color = normaliseColourChoice(ws?.color ?? "").split(",")[0];
    if (!color) {
        return [];
    }
    const raw = (ws?.meta as Record<string, unknown>)?.[WorkspaceGradientMetaKey];
    const gradient = normaliseColourChoice(typeof raw === "string" ? raw : "").split(",");
    return gradient.length > 1 && gradient[0] === color ? gradient : [color];
}

type StyleTarget = { setProperty(name: string, value: string): void };

function rgbCss({ r, g, b }: Rgb): string {
    return `rgb(${r}, ${g}, ${b})`;
}

// --mt-accent is the first stop, which every thin line and every fill behind text uses, with --mt-accent-fg picked on
// it; --mt-accent-mid and --mt-accent-end complete the gradient where one is drawn (the same colour when it is flat);
// --mt-focus-ring is the keyboard focus ring drawn from it.
export function applyAccent(color: string, style: StyleTarget, stops: string[] = []): void {
    const rgb = parseColor(color) ?? parseColor(MoltentermDefaultAccent);
    const rest = stops.length > 1 && parseColor(stops[0]) != null ? stops.slice(1).map(parseColor) : [];
    const end = rest[rest.length - 1] ?? rgb;
    const mid = rest.length > 1 ? rest[0] : mixColor(rgb, end, 50);
    style.setProperty("--mt-accent", rgbCss(rgb));
    style.setProperty("--mt-accent-mid", rgbCss(mid));
    style.setProperty("--mt-accent-end", rgbCss(end));
    style.setProperty("--mt-accent-fg", accentForeground(rgb));
    style.setProperty("--mt-focus-ring", rgbCss(focusRingColor(rgb)));
}

export function startMoltentermAccent(workspaceAtom: Atom<Workspace>): void {
    const apply = () => {
        const ws = globalStore.get(workspaceAtom);
        const stops = workspaceColourStops(ws);
        applyAccent(stops[0] ?? ws?.color, document.documentElement.style, stops);
        document.documentElement.toggleAttribute("data-mt-accent-gradient", stops.length > 1);
    };
    apply();
    globalStore.sub(workspaceAtom, apply);
}
