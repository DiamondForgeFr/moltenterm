// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The search engines MoltenTerm offers (#2312, FR-SHELL-035): the presets, the recommended default, which preset a
// setting is, and when the one-time note about the default is due.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shippedDictionary } from "../i18n/i18n-core";
import {
    CustomEngineId,
    DefaultSearchTemplate,
    isSearchPage,
    presetOf,
    RecommendedEngineId,
    searchEngineInfo,
    SearchEnginePresets,
    searchNoteDue,
    searchUrl,
    usableTemplate,
} from "./search-engine-model";

const DefaultSettings = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/settings.json"), "utf8")
);

describe("the presets", () => {
    it("are the seven engines of the ticket, Brave Search first and the only recommended one", () => {
        expect(SearchEnginePresets.map((p) => p.name)).toEqual([
            "Brave Search",
            "DuckDuckGo",
            "Startpage",
            "Qwant",
            "Ecosia",
            "Google",
            "Bing",
        ]);
        expect(RecommendedEngineId).toBe("brave");
        expect(SearchEnginePresets[0].id).toBe(RecommendedEngineId);
    });

    it("each carry the words at {query}, on https, with a letter mark and a line in both languages", () => {
        const en = shippedDictionary("en") as any;
        const fr = shippedDictionary("fr") as any;
        for (const p of SearchEnginePresets) {
            expect(usableTemplate(p.template), p.id).toBe(true);
            expect(p.template.startsWith("https://"), p.id).toBe(true);
            expect(p.template.match(/\{query\}/g), p.id).toHaveLength(1);
            expect(p.letter, p.id).not.toBe("");
            expect(en.settings.searchEngine[p.id], p.id).toBeTruthy();
            expect(fr.settings.searchEngine[p.id], p.id).toBeTruthy();
        }
        expect(new Set(SearchEnginePresets.map((p) => p.letter)).size).toBe(SearchEnginePresets.length);
    });

    it("name Brave Search's reason: its own index, no tracking or profiling", () => {
        expect((shippedDictionary("en") as any).settings.searchEngine.brave).toBe(
            "Its own independent index, no tracking or profiling"
        );
    });
});

describe("the default", () => {
    it("is Brave Search, the one the default settings carry (a user's own value overrides it, never the reverse)", () => {
        expect(DefaultSearchTemplate).toBe(SearchEnginePresets[0].template);
        expect(DefaultSettings["web:defaultsearch"]).toBe(DefaultSearchTemplate);
    });

    it("searches the words with it when the setting says nothing usable", () => {
        for (const template of [null, undefined, "", "  ", "https://no-placeholder.dev/"]) {
            expect(searchUrl("a b", template)).toBe("https://search.brave.com/search?q=a%20b");
        }
    });
});

describe("presetOf and searchEngineInfo", () => {
    it("recognises a preset by its template, the legacy %s and spaces included", () => {
        expect(presetOf("https://duckduckgo.com/?q={query}")?.id).toBe("duckduckgo");
        expect(presetOf("  https://www.google.com/search?q=%s ")?.id).toBe("google");
        expect(presetOf("https://search.example.dev/?q={query}")).toBeNull();
    });

    it("names a custom engine by its site, without www", () => {
        expect(searchEngineInfo("https://www.search.example.dev/?q={query}")).toEqual({
            id: CustomEngineId,
            name: "search.example.dev",
            letter: "S",
        });
        expect(searchEngineInfo("https://www.google.com/search?q={query}")).toMatchObject({
            id: "google",
            name: "Google",
        });
    });

    it("marks a custom engine by its site's first letter, or a gap for an address of digits", () => {
        expect(searchEngineInfo("http://127.0.0.1:19312/search?q={query}")).toMatchObject({
            id: CustomEngineId,
            name: "127.0.0.1",
            letter: "…",
        });
    });

    it("reads an unusable template as the default engine, as the search does", () => {
        expect(searchEngineInfo("").id).toBe("brave");
        expect(searchEngineInfo(null).name).toBe("Brave Search");
    });
});

describe("isSearchPage", () => {
    it("is a page whose address starts as the engine's search does", () => {
        expect(isSearchPage("https://search.brave.com/search?q=github", DefaultSearchTemplate)).toBe(true);
        expect(isSearchPage("https://search.brave.com/", DefaultSearchTemplate)).toBe(false);
        expect(isSearchPage("https://www.google.com/search?q=github", DefaultSearchTemplate)).toBe(false);
        expect(isSearchPage("https://duckduckgo.com/?q=x", "https://duckduckgo.com/?q={query}")).toBe(true);
        expect(isSearchPage(null, DefaultSearchTemplate)).toBe(false);
    });
});

describe("the one-time note", () => {
    it("is due for the default engine until it was shown", () => {
        expect(searchNoteDue(DefaultSearchTemplate, undefined)).toBe(true);
        expect(searchNoteDue(null, undefined)).toBe(true);
        expect(searchNoteDue(DefaultSearchTemplate, true)).toBe(false);
    });

    it("is never due for an engine the user chose, Google included, or a custom one", () => {
        expect(searchNoteDue("https://www.google.com/search?q={query}", undefined)).toBe(false);
        expect(searchNoteDue("https://duckduckgo.com/?q={query}", undefined)).toBe(false);
        expect(searchNoteDue("https://search.example.dev/?q={query}", undefined)).toBe(false);
    });
});
