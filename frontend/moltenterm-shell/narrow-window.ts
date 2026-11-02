// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A narrow window (FR-SHELL-109): below this width the sidebar floats on its own (FR-SHELL-079) and two columns that
// do not fit at their readable minimums go to the 360 view (FR-SHELL-066). One signal, so both switch together.

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

// In CSS pixels, so a zoomed-in window counts as narrower. At 1000 px a docked default sidebar (264 px) still leaves
// the view about 720 px; below it the view needs the whole width.
export const NarrowWindowPx = 1000;

export function isNarrowWindow(widthPx: number): boolean {
    return Number.isFinite(widthPx) && widthPx > 0 && widthPx < NarrowWindowPx;
}

function currentWidth(): number {
    return typeof window === "undefined" ? 0 : window.innerWidth;
}

export const windowWidthAtom = jotai.atom(currentWidth()) as jotai.PrimitiveAtom<number>;
export const narrowWindowAtom = jotai.atom((get) => isNarrowWindow(get(windowWidthAtom)));

if (typeof window !== "undefined") {
    window.addEventListener("resize", () => globalStore.set(windowWidthAtom, currentWidth()));
}

export function isNarrowWindowNow(): boolean {
    return globalStore.get(narrowWindowAtom);
}
