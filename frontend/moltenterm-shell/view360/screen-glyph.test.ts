// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view's icon says what its screen shows (FR-SHELL-081, #1823): one mark per screen region. The fixed zone keeps its
// panels' icons, the carpet is one cube whose front face is the carpet panel in front.

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import { isGlyphCube, viewGlyphIcons, type GlyphCube } from "../sidebar/view-menu-model";
import type { CarpetLayout } from "./carpet-model";
import { describeScreen, readScreen, sameScreen, screenGlyphIcons, type ScreenDescription } from "./screen-glyph";

function leaf(id: string, blockId: string): LayoutNode {
    return { id, data: { blockId } } as unknown as LayoutNode;
}

function row(...children: LayoutNode[]): LayoutNode {
    return { id: "root", flexDirection: FlexDirection.Row, children } as unknown as LayoutNode;
}

function column(id: string, ...children: LayoutNode[]): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, children } as unknown as LayoutNode;
}

function layoutOf(fixedIds: string[], carpetIds: string[]): CarpetLayout {
    return {
        fixedNodeId: fixedIds[0],
        fixedColumns: fixedIds.map((nodeId, i) => ({ nodeId, mode: i === 0 ? "first" : "beside" })),
        columns: carpetIds.map((nodeId, i) => ({ nodeId, x: i * 400, width: 400 })),
    } as unknown as CarpetLayout;
}

const Icons: Record<string, string> = {
    agent: "robot",
    term: "terminal",
    companion: "gauge",
    page: "globe",
    files: "file-lines",
    review: "code-pull-request",
};
const iconOf = (id: string) => Icons[id];

function cubeOf(icons: ReturnType<typeof screenGlyphIcons>): GlyphCube {
    return icons.find(isGlyphCube);
}

describe("describeScreen (#1823)", () => {
    // agent | [companion, page]
    const root = row(leaf("n1", "agent"), leaf("n2", "companion"), leaf("n3", "page"));
    const layout = layoutOf(["n1"], ["n2", "n3"]);

    it("names the fixed panels, the carpet's panels in order, the one in front and how many are on screen", () => {
        expect(describeScreen(root, layout, ["n3"])).toEqual({
            fixed: ["agent"],
            carpet: ["companion", "page"],
            front: "page",
            shown: 1,
        });
    });

    it("puts the first column in view in front, whatever is further on (360 x N)", () => {
        expect(describeScreen(root, layout, ["n2", "n3"]).front).toBe("companion");
    });

    it("counts the carpet columns in view: one, two, three (#1861)", () => {
        const wide = row(leaf("n1", "agent"), leaf("n2", "companion"), leaf("n3", "page"), leaf("n4", "files"));
        const wideLayout = layoutOf(["n1"], ["n2", "n3", "n4"]);
        expect(describeScreen(wide, wideLayout, ["n3"]).shown).toBe(1);
        expect(describeScreen(wide, wideLayout, ["n2", "n3"])).toMatchObject({ front: "companion", shown: 2 });
        expect(describeScreen(wide, wideLayout, ["n2", "n3", "n4"])).toMatchObject({ front: "companion", shown: 3 });
        expect(describeScreen(wide, wideLayout, ["n3", "n4"])).toMatchObject({ front: "page", shown: 2 });
    });

    it("counts a column in view that holds no panel as no place, and shows at least one", () => {
        const hollow = row(leaf("n1", "agent"), column("n2"), leaf("n3", "page"));
        expect(describeScreen(hollow, layoutOf(["n1"], ["n2", "n3"]), ["n2", "n3"]).shown).toBe(1);
        expect(describeScreen(root, layout, []).shown).toBe(1);
    });

    it("falls back to the first carpet column when none is reported in view", () => {
        expect(describeScreen(root, layout, []).front).toBe("companion");
    });

    it("is null for a view not drawn in 360 view, or without a carpet panel", () => {
        expect(describeScreen(root, null, [])).toBeNull();
        expect(describeScreen(null, layout, [])).toBeNull();
        expect(describeScreen(root, layoutOf(["n1"], []), [])).toBeNull();
    });

    it("keeps every panel of the fixed zone, pinned columns included, and names a stacked carpet column by its first panel", () => {
        const stacked = row(
            column("c1", leaf("a", "agent"), leaf("b", "term")),
            leaf("pinned", "review"),
            column("c2", leaf("d", "page"), leaf("e", "files"))
        );
        expect(describeScreen(stacked, layoutOf(["c1", "pinned"], ["c2"]), ["c2"])).toEqual({
            fixed: ["agent", "term", "review"],
            carpet: ["page"],
            front: "page",
            shown: 1,
        });
    });
});

