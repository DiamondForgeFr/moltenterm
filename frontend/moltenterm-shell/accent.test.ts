// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { accentForeground, applyAccent, contrastRatio, mixColor, parseColor } from "./accent";

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
    it("sets the accent and its text colour", () => {
        const style = fakeStyle();
        applyAccent("#BF55EC", style);
        expect(style.props).toEqual({ "--mt-accent": "rgb(191, 85, 236)", "--mt-accent-fg": "#000000" });
    });

    it("falls back to MoltenTerm's orange for a workspace without a colour", () => {
        const style = fakeStyle();
        applyAccent(undefined, style);
        expect(style.props).toEqual({ "--mt-accent": "rgb(255, 124, 13)", "--mt-accent-fg": "#000000" });
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
