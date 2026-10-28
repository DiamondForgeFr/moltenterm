// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AgentStatesData } from "../agent-state-model";
import { sameTabSplit, splitSidebarTabs } from "./sidebar-model";
import {
    agentBlocksOf,
    applyMetaPatch,
    configSignature,
    GlobalPin,
    GlobalPinMetaKey,
    GlobalPinRevMetaKey,
    GlobalPinsMetaKey,
    instanceStale,
    isProjectTab,
    layoutTree,
    liveSignature,
    makeGlobalPinId,
    paneKey,
    PinConfig,
    PinConfigMetaKey,
    PinMetaKey,
    pinMetaOf,
    PinWorkspace,
    planViewMove,
    readGlobalPins,
    RepoToken,
    shownViewState,
    undoPins,
    viewBusy,
    viewFinished,
    ViewIconMetaKey,
    viewModified,
    viewMoves,
    ViewState,
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

describe("moving a view between its three states (#1244)", () => {
    const captured: PinConfig = { tree: { pane: 0 }, panes: [{ view: "term" }] };
    const other: GlobalPin = { id: "g0", name: "Docs", rev: 1, config };
    // A view of its own: a terminal and a web page, a background, an icon, its name; the pin keys come per state.
    const own = { bg: "#123456", "molten:viewicon": "gear", "tab:name": "Work" };
    const tabOf = (state: ViewState) => {
        const meta: Record<string, any> = { ...own };
        if (state === "workspace") {
            Object.assign(meta, { [PinMetaKey]: PinWorkspace, [PinConfigMetaKey]: config });
        }
        if (state === "everywhere") {
            Object.assign(meta, { [GlobalPinMetaKey]: "g1", [GlobalPinRevMetaKey]: 2 });
        }
        return { oid: "tab-1", blockids: ["term-1", "web-1"], meta };
    };
    const pinsOf = (state: ViewState): GlobalPin[] =>
        state === "everywhere" ? [other, { ...pin, icon: "gear" }] : [other];
    const transitions: [ViewState, ViewState][] = [
        ["temporary", "workspace"],
        ["temporary", "everywhere"],
        ["workspace", "everywhere"],
        ["workspace", "temporary"],
        ["everywhere", "workspace"],
        ["everywhere", "temporary"],
    ];

    for (const [from, to] of transitions) {
        it(`${from} → ${to} keeps the view's tab, panels and meta, and Undo brings ${from} back`, () => {
            const tab = tabOf(from);
            const pins = pinsOf(from);
            const move = planViewMove(from, to, {
                tabMeta: tab.meta,
                pins,
                captured,
                name: "Work",
                newPinId: "g9",
            });
            expect(move).not.toBeNull();
            // Only pin keys (and the icon a pin carried) are written: the tab, its panels and its own meta stay.
            const touched = Object.keys(move.tabMeta);
            const pinKeys = [PinMetaKey, PinConfigMetaKey, GlobalPinMetaKey, GlobalPinRevMetaKey, "molten:viewicon"];
            expect(touched.every((k) => pinKeys.includes(k))).toBe(true);
            const after = { ...tab, meta: applyMetaPatch(tab.meta, move.tabMeta) };
            expect(after.oid).toBe("tab-1");
            expect(after.blockids).toEqual(["term-1", "web-1"]);
            expect(after.meta).toMatchObject(own);
            const ids = new Set(move.pins.map((p) => p.id));
            expect(viewStateOf(after, ids)).toBe(to);
            expect(ids.has("g0")).toBe(true);

            const undone = applyMetaPatch(after.meta, pinMetaOf(tab.meta));
            const pinsBack = undoPins(pins, move.pins, move.pin);
            expect(undone).toEqual(tab.meta);
            expect(pinsBack.map((p) => p.id)).toEqual(pins.map((p) => p.id));
            expect(viewStateOf({ meta: undone }, new Set(pinsBack.map((p) => p.id)))).toBe(from);
        });
    }

    it("pins everywhere with the view's own icon and what it shows now", () => {
        const move = planViewMove("workspace", "everywhere", {
            tabMeta: tabOf("workspace").meta,
            pins: [other],
            captured,
            name: "Work",
            newPinId: "g9",
        });
        expect(move.pin).toEqual({ id: "g9", name: "Work", icon: "gear", rev: 1, config: captured });
        expect(move.pins.map((p) => p.id)).toEqual(["g0", "g9"]);
    });

    it("keeps the pin's configuration for a view pinned only here", () => {
        const move = planViewMove("everywhere", "workspace", {
            tabMeta: tabOf("everywhere").meta,
            pins: pinsOf("everywhere"),
        });
        expect(move.tabMeta[PinConfigMetaKey]).toBe(config);
        expect(move.pins.map((p) => p.id)).toEqual(["g0"]);
    });

    it("moves a top-row block this workspace never opened by its pin", () => {
        const move = planViewMove("everywhere", "temporary", {
            tabMeta: null,
            pins: pinsOf("everywhere"),
            pinId: "g1",
        });
        expect(move.pin.id).toBe("g1");
        expect(move.tabMeta[ViewIconMetaKey]).toBe("gear");
    });

    it("refuses what it cannot do: the same state, a missing pin, a pin without the view's layout", () => {
        expect(planViewMove("workspace", "workspace", { tabMeta: {}, pins: [] })).toBeNull();
        expect(planViewMove("everywhere", "temporary", { tabMeta: {}, pins: [] })).toBeNull();
        expect(planViewMove("temporary", "everywhere", { tabMeta: {}, pins: [], newPinId: "g9" })).toBeNull();
    });

    it("puts an undone pin back at its place, keeping changes made meanwhile", () => {
        const a = { ...pin, id: "a" };
        const b = { ...pin, id: "b" };
        const c = { ...pin, id: "c" };
        expect(undoPins([a, b, c], [a, c], b).map((p) => p.id)).toEqual(["a", "b", "c"]);
        expect(undoPins([a], [a, b], b).map((p) => p.id)).toEqual(["a"]);
        const renamed = { ...a, name: "Renamed" };
        expect(undoPins([a, b], [renamed], b)[0].name).toBe("Renamed");
    });

    it("leaves the Project tab where it is", () => {
        expect(viewMoves("workspace", true)).toEqual([]);
        expect(isProjectTab({ meta: { "molten:projecttab": true } })).toBe(true);
        expect(shownViewState("temporary", true)).toBe("workspace");
        expect(shownViewState("temporary", false)).toBe("temporary");
    });
});
