// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// One rule for every panel added (FR-SHELL-042 AC-grid, FR-SHELL-123 AC17, #2433). These tests drive the real
// LayoutModel: every way of adding a panel ends in its treeReducer, so the entry points are tested through the kinds of
// actions they send, and through the backend's queued actions, which the layout replays with handleBackendAction.

import { globalStore } from "@/app/store/jotaiStore";
import { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode, newLayoutNode } from "@/layout/lib/layoutNode";
import {
    DefaultNodeSize,
    FlexDirection,
    LayoutTreeActionType,
    type LayoutNode,
    type LayoutTreeInsertNodeAction,
    type LayoutTreeInsertNodeAtIndexAction,
    type LayoutTreeSplitHorizontalAction,
    type LayoutTreeSplitVerticalAction,
} from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { visibleCarpetColumnIds } from "../view360/carpet-model";
import { FirstColumnMinPx } from "../view360/view360-decision";
import { View360MetaKey, View360PlacesMetaKey } from "../view360/view360-meta";

const settingAtom = vi.hoisted(() => ({ current: null as unknown }));
const floor = vi.hoisted(() => ({ px: null as number }));
// The view of a block, "web" unless a test says otherwise (a terminal is the agent's).
const views = vi.hoisted(() => ({ byBlock: {} as Record<string, string> }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settingAtom.current = atom<string>("auto");
    return {
        getSettingsKeyAtom: () => settingAtom.current,
        WOS: { makeORef: () => "", getObjectValue: () => null },
    };
});
vi.mock("@/app/store/focusManager", () => ({ FocusManager: { getInstance: () => ({ requestNodeFocus: vi.fn() }) } }));
vi.mock("@/app/store/services", () => ({ BlockService: { CleanupOrphanedBlocks: vi.fn() } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (type: string, id: string) => `${type}:${id}`,
    loadAndPinWaveObject: vi.fn(() => Promise.resolve(null)),
    getObjectValue: vi.fn(() => null),
    reloadWaveObject: vi.fn(() => Promise.resolve(null)),
    setObjectValue: vi.fn(),
}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/layout/lib/layoutAtom", async () => {
    const { atom } = await import("jotai");
    return { getLayoutStateAtomFromTab: () => atom({ pendingbackendactions: [] }) };
});
vi.mock("../toast-store", () => ({ showToast: vi.fn(() => "toast:1") }));
vi.mock("../panel-motion/panel-arrival-model", () => ({ notePanelsArrived: vi.fn() }));
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: (blockId: string) => views.byBlock[blockId] ?? "web",
    currentPanelSizes: () => ({}),
    currentFirstColumnFloorPx: () => floor.px,
    clearFirstColumnFloor: vi.fn(),
    setFirstColumnFloor: vi.fn(),
    rememberPanelWidth: vi.fn(),
    applyRememberedPanelSizes: vi.fn(),
    recordDraggedPanelSizes: vi.fn(),
    addedBlockId: (action: { type?: string; node?: LayoutNode; newNode?: LayoutNode }) =>
        action?.node?.data?.blockId ?? action?.newNode?.data?.blockId ?? null,
}));
const screenThreshold = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("../view360/screen-store", async () => {
    const { atom } = await import("jotai");
    screenThreshold.atom = atom(8);
    const { makeFakeScreens } = await import("../view360/screen-store-fake");
    return { ScreenModel: { getInstance: () => makeFakeScreens(screenThreshold.atom) } };
});
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

const Width = 2400;

function leaf(id: string, size = 50): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function group(id: string, dir: FlexDirection, children: LayoutNode[], size = 50): LayoutNode {
    return { id, flexDirection: dir, size, children };
}

function row(...ids: string[]): LayoutNode {
    return group(
        "root",
        FlexDirection.Row,
        ids.map((id) => leaf(id, 100 / ids.length)),
        100
    );
}

