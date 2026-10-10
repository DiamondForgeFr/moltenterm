// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    bestMatchIndex,
    filterPalette,
    flattenSections,
    PaletteEntry,
    PickerGroupOrder,
} from "../palette/palette-model";
import { buildPaletteEntries, pickerPanelEntries, PickerSource } from "../palette/palette-sources";
import { shouldOpenBlockBodyMenu } from "./split-body-menu";
import { SplitDownLabel, SplitRightLabel, withoutSplitItems } from "./split-menu";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

const TermSource: PickerSource = {
    blockId: "src",
    meta: { view: "term", controller: "shell", "cmd:cwd": "/work/app", connection: "dev@box" },
    splitKeys: "⌘D",
    companionKeys: "⇧⌘J",
};

function pickerEntries(source: PickerSource, projectLinked = true): PaletteEntry[] {
    return buildPaletteEntries({
        presets: DefaultAgents,
        widgets: {
            ...DefaultWidgets,
            "my-dash": { label: "dash", icon: "chart-pie", blockdef: { meta: { view: "web", url: "http://x" } } },
        },
        workspaceId: "ws",
        folder: "/work",
        recentFolders: ["/work/other"],
        otherFolders: [],
        workspaces: [],
        home: "/home/me",
        projectLinked,
        picker: source,
    });
}

describe("the split's picker (FR-SHELL-042-AC6, DS-SHELL-066)", () => {
    it("lists every panel kind first, Terminal on top", () => {
        const sections = filterPalette(pickerEntries(TermSource), "", {}, PickerGroupOrder);
        expect(sections[0].group).toBe("panels");
        expect(sections[0].entries.map((e) => e.label)).toEqual([
            "Terminal",
            "Browser",
            "Files",
            "Mission Control",
            "Line map",
            "CI/CD",
            "Companion",
            "Sessions",
            "System info",
            "Processes",
            "dash",
        ]);
        expect(flattenSections(sections)[bestMatchIndex(sections, "")].label).toBe("Terminal");
    });

    it("opens the terminal and the files where the source terminal is", () => {
        const panels = pickerPanelEntries(DefaultWidgets, "ws", TermSource);
        const term = panels.find((e) => e.label === "Terminal");
        expect(term.run).toEqual({
            kind: "widget",
            blockdef: { meta: { view: "term", controller: "shell", "cmd:cwd": "/work/app", connection: "dev@box" } },
        });
        const files = panels.find((e) => e.label === "Files");
        expect(files.run).toEqual({
            kind: "widget",
            blockdef: { meta: { view: "preview", file: "/work/app", connection: "dev@box" } },
        });
        const companion = panels.find((e) => e.label === "Companion");
        expect(companion.run).toEqual({
            kind: "widget",
            blockdef: { meta: { view: "molten-companion", "molten:companion:block": "src" } },
        });
        expect(companion.shortcut).toBe("⇧⌘J");
    });

    it("offers no companion for a source that is not a terminal, and Mission Control with or without a project", () => {
        const panels = pickerPanelEntries(DefaultWidgets, "ws", {
            ...TermSource,
            meta: { view: "molten-browser" },
        });
        const labels = panels.map((e) => e.label);
        expect(labels).not.toContain("Companion");
        expect(labels).toContain("Mission Control");
        expect(labels).toContain("Line map");
        expect(labels[0]).toBe("Terminal");
        expect(panels.find((e) => e.label === "Mission Control").detail).toMatch(/link a project/);
    });

    it("finds Mission Control by the words people type for it (FR-SHELL-046-AC5, DS-SHELL-084)", () => {
        for (const linked of [true, false]) {
            const entries = pickerEntries(TermSource, linked);
            for (const word of ["mission", "dashboard", "branches", "git"]) {
                const sections = filterPalette(entries, word, {}, PickerGroupOrder);
                const labels = flattenSections(sections).map((e) => e.label);
                expect(labels, `${word} (linked: ${linked})`).toContain("Mission Control");
            }
        }
        const pick = (word: string) => {
            const sections = filterPalette(pickerEntries(TermSource), word, {}, PickerGroupOrder);
            return flattenSections(sections)[bestMatchIndex(sections, word)].label;
        };
        expect(pick("mission")).toBe("Mission Control");
        expect(pick("url")).toBe("Browser");
        expect(pick("resume")).toBe("Sessions");
        expect(pick("usage")).toBe("Companion");
        expect(pick("line")).toBe("Line map");
    });

    it("opens the line map full size from the picker", () => {
        const lineMap = pickerPanelEntries(DefaultWidgets, "ws", TermSource, true).find((e) => e.label === "Line map");
        expect(lineMap.run).toEqual({ kind: "widget", blockdef: { meta: { view: "molten-linemap" } } });
    });

    it("shows on each panel the keys that reach it, and they do", () => {
        const entries = pickerEntries(TermSource);
        const panels = entries.filter((e) => e.group === "panels");
        for (const panel of panels) {
            expect(panel.keyPath, panel.label).toMatch(/^⌘D {2}\S+ {2}↵$/);
            const typed = panel.keyPath.split("  ")[1];
            const sections = filterPalette(entries, typed, {}, PickerGroupOrder);
            expect(flattenSections(sections)[bestMatchIndex(sections, typed)].id).toBe(panel.id);
        }
        expect(panels.find((e) => e.label === "Browser").keyPath).toBe("⌘D  b  ↵");
        expect(entries.filter((e) => e.group !== "panels").every((e) => e.keyPath == null)).toBe(true);
    });

    it("leaves the ordinary palette as it was", () => {
        const entries = buildPaletteEntries({
            presets: DefaultAgents,
            widgets: DefaultWidgets,
            workspaceId: "ws",
            folder: "",
            recentFolders: [],
            otherFolders: [],
            workspaces: [],
            home: "",
        });
        const panels = entries.filter((e) => e.group === "panels");
        expect(panels.every((e) => e.keyPath == null)).toBe(true);
        expect(panels.map((e) => e.label)).not.toContain("Sessions");
        expect(entries.some((e) => e.label === "Keyboard shortcuts")).toBe(true);
    });
});

describe("split menus (FR-SHELL-042-AC4)", () => {
    it("drops a view's own split items from the block menu, which starts with them", () => {
        const items: ContextMenuItem[] = [
            { label: SplitRightLabel },
            { label: SplitDownLabel },
            { type: "separator" },
            { label: "Themes" },
        ];
        expect(withoutSplitItems(items)).toEqual([{ label: "Themes" }]);
        expect(withoutSplitItems(null)).toBe(null);
    });

    it("opens the block menu from the body only where nothing else answers", () => {
        const plain = { defaultPrevented: false, target: { closest: () => null } as unknown as EventTarget };
        expect(shouldOpenBlockBodyMenu(plain)).toBe(true);
        expect(shouldOpenBlockBodyMenu({ ...plain, defaultPrevented: true })).toBe(false);
        const input = { defaultPrevented: false, target: { closest: () => ({}) } as unknown as EventTarget };
        expect(shouldOpenBlockBodyMenu(input)).toBe(false);
    });
});
