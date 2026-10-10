// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    activeScope,
    buildRows,
    canReset,
    effectiveValue,
    firstSelectable,
    flattenPanel,
    moveRowSelection,
    nthSelectable,
    panelKeyIntent,
    panelMatch,
    PanelRow,
    resetItem,
    scopeLabel,
    setItemValue,
    stepNumber,
    validStack,
    valueAtScope,
} from "./panel-model";
import { PanelChoice, PanelItem, PanelNumber, PanelSection, ScopeBinding } from "./panel-types";

function store(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial };
    const binding = <T>(scope: ScopeBinding<T>["scope"], key: string): ScopeBinding<T> => ({
        scope,
        get: () => data[key] as T,
        set: (v) => {
            data[key] = v;
        },
        clear: () => {
            delete data[key];
        },
    });
    return { data, binding };
}

const action = (id: string, label: string, extra: Partial<PanelItem> = {}): PanelItem =>
    ({ id, label, type: "action", run: () => {}, ...extra }) as PanelItem;

function terminalSections(): {
    sections: PanelSection[];
    theme: PanelChoice;
    font: PanelNumber;
    s: ReturnType<typeof store>;
} {
    const s = store();
    const theme: PanelChoice = {
        id: "theme",
        type: "choice",
        label: "Theme",
        defaultValue: "default-dark",
        options: [
            { id: "t1", label: "Default Dark", value: "default-dark" },
            { id: "t2", label: "Dracula", value: "dracula" },
            { id: "t3", label: "Monokai", value: "monokai" },
        ],
        scopes: [s.binding("panel", "meta:theme"), s.binding("kind", "settings:theme")],
    };
    const font: PanelNumber = {
        id: "font",
        type: "number",
        label: "Font size",
        min: 6,
        max: 32,
        step: 1,
        defaultValue: 12,
        scopes: [s.binding("panel", "meta:font"), s.binding("kind", "settings:font")],
    };
    const sections: PanelSection[] = [
        // Out of order on purpose: buildRows keeps the given order, the registry sorts by kind.
        {
            id: "widget",
            kind: "widget",
            title: "Terminal",
            items: [
                theme,
                font,
                action("save", "Save session as…"),
                {
                    id: "advanced",
                    type: "page",
                    label: "Advanced",
                    items: [action("filebrowser", "Open a file browser here")],
                },
            ],
        },
        { id: "developer", kind: "developer", title: "Developer", items: [action("copyid", "Copy panel id")] },
    ];
    return { sections, theme, font, s };
}

const labels = (rows: PanelRow[]) =>
    rows.map((r) => (r.kind === "heading" ? `#${r.title}` : r.kind === "option" ? `${r.option.label}` : r.item.label));

describe("command panel rows (FR-SHELL-047, TC-SHELL-101, TC-SHELL-103)", () => {
    it("lists the sections with headings and hides Developer until Option is held", () => {
        const { sections } = terminalSections();
        expect(labels(buildRows({ sections, stack: [], query: "", alt: false }))).toEqual([
            "#Terminal",
            "Theme",
            "Font size",
            "Save session as…",
            "Advanced",
        ]);
        expect(labels(buildRows({ sections, stack: [], query: "", alt: true }))).toContain("Copy panel id");
    });

    it("opens a choice as a sub-page of its values, never a cascade", () => {
        const { sections } = terminalSections();
        const rows = buildRows({ sections, stack: ["theme"], query: "", alt: false });
        expect(labels(rows)).toEqual(["Default Dark", "Dracula", "Monokai"]);
        expect(rows.every((r) => r.kind === "option")).toBe(true);
    });

    it("searches across sections and sub-pages, footer included", () => {
        const { sections } = terminalSections();
        const footer = [action("split", "Split right")];
        const rows = buildRows({ sections, stack: [], query: "drac", alt: false, footer });
        expect(labels(rows)).toEqual(["#Terminal", "Dracula"]);
        expect((rows[1] as any).breadcrumb).toBe("Theme");
        expect(labels(buildRows({ sections, stack: [], query: "file browser", alt: false }))).toEqual([
            "#Terminal",
            "Open a file browser here",
        ]);
        expect(labels(buildRows({ sections, stack: [], query: "split", alt: false, footer }))).toEqual([
            "#Panel",
            "Split right",
        ]);
    });

    it("keeps Developer items behind Option in search too", () => {
        const { sections } = terminalSections();
        expect(buildRows({ sections, stack: [], query: "copy panel", alt: false })).toEqual([]);
        expect(labels(buildRows({ sections, stack: [], query: "copy panel", alt: true }))).toEqual([
            "#Developer",
            "Copy panel id",
        ]);
    });

    it("never numbers a destructive row for Cmd+N", () => {
        const rows = buildRows({
            sections: [
                {
                    id: "w",
                    kind: "widget",
                    title: "W",
                    items: [action("kill", "Kill", { destructive: true }), action("ok", "Fine")],
                },
            ],
            stack: [],
            query: "",
            alt: false,
        });
        expect(labels([rows[nthSelectable(rows, 1)]])).toEqual(["Fine"]);
    });

    it("ignores loose subsequences but keeps initials and substrings", () => {
        expect(panelMatch("font", "Force restart controller")).toBeNull();
        expect(panelMatch("fs", "Font size")).not.toBeNull();
        expect(panelMatch("size", "Font size")).not.toBeNull();
    });

    it("drops a stale stack to its valid start", () => {
        const { sections } = terminalSections();
        expect(validStack(sections, ["theme", "nope"])).toEqual(["theme"]);
        expect(validStack(sections, ["gone"])).toEqual([]);
    });
});

