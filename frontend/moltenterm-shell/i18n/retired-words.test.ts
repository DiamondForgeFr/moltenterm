// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One word per object (FR-SHELL-093, #1322): the names from before Spaces are retired, in the dictionaries of both
// languages. A value that uses one fails here, unless its key sits in Allowed with the reason. A new language pack is
// not held to this: only the two shipped dictionaries are.

import { describe, expect, it } from "vitest";
import { flattenKeys, resolveKey, shippedDictionary } from "./i18n-core";

type Retired = { id: string; words: RegExp; use: string };

// Lookbehinds keep a key's own name in a placeholder ({tab}, {workspace}) out of the match: placeholders are stripped
// before the test, so they are never read as words.
export const RetiredWords: Record<string, Retired[]> = {
    en: [
        { id: "tab", words: /(?<![+\w])tabs?(?![\w])/i, use: "view" },
        { id: "mission-control", words: /mission control/i, use: "Project (the panel)" },
        { id: "rail", words: /\brail\b/i, use: "sidebar" },
        { id: "widget", words: /\bwidgets?\b/i, use: "tool" },
        { id: "browser-panel", words: /\bbrowser (panel|pane)\b/i, use: "Web page" },
        { id: "map-of-lines", words: /\bmaps? of lines\b/i, use: "Line map" },
    ],
    fr: [
        { id: "onglet", words: /\bonglets?\b/i, use: "vue" },
        { id: "workspace", words: /\bworkspaces?\b/i, use: "espace de travail" },
        { id: "mission-control", words: /mission control/i, use: "Projet (le panneau)" },
        { id: "rail", words: /\brail\b/i, use: "barre latérale" },
        { id: "widget", words: /\bwidgets?\b/i, use: "outil" },
        { id: "navigateur-panel", words: /\bpanneaux? (de )?navigateur\b/i, use: "Page web" },
        { id: "carte-des-lignes", words: /\bcartes? des lignes\b/i, use: "Plan de lignes" },
        { id: "plan-de-ligne", words: /\bplans? de ligne\b/i, use: "Plan de lignes" },
        { id: "review", words: /\breview\b/i, use: "Revue" },
    ],
};

// A key's prefix or whole name, the rules it may break and why. Keep it short: each line is a place the word is right.
export const Allowed: { key: RegExp; rules: string[]; reason: string }[] = [
    {
        key: /^(browser|cmdpanel\.browser|server\.browser)\.|^shortcuts\.items\.browser-/,
        rules: ["tab", "onglet"],
        reason: "tabs of the Web page panel are a browser's tabs, a different object from a view",
    },
    { key: /^shortcuts\.keys\.tab$/, rules: ["tab", "onglet"], reason: "the Tab key" },
    { key: /^rail\.tools\.editWidgets$/, rules: ["widget"], reason: "names the widgets.json file" },
    {
        key: /^review\.publish\.sheet\.languageSource\.setting$/,
        rules: ["review"],
        reason: "names the review:publishlanguage setting",
    },
];

export function retiredWordProblems(lang: string, entries: [string, string][]): string[] {
    const rules = RetiredWords[lang] ?? [];
    const problems: string[] = [];
    for (const [key, text] of entries) {
        const words = text.replace(/\{[^}]*\}/g, "");
        for (const rule of rules) {
            if (!rule.words.test(words)) {
                continue;
            }
            if (Allowed.some((a) => a.key.test(key) && a.rules.includes(rule.id))) {
                continue;
            }
            problems.push(`${lang} ${key}: "${rule.id}" is retired, say ${rule.use}: ${text}`);
        }
    }
    return problems;
}

describe("retired words (#1322)", () => {
    it("catches each retired word, in its language", () => {
        expect(retiredWordProblems("fr", [["a", "Nouvel onglet"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["a", "Tous les workspaces"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["a", "Connecter à Mission Control"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["a", "Dans le rail"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["a", "Carte des lignes"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["a", "Plan de ligne"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["a", "Review #17"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["a", "Le panneau navigateur"]])).toHaveLength(1);
        expect(retiredWordProblems("en", [["a", "Close the tab"]])).toHaveLength(1);
        expect(retiredWordProblems("en", [["a", "Open Mission Control"]])).toHaveLength(1);
        expect(retiredWordProblems("en", [["a", "In the rail"]])).toHaveLength(1);
        expect(retiredWordProblems("en", [["a", "Rail widgets"]])).toHaveLength(2);
        expect(retiredWordProblems("en", [["a", "The browser panel"]])).toHaveLength(1);
    });

    it("accepts the current words", () => {
        expect(retiredWordProblems("fr", [["a", "Nouvelle vue dans cet espace de travail"]])).toEqual([]);
        expect(retiredWordProblems("fr", [["a", "Le panneau Projet et le Plan de lignes"]])).toEqual([]);
        expect(retiredWordProblems("fr", [["a", "Revue #17 (« Reviewed by »)"]])).toEqual([]);
        expect(retiredWordProblems("en", [["a", "A view in this workspace; Sent Shift+Tab once"]])).toEqual([]);
        expect(retiredWordProblems("en", [["a", "The Web page panel and the Line map"]])).toEqual([]);
    });

    it("reads a placeholder's name as no word", () => {
        expect(retiredWordProblems("en", [["a", "{tab} in {workspace}"]])).toEqual([]);
        expect(retiredWordProblems("fr", [["a", "{tabs} dans {workspace}"]])).toEqual([]);
    });

    it("lets an allowed key keep the word, and only for the rules it names", () => {
        expect(retiredWordProblems("en", [["browser.tabs.newTab", "New tab"]])).toEqual([]);
        expect(retiredWordProblems("fr", [["browser.tabs.close", "Fermer l'onglet"]])).toEqual([]);
        expect(retiredWordProblems("fr", [["appMenu.reloadView", "Recharger l'onglet"]])).toHaveLength(1);
        expect(retiredWordProblems("fr", [["browser.share.x", "Le workspace"]])).toHaveLength(1);
        expect(retiredWordProblems("en", [["shortcuts.keys.tab", "Tab"]])).toEqual([]);
    });

    it("keeps every allowed line honest: it covers a key that still holds the word", () => {
        const used = new Set<number>();
        for (const lang of ["en", "fr"]) {
            const dict = shippedDictionary(lang);
            for (const key of flattenKeys(dict)) {
                const text = resolveKey(dict, key).replace(/\{[^}]*\}/g, "");
                for (const rule of RetiredWords[lang]) {
                    if (!rule.words.test(text)) {
                        continue;
                    }
                    Allowed.forEach((a, i) => {
                        if (a.key.test(key) && a.rules.includes(rule.id)) {
                            used.add(i);
                        }
                    });
                }
            }
        }
        const unused = Allowed.filter((_, i) => !used.has(i)).map((a) => a.key.source);
        expect(unused).toEqual([]);
    });

    for (const lang of ["en", "fr"]) {
        it(`${lang}.json uses no retired word`, () => {
            const dict = shippedDictionary(lang);
            const entries = flattenKeys(dict).map((k) => [k, resolveKey(dict, k)] as [string, string]);
            expect(retiredWordProblems(lang, entries)).toEqual([]);
        });
    }
});
