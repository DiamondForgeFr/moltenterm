// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { pointerInCorner, windowButtonsVisible } from "./window-corner-model";

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
