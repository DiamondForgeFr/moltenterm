// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    accentForeground,
    applyAccent,
    contrastRatio,
    focusRingColor,
    FocusRingMinContrast,
    gradientForeground,
    mixColor,
    normaliseColourChoice,
    parseColor,
    workspaceColourStops,
    WorkspaceGradientMetaKey,
} from "./accent";

function fakeStyle() {
    const props: Record<string, string> = {};
    return { props, setProperty: (name: string, value: string) => void (props[name] = value) };
}

describe("parseColor", () => {
    it.each([
        ["#58C142", { r: 88, g: 193, b: 66 }],
        ["#fff", { r: 255, g: 255, b: 255 }],
        ["rgb(88, 193, 66)", { r: 88, g: 193, b: 66 }],
        ["rgba(1,2,3,0.5)", { r: 1, g: 2, b: 3 }],
    ])("parses %s", (input, want) => expect(parseColor(input)).toEqual(want));

    it.each([null, "", "green", "#12345"])("rejects %s", (input) => expect(parseColor(input)).toBeNull());
});

describe("accentForeground", () => {
    // Wave's workspace colours, from FlagColors in frontend/app/tab/tabcontextmenu.ts
    it.each([
        ["#58C142", "#000000"],
        ["#00FFDB", "#000000"],
        ["#429DFF", "#000000"],
        ["#BF55EC", "#000000"],
        ["#FF453A", "#000000"],
        ["#FF9500", "#000000"],
        ["#FFE900", "#000000"],
        ["#1E3A8A", "#ffffff"],
    ])("picks a readable text colour on %s", (accent, want) => {
        const rgb = parseColor(accent);
        expect(accentForeground(rgb)).toBe(want);
        expect(contrastRatio(rgb, parseColor(want))).toBeGreaterThanOrEqual(4.5);
    });
});

describe("applyAccent", () => {
    it("sets the accent and its text colour, the gradient's stops the same colour", () => {
        const style = fakeStyle();
        applyAccent("#BF55EC", style);
        expect(style.props).toEqual({
            "--mt-accent": "rgb(191, 85, 236)",
            "--mt-accent-mid": "rgb(191, 85, 236)",
            "--mt-accent-end": "rgb(191, 85, 236)",
            "--mt-accent-fg": "#000000",
            "--mt-focus-ring": "rgb(191, 85, 236)",
        });
    });

    it("falls back to MoltenTerm's orange for a workspace without a colour", () => {
        const style = fakeStyle();
        applyAccent(undefined, style);
        expect(style.props).toEqual({
            "--mt-accent": "rgb(255, 124, 13)",
            "--mt-accent-mid": "rgb(255, 124, 13)",
            "--mt-accent-end": "rgb(255, 124, 13)",
            "--mt-accent-fg": "#000000",
            "--mt-focus-ring": "rgb(255, 124, 13)",
        });
    });

    it("keeps the first stop of a gradient as the accent, with its text colour (#657 AC3)", () => {
        const style = fakeStyle();
        applyAccent("#00ffdb", style, ["#00ffdb", "#429dff"]);
        expect(style.props).toEqual({
            "--mt-accent": "rgb(0, 255, 219)",
            "--mt-accent-mid": "rgb(33, 206, 237)",
            "--mt-accent-end": "rgb(66, 157, 255)",
            "--mt-accent-fg": "#000000",
            "--mt-focus-ring": "rgb(0, 255, 219)",
        });
        applyAccent("#ffc53d", style, ["#ffc53d", "#ff7c0d", "#ff453a"]);
        expect(style.props["--mt-accent-mid"]).toBe("rgb(255, 124, 13)");
        expect(style.props["--mt-accent-end"]).toBe("rgb(255, 69, 58)");
    });
});

