// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    floorFromDraggedTerminals,
    fullWidthTerminals,
    MinFillPx,
    MinPanelPx,
    panelSizeKind,
    readPanelSizes,
    readTerminalFloor,
    rememberedPanelPx,
    rememberPanelSize,
    shareRoom,
    sizesForRememberedPanel,
    terminalNeedPx,
} from "./panel-size-model";

// Size units per pixel of a parent whose children are `sizes` over `px` pixels.
function ratioOf(sizes: number[], px: number): number {
    return sizes.reduce((a, b) => a + b, 0) / px;
}

function toPx(sizes: number[], px: number): number[] {
    const total = sizes.reduce((a, b) => a + b, 0);
    return sizes.map((s) => Math.round((s / total) * px));
}

describe("panelSizeKind", () => {
    it("remembers side panels by their view", () => {
        expect(panelSizeKind("molten-companion")).toBe("molten-companion");
        expect(panelSizeKind("molten-browser")).toBe("molten-browser");
        expect(panelSizeKind("molten-review")).toBe("molten-review");
        expect(panelSizeKind("preview")).toBe("preview");
    });

    it("never sizes terminals and the Project view from memory", () => {
        expect(panelSizeKind("term")).toBeNull();
        expect(panelSizeKind("molten-project")).toBeNull();
        expect(panelSizeKind("molten-timeline")).toBeNull();
        expect(panelSizeKind("")).toBeNull();
        expect(panelSizeKind(null)).toBeNull();
    });
});

describe("size memory", () => {
    it("keeps one size per kind and axis, rounded", () => {
        let sizes = rememberPanelSize({}, "molten-companion", "width", 420.6);
        sizes = rememberPanelSize(sizes, "molten-companion", "height", 300);
        sizes = rememberPanelSize(sizes, "molten-browser", "width", 800);
        sizes = rememberPanelSize(sizes, "molten-companion", "width", 380);
        expect(sizes).toEqual({
            "molten-companion": { width: 380, height: 300 },
            "molten-browser": { width: 800 },
        });
        expect(rememberedPanelPx(sizes, "molten-companion", "width")).toBe(380);
        expect(rememberedPanelPx(sizes, "molten-browser", "height")).toBeNull();
        expect(rememberedPanelPx(sizes, "preview", "width")).toBeNull();
    });

    it("ignores a size that is not a positive number", () => {
        expect(rememberPanelSize({}, "molten-companion", "width", 0)).toEqual({});
        expect(rememberPanelSize({}, "molten-companion", "width", NaN)).toEqual({});
        expect(rememberPanelSize({}, null, "width", 300)).toEqual({});
    });

    it("reads only well-formed entries from the meta", () => {
        expect(readPanelSizes(null)).toEqual({});
        expect(readPanelSizes("x")).toEqual({});
        expect(readPanelSizes([1])).toEqual({});
        expect(
            readPanelSizes({
                a: { width: 400 },
                b: { width: -1, height: "300" },
                c: null,
                d: { height: 200, extra: 1 },
            })
        ).toEqual({ a: { width: 400 }, d: { height: 200 } });
    });
});

describe("shareRoom", () => {
    it("shares in proportion when every share is above the minimum", () => {
        expect(shareRoom([1, 3], 1000, 100)).toEqual([250, 750]);
    });

    it("raises a short share to the minimum and shares the rest", () => {
        expect(shareRoom([1, 9], 1000, 320)).toEqual([320, 680]);
    });

    it("shares evenly when the room is below the minimums", () => {
        expect(shareRoom([1, 9], 400, 320)).toEqual([200, 200]);
    });
});

