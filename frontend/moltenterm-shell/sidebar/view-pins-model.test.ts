// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentStatesData } from "../agent-state-model";
import { sameTabSplit, splitSidebarTabs } from "./sidebar-model";
import {
    agentBlocksOf,
    configSignature,
    GlobalPin,
    GlobalPinMetaKey,
    GlobalPinRevMetaKey,
    GlobalPinsMetaKey,
    instanceStale,
    layoutTree,
    liveSignature,
    makeGlobalPinId,
    paneKey,
    PinConfig,
    PinConfigMetaKey,
    PinMetaKey,
    readGlobalPins,
    RepoToken,
    viewBusy,
    viewFinished,
    viewModified,
    viewStateOf,
} from "./view-pins-model";

const config: PinConfig = {
    tree: { dir: "row", children: [{ pane: 0 }, { pane: 1 }] },
    panes: [
        { view: "term", controller: "shell" },
        { view: "molten-browser", url: RepoToken + "/pulls" },
    ],
};

const pin: GlobalPin = { id: "g1", name: "Review", rev: 2, config };

function states(entries: Record<string, string>): AgentStatesData {
    const rtn: AgentStatesData = { states: {}, versions: {} };
    for (const [id, state] of Object.entries(entries)) {
        rtn.states[id] = { blockid: id, state: state as any, version: 1 };
    }
    return rtn;
}

describe("view states (FR-SHELL-080)", () => {
    it("reads a tab as temporary, pinned in the workspace or pinned everywhere", () => {
        const ids = new Set(["g1"]);
        expect(viewStateOf({ meta: {} }, ids)).toBe("temporary");
        expect(viewStateOf({ meta: { [PinMetaKey]: "workspace", [PinConfigMetaKey]: config } }, ids)).toBe("workspace");
        expect(viewStateOf({ meta: { [GlobalPinMetaKey]: "g1" } }, ids)).toBe("everywhere");
        // The pin everywhere was removed (from another workspace): the instance is temporary again, its content kept.
        expect(viewStateOf({ meta: { [GlobalPinMetaKey]: "gone" } }, ids)).toBe("temporary");
        expect(viewStateOf({ meta: { [PinMetaKey]: "workspace" } }, ids)).toBe("temporary");
    });

    it("keeps only valid pins everywhere from the client's meta", () => {
        expect(readGlobalPins({ [GlobalPinsMetaKey]: [pin, { id: "", config }, { id: "x" }, null] })).toEqual([pin]);
        expect(readGlobalPins(null)).toEqual([]);
        expect(makeGlobalPinId(1000, 0.5)).toMatch(/^g/);
    });

    it("splits the tabs into tiles, temporary views and the top row's instances", () => {
        const tabs: Record<string, { meta: Record<string, any> }> = {
            p: { meta: { "molten:projecttab": true } },
            w: { meta: { [PinMetaKey]: "workspace" } },
            e: { meta: { [GlobalPinMetaKey]: "g1" } },
            e2: { meta: { [GlobalPinMetaKey]: "g1" } },
            old: { meta: { [GlobalPinMetaKey]: "gone" } },
            a: { meta: {} },
        };
        const split = splitSidebarTabs(
            { tabids: ["p", "w", "e", "e2", "old", "a"] },
            (id) => tabs[id],
            ["molten:projecttab", PinMetaKey],
            new Set(["g1"]),
            GlobalPinMetaKey
        );
        expect(split).toEqual({ tiles: ["p", "w"], temporary: ["e2", "old", "a"], everywhere: { g1: "e" } });
        expect(sameTabSplit(split, { ...split, everywhere: { g1: "e2" } })).toBe(false);
        expect(sameTabSplit(split, { ...split, everywhere: { g1: "e" } })).toBe(true);
    });
});