describe("focus ring (#751)", () => {
    const panel = { r: 60, g: 60, b: 60 };

    it("is the accent itself when it reads on the panels", () => {
        for (const accent of ["#ff7c0d", "#00ffdb", "#58c142", "#ffc53d"]) {
            expect(focusRingColor(parseColor(accent))).toEqual(parseColor(accent));
        }
    });

    it("lightens a dark accent until it reads at 3:1 on the lightest panel", () => {
        for (const accent of ["#1e3a8a", "#7f1d1d", "#3e2c8c", "#000000", "#4b5563"]) {
            const ring = focusRingColor(parseColor(accent));
            expect(contrastRatio(ring, panel)).toBeGreaterThanOrEqual(FocusRingMinContrast);
            expect(ring).not.toEqual({ r: 255, g: 255, b: 255 });
        }
    });

    it("is set with the accent", () => {
        const style = fakeStyle();
        applyAccent("#1e3a8a", style);
        const ring = parseColor(style.props["--mt-focus-ring"]);
        expect(contrastRatio(ring, panel)).toBeGreaterThanOrEqual(FocusRingMinContrast);
        applyAccent("#00ffdb", style);
        expect(style.props["--mt-focus-ring"]).toBe("rgb(0, 255, 219)");
    });
});

describe("gradientForeground (#657 AC5)", () => {
    it("is the accent's text colour for one stop", () => {
        expect(gradientForeground([parseColor("#1E3A8A")])).toBe("#ffffff");
        expect(gradientForeground([parseColor("#FFE900")])).toBe("#000000");
    });

    it("picks the text colour with the better worst case over every stop", () => {
        // Black reads on the yellow, white on the navy: across both, the worst case decides.
        const stops = ["#ffe900", "#1e3a8a"].map(parseColor);
        const fg = gradientForeground(stops);
        const other = fg === "#000000" ? "#ffffff" : "#000000";
        const worst = (c: string) => Math.min(...stops.map((s) => contrastRatio(s, parseColor(c))));
        expect(worst(fg)).toBeGreaterThanOrEqual(worst(other));
        expect(gradientForeground(["#00ffdb", "#429dff"].map(parseColor))).toBe("#000000");
        expect(gradientForeground(["#1e3a8a", "#4c1d95"].map(parseColor))).toBe("#ffffff");
    });
});

describe("workspace colour storage (#657 AC4)", () => {
    it("normalises a choice of 1-3 hex stops", () => {
        expect(normaliseColourChoice("#429DFF")).toBe("#429dff");
        expect(normaliseColourChoice(" #fff , #00FFDB ")).toBe("#ffffff,#00ffdb");
        expect(normaliseColourChoice("#a,#b,#c,#d")).toBe("");
        expect(normaliseColourChoice("#aaa,#bbb,#ccc,#ddd")).toBe("");
        expect(normaliseColourChoice("green")).toBe("");
        expect(normaliseColourChoice(undefined)).toBe("");
    });

    it("keeps a flat colour from before gradients", () => {
        expect(workspaceColourStops({ color: "#58C142", meta: {} })).toEqual(["#58c142"]);
        expect(workspaceColourStops({ color: "#58C142" })).toEqual(["#58c142"]);
        expect(workspaceColourStops({ color: "" })).toEqual([]);
    });

    it("reads a gradient whose first stop is the colour", () => {
        const meta = { [WorkspaceGradientMetaKey]: "#00FFDB,#429dff" };
        expect(workspaceColourStops({ color: "#00ffdb", meta })).toEqual(["#00ffdb", "#429dff"]);
    });

    it("ignores a gradient left behind by a colour set elsewhere (Wave's switcher)", () => {
        const meta = { [WorkspaceGradientMetaKey]: "#00ffdb,#429dff" };
        expect(workspaceColourStops({ color: "#ff453a", meta })).toEqual(["#ff453a"]);
        expect(workspaceColourStops({ color: "#ff453a", meta: { [WorkspaceGradientMetaKey]: 42 } })).toEqual([
            "#ff453a",
        ]);
    });
});

describe("mixColor", () => {
    it("matches CSS color-mix in srgb", () => {
        const orange = parseColor("#FF7C0D");
        const grey = parseColor("rgb(31, 31, 31)");
        expect(mixColor(orange, grey, 0)).toEqual(grey);
        expect(mixColor(orange, grey, 100)).toEqual(orange);
        expect(mixColor(orange, grey, 4)).toEqual({ r: 40, g: 35, b: 30 });
    });
});
