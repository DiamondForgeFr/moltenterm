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

type StyleTarget = { setProperty(name: string, value: string): void };

export function applyAccent(color: string, style: StyleTarget): void {
    const rgb = parseColor(color) ?? parseColor(MoltentermDefaultAccent);
    style.setProperty("--mt-accent", `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);
    style.setProperty("--mt-accent-fg", accentForeground(rgb));
}

export function startMoltentermAccent(workspaceAtom: Atom<Workspace>): void {
    const apply = () => applyAccent(globalStore.get(workspaceAtom)?.color, document.documentElement.style);
    apply();
    globalStore.sub(workspaceAtom, apply);
}
