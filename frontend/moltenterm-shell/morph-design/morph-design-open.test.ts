// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// `molten morph design <mod-id>` reaches the window as a hand-off (FR-MORPH-019) when wavesrv cannot do it alone: the
// window makes or finds the tab and shows it, in the interface language, and answers the hand-off it was given; or it
// brings an open panel into view.

import { describe, expect, it } from "vitest";
import { MorphHandoff } from "./morph-design-model";
import { focusMorphDesignPanel, MorphFocusDeps, MorphOpenDeps, openMorphDesignTab } from "./morph-design-open";

const handoff: MorphHandoff = {
    id: "h-1",
    kind: "tab",
    mod: "branch-box",
    name: "Branch box",
    dir: "/work/app",
    workspaceid: "ws-1",
    at: 1,
};

function fakeDeps() {
    const calls: unknown[] = [];
    const shown: string[] = [];
    const deps: MorphOpenDeps = {
        tab: async (data) => {
            calls.push(data);
            return { tabid: "tab-design", created: true };
        },
        showTab: (tabId) => shown.push(tabId),
        tabName: (title) => `Design · ${title}`,
    };
    return { deps, calls, shown };
}

describe("opening the design's tab", () => {
    it("asks for the mod's tab in the workspace, answering the hand-off, then shows it", async () => {
        const { deps, calls, shown } = fakeDeps();
        await expect(openMorphDesignTab(handoff, "ws-1", deps)).resolves.toBe("tab-design");
        expect(calls).toEqual([
            { mod: "branch-box", workspaceid: "ws-1", handoffid: "h-1", tabname: "Design · Branch box" },
        ]);
        expect(shown).toEqual(["tab-design"]);
    });

    it("names the tab with the mod's id when /morph gave no name", async () => {
        const { deps, calls } = fakeDeps();
        await openMorphDesignTab({ ...handoff, name: undefined }, "ws-1", deps);
        expect(calls[0]).toMatchObject({ tabname: "Design · branch-box" });
    });

    it("opens nothing without a workspace", async () => {
        const { deps, calls, shown } = fakeDeps();
        await expect(openMorphDesignTab(handoff, "", deps)).resolves.toBe("");
        expect(calls).toEqual([]);
        expect(shown).toEqual([]);
    });

    it("shows nothing when wavesrv could not make the tab", async () => {
        const { deps, shown } = fakeDeps();
        deps.tab = async () => {
            throw new Error("placing the design panel failed");
        };
        await expect(openMorphDesignTab(handoff, "ws-1", deps)).rejects.toThrow("placing");
        expect(shown).toEqual([]);
    });
});

function fakeFocus(shownTab: string) {
    const shown: string[] = [];
    const focused: string[] = [];
    const deps: MorphFocusDeps = {
        shownTab: () => shownTab,
        showTab: (tabId) => shown.push(tabId),
        focusBlock: (blockId) => focused.push(blockId),
    };
    return { deps, shown, focused };
}

describe("bringing an open panel into view", () => {
    const focus: MorphHandoff = { ...handoff, kind: "focus", tabid: "tab-agent", blockid: "block-panel" };

    it("gives the keyboard to the panel when its tab is the one shown", () => {
        const { deps, shown, focused } = fakeFocus("tab-agent");
        focusMorphDesignPanel(focus, deps);
        expect(focused).toEqual(["block-panel"]);
        expect(shown).toEqual([]);
    });

    it("shows the panel's tab when another one is shown, and leaves the keyboard alone", () => {
        const { deps, shown, focused } = fakeFocus("tab-elsewhere");
        focusMorphDesignPanel(focus, deps);
        expect(shown).toEqual(["tab-agent"]);
        expect(focused).toEqual([]);
    });

    it("does nothing without the panel's tab and block", () => {
        const { deps, shown, focused } = fakeFocus("tab-agent");
        focusMorphDesignPanel({ ...focus, blockid: undefined }, deps);
        focusMorphDesignPanel({ ...focus, tabid: undefined }, deps);
        expect(shown).toEqual([]);
        expect(focused).toEqual([]);
    });
});
