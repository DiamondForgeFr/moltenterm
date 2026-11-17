// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The chooser searches the web when nothing matches (#2312, FR-SHELL-089): what it lists, selects and opens for what
// was typed, on the panels and agents MoltenTerm ships.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import {
    AddressEntryId,
    bestMatchIndex,
    entryMatch,
    filterPalette,
    flattenSections,
    PaletteEntry,
    PaletteGroupOrder,
    WebSearchEntryId,
} from "../palette/palette-model";
import {
    chooserListEntries,
    chooserListing,
    newViewChoices,
    resolveFavorites,
    suggestionEntries,
    WebPageChoiceId,
    webTargetFavorite,
} from "./new-view-model";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

const choices = newViewChoices({ presets: DefaultAgents, widgets: DefaultWidgets, workspaceId: "ws1" });
const favorites = resolveFavorites(undefined, choices);
const base = [...suggestionEntries(t), ...chooserListEntries(choices)];
const Brave = "https://search.brave.com/search?q={query}";

// What the palette does with a typed query: lists, selects, and which favourite shows as the target.
function typed(query: string, template: string = Brave) {
    const listing = chooserListing(base, query, template, PaletteGroupOrder);
    const sections = filterPalette(listing.listed, query, {}, listing.order);
    const flat = flattenSections(sections);
    const selected = flat[bestMatchIndex(sections, query)];
    return { listing, flat, selected, target: webTargetFavorite(favorites, selected) };
}

const webFavorite = favorites.findIndex((f) => f.id === WebPageChoiceId);

function pageUrl(entry: PaletteEntry): string {
    const run = entry.run as { kind: string; blockdef: { meta: Record<string, unknown> } };
    expect(run.kind).toBe("widget");
    expect(run.blockdef.meta.view).toBe("molten-browser");
    return run.blockdef.meta.url as string;
}

describe("nothing matches: the words are a web search (the developer's github case)", () => {
    it("lists the search first and selects it, with the Web page favourite as its target", () => {
        const { flat, selected, target, listing } = typed("github");
        expect(webFavorite).toBeGreaterThanOrEqual(0);
        expect(flat[0].id).toBe(WebSearchEntryId);
        expect(flat[0].label).toBe("Search the web for “github”");
        expect(flat[0].detail).toBe("with Brave Search");
        expect(selected.id).toBe(WebSearchEntryId);
        expect(target).toBe(webFavorite);
        expect(listing.webFirst).toBe(true);
    });

    it("keeps the result found only through a hidden word below the search, unselected, with the word to show", () => {
        const { flat, selected } = typed("github");
        const integration = flat.find((e) => e.id === "panel:defwidget@reviews");
        expect(integration).toBeDefined();
        expect(flat.indexOf(integration)).toBeGreaterThan(0);
        expect(selected).not.toBe(integration);
        expect(entryMatch("github", integration)).toMatchObject({ kind: "keyword", keyword: "github" });
    });

    it("opens a web page panel on the engine's results for the words, with the page allowed as typed", () => {
        const { selected } = typed("github");
        expect(pageUrl(selected)).toBe("https://search.brave.com/search?q=github");
        const meta = (selected.run as any).blockdef.meta;
        expect(meta["molten:browser:tabs"]).toEqual([
            { id: expect.any(String), url: "https://search.brave.com/search?q=github", allowed: true },
        ]);
    });

    it("searches the words as one query, encoded", () => {
        expect(pageUrl(typed("kanban board & more").selected)).toBe(
            "https://search.brave.com/search?q=kanban%20board%20%26%20more"
        );
    });

    it("never takes scattered letters for a match", () => {
        const { selected, flat } = typed("tml");
        expect(selected.id).toBe(WebSearchEntryId);
        expect(flat.map((e) => e.id)).toContain("panel:defwidget@terminal");
    });
});

describe("something matches: the search stays last", () => {
    it("selects the matching result and keeps the search below it, with no favourite as the target", () => {
        const { flat, selected, target, listing } = typed("term");
        expect(selected.id).toBe("panel:defwidget@terminal");
        expect(flat[flat.length - 1].id).toBe(WebSearchEntryId);
        expect(target).toBe(-1);
        expect(listing.webFirst).toBe(false);
    });

    it("matches a label's word starts, and the text shown beside a result", () => {
        expect(typed("web page").selected.id).toBe(WebPageChoiceId);
        expect(typed("web page").flat[typed("web page").flat.length - 1].id).toBe(WebSearchEntryId);
    });

    it("lists the search for any typed words, one row, once", () => {
        for (const query of ["t", "term", "kanban board", "github"]) {
            expect(typed(query).flat.filter((e) => e.id === WebSearchEntryId)).toHaveLength(1);
        }
    });
});

describe("an address opens directly", () => {
    it.each([
        ["github.com", "Open github.com", "https://github.com"],
        ["localhost:3000", "Open localhost:3000", "http://localhost:3000"],
        ["https://example.com/a?b=1", "Open https://example.com/a?b=1", "https://example.com/a?b=1"],
    ])("%s: Open first and selected, no search row, the Web page favourite as the target", (query, label, url) => {
        const { flat, selected, target, listing } = typed(query);
        expect(flat[0].id).toBe(AddressEntryId);
        expect(flat[0].label).toBe(label);
        expect(selected.id).toBe(AddressEntryId);
        expect(pageUrl(selected)).toBe(url);
        expect(flat.some((e) => e.id === WebSearchEntryId)).toBe(false);
        expect(target).toBe(webFavorite);
        expect(listing.address).toBe(true);
    });
});

describe("the engine is the one setting", () => {
    const searchRow = (query: string, template?: string) =>
        typed(query, template).flat.find((e) => e.id === WebSearchEntryId);

    it("names the engine of web:defaultsearch and searches with it", () => {
        const row = searchRow("wave terminal", "https://duckduckgo.com/?q={query}");
        expect(row.detail).toBe("with DuckDuckGo");
        expect(pageUrl(row)).toBe("https://duckduckgo.com/?q=wave%20terminal");
    });

    it("names a custom engine by its site", () => {
        const row = searchRow("wave", "https://search.example.dev/find?query={query}");
        expect(row.detail).toBe("with search.example.dev");
        expect(pageUrl(row)).toBe("https://search.example.dev/find?query=wave");
    });

    it("falls back to the default engine for a template that cannot carry the words", () => {
        expect(searchRow("zzzz", "https://search.example/").detail).toBe("with Brave Search");
        expect(searchRow("zzzz", null).detail).toBe("with Brave Search");
    });

    it("marks the row with the engine's letters, not a fetched icon", () => {
        expect(searchRow("zzzz").mark).toBe("Br");
        expect(searchRow("zzzz", "https://www.bing.com/search?q={query}").mark).toBe("Bi");
    });
});

describe("nothing typed", () => {
    it("lists no web row and selects the first entry", () => {
        const listing = chooserListing(base, "", Brave, PaletteGroupOrder);
        expect(listing.listed).toBe(base);
        expect(listing.webFirst).toBe(false);
        const sections = filterPalette(listing.listed, "", {}, listing.order);
        expect(bestMatchIndex(sections, "")).toBe(0);
        expect(flattenSections(sections).some((e) => e.id === WebSearchEntryId)).toBe(false);
    });

    it("shows no favourite as the target for a row that is not a web row", () => {
        expect(webTargetFavorite(favorites, base[0])).toBe(-1);
        expect(webTargetFavorite([], { group: "web" } as PaletteEntry)).toBe(-1);
    });
});
