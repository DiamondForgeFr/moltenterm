// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitPanel } from "./split";
import {
    cancelSplitPlacement,
    confirmSplitPlacement,
    enterSplitPlacement,
    enterSplitPlacementFocused,
    setSplitPlacementSide,
    splitPlacementAtom,
} from "./split-place";

vi.mock("@/app/store/global", () => ({ getFocusedBlockId: () => "focused" }));
vi.mock("./split", () => ({ splitPanel: vi.fn(() => Promise.resolve("new")) }));

describe("split placement mode (#677)", () => {
    beforeEach(() => {
        globalStore.set(splitPlacementAtom, null);
        vi.mocked(splitPanel).mockClear();
    });

    it("splits on the side chosen with the pointer or the arrows", () => {
        enterSplitPlacement("b1");
        expect(globalStore.get(splitPlacementAtom)).toEqual({ blockId: "b1", side: null });
        setSplitPlacementSide("up");
        confirmSplitPlacement();
        expect(splitPanel).toHaveBeenCalledWith("b1", "up");
        expect(globalStore.get(splitPlacementAtom)).toBe(null);
    });

    it("splits on the clicked zone, whatever was chosen before", () => {
        enterSplitPlacement("b1", "right");
        confirmSplitPlacement("left");
        expect(splitPanel).toHaveBeenCalledWith("b1", "left");
    });

    it("starts with a side already chosen", () => {
        enterSplitPlacement("b1", "left");
        confirmSplitPlacement();
        expect(splitPanel).toHaveBeenCalledWith("b1", "left");
    });

    it("does nothing on Enter before a side is chosen, and nothing after a cancel", () => {
        enterSplitPlacement("b1");
        confirmSplitPlacement();
        expect(splitPanel).not.toHaveBeenCalled();
        expect(globalStore.get(splitPlacementAtom)).not.toBe(null);
        cancelSplitPlacement();
        confirmSplitPlacement("down");
        expect(splitPanel).not.toHaveBeenCalled();
    });

    it("enters the mode on the focused panel for the keys", () => {
        enterSplitPlacementFocused();
        expect(globalStore.get(splitPlacementAtom)).toEqual({ blockId: "focused", side: null });
    });
});