describe("sizesForRememberedPanel", () => {
    it("gives a reopened companion its remembered width beside the terminal", () => {
        const sizes = [10, 10];
        const ratio = ratioOf(sizes, 1600);
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: true },
                { size: 10, fill: false },
            ],
            1,
            420,
            ratio
        );
        expect(toPx(next, 1600)).toEqual([1180, 420]);
        expect(next.every((s) => s >= 0 && s <= 100)).toBe(true);
    });

    it("keeps other remembered panels and takes the room from the terminal", () => {
        const sizes = [20, 10, 10];
        const ratio = ratioOf(sizes, 2000);
        // terminal 1000px, browser 500px, new companion 500px
        const next = sizesForRememberedPanel(
            [
                { size: 20, fill: true },
                { size: 10, fill: false },
                { size: 10, fill: false },
            ],
            2,
            300,
            ratio
        );
        expect(toPx(next, 2000)).toEqual([1200, 500, 300]);
    });

    it("shares the room between filling siblings in proportion", () => {
        const next = sizesForRememberedPanel(
            [
                { size: 30, fill: true },
                { size: 10, fill: true },
                { size: 10, fill: false },
            ],
            2,
            200,
            ratioOf([30, 10, 10], 2000)
        );
        expect(toPx(next, 2000)).toEqual([1350, 450, 200]);
    });

    it("clamps a size that does not fit so the terminal keeps its minimum", () => {
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: true },
                { size: 10, fill: false },
            ],
            1,
            2000,
            ratioOf([10, 10], 800)
        );
        expect(toPx(next, 800)).toEqual([MinFillPx, 800 - MinFillPx]);
    });

    it("keeps every filling sibling at its minimum when clamped, not a proportional sliver", () => {
        // terminal 300px, other panel 450px, group 1200px; a new panel remembered at 5000px
        const sizes = [300, 450, 1200, 10];
        const next = sizesForRememberedPanel(
            [
                { size: 300, fill: true },
                { size: 450, fill: false },
                { size: 1200, fill: true },
                { size: 10, fill: false },
            ],
            3,
            5000,
            ratioOf(sizes, 1960)
        );
        expect(toPx(next, 1960)).toEqual([MinFillPx, 450, MinFillPx, 1960 - 450 - 2 * MinFillPx]);
    });

    it("leaves the remembered value untouched by the clamp", () => {
        const sizes = rememberPanelSize({}, "molten-companion", "width", 2000);
        sizesForRememberedPanel(
            [
                { size: 10, fill: true },
                { size: 10, fill: false },
            ],
            1,
            rememberedPanelPx(sizes, "molten-companion", "width"),
            ratioOf([10, 10], 800)
        );
        expect(rememberedPanelPx(sizes, "molten-companion", "width")).toBe(2000);
    });

    it("does not go below the smallest panel", () => {
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: true },
                { size: 10, fill: false },
            ],
            1,
            5,
            ratioOf([10, 10], 1000)
        );
        expect(toPx(next, 1000)).toEqual([1000 - MinPanelPx, MinPanelPx]);
    });

    it("lets every other panel give way when none fills", () => {
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: false },
                { size: 10, fill: false },
            ],
            1,
            600,
            ratioOf([10, 10], 1000)
        );
        expect(toPx(next, 1000)).toEqual([400, 600]);
    });

    it("gives up when the window is too small for any panel", () => {
        expect(
            sizesForRememberedPanel(
                [
                    { size: 10, fill: true },
                    { size: 10, fill: false },
                ],
                1,
                300,
                ratioOf([10, 10], 340)
            )
        ).toBeNull();
    });

    it("needs a sibling, a ratio and a size", () => {
        expect(sizesForRememberedPanel([{ size: 10, fill: false }], 0, 300, 0.1)).toBeNull();
        expect(
            sizesForRememberedPanel(
                [
                    { size: 10, fill: true },
                    { size: 10, fill: false },
                ],
                1,
                300,
                0
            )
        ).toBeNull();
        expect(
            sizesForRememberedPanel(
                [
                    { size: 10, fill: true },
                    { size: 10, fill: false },
                ],
                1,
                null,
                0.01
            )
        ).toBeNull();
    });
});

function node(id: string, children?: LayoutNode[], dir = FlexDirection.Column): LayoutNode {
    return { id, flexDirection: dir, size: 10, children, data: children ? undefined : { blockId: `b-${id}` } };
}

const isTerm = (n: LayoutNode) => n.id.startsWith("t");