describe("a pinned view's changes (FR-SHELL-080)", () => {
    const live = {
        id: "root",
        flexDirection: "row",
        children: [
            { id: "n1", data: { blockId: "b1" } },
            { id: "wrap", flexDirection: "column", children: [{ id: "n2", data: { blockId: "b2" } }] },
        ],
    };
    const metas: Record<string, Record<string, any>> = {
        b1: { view: "term", controller: "shell", "cmd:cwd": "/elsewhere" },
        b2: { view: "molten-browser", url: "https://github.com/o/n/issues/3" },
    };

    it("reads the layout without sizes and folds a split of one", () => {
        expect(layoutTree(live)).toEqual({ dir: "row", children: [{ blockid: "b1" }, { blockid: "b2" }] });
        expect(layoutTree({ data: { blockId: "x" } })).toEqual({ blockid: "x" });
        expect(layoutTree(null)).toBeNull();
    });

    it("names a panel by its kind and a page by its site", () => {
        expect(paneKey({ view: "term", "cmd:cwd": "/a" })).toBe(paneKey({ view: "term", "molten:agentslot": true }));
        expect(paneKey({ view: "molten-browser", url: RepoToken })).toBe("molten-browser:github.com");
        expect(paneKey({ view: "molten-browser", url: "https://npmjs.com/x" })).toBe("molten-browser:npmjs.com");
    });

    it("is unchanged while its panels and layout match, even when a terminal moves or a page browses its site", () => {
        const tree = layoutTree(live);
        expect(liveSignature(tree, (id) => metas[id])).toBe(configSignature(config));
        expect(viewModified(config, tree, (id) => metas[id])).toBe(false);
    });

    it("is changed when a panel is added, swapped or the split turns", () => {
        const added = { dir: "row", children: [{ blockid: "b1" }, { blockid: "b2" }, { blockid: "b3" }] };
        const all = { ...metas, b3: { view: "molten-project" } };
        expect(viewModified(config, added, (id) => all[id])).toBe(true);
        const swapped = { dir: "row", children: [{ blockid: "b2" }, { blockid: "b1" }] };
        expect(viewModified(config, swapped, (id) => metas[id])).toBe(true);
        const turned = { dir: "column", children: [{ blockid: "b1" }, { blockid: "b2" }] };
        expect(viewModified(config, turned, (id) => metas[id])).toBe(true);
        const other = { ...metas, b2: { view: "molten-browser", url: "https://npmjs.com" } };
        expect(viewModified(config, layoutTree(live), (id) => other[id])).toBe(true);
    });

    it("is not changed while its layout or panels are not loaded", () => {
        expect(viewModified(config, null, (id) => metas[id])).toBe(false);
        expect(viewModified(config, layoutTree(live), () => null)).toBe(false);
        expect(viewModified(null, layoutTree(live), (id) => metas[id])).toBe(false);
    });

    it("needs the newer configuration when it was made from an older one", () => {
        expect(instanceStale({ meta: { [GlobalPinRevMetaKey]: 1 } }, pin)).toBe(true);
        expect(instanceStale({ meta: { [GlobalPinRevMetaKey]: 2 } }, pin)).toBe(false);
        expect(instanceStale({ meta: {} }, pin)).toBe(true);
    });
});

describe("finished views (FR-SHELL-080)", () => {
    it("is finished when its agents are done or idle, and only then", () => {
        expect(viewFinished(states({ a: "done" }), ["a", "t"])).toBe(true);
        expect(viewFinished(states({ a: "done", b: "working" }), ["a", "b"])).toBe(false);
        expect(viewFinished(states({ a: "waiting" }), ["a"])).toBe(false);
        expect(viewFinished(states({ a: "idle", b: "done" }), ["a", "b"])).toBe(true);
        expect(viewFinished(states({ a: "error" }), ["a"])).toBe(false);
        expect(viewFinished(states({}), ["t"])).toBe(false);
    });

    it("is busy while an agent works or waits, even beside an error", () => {
        expect(viewBusy(states({ a: "error", b: "working" }), ["a", "b"])).toBe(true);
        expect(viewBusy(states({ a: "done" }), ["a"])).toBe(false);
    });

    it("lists the panels that hold an agent", () => {
        expect(agentBlocksOf(states({ a: "idle" }), ["a", "t"])).toEqual(["a"]);
    });
});
