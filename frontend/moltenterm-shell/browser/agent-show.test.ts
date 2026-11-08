// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bringPanelIntoView } from "../view360/carpet-reveal";
import { showAgentPage } from "./agent-show";
import { BrowserAgentModel, PanelAgentState } from "./browser-agent";

// A layout of one tab: terminals and a page panel, one of them possibly magnified, and what a layout does when it is
// asked to give the focus. The static tab's layout is the shown one (getLayoutModelForStaticTab).
const Layout = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/layout/lib/layoutModelHooks", () => ({ getLayoutModelForStaticTab: () => Layout.current }));
const Mocks = vi.hoisted(() => ({ subscribe: vi.fn(), call: vi.fn() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: Mocks.subscribe }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

type FakeNode = { id: string; data: { blockId: string } };

function makeLayout(opts: { magnified?: string; carpet?: boolean } = {}) {
    const nodes: Record<string, FakeNode> = {
        "node-term": { id: "node-term", data: { blockId: "block-term" } },
        "node-page": { id: "node-page", data: { blockId: "block-page" } },
    };
    const focusedNode = atom(nodes["node-term"]) as PrimitiveAtom<FakeNode>;
    const layout = {
        magnifiedNodeId: opts.magnified,
        focusedNode,
        getNodeByBlockId: vi.fn((blockId: string) => Object.values(nodes).find((n) => n.data.blockId === blockId)),
        magnifyNodeToggle: vi.fn((nodeId: string) => {
            layout.magnifiedNodeId = layout.magnifiedNodeId === nodeId ? undefined : nodeId;
        }),
        focusNode: vi.fn(),
        treeReducer: vi.fn(),
        moltenView360: opts.carpet ? { revealBlock: vi.fn() } : null,
    };
    Layout.current = layout;
    return layout;
}

beforeEach(() => {
    Layout.current = null;
});

describe("a page the agent shows in a grid view (#1994)", () => {
    it("ends the magnification of another panel, which hides the page", () => {
        const layout = makeLayout({ magnified: "node-term" });
        bringPanelIntoView("block-page");
        expect(layout.magnifyNodeToggle).toHaveBeenCalledTimes(1);
        expect(layout.magnifyNodeToggle).toHaveBeenCalledWith("node-term");
        expect(layout.magnifiedNodeId).toBeUndefined();
    });

    it("moves, resizes and focuses nothing", () => {
        const layout = makeLayout({ magnified: "node-term" });
        bringPanelIntoView("block-page");
        expect(layout.focusNode).not.toHaveBeenCalled();
        expect(layout.treeReducer).not.toHaveBeenCalled();
        expect(globalStore.get(layout.focusedNode).id).toBe("node-term");
    });

    it("changes nothing when nothing is magnified or the page panel itself is", () => {
        const plain = makeLayout();
        bringPanelIntoView("block-page");
        expect(plain.magnifyNodeToggle).not.toHaveBeenCalled();
        const own = makeLayout({ magnified: "node-page" });
        bringPanelIntoView("block-page");
        expect(own.magnifyNodeToggle).not.toHaveBeenCalled();
        expect(own.magnifiedNodeId).toBe("node-page");
    });

    it("changes nothing for a panel of another tab, which has no node in the shown layout", () => {
        const layout = makeLayout({ magnified: "node-term" });
        bringPanelIntoView("block-elsewhere");
        bringPanelIntoView("");
        expect(layout.magnifyNodeToggle).not.toHaveBeenCalled();
        expect(layout.magnifiedNodeId).toBe("node-term");
    });

    it("does nothing without a shown layout", () => {
        expect(() => bringPanelIntoView("block-page")).not.toThrow();
    });
});

describe("a page the agent shows on a 360 carpet (#1812, #1994)", () => {
    it("glides the carpet to the panel, without focusing it", () => {
        const layout = makeLayout({ carpet: true });
        bringPanelIntoView("block-page");
        expect(layout.moltenView360.revealBlock).toHaveBeenCalledTimes(1);
        expect(layout.moltenView360.revealBlock).toHaveBeenCalledWith("block-page");
        expect(layout.focusNode).not.toHaveBeenCalled();
        expect(globalStore.get(layout.focusedNode).id).toBe("node-term");
    });

    it("does not glide to a panel the layout does not hold", () => {
        const layout = makeLayout({ carpet: true });
        bringPanelIntoView("block-elsewhere");
        expect(layout.moltenView360.revealBlock).not.toHaveBeenCalled();
    });
});

describe("the panel's side of a page the agent shows", () => {
    const target = (over: Partial<Parameters<typeof showAgentPage>[0]> = {}) => ({
        blockId: "block-page",
        activeTabId: () => "tab-a",
        hasTab: (id: string) => id === "tab-a" || id === "tab-b",
        selectTab: vi.fn(),
        ...over,
    });

    it("selects the tab the agent showed and brings the panel into view", () => {
        const layout = makeLayout({ magnified: "node-term" });
        const t = target();
        showAgentPage(t, ["tab-b"]);
        expect(t.selectTab).toHaveBeenCalledWith("tab-b");
        expect(layout.magnifyNodeToggle).toHaveBeenCalledWith("node-term");
    });

    it("selects the latest of several tabs shown", () => {
        makeLayout();
        const t = target();
        showAgentPage(t, ["tab-a", "tab-b"]);
        expect(t.selectTab).toHaveBeenCalledTimes(1);
        expect(t.selectTab).toHaveBeenCalledWith("tab-b");
    });

    it("leaves the selection alone when the tab is already the one shown or is not in the panel", () => {
        makeLayout();
        const t = target();
        showAgentPage(t, ["tab-a"]);
        showAgentPage(t, ["agent-queued"]);
        showAgentPage(t, []);
        expect(t.selectTab).not.toHaveBeenCalled();
    });
});

// The whole path, from the state wavesrv publishes to the layout: the developer's focus is where it was before.
describe("an agent shows a page (#1994)", () => {
    const state = (shownts: number): PanelAgentState => ({
        blockid: "block-page",
        tabs: [{ browsertabid: "agent-tab", agentname: "Arthur", origin: "opened", state: "active", shownts }],
    });
    let model: BrowserAgentModel;
    let publish: (next: PanelAgentState) => void;

    beforeEach(async () => {
        Mocks.call.mockReset().mockResolvedValue(state(100));
        Mocks.subscribe.mockImplementation(({ handler }) => {
            publish = (next) => handler({ data: next });
            return () => {};
        });
        model = new BrowserAgentModel("block-page");
        model.start();
        await vi.waitFor(() => expect(model.tabs()["agent-tab"]).toBeDefined(), { timeout: 30_000 });
    });

    afterEach(() => model.dispose());

    it("brings the hidden panel out, raises the note and keeps the developer's focus", () => {
        const layout = makeLayout({ magnified: "node-term", carpet: true });
        const selectTab = vi.fn();
        model.onShown = (ids) =>
            showAgentPage({ blockId: "block-page", activeTabId: () => "other", hasTab: () => true, selectTab }, ids);
        publish(state(400));
        expect(layout.magnifiedNodeId).toBeUndefined();
        expect(layout.moltenView360.revealBlock).toHaveBeenCalledWith("block-page");
        expect(selectTab).toHaveBeenCalledWith("agent-tab");
        expect(globalStore.get(model.shownAtom)).toEqual({ "agent-tab": true });
        expect(layout.focusNode).not.toHaveBeenCalled();
        expect(globalStore.get(layout.focusedNode).id).toBe("node-term");
    });
});