// A layout model on a tree, drawn at the given width (the real constructor, the real treeReducer and updateTree).
function makeLayout(root: LayoutNode, meta: Record<string, unknown> = {}, focusedId: string = null, width = Width) {
    const tabAtom = atom({ oid: "tab-1", layoutstate: "layout-1", meta } as unknown as Tab) as PrimitiveAtom<Tab>;
    const model = new LayoutModel(tabAtom, globalStore.get, globalStore.set);
    model.treeState = { rootNode: root, focusedNodeId: focusedId } as typeof model.treeState;
    globalStore.set(model["localTreeStateAtom"], { ...model.treeState });
    model.displayContainerRef = {
        current: { getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 900 }) },
    } as never;
    model.updateTree();
    return model;
}

function newLeaf(id: string, size?: number): LayoutNode {
    const node = newLayoutNode(undefined, size, undefined, { blockId: `b-${id}` });
    node.id = id;
    return node;
}

function shape(node: LayoutNode): string {
    return node.children?.length
        ? `${node.flexDirection === FlexDirection.Row ? "row" : "col"}(${node.children.map(shape).join(",")})`
        : node.id;
}

function sizesOf(parent: LayoutNode): number[] {
    return parent.children.map((c) => c.size);
}

function expectEven(parent: LayoutNode) {
    for (const size of sizesOf(parent)) {
        expect(size).toBeCloseTo(100 / parent.children.length, 5);
    }
}

beforeEach(() => {
    floor.px = null;
    views.byBlock = {};
});

