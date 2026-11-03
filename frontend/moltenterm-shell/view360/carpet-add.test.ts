// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addPickerColumn } from "../split/split";
import { addCarpetPanel } from "./carpet-add";
import { computeCarpetLayout } from "./carpet-model";

vi.mock("../split/split", () => ({ addPickerColumn: vi.fn(() => Promise.resolve("new-block")) }));
vi.mock("@/app/store/global", () => ({ getFocusedBlockId: () => "focused-block" }));

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function carpetModel(): LayoutModel {
    const root: LayoutNode = {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: [leaf("term"), leaf("a"), leaf("b"), leaf("c")],
    };
    const layout = computeCarpetLayout({
        width: 1600,
        height: 900,
        fixedNodeId: "term",
        fixedPx: 600,
        columns: ["a", "b", "c"].map((nodeId) => ({ nodeId, widthPx: 484 })),
    });
    return { moltenView360: { layout }, treeState: { rootNode: root } } as unknown as LayoutModel;
}

// What the picker is asked: the panel it takes its context from, and where the new column goes.
function pickerCall() {
    const [, blockId, place] = vi.mocked(addPickerColumn).mock.calls[0];
    return { blockId, place: place() };
}

describe("adding a panel at an end of the carpet (#702, #1836)", () => {
    beforeEach(() => {
        vi.mocked(addPickerColumn).mockClear();
    });

    it("opens the picker for a column right before the first carpet column from the start slot", async () => {
        await addCarpetPanel(carpetModel(), "start");
        expect(pickerCall()).toEqual({ blockId: "b-a", place: { targetNodeId: "a", position: "before" } });
    });

    it("opens the picker for a column right after the last carpet column from the end slot", async () => {
        await addCarpetPanel(carpetModel(), "end");
        expect(pickerCall()).toEqual({ blockId: "b-c", place: { targetNodeId: "c", position: "after" } });
    });

    it("does nothing outside 360 view", async () => {
        const model = { moltenView360: { layout: null }, treeState: { rootNode: null } } as unknown as LayoutModel;
        expect(await addCarpetPanel(model, "end")).toBeNull();
        expect(addPickerColumn).not.toHaveBeenCalled();
    });
});
