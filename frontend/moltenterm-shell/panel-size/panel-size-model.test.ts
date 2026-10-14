// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    MinFillPx,
    MinPanelPx,
    panelSizeKind,
    readPanelSizes,
    rememberedPanelPx,
    rememberPanelSize,
    sizesForRememberedPanel,
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
            ratioOf([30, 10, 10], 1000)
        );
        expect(toPx(next, 1000)).toEqual([600, 200, 200]);
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
