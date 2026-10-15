// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { placeLabelKey, previewInsets, sideForKey, SplitSides, zoneAt, zonePoints } from "./split-place-model";

describe("split placement zones (#677)", () => {
    it("picks the triangle under the pointer, from the centre to each edge", () => {
        expect(zoneAt(10, 150, 400, 300)).toBe("left");
        expect(zoneAt(390, 150, 400, 300)).toBe("right");
        expect(zoneAt(200, 10, 400, 300)).toBe("up");
        expect(zoneAt(200, 290, 400, 300)).toBe("down");
    });

    it("splits a wide panel along its diagonals, not at fixed distances", () => {
        // 100 px from the left of an 800 px panel is 12.5 %; 60 px from the top of 300 px is 20 %.
        expect(zoneAt(100, 60, 800, 300)).toBe("left");
        // 300 px from the left (37.5 %) and 60 px from the top (20 %): the top triangle.
        expect(zoneAt(300, 60, 800, 300)).toBe("up");
    });

    it("has no zone outside the panel or on an empty one", () => {
        expect(zoneAt(-1, 10, 400, 300)).toBe(null);
        expect(zoneAt(10, 301, 400, 300)).toBe(null);
        expect(zoneAt(0, 0, 0, 300)).toBe(null);
    });

    it("maps the arrow keys to their side and nothing else", () => {
        expect(sideForKey("ArrowLeft")).toBe("left");
        expect(sideForKey("ArrowRight")).toBe("right");
        expect(sideForKey("ArrowUp")).toBe("up");
        expect(sideForKey("ArrowDown")).toBe("down");
        expect(sideForKey("Enter")).toBe(null);
        expect(sideForKey("a")).toBe(null);
    });

    it("previews the half the new panel takes", () => {
        expect(previewInsets("left")).toEqual({ top: "0%", right: "50%", bottom: "0%", left: "0%" });
        expect(previewInsets("right")).toEqual({ top: "0%", right: "0%", bottom: "0%", left: "50%" });
        expect(previewInsets("up")).toEqual({ top: "0%", right: "0%", bottom: "50%", left: "0%" });
        expect(previewInsets("down")).toEqual({ top: "50%", right: "0%", bottom: "0%", left: "0%" });
    });

    it("draws four triangles meeting at the centre, each labelled", () => {
        expect(SplitSides).toHaveLength(4);
        for (const side of SplitSides) {
            expect(zonePoints(side)).toContain("50,50");
            expect(placeLabelKey(side)).toBe(`split.place.${side}`);
        }
        expect(new Set(SplitSides.map(zonePoints)).size).toBe(4);
    });
});
