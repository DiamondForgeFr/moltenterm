// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, LayoutTreeActionType, type LayoutNode, type LayoutTreeState } from "@/layout/lib/types";
import { moveNode } from "@/layout/lib/layoutTree";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MoltentermBrowserView } from "../browser/browser-model";
import { I18nModel } from "../i18n/i18n";
import {
    agentInitial,
    carpetMoveAction,
    carpetTabMenu,
    CarpetTabMenuInput,
    carpetTabName,
    dropIndex,
    FrameExtraPx,
    pageOpener,
    reorderColumns,
    rovingColumnId,
    stepIndex,
    StripPlusPx,
    stripLayout,
    stripWidthPx,
    TabGapPx,
    TabIconPx,
    TabMaxPx,
    TabMinTitlePx,
} from "./carpet-tabs-model";
import { buildRadarTicks, RadarBlockFacts, RadarColumnInput, RadarKindColors } from "./radar-model";

const facts: Record<string, RadarBlockFacts> = {
    a: { view: "term", agent: true, title: "Léon", attention: null, icon: "robot" },
    p: { view: MoltentermBrowserView, agent: false, title: "Thème Coulée", attention: null, icon: "globe" },
    r: { view: "molten-reviews", agent: false, title: "Intégration", attention: "answer", icon: "gauge" },
    x: { view: "something-new", agent: false, title: "", attention: null },
};

function col(columnId: string, ...blockIds: string[]): RadarColumnInput {
    return { columnId, leaves: blockIds.map((b) => ({ nodeId: `n-${b}`, blockId: b })) };
}

function leaf(id: string): LayoutNode {
    return { id, data: { blockId: id }, flexDirection: FlexDirection.Row, size: 10 } as LayoutNode;
}

function row(...ids: string[]): LayoutNode {
    return { id: "root", flexDirection: FlexDirection.Row, size: 100, children: ids.map(leaf) } as LayoutNode;
}

describe("the tab model (FR-SHELL-125-AC1, AC3, AC10)", () => {
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("keeps the carpet order, the icon and colour of each kind, and the page flag", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        const ticks = buildRadarTicks([col("c1", "a"), col("c2", "p"), col("c3", "r"), col("c4", "x")], facts, [
            "c2",
            "c3",
        ]);
        expect(ticks.map((t) => t.columnId)).toEqual(["c1", "c2", "c3", "c4"]);
        expect(ticks.map((t) => t.icon)).toEqual(["robot", "globe", "gauge", "square"]);
        expect(ticks.map((t) => t.kind)).toEqual(["agent", "web", "review", "other"]);
        expect(ticks[1].color).toBe(RadarKindColors.web);
        expect(ticks.map((t) => t.page)).toEqual([false, true, false, false]);
        expect(ticks.map((t) => t.visible)).toEqual([false, true, true, false]);
        expect(ticks[2].attention).toBe("answer");
        expect(ticks[2].focusBlockId).toBe("r");
    });

    it("names a tab by its kind, its title and its state, with the word panel", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        const [stored, visible, waiting, other] = buildRadarTicks(
            [col("c1", "a"), col("c2", "p"), col("c3", "r"), col("c4", "x")],
            facts,
            ["c2", "c3"]
        );
        expect(carpetTabName(stored)).toBe("Agent: Léon, stored on the carpet");
        expect(carpetTabName(visible, "Adrien")).toBe("Page: Thème Coulée, visible, opened by Adrien");
        expect(carpetTabName(waiting)).toBe("Review: Intégration, visible, waiting for your answer");
        expect(carpetTabName(other)).toBe("Panel: Panel, stored on the carpet");
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(carpetTabName(stored)).toBe("Agent\u00a0: Léon, rangé sur le tapis");
        expect(carpetTabName(waiting)).toBe("Revue\u00a0: Intégration, visible, attend votre réponse");
    });

    it("shows the initial of the agent that opened a page, never for a page the developer shared", () => {
        expect(agentInitial("adrien")).toBe("A");
        expect(agentInitial("  Élodie ")).toBe("É");
        expect(agentInitial("")).toBe("");
        const agents = {
            t1: { agentname: "Léon", origin: "opened" },
            t2: { agentname: "Léon", origin: "shared" },
        };
        expect(pageOpener("t1", agents)).toBe("Léon");
        expect(pageOpener("t2", agents)).toBe("");
        expect(pageOpener("t3", agents)).toBe("");
        expect(pageOpener(null, agents)).toBe("");
    });

    it("puts one tab in the tab order: the focused panel's, else the first visible one", () => {
        const ticks = buildRadarTicks([col("c1", "a"), col("c2", "p"), col("c3", "r")], facts, ["c2", "c3"]);
        expect(rovingColumnId(ticks, "c3")).toBe("c3");
        expect(rovingColumnId(ticks, null)).toBe("c2");
        expect(rovingColumnId(ticks, "elsewhere")).toBe("c2");
        expect(rovingColumnId(buildRadarTicks([col("c1", "a")], facts, []), null)).toBe("c1");
        expect(rovingColumnId([], null)).toBeNull();
    });
});

