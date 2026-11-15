// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where the typed letters were found (#2312, FR-SHELL-089): the ranking by what a row shows, and the keyword a result
// found only through a hidden search word carries.

import { describe, expect, it } from "vitest";
import { panelMatch } from "../command-panel/panel-model";
import {
    bestMatchIndex,
    entryMatch,
    filterPalette,
    flattenSections,
    hasVisibleMatch,
    isVisibleMatch,
    PaletteEntry,
    strictMatch,
    WebSearchEntryId,
} from "./palette-model";

function entry(id: string, label: string, extra: Partial<PaletteEntry> = {}): PaletteEntry {
    return { id, group: "panels", label, icon: "circle", run: { kind: "newtab" }, ...extra };
}

const Integration = entry("integration", "Integration", { keywords: ["pull request", "pr", "review", "github"] });
const Terminal = entry("terminal", "Terminal", { cli: "wsh launch defwidget@terminal" });
const WebPage = entry("web", "Web page", { keywords: ["web", "page", "url"] });
const Files = entry("files", "Files", { detail: "browse the project folder" });

describe("strictMatch", () => {
    it("is a substring, or letters that each start a word", () => {
        expect(strictMatch("term", "Terminal")).toMatchObject({ contiguous: true, indices: [0, 1, 2, 3] });
        expect(strictMatch("cc", "Claude Code")).toMatchObject({ contiguous: false, indices: [0, 7] });
        expect(strictMatch("font", "Force restart controller")).toBeNull();
        expect(strictMatch("xyz", "Terminal")).toBeNull();
    });

    it("ignores accents and case, with the indices on the shown text", () => {
        expect(strictMatch("epingler", "Épingler cette vue")).toMatchObject({
            contiguous: true,
            indices: [0, 1, 2, 3, 4, 5, 6, 7],
        });
    });

    it("is the command panel's rule", () => {
        expect(panelMatch("fs", "Font size")).toEqual({ score: expect.any(Number), indices: [0, 5] });
        expect(panelMatch("font", "Force restart controller")).toBeNull();
    });
});

describe("entryMatch kinds", () => {
    it("tells a contiguous label match from word starts", () => {
        expect(entryMatch("term", Terminal).kind).toBe("label");
        expect(entryMatch("wp", WebPage).kind).toBe("word");
        expect(entryMatch("term", Terminal).indices).toEqual([0, 1, 2, 3]);
    });

    it("finds a result through the text shown beside its label, with its highlights", () => {
        const m = entryMatch("folder", Files);
        expect(m.kind).toBe("detail");
        expect(m.indices).toEqual([]);
        expect(m.detailIndices).toEqual([19, 20, 21, 22, 23, 24]);
    });

    it("shows the hidden word a result was found through", () => {
        const m = entryMatch("github", Integration);
        expect(m).toMatchObject({
            kind: "keyword",
            keyword: "github",
            keywordIndices: [0, 1, 2, 3, 4, 5],
            indices: [],
        });
    });

    it("keeps scattered letters for last", () => {
        expect(entryMatch("tml", Terminal).kind).toBe("loose");
        expect(entryMatch("zzz", Terminal)).toBeNull();
    });

    it("counts only what a row shows as a visible match", () => {
        expect(["label", "word", "detail"].every((k) => isVisibleMatch(k as any))).toBe(true);
        expect(isVisibleMatch("keyword")).toBe(false);
        expect(isVisibleMatch("loose")).toBe(false);
    });

    it("does not show a command line that a key path replaces", () => {
        const picked = entry("t", "Terminal", { cli: "wsh launch terminal", keyPath: "⌘D t ↵" });
        expect(entryMatch("launch", picked).kind).toBe("keyword");
        expect(entryMatch("launch", picked).keyword).toBeUndefined();
        expect(entryMatch("launch", Terminal).kind).toBe("detail");
    });
});

describe("ranking inside a group (#2312)", () => {
    const ids = (query: string, entries: PaletteEntry[]) =>
        flattenSections(filterPalette(entries, query)).map((e) => e.id);

    it("puts a contiguous label first, then word starts, then the visible detail, then a hidden word, then loose letters", () => {
        const entries = [
            entry("loose", "Tamper mixer"),
            entry("keyword", "Other", { keywords: ["tmx"] }),
            entry("detail", "Another", { detail: "a tmx file" }),
            entry("word", "Terminal my xylophone"),
            entry("label", "The tmx panel"),
        ];
        expect(entries.map((e) => entryMatch("tmx", e).kind)).toEqual(["loose", "keyword", "detail", "word", "label"]);
        expect(ids("tmx", entries)).toEqual(["label", "word", "detail", "keyword", "loose"]);
    });

    it("ranks a prefix above the same letters inside a word", () => {
        const entries = [entry("inside", "Settings"), entry("prefix", "Terminal")];
        expect(ids("t", entries)).toEqual(["prefix", "inside"]);
    });
});

describe("hasVisibleMatch and the selection", () => {
    it("is false for a hidden word and for scattered letters, true for a label or a detail", () => {
        expect(hasVisibleMatch([Integration], "github")).toBe(false);
        expect(hasVisibleMatch([Terminal], "tml")).toBe(false);
        expect(hasVisibleMatch([Terminal, Integration], "term")).toBe(true);
        expect(hasVisibleMatch([Files], "folder")).toBe(true);
        expect(hasVisibleMatch([Terminal], "  ")).toBe(false);
    });

    it("selects the web search row, not a result found only through a hidden word", () => {
        const search = entry(WebSearchEntryId, "Search the web for “github”", { group: "web" });
        const sections = filterPalette([search, Integration, Terminal], "github", {}, ["web", "panels"]);
        const flat = flattenSections(sections);
        expect(flat.map((e) => e.id)).toEqual([WebSearchEntryId, "integration"]);
        expect(flat[bestMatchIndex(sections, "github")].id).toBe(WebSearchEntryId);
    });

    it("selects the best visible result and leaves the web row last", () => {
        const search = entry(WebSearchEntryId, "Search the web for “term”", { group: "web" });
        const sections = filterPalette([Terminal, Integration, search], "term", {}, ["panels", "web"]);
        const flat = flattenSections(sections);
        expect(flat[bestMatchIndex(sections, "term")].id).toBe("terminal");
        expect(flat[flat.length - 1].id).toBe(WebSearchEntryId);
    });

    it("keeps choosing the best match, hidden word included, where there is no web row", () => {
        const sections = filterPalette([Integration, Terminal], "github");
        expect(flattenSections(sections)[bestMatchIndex(sections, "github")].id).toBe("integration");
    });
});
