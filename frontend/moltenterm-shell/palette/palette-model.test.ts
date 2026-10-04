// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    bestMatchIndex,
    filterPalette,
    flattenSections,
    fuzzyMatch,
    highlightRuns,
    matchEntry,
    moveSelection,
    PaletteEntry,
    paletteKeyCommand,
} from "./palette-model";

function entry(
    id: string,
    group: PaletteEntry["group"],
    label: string,
    extra: Partial<PaletteEntry> = {}
): PaletteEntry {
    return { id, group, label, icon: "circle", run: { kind: "newtab" }, ...extra };
}

const Entries: PaletteEntry[] = [
    entry("a1", "agents", "Claude Code", { cli: "claude" }),
    entry("a2", "agents", "Codex", { cli: "codex" }),
    entry("p1", "panels", "Terminal", { cli: "wsh launch defwidget@terminal" }),
    entry("p2", "panels", "Timeline"),
    entry("p3", "panels", "CI/CD", { keywords: ["ci/cd", "molten-cicd"] }),
    entry("f1", "folders", "Notulia", { detail: "~/APPS/Notulia" }),
    entry("w1", "actions", "New tab"),
    entry("w2", "actions", "Settings", { cli: "wsh editconfig" }),
];

describe("fuzzyMatch", () => {
    it("matches a subsequence, case-insensitively", () => {
        expect(fuzzyMatch("cla", "Claude Code")?.indices).toEqual([0, 1, 2]);
        expect(fuzzyMatch("TML", "Timeline")).not.toBeNull();
        expect(fuzzyMatch("xyz", "Timeline")).toBeNull();
        expect(fuzzyMatch("ab", "ba")).toBeNull();
    });

    it("prefers word starts, so initials find an entry", () => {
        expect(fuzzyMatch("cc", "Claude Code")?.indices).toEqual([0, 7]);
        expect(fuzzyMatch("nt", "New tab")?.indices).toEqual([0, 4]);
    });

    it("ranks a prefix and consecutive characters above scattered ones", () => {
        const prefix = fuzzyMatch("term", "Terminal").score;
        const scattered = fuzzyMatch("term", "The external room").score;
        expect(prefix).toBeGreaterThan(scattered);
    });

    it("treats an empty query as a match of everything", () => {
        expect(fuzzyMatch("  ", "Anything")).toEqual({ score: 0, indices: [] });
    });

    it("ignores spaces in the query", () => {
        expect(fuzzyMatch("new tab", "New tab")).not.toBeNull();
        expect(fuzzyMatch("cl co", "Claude Code")).not.toBeNull();
    });
});

describe("matchEntry", () => {
    it("falls back to the CLI, detail and keywords at a lower weight", () => {
        const settings = Entries.find((e) => e.id === "w2");
        const viaCli = matchEntry("editconfig", settings);
        expect(viaCli).not.toBeNull();
        expect(viaCli.indices).toEqual([]);
        expect(
            matchEntry(
                "notulia",
                Entries.find((e) => e.id === "f1")
            )
        ).not.toBeNull();
        expect(
            matchEntry(
                "cicd",
                Entries.find((e) => e.id === "p3")
            )
        ).not.toBeNull();
    });

    it("keeps label highlights when a label matches", () => {
        expect(
            matchEntry(
                "tim",
                Entries.find((e) => e.id === "p2")
            ).indices
        ).toEqual([0, 1, 2]);
    });
});