describe("outside the 360 view, every kind of action rebalances the row the panel joined (FR-SHELL-042 AC-grid)", () => {
    const actions: Record<string, (node: LayoutNode) => unknown> = {
        // createBlock, the "+" buttons, the palette, a page, a file or a tab opened as a panel, an agent's panel.
        insert: (node) =>
            ({ type: LayoutTreeActionType.InsertNode, node, focused: true }) as LayoutTreeInsertNodeAction,
        // A reopened panel, a panel the backend places at an index.
        insertAtIndex: (node) =>
            ({
                type: LayoutTreeActionType.InsertNodeAtIndex,
                node,
                indexArr: [0],
                focused: true,
            }) as LayoutTreeInsertNodeAtIndexAction,
        // ⌘T, Add a panel on the left or right, the split menus, createBlockSplitHorizontally, a drop beside a panel.
        splitHorizontal: (node) =>
            ({
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "b",
                newNode: node,
                position: "after",
                focused: true,
            }) as LayoutTreeSplitHorizontalAction,
    };

    for (const [name, make] of Object.entries(actions)) {
        it(`${name}: a row of 3 becomes a row of 4 panels of the same width`, () => {
            const model = makeLayout(row("a", "b", "c"));
            model.treeReducer(make(newLeaf("n")) as never, false);
            const root = model.treeState.rootNode;
            expect(root.children.length).toBe(4);
            expectEven(root);
        });
    }

    it("a row of N becomes N + 1 panels of equal width, whichever the starting sizes", () => {
        for (const n of [2, 3, 4, 5]) {
            const ids = Array.from({ length: n }, (_, i) => `p${i}`);
            const root = group(
                "root",
                FlexDirection.Row,
                ids.map((id, i) => leaf(id, i === 0 ? 70 : 30 / (n - 1))),
                100
            );
            const model = makeLayout(root, {}, null, 4000);
            model.treeReducer(
                {
                    type: LayoutTreeActionType.SplitHorizontal,
                    targetNodeId: "p0",
                    newNode: newLeaf("n"),
                    position: "before",
                    focused: true,
                } as never,
                false
            );
            const parent = model.treeState.rootNode;
            expect(parent.children.length).toBe(n + 1);
            expect(parent.children[0].id).toBe("n");
            expectEven(parent);
        }
    });

    it("shares the width equally even where the first column ends under its readable minimum: only a floor the developer set holds", () => {
        const model = makeLayout(row("a", "b", "c", "d", "e"));
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "e",
                newNode: newLeaf("n"),
                position: "after",
            } as never,
            false
        );
        const root = model.treeState.rootNode;
        expect(root.children.length).toBe(6);
        expect((root.children[0].size / 100) * Width).toBeLessThan(FirstColumnMinPx);
        expectEven(root);
    });

    it("splits a lone panel into two halves", () => {
        const model = makeLayout(leaf("a", 100));
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "a",
                newNode: newLeaf("n"),
                position: "after",
                focused: true,
            } as never,
            false
        );
        expect(sizesOf(model.treeState.rootNode)).toEqual([50, 50]);
    });

    it("evens out only the row the panel joined, not the other rows", () => {
        const top = group("top", FlexDirection.Row, [leaf("t1", 70), leaf("t2", 30)], 60);
        const bottom = group("bottom", FlexDirection.Row, [leaf("u1", 90), leaf("u2", 10)], 40);
        const model = makeLayout(group("root", FlexDirection.Column, [top, bottom], 100));
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "u1",
                newNode: newLeaf("n"),
                position: "after",
            } as never,
            false
        );
        expect(sizesOf(findNode(model.treeState.rootNode, "top"))).toEqual([70, 30]);
        expectEven(findNode(model.treeState.rootNode, "bottom"));
        expect(sizesOf(model.treeState.rootNode)).toEqual([60, 40]);
    });

    it("rebalances along the axis the panel was added on: a vertical split shares the column's heights", () => {
        const stack = group("stack", FlexDirection.Column, [leaf("s1", 80), leaf("s2", 20)], 50);
        const model = makeLayout(group("root", FlexDirection.Row, [leaf("a", 50), stack], 100));
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitVertical,
                targetNodeId: "s2",
                newNode: newLeaf("n"),
                position: "after",
                focused: true,
            } as LayoutTreeSplitVerticalAction,
            false
        );
        const col = findNode(model.treeState.rootNode, "stack");
        expect(col.children.map((c) => c.id)).toEqual(["s1", "s2", "n"]);
        expectEven(col);
        expect(sizesOf(model.treeState.rootNode)).toEqual([50, 50]);
    });

    it("keeps a stacked column's inner heights when a column is added beside it", () => {
        const stack = group("stack", FlexDirection.Column, [leaf("s1", 80), leaf("s2", 20)], 40);
        const model = makeLayout(group("root", FlexDirection.Row, [leaf("a", 60), stack], 100));
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "a",
                newNode: newLeaf("n"),
                position: "after",
            } as never,
            false
        );
        expect(shape(model.treeState.rootNode)).toBe("row(a,n,col(s1,s2))");
        expectEven(model.treeState.rootNode);
        expect(sizesOf(findNode(model.treeState.rootNode, "stack"))).toEqual([80, 20]);
    });

    it("keeps a size the panel arrives with (the Review tab's AI panel, the onboarding dock, the pipeline tab)", () => {
        const model = makeLayout(row("review", "other"));
        const before = sizesOf(model.treeState.rootNode);
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "review",
                newNode: newLeaf("ai", 6),
                position: "before",
            } as never,
            false
        );
        expect(model.treeState.rootNode.children.map((c) => c.id)).toEqual(["ai", "review", "other"]);
        expect(findNode(model.treeState.rootNode, "ai").size).toBe(6);
        expect(sizesOf(model.treeState.rootNode).slice(1)).toEqual(before);
    });

    it("keeps the sizes when a magnified panel is added: it hides the row", () => {
        const model = makeLayout(row("a", "b"));
        const before = sizesOf(model.treeState.rootNode);
        model.treeReducer(
            { type: LayoutTreeActionType.InsertNode, node: newLeaf("n"), magnified: true, focused: true } as never,
            false
        );
        expect(sizesOf(model.treeState.rootNode).slice(0, 2)).toEqual(before);
    });

    it("settles the added panel's size so the one remembered for its kind does not apply", () => {
        const model = makeLayout(row("a", "b"));
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "a",
                newNode: newLeaf("n"),
                position: "after",
            } as never,
            false
        );
        expect(model.moltenSizedBlockIds.has("b-n")).toBe(true);
        const arrived = newLeaf("m", 6);
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "a",
                newNode: arrived,
                position: "after",
            } as never,
            false
        );
        expect(model.moltenSizedBlockIds.has("b-m")).toBe(false);
    });

    it("holds the first column's floor: the other columns share what it leaves", () => {
        floor.px = 900;
        const model = makeLayout(row("a", "b"), {}, null, 1800);
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "b",
                newNode: newLeaf("n"),
                position: "after",
            } as never,
            false
        );
        const [a, b, n] = model.treeState.rootNode.children.map((c) => (c.size / 100) * 1800);
        // The tile gap stands between the columns, so the sizes are shares of what they leave.
        expect(Math.abs(a - 900)).toBeLessThan(5);
        expect(b).toBeCloseTo(n, 3);
    });

    // The developer's gold (#2497): a floor of 1743 px, a window 1728 px wide, the "Kimi" view rebuilt from its pin (the
    // agent's terminal, then its companion split after it): the companion was laid at size 0.
    it("drops a floor wider than the window leaves room for: the companion split beside the agent is never laid at size 0", async () => {
        floor.px = 1743;
        const model = makeLayout(leaf("agent", 100), {}, null, 1728);
        await (
            model as unknown as { handleBackendAction: (a: unknown) => Promise<void> }
        ).handleBackendAction({
            actionid: "2497",
            actiontype: LayoutTreeActionType.SplitHorizontal,
            blockid: "companion",
            targetblockid: "b-agent",
            position: "after",
        });
        const root = model.treeState.rootNode;
        expect(root.children.map((c) => c.data?.blockId)).toEqual(["b-agent", "companion"]);
        for (const size of sizesOf(root)) {
            expect(size).toBeGreaterThan(0);
        }
        expectEven(root);
    });

    it("holds a floor while the other columns keep a readable width each, and drops it once they would not", () => {
        floor.px = 1200;
        const fits = makeLayout(row("a", "b"), {}, null, 1600);
        fits.treeReducer(
            { type: LayoutTreeActionType.SplitHorizontal, targetNodeId: "b", newNode: newLeaf("n"), position: "after" } as never,
            false
        );
        // 1200 px + two columns of 360 px do not fit in 1600 px: the row shares its width.
        expectEven(fits.treeState.rootNode);
        floor.px = 1000;
        const holds = makeLayout(leaf("a", 100), {}, null, 1600);
        holds.treeReducer(
            { type: LayoutTreeActionType.SplitHorizontal, targetNodeId: "a", newNode: newLeaf("n"), position: "after" } as never,
            false
        );
        const [a, n] = holds.treeState.rootNode.children.map((c) => (c.size / 100) * 1600);
        expect(Math.abs(a - 1000)).toBeLessThan(5);
        expect(n).toBeGreaterThan(500);
    });

    it("never sizes a panel of a tree that only holds it", () => {
        const model = makeLayout(leaf("a", 100));
        model.treeReducer({ type: LayoutTreeActionType.InsertNode, node: newLeaf("n") } as never, false);
        expect(model.treeState.rootNode.children?.length).toBe(2);
    });
});