describe("command panel keys (DS-SHELL-085, NFR-SHELL-026)", () => {
    const { sections } = terminalSections();
    const rows = buildRows({ sections, stack: [], query: "", alt: false });
    const themeRow = rows[1];
    const fontRow = rows[2];

    it("moves over selectable rows only and runs Cmd+N on the Nth row", () => {
        const first = firstSelectable(rows);
        expect(first).toBe(1);
        expect(moveRowSelection(rows, first, "up")).toBe(rows.length - 1);
        expect(nthSelectable(rows, 2)).toBe(2);
        expect(nthSelectable(rows, 9)).toBe(-1);
        expect(panelKeyIntent({ key: "2", meta: true }, { query: "", depth: 0, row: themeRow })).toEqual({
            type: "activate-nth",
            n: 2,
        });
    });

    it("opens with →, steps numbers with ← and →, goes back with ← and Backspace", () => {
        expect(panelKeyIntent({ key: "ArrowRight" }, { query: "", depth: 0, row: themeRow })).toEqual({ type: "open" });
        expect(panelKeyIntent({ key: "ArrowRight" }, { query: "", depth: 0, row: fontRow })).toEqual({
            type: "step",
            delta: 1,
        });
        expect(panelKeyIntent({ key: "ArrowLeft" }, { query: "", depth: 1, row: themeRow })).toEqual({ type: "back" });
        expect(panelKeyIntent({ key: "Backspace" }, { query: "", depth: 1, row: themeRow })).toEqual({ type: "back" });
        // While typing, the arrows move the caret.
        expect(panelKeyIntent({ key: "ArrowLeft" }, { query: "ab", depth: 1, row: themeRow })).toBeNull();
    });

    it("climbs the Escape ladder: clear the search, go back, close", () => {
        expect(panelKeyIntent({ key: "Escape" }, { query: "x", depth: 1, row: null })).toEqual({ type: "clear-query" });
        expect(panelKeyIntent({ key: "Escape" }, { query: "", depth: 1, row: null })).toEqual({ type: "back" });
        expect(panelKeyIntent({ key: "Escape" }, { query: "", depth: 0, row: null })).toEqual({ type: "close" });
        expect(panelKeyIntent({ key: "Enter" }, { query: "", depth: 0, row: themeRow })).toEqual({ type: "activate" });
    });
});

describe("command panel scopes and reset (FR-SHELL-047-AC5, TC-SHELL-102)", () => {
    it("reads the narrowest scope that holds a value, else the default", async () => {
        const { theme, s } = terminalSections();
        expect(effectiveValue(theme)).toBe("default-dark");
        expect(canReset(theme)).toBe(false);
        await setItemValue(theme, "monokai", "kind");
        expect(s.data["settings:theme"]).toBe("monokai");
        expect(effectiveValue(theme)).toBe("monokai");
        expect(activeScope(theme).scope).toBe("kind");
        await setItemValue(theme, "dracula", "panel");
        expect(effectiveValue(theme)).toBe("dracula");
        expect(activeScope(theme).scope).toBe("panel");
    });

    it("resets only the chosen scope", async () => {
        const { font, s } = terminalSections();
        await setItemValue(font, 16, "panel");
        await setItemValue(font, 14, "kind");
        await resetItem(font, "panel");
        expect(s.data["meta:font"]).toBeUndefined();
        expect(s.data["settings:font"]).toBe(14);
        expect(effectiveValue(font)).toBe(14);
        // This panel now inherits All terminals' value.
        expect(valueAtScope(font, activeScope(font, "panel"))).toBe(14);
    });

    it("names the scopes for the badge", () => {
        expect(scopeLabel("panel", "terminals")).toBe("This panel");
        expect(scopeLabel("kind", "terminals")).toBe("All terminals");
        expect(scopeLabel("workspace", "terminals")).toBe("This workspace");
        expect(scopeLabel("global", "terminals")).toBe("Everywhere");
    });

    it("steps a number within its bounds and precision", () => {
        const slider: PanelNumber = { id: "t", type: "number", label: "T", min: 0, max: 1, step: 0.05 };
        expect(stepNumber(slider, 0.5, 1)).toBe(0.55);
        expect(stepNumber(slider, 1, 1)).toBe(1);
        expect(stepNumber(slider, 0, -1)).toBe(0);
    });
});

describe("command panel items as palette commands", () => {
    it("flattens actions, toggles and each choice value, skipping pages' wrappers", () => {
        const { sections } = terminalSections();
        const flat = flattenPanel(sections, [action("split", "Split right")]);
        const names = flat.map((f) => f.label);
        expect(names).toContain("Theme: Dracula");
        expect(names).toContain("Open a file browser here");
        expect(names).not.toContain("Copy panel id");
        expect(names).toContain("Split right");
        expect(names).not.toContain("Advanced");
        expect(flat.find((f) => f.label === "Open a file browser here").breadcrumb).toBe("Terminal › Advanced");
    });
});
