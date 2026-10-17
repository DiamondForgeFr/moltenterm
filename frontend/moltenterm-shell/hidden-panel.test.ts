// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    leafs: new Map<string, string>(),
    blocks: new Map<string, MetaType>(),
    tabBlocks: [] as string[],
    actions: [] as any[],
    focused: [] as string[],
    metas: [] as any[],
    rootNode: { id: "root" } as any,
}));

vi.mock("@/app/store/global", () => ({ atoms: { staticTabId: "staticTabId" } }));
vi.mock("@/app/store/jotaiStore", () => ({
    globalStore: {
        get: (a: any) => {
            if (a === "staticTabId") {
                return "tab1";
            }
            if (a === "tab:tab1") {
                return { oid: "tab1", blockids: state.tabBlocks };
            }
            if (typeof a === "string" && a.startsWith("block:")) {
                const meta = state.blocks.get(a.slice(6));
                return meta ? { meta } : null;
            }
            return null;
        },
    },
}));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: (oref: string) => oref,
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { SetMetaCommand: async (_c: unknown, data: unknown) => state.metas.push(data) },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/layout/index", () => ({
    LayoutTreeActionType: { InsertNode: "insert", SplitVertical: "splitvertical" },
    newLayoutNode: (_a: unknown, _b: unknown, _c: unknown, data: { blockId: string }) => ({ id: "new", data }),
    getLayoutModelForStaticTab: () => ({
        treeState: { rootNode: state.rootNode },
        magnifiedNodeId: null,
        getNodeByBlockId: (blockId: string) => (state.leafs.has(blockId) ? { id: state.leafs.get(blockId) } : null),
        focusNode: (id: string) => state.focused.push(id),
        treeReducer: (action: any) => state.actions.push(action),
    }),
}));

import { showPanel } from "./hidden-panel";
import { HiddenMetaKey } from "./hidden-panel-meta";

describe("hidden panels (#916)", () => {
    beforeEach(() => {
        state.leafs = new Map([["ai", "node-ai"]]);
        state.blocks = new Map<string, MetaType>([
            ["session", { view: "term", [HiddenMetaKey]: true } as MetaType],
            ["plain", { view: "term" }],
        ]);
        state.tabBlocks = ["ai", "session", "plain"];
        state.actions = [];
        state.focused = [];
        state.metas = [];
        state.rootNode = { id: "root" };
    });

    it("splits a hidden panel under the given panel, focused, and clears its mark", async () => {
        expect(showPanel("session", "ai")).toBe(true);
        expect(state.actions).toEqual([
            {
                type: "splitvertical",
                targetNodeId: "node-ai",
                newNode: { id: "new", data: { blockId: "session" } },
                position: "after",
                focused: true,
            },
        ]);
        await Promise.resolve();
        expect(state.metas).toEqual([{ oref: "block:session", meta: { [HiddenMetaKey]: null } }]);
    });

    it("adds it when the given panel is not laid out", () => {
        expect(showPanel("session", "gone")).toBe(true);
        expect(state.actions.map((a) => a.type)).toEqual(["insert"]);
    });

    it("only focuses a panel already laid out", () => {
        state.leafs.set("session", "node-session");
        expect(showPanel("session", "ai")).toBe(true);
        expect(state.focused).toEqual(["node-session"]);
        expect(state.actions).toEqual([]);
    });

    it("never lays out a block that is not hidden, nor one of another tab, nor before the layout exists", () => {
        expect(showPanel("plain")).toBe(false);
        state.tabBlocks = ["ai"];
        expect(showPanel("session")).toBe(false);
        state.tabBlocks = ["ai", "session"];
        state.rootNode = null;
        expect(showPanel("session")).toBe(false);
        expect(state.actions).toEqual([]);
    });
});
