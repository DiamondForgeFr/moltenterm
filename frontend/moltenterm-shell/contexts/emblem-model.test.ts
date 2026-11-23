// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { EmblemColumns, gridMove, matchEmblems, SuggestedEmblems } from "./emblem-model";

const names = [
    "book",
    "book-open",
    "book-open-check",
    "bookmark",
    "briefcase",
    "building-2",
    "hammer",
    "notebook",
    "library-big",
    "a-arrow-down",
];

describe("the emblem search", () => {
    it("opens on the suggestions the catalog has", () => {
        const found = matchEmblems(names, "");
        expect(found.shown).toEqual(["briefcase", "building-2", "hammer", "book-open"]);
        expect(found.hidden).toBe(0);
        expect(matchEmblems(names, "   ").shown).toEqual(found.shown);
        expect(SuggestedEmblems.every((name) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name))).toBe(true);
    });

    it("finds the names that hold the typed word, the exact name and the ones that start with it first", () => {
        expect(matchEmblems(names, "book").shown).toEqual([
            "book",
            "bookmark",
            "book-open",
            "book-open-check",
            "notebook",
        ]);
    });

    it("needs every word of the query, in any order and case, with a space or a hyphen between them", () => {
        expect(matchEmblems(names, "open BOOK").shown).toEqual(["book-open", "book-open-check"]);
        expect(matchEmblems(names, "book-open").shown).toEqual(["book-open", "book-open-check"]);
        expect(matchEmblems(names, "zzz").shown).toEqual([]);
    });

    it("keeps to a limit and says how many it left out", () => {
        const many = Array.from({ length: 200 }, (_, i) => `icon-${String(i).padStart(3, "0")}`);
        const found = matchEmblems(many, "icon", 96);
        expect(found.shown).toHaveLength(96);
        expect(found.hidden).toBe(104);
    });
});

describe("the grid's keys", () => {
    const count = 20;

    it("moves along the list, around the ends", () => {
        expect(gridMove(3, "ArrowRight", EmblemColumns, count)).toBe(4);
        expect(gridMove(19, "ArrowRight", EmblemColumns, count)).toBe(0);
        expect(gridMove(0, "ArrowLeft", EmblemColumns, count)).toBe(19);
    });

    it("moves by a row and stays at the first and last rows", () => {
        expect(gridMove(3, "ArrowDown", EmblemColumns, count)).toBe(11);
        expect(gridMove(15, "ArrowDown", EmblemColumns, count)).toBe(15);
        expect(gridMove(11, "ArrowUp", EmblemColumns, count)).toBe(3);
        expect(gridMove(3, "ArrowUp", EmblemColumns, count)).toBe(3);
    });

    it("goes to the ends and leaves other keys alone", () => {
        expect(gridMove(7, "Home", EmblemColumns, count)).toBe(0);
        expect(gridMove(7, "End", EmblemColumns, count)).toBe(19);
        expect(gridMove(7, "x", EmblemColumns, count)).toBeNull();
        expect(gridMove(0, "ArrowRight", EmblemColumns, 0)).toBeNull();
    });
});
