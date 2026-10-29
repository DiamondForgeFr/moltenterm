// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isNarrowWindow, NarrowWindowPx } from "../narrow-window";
import {
    buildLetterKey,
    clampSidebarWidth,
    dotDropSlot,
    dotMoveKey,
    dropTargetAt,
    moveTabBefore,
    readProjectType,
    readSidebarHidden,
    readSidebarWidth,
    sameTabSplit,
    SidebarDefaultWidth,
    sidebarEnabled,
    sidebarFloats,
    SidebarHiddenMetaKey,
    sidebarKeyYields,
    SidebarMaxWidth,
    SidebarMinWidth,
    SidebarWidthMetaKey,
    splitSidebarTabs,
    TileGridColumns,
    tilesPerRow,
} from "./sidebar-model";

describe("workspace sidebar width (FR-SHELL-079, TC-SHELL-154)", () => {
    it("stays between 220 and 420 px", () => {
        expect(SidebarMinWidth).toBe(220);
        expect(SidebarMaxWidth).toBe(420);
        expect(clampSidebarWidth(100)).toBe(220);
        expect(clampSidebarWidth(9999)).toBe(420);
        expect(clampSidebarWidth(300.4)).toBe(300);
    });

    it("falls back to 264 px, the double-click width", () => {
        expect(SidebarDefaultWidth).toBe(264);
        expect(clampSidebarWidth(NaN)).toBe(264);
        expect(clampSidebarWidth(null)).toBe(264);
        expect(readSidebarWidth(null)).toBe(264);
        expect(readSidebarWidth({ [SidebarWidthMetaKey]: "wide" })).toBe(264);
    });

    it("reads the window's width and hidden state", () => {
        expect(readSidebarWidth({ [SidebarWidthMetaKey]: 333 })).toBe(333);
        expect(readSidebarWidth({ [SidebarWidthMetaKey]: 600 })).toBe(420);
        expect(readSidebarHidden({ [SidebarHiddenMetaKey]: true })).toBe(true);
        expect(readSidebarHidden({ [SidebarHiddenMetaKey]: "yes" })).toBe(false);
        expect(readSidebarHidden(null)).toBe(false);
    });

    it("is on unless the setting says false", () => {
        expect(sidebarEnabled(undefined)).toBe(true);
        expect(sidebarEnabled(null)).toBe(true);
        expect(sidebarEnabled(true)).toBe(true);
        expect(sidebarEnabled(false)).toBe(false);
    });
});

describe("narrow window (FR-SHELL-109)", () => {
    it("floats when hidden by choice or when the window is narrow, docks again once it widens", () => {
        expect(sidebarFloats(false, false)).toBe(false);
        expect(sidebarFloats(false, true)).toBe(true);
        expect(sidebarFloats(true, false)).toBe(true);
        expect(sidebarFloats(true, true)).toBe(true);
    });

    it("counts a window as narrow below 1000 px", () => {
        expect(NarrowWindowPx).toBe(1000);
        expect(isNarrowWindow(1400)).toBe(false);
        expect(isNarrowWindow(1000)).toBe(false);
        expect(isNarrowWindow(999)).toBe(true);
        expect(isNarrowWindow(820)).toBe(true);
        expect(isNarrowWindow(0)).toBe(false);
        expect(isNarrowWindow(NaN)).toBe(false);
    });
});

describe("tile grid", () => {
    it("holds at most 3 tiles a row, never under 74 px", () => {
        // The sidebar's content width at 420, 264 and 220 px (8 px padding, 4 px grid inset each side).
        expect(tilesPerRow(404)).toBe(3);
        expect(tilesPerRow(248)).toBe(3);
        expect(tilesPerRow(204)).toBe(2);
        expect(tilesPerRow(160)).toBe(2);
        expect(tilesPerRow(120)).toBe(1);
        for (let width = 150; width <= 420; width++) {
            const n = tilesPerRow(width);
            expect(n).toBeLessThanOrEqual(3);
            expect((width - 6 * (n - 1)) / n).toBeGreaterThanOrEqual(74);
        }
    });

    it("states the same rule in CSS", () => {
        expect(TileGridColumns).toBe("repeat(auto-fill, minmax(max(74px, calc((100% - 12px) / 3)), 1fr))");
    });
});

