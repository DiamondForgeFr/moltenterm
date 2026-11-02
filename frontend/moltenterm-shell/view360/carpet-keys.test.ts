// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { atom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { registerCarpetKeys, stepCarpet } from "./carpet-keys";

const Columns = ["c1", "c2", "c3"];

vi.mock("@/layout/lib/layoutModelHooks", () => ({ getLayoutModelForStaticTab: () => null }));
vi.mock("./radar-store", () => ({
    makeRadarFactsAtom: () => atom({}),
    radarColumns: () => Columns.map((id) => ({ columnId: id, leaves: [{ nodeId: `n-${id}`, blockId: `b-${id}` }] })),
}));

// A tab in 360 view with three carpet columns, the focus on the node given (null: in the fixed zone).
function layoutModelOn(focusNodeId: string, in360 = true) {
    const focusedNode = atom(focusNodeId == null ? null : { id: focusNodeId });
    const scrollToColumn = vi.fn();
    const focusNode = vi.fn();
    const layoutModel = {
        focusedNode,
        focusNode,
        treeState: { rootNode: { id: "root" } },
        moltenView360: in360
            ? {
                  layout: { columns: Columns.map((nodeId) => ({ nodeId })) },
                  visibleColumnIdsAtom: atom(["c2"]),
                  carpetColumnOf: (nodeId: string) => (nodeId?.startsWith("n-") ? nodeId.slice(2) : null),
                  scrollToColumn,
              }
            : null,
    } as unknown as LayoutModel;
    return { layoutModel, scrollToColumn, focusNode };
}

describe("the carpet's tab keys (FR-SHELL-126-AC1)", () => {
    it("binds Ctrl+Tab, Ctrl+Shift+Tab and the PageUp / PageDown keys that stay", () => {
        const keyMap = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerCarpetKeys(keyMap);
        expect([...keyMap.keys()].sort()).toEqual(
            ["Ctrl:Shift:PageDown", "Ctrl:Shift:PageUp", "Ctrl:Shift:Tab", "Ctrl:Tab"].sort()
        );
    });

    it("moves to the next and the previous panel and brings it into view", () => {
        const { layoutModel, scrollToColumn, focusNode } = layoutModelOn("n-c2");
        expect(stepCarpet(layoutModel, 1)).toBe(true);
        expect(scrollToColumn).toHaveBeenLastCalledWith("c3");
        expect(focusNode).toHaveBeenLastCalledWith("n-c3");
        expect(stepCarpet(layoutModel, -1)).toBe(true);
        expect(scrollToColumn).toHaveBeenLastCalledWith("c1");
        expect(focusNode).toHaveBeenLastCalledWith("n-c1");
    });

    it("wraps from the last panel to the first and back", () => {
        const last = layoutModelOn("n-c3");
        expect(stepCarpet(last.layoutModel, 1)).toBe(true);
        expect(last.focusNode).toHaveBeenLastCalledWith("n-c1");
        const first = layoutModelOn("n-c1");
        expect(stepCarpet(first.layoutModel, -1)).toBe(true);
        expect(first.focusNode).toHaveBeenLastCalledWith("n-c3");
    });

    it("leaves the agent's fixed zone out of the cycle, entering at the first panel in view or the last panel", () => {
        const next = layoutModelOn("fixed");
        expect(stepCarpet(next.layoutModel, 1)).toBe(true);
        expect(next.focusNode).toHaveBeenLastCalledWith("n-c2");
        const previous = layoutModelOn(null);
        expect(stepCarpet(previous.layoutModel, -1)).toBe(true);
        expect(previous.focusNode).toHaveBeenLastCalledWith("n-c3");
    });

    it("captures nothing outside 360 view, so the key reaches the panel", () => {
        const { layoutModel, scrollToColumn, focusNode } = layoutModelOn("n-c1", false);
        expect(stepCarpet(layoutModel, 1)).toBe(false);
        expect(stepCarpet(layoutModel, -1)).toBe(false);
        expect(stepCarpet(null, 1)).toBe(false);
        expect(scrollToColumn).not.toHaveBeenCalled();
        expect(focusNode).not.toHaveBeenCalled();
    });
});
