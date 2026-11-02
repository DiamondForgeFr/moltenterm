// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The palette's search words are translated like its labels (#1670, FR-SHELL-013): every list exists in each
// language, every entry's words resolve, and the words on screen find their command.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { flattenKeys, resolveKey, shippedDictionary } from "../i18n/i18n-core";
import { filterPalette, flattenSections, fuzzyMatch, PaletteEntry } from "./palette-model";
import { buildPaletteEntries, paletteKeywords, PaletteKeywordsPrefix, PaletteSourceInput } from "./palette-sources";

const Root = path.resolve(__dirname, "../../..");
const Sources = [
    "frontend/moltenterm-shell/palette/palette-sources.ts",
    "frontend/moltenterm-shell/command-panel/command-panel-palette.ts",
].map((f) => fs.readFileSync(path.join(Root, f), "utf8"));
const SourceText = Sources.join("\n");

const DefaultWidgets = JSON.parse(fs.readFileSync(path.join(Root, "pkg/wconfig/defaultconfig/widgets.json"), "utf8"));
const DefaultAgents = JSON.parse(
    fs.readFileSync(path.join(Root, "pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);

function usedNames(): string[] {
    const direct = [...SourceText.matchAll(/paletteKeywords\(\s*"([\w]+)"/g)].map((m) => m[1]);
    const picker = SourceText.match(/const PickerKeywords[^}]*\}/)?.[0] ?? "";
    const viaPicker = [...picker.matchAll(/:\s*"([\w]+)"/g)].map((m) => m[1]);
    return [...new Set([...direct, ...viaPicker])];
}

// Every entry the palette can list: a linked project, a Web page panel, outdated terminals, the view pin moves.
function everyEntry(): PaletteEntry[] {
    const input: PaletteSourceInput = {
        presets: DefaultAgents,
        widgets: DefaultWidgets,
        workspaceId: "w1",
        folder: "/p",
        recentFolders: ["/q"],
        otherFolders: [],
        workspaces: [
            { id: "w1", name: "One", icon: "", color: "", active: true },
            { id: "w2", name: "Two", icon: "", color: "", active: false },
        ],
        home: "/home/me",
        projectLinked: true,
        installedBrowser: { id: "chrome", name: "Chrome" },
        hasBrowserPanel: true,
        outdatedTerminals: 2,
        viewPin: { moves: ["here", "everywhere", "temporary"], keepMove: "here", keepHint: "⇧⌘O" },
    };
    const picker = buildPaletteEntries({
        ...input,
        picker: { blockId: "b1", meta: { view: "term" }, splitKeys: "⌘D" },
    });
    return [...buildPaletteEntries(input), ...picker];
}

function inFrench<T>(fn: () => T): T {
    I18nModel.getInstance().setLanguageSetting("fr");
    try {
        return fn();
    } finally {
        I18nModel.getInstance().setLanguageSetting("en");
    }
}

function found(query: string): string[] {
    return flattenSections(filterPalette(everyEntry(), query)).map((e) => e.id);
}

const PinIds = ["action:pinview:here", "action:pinview:everywhere", "action:pinview:temporary"];

afterEach(() => {
    I18nModel.getInstance().setLanguageSetting("en");
});

describe("palette search words (#1670)", () => {
    it("has every list the code asks for in each language, and no list the code does not use", () => {
        const names = usedNames();
        expect(names.length).toBeGreaterThan(15);
        for (const lang of ["en", "fr"]) {
            const dict = shippedDictionary(lang);
            for (const name of names) {
                const text = resolveKey(dict, PaletteKeywordsPrefix + name);
                expect(text, `${lang} ${PaletteKeywordsPrefix}${name}`).toBeTruthy();
                expect(
                    text.split(",").every((w) => w.trim() !== ""),
                    `${lang} ${name}: an empty word`
                ).toBe(true);
            }
        }
        const shipped = flattenKeys(shippedDictionary("en"))
            .filter((k) => k.startsWith(PaletteKeywordsPrefix))
            .map((k) => k.slice(PaletteKeywordsPrefix.length));
        expect(shipped.sort()).toEqual([...names].sort());
    });

    it("writes no literal word list in the palette's code: words go through a key", () => {
        for (const src of Sources) {
            expect(src).not.toMatch(/keywords:\s*\[\s*"/);
        }
    });

    it("resolves every entry's words in both languages, never a raw key", () => {
        for (const lang of ["en", "fr"]) {
            I18nModel.getInstance().setLanguageSetting(lang);
            for (const entry of everyEntry()) {
                for (const word of entry.keywords ?? []) {
                    expect(word, `${lang} ${entry.id}`).not.toContain(PaletteKeywordsPrefix);
                }
            }
        }
    });

    it("finds an entry by the current language's words and by the English ones", () => {
        expect(paletteKeywords("viewPin")).toEqual(["pin", "unpin", "keep", "temporary", "view", "tab"]);
        const fr = inFrench(() => paletteKeywords("viewPin", "x"));
        expect(fr.slice(0, 4)).toEqual(["épingler", "désépingler", "garder", "temporaire"]);
        expect(fr).toEqual(expect.arrayContaining(["pin", "keep", "x"]));
        expect(new Set(fr).size).toBe(fr.length);
    });

    it.each(["épingler", "epingler", "désépingler", "garder", "temporaire", "pin", "unpin", "keep"])(
        "finds the view pin commands by %s in French",
        (query) => {
            expect(inFrench(() => found(query))).toEqual(expect.arrayContaining(PinIds));
        }
    );

    it.each(["pin", "unpin", "keep", "temporary"])("finds the view pin commands by %s in English", (query) => {
        expect(found(query)).toEqual(expect.arrayContaining(PinIds));
    });

    it("labels the view pin commands with the interface's word for the action", () => {
        const labels = (entries: PaletteEntry[]) => entries.filter((e) => PinIds.includes(e.id)).map((e) => e.label);
        expect(labels(everyEntry())).toEqual([
            "Pin this view in this workspace",
            "Pin this view everywhere",
            "Unpin this view (make it temporary)",
        ]);
        expect(inFrench(() => labels(everyEntry()))).toEqual([
            "Épingler cette vue dans cet espace de travail",
            "Épingler cette vue partout",
            "Désépingler cette vue (la rendre temporaire)",
        ]);
    });

    it.each([
        ["raccourcis", "action:shortcuts"],
        ["préférences", "action:settings"],
        ["égaliser", "action:equalize"],
        ["presse-papiers", "action:agentcopy:claude"],
        ["navigateur", "action:openinbrowser"],
        ["historique", "panel:sessions"],
        ["compagnon", "panel:companion"],
    ])("finds other entries by their French words: %s", (query, id) => {
        expect(inFrench(() => found(query))).toContain(id);
    });
});

describe("accent-insensitive matching (#1670)", () => {
    it("matches with or without accents, indices on the shown text", () => {
        expect(fuzzyMatch("epingler", "Épingler cette vue")).not.toBeNull();
        expect(fuzzyMatch("épingler", "Epingler")).not.toBeNull();
        expect(fuzzyMatch("egal", "Égaliser").indices).toEqual([0, 1, 2, 3]);
        expect(fuzzyMatch("xyz", "Épingler")).toBeNull();
    });
});
