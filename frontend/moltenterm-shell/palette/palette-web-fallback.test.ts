// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Every palette mode offers the typed words on the web (#2545, FR-SHELL-013): a split's picker, a new column's picker
// and the open palette list "Search the web" with the engine of Settings and "Open <address>", so a query that matches
// nothing is never a dead end, and Enter opens the web page panel in the split's place.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { paletteListing } from "../newview/new-view-model";
import { SplitNewPanelMetaKey } from "../split/split-model";
import {
    AddressEntryId,
    bestMatchIndex,
    filterPalette,
    flattenSections,
    PaletteEntry,
    PaletteGroupOrder,
    paletteOpenPlan,
    PickerGroupOrder,
    WebSearchEntryId,
} from "./palette-model";
import { addressEntry, buildPaletteEntries, PickerSource } from "./palette-sources";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

const Brave = "https://search.brave.com/search?q={query}";
const DuckDuckGo = "https://duckduckgo.com/?q={query}";

const splitSource: PickerSource = {
    blockId: "source",
    meta: { view: "term", "cmd:cwd": "/p" },
    splitKeys: "⌘D",
};
const newPanelSource: PickerSource = {
    blockId: "source",
    meta: { view: "term", "cmd:cwd": "/p", [SplitNewPanelMetaKey]: true } as MetaType,
    splitKeys: "⌘D",
};

function entries(picker: PickerSource): PaletteEntry[] {
    return buildPaletteEntries({
        presets: DefaultAgents,
        widgets: DefaultWidgets,
        workspaceId: "ws1",
        folder: "/p",
        recentFolders: [],
        otherFolders: [],
        workspaces: [],
        home: "",
        picker,
    });
}

// What a palette lists and selects for a typed query, as command-palette.tsx does it.
function typed(picker: PickerSource, query: string, template: string = Brave) {
    const order = picker != null ? PickerGroupOrder : PaletteGroupOrder;
    const listing = paletteListing(entries(picker), query, template, order, false, t);
    const sections = filterPalette(listing.listed, query, {}, listing.order);
    const flat = flattenSections(sections);
    return { flat, selected: flat[bestMatchIndex(sections, query)] };
}

function pageUrl(entry: PaletteEntry): string {
    const run = entry.run as { kind: string; blockdef: { meta: Record<string, unknown> } };
    expect(run.kind).toBe("widget");
    expect(run.blockdef.meta.view).toBe("molten-browser");
    return run.blockdef.meta.url as string;
}

const pickers: [string, PickerSource][] = [
    ["a split's picker", splitSource],
    ["a new panel's picker", newPanelSource],
];

describe.each(pickers)("%s: nothing matches (the developer's infoomaniak case)", (_, picker) => {
    it("offers the web search with the engine chosen in Settings, selected", () => {
        const { flat, selected } = typed(picker, "infoomaniak");
        expect(flat.length).toBeGreaterThan(0);
        expect(selected.id).toBe(WebSearchEntryId);
        expect(selected.label).toBe("Search the web for “infoomaniak”");
        expect(selected.detail).toBe("with Brave Search");
        expect(pageUrl(selected)).toBe("https://search.brave.com/search?q=infoomaniak");
        expect(typed(picker, "infoomaniak", DuckDuckGo).selected.detail).toBe("with DuckDuckGo");
    });

    it("opens the web page panel in the split's place on Enter", () => {
        const { selected } = typed(picker, "infoomaniak");
        expect(
            paletteOpenPlan(selected.run, { inPlace: "replace", right: false, blockId: "picker", picker: true })
        ).toEqual({
            kind: "fill",
            placement: "replace",
            consumeSplit: true,
        });
    });

    it("opens an address directly, first and selected, with no search row", () => {
        const { flat, selected } = typed(picker, "infomaniak.com");
        expect(flat[0].id).toBe(AddressEntryId);
        expect(selected.id).toBe(AddressEntryId);
        expect(selected.label).toBe("Open infomaniak.com");
        expect(pageUrl(selected)).toBe("https://infomaniak.com");
        expect(flat.some((e) => e.id === WebSearchEntryId)).toBe(false);
        expect(
            paletteOpenPlan(selected.run, { inPlace: "replace", right: false, blockId: "picker", picker: true })
        ).toEqual({
            kind: "fill",
            placement: "replace",
            consumeSplit: true,
        });
    });

    it("keeps a match first and selected, the web search as the last entry", () => {
        const { flat, selected } = typed(picker, "term");
        expect(selected.id).toBe("panel:defwidget@terminal");
        expect(flat[flat.length - 1].id).toBe(WebSearchEntryId);
    });
});

describe("the open palette", () => {
    it("is never a dead end either: the web search opens in a new panel", () => {
        const { selected } = typed(null, "infoomaniak");
        expect(selected.id).toBe(WebSearchEntryId);
        expect(
            paletteOpenPlan(selected.run, { inPlace: "new", right: false, blockId: "focused", picker: false })
        ).toEqual({
            kind: "fill",
            placement: "new",
            consumeSplit: false,
        });
    });

    it("lists and selects its matches as before, the web search only added after them", () => {
        for (const query of ["term", "claude", "settings", "github.com"]) {
            const before = (() => {
                const address = addressEntry(query);
                const all = entries(null);
                const sections = filterPalette(address != null ? [address, ...all] : all, query, {}, PaletteGroupOrder);
                const flat = flattenSections(sections);
                return { ids: flat.map((e) => e.id), selected: flat[bestMatchIndex(sections, query)].id };
            })();
            const { flat, selected } = typed(null, query);
            expect(selected.id).toBe(before.selected);
            expect(flat.map((e) => e.id).filter((id) => id !== WebSearchEntryId)).toEqual(before.ids);
        }
    });

    it("keeps Tab's open-to-the-right and an action's cancelled split", () => {
        const run = { kind: "widget", blockdef: { meta: { view: "term" } } } as const;
        expect(paletteOpenPlan(run, { inPlace: "new", right: true, blockId: "focused", picker: false })).toMatchObject({
            placement: "right",
        });
        expect(
            paletteOpenPlan({ kind: "settings" }, { inPlace: "replace", right: false, blockId: "p", picker: true })
        ).toEqual({ kind: "elsewhere", focusOrigin: false });
    });
});