describe("filterPalette", () => {
    it("shows every group in a fixed order when the query is empty", () => {
        const sections = filterPalette(Entries, "");
        expect(sections.map((s) => s.group)).toEqual(["agents", "panels", "folders", "actions"]);
        expect(sections.map((s) => s.title)).toEqual(["Agents", "Panels", "Recent folders", "Workspace"]);
        expect(flattenSections(sections).map((e) => e.id)).toEqual(Entries.map((e) => e.id));
    });

    it("drops groups without a match and ranks inside a group", () => {
        const sections = filterPalette(Entries, "t");
        expect(sections.map((s) => s.group)).not.toContain("agents");
        const panels = sections.find((s) => s.group === "panels");
        expect(panels.entries.map((e) => e.id).slice(0, 2)).toEqual(["p1", "p2"]);
    });

    it("keeps the group order whatever the scores", () => {
        const sections = filterPalette(Entries, "c");
        expect(sections[0].group).toBe("agents");
        expect(sections.map((s) => s.group)).toEqual(["agents", "panels", "actions"]);
    });

    it("puts the best label match first in its group", () => {
        const agents = filterPalette(Entries, "codex").find((s) => s.group === "agents");
        expect(agents.entries.map((e) => e.id)).toEqual(["a2"]);
    });

    it("uses the given titles", () => {
        const sections = filterPalette(Entries, "", { agents: "Agents in ~/APPS/MoltenTerm" });
        expect(sections[0].title).toBe("Agents in ~/APPS/MoltenTerm");
    });

    it("returns nothing when nothing matches", () => {
        expect(filterPalette(Entries, "qqqq")).toEqual([]);
    });
});

describe("bestMatchIndex", () => {
    it("starts the selection on the best match, even in a later group", () => {
        const entries = [
            entry("p1", "panels", "Web", { cli: "wsh launch defwidget@web" }),
            entry("f1", "folders", "sub", { detail: "/tmp/sub" }),
        ];
        const sections = filterPalette(entries, "sub");
        expect(flattenSections(sections).map((e) => e.id)).toEqual(["p1", "f1"]);
        expect(bestMatchIndex(sections, "sub")).toBe(1);
    });

    it("starts on the first entry without a query, and has none for an empty list", () => {
        expect(bestMatchIndex(filterPalette(Entries, ""), "")).toBe(0);
        expect(bestMatchIndex([], "x")).toBe(-1);
    });
});

describe("keyboard", () => {
    it("maps keys to commands", () => {
        expect(paletteKeyCommand({ key: "ArrowDown" })).toBe("down");
        expect(paletteKeyCommand({ key: "ArrowUp" })).toBe("up");
        expect(paletteKeyCommand({ key: "n", ctrl: true })).toBe("down");
        expect(paletteKeyCommand({ key: "p", ctrl: true })).toBe("up");
        expect(paletteKeyCommand({ key: "Enter" })).toBe("open");
        expect(paletteKeyCommand({ key: "Tab" })).toBe("open-right");
        expect(paletteKeyCommand({ key: "Escape" })).toBe("close");
        expect(paletteKeyCommand({ key: "PageUp" })).toBe("first");
        expect(paletteKeyCommand({ key: "PageDown" })).toBe("last");
    });

    it("leaves modified keys and typing alone", () => {
        expect(paletteKeyCommand({ key: "Tab", shift: true })).toBeNull();
        expect(paletteKeyCommand({ key: "Enter", meta: true })).toBeNull();
        expect(paletteKeyCommand({ key: "a" })).toBeNull();
        expect(paletteKeyCommand({ key: "k", meta: true, shift: true })).toBeNull();
    });

    it("moves the selection with wrap-around", () => {
        expect(moveSelection(0, "down", 3)).toBe(1);
        expect(moveSelection(2, "down", 3)).toBe(0);
        expect(moveSelection(0, "up", 3)).toBe(2);
        expect(moveSelection(1, "first", 3)).toBe(0);
        expect(moveSelection(1, "last", 3)).toBe(2);
        expect(moveSelection(7, "down", 3)).toBe(1);
        expect(moveSelection(0, "down", 0)).toBe(-1);
    });
});

describe("highlightRuns", () => {
    it("splits text into matched and plain runs", () => {
        expect(highlightRuns("Codex", [0, 1])).toEqual([
            { text: "Co", hit: true },
            { text: "dex", hit: false },
        ]);
        expect(highlightRuns("ab", [])).toEqual([{ text: "ab", hit: false }]);
    });
});
