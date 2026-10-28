// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { splitHorizontal } from "@/layout/lib/layoutTree";
import { FlexDirection, type LayoutNode, type LayoutTreeState } from "@/layout/lib/types";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rowEqualizeOps } from "../equalize/equalize-rules";
import { ChooserBlockDef, newViewChoices, TerminalChoiceId, WebPageChoiceId } from "../newview/new-view-model";
import type { CarpetLayout } from "../view360/carpet-model";
import { newPanelContent, newPanelSplit, newPanelTarget, type PointerHit } from "./new-panel-model";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

function leaf(id: string, size = 50): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function node(id: string, dir: FlexDirection, children: LayoutNode[], size = 50): LayoutNode {
    return { id, flexDirection: dir, size, children };
}

function layout360(fixed: string[], carpet: string[]): CarpetLayout {
    return {
        fixedNodeId: fixed[0],
        fixedColumns: fixed.map((nodeId, i) => ({
            nodeId,
            mode: i === 0 ? "first" : "beside",
            rect: { top: 0, left: 0, width: 0, height: 0 },
        })),
        columns: carpet.map((nodeId, i) => ({ nodeId, x: i * 100, width: 100 })),
    } as CarpetLayout;
}

// Runs ⌘N's split and row equalize on a tree as the layout does, and returns the root.
function openBeside(root: LayoutNode, nodeId: string, side: "left" | "right"): LayoutNode {
    const split = newPanelSplit(root, nodeId, side, null, false);
    const state = { rootNode: root } as LayoutTreeState;
    const newNode = leaf("new", 10);
    splitHorizontal(state, {
        type: "splithorizontal",
        targetNodeId: split.targetNodeId,
        newNode,
        position: split.position,
    } as any);
    for (const op of rowEqualizeOps(state.rootNode, newNode.id)) {
        const find = (n: LayoutNode): LayoutNode =>
            n.id === op.nodeId ? n : (n.children ?? []).map(find).find((x) => x != null);
        find(state.rootNode).size = op.size;
    }
    return state.rootNode;
}

describe("which panel and which side (#1241)", () => {
    const hit: PointerHit = { blockId: "left", left: 100, width: 400 };

    it("goes on the left of the panel under the pointer when the pointer is in its left half", () => {
        expect(newPanelTarget(hit, 120, "focused")).toEqual({ blockId: "left", side: "left" });
        expect(newPanelTarget(hit, 299, "focused")).toEqual({ blockId: "left", side: "left" });
    });

    it("goes on the right of it when the pointer is in its right half", () => {
        expect(newPanelTarget(hit, 300, "focused")).toEqual({ blockId: "left", side: "right" });
        expect(newPanelTarget(hit, 480, "focused")).toEqual({ blockId: "left", side: "right" });
    });

    it("goes right of the focused panel when the pointer is over no panel", () => {
        expect(newPanelTarget(null, 0, "focused")).toEqual({ blockId: "focused", side: "right" });
        expect(newPanelTarget(null, undefined, "focused")).toEqual({ blockId: "focused", side: "right" });
        expect(newPanelTarget(null, 0, null)).toBeNull();
    });
});

