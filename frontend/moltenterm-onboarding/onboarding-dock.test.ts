// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { splitHorizontal } from "@/layout/lib/layoutTree";
import { FlexDirection, LayoutNode, LayoutTreeActionType, LayoutTreeState } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import { dockAction, PanelNodeSize } from "./onboarding-dock";

function leaf(id: string, blockId: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Row, size: 10, data: { blockId } };
}

describe("docking the first-run panel", () => {
    it("splits the root node before it, focused", () => {
        const node = leaf("panel", "b-panel");
        expect(dockAction("root", node)).toEqual({
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: "root",
            newNode: node,
            position: "before",
            focused: true,
        });
    });

    it("lands on the left of everything already in the tab, along its whole height", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Column,
            size: 10,
            children: [leaf("a", "b-a"), leaf("b", "b-b")],
        };
        const state = { rootNode: root, focusedNodeId: "a" } as LayoutTreeState;
        const panel = { ...leaf("panel", "b-panel"), size: PanelNodeSize };
        splitHorizontal(state, dockAction("root", panel));
        expect(state.rootNode.flexDirection).toBe(FlexDirection.Row);
        expect(state.rootNode.children.map((c) => c.id)).toEqual(["panel", "root"]);
        expect(state.focusedNodeId).toBe("panel");
    });
});
