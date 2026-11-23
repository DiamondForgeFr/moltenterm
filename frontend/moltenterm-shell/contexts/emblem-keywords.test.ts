// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { DefaultContextEmblem, FallbackContextEmblem } from "./context-model";
import { EmblemCatalog } from "./emblem-catalog";
import { EmblemKeywords } from "./emblem-keywords";
import { matchEmblems, plainText } from "./emblem-model";

const Names = Object.keys(EmblemCatalog);
const find = (query: string) => matchEmblems(Names, query, 500, EmblemKeywords).shown;

// What a developer types to name an activity, in either interface language, and an icon it must find.
const Activities: [english: string, french: string, expects: string[]][] = [
    ["work", "travail", ["briefcase"]],
    ["company", "entreprise", ["building-2", "factory"]],
    ["home", "maison", ["house"]],
    ["family", "famille", ["users", "baby"]],
    ["writing", "écriture", ["pen", "notebook-pen", "feather"]],
    ["book", "livre", ["book-open"]],
    ["novel", "roman", ["book"]],
    ["health", "santé", ["stethoscope", "heart-pulse"]],
    ["sport", "sport", ["dumbbell", "trophy"]],
    ["music", "musique", ["music", "guitar"]],
    ["travel", "voyage", ["plane", "luggage"]],
    ["learning", "apprentissage", ["graduation-cap", "book-open"]],
    ["finance", "argent", ["wallet", "coins", "banknote"]],
    ["code", "développement", ["code-xml", "terminal"]],
    ["design", "graphisme", ["palette", "pen-tool"]],
    ["science", "recherche", ["flask-conical", "atom", "microscope"]],
    ["game", "jeu", ["gamepad-2"]],
    ["garden", "jardin", ["flower", "sprout"]],
    ["project", "projet", ["kanban", "target"]],
    ["security", "sécurité", ["shield", "lock"]],
];

// FR-SHELL-158: the picker's search feels complete for the activities a context is made of.
describe("the emblem search by activity", () => {
    it.each(Activities)("finds %s (and %s in French) among a real choice of icons", (english, french, expects) => {
        for (const query of [english, french]) {
            const found = find(query);
            expect(found.length, query).toBeGreaterThanOrEqual(6);
            for (const icon of expects) {
                expect(found, `${query} lacks ${icon}`).toContain(icon);
            }
        }
    });

    it("ignores accents and case in the query", () => {
        expect(find("ÉCRITURE")).toEqual(find("ecriture"));
        expect(plainText("Santé à l'école")).toBe("sante a l'ecole");
    });

    it("keeps the icons whose name matches before the ones only their words find", () => {
        const found = find("book");
        expect(found[0]).toBe("book");
        const wordOnly = found.indexOf("pen");
        expect(wordOnly).toBeGreaterThan(found.indexOf("book-open"));
    });

    it("still finds by an icon's own name", () => {
        expect(find("rocket")).toContain("rocket");
        expect(find("flask")).toEqual(expect.arrayContaining(["flask-conical", "flask-round"]));
    });

    it("needs every word of the query, in the name or in the words", () => {
        const found = find("music travel");
        expect(found.every((name) => !name.includes("zzz"))).toBe(true);
        expect(find("zzzz")).toEqual([]);
    });
});

describe("the words of the emblems", () => {
    it("name only icons the catalog holds", () => {
        expect(Object.keys(EmblemKeywords).filter((name) => !Names.includes(name))).toEqual([]);
    });

    it("are written without accents, in lower case", () => {
        const odd = Object.entries(EmblemKeywords).flatMap(([name, words]) =>
            words.filter((word) => word !== plainText(word)).map((word) => `${name}: ${word}`)
        );
        expect(odd).toEqual([]);
    });

    it("leave the fallback emblem a neutral folder, and the default context its hammer", () => {
        expect(FallbackContextEmblem).toBe("folder");
        expect(DefaultContextEmblem).toBe("hammer");
        expect(Names).toContain("folder");
    });
});
