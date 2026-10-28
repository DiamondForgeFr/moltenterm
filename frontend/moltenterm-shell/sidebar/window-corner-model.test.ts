// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { frameSizes, pointerInCorner, windowButtonsVisible } from "./window-corner-model";

describe("the frame's one margin (DS-SHELL-127)", () => {
    it("is 8 px when window:tilegapsize is not set", () => {
        expect(frameSizes(undefined)).toEqual({ marginPx: 8, gapPx: 8 });
        expect(frameSizes(null)).toEqual({ marginPx: 8, gapPx: 8 });
    });

    it("takes a set window:tilegapsize for both the margins and the gap between panels", () => {
        expect(frameSizes(3)).toEqual({ marginPx: 3, gapPx: 3 });
        expect(frameSizes(12)).toEqual({ marginPx: 12, gapPx: 12 });
        expect(frameSizes(0)).toEqual({ marginPx: 0, gapPx: 0 });
    });

    it("ignores a value that is not a size", () => {
        expect(frameSizes(-4)).toEqual({ marginPx: 8, gapPx: 8 });
        expect(frameSizes("10")).toEqual({ marginPx: 8, gapPx: 8 });
        expect(frameSizes(Number.NaN)).toEqual({ marginPx: 8, gapPx: 8 });
    });
});

const hidden = { sidebarHidden: true, peek: false, corner: false, fullScreen: false };

describe("the window buttons in the Spaces frame (DS-SHELL-127)", () => {
    it("show with the sidebar", () => {
        expect(windowButtonsVisible({ ...hidden, sidebarHidden: false })).toBe(true);
    });

    it("hide with the sidebar, until the pointer reaches the corner or the sidebar peeks", () => {
        expect(windowButtonsVisible(hidden)).toBe(false);
        expect(windowButtonsVisible({ ...hidden, corner: true })).toBe(true);
        expect(windowButtonsVisible({ ...hidden, peek: true })).toBe(true);
    });

    it("stay with the system in full screen", () => {
        expect(windowButtonsVisible({ ...hidden, fullScreen: true })).toBe(true);
    });
});

describe("the top-left corner", () => {
    const corner = { right: 114, bottom: 33 };

    it("holds the pointer inside it only", () => {
        expect(pointerInCorner(0, 0, corner)).toBe(true);
        expect(pointerInCorner(113, 32, corner)).toBe(true);
        expect(pointerInCorner(114, 10, corner)).toBe(false);
        expect(pointerInCorner(10, 33, corner)).toBe(false);
        expect(pointerInCorner(-1, 4, corner)).toBe(false);
    });
});
