// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 cube turns a quarter to the carpet panel that came in front and stays still otherwise (#1823).

import { describe, expect, it } from "vitest";
import { cubeAngle, faceRole, nextCube, startCube } from "./view-cube-model";
import type { GlyphCube } from "./view-menu-model";

function cube(id: string, icon: string, index: number, count = 4): GlyphCube {
    return { cube: true, id, icon, index, count };
}

describe("view cube turns (#1823)", () => {
    const companion = cube("companion", "gauge", 0);
    const page = cube("page", "globe", 1);
    const files = cube("files", "file-lines", 2);

    it("starts at rest with the front panel's icon on the front face", () => {
        const state = startCube(page);
        expect(cubeAngle(state)).toBeCloseTo(0);
        expect(state.icons[state.slot]).toBe("globe");
        expect(faceRole(state, state.slot)).toBe("front");
    });

    it("does not move while nothing changed: the same object, the same angle", () => {
        const state = startCube(page);
        expect(nextCube(state, page, true)).toBe(state);
        expect(nextCube(state, { ...page }, true)).toBe(state);
    });

    it("turns a quarter toward the right for a panel further on the carpet, writing it on the face that comes forward", () => {
        const state = nextCube(startCube(page), files, true);
        expect(cubeAngle(state)).toBe(-90);
        expect(state.slot).toBe(1);
        expect(state.icons[state.slot]).toBe("file-lines");
        expect(faceRole(state, 0)).toBe("left");
        expect(faceRole(state, 1)).toBe("front");
        expect(faceRole(state, 2)).toBe("right");
    });

    it("turns the other way for a panel earlier on the carpet", () => {
        const state = nextCube(startCube(page), companion, true);
        expect(cubeAngle(state)).toBe(90);
        expect(state.slot).toBe(3);
        expect(state.icons[3]).toBe("gauge");
    });

    it("keeps turning in one direction past a full turn, and the face in front always shows the panel in front", () => {
        let state = startCube(companion);
        const panels = [page, files, cube("review", "code-pull-request", 3), cube("agent", "robot", 4), companion];
        // companion -> page -> files -> review -> agent: four quarter turns to the right, then back to the companion
        for (const panel of panels.slice(0, 4)) {
            state = nextCube(state, panel, true);
            expect(state.icons[state.slot]).toBe(panel.icon);
        }
        expect(cubeAngle(state)).toBe(-360);
        expect(state.slot).toBe(0);
        state = nextCube(state, companion, true);
        expect(cubeAngle(state)).toBe(-270);
        expect(state.icons[state.slot]).toBe("gauge");
    });

    it("only swaps the icon when the same panel's icon changes (a page that loaded its icon): no turn", () => {
        const state = nextCube(startCube(page), { ...page, icon: "brands@github" }, true);
        expect(cubeAngle(state)).toBe(0);
        expect(state.icons[state.slot]).toBe("brands@github");
    });

    it("does not turn when a panel opened before the one in front shifts its place", () => {
        const state = nextCube(startCube(page), { ...page, index: 2, count: 5 }, true);
        expect(cubeAngle(state)).toBe(0);
        expect(state.index).toBe(2);
    });

    it("under reduced motion the front face just swaps: no turn, whichever panel comes", () => {
        let state = startCube(page);
        state = nextCube(state, files, false);
        expect(cubeAngle(state)).toBe(0);
        expect(state.icons[state.slot]).toBe("file-lines");
        state = nextCube(state, companion, false);
        expect(cubeAngle(state)).toBe(0);
        expect(state.icons[state.slot]).toBe("gauge");
        expect(state.id).toBe("companion");
    });
});
