// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    clampFraction,
    dragFraction,
    handlesAllowed,
    MinPanelPx,
    nearEdge,
    panelKindRank,
    pickerFitsInline,
    PickerMinPx,
    PickerMinRows,
    pickerPopoverRect,
    PickerPopoverWidthPx,
    PickerRowPx,
    splitAxis,
    splitHandleText,
    splitSizes,
    terminalBlockDefFrom,
} from "./split-model";

describe("split directions", () => {
    it("maps right and down to Wave's horizontal and vertical splits after the panel", () => {
        expect(splitAxis("right")).toEqual({ axis: "horizontal", position: "after" });
        expect(splitAxis("down")).toEqual({ axis: "vertical", position: "after" });
        expect(splitAxis("left")).toEqual({ axis: "horizontal", position: "before" });
        expect(splitAxis("up")).toEqual({ axis: "vertical", position: "before" });
    });
});

describe("split sizes (FR-SHELL-042-AC2)", () => {
    it("gives the new panel its share of the source only", () => {
        expect(splitSizes(10, 0.5)).toEqual({ source: 5, added: 5 });
        const third = splitSizes(9, 1 / 3);
        expect(third.source).toBeCloseTo(6);
        expect(third.added).toBeCloseTo(3);
    });

    it("keeps both panels above the layout's minimum", () => {
        expect(clampFraction(0.01, 400)).toBeCloseTo(MinPanelPx / 400);
        expect(clampFraction(0.99, 400)).toBeCloseTo(1 - MinPanelPx / 400);
        expect(clampFraction(0.3, 400)).toBe(0.3);
    });

    it("splits a panel too small for two in half", () => {
        expect(clampFraction(0.2, 60)).toBe(0.5);
        expect(clampFraction(NaN, 400)).toBe(0.5);
    });

    it("reads the new panel's share from where the drag was released", () => {
        expect(dragFraction("right", 300, 0, 400)).toBe(0.25);
        expect(dragFraction("down", 100, 0, 400)).toBe(0.75);
        expect(dragFraction("right", 10, 0, 0)).toBe(0.5);
    });
});

describe("edge handles (DS-SHELL-065)", () => {
    it("finds the right or bottom edge within the hot zone, past the gutter inset", () => {
        expect(nearEdge(395, 100, 400, 300, 12, 2)).toBe("right");
        expect(nearEdge(100, 290, 400, 300, 12, 2)).toBe("down");
        expect(nearEdge(399, 100, 400, 300, 12, 2)).toBe(null);
        expect(nearEdge(200, 150, 400, 300, 12, 2)).toBe(null);
        expect(nearEdge(-1, 150, 400, 300, 12, 2)).toBe(null);
    });

    it("gives the corner to the nearer edge", () => {
        expect(nearEdge(396, 290, 400, 300, 12, 2)).toBe("right");
        expect(nearEdge(390, 296, 400, 300, 12, 2)).toBe("down");
    });

    it("hides the handles while magnified, resizing, in a preview, or when a split would not fit", () => {
        const base = { preview: false, ephemeral: false, magnified: false, resizing: false, width: 400, height: 300 };
        expect(handlesAllowed({ ...base, edge: "right" })).toBe(true);
        expect(handlesAllowed({ ...base, magnified: true, edge: "right" })).toBe(false);
        expect(handlesAllowed({ ...base, resizing: true, edge: "down" })).toBe(false);
        expect(handlesAllowed({ ...base, preview: true, edge: "down" })).toBe(false);
        expect(handlesAllowed({ ...base, ephemeral: true, edge: "down" })).toBe(false);
        expect(handlesAllowed({ ...base, width: 70, edge: "right" })).toBe(false);
        expect(handlesAllowed({ ...base, width: 70, edge: "down" })).toBe(true);
    });
});

describe("the picker's terminal (FR-SHELL-042-AC7)", () => {
    it("starts in the source terminal's folder and on its connection", () => {
        expect(terminalBlockDefFrom({ view: "term", "cmd:cwd": "/src/app", connection: "dev@box" })).toEqual({
            meta: { view: "term", controller: "shell", "cmd:cwd": "/src/app", connection: "dev@box" },
        });
    });

    it("keeps a non-terminal source's connection and leaves the folder to the workspace", () => {
        expect(terminalBlockDefFrom({ view: "preview", "cmd:cwd": "/x", connection: "dev@box" })).toEqual({
            meta: { view: "term", controller: "shell", connection: "dev@box" },
        });
        expect(terminalBlockDefFrom(null)).toEqual({ meta: { view: "term", controller: "shell" } });
    });

    it("orders the panel kinds with the terminal first and custom widgets last", () => {
        expect(panelKindRank("term")).toBe(0);
        expect(panelKindRank("molten-browser")).toBeLessThan(panelKindRank("preview"));
        expect(panelKindRank("molten-sessions")).toBeLessThan(panelKindRank("sysinfo"));
        expect(panelKindRank("my-widget")).toBeGreaterThan(panelKindRank("processviewer"));
        expect(panelKindRank("molten-linemap")).toBe(panelKindRank("molten-project") + 1);
    });
});

describe("the edge handle's tooltip (FR-SHELL-046-AC2, DS-SHELL-083)", () => {
    it("names the split, its keys and the drag", () => {
        expect(splitHandleText("right", "⌘D")).toEqual({ label: "Split right", tip: "Split right ⌘D · drag to size" });
        expect(splitHandleText("down", "⇧⌘D").tip).toBe("Split down ⇧⌘D · drag to size");
        expect(splitHandleText("down", "").tip).toBe("Split down · drag to size");
    });
});

describe("the picker's minimum height (FR-SHELL-046-AC6, DS-SHELL-084)", () => {
    it("stays in the panel only with room for six rows", () => {
        expect(PickerMinPx).toBeGreaterThanOrEqual(PickerMinRows * PickerRowPx);
        expect(pickerFitsInline(PickerMinPx)).toBe(true);
        expect(pickerFitsInline(PickerMinPx - 1)).toBe(false);
    });

    it("opens the popover on the new panel, inside the window", () => {
        const win = { width: 1400, height: 900 };
        expect(pickerPopoverRect({ left: 700, top: 300, width: 700 }, win)).toEqual({
            left: 870,
            top: 300,
            width: PickerPopoverWidthPx,
            height: PickerMinPx,
        });
        const low = pickerPopoverRect({ left: 1300, top: 860, width: 100 }, win);
        expect(low.left + low.width).toBeLessThanOrEqual(win.width - 8);
        expect(low.top + low.height).toBeLessThanOrEqual(win.height - 8);
        const tiny = pickerPopoverRect({ left: 0, top: 0, width: 100 }, { width: 300, height: 200 });
        expect(tiny).toEqual({ left: 8, top: 8, width: 284, height: 184 });
    });
});
