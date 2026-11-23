// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sidebar's three sections of views are named, and no text of the interface says "temporary" (FR-SHELL-080, #2484):
// Transversal views (the top row), Important views (the tiles), Views (the list under New view). The dictionaries of both
// languages are read whole, so a string that brings the word back fails here whichever surface it is on.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flattenKeys, resolveKey, shippedDictionary } from "../i18n/i18n-core";

const Temporary = /temporar(?:y|ily)|temporaire/i;

function texts(lang: string): [string, string][] {
    const dict = shippedDictionary(lang);
    return flattenKeys(dict).map((key) => [key, resolveKey(dict, key)] as [string, string]);
}

describe("no interface text says temporary (#2484)", () => {
    for (const lang of ["en", "fr"]) {
        it(`${lang}.json holds no value with the word`, () => {
            expect(texts(lang).filter(([, text]) => Temporary.test(text))).toEqual([]);
        });
    }

    it("keeps the word out of the shortcuts' own English labels and search words", () => {
        const registry = fs.readFileSync(path.join(__dirname, "../shortcuts/registry.ts"), "utf8");
        const shown = registry.split("\n").filter((line) => /^\s*(label|keywords):/.test(line));
        expect(shown.length).toBeGreaterThan(10);
        expect(shown.filter((line) => Temporary.test(line))).toEqual([]);
    });

    it("says Unpin where it said Make temporary, in both languages", () => {
        const en = shippedDictionary("en") as any;
        const fr = shippedDictionary("fr") as any;
        expect(en.sidebar.pins.menu.makeTemporary).toBe("Unpin");
        expect(fr.sidebar.pins.menu.makeTemporary).toBe("Désépingler");
        expect(en.palette.actions.makeViewTemporary).toBe("Unpin this view");
        expect(fr.palette.actions.makeViewTemporary).toBe("Désépingler cette vue");
        expect(en.sidebar.views.captionTemporary).toBe("Unpin it");
        expect(fr.sidebar.views.captionTemporary).toBe("La désépingler");
    });

    it("asks to close the views, naming what stays", () => {
        const en = shippedDictionary("en") as any;
        const fr = shippedDictionary("fr") as any;
        expect(en.shell.busy.clear.title).toBe("Close the views? Important views and folders stay");
        expect(fr.shell.busy.clear.title).toBe("Fermer les vues ? Les vues importantes et les dossiers restent");
        expect(en.sidebar.temporary.closeAllTitle).toContain("important views and folders stay");
        expect(fr.sidebar.temporary.closeAllTitle).toContain("les vues importantes et les dossiers restent");
    });

    it("tells a new view in the onboarding without the word", () => {
        expect(JSON.stringify(shippedDictionary("en"))).toContain("A new view lands in Views");
        expect(JSON.stringify(shippedDictionary("fr"))).toContain("Une nouvelle vue arrive dans Vues");
    });
});

describe("the three sections are named (#2484)", () => {
    it("names the top row Transversal views, the tiles Important views, the list Views", () => {
        const en = shippedDictionary("en") as any;
        const fr = shippedDictionary("fr") as any;
        expect(en.sidebar.pins.topRowLabel).toBe("Transversal views");
        expect(fr.sidebar.pins.topRowLabel).toBe("Vues transverses");
        expect(en.sidebar.tiles.label).toBe("Important views of {name}");
        expect(fr.sidebar.tiles.label).toBe("Vues importantes de {name}");
        expect(en.sidebar.temporary.sectionLabel).toBe("Views");
        expect(fr.sidebar.temporary.sectionLabel).toBe("Vues");
    });

    it("says only View where a label tells the section a view is in", () => {
        const en = shippedDictionary("en") as any;
        const fr = shippedDictionary("fr") as any;
        expect(en.sidebar.pins.menu.state.temporary).toBe("View");
        expect(fr.sidebar.pins.menu.state.temporary).toBe("Vue");
    });

    it("ships every folder text in both languages with the same placeholders", () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        const en = texts("en").filter(([key]) => key.startsWith("sidebar.folders."));
        const fr = new Map(texts("fr").filter(([key]) => key.startsWith("sidebar.folders.")));
        expect(en.length).toBeGreaterThan(25);
        expect(fr.size).toBe(en.length);
        for (const [key, text] of en) {
            expect(fr.has(key), key).toBe(true);
            expect(placeholders(fr.get(key)), key).toEqual(placeholders(text));
        }
    });

    it("names no machine or system in the folders' texts", () => {
        const os = /\b(mac|macos|finder|windows|explorer)\b/i;
        for (const lang of ["en", "fr"]) {
            const folderTexts = texts(lang).filter(([key]) => key.startsWith("sidebar.folders."));
            expect(
                folderTexts.filter(([, text]) => os.test(text)),
                lang
            ).toEqual([]);
        }
    });
});
