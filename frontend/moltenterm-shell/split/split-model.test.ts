// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    newTerminalBlockDef,
    panelKindRank,
    pickerBlockDef,
    pickerFitsInline,
    PickerMinPx,
    PickerMinRows,
    pickerPopoverRect,
    PickerPopoverWidthPx,
    PickerRowPx,
    pickerSourceMeta,
    sourceContext,
    splitAxis,
    SplitFromMetaKey,
    SplitNewPanelMetaKey,
    splitSizes,
    terminalBlockDefFrom,
} from "./split-model";

// FR-SHELL-009 (#1839): a new terminal or file panel starts in the workspace folder, which wavesrv fills in for a
// block without a folder of its own (pkg/wcore/moltenterm_folder.go): the active project's, home without one. Only a
// split carries the source panel's folder.
describe("what a new panel takes from the panel it opens from (FR-SHELL-009, #1839)", () => {
    const HomeTerminal = { view: "term", controller: "shell", "cmd:cwd": "/home/me", connection: "local" };

    it("keeps the source's folder for a split", () => {
        expect(sourceContext(HomeTerminal, true)).toEqual({ view: "term", "cmd:cwd": "/home/me", connection: "local" });
    });

    it("keeps only the connection for a new panel, so it starts in the workspace folder", () => {
        expect(sourceContext(HomeTerminal, false)).toEqual({ view: "term", connection: "local" });
        expect(sourceContext({ view: "term", "cmd:cwd": "/x" }, false)).toEqual({ view: "term" });
        expect(sourceContext(null, false)).toEqual({ view: undefined });
    });

    it("opens ⌘T's direct terminal without the focused terminal's folder (getDefaultNewBlockDef)", () => {
        expect(newTerminalBlockDef(HomeTerminal)).toEqual({
            meta: { view: "term", controller: "shell", connection: "local" },
        });
        expect(newTerminalBlockDef({ view: "preview", file: "/x", connection: "dev@box" })).toEqual({
            meta: { view: "term", controller: "shell", connection: "dev@box" },
        });
        expect(newTerminalBlockDef(null)).toEqual({ meta: { view: "term", controller: "shell" } });
    });

    it("marks the picker of a new column (carpet end, Add a panel on the left / right), not a split's", () => {
        expect(pickerBlockDef("src", false)).toEqual({ meta: { view: "launcher", [SplitFromMetaKey]: "src" } });
        expect(pickerBlockDef("src", true)).toEqual({
            meta: { view: "launcher", [SplitFromMetaKey]: "src", [SplitNewPanelMetaKey]: true },
        });
    });

    it("gives a split's picker the source's folder, a new column's picker only its connection", () => {
        const split = { view: "launcher", [SplitFromMetaKey]: "src" };
        const column = { ...split, [SplitNewPanelMetaKey]: true };
        expect(pickerSourceMeta(split, HomeTerminal)).toEqual({
            view: "term",
            "cmd:cwd": "/home/me",
            connection: "local",
        });
        expect(pickerSourceMeta(column, HomeTerminal)).toEqual({ view: "term", connection: "local" });
    });
});

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
