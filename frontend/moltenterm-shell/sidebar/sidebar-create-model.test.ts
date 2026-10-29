// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isRedColour, PresetColourChoices, ShortPaletteColours } from "../workspace-colour";
import { CreateColours, freshColour, logoDefaultColour, makeCreateDraft, shortRow } from "./sidebar-create-model";

describe("new workspace colour (FR-SHELL-102)", () => {
    it("takes its short row from the sheet's palette", () => {
        expect(CreateColours).toBe(ShortPaletteColours);
        expect(CreateColours).toHaveLength(10);
        CreateColours.forEach((c) => expect(PresetColourChoices).toContain(c));
    });

    it("never defaults to red, even when every other colour is taken", () => {
        expect(makeCreateDraft("").colour).toBe("#ff7c0d");
        expect(isRedColour(freshColour([], 0))).toBe(false);
        for (let count = 0; count < 25; count++) {
            expect(isRedColour(freshColour(CreateColours, count))).toBe(false);
        }
    });

    it("takes the first free colour that is not red", () => {
        expect(freshColour(["#FF7C0D"], 1)).toBe("#ffc53d");
    });

    it("tells red and coral from pink, rose and orange", () => {
        expect(isRedColour("#ff453a")).toBe(true);
        expect(isRedColour("#ff6f61")).toBe(true);
        expect(isRedColour("#ff5fb8")).toBe(false);
        expect(isRedColour("#ff8fab")).toBe(false);
        expect(isRedColour("#ff7c0d")).toBe(false);
        expect(isRedColour("#9fb1c8")).toBe(false);
        expect(isRedColour("#ffc53d,#ff7c0d,#ff453a")).toBe(false);
    });

    it("takes the logo's dominant colour, and leads the short row with it", () => {
        expect(logoDefaultColour(["#1E88E5", "#FFC107"])).toBe("#1e88e5");
        expect(logoDefaultColour([])).toBe("");
        expect(shortRow(["#1e88e5"])).toEqual(["#1e88e5", ...CreateColours]);
        expect(shortRow(["#429dff"])).toBe(CreateColours);
        expect(shortRow([])).toBe(CreateColours);
    });
});
