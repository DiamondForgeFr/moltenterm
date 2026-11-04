// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where the panel a call to action opens is laid (#1844, FR-SHELL-139 AC13, FR-SHELL-065 AC17): a column to the right
// of the panel's own, in the normal layout and in 360 view, on a faked layout.

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CarpetLayout } from "../view360/carpet-model";
import type { ColumnPlace } from "./add-beside-model";

const env = vi.hoisted(() => ({
    layout: null as any,
    added: [] as { blockDef: BlockDef; place: () => ColumnPlace }[],
}));

vi.mock("@/layout/index", () => ({ getLayoutModelForStaticTab: () => env.layout }));
vi.mock("./split", () => ({
    addPickerColumn: async () => null,
    addPanelColumn: async (_layoutModel: unknown, blockDef: BlockDef, place: () => ColumnPlace) => {
        env.added.push({ blockDef, place });
        return "new-block";
    },
}));

import { openPanelBeside } from "./add-beside";

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function row(...children: LayoutNode[]): LayoutNode {
    return { id: "root", flexDirection: FlexDirection.Row, size: 10, children };
}

// "a" in the fixed zone, "b" and "c" on the carpet.
function layout360(): CarpetLayout {
    return {
        fixedNodeId: "a",
        fixedColumns: [{ nodeId: "a", mode: "first", rect: { top: 0, left: 0, width: 0, height: 0 } }],
        columns: [
            { nodeId: "b", x: 0, width: 100 },
            { nodeId: "c", x: 100, width: 100 },
        ],
    } as CarpetLayout;
}

function fakeLayout(root: LayoutNode, view360: object = undefined) {
    const nodes = new Map<string, LayoutNode>();
    const walk = (node: LayoutNode) => {
        if (node.data?.blockId) {
            nodes.set(node.data.blockId, node);
        }
        node.children?.forEach(walk);
    };
    walk(root);
    return {
        treeState: { rootNode: root },
        magnifiedNodeId: null as string,
        magnifyNodeToggle: vi.fn(),
        getNodeByBlockId: (blockId: string) => nodes.get(blockId) ?? null,
        displayContainerRef: { current: null },
        moltenView360: view360,
    };
}

const CicdDef = { meta: { view: "molten-cicd" } } as BlockDef;

beforeEach(() => {
    env.added = [];
});

describe("openPanelBeside", () => {
    it("lays the panel in a column right after the column of the panel it opens from, in the normal layout", async () => {
        env.layout = fakeLayout(row(leaf("a"), leaf("b"), leaf("c")));
        expect(await openPanelBeside("b-b", CicdDef)).toBe("new-block");
        expect(env.added).toHaveLength(1);
        expect(env.added[0].blockDef).toBe(CicdDef);
        expect(env.added[0].place()).toMatchObject({ targetNodeId: "b", position: "after" });
    });

    it("lays it after the whole vertical stack the panel is in, a stack counting as one column", async () => {
        const stack: LayoutNode = {
            id: "stack",
            flexDirection: FlexDirection.Column,
            size: 10,
            children: [leaf("s1"), leaf("s2")],
        };
        env.layout = fakeLayout(row(leaf("a"), stack, leaf("c")));
        await openPanelBeside("b-s1", CicdDef);
        expect(env.added[0].place()).toMatchObject({ targetNodeId: "stack", position: "after" });
    });

    it("in 360 view, right after the column of a carpet panel", async () => {
        env.layout = fakeLayout(row(leaf("a"), leaf("b"), leaf("c")), { layout: layout360(), wanted: true });
        await openPanelBeside("b-b", CicdDef);
        expect(env.added[0].place()).toEqual({ targetNodeId: "b", position: "after" });
    });

    it("in 360 view, from the fixed zone, first on the carpet", async () => {
        env.layout = fakeLayout(row(leaf("a"), leaf("b"), leaf("c")), { layout: layout360(), wanted: true });
        await openPanelBeside("b-a", CicdDef);
        expect(env.added[0].place()).toEqual({ targetNodeId: "b", position: "before" });
    });

    it("brings a magnified panel back to the layout first, or the new one would open out of sight", async () => {
        env.layout = fakeLayout(row(leaf("a"), leaf("b")));
        env.layout.magnifiedNodeId = "b";
        env.layout.magnifyNodeToggle = vi.fn(() => {
            env.layout.magnifiedNodeId = null;
        });
        expect(await openPanelBeside("b-b", CicdDef)).toBe("new-block");
        expect(env.layout.magnifyNodeToggle).toHaveBeenCalledWith("b", false);
    });

    it("opens nothing for a panel that is not in the layout", async () => {
        env.layout = fakeLayout(row(leaf("a"), leaf("b")));
        expect(await openPanelBeside("b-zz", CicdDef)).toBe(null);
        expect(env.added).toEqual([]);
    });
});
