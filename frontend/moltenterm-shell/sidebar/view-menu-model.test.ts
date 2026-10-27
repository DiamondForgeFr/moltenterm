// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    configPaneIcons,
    dropAction,
    dropsAfter,
    MaxGlyphIcons,
    moveBeside,
    paneIcon,
    readViewIcon,
    sameOrder,
    typesText,
    undoKey,
    undoOrder,
    viewGlyphIcons,
    ViewIconChoices,
    viewMenuPlan,
    zoneCaptionShown,
} from "./view-menu-model";
import { AgentSlotMetaKey, PinConfig } from "./view-pins-model";

describe("a view's glyph (DS-SHELL-126)", () => {
    it("shows the panels' icons, up to three, in order", () => {
        expect(viewGlyphIcons(null, ["folder-open", "code-branch"])).toEqual(["folder-open", "code-branch"]);
        expect(viewGlyphIcons(undefined, ["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
        expect(MaxGlyphIcons).toBe(3);
    });

    it("lets a chosen icon replace them", () => {
        expect(viewGlyphIcons("gauge", ["terminal", "globe"])).toEqual(["gauge"]);
        expect(viewGlyphIcons("  ", ["terminal"])).toEqual(["terminal"]);
    });

    it("shows a square for a view without a panel", () => {
        expect(viewGlyphIcons(null, [])).toEqual(["square"]);
    });

    it("gives an agent's panel the agent's glyph, and a kept slot the default one", () => {
        expect(paneIcon({ view: "term" }, "brands@claude")).toBe("brands@claude");
        expect(paneIcon({ view: "term", [AgentSlotMetaKey]: true })).toBe("robot");
        expect(paneIcon({ view: "term" })).toBe("terminal");
        expect(paneIcon({ view: "preview" })).toBe("folder-open");
    });

    it("reads a configuration's panels in the order of its layout", () => {
        const config: PinConfig = {
            tree: { dir: "row", children: [{ pane: 1 }, { dir: "column", children: [{ pane: 0 }, { pane: 2 }] }] },
            panes: [{ view: "term" }, { view: "preview" }, { view: "molten-browser" }],
        };
        expect(configPaneIcons(config)).toEqual(["folder-open", "terminal", "globe"]);
        expect(configPaneIcons(null)).toEqual([]);
    });

    it("offers a set of free glyphs", () => {
        expect(ViewIconChoices.length).toBe(16);
        expect(new Set(ViewIconChoices).size).toBe(ViewIconChoices.length);
        expect(readViewIcon(" gear ")).toBe("gear");
        expect(readViewIcon(3)).toBeNull();
    });
});

describe("the view menu (FR-SHELL-081)", () => {
    it("never offers Close on a pinned view, and says why", () => {
        for (const state of ["workspace", "everywhere"] as const) {
            const plan = viewMenuPlan(state, false);
            expect(plan.close).toBe(false);
            expect(plan.closeNote).toBe(true);
            expect(plan.unpin).toBe(true);
            expect(plan.pinHere).toBe(false);
        }
    });

    it("offers a temporary view its pins and Close, never Unpin or Save", () => {
        const plan = viewMenuPlan("temporary", true);
        expect(plan).toMatchObject({ pinHere: true, pinEverywhere: true, close: true, unpin: false });
        expect(plan.saveOrRevert).toBe(false);
        expect(plan.closeNote).toBe(false);
    });

    it("offers each pinned state the other scope", () => {
        expect(viewMenuPlan("workspace", false)).toMatchObject({ pinEverywhere: true, pinOnlyHere: false });
        expect(viewMenuPlan("everywhere", false)).toMatchObject({ pinEverywhere: false, pinOnlyHere: true });
    });

    it("offers Save and Back only once a pinned view changed", () => {
        expect(viewMenuPlan("workspace", true).saveOrRevert).toBe(true);
        expect(viewMenuPlan("everywhere", false).saveOrRevert).toBe(false);
    });
});

describe("reorder by drag", () => {
    it("puts the dragged block before or after the target", () => {
        expect(moveBeside(["a", "b", "c", "d"], "d", "b", false)).toEqual(["a", "d", "b", "c"]);
        expect(moveBeside(["a", "b", "c", "d"], "a", "c", true)).toEqual(["b", "c", "a", "d"]);
        expect(moveBeside(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
        expect(moveBeside(["a", "b"], "a", "a", true)).toEqual(["a", "b"]);
        expect(moveBeside(["a", "b"], "a", "z", true)).toEqual(["a", "b"]);
    });

    it("keeps the other tabs (temporary ones between tiles) in place", () => {
        expect(moveBeside(["t1", "x", "t2", "y", "t3"], "t3", "t1", false)).toEqual(["t3", "t1", "x", "t2", "y"]);
    });

    it("undoes to the order before, unless the list changed meanwhile", () => {
        expect(undoOrder(["a", "b", "c"], ["b", "a", "c"])).toEqual(["a", "b", "c"]);
        expect(undoOrder(["a", "b"], ["b", "a", "c"])).toBeNull();
        expect(undoOrder(["a", "b"], ["b", "c"])).toBeNull();
        expect(sameOrder(["a"], ["a"])).toBe(true);
    });

    it("lands after the target past its middle", () => {
        expect(dropsAfter(61, { left: 10, width: 100 })).toBe(true);
        expect(dropsAfter(59, { left: 10, width: 100 })).toBe(false);
    });

    it("reorders within a row, and pins across rows", () => {
        expect(dropAction("tile", "tiles")).toBe("reorder-tiles");
        expect(dropAction("top", "top")).toBe("reorder-top");
        expect(dropAction("tile", "top")).toBe("pin-everywhere");
        expect(dropAction("row", "tiles")).toBe("pin-here");
        expect(dropAction("row", "top")).toBe("pin-everywhere");
        expect(dropAction("top", "tiles")).toBeNull();
    });

    it("hides the reordered row's own caption and keeps the other targets'", () => {
        expect(zoneCaptionShown("tile", "tiles")).toBe(false);
        expect(zoneCaptionShown("tile", "top")).toBe(true);
        expect(zoneCaptionShown("top", "top")).toBe(false);
        expect(zoneCaptionShown("top", "tiles")).toBe(false);
        expect(zoneCaptionShown("row", "tiles")).toBe(true);
        expect(zoneCaptionShown("row", "top")).toBe(true);
    });
});

describe("⌘Z", () => {
    const key = (
        k: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>
    ) => ({
        key: "z",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...k,
    });

    it("is Command+Z on macOS and Ctrl+Z elsewhere, never with Shift", () => {
        expect(undoKey(key({ metaKey: true }), true)).toBe(true);
        expect(undoKey(key({ ctrlKey: true }), true)).toBe(false);
        expect(undoKey(key({ ctrlKey: true }), false)).toBe(true);
        expect(undoKey(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
        expect(undoKey(key({ key: "y", metaKey: true }), true)).toBe(false);
    });

    it("leaves a field, an editor or a terminal its own undo", () => {
        const el = (tagName: string, inside?: string) =>
            ({
                tagName,
                isContentEditable: false,
                closest: (sel: string) => (inside != null && sel.includes(inside) ? {} : null),
            }) as unknown as Element;
        expect(typesText(el("INPUT"))).toBe(true);
        expect(typesText(el("TEXTAREA"))).toBe(true);
        expect(typesText(el("DIV", ".xterm"))).toBe(true);
        expect(typesText(el("DIV", ".monaco-editor"))).toBe(true);
        expect(typesText(el("DIV"))).toBe(false);
        expect(typesText(null)).toBe(false);
    });
});