describe("terminal floor (#731)", () => {
    it("reads a positive width, rounded, and nothing else", () => {
        expect(readTerminalFloor(900.4)).toBe(900);
        expect(readTerminalFloor(0)).toBeNull();
        expect(readTerminalFloor(-5)).toBeNull();
        expect(readTerminalFloor("900")).toBeNull();
        expect(readTerminalFloor(null)).toBeNull();
    });

    it("takes the smallest width a drag gave to the terminals it moved", () => {
        expect(floorFromDraggedTerminals([900.6])).toBe(901);
        expect(floorFromDraggedTerminals([1100, 480])).toBe(480);
        expect(floorFromDraggedTerminals([])).toBeNull();
        expect(floorFromDraggedTerminals([NaN, 0])).toBeNull();
    });

    it("finds the terminals whose width is the node's own, not those sharing a nested row", () => {
        expect(fullWidthTerminals(node("t1"), isTerm).map((n) => n.id)).toEqual(["t1"]);
        expect(fullWidthTerminals(node("browser"), isTerm)).toEqual([]);
        const stack = node("s", [node("t1"), node("x"), node("t2")]);
        expect(fullWidthTerminals(stack, isTerm).map((n) => n.id)).toEqual(["t1", "t2"]);
        const split = node("r", [node("t1"), node("t2")], FlexDirection.Row);
        expect(fullWidthTerminals(split, isTerm)).toEqual([]);
    });

    it("needs the floor per terminal side by side, the largest among stacked ones", () => {
        expect(terminalNeedPx(node("t1"), 900, isTerm)).toBe(900);
        expect(terminalNeedPx(node("x"), 900, isTerm)).toBe(0);
        expect(terminalNeedPx(node("t1"), null, isTerm)).toBe(0);
        const group = node("s", [node("r", [node("t1"), node("t2")], FlexDirection.Row), node("t3")]);
        expect(terminalNeedPx(group, 500, isTerm)).toBe(1000);
    });

    it("AC2: a terminal at a 900 px floor stays at 900 px, the new panel shrinks to what is left", () => {
        // terminal 1500px alone, a browser remembered at 900px opens beside it in a 1500px row
        const sizes = [10, 10];
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: true, minPx: 900 },
                { size: 10, fill: false },
            ],
            1,
            900,
            ratioOf(sizes, 1500)
        );
        expect(toPx(next, 1500)).toEqual([900, 600]);
    });

    it("lets the terminal grow above its floor when there is room", () => {
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: true, minPx: 900 },
                { size: 10, fill: false },
            ],
            1,
            400,
            ratioOf([10, 10], 2000)
        );
        expect(toPx(next, 2000)).toEqual([1600, 400]);
    });

    it("keeps every terminal's floor and shares the rest in proportion", () => {
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: true, minPx: 700 },
                { size: 30, fill: true, minPx: 700 },
                { size: 10, fill: false },
            ],
            2,
            1000,
            ratioOf([10, 30, 10], 2000)
        );
        expect(toPx(next, 2000)).toEqual([700, 700, 600]);
    });

    it("drops the floor for this layout when not even the smallest panel fits beside it", () => {
        const next = sizesForRememberedPanel(
            [
                { size: 10, fill: true, minPx: 1000 },
                { size: 10, fill: false },
            ],
            1,
            600,
            ratioOf([10, 10], 1020)
        );
        expect(toPx(next, 1020)).toEqual([420, 600]);
        const clamped = sizesForRememberedPanel(
            [
                { size: 10, fill: true, minPx: 1000 },
                { size: 10, fill: false },
            ],
            1,
            900,
            ratioOf([10, 10], 1020)
        );
        expect(toPx(clamped, 1020)).toEqual([MinFillPx, 1020 - MinFillPx]);
    });

    it("shares the room with one minimum per share, scaled down together when the room is short", () => {
        expect(shareRoom([1, 1], 1000, [700, 200])).toEqual([700, 300]);
        expect(shareRoom([1, 1], 800, [900, 100])).toEqual([720, 80]);
    });
});