describe("the backend's queued actions replay through the same reducer (an agent's panels, reopen, molten open)", () => {
    // What the layout does with each action the backend queues (LayoutModel.processPendingBackendActions).
    function replay(model: LayoutModel, action: Record<string, unknown>): Promise<void> {
        return (model as unknown as { handleBackendAction: (a: unknown) => Promise<void> }).handleBackendAction(action);
    }

    it("insert, with no size: the row shares its width", async () => {
        const model = makeLayout(row("a", "b"));
        await replay(model, {
            actionid: "1",
            actiontype: LayoutTreeActionType.InsertNode,
            blockid: "x",
            focused: false,
        });
        expect(model.treeState.rootNode.children.length).toBe(3);
        expectEven(model.treeState.rootNode);
    });

    it("insert at an index (a reopened pane): the row shares its width", async () => {
        const model = makeLayout(row("a", "b"));
        await replay(model, {
            actionid: "2",
            actiontype: LayoutTreeActionType.InsertNodeAtIndex,
            blockid: "x",
            indexarr: [0],
        });
        expect(model.treeState.rootNode.children.length).toBe(3);
        expectEven(model.treeState.rootNode);
    });

    it("split beside a panel, with no size: the row shares its width; with a size (the Review tab's AI panel): it keeps it", async () => {
        const model = makeLayout(row("a", "b"));
        await replay(model, {
            actionid: "3",
            actiontype: LayoutTreeActionType.SplitHorizontal,
            blockid: "x",
            targetblockid: "b-a",
            position: "after",
        });
        expectEven(model.treeState.rootNode);
        await replay(model, {
            actionid: "4",
            actiontype: LayoutTreeActionType.SplitHorizontal,
            blockid: "ai",
            targetblockid: "b-a",
            position: "before",
            nodesize: 6,
        });
        const ai = model.treeState.rootNode.children.find((c) => c.data?.blockId === "ai");
        expect(ai.size).toBe(6);
        expect(model.treeState.rootNode.children[0].id).toBe(ai.id);
    });

    it("a split below a panel shares the column's heights", async () => {
        const model = makeLayout(row("a", "b"));
        await replay(model, {
            actionid: "5",
            actiontype: LayoutTreeActionType.SplitVertical,
            blockid: "x",
            targetblockid: "b-a",
            position: "after",
        });
        const column = model.treeState.rootNode.children[0];
        expect(column.children.length).toBe(2);
        expectEven(column);
    });

    it("never moves or closes a pane: the panes that were there keep their order", () => {
        const model = makeLayout(row("agent", "view"));
        model.treeReducer(
            {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "view",
                newNode: newLeaf("n"),
                position: "after",
            } as never,
            false
        );
        expect(model.treeState.rootNode.children.map((c) => c.id)).toEqual(["agent", "view", "n"]);
    });
});