describe("the fallback steps (AC8)", () => {
    const strip = 1200;

    it("shows titles, tightened down to their minimum, then icons, then ticks", () => {
        expect(stripLayout(1, strip)).toEqual({ mode: "titles", tabPx: TabMaxPx });
        expect(stripLayout(5, strip)).toEqual({ mode: "titles", tabPx: TabMaxPx });
        const tight = stripLayout(9, strip);
        expect(tight.mode).toBe("titles");
        expect(tight.tabPx).toBeLessThan(TabMaxPx);
        expect(tight.tabPx).toBeGreaterThanOrEqual(TabMinTitlePx);
        expect(stripLayout(20, strip)).toEqual({ mode: "icons", tabPx: TabIconPx });
        expect(stripLayout(40, strip).mode).toBe("ticks");
    });

    it("steps by width as well as by count", () => {
        expect(stripLayout(12, 2400).mode).toBe("titles");
        expect(stripLayout(12, 900).mode).toBe("icons");
        expect(stripLayout(12, 300).mode).toBe("ticks");
    });

    it("never overflows the room it is given", () => {
        for (const width of [300, 640, 960, 1200, 2400]) {
            for (const count of [1, 5, 12, 40]) {
                const layout = stripLayout(count, width);
                if (layout.mode !== "ticks") {
                    expect(stripWidthPx(count, layout), `${count} in ${width}`).toBeLessThanOrEqual(width);
                }
            }
        }
        expect(stripWidthPx(3, { mode: "titles", tabPx: 100 })).toBe(
            300 + 2 * TabGapPx + FrameExtraPx + StripPlusPx
        );
    });
});

