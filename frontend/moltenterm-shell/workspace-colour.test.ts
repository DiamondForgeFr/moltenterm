// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, parseColor } from "./accent";
import {
    colourChoiceCss,
    colourChoiceForeground,
    colourChoiceName,
    logoColourChoices,
    parseCustomColour,
    PresetColourChoices,
    PresetGradientChoices,
} from "./workspace-colour";

const WorkspaceGo = readFileSync(join(__dirname, "../../pkg/wcore/workspace.go"), "utf8");
const WaveColours = [
    ...(/var WorkspaceColors = \[\.\.\.\]string\{([^}]*)\}/.exec(WorkspaceGo)?.[1] ?? "").matchAll(/"([^"]+)"/g),
].map((m) => m[1].toLowerCase());

// The window and sidebar's cast iron (tokens.css --mt-surface-0, FR-SHELL-115), where a workspace's dot is drawn.
const DarkPanel = parseColor("#141210");

describe("preset colours (#657 AC2)", () => {
    it("offers about 24 distinct colours, wavesrv's among them", () => {
        expect(PresetColourChoices).toHaveLength(24);
        expect(new Set(PresetColourChoices).size).toBe(24);
        expect(WaveColours).toHaveLength(7);
        for (const colour of WaveColours) {
            expect(PresetColourChoices).toContain(colour);
        }
    });

    it("are each named, and stand out on the dark theme (3:1, WCAG 1.4.11)", () => {
        for (const colour of PresetColourChoices) {
            expect(colourChoiceName(colour), colour).toMatch(/^[A-Z][a-z]+( [a-z]+)?$/);
            expect(contrastRatio(parseColor(colour), DarkPanel), colour).toBeGreaterThanOrEqual(3);
        }
    });

    it("comes with a few named gradients of 2-3 stops", () => {
        expect(PresetGradientChoices.length).toBeGreaterThanOrEqual(3);
        for (const gradient of PresetGradientChoices) {
            const stops = gradient.split(",");
            expect(stops.length).toBeGreaterThanOrEqual(2);
            expect(stops.length).toBeLessThanOrEqual(3);
            expect(colourChoiceName(gradient)).toMatch(/^[A-Z][a-z]+$/);
            for (const stop of stops) {
                expect(contrastRatio(parseColor(stop), DarkPanel), stop).toBeGreaterThanOrEqual(3);
            }
        }
    });
});

describe("colour choices", () => {
    it("names an unknown colour by its value and an unknown gradient by its ends", () => {
        expect(colourChoiceName("#123456")).toBe("#123456");
        expect(colourChoiceName("#ff453a,#123456")).toBe("Gradient from Red to #123456");
        expect(colourChoiceName("")).toBe("No colour");
    });

    it("paints a colour flat and a gradient as a linear gradient", () => {
        expect(colourChoiceCss("#429DFF")).toBe("#429dff");
        expect(colourChoiceCss("#00ffdb,#429dff")).toBe("linear-gradient(135deg, #00ffdb, #429dff)");
        expect(colourChoiceCss("#00ffdb,#429dff", "to bottom")).toBe("linear-gradient(to bottom, #00ffdb, #429dff)");
    });

    it("draws the check mark in the colour that reads over the whole swatch (#657 AC5)", () => {
        expect(colourChoiceForeground("#ffe900")).toBe("#000000");
        expect(colourChoiceForeground("#1e3a8a,#4c1d95")).toBe("#ffffff");
    });

    it("takes a custom hex value, with or without #", () => {
        expect(parseCustomColour("#AABBCC")).toBe("#aabbcc");
        expect(parseCustomColour("aabbcc")).toBe("#aabbcc");
        expect(parseCustomColour("#abc")).toBe("#aabbcc");
        expect(parseCustomColour("#ab")).toBe("");
        expect(parseCustomColour("#aa,#bb")).toBe("");
        expect(parseCustomColour("")).toBe("");
    });
});

describe("logo colour choices (#657 AC1)", () => {
    it("offers each colour, then a gradient of the first two and one of the first three", () => {
        expect(logoColourChoices(["#E34F26", "#1572B6", "#F0DB4F", "#22AA66"])).toEqual([
            "#e34f26",
            "#1572b6",
            "#f0db4f",
            "#22aa66",
            "#e34f26,#1572b6",
            "#e34f26,#1572b6,#f0db4f",
        ]);
    });

    it("offers one gradient for two colours and none for one", () => {
        expect(logoColourChoices(["#e34f26", "#1572b6"])).toEqual(["#e34f26", "#1572b6", "#e34f26,#1572b6"]);
        expect(logoColourChoices(["#e34f26"])).toEqual(["#e34f26"]);
        expect(logoColourChoices([])).toEqual([]);
        expect(logoColourChoices(null)).toEqual([]);
    });
});