describe("under a 360 × N the panel goes next to the focused one and the zones keep their number (FR-SHELL-123 AC17)", () => {
    const Wide = 3600;

    // An agent (c0) and carpet panels c1..c5 in a 360 × places view, the panel `focused` in focus, drawn.
    function zonesLayout(places: number, focused: string, ids = ["c0", "c1", "c2", "c3", "c4", "c5"]) {
        const meta = { [View360MetaKey]: true, [View360PlacesMetaKey]: places };
        return makeLayout(row(...ids), meta, focused, Wide);
    }

    function inView(model: LayoutModel): string[] {
        return visibleCarpetColumnIds(model.moltenView360.layout, model.moltenView360.scrollLeft);
    }

    function order(model: LayoutModel): string[] {
        return model.treeState.rootNode.children.map((c) => c.id);
    }

    const insertAction = (node: LayoutNode) => ({ type: LayoutTreeActionType.InsertNode, node, focused: true });

    function add(model: LayoutModel, action: unknown) {
        model.treeReducer(action as never, false);
        model.updateTree();
    }

    it("is drawn as 360 × 2 with the first two carpet panels in view", () => {
        const model = zonesLayout(2, "c1");
        expect(model.moltenView360.addMode()).toBe("zones");
        expect(inView(model)).toEqual(["c1", "c2"]);
    });

    describe("a panel added through an action with no place of its own (createBlock, the palette, a page, a reopened panel)", () => {
        for (const [name, make] of Object.entries({
            insert: insertAction,
            insertAtIndex: (node: LayoutNode) => ({
                type: LayoutTreeActionType.InsertNodeAtIndex,
                node,
                indexArr: [5],
                focused: true,
            }),
        })) {
            it(`${name}: × 2, next to the first zone's panel, which keeps its zone; the panel on the right goes to the carpet`, () => {
                const model = zonesLayout(2, "c1");
                add(model, make(newLeaf("n")));
                expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
                expect(inView(model)).toEqual(["c1", "n"]);
                expect(globalStore.get(model.moltenView360.shownPlacesAtom)).toBe(2);
                expect(model.treeState.focusedNodeId).toBe("n");
            });
        }

        it("× 2, last zone: on the left of the focused panel, which keeps its zone; the panel on the left goes to the carpet", () => {
            const model = zonesLayout(2, "c2");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["n", "c2"]);
        });

        it("× 3, first zone: the third panel goes to the carpet", () => {
            const model = zonesLayout(3, "c1");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c1", "n", "c2"]);
        });

        it("× 3, middle zone: the far panel on the right goes to the carpet", () => {
            const model = zonesLayout(3, "c2");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "c2", "n", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c1", "c2", "n"]);
        });

        it("× 3, last zone: on its left, the far panel on the left goes to the carpet", () => {
            const model = zonesLayout(3, "c3");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "c2", "n", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c2", "n", "c3"]);
        });

        it("× 1: the new panel becomes the visible one and the previous one goes to the carpet", () => {
            const model = zonesLayout(1, "c1");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["n"]);
        });

        it("with the focus in the fixed zone (the agent): it takes the first zone, next to the agent", () => {
            const model = zonesLayout(2, "c0");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "n", "c1", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["n", "c1"]);
        });

        it("keeps the zones' number and the carpet's place after the carpet moved: next to the focus, where the carpet rests", () => {
            const model = zonesLayout(2, "c3");
            model.moltenView360.scrollTo(model.moltenView360.layout.columns[2].x);
            model.updateTree();
            expect(inView(model)).toEqual(["c3", "c4"]);
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "c2", "c3", "n", "c4", "c5"]);
            expect(inView(model)).toEqual(["c3", "n"]);
        });

        it("never moves or closes a pane: the panels keep their order around the new one", () => {
            const model = zonesLayout(3, "c2");
            add(model, insertAction(newLeaf("n")));
            expect(order(model).filter((id) => id !== "n")).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
        });

        it("does nothing when nothing is in focus: the plain carpet rule lays it at the end", () => {
            const model = zonesLayout(2, null);
            add(model, insertAction(newLeaf("n")));
            expect(order(model).at(-1)).toBe("n");
        });
    });

    describe("a panel added beside a named panel (a split, Add a panel on the left or right, a drop on a panel, a page beside)", () => {
        const split = (target: string, position: "before" | "after", node = newLeaf("n")) => ({
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: target,
            newNode: node,
            position,
            focused: true,
        });

        it("goes on the side asked: on the right of a panel that is not the last zone", () => {
            const model = zonesLayout(3, "c2");
            add(model, split("c1", "after"));
            expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c1", "n", "c2"]);
        });

        it("on the left of a panel that is not the last zone", () => {
            const model = zonesLayout(3, "c1");
            add(model, split("c2", "before"));
            expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c1", "n", "c2"]);
        });

        it("on the right of the last zone: the carpet moves one zone so both stay in view", () => {
            const model = zonesLayout(2, "c1");
            add(model, split("c2", "after"));
            expect(order(model)).toEqual(["c0", "c1", "c2", "n", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c2", "n"]);
        });

        it("beside the agent: it takes the first zone", () => {
            const model = zonesLayout(2, "c1");
            add(model, split("c0", "after"));
            expect(order(model)).toEqual(["c0", "n", "c1", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["n", "c1"]);
        });

        it("beside a panel stored out of view: it goes next to the focused one instead, so the zones stay where they are", () => {
            const model = zonesLayout(2, "c1");
            add(model, split("c5", "after"));
            expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c1", "n"]);
        });
    });

    describe("the agent stays on the left and graphics go on its right (DS-REV-012)", () => {
        // What the layout does with each action the backend queues (an agent's `wsh view`, a reopened panel).
        function replay(model: LayoutModel, action: Record<string, unknown>): Promise<void> {
            return (model as unknown as { handleBackendAction: (a: unknown) => Promise<void> }).handleBackendAction(
                action
            );
        }

        const added = (model: LayoutModel, blockId: string) =>
            model.treeState.rootNode.children.find((c) => c.data?.blockId === blockId);

        it("a panel added next to the agent's terminal in the last zone goes after it, not before", () => {
            views.byBlock["b-c2"] = "term";
            const model = zonesLayout(2, "c2");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "c2", "n", "c3", "c4", "c5"]);
            expect(inView(model)).toEqual(["c2", "n"]);
            expect(model.treeState.focusedNodeId).toBe("n");
        });

        it("a terminal in the last zone of a 360 × 3 keeps the graphics on its right as well", () => {
            views.byBlock["b-c3"] = "term";
            const model = zonesLayout(3, "c3");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "c2", "c3", "n", "c4", "c5"]);
            expect(inView(model)).toEqual(["c2", "c3", "n"]);
        });

        it("a panel the backend adds (`wsh view` run in the focused terminal) goes after it in the last zone", async () => {
            views.byBlock["b-c2"] = "term";
            const model = zonesLayout(2, "c2");
            await replay(model, { actionid: "v1", actiontype: LayoutTreeActionType.InsertNode, blockid: "x" });
            model.updateTree();
            expect(order(model).slice(0, 4)).toEqual(["c0", "c1", "c2", added(model, "x").id]);
            expect(inView(model)).toEqual(["c2", added(model, "x").id]);
        });

        it("a panel the backend adds goes after any focused panel in the last zone, a reopened panel too", async () => {
            const model = zonesLayout(2, "c2");
            await replay(model, {
                actionid: "v2",
                actiontype: LayoutTreeActionType.InsertNodeAtIndex,
                blockid: "y",
                indexarr: [1],
            });
            model.updateTree();
            expect(order(model).slice(0, 4)).toEqual(["c0", "c1", "c2", added(model, "y").id]);
            expect(inView(model)).toEqual(["c2", added(model, "y").id]);
        });

        it("the backend's rule ends with its action: the next panel the developer adds goes before a panel that is no terminal", async () => {
            const model = zonesLayout(2, "c2");
            await replay(model, { actionid: "v3", actiontype: LayoutTreeActionType.InsertNode, blockid: "z" });
            expect(model.moltenBackendAdd).toBe(false);
            const fresh = zonesLayout(2, "c2");
            add(fresh, insertAction(newLeaf("n")));
            expect(order(fresh)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
        });

        it("a side a split names is kept: a split asked on the left of the terminal goes there", () => {
            views.byBlock["b-c2"] = "term";
            const model = zonesLayout(2, "c2");
            add(model, {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "c2",
                newNode: newLeaf("n"),
                position: "before",
                focused: true,
            });
            expect(order(model)).toEqual(["c0", "c1", "n", "c2", "c3", "c4", "c5"]);
        });
    });

    describe("the other cases", () => {
        it("the plain 360 view, with no N, has no zones to keep: the carpet rule stays", () => {
            const model = makeLayout(row("c0", "c1", "c2", "c3", "c4"), { [View360MetaKey]: true }, "c1", Wide);
            expect(model.moltenView360.addMode()).toBe("carpet");
            add(model, insertAction(newLeaf("n")));
            expect(order(model).at(-1)).toBe("n");
        });

        it("a view whose N stores nothing is the grid: the row shares its width", () => {
            const model = makeLayout(
                row("c0", "c1"),
                { [View360MetaKey]: true, [View360PlacesMetaKey]: 2 },
                "c1",
                Wide
            );
            expect(model.moltenView360.addMode()).toBe("grid");
            add(model, insertAction(newLeaf("n")));
            expectEven(model.treeState.rootNode);
        });

        it("a panel that makes the view store something brings the 360 back with the same zones, next to the focus", () => {
            const model = makeLayout(
                row("c0", "c1", "c2"),
                { [View360MetaKey]: true, [View360PlacesMetaKey]: 2 },
                "c1",
                Wide
            );
            expect(model.moltenView360.layout).toBeNull();
            expect(model.moltenView360.addMode()).toBe("zones");
            add(model, insertAction(newLeaf("n")));
            expect(order(model)).toEqual(["c0", "c1", "n", "c2"]);
            expect(inView(model)).toEqual(["c1", "n"]);
        });

        it("a magnified panel is no zone: it opens over the others and the zones are left as they are", () => {
            const model = zonesLayout(2, "c1");
            model.treeReducer(
                { type: LayoutTreeActionType.InsertNode, node: newLeaf("n"), magnified: true, focused: true } as never,
                false
            );
            expect(findNode(model.treeState.rootNode, "n")).toBeDefined();
            expect(model.treeState.magnifiedNodeId).toBe("n");
            expect(model.moltenSizedBlockIds.size).toBe(0);
        });
    });
});

describe("DefaultNodeSize is the mark of a panel that asks for no size", () => {
    it("is what every creator without a size gets", () => {
        expect(newLayoutNode(undefined, undefined, undefined, { blockId: "b" }).size).toBe(DefaultNodeSize);
    });
});