describe("the split and the row's widths (#1241)", () => {
    it("puts the new panel between two columns and gives the three of them 1/3 each", () => {
        const root = openBeside(node("root", FlexDirection.Row, [leaf("a", 70), leaf("b", 30)]), "a", "right");
        expect(root.children.map((c) => c.id)).toEqual(["a", "new", "b"]);
        for (const c of root.children) {
            expect(c.size).toBeCloseTo(100 / 3);
        }
    });

    it("puts it before the panel from its left half", () => {
        const root = openBeside(node("root", FlexDirection.Row, [leaf("a"), leaf("b")]), "a", "left");
        expect(root.children.map((c) => c.id)).toEqual(["new", "a", "b"]);
    });

    it("keeps a stacked column's inner heights", () => {
        const stack = node("stack", FlexDirection.Column, [leaf("s1", 80), leaf("s2", 20)], 40);
        const root = openBeside(node("root", FlexDirection.Row, [leaf("a", 60), stack]), "a", "right");
        expect(root.children.map((c) => c.id)).toEqual(["a", "new", "stack"]);
        for (const c of root.children) {
            expect(c.size).toBeCloseTo(100 / 3);
        }
        expect(stack.children.map((c) => c.size)).toEqual([80, 20]);
    });

    it("evens out only the row the new panel joins, not the other rows", () => {
        const top = node("top", FlexDirection.Row, [leaf("t1", 70), leaf("t2", 30)], 60);
        const bottom = node("bottom", FlexDirection.Row, [leaf("u1", 90), leaf("u2", 10)], 40);
        const root = openBeside(node("root", FlexDirection.Column, [top, bottom]), "u1", "right");
        expect(top.children.map((c) => c.size)).toEqual([70, 30]);
        expect(root.children.map((c) => c.size)).toEqual([60, 40]);
        expect(bottom.children.map((c) => c.id)).toEqual(["u1", "new", "u2"]);
        for (const c of bottom.children) {
            expect(c.size).toBeCloseTo(100 / 3);
        }
    });

    it("splits a lone panel into a row of two halves", () => {
        const root = openBeside(leaf("a", 100), "a", "right");
        expect(root.children.map((c) => c.id)).toEqual(["a", "new"]);
        expect(root.children.map((c) => c.size)).toEqual([50, 50]);
    });
});

describe("in 360 view (#1241)", () => {
    const stack = node("stack", FlexDirection.Column, [leaf("b1"), leaf("b2")]);
    const tree = node("root", FlexDirection.Row, [leaf("a"), leaf("p"), stack, leaf("c")]);
    const layout = layout360(["a", "p"], ["stack", "c"]);

    it("puts the new panel beside the carpet column under the pointer, widths untouched", () => {
        expect(newPanelSplit(tree, "b2", "left", layout, true)).toEqual({
            targetNodeId: "stack",
            position: "before",
            equalizeRow: false,
        });
        expect(newPanelSplit(tree, "c", "right", layout, true)).toEqual({
            targetNodeId: "c",
            position: "after",
            equalizeRow: false,
        });
    });

    it("puts it at the start of the carpet from the fixed zone, whichever half", () => {
        const start = { targetNodeId: "stack", position: "before", equalizeRow: false };
        expect(newPanelSplit(tree, "a", "left", layout, true)).toEqual(start);
        expect(newPanelSplit(tree, "a", "right", layout, true)).toEqual(start);
        expect(newPanelSplit(tree, "p", "left", layout, true)).toEqual(start);
    });

    it("lets the 360 view lay it out without evening the row while the tab wants 360 view but is not drawn in it", () => {
        expect(newPanelSplit(tree, "c", "right", null, true)).toEqual({
            targetNodeId: "c",
            position: "after",
            equalizeRow: false,
        });
    });
});

describe("what the new panel holds (#1241, FR-SHELL-089)", () => {
    const choices = newViewChoices({ presets: DefaultAgents, widgets: DefaultWidgets, workspaceId: "ws1" });

    it("opens the chooser by default and for an unknown type", () => {
        expect(newPanelContent(undefined, choices)).toEqual({ kind: "block", blockdef: ChooserBlockDef });
        expect(newPanelContent("panel:gone", choices)).toEqual({ kind: "block", blockdef: ChooserBlockDef });
    });

    it("opens today's terminal directly when the setting is Terminal", () => {
        expect(newPanelContent(TerminalChoiceId, choices)).toEqual({ kind: "terminal" });
    });

    it("opens another type directly, without the chooser", () => {
        const content = newPanelContent(WebPageChoiceId, choices);
        expect(content.kind).toBe("block");
        expect((content as { blockdef: BlockDef }).blockdef.meta.view).toBe("molten-browser");
    });

    it("runs an entry that opens nothing in a panel", () => {
        const linked = newViewChoices({
            presets: DefaultAgents,
            widgets: DefaultWidgets,
            workspaceId: "ws1",
            projectLinked: true,
        });
        expect(newPanelContent("action:projecttab", linked).kind).toBe("run");
    });

    it("opens Sessions as a panel, also for a choice saved when it was an action (#1273)", () => {
        const content = newPanelContent("action:sessions", choices);
        expect(content.kind).toBe("block");
        expect((content as { blockdef: BlockDef }).blockdef.meta.view).toBe("molten-sessions");
    });
});
