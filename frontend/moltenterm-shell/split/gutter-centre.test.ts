// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { resizeHandleDimensions, setTransform } from "@/layout/lib/utils";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const gutterCss = readFileSync(new URL("./panel-gutter.css", import.meta.url), "utf8");
const sidebarCss = readFileSync(new URL("../sidebar/sidebar.css", import.meta.url), "utf8");

const Gap = 8;

describe("resize handle geometry (#1240)", () => {
    it("centres the handle on the rounded edge the tiles share, side by side", () => {
        for (const edge of [400, 400.2, 400.5, 400.7, 333.333, 0.4]) {
            const lastChild = { top: 10, left: 0, width: edge, height: 300.5 };
            const handle = resizeHandleDimensions(lastChild, true, 2 * Gap);
            const tile = setTransform(lastChild);
            expect(handle.left + Gap).toBe(parseInt(String(tile.width)));
            expect(Number.isInteger(handle.left)).toBe(true);
        }
    });

    it("centres the handle on the rounded edge the tiles share, stacked", () => {
        for (const edge of [400, 400.2, 400.5, 400.7, 333.333, 0.4]) {
            const lastChild = { top: 0, left: 5, width: 300.5, height: edge };
            const handle = resizeHandleDimensions(lastChild, false, 2 * Gap);
            const tile = setTransform(lastChild);
            expect(handle.top + Gap).toBe(parseInt(String(tile.height)));
            expect(Number.isInteger(handle.top)).toBe(true);
        }
    });

    it("gives the grip the parity of the gap", () => {
        expect(gutterCss).toContain("--mt-grip-w: calc(4px - mod(var(--gap-size-px), 2px))");
        expect(gutterCss).not.toMatch(/(width|height): 3px/);
        expect(sidebarCss).toContain("width: calc(4px - mod(var(--mt-frame-gap), 2px))");
    });
});