describe("screenGlyphIcons (#1823)", () => {
    const screen: ScreenDescription = { fixed: ["agent"], carpet: ["companion", "page"], front: "page", shown: 1 };
    const live = ["agent", "companion", "page"];
    const Carpet = [
        { id: "companion", icon: "gauge" },
        { id: "page", icon: "globe" },
    ];

    it("draws the agent's icon, then a cube whose front face is the page", () => {
        const icons = screenGlyphIcons(screen, live, iconOf);
        expect(icons).toHaveLength(2);
        expect(icons[0]).toBe("robot");
        expect(cubeOf(icons)).toEqual({
            cube: true,
            id: "page",
            icon: "globe",
            index: 1,
            count: 2,
            shown: 1,
            panels: Carpet,
        });
    });

    it("turns the cube to the companion when the carpet scrolls to it", () => {
        const icons = screenGlyphIcons({ ...screen, front: "companion" }, live, iconOf);
        expect(cubeOf(icons)).toMatchObject({ id: "companion", icon: "gauge", index: 0 });
    });

    it("shows one cube whatever the carpet holds: three carpet panels still make a single mark", () => {
        const many: ScreenDescription = {
            fixed: ["agent"],
            carpet: ["companion", "page", "files", "review"],
            front: "files",
            shown: 1,
        };
        const icons = screenGlyphIcons(many, [...live, "files", "review"], iconOf);
        expect(icons.filter(isGlyphCube)).toHaveLength(1);
        expect(icons).toHaveLength(2);
        expect(cubeOf(icons)).toMatchObject({ id: "files", index: 2, count: 4 });
    });

    it("carries the carpet's icons in order and how many panels are on screen (#1861)", () => {
        const two: ScreenDescription = { ...screen, front: "companion", shown: 2 };
        const cube = cubeOf(screenGlyphIcons(two, live, iconOf));
        expect(cube.shown).toBe(2);
        expect(cube.panels.map((p) => p.icon)).toEqual(["gauge", "globe"]);
        expect(screenGlyphIcons(two, live, iconOf)).toHaveLength(2);
    });

    it("never counts more panels on screen than the carpet holds from the front one on (#1861)", () => {
        expect(cubeOf(screenGlyphIcons({ ...screen, shown: 3 }, live, iconOf)).shown).toBe(1);
        expect(cubeOf(screenGlyphIcons({ ...screen, front: "companion", shown: 5 }, live, iconOf)).shown).toBe(2);
        expect(cubeOf(screenGlyphIcons({ ...screen, shown: 0 }, live, iconOf)).shown).toBe(1);
    });

    it("forgets a panel that closed from the panels on screen (#1861)", () => {
        const two: ScreenDescription = { ...screen, front: "companion", shown: 2 };
        const cube = cubeOf(screenGlyphIcons(two, ["agent", "companion"], iconOf));
        expect(cube).toMatchObject({ id: "companion", shown: 1, count: 1 });
    });

    it("keeps at most three marks: the fixed zone gives way so the cube always shows", () => {
        const wide: ScreenDescription = {
            fixed: ["agent", "term", "review"],
            carpet: ["page"],
            front: "page",
            shown: 1,
        };
        const icons = screenGlyphIcons(wide, ["agent", "term", "review", "page"], iconOf);
        expect(icons.slice(0, 2)).toEqual(["robot", "terminal"]);
        expect(isGlyphCube(icons[2])).toBe(true);
        expect(icons).toHaveLength(3);
    });

    it("forgets panels that closed since the description was written", () => {
        const icons = screenGlyphIcons(screen, ["agent", "companion"], iconOf);
        expect(cubeOf(icons)).toMatchObject({ id: "companion", count: 1, index: 0 });
        expect(screenGlyphIcons(screen, ["companion", "page"], iconOf)).toHaveLength(1);
    });

    it("goes back to the panels' icons once no carpet panel is left", () => {
        expect(screenGlyphIcons(screen, ["agent"], iconOf)).toBeNull();
        expect(screenGlyphIcons(null, live, iconOf)).toBeNull();
    });

    it("leaves a grid view as it is: one icon per panel, no cube", () => {
        const grid = viewGlyphIcons(null, ["robot", "globe"]);
        expect(grid).toEqual(["robot", "globe"]);
        expect(grid.some(isGlyphCube)).toBe(false);
    });

    it("lets a chosen icon win over the cube", () => {
        const cube = screenGlyphIcons(screen, live, iconOf);
        expect(viewGlyphIcons("rocket", cube)).toEqual(["rocket"]);
    });
});

describe("readScreen and sameScreen", () => {
    const screen: ScreenDescription = { fixed: ["a"], carpet: ["b", "c"], front: "c", shown: 1 };

    it("reads what the tab's meta holds and nothing else", () => {
        expect(readScreen({ ...screen })).toEqual(screen);
        expect(readScreen(null)).toBeNull();
        expect(readScreen("page")).toBeNull();
        expect(readScreen({ fixed: [], carpet: [], front: "x" })).toBeNull();
        expect(readScreen({ fixed: ["a"], carpet: ["b", 3], front: "b" })).toBeNull();
        expect(readScreen({ fixed: ["a"], carpet: ["b"] })).toBeNull();
    });

    it("reads how many carpet panels are on screen, one for a description written without it (#1861)", () => {
        expect(readScreen({ ...screen, shown: 3 }).shown).toBe(3);
        expect(readScreen({ fixed: ["a"], carpet: ["b", "c"], front: "c" }).shown).toBe(1);
        expect(readScreen({ ...screen, shown: 0 }).shown).toBe(1);
        expect(readScreen({ ...screen, shown: 1.5 }).shown).toBe(1);
        expect(readScreen({ ...screen, shown: "2" }).shown).toBe(1);
    });

    it("compares descriptions by their panels, their front and how many are on screen", () => {
        expect(sameScreen(screen, { ...screen, carpet: [...screen.carpet] })).toBe(true);
        expect(sameScreen(screen, { ...screen, shown: 2 })).toBe(false);
        expect(sameScreen(screen, { ...screen, front: "b" })).toBe(false);
        expect(sameScreen(screen, { ...screen, carpet: ["b"] })).toBe(false);
        expect(sameScreen(screen, null)).toBe(false);
        expect(sameScreen(null, null)).toBe(true);
    });
});