describe("the order (AC5)", () => {
    it("drops before the first tab whose centre is right of the pointer", () => {
        expect(dropIndex([10, 50, 90], 0)).toBe(0);
        expect(dropIndex([10, 50, 90], 60)).toBe(2);
        expect(dropIndex([10, 50, 90], 200)).toBe(3);
    });

    it("reorders the carpet, and changes nothing when the tab drops where it is", () => {
        const ids = ["a", "b", "c", "d"];
        expect(reorderColumns(ids, "d", 1)).toEqual(["a", "d", "b", "c"]);
        expect(reorderColumns(ids, "a", 4)).toEqual(["b", "c", "d", "a"]);
        expect(reorderColumns(ids, "b", 3)).toEqual(["a", "c", "b", "d"]);
        expect(reorderColumns(ids, "b", 1)).toBeNull();
        expect(reorderColumns(ids, "b", 2)).toBeNull();
        expect(reorderColumns(ids, "zz", 0)).toBeNull();
    });

    it("moves left or right by one, and not past either end", () => {
        const ids = ["a", "b", "c"];
        expect(reorderColumns(ids, "b", stepIndex(ids, "b", -1))).toEqual(["b", "a", "c"]);
        expect(reorderColumns(ids, "b", stepIndex(ids, "b", 1))).toEqual(["a", "c", "b"]);
        expect(stepIndex(ids, "a", -1)).toBeNull();
        expect(stepIndex(ids, "c", 1)).toBeNull();
    });

    it("moves the column in the tree, next to its new carpet neighbour, keeping the node", () => {
        // "fixed" is the first column, "pin" a pinned column between carpet columns.
        const root = row("fixed", "a", "pin", "b", "c");
        const carpet = ["a", "b", "c"];
        const node = root.children[4];
        const action = carpetMoveAction(root, carpet, "c", 0);
        expect(action).toMatchObject({ type: LayoutTreeActionType.Move, parentId: "root", index: 1 });
        const state = { rootNode: root } as LayoutTreeState;
        vi.spyOn(console, "log").mockImplementation(() => {});
        moveNode(state, action);
        expect(state.rootNode.children.map((c) => c.id)).toEqual(["fixed", "c", "a", "pin", "b"]);
        expect(state.rootNode.children[1]).toBe(node);
        expect(state.rootNode.children[1].size).toBe(10);

        const again = row("fixed", "a", "pin", "b", "c");
        const right = carpetMoveAction(again, carpet, "a", stepIndex(carpet, "a", 1));
        moveNode({ rootNode: again } as LayoutTreeState, right);
        expect(again.children.map((c) => c.id)).toEqual(["fixed", "pin", "b", "a", "c"]);

        const end = row("fixed", "a", "b", "c");
        moveNode({ rootNode: end } as LayoutTreeState, carpetMoveAction(end, carpet, "a", 3));
        expect(end.children.map((c) => c.id)).toEqual(["fixed", "b", "c", "a"]);
        expect(carpetMoveAction(end, ["b", "c", "a"], "c", 2)).toBeNull();
    });
});

describe("the tab menu (AC6)", () => {
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    function input(over: Partial<CarpetTabMenuInput> = {}): CarpetTabMenuInput {
        return {
            pageItems: [],
            pinItems: [{ label: "Pin beside", click: () => {} }, { label: "Pin in the first column", click: () => {} }],
            canMoveLeft: true,
            canMoveRight: true,
            hasOthers: true,
            close: vi.fn(),
            closeOthers: vi.fn(),
            moveLeft: vi.fn(),
            moveRight: vi.fn(),
            ...over,
        };
    }

    const labels = (menu: ContextMenuItem[]) => menu.map((m) => (m.type === "separator" ? "—" : m.label));

    it("offers a page its actions, then Close, Close others, Pin and the moves", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        const page = [
            { label: "Reload", click: () => {} },
            { label: "Duplicate", click: () => {} },
            { label: "Copy link", click: () => {} },
        ];
        expect(labels(carpetTabMenu(input({ pageItems: page })))).toEqual([
            "Reload",
            "Duplicate",
            "Copy link",
            "—",
            "Close",
            "Close others",
            "—",
            "Pin beside",
            "Pin in the first column",
            "—",
            "Move left",
            "Move right",
        ]);
    });

    it("offers another panel Close, Close others, Pin and the moves", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(labels(carpetTabMenu(input()))).toEqual([
            "Fermer",
            "Fermer les autres",
            "—",
            "Pin beside",
            "Pin in the first column",
            "—",
            "Déplacer à gauche",
            "Déplacer à droite",
        ]);
    });

    it("leaves out what is not possible, and runs the actions it shows", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        const actions = input({ canMoveLeft: false, hasOthers: false, pinItems: [] });
        const menu = carpetTabMenu(actions);
        expect(labels(menu)).toEqual(["Close", "—", "Move right"]);
        menu[0].click();
        menu[2].click();
        expect(actions.close).toHaveBeenCalled();
        expect(actions.moveRight).toHaveBeenCalled();
    });
});