describe("tiles and temporary views", () => {
    const tabs: Record<string, { meta?: Record<string, any> }> = {
        p: { meta: { "molten:projecttab": true } },
        a: { meta: {} },
        b: {},
        h: {},
    };
    const ws = { tabids: ["a", "p", "b", "h"], meta: { "molten:hiddentabs": ["h"] } };

    it("draws the pinned tabs as tiles and the others as temporary views, hidden tabs left out", () => {
        const split = splitSidebarTabs(ws, (id) => tabs[id], ["molten:projecttab"]);
        expect(split).toEqual({ tiles: ["p"], temporary: ["a", "b"] });
    });

    it("counts a tab not loaded yet as temporary", () => {
        const split = splitSidebarTabs({ tabids: ["x"] }, () => undefined, ["molten:projecttab"]);
        expect(split).toEqual({ tiles: [], temporary: ["x"] });
    });

    it("compares two splits by their lists", () => {
        expect(sameTabSplit({ tiles: ["p"], temporary: ["a"] }, { tiles: ["p"], temporary: ["a"] })).toBe(true);
        expect(sameTabSplit({ tiles: ["p"], temporary: ["a"] }, { tiles: [], temporary: ["p", "a"] })).toBe(false);
    });
});

describe("reordering temporary views", () => {
    it("moves the dragged tab before the target", () => {
        expect(moveTabBefore(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
        expect(moveTabBefore(["a", "b", "c", "d"], "a", "d")).toEqual(["b", "c", "a", "d"]);
    });

    it("moves it to the end without a target, and keeps the order when it lands on itself", () => {
        expect(moveTabBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
        expect(moveTabBefore(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
        expect(moveTabBefore(["a", "b"], "z", "a")).toEqual(["a", "b"]);
    });

    it("finds the row the pointer drops before", () => {
        const rows = [
            { id: "a", top: 0, height: 30 },
            { id: "b", top: 31, height: 30 },
        ];
        expect(dropTargetAt(5, rows)).toBe("a");
        expect(dropTargetAt(20, rows)).toBe("b");
        expect(dropTargetAt(50, rows)).toBe(null);
    });
});

describe("header and build line", () => {
    it("shows the project type only when one is set", () => {
        expect(readProjectType({ meta: { "molten:projecttype": " Desktop " } })).toBe("Desktop");
        expect(readProjectType({ meta: { "molten:projecttype": 3 } })).toBe("");
        expect(readProjectType(null)).toBe("");
    });

    it("names the build's letter by its channel", () => {
        expect(buildLetterKey("gold")).toBe("sidebar.build.letter.gold");
        expect(buildLetterKey("public")).toBe("sidebar.build.letter.public");
    });
});

describe("Cmd+S", () => {
    it("toggles the sidebar unless an editor saves with it", () => {
        const plain = { closest: () => null } as unknown as Element;
        expect(sidebarKeyYields(plain, "term")).toBe(false);
        expect(sidebarKeyYields(null, "")).toBe(false);
        expect(sidebarKeyYields(plain, "waveconfig")).toBe(true);
        const inEditor = {
            closest: (selector: string) => (selector.includes(".monaco-editor") ? {} : null),
        } as unknown as Element;
        expect(sidebarKeyYields(inEditor, "preview")).toBe(true);
    });
});

describe("workspace order (FR-MC-031)", () => {
    it("moves a dot with Alt+Shift and an arrow only", () => {
        const key = (k: string, mods: Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>>) =>
            dotMoveKey({ key: k, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });
        expect(key("ArrowUp", { altKey: true, shiftKey: true })).toBe(-1);
        expect(key("ArrowLeft", { altKey: true, shiftKey: true })).toBe(-1);
        expect(key("ArrowDown", { altKey: true, shiftKey: true })).toBe(1);
        expect(key("ArrowRight", { altKey: true, shiftKey: true })).toBe(1);
        expect(key("ArrowRight", { altKey: true })).toBe(null);
        expect(key("ArrowRight", { altKey: true, shiftKey: true, metaKey: true })).toBe(null);
    });

    it("finds the slot a dragged dot lands in", () => {
        const centres = [
            { id: "a", x: 10 },
            { id: "b", x: 34 },
            { id: "c", x: 58 },
        ];
        expect(dotDropSlot(centres, "a", 5)).toBe(0);
        expect(dotDropSlot(centres, "a", 40)).toBe(1);
        expect(dotDropSlot(centres, "a", 70)).toBe(2);
        expect(dotDropSlot(centres, "c", 20)).toBe(1);
    });
});
